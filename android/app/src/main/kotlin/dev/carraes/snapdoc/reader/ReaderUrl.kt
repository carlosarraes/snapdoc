package dev.carraes.snapdoc.reader

import dev.carraes.snapdoc.artifacts.Artifact
import dev.carraes.snapdoc.artifacts.ArtifactKind
import dev.carraes.snapdoc.net.ARTIFACT_HOST

enum class ReaderMode { REVIEW, READ }

object ReaderUrl {
    /**
     * Always the artifact host: that is where the unlock cookie is scoped, and
     * the API host redirects protected review pages here anyway.
     *
     * The review page only frames the document when the owner enabled reader
     * comments — without that it renders a "commenting is turned off" panel and
     * no document at all, so an uncommentable artifact must never be sent there.
     */
    fun of(artifact: Artifact, mode: ReaderMode): String {
        val reviewable = artifact.kind == ArtifactKind.DOCUMENT && artifact.commentsEnabled
        return if (mode == ReaderMode.REVIEW && reviewable) {
            "$ARTIFACT_HOST/review/${artifact.id}"
        } else {
            "$ARTIFACT_HOST/${artifact.id}"
        }
    }

    /** The `next` value the unlock endpoint will accept for this destination. */
    fun unlockNext(artifact: Artifact, mode: ReaderMode): String =
        if (of(artifact, mode).endsWith("/review/${artifact.id}")) "/review/${artifact.id}" else "/${artifact.id}"

    /** Whether offering a Review toggle makes sense for this artifact. */
    fun canReview(artifact: Artifact): Boolean =
        artifact.kind == ArtifactKind.DOCUMENT && artifact.commentsEnabled
}
