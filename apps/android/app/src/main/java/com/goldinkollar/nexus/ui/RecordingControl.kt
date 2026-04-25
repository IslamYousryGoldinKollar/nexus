package com.goldinkollar.nexus.ui

import android.Manifest
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.os.Build
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.width
import androidx.compose.material3.Button
import androidx.compose.material3.Card
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.unit.dp
import androidx.core.content.ContextCompat
import com.goldinkollar.nexus.recording.RecordingObserverService

/**
 * Inline card that surfaces the Phase 8 (Wave A') call-recording observer
 * service: requests the storage + notification perms it needs, then starts
 * RecordingObserverService.
 *
 * Untested on Samsung S24 hardware in this session. Server-side
 * `/api/ingest/phone` is still a Phase 0 stub — uploads will 4xx until
 * Phase 1 phone ingest lands; the worker's WorkManager retry backoff
 * means the queue won't lose anything in the meantime.
 */
@Composable
fun RecordingControl() {
    val context = LocalContext.current
    var enabled by remember { mutableStateOf(isServiceRunning(context)) }
    var permissionsGranted by remember { mutableStateOf(hasAllPermissions(context)) }

    LaunchedEffect(Unit) {
        permissionsGranted = hasAllPermissions(context)
    }

    val permissionLauncher = rememberLauncherForActivityResult(
        contract = ActivityResultContracts.RequestMultiplePermissions(),
    ) { results ->
        permissionsGranted = results.values.all { it }
        if (permissionsGranted) {
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
                "Watches /storage/emulated/0/Cube Call Recorder/all and similar dirs " +
                    "for new recordings, then uploads them to Nexus for transcription.",
                style = MaterialTheme.typography.bodySmall,
                color = MaterialTheme.colorScheme.outline,
            )
            Spacer(Modifier.height(12.dp))
            Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                if (!enabled) {
                    Button(onClick = {
                        if (permissionsGranted) {
                            startRecordingService(context)
                            enabled = true
                        } else {
                            permissionLauncher.launch(requiredPermissions().toTypedArray())
                        }
                    }) {
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
            }
        }
    }
}

private fun requiredPermissions(): List<String> {
    val perms = mutableListOf<String>()
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
        perms += Manifest.permission.READ_MEDIA_AUDIO
        perms += Manifest.permission.POST_NOTIFICATIONS
    } else {
        @Suppress("DEPRECATION")
        perms += Manifest.permission.READ_EXTERNAL_STORAGE
    }
    return perms
}

private fun hasAllPermissions(context: Context): Boolean =
    requiredPermissions().all {
        ContextCompat.checkSelfPermission(context, it) == PackageManager.PERMISSION_GRANTED
    }

private fun isServiceRunning(context: Context): Boolean {
    // Best-effort lookup. ActivityManager.getRunningServices is deprecated
    // for non-owned services on API 26+, but our own service is always
    // visible. Used for UI-state hydration only.
    @Suppress("DEPRECATION")
    val am =
        context.getSystemService(Context.ACTIVITY_SERVICE) as? android.app.ActivityManager
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

private fun stopRecordingService(context: Context) {
    context.stopService(Intent(context, RecordingObserverService::class.java))
}
