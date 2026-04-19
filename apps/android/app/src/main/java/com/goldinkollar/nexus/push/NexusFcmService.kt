package com.goldinkollar.nexus.push

import android.app.PendingIntent
import android.content.Intent
import androidx.core.app.NotificationCompat
import androidx.core.app.NotificationManagerCompat
import com.goldinkollar.nexus.MainActivity
import com.goldinkollar.nexus.NexusApplication
import com.goldinkollar.nexus.data.NexusApi
import com.goldinkollar.nexus.data.SessionStore
import com.google.firebase.messaging.FirebaseMessagingService
import com.google.firebase.messaging.RemoteMessage
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch

/**
 * FCM message handler.
 *
 * - on new device token → PUT /api/devices/me/fcm-token
 * - on data message ("type":"approval.created") → show notification
 *
 * Notifications without a `data` payload are ignored (we expect server
 * to send `data` messages so we have full control over how/when to
 * notify; otherwise FCM auto-displays which we don't want).
 */
class NexusFcmService : FirebaseMessagingService() {

    private val scope = CoroutineScope(Dispatchers.IO)

    override fun onNewToken(token: String) {
        super.onNewToken(token)
        val store = SessionStore.shared(applicationContext)
        if (store.apiKey.isNullOrBlank()) return
        val api = NexusApi(store.baseUrl) { store.apiKey }
        scope.launch { runCatching { api.updateFcmToken(token) } }
    }

    override fun onMessageReceived(message: RemoteMessage) {
        super.onMessageReceived(message)
        val type = message.data["type"] ?: return
        when (type) {
            "approval.created" -> showApprovalNotice(
                title = message.data["title"] ?: "New proposal",
                body = message.data["body"] ?: "Open Nexus to review.",
            )
        }
    }

    private fun showApprovalNotice(title: String, body: String) {
        val intent = Intent(this, MainActivity::class.java).apply {
            flags = Intent.FLAG_ACTIVITY_SINGLE_TOP
        }
        val pi = PendingIntent.getActivity(
            this, 0, intent,
            PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT,
        )
        val notification = NotificationCompat.Builder(this, NexusApplication.CHANNEL_APPROVALS)
            .setSmallIcon(android.R.drawable.ic_dialog_email)
            .setContentTitle(title)
            .setContentText(body)
            .setAutoCancel(true)
            .setContentIntent(pi)
            .build()
        NotificationManagerCompat.from(this).notify(approvalsNotifId(), notification)
    }

    private fun approvalsNotifId(): Int =
        (System.currentTimeMillis() % Int.MAX_VALUE).toInt()
}
