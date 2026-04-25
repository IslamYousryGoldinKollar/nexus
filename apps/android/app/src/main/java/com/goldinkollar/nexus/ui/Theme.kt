package com.goldinkollar.nexus.ui

import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.lightColorScheme
import androidx.compose.material3.darkColorScheme
import androidx.compose.runtime.Composable

private val LightColorScheme = lightColorScheme(
    primary = androidx.compose.ui.graphics.Color(0xFF1A73E8),
    onPrimary = androidx.compose.ui.graphics.Color(0xFFFFFFFF),
    primaryContainer = androidx.compose.ui.graphics.Color(0xFFD3E3FD),
    onPrimaryContainer = androidx.compose.ui.graphics.Color(0xFF001D36),
    secondary = androidx.compose.ui.graphics.Color(0xFF525252),
    onSecondary = androidx.compose.ui.graphics.Color(0xFFFFFFFF),
    secondaryContainer = androidx.compose.ui.graphics.Color(0xFFE8E8E8),
    onSecondaryContainer = androidx.compose.ui.graphics.Color(0xFF332D23),
    tertiary = androidx.compose.ui.graphics.Color(0xFF7C5800),
    onTertiary = androidx.compose.ui.graphics.Color(0xFFFFFFFF),
    tertiaryContainer = androidx.compose.ui.graphics.Color(0xFFFFDDB3),
    onTertiaryContainer = androidx.compose.ui.graphics.Color(0xFF2C1B00),
    error = androidx.compose.ui.graphics.Color(0xFFB3261E),
    onError = androidx.compose.ui.graphics.Color(0xFFFFFFFF),
    errorContainer = androidx.compose.ui.graphics.Color(0xFFF9DEDC),
    onErrorContainer = androidx.compose.ui.graphics.Color(0xFF601410),
    background = androidx.compose.ui.graphics.Color(0xFFFEF7FF),
    onBackground = androidx.compose.ui.graphics.Color(0xFF1D1B20),
    surface = androidx.compose.ui.graphics.Color(0xFFFEF7FF),
    onSurface = androidx.compose.ui.graphics.Color(0xFF1D1B20),
)

private val DarkColorScheme = darkColorScheme(
    primary = androidx.compose.ui.graphics.Color(0xFFA8C7FA),
    onPrimary = androidx.compose.ui.graphics.Color(0xFF001D36),
    primaryContainer = androidx.compose.ui.graphics.Color(0xFF00458F),
    onPrimaryContainer = androidx.compose.ui.graphics.Color(0xFFD3E3FD),
    secondary = androidx.compose.ui.graphics.Color(0xFFD6C3B5),
    onSecondary = androidx.compose.ui.graphics.Color(0xFF332D23),
    secondaryContainer = androidx.compose.ui.graphics.Color(0xFF4A3C2E),
    onSecondaryContainer = androidx.compose.ui.graphics.Color(0xFFE8E8E8),
    tertiary = androidx.compose.ui.graphics.Color(0xFFF6B895),
    onTertiary = androidx.compose.ui.graphics.Color(0xFF2C1B00),
    tertiaryContainer = androidx.compose.ui.graphics.Color(0xFF5E4300),
    onTertiaryContainer = androidx.compose.ui.graphics.Color(0xFFFFDDB3),
    error = androidx.compose.ui.graphics.Color(0xFFF2B8B5),
    onError = androidx.compose.ui.graphics.Color(0xFF601410),
    errorContainer = androidx.compose.ui.graphics.Color(0xFF8C1D18),
    onErrorContainer = androidx.compose.ui.graphics.Color(0xFFF9DEDC),
    background = androidx.compose.ui.graphics.Color(0xFF141218),
    onBackground = androidx.compose.ui.graphics.Color(0xFFE6E1E5),
    surface = androidx.compose.ui.graphics.Color(0xFF141218),
    onSurface = androidx.compose.ui.graphics.Color(0xFFE6E1E5),
)

@Composable
fun NexusTheme(
    darkTheme: Boolean = false,
    content: @Composable () -> Unit
) {
    val colorScheme = if (darkTheme) DarkColorScheme else LightColorScheme
    MaterialTheme(
        colorScheme = colorScheme,
        content = content
    )
}
