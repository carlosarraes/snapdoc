package dev.carraes.snapdoc.artifacts

import android.content.Context
import dev.carraes.snapdoc.security.EncryptedBlobStore
import org.json.JSONArray
import org.json.JSONObject

/**
 * Last-seen artifact list, so the app opens with content instead of a spinner.
 * Encrypted at rest: titles alone can be sensitive, and the list is a map of
 * everything the owner has published.
 */
interface ArtifactsCache {
    fun load(key: String): List<Artifact>?
    fun save(key: String, items: List<Artifact>)
    fun clear()
}

/** Pure JSON codec, split out so it can be unit-tested off-device. */
object ArtifactsCacheCodec {
    fun encode(sections: Map<String, List<Artifact>>): String {
        val root = JSONObject()
        sections.forEach { (key, items) ->
            val array = JSONArray()
            items.forEach { array.put(it.toJson()) }
            root.put(key, array)
        }
        return root.toString()
    }

    fun decode(text: String): Map<String, List<Artifact>> {
        val root = JSONObject(text)
        return root.keys().asSequence().associateWith { key ->
            val array = root.optJSONArray(key) ?: JSONArray()
            (0 until array.length()).map { ArtifactJson.parseArtifact(array.getJSONObject(it)) }
        }
    }

    private fun Artifact.toJson(): JSONObject = JSONObject().apply {
        put("id", id)
        put("kind", if (kind == ArtifactKind.VIDEO) "video" else "document")
        put("url", url)
        put("title", title ?: JSONObject.NULL)
        put("status", status)
        put("current_version", currentVersion)
        put("size_bytes", sizeBytes)
        put("created_at", createdAt)
        put("expires_at", expiresAt ?: JSONObject.NULL)
        put("has_passcode", hasPasscode)
        put("comments_enabled", commentsEnabled)
        put("duration_ms", durationMs ?: JSONObject.NULL)
    }
}

class SecureArtifactsCache(context: Context) : ArtifactsCache {
    private val blobs = EncryptedBlobStore(context, "snapdoc.list.v1", "artifacts.enc")

    private fun read(): Map<String, List<Artifact>> =
        runCatching { blobs.read()?.toString(Charsets.UTF_8)?.let(ArtifactsCacheCodec::decode) }
            .getOrNull() ?: emptyMap()

    override fun load(key: String): List<Artifact>? = read()[key]

    override fun save(key: String, items: List<Artifact>) {
        // Only the visible page is worth keeping; a huge cache buys nothing.
        val sections = read().toMutableMap()
        sections[key] = items.take(MAX_CACHED)
        runCatching { blobs.write(ArtifactsCacheCodec.encode(sections).toByteArray(Charsets.UTF_8)) }
    }

    override fun clear() = blobs.clear()

    private companion object {
        const val MAX_CACHED = 100
    }
}
