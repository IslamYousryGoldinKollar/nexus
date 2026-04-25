package com.goldinkollar.nexus.ui

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.material3.Button
import androidx.compose.material3.Card
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
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
import com.goldinkollar.nexus.data.ApprovalAction
import com.goldinkollar.nexus.data.NexusApi
import com.goldinkollar.nexus.data.SessionCard
import com.goldinkollar.nexus.data.SessionStore
import com.goldinkollar.nexus.data.TaskCard
import kotlinx.coroutines.launch

/**
 * Approvals queue — list of session cards, each with N proposed tasks.
 *
 * Polling: refresh on screen entry + on pull-to-refresh (manual button
 * for now; gesture support later). FCM data messages will trigger
 * a refresh too in a future iteration.
 */
@Composable
fun ApprovalsScreen() {
    val context = LocalContext.current
    val store = remember { SessionStore.shared(context) }
    val api = remember { NexusApi(store.baseUrl) { store.apiKey } }
    val scope = rememberCoroutineScope()

    var loading by remember { mutableStateOf(true) }
    var sessions by remember { mutableStateOf<List<SessionCard>>(emptyList()) }
    var error by remember { mutableStateOf<String?>(null) }

    suspend fun refresh() {
        loading = true
        error = null
        runCatching { api.getApprovals() }
            .onSuccess { sessions = it.items }
            .onFailure { error = it.message }
        loading = false
    }

    LaunchedEffect(Unit) { refresh() }

    Column(modifier = Modifier.fillMaxSize().padding(16.dp)) {
        Row(verticalAlignment = Alignment.CenterVertically) {
            Text("Approvals", style = MaterialTheme.typography.headlineSmall)
            Spacer(Modifier.width(8.dp))
            Text("· ${sessions.size}", color = MaterialTheme.colorScheme.outline)
            Spacer(Modifier.width(16.dp))
            OutlinedButton(onClick = { scope.launch { refresh() } }) { Text("Refresh") }
        }
        Spacer(Modifier.height(12.dp))

        RecordingControl()
        Spacer(Modifier.height(12.dp))

        if (loading) {
            CircularProgressIndicator()
        } else if (error != null) {
            Text(error!!, color = MaterialTheme.colorScheme.error)
        } else if (sessions.isEmpty()) {
            Text("Inbox zero ✨", color = MaterialTheme.colorScheme.outline)
        } else {
            LazyColumn(verticalArrangement = Arrangement.spacedBy(12.dp)) {
                items(sessions, key = { it.sessionId }) { s ->
                    SessionCardView(s) { task, action ->
                        scope.launch {
                            runCatching { api.act(task.id, action) }
                                .onSuccess { refresh() }
                                .onFailure { error = it.message }
                        }
                    }
                }
            }
        }
    }
}

@Composable
private fun SessionCardView(
    session: SessionCard,
    onAction: (TaskCard, ApprovalAction) -> Unit,
) {
    Card(modifier = Modifier.padding(vertical = 4.dp)) {
        Column(modifier = Modifier.padding(16.dp)) {
            Text(session.contactName ?: "(no contact)", style = MaterialTheme.typography.titleMedium)
            Spacer(Modifier.height(8.dp))
            session.tasks.forEach { t ->
                Text(t.title, style = MaterialTheme.typography.bodyLarge)
                Text(
                    t.description,
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.outline,
                )
                Spacer(Modifier.height(8.dp))
                Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    Button(onClick = { onAction(t, ApprovalAction.Approve) }) { Text("Approve") }
                    OutlinedButton(onClick = { onAction(t, ApprovalAction.Reject(null)) }) {
                        Text("Reject")
                    }
                }
                Spacer(Modifier.height(12.dp))
            }
        }
    }
}
