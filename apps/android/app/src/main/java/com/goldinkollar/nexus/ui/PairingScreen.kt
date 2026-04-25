package com.goldinkollar.nexus.ui

import android.os.Build
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.width
import androidx.compose.material3.Button
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.unit.dp
import com.goldinkollar.nexus.data.NexusApi
import com.goldinkollar.nexus.data.PairClaimRequest
import com.goldinkollar.nexus.data.SessionStore
import kotlinx.coroutines.launch

/**
 * Pairing screen — user can enter the 6-char code from web /settings OR scan QR code.
 * On success, SessionStore writes the API key and MainActivity flips to
 * the approvals screen automatically (Flow observation).
 */
@Composable
fun PairingScreen(onPaired: () -> Unit) {
    val context = LocalContext.current
    val store = remember { SessionStore.shared(context) }
    val scope = rememberCoroutineScope()

    var code by remember { mutableStateOf("") }
    var loading by remember { mutableStateOf(false) }
    var error by remember { mutableStateOf<String?>(null) }
    var showQrScanner by remember { mutableStateOf(false) }

    Column(
        modifier = Modifier
            .fillMaxSize()
            .padding(24.dp),
        verticalArrangement = Arrangement.Center,
        horizontalAlignment = Alignment.CenterHorizontally,
    ) {
        if (showQrScanner) {
            QrScanner(
                onCodeScanned = { scannedCode ->
                    code = scannedCode
                    showQrScanner = false
                },
                modifier = Modifier.fillMaxSize()
            )
            Spacer(Modifier.height(16.dp))
            OutlinedButton(onClick = { showQrScanner = false }) {
                Text("Cancel")
            }
        } else {
            Text("Pair this device", style = androidx.compose.material3.MaterialTheme.typography.headlineSmall)
            Spacer(Modifier.height(8.dp))
            Text(
                "Open Nexus admin → Settings → Pair new device, then scan QR or type the 6-character code below.",
                style = androidx.compose.material3.MaterialTheme.typography.bodyMedium,
            )
            Spacer(Modifier.height(24.dp))
            OutlinedTextField(
                value = code,
                onValueChange = { code = it.uppercase().take(8) },
                label = { Text("Pairing code") },
                singleLine = true,
            )
            Spacer(Modifier.height(16.dp))
            Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                Button(
                    onClick = {
                        error = null
                        loading = true
                        scope.launch {
                            val api = NexusApi(store.baseUrl) { null /* no token yet */ }
                            runCatching {
                                val resp = api.pairClaim(
                                    PairClaimRequest(
                                        code = code.trim(),
                                        name = "Android · ${Build.MODEL}",
                                        platform = "android",
                                        fcmToken = null,
                                    ),
                                )
                                store.store(resp.apiKey, resp.userId, resp.deviceId)
                                onPaired()
                            }.onFailure { e ->
                                error = e.message ?: "Pairing failed"
                            }
                            loading = false
                        }
                    },
                    enabled = code.length >= 4 && !loading,
                ) {
                    if (loading) CircularProgressIndicator(modifier = Modifier.height(16.dp))
                    else Text("Pair")
                }
                OutlinedButton(
                    onClick = { showQrScanner = true },
                    enabled = !loading
                ) {
                    Text("Scan QR")
                }
            }
            error?.let {
                Spacer(Modifier.height(12.dp))
                Text(it, color = androidx.compose.material3.MaterialTheme.colorScheme.error)
            }
        }
    }

    // Re-emit on first composition so paired devices skip this screen the
    // moment SessionStore is bootstrapped from disk.
    LaunchedEffect(Unit) {
        if (!store.apiKey.isNullOrBlank()) onPaired()
    }
}
