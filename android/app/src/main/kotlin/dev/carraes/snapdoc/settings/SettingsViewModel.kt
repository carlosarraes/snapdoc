package dev.carraes.snapdoc.settings

import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import dev.carraes.snapdoc.net.ApiException
import dev.carraes.snapdoc.net.OfflineException
import dev.carraes.snapdoc.net.SnapdocApi
import dev.carraes.snapdoc.passcode.PasscodeVault
import dev.carraes.snapdoc.security.TokenStore
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch

data class SettingsUiState(
    val tokenSaved: Boolean = false,
    val tokenStatus: String = "No token saved.",
    val tokenError: String? = null,
    val checkingToken: Boolean = false,
    val passcodes: List<String> = emptyList(),
)

class SettingsViewModel(
    private val api: SnapdocApi,
    private val tokens: TokenStore,
    private val vault: PasscodeVault,
    private val onCookiesCleared: () -> Unit,
) : ViewModel() {
    private val _state = MutableStateFlow(SettingsUiState())
    val state: StateFlow<SettingsUiState> = _state.asStateFlow()

    init {
        val saved = tokens.read()
        _state.update {
            it.copy(
                tokenSaved = !saved.isNullOrBlank(),
                tokenStatus = if (saved.isNullOrBlank()) "No token saved." else "Token saved.",
                passcodes = vault.state().codes,
            )
        }
        if (!saved.isNullOrBlank()) describeToken()
    }

    /** Saves then immediately proves the token works, so a typo surfaces here. */
    fun saveToken(token: String) {
        if (token.isBlank()) return
        val previous = tokens.read()
        tokens.write(token)
        _state.update { it.copy(checkingToken = true, tokenError = null) }
        viewModelScope.launch {
            try {
                val name = api.tokenName()
                _state.update {
                    it.copy(
                        tokenSaved = true,
                        checkingToken = false,
                        tokenError = null,
                        tokenStatus = if (name.isBlank()) "Token saved." else "Signed in as $name.",
                    )
                }
            } catch (e: Throwable) {
                // A rejected token must not replace a working one.
                val rejected = e is ApiException && e.code == "unauthorized"
                if (rejected) {
                    if (previous.isNullOrBlank()) tokens.clear() else tokens.write(previous)
                }
                _state.update {
                    it.copy(
                        checkingToken = false,
                        tokenSaved = !tokens.read().isNullOrBlank(),
                        tokenError = when {
                            rejected -> "That token was rejected. Check it and try again."
                            e is OfflineException -> "Saved, but snapdoc is unreachable right now."
                            else -> (e as? ApiException)?.message ?: "Could not verify the token."
                        },
                    )
                }
            }
        }
    }

    private fun describeToken() {
        viewModelScope.launch {
            runCatching { api.tokenName() }.onSuccess { name ->
                if (name.isNotBlank()) _state.update { it.copy(tokenStatus = "Signed in as $name.") }
            }
        }
    }

    fun addPasscode(code: String) {
        vault.addCode(code)
        _state.update { it.copy(passcodes = vault.state().codes) }
    }

    fun removePasscode(code: String) {
        vault.removeCode(code)
        _state.update { it.copy(passcodes = vault.state().codes) }
    }

    fun forgetUnlocked() {
        vault.forgetUnlocked()
        onCookiesCleared()
    }
}
