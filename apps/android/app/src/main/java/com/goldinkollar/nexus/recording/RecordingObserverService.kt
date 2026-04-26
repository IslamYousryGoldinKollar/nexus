package com.goldinkollar.nexus.recording

import android.app.Notification
import android.app.Service
import android.content.Intent
import android.net.Uri
import android.os.IBinder
import android.provider.DocumentsContract
import android.util.Log
import androidx.core.app.NotificationCompat
import androidx.work.Data
import androidx.work.OneTimeWorkRequestBuilder
import androidx.work.WorkManager
import com.goldinkollar.nexus.NexusApplication
import com.goldinkollar.nexus.data.SessionStore
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.delay
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch

/**
 * Phase 8 — Wave A' (revised) folder watcher built on Storage Access
 * Framework (SAF). The user picks a tree URI once via OpenDocumentTree
 * (see [com.goldinkollar.nexus.ui.RecordingControl]), the URI is
 * persisted in [SessionStore.recordingFolderUri], and this service
 * polls the folder every [POLL_INTERVAL_MS] for new files.
 *
 * Why SAF instead of FileObserver-on-a-path:
 *   - Android 11+ blocks raw filesystem reads outside the app's
 *     scoped storage. FileObserver only works for app-owned dirs OR
 *     dirs the user explicitly granted via SAF. For a user-installed
 *     recorder app (Cube ACR, etc.), SAF is the only legal path.
 *   - SAF doesn't expose inotify-equivalent push events; polling is
 *     the recommended pattern. 30s cadence is fast enough that a call
 *     ending → upload starting feels instant, and slow enough that the
 *     foreground service uses negligible battery.
 *
 * For each new document URI we haven't seen before, we enqueue an
 * [UploadRecordingWorker] with the URI string. The worker reads via
 * ContentResolver and uploads to /api/ingest/phone. After a
 * successful upload the URI is marked as seen in
 * [SessionStore.markRecordingSeen] so we don't re-upload on the next
 * tick or after a service restart.
 */
class RecordingObserverService : Service() {

    private val supervisor = SupervisorJob()
    private val scope = CoroutineScope(Dispatchers.IO + supervisor)
    private var pollJob: Job? = null

    override fun onCreate() {
        super.onCreate()
        startForeground(FOREGROUND_NOTIFICATION_ID, buildForegroundNotification())
        pollJob = scope.launch { pollLoop() }
    }

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int = START_STICKY

    override fun onDestroy() {
        pollJob?.cancel()
        scope.cancel()
        super.onDestroy()
    }

    private suspend fun pollLoop() {
        while (scope.isActive) {
            try {
                pollOnce()
            } catch (t: Throwable) {
                Log.w(TAG, "poll iteration failed", t)
            }
            delay(POLL_INTERVAL_MS)
        }
    }

    /**
     * One iteration: enumerate all audio/video children of the picked
     * tree URI and enqueue uploads for any URI not in the seen-set.
     * We never throw out of here — partial failure is logged and the
     * next tick gets another shot.
     */
    private fun pollOnce() {
        val store = SessionStore.shared(applicationContext)
        val treeUriStr = store.recordingFolderUri ?: run {
            Log.d(TAG, "no folder picked — skipping poll")
            return
        }
        val treeUri = Uri.parse(treeUriStr)
        val rootDocId = DocumentsContract.getTreeDocumentId(treeUri)
        val seen = store.seenRecordingDocumentIds()

        val newUris = enumerateNewAudioFiles(treeUri, rootDocId, seen)
        if (newUris.isEmpty()) return

        Log.i(TAG, "found ${newUris.size} new recordings; enqueueing")
        for (uri in newUris) {
            val request = OneTimeWorkRequestBuilder<UploadRecordingWorker>()
                .setInputData(
                    Data.Builder()
                        .putString(UploadRecordingWorker.KEY_DOC_URI, uri.toString())
                        .putString(UploadRecordingWorker.KEY_TREE_URI, treeUriStr)
                        .build(),
                )
                .build()
            WorkManager.getInstance(applicationContext).enqueue(request)
        }
    }

    /**
     * Recursively walk the tree and return URIs of audio/video files
     * not yet in [seen]. Tiny files (<1 KB) are ignored — recorder
     * apps sometimes create empty placeholders before the actual
     * write completes; we'll catch them on the next tick.
     *
     * Recursion depth is bounded by [MAX_DEPTH] to defend against a
     * malicious tree that loops via symbolic structure.
     */
    private fun enumerateNewAudioFiles(
        treeUri: Uri,
        rootDocId: String,
        seen: Set<String>,
    ): List<Uri> {
        val resolver = contentResolver
        val pending = ArrayDeque<Pair<String, Int>>().apply { add(rootDocId to 0) }
        val out = mutableListOf<Uri>()

        while (pending.isNotEmpty()) {
            val (parentId, depth) = pending.removeFirst()
            if (depth > MAX_DEPTH) continue

            val childrenUri = DocumentsContract.buildChildDocumentsUriUsingTree(treeUri, parentId)
            val cursor = try {
                resolver.query(
                    childrenUri,
                    arrayOf(
                        DocumentsContract.Document.COLUMN_DOCUMENT_ID,
                        DocumentsContract.Document.COLUMN_MIME_TYPE,
                        DocumentsContract.Document.COLUMN_SIZE,
                        DocumentsContract.Document.COLUMN_DISPLAY_NAME,
                    ),
                    null, null, null,
                )
            } catch (t: Throwable) {
                Log.w(TAG, "query failed for $parentId", t)
                null
            } ?: continue

            cursor.use { c ->
                while (c.moveToNext()) {
                    val docId = c.getString(0) ?: continue
                    val mime = c.getString(1) ?: continue
                    val size = if (c.isNull(2)) 0L else c.getLong(2)
                    val name = c.getString(3) ?: ""

                    if (mime == DocumentsContract.Document.MIME_TYPE_DIR) {
                        pending.add(docId to (depth + 1))
                        continue
                    }
                    if (!isAudioOrVideo(mime, name)) continue
                    if (size < MIN_BYTES) continue
                    if (docId in seen) continue

                    val docUri = DocumentsContract.buildDocumentUriUsingTree(treeUri, docId)
                    out.add(docUri)
                }
            }
        }

        return out
    }

    private fun isAudioOrVideo(mime: String, name: String): Boolean {
        if (mime.startsWith("audio/") || mime.startsWith("video/")) return true
        // Some recorders return application/octet-stream — fall back to extension.
        val ext = name.substringAfterLast('.', "").lowercase()
        return ext in AUDIO_EXTENSIONS
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
        private const val TAG = "RecObs"
        private const val FOREGROUND_NOTIFICATION_ID = 9001
        private const val POLL_INTERVAL_MS = 30_000L
        private const val MIN_BYTES = 1024L
        private const val MAX_DEPTH = 4
        private val AUDIO_EXTENSIONS = setOf(
            "m4a", "mp4", "mp3", "wav", "ogg", "amr", "aac", "opus", "3gp", "flac",
        )
    }
}
