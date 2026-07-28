package dev.carraes.snapdoc.passcode

import dev.carraes.snapdoc.artifacts.Artifact
import dev.carraes.snapdoc.artifacts.ArtifactKind
import dev.carraes.snapdoc.net.OfflineException
import dev.carraes.snapdoc.net.PasscodeCheck
import dev.carraes.snapdoc.net.SnapdocApi
import dev.carraes.snapdoc.net.UnlockResult

/** Where the app keeps the browser's unlock cookies. */
interface CookieJar {
    fun hasUnlock(artifactId: String): Boolean
    fun store(setCookie: String)
    fun clearAll()
}

sealed interface UnlockOutcome {
    /** Already unlocked, or just unlocked — load the page. */
    data object Ready : UnlockOutcome
    /** No saved passcode fits; ask the reader for one. */
    data object NeedsPasscode : UnlockOutcome
    data class Failed(val message: String) : UnlockOutcome
}

/**
 * Gets a protected artifact ready to display without pestering the reader.
 *
 * Candidate passcodes are verified against the token-authenticated content
 * endpoint, which is free: its failures are not rate-limited. Only a code
 * already known to be right is spent on `POST /{id}/unlock`, whose failures
 * are counted per IP across every artifact and shared with posting comments.
 */
class UnlockCoordinator(
    private val api: SnapdocApi,
    private val vault: PasscodeVault,
    private val cookies: CookieJar,
    private val now: () -> Long = System::currentTimeMillis,
) {
    suspend fun prepare(artifact: Artifact): UnlockOutcome {
        if (!artifact.hasPasscode) return UnlockOutcome.Ready
        if (cookies.hasUnlock(artifact.id)) return UnlockOutcome.Ready

        val state = vault.state()
        if (state.throttled(now())) {
            return UnlockOutcome.Failed("Too many passcode attempts. Try again in about an hour.")
        }

        val candidates = state.candidatesFor(artifact.id)
        if (candidates.isEmpty()) return UnlockOutcome.NeedsPasscode

        // A video has no text content, so the probe answers "unsupported"
        // whatever the passcode is. Spend at most one real attempt there.
        if (artifact.kind == ArtifactKind.VIDEO) {
            return attemptUnlock(artifact, candidates.first(), next = "/${artifact.id}")
        }

        for (candidate in candidates) {
            when (probe(artifact, candidate)) {
                PasscodeCheck.CORRECT -> return attemptUnlock(artifact, candidate, next = "/${artifact.id}")
                PasscodeCheck.INCORRECT -> vault.markFailed(artifact.id, candidate)
                PasscodeCheck.UNAUTHORIZED ->
                    return UnlockOutcome.Failed("Your API token was rejected. Check it in Settings.")
                PasscodeCheck.GONE -> return UnlockOutcome.Failed("This document is no longer available.")
                PasscodeCheck.NO_PASSCODE -> return UnlockOutcome.Ready
                // Probing is unavailable — fall back to one honest attempt.
                PasscodeCheck.UNSUPPORTED -> return attemptUnlock(artifact, candidate, next = "/${artifact.id}")
            }
        }
        return UnlockOutcome.NeedsPasscode
    }

    /** A passcode the reader just typed: try it directly and remember it. */
    suspend fun submit(artifact: Artifact, passcode: String, save: Boolean): UnlockOutcome {
        val outcome = attemptUnlock(artifact, passcode, next = "/${artifact.id}")
        if (outcome is UnlockOutcome.Ready && save) vault.addCode(passcode)
        return outcome
    }

    private suspend fun probe(artifact: Artifact, candidate: String): PasscodeCheck =
        try {
            api.checkPasscode(artifact.id, candidate)
        } catch (e: OfflineException) {
            PasscodeCheck.UNSUPPORTED
        }

    private suspend fun attemptUnlock(artifact: Artifact, passcode: String, next: String): UnlockOutcome =
        try {
            when (val result = api.unlock(artifact.id, passcode, next)) {
                is UnlockResult.Unlocked -> {
                    cookies.store(result.setCookie)
                    vault.rememberWorking(artifact.id, passcode)
                    UnlockOutcome.Ready
                }
                UnlockResult.Incorrect -> {
                    vault.markFailed(artifact.id, passcode)
                    vault.recordUnlockFailure(now())
                    UnlockOutcome.NeedsPasscode
                }
                UnlockResult.RateLimited -> {
                    vault.startBackoff(now() + VaultState.HOUR_MILLIS)
                    UnlockOutcome.Failed("Too many passcode attempts. Try again in about an hour.")
                }
                UnlockResult.Missing -> UnlockOutcome.Failed("This document is no longer available.")
            }
        } catch (e: OfflineException) {
            UnlockOutcome.Failed("Can't reach snapdoc.")
        }
}
