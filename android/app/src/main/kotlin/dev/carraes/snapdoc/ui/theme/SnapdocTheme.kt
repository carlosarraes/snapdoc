package dev.carraes.snapdoc.ui.theme

import androidx.compose.foundation.isSystemInDarkTheme
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.darkColorScheme
import androidx.compose.material3.lightColorScheme
import androidx.compose.runtime.Composable
import androidx.compose.ui.graphics.Color

// The snapdoc web palette (GitHub Primer), so the app and the documents it
// frames read as one product. Deliberately NOT Material You: dynamic color
// would repaint everything in the wallpaper's hues.
private val LightBackground = Color(0xFFF6F8FA)
private val LightSurface = Color(0xFFFFFFFF)
private val LightText = Color(0xFF1F2328)
private val LightMuted = Color(0xFF59636E)
private val LightBorder = Color(0xFFD1D9E0)
private val LightAccent = Color(0xFF0969DA)
private val LightDanger = Color(0xFFCF222E)

private val DarkBackground = Color(0xFF0D1117)
private val DarkSurface = Color(0xFF161B22)
private val DarkText = Color(0xFFE6EDF3)
private val DarkMuted = Color(0xFF9198A1)
private val DarkBorder = Color(0xFF30363D)
private val DarkAccent = Color(0xFF4493F8)
private val DarkDanger = Color(0xFFF85149)

/** Amber used for quoted anchor text, matching `--quote` on the review page. */
val QuoteLight = Color(0xFFFFF8C5)
val QuoteDark = Color(0xFF3F3A10)

private val LightColors = lightColorScheme(
    primary = LightAccent,
    onPrimary = Color.White,
    background = LightBackground,
    onBackground = LightText,
    surface = LightSurface,
    onSurface = LightText,
    surfaceVariant = LightBackground,
    onSurfaceVariant = LightMuted,
    outline = LightBorder,
    outlineVariant = LightBorder,
    error = LightDanger,
)

private val DarkColors = darkColorScheme(
    primary = DarkAccent,
    onPrimary = DarkBackground,
    background = DarkBackground,
    onBackground = DarkText,
    surface = DarkSurface,
    onSurface = DarkText,
    surfaceVariant = DarkSurface,
    onSurfaceVariant = DarkMuted,
    outline = DarkBorder,
    outlineVariant = DarkBorder,
    error = DarkDanger,
)

@Composable
fun SnapdocTheme(dark: Boolean = isSystemInDarkTheme(), content: @Composable () -> Unit) {
    MaterialTheme(colorScheme = if (dark) DarkColors else LightColors, content = content)
}
