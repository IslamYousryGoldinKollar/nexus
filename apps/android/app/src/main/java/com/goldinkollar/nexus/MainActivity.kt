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
        super.onCreate(savedInstanceState)
        setContent {
            NexusTheme {
                NexusAppRoot()
            }
        }
    }
}

/**
 * Catches anything thrown during composition / first read of session
 * state and renders an in-app error screen instead of letting Android
 * kill the process. Tap-to-dismiss on the next launch attempt is the
 * built-in OS retry path.
 */
@Composable
private fun NexusAppRoot() {
    var error by remember { mutableStateOf<Throwable?>(null) }
    val captured = error
    if (captured != null) {
        StartupErrorScreen(captured)
        return
    }
    runCatching { NexusApp() }.onFailure { t ->
        Log.e("MainActivity", "NexusApp threw during composition", t)
        error = t
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
