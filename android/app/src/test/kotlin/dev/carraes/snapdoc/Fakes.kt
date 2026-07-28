package dev.carraes.snapdoc

import dev.carraes.snapdoc.artifacts.Artifact
import dev.carraes.snapdoc.artifacts.ArtifactKind
import dev.carraes.snapdoc.artifacts.ArtifactPage
import dev.carraes.snapdoc.artifacts.ArtifactsCache
import dev.carraes.snapdoc.net.ApiException
import dev.carraes.snapdoc.net.PasscodeCheck
import dev.carraes.snapdoc.net.SnapdocApi
import dev.carraes.snapdoc.net.UnlockResult
import dev.carraes.snapdoc.passcode.CookieJar
import dev.carraes.snapdoc.passcode.PasscodeVault
import dev.carraes.snapdoc.passcode.PasscodeVaultCodec
import dev.carraes.snapdoc.passcode.VaultState

fun artifact(
    id: String = "abcdefghijklmn",
    kind: ArtifactKind = ArtifactKind.DOCUMENT,
    title: String? = "A document",
    hasPasscode: Boolean = false,
    commentsEnabled: Boolean = false,
    status: String = "active",
) = Artifact(
    id = id,
    kind = kind,
    url = "https://snapdoc.carraes.dev/$id",
    title = title,
    status = status,
    currentVersion = 1,
    sizeBytes = 1024,
    createdAt = "2026-07-01T00:00:00Z",
    expiresAt = null,
    hasPasscode = hasPasscode,
    commentsEnabled = commentsEnabled,
    durationMs = null,
)

class FakeApi(
    var pages: MutableList<Result<ArtifactPage>> = mutableListOf(),
    var probes: MutableMap<String, PasscodeCheck> = mutableMapOf(),
    var unlockFor: MutableMap<String, UnlockResult> = mutableMapOf(),
) : SnapdocApi {
    val probed = mutableListOf<Pair<String, String>>()
    val unlocked = mutableListOf<Pair<String, String>>()
    var listCalls = 0

    override suspend fun tokenName(): String = "test-token"

    override suspend fun listArtifacts(status: String?, cursor: String?): ArtifactPage {
        listCalls++
        val next = pages.removeFirstOrNull() ?: Result.success(ArtifactPage(emptyList(), null))
        return next.getOrThrow()
    }

    override suspend fun checkPasscode(id: String, passcode: String): PasscodeCheck {
        probed += id to passcode
        return probes[passcode] ?: PasscodeCheck.INCORRECT
    }

    override suspend fun unlock(id: String, passcode: String, next: String): UnlockResult {
        unlocked += id to passcode
        return unlockFor[passcode] ?: UnlockResult.Incorrect
    }
}

fun unauthorized() = ApiException("unauthorized", "Add your API token in Settings.", 401)

class FakeVault(private var state: VaultState = VaultState()) : PasscodeVault {
    override fun state(): VaultState = state
    override fun addCode(code: String) {
        state = state.copy(codes = state.codes + code)
    }
    override fun removeCode(code: String) {
        state = state.copy(codes = state.codes - code)
    }
    override fun rememberWorking(id: String, code: String) {
        state = state.copy(working = state.working + (id to code))
    }
    override fun markFailed(id: String, code: String) {
        state = state.copy(failed = state.failed + (id to state.failed[id].orEmpty() + code))
    }
    override fun recordUnlockFailure(now: Long) {
        state = state.copy(recentFailures = state.recentFailures + now)
    }
    override fun startBackoff(until: Long) {
        state = state.copy(backoffUntil = until)
    }
    override fun forgetUnlocked() {
        state = state.copy(working = emptyMap(), failed = emptyMap(), backoffUntil = 0, recentFailures = emptyList())
    }
    /** Round-trips through the codec, proving persisted state behaves the same. */
    fun persisted(): VaultState = PasscodeVaultCodec.decode(PasscodeVaultCodec.encode(state))
}

class FakeCookieJar(private val unlocked: MutableSet<String> = mutableSetOf()) : CookieJar {
    val stored = mutableListOf<String>()
    override fun hasUnlock(artifactId: String): Boolean = artifactId in unlocked
    override fun store(setCookie: String) {
        stored += setCookie
        Regex("sd_unlock_([A-Za-z0-9_-]+)=").find(setCookie)?.groupValues?.get(1)?.let(unlocked::add)
    }
    override fun clearAll() = unlocked.clear()
}

class FakeCache(private val sections: MutableMap<String, List<Artifact>> = mutableMapOf()) : ArtifactsCache {
    override fun load(key: String): List<Artifact>? = sections[key]
    override fun save(key: String, items: List<Artifact>) {
        sections[key] = items
    }
    override fun clear() = sections.clear()
}
