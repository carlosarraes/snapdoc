package dev.carraes.snapdoc.reader

import android.annotation.SuppressLint
import android.app.DownloadManager
import android.content.Context
import android.content.Intent
import android.net.Uri
import android.os.Build
import android.os.Environment
import android.webkit.CookieManager
import android.webkit.WebResourceRequest
import android.webkit.WebView
import android.webkit.WebViewClient
import androidx.activity.compose.BackHandler
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.LinearProgressIndicator
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.viewinterop.AndroidView
import dev.carraes.snapdoc.artifacts.Artifact
import dev.carraes.snapdoc.net.ARTIFACT_HOST
import dev.carraes.snapdoc.net.API_HOST

@Composable
fun ReaderScreen(
    artifact: Artifact,
    mode: ReaderMode,
    ready: Boolean,
    error: String?,
    onToggleMode: () -> Unit,
    onRetry: () -> Unit,
    onBack: () -> Unit,
) {
    val context = LocalContext.current
    var webView by remember(artifact.id) { mutableStateOf<WebView?>(null) }
    var progress by remember(artifact.id, mode) { mutableStateOf(0) }

    // In-page history first, then out to the list.
    BackHandler {
        val view = webView
        if (view != null && view.canGoBack()) view.goBack() else onBack()
    }

    Column(modifier = Modifier.fillMaxSize()) {
        Row(
            modifier = Modifier.fillMaxWidth().padding(start = 8.dp, end = 8.dp, top = 8.dp),
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.spacedBy(4.dp),
        ) {
            TextButton(onClick = onBack) { Text("Back") }
            Text(
                artifact.displayTitle,
                style = MaterialTheme.typography.titleSmall,
                maxLines = 1,
                overflow = TextOverflow.Ellipsis,
                modifier = Modifier.weight(1f),
            )
            if (ReaderUrl.canReview(artifact)) {
                TextButton(onClick = onToggleMode) {
                    Text(if (mode == ReaderMode.REVIEW) "Read" else "Review")
                }
            }
        }

        if (progress in 1..99) {
            LinearProgressIndicator(progress = { progress / 100f }, modifier = Modifier.fillMaxWidth())
        }

        when {
            error != null -> Column(
                modifier = Modifier.fillMaxSize().padding(24.dp),
                verticalArrangement = Arrangement.Center,
                horizontalAlignment = Alignment.CenterHorizontally,
            ) {
                Text(error, style = MaterialTheme.typography.bodyMedium)
                TextButton(onClick = onRetry) { Text("Try again") }
            }

            !ready -> Box(Modifier.fillMaxSize(), Alignment.Center) { CircularProgressIndicator() }

            else -> AndroidView(
                modifier = Modifier.fillMaxSize(),
                factory = { ctx ->
                    createWebView(ctx) { progress = it }.also { webView = it }
                },
                update = { view ->
                    val url = ReaderUrl.of(artifact, mode)
                    if (view.tag != url) {
                        view.tag = url
                        view.loadUrl(url)
                    }
                },
            )
        }
    }

    DisposableEffect(artifact.id) {
        onDispose {
            webView?.let { view ->
                (view.parent as? android.view.ViewGroup)?.removeView(view)
                view.destroy()
            }
            webView = null
        }
    }
}

@SuppressLint("SetJavaScriptEnabled")
private fun createWebView(context: Context, onProgress: (Int) -> Unit): WebView = WebView(context).apply {
    settings.javaScriptEnabled = true
    // The review rail keeps the reviewer's name in localStorage; without DOM
    // storage it throws on load and the comment panel never renders.
    settings.domStorageEnabled = true
    // Artifacts published as raw HTML carry no viewport meta of their own.
    settings.useWideViewPort = true
    settings.loadWithOverviewMode = true
    settings.builtInZoomControls = true
    settings.displayZoomControls = false
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
        // Lets the document see prefers-color-scheme, so snapdoc's own dark CSS
        // applies instead of the WebView force-inverting the page.
        settings.isAlgorithmicDarkeningAllowed = true
    }
    CookieManager.getInstance().setAcceptCookie(true)

    webViewClient = object : WebViewClient() {
        override fun shouldOverrideUrlLoading(view: WebView, request: WebResourceRequest): Boolean {
            val url = request.url.toString()
            if (url.startsWith(ARTIFACT_HOST) || url.startsWith(API_HOST)) return false
            // Documents are full of the author's links; opening them in place
            // would strand the reader with no way back to the list.
            runCatching {
                context.startActivity(Intent(Intent.ACTION_VIEW, request.url).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
            }
            return true
        }
    }

    webChromeClient = object : android.webkit.WebChromeClient() {
        override fun onProgressChanged(view: WebView?, newProgress: Int) = onProgress(newProgress)
    }

    // A protected video's bytes are cookie-gated, so the download has to carry
    // the same unlock cookie the page used.
    setDownloadListener { url, _, _, mimeType, _ ->
        runCatching {
            val request = DownloadManager.Request(Uri.parse(url))
                .addRequestHeader("Cookie", CookieManager.getInstance().getCookie(url).orEmpty())
                .setMimeType(mimeType)
                .setNotificationVisibility(DownloadManager.Request.VISIBILITY_VISIBLE_NOTIFY_COMPLETED)
                .setDestinationInExternalPublicDir(Environment.DIRECTORY_DOWNLOADS, Uri.parse(url).lastPathSegment)
            (context.getSystemService(Context.DOWNLOAD_SERVICE) as DownloadManager).enqueue(request)
        }
    }
}
