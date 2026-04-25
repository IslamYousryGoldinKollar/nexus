package com.goldinkollar.nexus

import android.app.Application
import android.app.NotificationChannel
import android.app.NotificationManager
import android.os.Build
import androidx.work.Configuration

class NexusApplication : Application(), Configuration.Provider {

    override fun onCreate() {
        super.onCreate()
        SentryInitializer.initialize(this)
        ensureNotificationChannels()
    }

    private fun ensureNotificationChannels() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return
        val nm = getSystemService(NotificationManager::class.java) ?: return
        nm.createNotificationChannel(
            NotificationChannel(
                CHANNEL_APPROVALS,
                "Approvals",
                NotificationManager.IMPORTANCE_HIGH,
            ).apply {
                description = "New tasks Nexus is asking you to approve."
            },
        )
        nm.createNotificationChannel(
            NotificationChannel(
                CHANNEL_RECORDING,
                "Background recording",
                NotificationManager.IMPORTANCE_LOW,
            ).apply {
                description = "Persistent notice while watching the call-recording folder."
            },
        )
    }

    // WorkManager configuration — keep logging quiet in release.
    override val workManagerConfiguration: Configuration =
        Configuration.Builder()
            .setMinimumLoggingLevel(if (BuildConfig.DEBUG) android.util.Log.DEBUG else android.util.Log.INFO)
            .build()

    companion object {
        const val CHANNEL_APPROVALS = "approvals"
        const val CHANNEL_RECORDING = "recording"
    }
}
