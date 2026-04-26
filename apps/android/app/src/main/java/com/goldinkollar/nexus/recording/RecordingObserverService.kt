package com.goldinkollar.nexus.recording

import android.app.Notification
import android.app.Service
import android.content.Intent
import android.os.Environment
import android.os.FileObserver
import android.os.IBinder
import androidx.core.app.NotificationCompat
import androidx.work.Data
import androidx.work.OneTimeWorkRequestBuilder
import androidx.work.WorkManager
import com.goldinkollar.nexus.NexusApplication
import java.io.File

/**
 * Phase 8 — Wave A' folder watcher.
 *
 * Watches well-known third-party recorder output directories. When a new
 * audio file appears (CLOSE_WRITE event), we enqueue an
 * `UploadRecordingWorker` job to push it to /api/ingest/phone with
 * WorkManager retries.
 *
 * Note: `FileObserver` on a file path (not a content URI) requires
 * `READ_EXTERNAL_STORAGE` (or scoped storage equivalents). On API 30+
 * this only works for app-owned dirs OR dirs the user explicitly
 * granted via the Storage Access Framework. Real device deployment
 * needs a SAF-based picker (TBD).
 *
 * For Samsung S24 specifically, the user-installed Cube ACR writes to:
 *   /storage/emulated/0/Cube Call Recorder/all/
 * Add other recorder paths to `WATCHED_DIRS` as needed.
 */
class RecordingObserverService : Service() {

    private val observers = mutableListOf<FileObserver>()

    override fun onCreate() {
        super.onCreate()
        startForeground(FOREGROUND_NOTIFICATION_ID, buildForegroundNotification())
        WATCHED_DIRS.forEach { rel ->
            val dir = File(Environment.getExternalStorageDirectory(), rel)
            if (!dir.exists()) return@forEach
            val obs = makeObserver(dir)
            obs.startWatching()
            observers += obs
        }
    }

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int = START_STICKY

    override fun onDestroy() {
        observers.forEach { it.stopWatching() }
        observers.clear()
        super.onDestroy()
    }

    private fun makeObserver(dir: File): FileObserver {
        return object : FileObserver(dir, CLOSE_WRITE or MOVED_TO) {
            override fun onEvent(event: Int, path: String?) {
                if (path.isNullOrBlank()) return
                val file = File(dir, path)
                if (!file.isFile) return
                if (file.length() < 1024) return // ignore tiny artifacts
                val request = OneTimeWorkRequestBuilder<UploadRecordingWorker>()
                    .setInputData(
                        Data.Builder()
                            .putString(UploadRecordingWorker.KEY_FILE_PATH, file.absolutePath)
                            .build(),
                    )
                    .build()
                WorkManager.getInstance(applicationContext).enqueue(request)
            }
        }
    }

    private fun buildForegroundNotification(): Notification {
        return NotificationCompat.Builder(this, NexusApplication.CHANNEL_RECORDING)
            .setContentTitle("Nexus call recorder")
            .setContentText("Watching for new call recordings.")
            .setSmallIcon(android.R.drawable.stat_notify_sync)
            .setOngoing(true)
            .build()
    }

    companion object {
        private const val FOREGROUND_NOTIFICATION_ID = 9001

        // User-configurable in a future settings screen. Add your recorder app's path.
        // Cube ACR drops files in `Cube Call Recorder/all/CubeCallRecorder/` (one
        // level deeper than the SAF-picked root); we list both so the file
        // observer catches whichever the device uses.
        private val WATCHED_DIRS = listOf(
            "Cube Call Recorder/all",
            "Cube Call Recorder/all/CubeCallRecorder",
            "Cube Call Recorder",
            "Recordings/Call",
            "Recordings/Calls",
            "Recorder/Call",
            "Call recordings",
            "MIUI/sound_recorder/call_rec",
        )
    }
}
