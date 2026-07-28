package dev.carraes.snapdoc.net

import dev.carraes.snapdoc.artifacts.ArtifactJson
import dev.carraes.snapdoc.artifacts.ArtifactPage
import dev.carraes.snapdoc.security.TokenStore
import java.net.URLEncoder
import kotlinx.coroutines.CoroutineDispatcher
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import org.json.JSONObject

/** Outcome of checking one passcode candidate against an artifact. */
enum class PasscodeCheck { CORRECT, INCORRECT, NO_PASSCODE, UNSUPPORTED, UNAUTHORIZED, GONE }

/** Outcome of asking the artifact host for an unlock cookie. */
sealed interface UnlockResult {
    data class Unlocked(val setCookie: String) : UnlockResult
    data object Incorrect : UnlockResult
    data object RateLimited : UnlockResult
    data object Missing : UnlockResult
}

interface SnapdocApi {
    suspend fun tokenName(): String
    suspend fun listArtifacts(status: String?, cursor: String?): ArtifactPage
    suspend fun checkPasscode(id: String, passcode: String): PasscodeCheck
    suspend fun unlock(id: String, passcode: String, next: String): UnlockResult
}

class HttpSnapdocApi(
    private val tokens: TokenStore,
    private val dispatcher: CoroutineDispatcher = Dispatchers.IO,
) : SnapdocApi {

    override suspend fun tokenName(): String = withContext(dispatcher) {
        val response = Http.request("GET", "$API_HOST/v1/whoami", authHeaders())
        val body = requireOk(response)
        JSONObject(body).optJSONObject("token")?.optString("name").orEmpty()
    }

    override suspend fun listArtifacts(status: String?, cursor: String?): ArtifactPage = withContext(dispatcher) {
        val query = buildList {
            if (!status.isNullOrBlank()) add("status=" + status.encoded())
            if (!cursor.isNullOrBlank()) add("cursor=" + cursor.encoded())
        }.joinToString("&")
        val url = "$API_HOST/v1/artifacts" + if (query.isEmpty()) "" else "?$query"
        ArtifactJson.parsePage(requireOk(Http.request("GET", url, authHeaders())))
    }

    /**
     * Verifies a passcode without spending any unlock budget. The content
     * endpoint checks the passcode before it looks up the version, so asking
     * for a version that cannot exist proves the passcode with a 404 and never
     * transfers a document. Failed attempts here are not rate-limited — unlike
     * POST /{id}/unlock, whose failures are counted per IP across every
     * artifact and shared with posting comments.
     */
    override suspend fun checkPasscode(id: String, passcode: String): PasscodeCheck = withContext(dispatcher) {
        val url = "$API_HOST/v1/artifacts/$id/content?version=999999999"
        val response = Http.request("GET", url, authHeaders() + mapOf("X-Snapdoc-Passcode" to passcode))
        when {
            response.status == 404 -> PasscodeCheck.CORRECT
            response.status == 200 -> PasscodeCheck.CORRECT
            response.status == 410 -> PasscodeCheck.GONE
            else -> when (errorCode(response.body)) {
                "passcode_incorrect" -> PasscodeCheck.INCORRECT
                "passcode_required" -> PasscodeCheck.INCORRECT
                "unauthorized" -> PasscodeCheck.UNAUTHORIZED
                // Videos have no text content, so the kind check answers before
                // the passcode is ever consulted: there is nothing to learn here.
                "invalid_request" -> PasscodeCheck.UNSUPPORTED
                else -> PasscodeCheck.UNSUPPORTED
            }
        }
    }

    override suspend fun unlock(id: String, passcode: String, next: String): UnlockResult = withContext(dispatcher) {
        val form = "passcode=" + passcode.encoded() + "&next=" + next.encoded()
        val response = Http.request("POST", "$ARTIFACT_HOST/$id/unlock", emptyMap(), form)
        when (response.status) {
            303 -> response.setCookies.firstOrNull { it.startsWith("sd_unlock_$id=") }
                ?.let(UnlockResult::Unlocked) ?: UnlockResult.Incorrect
            429 -> UnlockResult.RateLimited
            404 -> UnlockResult.Missing
            else -> UnlockResult.Incorrect
        }
    }

    private fun authHeaders(): Map<String, String> {
        val token = tokens.read().orEmpty()
        if (token.isBlank()) throw ApiException("unauthorized", "Add your API token in Settings.", 401)
        return mapOf("Authorization" to "Bearer $token", "Accept" to "application/json")
    }

    private fun requireOk(response: HttpResponse): String {
        if (response.status in 200..299) return response.body
        throw ApiException(errorCode(response.body), errorMessage(response.body), response.status)
    }

    private fun errorCode(body: String): String =
        runCatching { JSONObject(body).getJSONObject("error").getString("code") }.getOrDefault("http_error")

    private fun errorMessage(body: String): String =
        runCatching { JSONObject(body).getJSONObject("error").getString("message") }
            .getOrDefault("Something went wrong.")

    private fun String.encoded(): String = URLEncoder.encode(this, "UTF-8")
}
