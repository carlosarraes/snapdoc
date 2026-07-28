package dev.carraes.snapdoc

import dev.carraes.snapdoc.artifacts.ArtifactPage
import dev.carraes.snapdoc.artifacts.ListViewModel
import dev.carraes.snapdoc.net.OfflineException
import java.io.IOException
import kotlin.test.AfterTest
import kotlin.test.BeforeTest
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertNull
import kotlin.test.assertTrue
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.test.StandardTestDispatcher
import kotlinx.coroutines.test.advanceUntilIdle
import kotlinx.coroutines.test.resetMain
import kotlinx.coroutines.test.runTest
import kotlinx.coroutines.test.setMain

@OptIn(ExperimentalCoroutinesApi::class)
class ListViewModelTest {
    private val dispatcher = StandardTestDispatcher()

    @BeforeTest fun setUp() = Dispatchers.setMain(dispatcher)

    @AfterTest fun tearDown() = Dispatchers.resetMain()

    @Test
    fun `shows cached rows before the network answers`() = runTest {
        val cached = listOf(artifact(id = "cachedcachedaa", title = "Cached"))
        val cache = FakeCache(mutableMapOf("active" to cached))
        val api = FakeApi(mutableListOf(Result.success(ArtifactPage(listOf(artifact(title = "Fresh")), null))))

        val model = ListViewModel(api, cache)
        assertEquals(listOf("Cached"), model.state.value.items.map { it.title }, "no empty flash on open")

        advanceUntilIdle()
        assertEquals(listOf("Fresh"), model.state.value.items.map { it.title })
    }

    @Test
    fun `a failed refresh keeps the rows and says it is offline`() = runTest {
        val cached = listOf(artifact(title = "Cached"))
        val api = FakeApi(mutableListOf(Result.failure(OfflineException(IOException("down")))))

        val model = ListViewModel(api, FakeCache(mutableMapOf("active" to cached)))
        advanceUntilIdle()

        val state = model.state.value
        assertEquals(listOf("Cached"), state.items.map { it.title }, "must not blank the list")
        assertTrue(state.offline)
        assertNull(state.error)
    }

    @Test
    fun `a failure with nothing cached surfaces an error`() = runTest {
        val api = FakeApi(mutableListOf(Result.failure(OfflineException(IOException("down")))))
        val model = ListViewModel(api, FakeCache())
        advanceUntilIdle()

        assertEquals("Can't reach snapdoc.", model.state.value.error)
        assertFalse(model.state.value.offline)
    }

    @Test
    fun `a rejected token asks for settings instead of showing stale rows`() = runTest {
        val api = FakeApi(mutableListOf(Result.failure(unauthorized())))
        val model = ListViewModel(api, FakeCache(mutableMapOf("active" to listOf(artifact()))))
        advanceUntilIdle()

        assertTrue(model.state.value.needsToken)
        assertTrue(model.state.value.error != null)
    }

    @Test
    fun `load more appends and never duplicates`() = runTest {
        val first = artifact(id = "aaaaaaaaaaaaaa", title = "One")
        val second = artifact(id = "bbbbbbbbbbbbbb", title = "Two")
        val api = FakeApi(
            mutableListOf(
                Result.success(ArtifactPage(listOf(first), "cursor-1")),
                // The overlap is deliberate: paging can repeat a row.
                Result.success(ArtifactPage(listOf(first, second), null)),
            ),
        )
        val model = ListViewModel(api, FakeCache())
        advanceUntilIdle()
        assertTrue(model.state.value.canLoadMore)

        model.loadMore()
        advanceUntilIdle()
        assertEquals(listOf("One", "Two"), model.state.value.items.map { it.title })
        assertFalse(model.state.value.canLoadMore)
    }

    @Test
    fun `search filters the visible rows without refetching`() = runTest {
        val api = FakeApi(
            mutableListOf(
                Result.success(
                    ArtifactPage(
                        listOf(artifact(id = "aaaaaaaaaaaaaa", title = "Deal Hub"), artifact(id = "bbbbbbbbbbbbbb", title = "Roadmap")),
                        null,
                    ),
                ),
            ),
        )
        val model = ListViewModel(api, FakeCache())
        advanceUntilIdle()
        val callsAfterLoad = api.listCalls

        model.setQuery("road")
        assertEquals(listOf("Roadmap"), model.state.value.visible.map { it.title })
        assertEquals(callsAfterLoad, api.listCalls, "search is local")
        assertFalse(model.state.value.canLoadMore, "paging is meaningless while filtering")
    }

    @Test
    fun `changing status swaps the cache and refetches`() = runTest {
        val api = FakeApi(
            mutableListOf(
                Result.success(ArtifactPage(listOf(artifact(title = "Active")), "cursor")),
                Result.success(ArtifactPage(listOf(artifact(title = "Expired")), null)),
            ),
        )
        val model = ListViewModel(api, FakeCache())
        advanceUntilIdle()

        model.setStatus("expired")
        assertNull(model.state.value.nextCursor, "the old page's cursor must not leak into the new filter")
        advanceUntilIdle()
        assertEquals(listOf("Expired"), model.state.value.items.map { it.title })
    }
}
