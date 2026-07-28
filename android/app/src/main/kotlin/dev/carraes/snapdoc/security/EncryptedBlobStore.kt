package dev.carraes.snapdoc.security

import android.content.Context
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import java.security.KeyStore
import javax.crypto.Cipher
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey
import javax.crypto.spec.GCMParameterSpec

/**
 * A file encrypted with AES-256-GCM under a non-exportable AndroidKeyStore
 * key. Layout is `[version byte][12-byte IV][ciphertext]`; writes go through a
 * temp file and a rename so a crash can never leave a half-written blob.
 */
class EncryptedBlobStore(
    context: Context,
    private val alias: String,
    fileName: String,
) {
    private val file = context.filesDir.resolve(fileName)

    fun read(): ByteArray? {
        if (!file.exists()) return null
        val bytes = file.readBytes()
        require(bytes.size > HEADER_BYTES && bytes[0] == VERSION) { "Unsupported encrypted data" }
        val iv = bytes.copyOfRange(1, HEADER_BYTES)
        val ciphertext = bytes.copyOfRange(HEADER_BYTES, bytes.size)
        return cipher(Cipher.DECRYPT_MODE, iv).doFinal(ciphertext)
    }

    fun write(plaintext: ByteArray) {
        val cipher = cipher(Cipher.ENCRYPT_MODE)
        val output = byteArrayOf(VERSION) + cipher.iv + cipher.doFinal(plaintext)
        val temporary = file.resolveSibling("${file.name}.tmp")
        temporary.writeBytes(output)
        check(temporary.renameTo(file)) { "Could not save encrypted data" }
    }

    fun clear() {
        if (file.exists()) check(file.delete()) { "Could not delete encrypted data" }
    }

    private fun cipher(mode: Int, iv: ByteArray? = null): Cipher =
        Cipher.getInstance(TRANSFORMATION).apply {
            if (iv == null) init(mode, key()) else init(mode, key(), GCMParameterSpec(TAG_BITS, iv))
        }

    private fun key(): SecretKey {
        val keyStore = KeyStore.getInstance(KEYSTORE).apply { load(null) }
        (keyStore.getKey(alias, null) as? SecretKey)?.let { return it }
        return KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, KEYSTORE).run {
            init(
                KeyGenParameterSpec.Builder(
                    alias,
                    KeyProperties.PURPOSE_ENCRYPT or KeyProperties.PURPOSE_DECRYPT,
                )
                    .setKeySize(256)
                    .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
                    .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
                    .build(),
            )
            generateKey()
        }
    }

    private companion object {
        const val KEYSTORE = "AndroidKeyStore"
        const val TRANSFORMATION = "AES/GCM/NoPadding"
        const val TAG_BITS = 128
        const val VERSION: Byte = 1
        const val HEADER_BYTES = 13
    }
}
