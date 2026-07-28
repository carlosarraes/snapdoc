package dev.carraes.snapdoc.artifacts

import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import dev.carraes.snapdoc.net.ApiException
import dev.carraes.snapdoc.net.OfflineException
import dev.carraes.snapdoc.net.SnapdocApi
import kotlinx.coroutines.Job
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch

data class ListUiState(
    val items: List<Artifact> = emptyList(),
    val query: String = "",
    val status: String? = "active",
    val loading: Boolean = false,
    val refreshing: Boolean = false,
    val loadingMore: Boolean = false,
    /** Set when a refresh failed but cached rows are still on screen. */
    val offline: Boolean = false,
    /** Set only when there is nothing to show at all. */
    val error: String? = null,
    val needsToken: Boolean = false,
    val nextCursor: String? = null,
) {
    val visible: List<Artifact> get() = items.filter { it.matches(query) }
    val canLoadMore: Boolean get() = nextCursor != null && query.isBlank()
}

class ListViewModel(
    private val api: SnapdocApi,
    private val cache: ArtifactsCache,
) : ViewModel() {
    private val _state = MutableStateFlow(ListUiState())
    val state: StateFlow<ListUiState> = _state.asStateFlow()
    private var inFlight: Job? = null

    init {
        // Cache first: the list paints immediately, then the network corrects it.
        val cached = cache.load(cacheKey(_state.value.status))
        if (!cached.isNullOrEmpty()) _state.update { it.copy(items = cached) }
        refresh()
    }

    fun setQuery(query: String) = _state.update { it.copy(query = query) }

    fun setStatus(status: String?) {
        if (status == _state.value.status) return
        val cached = cache.load(cacheKey(status)).orEmpty()
        _state.update { it.copy(status = status, items = cached, nextCursor = null, error = null, offline = false) }
        refresh()
    }

    fun refresh() {
        inFlight?.cancel()
        inFlight = viewModelScope.launch {
            val hadItems = _state.value.items.isNotEmpty()
            _state.update { it.copy(loading = !hadItems, refreshing = hadItems, error = null, needsToken = false) }
            try {
                val status = _state.value.status
                val page = api.listArtifacts(status, null)
                cache.save(cacheKey(status), page.items)
                _state.update {
                    it.copy(
                        items = page.items,
                        nextCursor = page.nextCursor,
                        loading = false,
                        refreshing = false,
                        offline = false,
                        error = null,
                    )
                }
            } catch (e: Throwable) {
                applyFailure(e)
            }
        }
    }

    fun loadMore() {
        val cursor = _state.value.nextCursor ?: return
        if (_state.value.loadingMore) return
        viewModelScope.launch {
            _state.update { it.copy(loadingMore = true) }
            try {
                val page = api.listArtifacts(_state.value.status, cursor)
                _state.update {
                    val merged = (it.items + page.items).distinctBy(Artifact::id)
                    it.copy(items = merged, nextCursor = page.nextCursor, loadingMore = false)
                }
            } catch (e: Throwable) {
                _state.update { it.copy(loadingMore = false, offline = e is OfflineException) }
            }
        }
    }

    private fun applyFailure(e: Throwable) {
        val unauthorized = e is ApiException && e.code == "unauthorized"
        val message = when {
            e is ApiException -> e.message
            e is OfflineException -> "Can't reach snapdoc."
            else -> "Something went wrong."
        }
        _state.update {
            // Keep whatever is on screen; a failed refresh should never blank
            // the list the reader was already looking at.
            val keepingRows = it.items.isNotEmpty() && !unauthorized
            it.copy(
                loading = false,
                refreshing = false,
                offline = keepingRows,
                error = if (keepingRows) null else message,
                needsToken = unauthorized,
            )
        }
    }

    private fun cacheKey(status: String?): String = status ?: "all"
}
