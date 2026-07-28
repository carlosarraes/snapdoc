package dev.carraes.snapdoc.net

import java.io.IOException
import java.net.HttpURLConnection
import java.net.URL

const val API_HOST = "https://api.snapdoc.carraes.dev"
const val ARTIFACT_HOST = "https://snapdoc.carraes.dev"

/** A raw HTTP response: status, body text, and headers we care about. */
data class HttpResponse(
    val status: Int,
    val body: String,
    val setCookies: List<String> = emptyList(),
)

/**
 * snapdoc's typed failures. `code` is the server's stable error code — always
 * switch on it, never on the message (which is for humans).
 */
class ApiException(val code: String, override val message: String, val status: Int) : IOException(message)

/** Network-level failure: no response at all. */
class OfflineException(cause: Throwable) : IOException("Can't reach snapdoc", cause)

object Http {
    private const val TIMEOUT_MS = 20_000

    fun request(
        method: String,
        url: String,
        headers: Map<String, String> = emptyMap(),
        formBody: String? = null,
    ): HttpResponse {
        val connection = try {
            (URL(url).openConnection() as HttpURLConnection)
        } catch (e: IOException) {
            throw OfflineException(e)
        }
        return try {
            connection.requestMethod = method
            connection.connectTimeout = TIMEOUT_MS
            connection.readTimeout = TIMEOUT_MS
            // The 303 from /unlock carries the Set-Cookie we need; following it
            // would discard the header and fetch the document pointlessly.
            connection.instanceFollowRedirects = false
            headers.forEach(connection::setRequestProperty)
            if (formBody != null) {
                connection.doOutput = true
                connection.setRequestProperty("Content-Type", "application/x-www-form-urlencoded")
                connection.outputStream.use { it.write(formBody.toByteArray(Charsets.UTF_8)) }
            }
            val status = connection.responseCode
            val stream = if (status in 200..399) connection.inputStream else connection.errorStream
            val body = stream?.bufferedReader()?.use { it.readText() }.orEmpty()
            val cookies = connection.headerFields.entries
                .filter { it.key?.equals("Set-Cookie", ignoreCase = true) == true }
                .flatMap { it.value }
            HttpResponse(status, body, cookies)
        } catch (e: IOException) {
            throw OfflineException(e)
        } finally {
            connection.disconnect()
        }
    }
}
