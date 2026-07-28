package dev.carraes.snapdoc.ui

import java.time.Duration
import java.time.Instant

/** "3d left" / "2h left" / "expired" — the only date fact that matters here. */
fun expiryLabel(expiresAt: String?, now: Instant = Instant.now()): String? {
    val instant = expiresAt?.let { runCatching { Instant.parse(it) }.getOrNull() } ?: return null
    val left = Duration.between(now, instant)
    if (left.isNegative || left.isZero) return "expired"
    return when {
        left.toDays() >= 1 -> "${left.toDays()}d left"
        left.toHours() >= 1 -> "${left.toHours()}h left"
        else -> "${left.toMinutes()}m left"
    }
}

fun relativeTime(iso: String, now: Instant = Instant.now()): String {
    val instant = runCatching { Instant.parse(iso) }.getOrNull() ?: return ""
    val elapsed = Duration.between(instant, now)
    return when {
        elapsed.toMinutes() < 1 -> "just now"
        elapsed.toMinutes() < 60 -> "${elapsed.toMinutes()}m ago"
        elapsed.toHours() < 24 -> "${elapsed.toHours()}h ago"
        elapsed.toDays() < 30 -> "${elapsed.toDays()}d ago"
        else -> iso.take(10)
    }
}

fun sizeLabel(bytes: Long): String = when {
    bytes >= 1_000_000 -> "%.1f MB".format(bytes / 1_000_000.0)
    bytes >= 1_000 -> "${bytes / 1_000} KB"
    else -> "$bytes B"
}

fun durationLabel(millis: Long?): String? {
    if (millis == null || millis <= 0) return null
    val total = millis / 1000
    return "%d:%02d".format(total / 60, total % 60)
}
