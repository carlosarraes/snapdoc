package dev.carraes.snapdoc

import android.content.Intent
import android.net.Uri
import android.os.Bundle
import android.webkit.CookieManager
import androidx.activity.ComponentActivity
import androidx.activity.compose.BackHandler
import androidx.activity.compose.setContent
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.safeDrawingPadding
import androidx.compose.material3.Surface
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.runtime.collectAsState
import androidx.compose.ui.Modifier
import androidx.lifecycle.ViewModel
import androidx.lifecycle.ViewModelProvider
import androidx.lifecycle.viewmodel.compose.viewModel
import dev.carraes.snapdoc.artifacts.Artifact
import dev.carraes.snapdoc.artifacts.ListScreen
import dev.carraes.snapdoc.artifacts.ListViewModel
import dev.carraes.snapdoc.artifacts.SecureArtifactsCache
import dev.carraes.snapdoc.net.ARTIFACT_HOST
import dev.carraes.snapdoc.net.HttpSnapdocApi
import dev.carraes.snapdoc.passcode.CookieJar
import dev.carraes.snapdoc.passcode.PasscodeDialog
import dev.carraes.snapdoc.passcode.SecurePasscodeVault
import dev.carraes.snapdoc.passcode.UnlockCoordinator
import dev.carraes.snapdoc.passcode.UnlockOutcome
import dev.carraes.snapdoc.reader.ReaderMode
import dev.carraes.snapdoc.reader.ReaderScreen
import dev.carraes.snapdoc.reader.ReaderUrl
import dev.carraes.snapdoc.security.SecureTokenStore
import dev.carraes.snapdoc.settings.SettingsScreen
import dev.carraes.snapdoc.settings.SettingsViewModel
import dev.carraes.snapdoc.ui.theme.SnapdocTheme
import kotlinx.coroutines.launch

private sealed interface Route {
    data object List : Route
    data object Settings : Route
    data class Reader(val artifact: Artifact, val mode: ReaderMode) : Route
}

/** The WebView's cookie store, which is where unlock cookies must land. */
private class WebViewCookieJar : CookieJar {
    override fun hasUnlock(artifactId: String): Boolean =
        CookieManager.getInstance().getCookie(ARTIFACT_HOST)?.contains("sd_unlock_$artifactId=") == true

    override fun store(setCookie: String) {
        // Hand the header over verbatim so its own attributes (Path, Max-Age,
        // Secure) survive; re-serialising them is how they get lost.
        CookieManager.getInstance().setCookie(ARTIFACT_HOST, setCookie)
        CookieManager.getInstance().flush()
    }

    override fun clearAll() {
        CookieManager.getInstance().removeAllCookies(null)
        CookieManager.getInstance().flush()
    }
}

class MainActivity : ComponentActivity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)

        val tokens = SecureTokenStore(applicationContext)
        val vault = SecurePasscodeVault(applicationContext)
        val cache = SecureArtifactsCache(applicationContext)
        val api = HttpSnapdocApi(tokens)
        val cookies = WebViewCookieJar()
        val unlocker = UnlockCoordinator(api, vault, cookies)

        setContent {
            SnapdocTheme {
                // targetSdk 36 always draws edge to edge, so the app must keep
                // its own chrome clear of the status and navigation bars.
                Surface(modifier = Modifier.fillMaxSize().safeDrawingPadding()) {
                    var route by remember { mutableStateOf<Route>(if (tokens.read().isNullOrBlank()) Route.Settings else Route.List) }

                    val listViewModel: ListViewModel = viewModel(factory = factory { ListViewModel(api, cache) })
                    val settingsViewModel: SettingsViewModel = viewModel(
                        factory = factory { SettingsViewModel(api, tokens, vault) { cookies.clearAll() } },
                    )

                    when (val current = route) {
                        Route.List -> {
                            val state by listViewModel.state.collectAsState()
                            ListScreen(
                                state = state,
                                onOpen = { route = Route.Reader(it, defaultMode(it)) },
                                onRefresh = listViewModel::refresh,
                                onLoadMore = listViewModel::loadMore,
                                onQuery = listViewModel::setQuery,
                                onStatus = listViewModel::setStatus,
                                onSettings = { route = Route.Settings },
                                onShare = ::share,
                                onOpenInBrowser = ::openInBrowser,
                            )
                        }

                        Route.Settings -> {
                            val state by settingsViewModel.state.collectAsState()
                            BackHandler(enabled = state.tokenSaved) { route = Route.List }
                            SettingsScreen(
                                state = state,
                                onSaveToken = settingsViewModel::saveToken,
                                onAddPasscode = settingsViewModel::addPasscode,
                                onRemovePasscode = settingsViewModel::removePasscode,
                                onForgetUnlocked = settingsViewModel::forgetUnlocked,
                                onBack = { route = Route.List; listViewModel.refresh() },
                            )
                        }

                        is Route.Reader -> ReaderRoute(
                            artifact = current.artifact,
                            mode = current.mode,
                            unlocker = unlocker,
                            onToggleMode = {
                                route = Route.Reader(
                                    current.artifact,
                                    if (current.mode == ReaderMode.REVIEW) ReaderMode.READ else ReaderMode.REVIEW,
                                )
                            },
                            onBack = { route = Route.List },
                        )
                    }
                }
            }
        }
    }

    private fun defaultMode(artifact: Artifact): ReaderMode =
        if (ReaderUrl.canReview(artifact)) ReaderMode.REVIEW else ReaderMode.READ

    private fun share(artifact: Artifact) {
        val intent = Intent(Intent.ACTION_SEND).apply {
            type = "text/plain"
            putExtra(Intent.EXTRA_SUBJECT, artifact.displayTitle)
            putExtra(Intent.EXTRA_TEXT, artifact.url)
        }
        startActivity(Intent.createChooser(intent, "Share document"))
    }

    private fun openInBrowser(artifact: Artifact) {
        runCatching { startActivity(Intent(Intent.ACTION_VIEW, Uri.parse(artifact.url))) }
    }
}

@Composable
private fun ReaderRoute(
    artifact: Artifact,
    mode: ReaderMode,
    unlocker: UnlockCoordinator,
    onToggleMode: () -> Unit,
    onBack: () -> Unit,
) {
    var ready by remember(artifact.id) { mutableStateOf(!artifact.hasPasscode) }
    var error by remember(artifact.id) { mutableStateOf<String?>(null) }
    var asking by remember(artifact.id) { mutableStateOf(false) }
    var promptError by remember(artifact.id) { mutableStateOf<String?>(null) }
    var busy by remember(artifact.id) { mutableStateOf(false) }
    var attempt by remember(artifact.id) { mutableStateOf(0) }
    val scope = androidx.compose.runtime.rememberCoroutineScope()

    LaunchedEffect(artifact.id, attempt) {
        if (!artifact.hasPasscode) return@LaunchedEffect
        ready = false
        error = null
        when (val outcome = unlocker.prepare(artifact)) {
            UnlockOutcome.Ready -> ready = true
            UnlockOutcome.NeedsPasscode -> asking = true
            is UnlockOutcome.Failed -> error = outcome.message
        }
    }

    ReaderScreen(
        artifact = artifact,
        mode = mode,
        ready = ready,
        error = error,
        onToggleMode = onToggleMode,
        onRetry = { attempt++ },
        onBack = onBack,
    )

    if (asking) {
        PasscodeDialog(
            title = artifact.displayTitle,
            error = promptError,
            busy = busy,
            onSubmit = { passcode, save ->
                busy = true
                promptError = null
                scope.launch {
                    when (val outcome = unlocker.submit(artifact, passcode, save)) {
                        UnlockOutcome.Ready -> { asking = false; ready = true }
                        UnlockOutcome.NeedsPasscode -> promptError = "That passcode did not work."
                        is UnlockOutcome.Failed -> { asking = false; error = outcome.message }
                    }
                    busy = false
                }
            },
            onDismiss = { asking = false; onBack() },
        )
    }
}

/** Minimal factory so ViewModels can take constructor dependencies. */
private fun <T : ViewModel> factory(create: () -> T): ViewModelProvider.Factory =
    object : ViewModelProvider.Factory {
        @Suppress("UNCHECKED_CAST")
        override fun <V : ViewModel> create(modelClass: Class<V>): V = create() as V
    }
