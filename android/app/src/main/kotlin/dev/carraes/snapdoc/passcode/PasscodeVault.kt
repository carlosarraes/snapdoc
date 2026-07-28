package dev.carraes.snapdoc.passcode

import android.content.Context
import dev.carraes.snapdoc.security.EncryptedBlobStore
import org.json.JSONArray
import org.json.JSONObject

/**
 * Saved passcodes plus what the app has learned about them.
 *
 * `working` is why a locked document only ever asks once: the code that
 * unlocked it is remembered, so later opens skip straight to it. `failed`
 * records codes already proven wrong for a document so they are never tried
 * against it again.
 */
data class VaultState(
    val codes: List<String> = emptyList(),
    val working: Map<String, String> = emptyMap(),
    val failed: Map<String, Set<String>> = emptyMap(),
    val backoffUntil: Long = 0L,
    val recentFailures: List<Long> = emptyList(),
) {
    /** Codes worth trying for this artifact, best guess first. */
    fun candidatesFor(id: String): List<String> {
        val known = failed[id].orEmpty()
        val remembered = working[id]
        return buildList {
            remembered?.let(::add)
            codes.forEach { if (it != remembered && it !in known) add(it) }
        }
    }

    fun throttled(now: Long): Boolean =
        now < backoffUntil || recentFailures.count { now - it < HOUR_MILLIS } >= MAX_FAILURES_PER_HOUR

    companion object {
        const val HOUR_MILLIS = 3_600_000L
        // The server counts failed unlocks per IP across every artifact and
        // shares that budget with posting comments, so the app stops well
        // short of it rather than locking the user out site-wide.
        const val MAX_FAILURES_PER_HOUR = 5
    }
}

object PasscodeVaultCodec {
    fun encode(state: VaultState): String = JSONObject().apply {
        put("codes", JSONArray(state.codes))
        put("working", JSONObject(state.working))
        put("failed", JSONObject(state.failed.mapValues { JSONArray(it.value.toList()) }))
        put("backoff_until", state.backoffUntil)
        put("recent_failures", JSONArray(state.recentFailures))
    }.toString()

    fun decode(text: String): VaultState {
        val root = JSONObject(text)
        return VaultState(
            codes = root.optJSONArray("codes").strings(),
            working = root.optJSONObject("working").stringMap(),
            failed = root.optJSONObject("failed").let { obj ->
                obj?.keys()?.asSequence()?.associateWith { obj.optJSONArray(it).strings().toSet() }.orEmpty()
            },
            backoffUntil = root.optLong("backoff_until", 0L),
            recentFailures = root.optJSONArray("recent_failures").longs(),
        )
    }

    private fun JSONArray?.strings(): List<String> =
        if (this == null) emptyList() else (0 until length()).map { getString(it) }

    private fun JSONArray?.longs(): List<Long> =
        if (this == null) emptyList() else (0 until length()).map { getLong(it) }

    private fun JSONObject?.stringMap(): Map<String, String> =
        if (this == null) emptyMap() else keys().asSequence().associateWith { getString(it) }
}

interface PasscodeVault {
    fun state(): VaultState
    fun addCode(code: String)
    fun removeCode(code: String)
    fun rememberWorking(id: String, code: String)
    fun markFailed(id: String, code: String)
    fun recordUnlockFailure(now: Long)
    fun startBackoff(until: Long)
    fun forgetUnlocked()
}

class SecurePasscodeVault(context: Context) : PasscodeVault {
    private val blobs = EncryptedBlobStore(context, "snapdoc.passcodes.v1", "passcodes.enc")

    override fun state(): VaultState =
        runCatching { blobs.read()?.toString(Charsets.UTF_8)?.let(PasscodeVaultCodec::decode) }
            .getOrNull() ?: VaultState()

    private fun update(block: (VaultState) -> VaultState) {
        runCatching { blobs.write(PasscodeVaultCodec.encode(block(state())).toByteArray(Charsets.UTF_8)) }
    }

    override fun addCode(code: String) = update { current ->
        if (code.isBlank() || code in current.codes) current else current.copy(codes = current.codes + code)
    }

    // Dropping a code also drops everything learned about it, so re-adding it
    // later starts from a clean slate.
    override fun removeCode(code: String) = update { current ->
        current.copy(
            codes = current.codes - code,
            working = current.working.filterValues { it != code },
            failed = current.failed.mapValues { it.value - code },
        )
    }

    override fun rememberWorking(id: String, code: String) = update { current ->
        current.copy(
            working = current.working + (id to code),
            failed = current.failed + (id to current.failed[id].orEmpty() - code),
        )
    }

    override fun markFailed(id: String, code: String) = update { current ->
        current.copy(
            failed = current.failed + (id to current.failed[id].orEmpty() + code),
            working = if (current.working[id] == code) current.working - id else current.working,
        )
    }

    override fun recordUnlockFailure(now: Long) = update { current ->
        current.copy(recentFailures = (current.recentFailures + now).takeLast(20))
    }

    override fun startBackoff(until: Long) = update { it.copy(backoffUntil = until) }

    override fun forgetUnlocked() = update {
        it.copy(working = emptyMap(), failed = emptyMap(), backoffUntil = 0L, recentFailures = emptyList())
    }
}
