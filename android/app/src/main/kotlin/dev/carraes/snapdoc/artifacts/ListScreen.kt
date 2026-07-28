package dev.carraes.snapdoc.artifacts

import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.material3.Button
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.FilterChip
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.pulltorefresh.PullToRefreshBox
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import dev.carraes.snapdoc.ui.durationLabel
import dev.carraes.snapdoc.ui.expiryLabel
import dev.carraes.snapdoc.ui.relativeTime
import dev.carraes.snapdoc.ui.sizeLabel

private val STATUSES = listOf<Pair<String?, String>>(
    "active" to "Active",
    null to "All",
    "expired" to "Expired",
)

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun ListScreen(
    state: ListUiState,
    onOpen: (Artifact) -> Unit,
    onRefresh: () -> Unit,
    onLoadMore: () -> Unit,
    onQuery: (String) -> Unit,
    onStatus: (String?) -> Unit,
    onSettings: () -> Unit,
    onShare: (Artifact) -> Unit,
    onOpenInBrowser: (Artifact) -> Unit,
) {
    Column(modifier = Modifier.fillMaxSize()) {
        Row(
            modifier = Modifier.fillMaxWidth().padding(start = 16.dp, end = 8.dp, top = 12.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Text("Snapdoc", style = MaterialTheme.typography.titleLarge, modifier = Modifier.weight(1f))
            TextButton(onClick = onSettings) { Text("Settings") }
        }

        OutlinedTextField(
            value = state.query,
            onValueChange = onQuery,
            singleLine = true,
            placeholder = { Text("Search documents") },
            modifier = Modifier.fillMaxWidth().padding(horizontal = 16.dp, vertical = 8.dp),
        )

        Row(
            modifier = Modifier.fillMaxWidth().padding(horizontal = 16.dp),
            horizontalArrangement = Arrangement.spacedBy(8.dp),
        ) {
            STATUSES.forEach { (value, label) ->
                FilterChip(
                    selected = state.status == value,
                    onClick = { onStatus(value) },
                    label = { Text(label) },
                )
            }
        }

        if (state.offline) {
            Text(
                "Offline · showing last refresh",
                style = MaterialTheme.typography.labelMedium,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
                modifier = Modifier.fillMaxWidth().padding(horizontal = 16.dp, vertical = 8.dp),
            )
        }

        PullToRefreshBox(
            isRefreshing = state.refreshing,
            onRefresh = onRefresh,
            modifier = Modifier.fillMaxSize(),
        ) {
            when {
                state.loading && state.items.isEmpty() ->
                    Box(Modifier.fillMaxSize(), Alignment.Center) { CircularProgressIndicator() }

                state.error != null && state.items.isEmpty() -> Column(
                    modifier = Modifier.fillMaxSize().padding(24.dp),
                    verticalArrangement = Arrangement.Center,
                    horizontalAlignment = Alignment.CenterHorizontally,
                ) {
                    Text(state.error, style = MaterialTheme.typography.bodyMedium)
                    Button(onClick = if (state.needsToken) onSettings else onRefresh, modifier = Modifier.padding(top = 12.dp)) {
                        Text(if (state.needsToken) "Open settings" else "Try again")
                    }
                }

                state.visible.isEmpty() -> Box(Modifier.fillMaxSize(), Alignment.Center) {
                    Text(
                        if (state.query.isBlank()) "Nothing published yet." else "No documents match “${state.query}”.",
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                    )
                }

                else -> LazyColumn(modifier = Modifier.fillMaxSize()) {
                    items(state.visible, key = { it.id }) { artifact ->
                        ArtifactRow(artifact, onOpen, onShare, onOpenInBrowser)
                        HorizontalDivider(color = MaterialTheme.colorScheme.outlineVariant)
                    }
                    if (state.canLoadMore) {
                        item {
                            TextButton(
                                onClick = onLoadMore,
                                modifier = Modifier.fillMaxWidth().padding(8.dp),
                            ) { Text(if (state.loadingMore) "Loading…" else "Load more") }
                        }
                    }
                }
            }
        }
    }
}

@Composable
private fun ArtifactRow(
    artifact: Artifact,
    onOpen: (Artifact) -> Unit,
    onShare: (Artifact) -> Unit,
    onOpenInBrowser: (Artifact) -> Unit,
) {
    var menuOpen by remember { mutableStateOf(false) }
    Row(
        modifier = Modifier.fillMaxWidth().clickable { onOpen(artifact) }.padding(16.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Column(modifier = Modifier.weight(1f)) {
            Text(
                artifact.displayTitle,
                style = MaterialTheme.typography.bodyLarge,
                fontWeight = FontWeight.Medium,
            )
            Text(
                meta(artifact),
                style = MaterialTheme.typography.labelMedium,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )
        }
        Box {
            TextButton(onClick = { menuOpen = true }) { Text("⋯") }
            DropdownMenu(expanded = menuOpen, onDismissRequest = { menuOpen = false }) {
                DropdownMenuItem(
                    text = { Text("Share link") },
                    onClick = { menuOpen = false; onShare(artifact) },
                )
                DropdownMenuItem(
                    text = { Text("Open in browser") },
                    onClick = { menuOpen = false; onOpenInBrowser(artifact) },
                )
            }
        }
    }
}

private fun meta(artifact: Artifact): String = buildList {
    if (artifact.kind == ArtifactKind.VIDEO) add("video")
    if (artifact.hasPasscode) add("🔒")
    if (artifact.commentsEnabled) add("💬")
    durationLabel(artifact.durationMs)?.let(::add)
    add("v${artifact.currentVersion}")
    add(sizeLabel(artifact.sizeBytes))
    add(relativeTime(artifact.createdAt))
    expiryLabel(artifact.expiresAt)?.let(::add)
}.joinToString(" · ")
