package com.goldinkollar.nexus.ui

import android.Manifest
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.net.Uri
import android.os.Build
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.width
import androidx.compose.material3.AssistChipDefaults
import androidx.compose.material3.Button
import androidx.compose.material3.Card
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.core.content.ContextCompat
import com.goldinkollar.nexus.data.SessionStore
import com.goldinkollar.nexus.recording.RecordingObserverService

/**
 * Inline card that drives the SAF-based recording observer.
 *
 * Workflow:
 *   1. User taps "Pick folder" → system OpenDocumentTree picker.
 *   2. We persist the URI permission so it survives reboots, and stash
 *      the URI in SessionStore.
 *   3. Tap "Enable" → start RecordingObserverService (foreground).
 *      The service polls the picked folder every 30s and uploads any
 *      new audio/video files it finds.
 *
 * Notification permission is still required on Android 13+ so the
 * foreground service can show its persistent notification.
 */
@Composable
fun RecordingControl(onContactPolicyClick: () -> Unit = {}) {
    val context = LocalContext.current
    val store = remember { SessionStore.shared(context) }

    var enabled by remember { mutableStateOf(isServiceRunning(context)) }
    var folderUri by remember { mutableStateOf(store.recordingFolderUri) }
    var notifGranted by remember { mutableStateOf(hasNotificationPermission(context)) }
    // Show the contact-name count rather than phone count — it's
    // 1:1 with the toggle the user actually flipped, even when a
    // contact has multiple numbers.
    val optedInCount = remember { store.optedInRecordingNames().size }

    LaunchedEffect(Unit) {
        notifGranted = hasNotificationPermission(context)
        folderUri = store.recordingFolderUri
    }

    val pickerLauncher = rememberLauncherForActivityResult(
        contract = ActivityResultContracts.OpenDocumentTree(),
    ) { uri: Uri? ->
        if (uri != null) {
            // Persist the grant so the URI keeps working after a reboot.
            val flags = Intent.FLAG_GRANT_READ_URI_PERMISSION
            try {
                context.contentResolver.takePersistableUriPermission(uri, flags)
            } catch (_: SecurityException) {
                // Some launchers return a one-shot grant; fall back to
                // ephemeral and let the next picker click re-grant.
            }
            store.setRecordingFolderUri(uri.toString())
            folderUri = uri.toString()
        }
    }

    val notifLauncher = rememberLauncherForActivityResult(
        contract = ActivityResultContracts.RequestPermission(),
    ) { granted ->
        notifGranted = granted
        if (granted && folderUri != null) {
            startRecordingService(context)
            enabled = true
        }
    }

    Card(modifier = Modifier.padding(vertical = 4.dp)) {
        Column(modifier = Modifier.padding(16.dp)) {
            Row(verticalAlignment = Alignment.CenterVertically) {
                Text("Call recording", style = MaterialTheme.typography.titleMedium)
                Spacer(Modifier.width(8.dp))
                Text(
                    if (enabled) "· active" else "· off",
                    color = MaterialTheme.colorScheme.outline,
                    style = MaterialTheme.typography.bodySmall,
                )
            }
            Spacer(Modifier.height(8.dp))
            Text(
                "Pick the folder where your call-recorder app (Cube ACR, " +
                    "Samsung Recorder, etc.) saves its files. Nexus will watch " +
                    "the folder and upload new recordings automatically.",
                style = MaterialTheme.typography.bodySmall,
                color = MaterialTheme.colorScheme.outline,
            )
            Spacer(Modifier.height(12.dp))

            Row(
                verticalAlignment = Alignment.CenterVertically,
                modifier = Modifier.fillMaxWidth(),
            ) {
                Text(
                    "Folder: ",
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.outline,
                )
                Text(
                    text = folderUri?.let { friendlyFolderLabel(it) } ?: "— not picked —",
                    style = MaterialTheme.typography.bodySmall,
                    fontFamily = FontFamily.Monospace,
                    maxLines = 1,
                    overflow = TextOverflow.Ellipsis,
                    modifier = Modifier.weight(1f, fill = true),
                )
            }
            Spacer(Modifier.height(8.dp))

            Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                OutlinedButton(onClick = { pickerLauncher.launch(null) }) {
                    Text(if (folderUri == null) "Pick folder" else "Change folder")
                }

                if (!enabled) {
                    Button(
                        enabled = folderUri != null,
                        onClick = {
                            if (!notifGranted && Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
                                notifLauncher.launch(Manifest.permission.POST_NOTIFICATIONS)
                            } else {
                                startRecordingService(context)
                                enabled = true
                            }
                        },
                    ) {
                        Text("Enable")
                    }
                } else {
                    OutlinedButton(onClick = {
                        stopRecordingService(context)
                        enabled = false
                    }) {
                        Text("Disable")
                    }
                }

                if (folderUri != null) {
                    TextButton(onClick = {
                        store.setRecordingFolderUri(null)
                        folderUri = null
                        if (enabled) {
                            stopRecordingService(context)
                            enabled = false
                        }
                    }) {
                        Text("Clear")
                    }
                }
            }

            if (folderUri == null) {
                Spacer(Modifier.height(8.dp))
                Text(
                    "Tip: on Android 14+, OS-level call recordings live under " +
                        "Internal storage → Recordings → Call. " +
                        "Older builds & third-party recorders use " +
                        "\"Cube Call Recorder\" / \"Recorder\".",
                    style = MaterialTheme.typography.bodySmall,
                    color = AssistChipDefaults.assistChipColors().labelColor,
                )
            }

            // Per-contact opt-in entry. Default-deny: if the user has
            // not opted in any contacts, the upload worker drops every
            // recording until they curate their allowlist here.
            Spacer(Modifier.height(12.dp))
            Row(
                verticalAlignment = Alignment.CenterVertically,
                modifier = Modifier.fillMaxWidth(),
            ) {
                Column(modifier = Modifier.weight(1f)) {
                    Text(
                        "Contact filter",
                        style = MaterialTheme.typography.bodyMedium,
                    )
                    Text(
                        if (optedInCount == 0)
                            "Default-deny — no recordings will upload until you opt in"
                        else "$optedInCount contact${if (optedInCount == 1) "" else "s"} opted in",
                        style = MaterialTheme.typography.bodySmall,
                        color = MaterialTheme.colorScheme.outline,
                    )
                }
                TextButton(onClick = onContactPolicyClick) { Text("Manage →") }
            }
        }
    }
}

private fun hasNotificationPermission(context: Context): Boolean {
    if (Build.VERSION.SDK_INT < Build.VERSION_CODES.TIRAMISU) return true
    return ContextCompat.checkSelfPermission(
        context, Manifest.permission.POST_NOTIFICATIONS,
    ) == PackageManager.PERMISSION_GRANTED
}

private fun isServiceRunning(context: Context): Boolean {
    @Suppress("DEPRECATION")
    val am = context.getSystemService(Context.ACTIVITY_SERVICE) as? android.app.ActivityManager
        ?: return false
    @Suppress("DEPRECATION")
    return am.getRunningServices(Int.MAX_VALUE).any {
        it.service.className == RecordingObserverService::class.java.name
    }
}

private fun startRecordingService(context: Context) {
    val intent = Intent(context, RecordingObserverService::class.java)
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
        context.startForegroundService(intent)
    } else {
        context.startService(intent)
    }
}

/**
 * Decode the tree-URI's last path segment back into a human-readable
 * folder name. Tree URIs look like:
 *   content://com.android.externalstorage.documents/tree/primary%3ACube%20Call%20Recorder%2Fall
 * → "primary:Cube Call Recorder/all"
 */
private fun friendlyFolderLabel(uriStr: String): String {
    return try {
        val uri = Uri.parse(uriStr)
        val raw = uri.lastPathSegment ?: return uriStr
        Uri.decode(raw)
    } catch (_: Throwable) {
        uriStr
    }
}

private fun stopRecordingService(context: Context) {
    context.stopService(Intent(context, RecordingObserverService::class.java))
}
