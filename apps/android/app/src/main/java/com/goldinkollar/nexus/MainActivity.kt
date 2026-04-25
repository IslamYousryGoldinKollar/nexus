package com.goldinkollar.nexus

import android.os.Bundle
import android.util.Log
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.unit.dp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import com.goldinkollar.nexus.data.SessionStore
import com.goldinkollar.nexus.ui.ApprovalsScreen
import com.goldinkollar.nexus.ui.NexusTheme
import com.goldinkollar.nexus.ui.PairingScreen

class MainActivity : ComponentActivity() {

    override fun onCreate(savedInstanceState: Bundle?) {
        // Pull any persisted crash from a previous launch BEFORE we
        // touch the rest of init — so even if onCreate itself dies, the
        // next launch will surface today's crash.
        val previousCrash = try {
            CrashRecorder.consume(filesDir)
        } catch (t: Throwable) {
            Log.w("MainActivity", "CrashRecorder.consume failed", t)
            null
        }

        try {
            super.onCreate(savedInstanceState)
            setContent {
                NexusTheme {
                    NexusAppRoot(previousCrash = previousCrash)
                }
            }
        } catch (t: Throwable) {
            CrashRecorder.record(filesDir, "MainActivity.onCreate", t)
            // Re-throw so the OS still records the crash.
            throw t
        }
    }
}

/**
 * Catches anything thrown during composition / first read of session
 * state and renders an in-app error screen instead of letting Android
 * kill the process. Also surfaces a persisted crash from a previous
 * launch (recorded via CrashRecorder) so the user can screenshot the
 * actual stack trace instead of the generic OS dialog.
 */
@Composable
private fun NexusAppRoot(previousCrash: String?) {
    var error by remember { mutableStateOf<Throwable?>(null) }

    // If we captured a crash from last launch, prioritize showing it.
    if (previousCrash != null && error == null) {
        PriorCrashScreen(previousCrash)
        return
    }

    val captured = error
    if (captured != null) {
        StartupErrorScreen(captured)
        return
    }
    // Capture LocalContext outside the lambda — Compose disallows
    // composition-local reads from non-@Composable lambda bodies.
    val context = LocalContext.current
    runCatching { NexusApp() }.onFailure { t ->
        Log.e("MainActivity", "NexusApp threw during composition", t)
        runCatching { CrashRecorder.record(context.filesDir, "NexusApp.composition", t) }
        error = t
    }
}

@Composable
private fun PriorCrashScreen(report: String) {
    val scroll = rememberScrollState()
    Column(
        modifier = Modifier
            .fillMaxSize()
            .padding(16.dp)
            .verticalScroll(scroll),
        verticalArrangement = Arrangement.spacedBy(8.dp),
    ) {
        Text("Nexus crashed last launch", style = MaterialTheme.typography.headlineSmall)
        Text(
            "This screen is your bug report. Screenshot and send it.",
            style = MaterialTheme.typography.bodyMedium,
        )
        Text(report, style = MaterialTheme.typography.bodySmall)
    }
}

/**
 * Top-level routing decision — paired or not?
 * Watching `apiKey` as a Flow auto-flips to ApprovalsScreen the moment
 * pairing succeeds.
 */
@Composable
private fun NexusApp() {
    val store = SessionStore.shared(LocalContext.current)
    val apiKey by store.apiKeyFlow.collectAsStateWithLifecycle(initialValue = null)

    if (apiKey.isNullOrBlank()) {
        PairingScreen(onPaired = { /* state flow flips automatically */ })
    } else {
        ApprovalsScreen()
    }
}

@Composable
private fun StartupErrorScreen(error: Throwable) {
    val scroll = rememberScrollState()
    Column(
        modifier = Modifier
            .fillMaxSize()
            .padding(16.dp)
            .verticalScroll(scroll),
        verticalArrangement = Arrangement.spacedBy(8.dp),
    ) {
        Text("Nexus failed to start", style = MaterialTheme.typography.headlineSmall)
        Text(
            "Send this to support so the bug can be fixed:",
            style = MaterialTheme.typography.bodyMedium,
        )
        Text(error.javaClass.name, style = MaterialTheme.typography.titleMedium)
        Text(error.message ?: "(no message)", style = MaterialTheme.typography.bodyMedium)
        Text(error.stackTraceToString(), style = MaterialTheme.typography.bodySmall)
    }
}
