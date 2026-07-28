package dev.carraes.snapdoc

import dev.carraes.snapdoc.artifacts.ArtifactKind
import dev.carraes.snapdoc.net.PasscodeCheck
import dev.carraes.snapdoc.net.UnlockResult
import dev.carraes.snapdoc.passcode.UnlockCoordinator
import dev.carraes.snapdoc.passcode.UnlockOutcome
import dev.carraes.snapdoc.passcode.VaultState
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertIs
import kotlin.test.assertTrue
import kotlinx.coroutines.test.runTest

class UnlockCoordinatorTest {
    private val locked = artifact(hasPasscode = true)
    private val cookie = "sd_unlock_${locked.id}=abc123; Path=/; Max-Age=43200"

    @Test
    fun `unprotected artifacts need no work`() = runTest {
        val api = FakeApi()
        val coordinator = UnlockCoordinator(api, FakeVault(), FakeCookieJar())
        assertEquals(UnlockOutcome.Ready, coordinator.prepare(artifact()))
        assertTrue(api.probed.isEmpty() && api.unlocked.isEmpty())
    }

    @Test
    fun `an existing unlock cookie costs no requests at all`() = runTest {
        val api = FakeApi()
        val cookies = FakeCookieJar(mutableSetOf(locked.id))
        val coordinator = UnlockCoordinator(api, FakeVault(VaultState(codes = listOf("pw"))), cookies)

        assertEquals(UnlockOutcome.Ready, coordinator.prepare(locked))
        assertTrue(api.probed.isEmpty(), "must not probe when already unlocked")
        assertTrue(api.unlocked.isEmpty(), "must not spend an unlock attempt")
    }

    @Test
    fun `probes candidates for free and spends one unlock on the winner`() = runTest {
        val api = FakeApi(
            probes = mutableMapOf("wrong" to PasscodeCheck.INCORRECT, "right" to PasscodeCheck.CORRECT),
            unlockFor = mutableMapOf("right" to UnlockResult.Unlocked(cookie)),
        )
        val vault = FakeVault(VaultState(codes = listOf("wrong", "right")))
        val cookies = FakeCookieJar()
        val coordinator = UnlockCoordinator(api, vault, cookies)

        assertEquals(UnlockOutcome.Ready, coordinator.prepare(locked))
        assertEquals(listOf(locked.id to "wrong", locked.id to "right"), api.probed)
        // Only the verified code reaches the rate-limited endpoint.
        assertEquals(listOf(locked.id to "right"), api.unlocked)
        assertEquals(listOf(cookie), cookies.stored)
        assertEquals("right", vault.persisted().working[locked.id])
        assertTrue(vault.persisted().failed[locked.id].orEmpty().contains("wrong"))
    }

    @Test
    fun `a remembered passcode is tried first`() = runTest {
        val api = FakeApi(
            probes = mutableMapOf("second" to PasscodeCheck.CORRECT),
            unlockFor = mutableMapOf("second" to UnlockResult.Unlocked(cookie)),
        )
        val vault = FakeVault(
            VaultState(codes = listOf("first", "second"), working = mapOf(locked.id to "second")),
        )
        val coordinator = UnlockCoordinator(api, vault, FakeCookieJar())

        assertEquals(UnlockOutcome.Ready, coordinator.prepare(locked))
        assertEquals(listOf(locked.id to "second"), api.probed, "should not walk the whole list")
    }

    @Test
    fun `codes already known wrong for a document are never retried`() = runTest {
        val api = FakeApi(probes = mutableMapOf("bad" to PasscodeCheck.INCORRECT))
        val vault = FakeVault(
            VaultState(codes = listOf("bad"), failed = mapOf(locked.id to setOf("bad"))),
        )
        val coordinator = UnlockCoordinator(api, vault, FakeCookieJar())

        assertEquals(UnlockOutcome.NeedsPasscode, coordinator.prepare(locked))
        assertTrue(api.probed.isEmpty())
    }

    @Test
    fun `a failing probe never spends an unlock attempt`() = runTest {
        val api = FakeApi(probes = mutableMapOf("nope" to PasscodeCheck.INCORRECT))
        val coordinator = UnlockCoordinator(api, FakeVault(VaultState(codes = listOf("nope"))), FakeCookieJar())

        assertEquals(UnlockOutcome.NeedsPasscode, coordinator.prepare(locked))
        assertTrue(api.unlocked.isEmpty(), "the rate-limited endpoint must stay untouched")
    }

    @Test
    fun `video artifacts spend at most one attempt because probing cannot work`() = runTest {
        val video = artifact(id = "vvvvvvvvvvvvvv", kind = ArtifactKind.VIDEO, hasPasscode = true)
        val api = FakeApi(unlockFor = mutableMapOf())
        val vault = FakeVault(VaultState(codes = listOf("a", "b", "c")))
        val coordinator = UnlockCoordinator(api, vault, FakeCookieJar())

        assertEquals(UnlockOutcome.NeedsPasscode, coordinator.prepare(video))
        assertTrue(api.probed.isEmpty(), "no probe: a video has no text content to gate")
        assertEquals(1, api.unlocked.size, "must not walk the passcode list against the unlock endpoint")
    }

    @Test
    fun `rate limiting starts a backoff and blocks further automatic attempts`() = runTest {
        val api = FakeApi(
            probes = mutableMapOf("pw" to PasscodeCheck.CORRECT),
            unlockFor = mutableMapOf("pw" to UnlockResult.RateLimited),
        )
        val vault = FakeVault(VaultState(codes = listOf("pw")))
        val coordinator = UnlockCoordinator(api, vault, FakeCookieJar(), now = { 1_000L })

        val first = coordinator.prepare(locked)
        assertIs<UnlockOutcome.Failed>(first)
        assertTrue(vault.persisted().backoffUntil > 1_000L)

        val before = api.unlocked.size
        val second = coordinator.prepare(locked)
        assertIs<UnlockOutcome.Failed>(second)
        assertEquals(before, api.unlocked.size, "backoff must stop further attempts")
    }

    @Test
    fun `a rejected api token is reported instead of prompting for a passcode`() = runTest {
        val api = FakeApi(probes = mutableMapOf("pw" to PasscodeCheck.UNAUTHORIZED))
        val coordinator = UnlockCoordinator(api, FakeVault(VaultState(codes = listOf("pw"))), FakeCookieJar())

        val outcome = coordinator.prepare(locked)
        assertIs<UnlockOutcome.Failed>(outcome)
        assertTrue(outcome.message.contains("token", ignoreCase = true))
    }

    @Test
    fun `a typed passcode is saved only when asked`() = runTest {
        val api = FakeApi(unlockFor = mutableMapOf("typed" to UnlockResult.Unlocked(cookie)))
        val vault = FakeVault()
        val coordinator = UnlockCoordinator(api, vault, FakeCookieJar())

        assertEquals(UnlockOutcome.Ready, coordinator.submit(locked, "typed", save = false))
        assertTrue(vault.persisted().codes.isEmpty())
        // Even unsaved, the document itself stays silent next time.
        assertEquals("typed", vault.persisted().working[locked.id])

        assertEquals(UnlockOutcome.Ready, coordinator.submit(locked, "typed", save = true))
        assertEquals(listOf("typed"), vault.persisted().codes)
    }
}
