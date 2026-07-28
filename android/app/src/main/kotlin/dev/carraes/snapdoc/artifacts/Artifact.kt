package dev.carraes.snapdoc.artifacts

import org.json.JSONArray
import org.json.JSONObject

enum class ArtifactKind { DOCUMENT, VIDEO }

/**
 * One hosted artifact. Only the fields the app actually shows are modelled —
 * snapdoc's contract says clients must ignore unknown fields, so new server
 * fields never break parsing.
 */
data class Artifact(
    val id: String,
    val kind: ArtifactKind,
    val url: String,
    val title: String?,
    val status: String,
    val currentVersion: Int,
    val sizeBytes: Long,
    val createdAt: String,
    val expiresAt: String?,
    val hasPasscode: Boolean,
    val commentsEnabled: Boolean,
    val durationMs: Long?,
) {
    val displayTitle: String get() = title?.takeIf { it.isNotBlank() } ?: id

    fun matches(query: String): Boolean {
        if (query.isBlank()) return true
        val needle = query.trim().lowercase()
        return displayTitle.lowercase().contains(needle) || id.lowercase().contains(needle)
    }
}

data class ArtifactPage(val items: List<Artifact>, val nextCursor: String?)

object ArtifactJson {
    fun parsePage(body: String): ArtifactPage {
        val root = JSONObject(body)
        val array: JSONArray = root.optJSONArray("artifacts") ?: JSONArray()
        val items = (0 until array.length()).map { parseArtifact(array.getJSONObject(it)) }
        return ArtifactPage(items, root.optString("next_cursor").takeIf { it.isNotEmpty() && it != "null" })
    }

    fun parseArtifact(json: JSONObject): Artifact = Artifact(
        id = json.getString("id"),
        kind = if (json.optString("kind") == "video") ArtifactKind.VIDEO else ArtifactKind.DOCUMENT,
        url = json.optString("url"),
        title = json.optStringOrNull("title"),
        status = json.optString("status", "active"),
        currentVersion = json.optInt("current_version", 1),
        sizeBytes = json.optLong("size_bytes", 0),
        createdAt = json.optString("created_at"),
        expiresAt = json.optStringOrNull("expires_at"),
        hasPasscode = json.optBoolean("has_passcode", false),
        commentsEnabled = json.optBoolean("comments_enabled", false),
        durationMs = if (json.isNull("duration_ms")) null else json.optLong("duration_ms").takeIf { it > 0 },
    )

    /** JSON null and absent both mean "no value"; optString would give "null". */
    private fun JSONObject.optStringOrNull(name: String): String? =
        if (isNull(name)) null else optString(name).takeIf { it.isNotEmpty() }
}
