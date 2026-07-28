package dev.carraes.snapdoc.security

import android.content.Context

interface TokenStore {
    fun read(): String?
    fun write(token: String)
    fun clear()
}

class SecureTokenStore(context: Context) : TokenStore {
    private val blobs = EncryptedBlobStore(context, "snapdoc.token.v1", "api-token.enc")

    override fun read(): String? = blobs.read()?.toString(Charsets.UTF_8)
    override fun write(token: String) = blobs.write(token.toByteArray(Charsets.UTF_8))
    override fun clear() = blobs.clear()
}
