package dev.carraes.snapdoc

import dev.carraes.snapdoc.artifacts.ArtifactJson
import dev.carraes.snapdoc.artifacts.ArtifactKind
import dev.carraes.snapdoc.artifacts.ArtifactsCacheCodec
import dev.carraes.snapdoc.passcode.PasscodeVaultCodec
import dev.carraes.snapdoc.passcode.VaultState
import dev.carraes.snapdoc.reader.ReaderMode
import dev.carraes.snapdoc.reader.ReaderUrl
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertNull
import kotlin.test.assertTrue

class ArtifactJsonTest {
    // A document, a video with null poster/title, and a field this build has
    // never heard of — the API contract says unknown fields must be ignored.
    private val body = """
        {"artifacts":[
          {"id":"x7Kp9qWm2AbCdE","kind":"document","url":"https://snapdoc.carraes.dev/x7Kp9qWm2AbCdE",
           "title":"Q3 plan","status":"active","current_version":2,"content_type":"text/html",
           "size_bytes":48213,"created_at":"2026-06-12T15:04:05Z","expires_at":"2026-06-26T15:04:05Z",
           "has_passcode":true,"comments_enabled":true,"future_field":{"nested":1}},
          {"id":"vvvvvvvvvvvvvv","kind":"video","url":"https://snapdoc.carraes.dev/vvvvvvvvvvvvvv",
           "title":null,"status":"active","current_version":1,"content_type":"video/mp4",
           "size_bytes":900,"created_at":"2026-06-12T15:04:05Z","expires_at":null,
           "has_passcode":false,"comments_enabled":false,"poster_url":null,"duration_ms":65000}
        ],"next_cursor":null}
    """.trimIndent()

    @Test
    fun `parses a mixed page and ignores unknown fields`() {
        val page = ArtifactJson.parsePage(body)
        assertEquals(2, page.items.size)
        assertNull(page.nextCursor)

        val doc = page.items[0]
        assertEquals(ArtifactKind.DOCUMENT, doc.kind)
        assertEquals("Q3 plan", doc.title)
        assertTrue(doc.hasPasscode)
        assertTrue(doc.commentsEnabled)

        val video = page.items[1]
        assertEquals(ArtifactKind.VIDEO, video.kind)
        assertNull(video.title, "JSON null must not become the string \"null\"")
        assertNull(video.expiresAt)
        assertEquals(65000L, video.durationMs)
        assertEquals("vvvvvvvvvvvvvv", video.displayTitle, "an untitled artifact falls back to its id")
    }

    @Test
    fun `keeps an opaque cursor when present`() {
        val page = ArtifactJson.parsePage("""{"artifacts":[],"next_cursor":"opaque=="}""")
        assertEquals("opaque==", page.nextCursor)
    }

    @Test
    fun `search matches title and id, case-insensitively`() {
        val doc = ArtifactJson.parsePage(body).items[0]
        assertTrue(doc.matches("q3"))
        assertTrue(doc.matches("X7KP"))
        assertTrue(doc.matches(""))
        assertFalse(doc.matches("nonsense"))
    }

    @Test
    fun `cache survives a round trip`() {
        val items = ArtifactJson.parsePage(body).items
        val decoded = ArtifactsCacheCodec.decode(ArtifactsCacheCodec.encode(mapOf("active" to items)))
        assertEquals(items, decoded["active"])
    }
}

class ReaderUrlTest {
    @Test
    fun `commentable documents open the review page by default`() {
        val doc = artifact(commentsEnabled = true)
        assertEquals("https://snapdoc.carraes.dev/review/${doc.id}", ReaderUrl.of(doc, ReaderMode.REVIEW))
        assertEquals("https://snapdoc.carraes.dev/${doc.id}", ReaderUrl.of(doc, ReaderMode.READ))
        assertTrue(ReaderUrl.canReview(doc))
        assertEquals("/review/${doc.id}", ReaderUrl.unlockNext(doc, ReaderMode.REVIEW))
    }

    @Test
    fun `a document without comments never goes to the review page`() {
        // The review page renders "commenting is turned off" and no document
        // at all, so sending an uncommentable artifact there shows nothing.
        val doc = artifact(commentsEnabled = false)
        assertEquals("https://snapdoc.carraes.dev/${doc.id}", ReaderUrl.of(doc, ReaderMode.REVIEW))
        assertFalse(ReaderUrl.canReview(doc))
        assertEquals("/${doc.id}", ReaderUrl.unlockNext(doc, ReaderMode.REVIEW))
    }

    @Test
    fun `videos always open their watch page`() {
        val video = artifact(kind = ArtifactKind.VIDEO, commentsEnabled = true)
        assertEquals("https://snapdoc.carraes.dev/${video.id}", ReaderUrl.of(video, ReaderMode.REVIEW))
        assertFalse(ReaderUrl.canReview(video))
    }
}

class PasscodeVaultCodecTest {
    @Test
    fun `round-trips every field`() {
        val state = VaultState(
            codes = listOf("one", "two"),
            working = mapOf("doc" to "one"),
            failed = mapOf("doc" to setOf("two")),
            backoffUntil = 42L,
            recentFailures = listOf(1L, 2L),
        )
        assertEquals(state, PasscodeVaultCodec.decode(PasscodeVaultCodec.encode(state)))
    }

    @Test
    fun `candidate order puts the remembered code first and drops known failures`() {
        val state = VaultState(
            codes = listOf("a", "b", "c"),
            working = mapOf("doc" to "c"),
            failed = mapOf("doc" to setOf("b")),
        )
        assertEquals(listOf("c", "a"), state.candidatesFor("doc"))
    }

    @Test
    fun `throttles after too many recent failures`() {
        val now = 10_000_000L
        val busy = VaultState(recentFailures = List(VaultState.MAX_FAILURES_PER_HOUR) { now - 1000L })
        assertTrue(busy.throttled(now))
        // Failures older than the window no longer count.
        val stale = VaultState(recentFailures = List(9) { now - VaultState.HOUR_MILLIS - 1 })
        assertFalse(stale.throttled(now))
    }
}
