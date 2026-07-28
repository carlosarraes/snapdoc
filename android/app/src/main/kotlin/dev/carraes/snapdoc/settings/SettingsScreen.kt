package dev.carraes.snapdoc.settings

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Button
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.input.PasswordVisualTransformation
import androidx.compose.ui.unit.dp

@Composable
fun SettingsScreen(
    state: SettingsUiState,
    onSaveToken: (String) -> Unit,
    onAddPasscode: (String) -> Unit,
    onRemovePasscode: (String) -> Unit,
    onForgetUnlocked: () -> Unit,
    onBack: () -> Unit,
) {
    var token by remember(state.tokenSaved) { mutableStateOf("") }
    var passcode by remember { mutableStateOf("") }

    Column(
        modifier = Modifier.fillMaxSize().verticalScroll(rememberScrollState()).padding(16.dp),
        verticalArrangement = Arrangement.spacedBy(12.dp),
    ) {
        Row(verticalAlignment = Alignment.CenterVertically) {
            Text("Settings", style = MaterialTheme.typography.titleLarge, modifier = Modifier.weight(1f))
            if (state.tokenSaved) TextButton(onClick = onBack) { Text("Done") }
        }

        Text("API token", style = MaterialTheme.typography.titleMedium)
        Text(
            state.tokenStatus,
            style = MaterialTheme.typography.bodySmall,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
        )
        OutlinedTextField(
            value = token,
            onValueChange = { token = it },
            singleLine = true,
            visualTransformation = PasswordVisualTransformation(),
            placeholder = { Text(if (state.tokenSaved) "Replace token" else "sd_live_…") },
            supportingText = { Text("The list shows documents published with this token.") },
            isError = state.tokenError != null,
            modifier = Modifier.fillMaxWidth(),
        )
        state.tokenError?.let {
            Text(it, color = MaterialTheme.colorScheme.error, style = MaterialTheme.typography.bodySmall)
        }
        Button(
            onClick = { onSaveToken(token.trim()); token = "" },
            enabled = token.isNotBlank() && !state.checkingToken,
        ) { Text(if (state.checkingToken) "Checking…" else "Save token") }

        HorizontalDivider(color = MaterialTheme.colorScheme.outlineVariant)

        Text("Passcodes", style = MaterialTheme.typography.titleMedium)
        Text(
            "Protected documents are unlocked with these automatically. " +
                "If none fit, the app asks once and saves what works.",
            style = MaterialTheme.typography.bodySmall,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
        )
        state.passcodes.forEach { saved ->
            Row(modifier = Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
                Text(maskPasscode(saved), modifier = Modifier.weight(1f))
                TextButton(onClick = { onRemovePasscode(saved) }) { Text("Remove") }
            }
        }
        if (state.passcodes.isEmpty()) {
            Text(
                "None saved yet.",
                style = MaterialTheme.typography.bodySmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )
        }
        OutlinedTextField(
            value = passcode,
            onValueChange = { passcode = it },
            singleLine = true,
            visualTransformation = PasswordVisualTransformation(),
            placeholder = { Text("Add a passcode") },
            modifier = Modifier.fillMaxWidth(),
        )
        Button(onClick = { onAddPasscode(passcode.trim()); passcode = "" }, enabled = passcode.isNotBlank()) {
            Text("Add passcode")
        }

        HorizontalDivider(color = MaterialTheme.colorScheme.outlineVariant)
        TextButton(onClick = onForgetUnlocked) { Text("Forget unlocked documents") }
        Text(
            "Clears the unlock cookies and which passcode opened which document.",
            style = MaterialTheme.typography.bodySmall,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
        )
    }
}

/** Never render a saved passcode in full — only enough to tell them apart. */
private fun maskPasscode(code: String): String =
    if (code.length <= 2) "•".repeat(code.length) else code.take(1) + "•".repeat(code.length - 2) + code.last()
