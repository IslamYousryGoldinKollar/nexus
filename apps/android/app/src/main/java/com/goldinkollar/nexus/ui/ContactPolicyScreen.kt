package com.goldinkollar.nexus.ui

import android.Manifest
import android.content.Context
import android.content.pm.PackageManager
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material3.Button
import androidx.compose.material3.Card
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Switch
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateListOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.core.content.ContextCompat
import com.goldinkollar.nexus.data.ContactEntry
import com.goldinkollar.nexus.data.ContactsRepository
import com.goldinkollar.nexus.data.SessionStore
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext

/**
 * Contact-by-contact opt-in toggle for call-recording uploads.
 *
 * Default-deny: a fresh install has zero phones in the allowlist, so
 * UploadRecordingWorker drops every recording until the user
 * explicitly enables one. Master switch at the top can disable the
 * filter entirely (upload-everything mode) for the rare case the user
 * wants to capture an unlisted business number quickly.
 *
 * Numbers are stored as E.164 in SharedPreferences. We compare against
 * the phone parsed from the recording filename (most recorders embed
 * `+201234567890` or similar in the filename).
 */
@Composable
fun ContactPolicyScreen(onBack: () -> Unit) {
    val context = LocalContext.current
    val store = remember { SessionStore.shared(context) }

    var hasPerm by remember { mutableStateOf(hasContactsPermission(context)) }
    var filterEnabled by remember { mutableStateOf(store.recordingFilterEnabled) }
    var contacts by remember { mutableStateOf<List<ContactEntry>>(emptyList()) }
    val opted = remember { mutableStateListOf<String>().apply { addAll(store.optedInRecordingPhones()) } }
    var query by remember { mutableStateOf("") }
    var loading by remember { mutableStateOf(false) }

    val permLauncher = rememberLauncherForActivityResult(
        ActivityResultContracts.RequestPermission(),
    ) { granted ->
        hasPerm = granted
    }

    LaunchedEffect(hasPerm) {
        if (!hasPerm) return@LaunchedEffect
        loading = true
        contacts = withContext(Dispatchers.IO) { ContactsRepository.loadContacts(context) }
        loading = false
    }

    val filtered = remember(contacts, query) {
        if (query.isBlank()) contacts
        else contacts.filter {
            it.displayName.contains(query, ignoreCase = true) ||
                it.phoneNumbersE164.any { p -> p.contains(query) }
        }
    }

    Column(modifier = Modifier.fillMaxSize().padding(16.dp)) {
        Row(verticalAlignment = Alignment.CenterVertically, modifier = Modifier.fillMaxWidth()) {
            TextButton(onClick = onBack) { Text("← Back") }
            Spacer(Modifier.weight(1f))
        }

        Text("Call recording — contact policy", style = MaterialTheme.typography.titleLarge)
        Spacer(Modifier.height(4.dp))
        Text(
            "Pick which contacts get their call recordings uploaded. " +
                "Recordings from numbers not on this list are skipped — " +
                "personal calls don't leave your phone.",
            style = MaterialTheme.typography.bodySmall,
            color = MaterialTheme.colorScheme.outline,
        )

        Spacer(Modifier.height(12.dp))

        Card(modifier = Modifier.fillMaxWidth()) {
            Row(
                verticalAlignment = Alignment.CenterVertically,
                modifier = Modifier.padding(horizontal = 16.dp, vertical = 12.dp).fillMaxWidth(),
            ) {
                Column(modifier = Modifier.weight(1f)) {
                    Text("Filter recordings by contact", style = MaterialTheme.typography.titleSmall)
                    Text(
                        if (filterEnabled) "Only opted-in contacts are uploaded"
                        else "All recordings are uploaded (filter off)",
                        style = MaterialTheme.typography.bodySmall,
                        color = MaterialTheme.colorScheme.outline,
                    )
                }
                Switch(
                    checked = filterEnabled,
                    onCheckedChange = {
                        filterEnabled = it
                        store.setRecordingFilterEnabled(it)
                    },
                )
            }
        }

        Spacer(Modifier.height(12.dp))

        if (!hasPerm) {
            Card(modifier = Modifier.fillMaxWidth()) {
                Column(modifier = Modifier.padding(16.dp)) {
                    Text("Contacts permission needed", style = MaterialTheme.typography.titleSmall)
                    Spacer(Modifier.height(4.dp))
                    Text(
                        "We read your address book locally so you can pick contacts by name. " +
                            "Nothing leaves your device — only the phone numbers you opt in get " +
                            "matched against incoming recording filenames.",
                        style = MaterialTheme.typography.bodySmall,
                        color = MaterialTheme.colorScheme.outline,
                    )
                    Spacer(Modifier.height(8.dp))
                    Button(onClick = { permLauncher.launch(Manifest.permission.READ_CONTACTS) }) {
                        Text("Grant access")
                    }
                }
            }
            return@Column
        }

        OutlinedTextField(
            value = query,
            onValueChange = { query = it },
            label = { Text("Search by name or number") },
            modifier = Modifier.fillMaxWidth(),
            singleLine = true,
            keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Text),
        )

        Spacer(Modifier.height(8.dp))

        Text(
            "${opted.size} of ${contacts.size} contacts opted in" +
                if (loading) " · loading…" else "",
            style = MaterialTheme.typography.bodySmall,
            color = MaterialTheme.colorScheme.outline,
        )

        Spacer(Modifier.height(8.dp))
        HorizontalDivider()

        LazyColumn(
            modifier = Modifier.fillMaxSize(),
            verticalArrangement = Arrangement.spacedBy(0.dp),
        ) {
            items(filtered, key = { it.phoneNumbersE164.firstOrNull() ?: it.displayName }) { c ->
                ContactRow(
                    entry = c,
                    isAnyOpted = c.phoneNumbersE164.any { it in opted },
                    onToggle = { newOpt ->
                        for (p in c.phoneNumbersE164) {
                            if (newOpt) {
                                if (p !in opted) opted += p
                            } else {
                                opted -= p
                            }
                        }
                        store.setOptedInRecordingPhones(opted.toSet())
                    },
                )
                HorizontalDivider()
            }
        }
    }
}

@Composable
private fun ContactRow(
    entry: ContactEntry,
    isAnyOpted: Boolean,
    onToggle: (Boolean) -> Unit,
) {
    Row(
        verticalAlignment = Alignment.CenterVertically,
        modifier = Modifier.fillMaxWidth().padding(vertical = 12.dp),
    ) {
        Column(modifier = Modifier.weight(1f)) {
            Text(entry.displayName, style = MaterialTheme.typography.bodyMedium, maxLines = 1, overflow = TextOverflow.Ellipsis)
            Text(
                entry.phoneNumbersE164.joinToString(" · "),
                style = MaterialTheme.typography.bodySmall,
                color = MaterialTheme.colorScheme.outline,
                fontFamily = FontFamily.Monospace,
                maxLines = 1,
                overflow = TextOverflow.Ellipsis,
            )
        }
        Switch(checked = isAnyOpted, onCheckedChange = onToggle)
    }
}

private fun hasContactsPermission(context: Context): Boolean =
    ContextCompat.checkSelfPermission(context, Manifest.permission.READ_CONTACTS) ==
        PackageManager.PERMISSION_GRANTED
