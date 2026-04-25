package com.goldinkollar.nexus

import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.compose.runtime.Composable
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.ui.Modifier
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
                NexusApp()
            }
        }
    }
}

/**
 * Top-level routing decision — paired or not?
 * Watching `apiKey` as a Flow auto-flips to ApprovalsScreen the moment
 * pairing succeeds.
 */
@Composable
private fun NexusApp() {
    val store = SessionStore.shared(LocalApplicationContext.current)
    val apiKey by store.apiKeyFlow.collectAsStateWithLifecycle(initialValue = null)

    if (apiKey.isNullOrBlank()) {
        PairingScreen(onPaired = { /* state flow flips automatically */ })
    } else {
        ApprovalsScreen()
    }
}

// LocalApplicationContext for cleaner accessor
private val LocalApplicationContext = androidx.compose.ui.platform.LocalContext
