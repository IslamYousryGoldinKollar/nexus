package com.goldinkollar.nexus.recording

import android.content.Context
import android.media.MediaMetadataRetriever
import android.net.Uri
import android.provider.DocumentsContract
import android.util.Log
import androidx.work.CoroutineWorker
import androidx.work.WorkerParameters
import com.goldinkollar.nexus.data.ContactsRepository
import com.goldinkollar.nexus.data.SessionStore
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.MediaType.Companion.toMediaTypeOrNull
import okhttp3.MultipartBody
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import java.io.File
import java.io.InputStream
import java.util.concurrent.TimeUnit

/**
 * WorkManager job that uploads one recording to /api/ingest/phone.
 *
 * Two input modes:
 *   - KEY_DOC_URI: SAF-picked file (preferred path, used by the
 *     polling observer). Bytes via ContentResolver, metadata via
 *     DocumentsContract.
 *   - KEY_FILE_PATH: legacy raw filesystem path.
 *
 * Multipart is built with OkHttp directly — Ktor's
 * MultiPartFormDataContent emitted a malformed Content-Disposition
 * that Vercel's WHATWG-fetch FormData parser rejected (diagnostic in
 * commit 4ce36db). OkHttp's MultipartBody is bulletproof and already
 * in the dependency graph via ktor-client-okhttp.
 *
 * Privacy gate: shouldUpload(filename) checks the recording filename
 * against the user's opt-in lists (display name OR phone number)
 * BEFORE bytes leave the device. Default-deny: a fresh install with
 * no opted-in contacts uploads nothing.
 *
 * Backoff: WorkManager handles exponential retry on Result.retry().
 * The server returns 200 even on validation failures (with
 * `{ ignored: ... }` in the body); the worker parses that and
 * returns retry rather than marking the file as seen — that way a
 * server-side fix automatically picks up files that previously
 * failed.
 */
class UploadRecordingWorker(
    appContext: Context,
    params: WorkerParameters,
) : CoroutineWorker(appContext, params) {

    override suspend fun doWork(): Result {
        val store = SessionStore.shared(applicationContext)
        val apiKey = store.apiKey ?: return Result.retry()

        val docUriStr = inputData.getString(KEY_DOC_URI)
        return if (docUriStr != null) {
            uploadFromContentUri(store, apiKey, Uri.parse(docUriStr))
        } else {
            val path = inputData.getString(KEY_FILE_PATH) ?: return Result.failure()
            uploadFromFile(store, apiKey, File(path))
        }
    }

    /**
     * Privacy gate. Returns true when the recording's counterparty is
     * one the user has explicitly opted in to upload. Two recognition
     * paths: contact display name (Android-14+ native recorder writes
     * "<Name>_YYMMDD_HHMMSS.m4a") and phone number (third-party
     * recorders + unknown callers).
     */
    private fun shouldUpload(store: SessionStore, filename: String): Boolean {
        if (!store.recordingFilterEnabled) return true

        val optedNames = store.optedInRecordingNames()
        if (optedNames.isNotEmpty()) {
            val haystack = filename
                .substringBeforeLast('.')
                .replace(Regex("[_\\-]+"), " ")
                .lowercase()
                .replace(Regex("\\s+"), " ")
                .trim()
            for (name in optedNames) {
                if (name.isNotEmpty() && haystack.contains(name)) {
                    Log.i(TAG, "name-match: '$name' in '$filename'")
                    return true
                }
            }
        }

        val phone = extractPhone(filename)
        if (phone != null && phone in store.optedInRecordingPhones()) {
            Log.i(TAG, "phone-match: $phone in '$filename'")
            return true
        }

        Log.i(TAG, "skipping (no opted-in name or phone): $filename")
        return false
    }

    private fun extractPhone(filename: String): String? {
        val plus = Regex("\\+\\d{8,15}").find(filename)?.value
        if (plus != null) return plus
        val bare = Regex("\\b\\d{8,15}\\b").find(filename)?.value ?: return null
        return ContactsRepository.normalizeE164(bare)
    }

    /**
     * Heuristically classify a recording as inbound/outbound by looking
     * for keyword markers many recorder apps embed in the filename.
     * Returns "inbound" or "outbound" when confident, else null —
     * the server schema treats null/missing as "internal" (the DB
     * direction enum's catch-all value).
     */
    private fun extractDirection(filename: String): String? {
        val lower = filename.lowercase()
        // Prioritise unambiguous markers.
        if (Regex("\\b(in|incoming|received|recv)\\b").containsMatchIn(lower)) return "inbound"
        if (Regex("\\b(out|outgoing|outbound|sent)\\b").containsMatchIn(lower)) return "outbound"
        return null
    }

    /**
     * Best-effort audio duration in seconds via MediaMetadataRetriever.
     * Returns 0 on any failure — the server defaults to 0 and the
     * reasoner doesn't depend on this field.
     */
    private fun extractDurationSec(uriOrPath: Any): Int {
        return try {
            val r = MediaMetadataRetriever()
            when (uriOrPath) {
                is Uri -> r.setDataSource(applicationContext, uriOrPath)
                is File -> r.setDataSource(uriOrPath.absolutePath)
            }
            val ms = r.extractMetadata(MediaMetadataRetriever.METADATA_KEY_DURATION)?.toLongOrNull() ?: 0L
            r.release()
            (ms / 1000).toInt().coerceAtLeast(0)
        } catch (_: Throwable) {
            0
        }
    }

    private suspend fun uploadFromContentUri(
        store: SessionStore,
        apiKey: String,
        docUri: Uri,
    ): Result {
        val resolver = applicationContext.contentResolver
        val meta = queryDocumentMeta(docUri) ?: run {
            Log.w(TAG, "could not read doc meta for $docUri")
            return Result.failure()
        }
        if (meta.size < 1024L) return Result.failure()

        if (!shouldUpload(store, meta.displayName)) {
            store.markRecordingSeen(meta.documentId)
            return Result.success()
        }

        val bytes = try {
            resolver.openInputStream(docUri)?.use(InputStream::readBytes)
        } catch (t: Throwable) {
            Log.w(TAG, "openInputStream failed for $docUri", t)
            null
        } ?: return Result.retry()

        val durationSec = extractDurationSec(docUri)

        return doUpload(
            store = store,
            apiKey = apiKey,
            audioBytes = bytes,
            filename = meta.displayName,
            mime = meta.mimeType,
            occurredEpochMs = meta.lastModified,
            durationSec = durationSec,
            onSuccess = { store.markRecordingSeen(meta.documentId) },
        )
    }

    private suspend fun uploadFromFile(
        store: SessionStore,
        apiKey: String,
        file: File,
    ): Result {
        if (!file.exists() || file.length() == 0L) return Result.failure()
        if (!shouldUpload(store, file.name)) return Result.success()
        val durationSec = extractDurationSec(file)
        return doUpload(
            store = store,
            apiKey = apiKey,
            audioBytes = file.readBytes(),
            filename = file.name,
            mime = file.guessMime(),
            occurredEpochMs = file.lastModified(),
            durationSec = durationSec,
            onSuccess = { /* legacy path — no idempotency tag */ },
        )
    }

    /**
     * Perform the actual HTTP upload using OkHttp's MultipartBody —
     * which produces a Content-Disposition like
     * `form-data; name="audio"; filename="..."` exactly as
     * Vercel's FormData parser expects.
     *
     * Field names match the server schema in
     * apps/web/lib/channels/phone/schema.ts:
     *   - `audio` (file part)
     *   - `meta` (JSON string with callId + startedAt + optional
     *     counterparty / direction / durationSec / recorder)
     */
    private fun doUpload(
        store: SessionStore,
        apiKey: String,
        audioBytes: ByteArray,
        filename: String,
        mime: String,
        occurredEpochMs: Long,
        durationSec: Int,
        onSuccess: () -> Unit,
    ): Result {
        val mediaType = mime.toMediaTypeOrNull() ?: "application/octet-stream".toMediaType()
        val body = MultipartBody.Builder()
            .setType(MultipartBody.FORM)
            .addFormDataPart(
                "audio",
                sanitizeFilename(filename),
                audioBytes.toRequestBody(mediaType),
            )
            .addFormDataPart("meta", buildMetadata(filename, occurredEpochMs, durationSec))
            .build()

        val url = store.baseUrl.trimEnd('/') + "/api/ingest/phone"
        val request = Request.Builder()
            .url(url)
            .header("Authorization", "Bearer $apiKey")
            .header("User-Agent", "nexus-android/0.3")
            .post(body)
            .build()

        return runCatching {
            uploadClient.newCall(request).execute().use { resp ->
                val code = resp.code
                val respBody = resp.body?.string() ?: ""
                when {
                    code in 200..299 -> {
                        // Server returns 200 even on validation failure,
                        // with `{ ignored: <reason> }` in the body.
                        // Don't mark as seen if the server ignored —
                        // let the next polling tick (or backoff retry)
                        // try again so a server-side fix automatically
                        // picks up the file.
                        val ignored = Regex("\"ignored\"\\s*:\\s*\"([^\"]+)\"")
                            .find(respBody)?.groupValues?.get(1)
                        if (ignored != null) {
                            Log.w(TAG, "server ignored upload ($ignored): $filename")
                            Result.retry()
                        } else {
                            Log.i(TAG, "uploaded: $filename (${audioBytes.size} bytes, ${durationSec}s)")
                            onSuccess()
                            Result.success()
                        }
                    }
                    code in 500..599 || code == 408 -> Result.retry()
                    else -> {
                        Log.w(TAG, "upload failed $code: $respBody")
                        Result.failure()
                    }
                }
            }
        }.getOrElse {
            Log.w(TAG, "upload exception (will retry): $filename", it)
            Result.retry()
        }
    }

    private data class DocMeta(
        val documentId: String,
        val displayName: String,
        val mimeType: String,
        val size: Long,
        val lastModified: Long,
    )

    private fun queryDocumentMeta(docUri: Uri): DocMeta? {
        val resolver = applicationContext.contentResolver
        val cursor = resolver.query(
            docUri,
            arrayOf(
                DocumentsContract.Document.COLUMN_DOCUMENT_ID,
                DocumentsContract.Document.COLUMN_DISPLAY_NAME,
                DocumentsContract.Document.COLUMN_MIME_TYPE,
                DocumentsContract.Document.COLUMN_SIZE,
                DocumentsContract.Document.COLUMN_LAST_MODIFIED,
            ),
            null, null, null,
        ) ?: return null
        return cursor.use { c ->
            if (!c.moveToFirst()) return null
            val name = c.getString(1) ?: return null
            DocMeta(
                documentId = c.getString(0) ?: return null,
                displayName = name,
                mimeType = mimeFromString(c.getString(2), name),
                size = if (c.isNull(3)) 0L else c.getLong(3),
                lastModified = if (c.isNull(4)) System.currentTimeMillis() else c.getLong(4),
            )
        }
    }

    private fun mimeFromString(declared: String?, filename: String): String {
        if (declared != null && declared != "application/octet-stream") return declared
        return extensionMime(filename)
    }

    private fun extensionMime(filename: String): String =
        when (filename.substringAfterLast('.', "").lowercase()) {
            "m4a", "mp4" -> "audio/mp4"
            "mp3" -> "audio/mpeg"
            "wav" -> "audio/wav"
            "ogg", "opus" -> "audio/ogg"
            "amr" -> "audio/amr"
            "aac" -> "audio/aac"
            "3gp" -> "audio/3gpp"
            "flac" -> "audio/flac"
            else -> "application/octet-stream"
        }

    private fun File.guessMime(): String = extensionMime(name)

    /**
     * Strip characters that break a `filename="..."` parameter:
     * literal double-quotes, CR/LF, backslash, and non-ASCII (the
     * Android native recorder includes 🥰 emoji in filenames).
     * The original filename is preserved in the metadata JSON.
     */
    private fun sanitizeFilename(name: String): String =
        name
            .replace(Regex("[\\r\\n\"\\\\]"), "")
            .replace(Regex("[^\\x20-\\x7E]"), "_")
            .ifEmpty { "recording" }

    /**
     * Construct the JSON value of the `meta` form field. Aligned with
     * apps/web/lib/channels/phone/schema.ts:phoneUploadMetaSchema —
     * `callId` and `startedAt` are required, the rest are optional and
     * the server defaults them when null.
     */
    private fun buildMetadata(filename: String, occurredMs: Long, durationSec: Int): String {
        val counterparty = extractPhone(filename)
        val direction = extractDirection(filename)
        val callId = java.util.UUID.nameUUIDFromBytes(
            filename.toByteArray(Charsets.UTF_8),
        ).toString()
        val startedAtIso = java.time.Instant.ofEpochMilli(occurredMs).toString()

        return buildString {
            append('{')
            append("\"callId\":\"").append(callId).append('"')
            append(",\"startedAt\":\"").append(startedAtIso).append('"')
            append(",\"durationSec\":").append(durationSec)
            if (counterparty != null) {
                append(",\"counterparty\":\"").append(counterparty).append('"')
            }
            if (direction != null) {
                append(",\"direction\":\"").append(direction).append('"')
            }
            append(",\"recorder\":\"saf-picker\"")
            append('}')
        }
    }

    companion object {
        private const val TAG = "RecUpload"
        const val KEY_FILE_PATH = "file_path"
        const val KEY_DOC_URI = "doc_uri"
        const val KEY_TREE_URI = "tree_uri"

        /**
         * One client per process. OkHttp keeps a connection pool so
         * subsequent uploads reuse the same TLS session — saving
         * ~200ms per call. Long timeouts because the audio body is
         * uploaded in one POST.
         */
        private val uploadClient = OkHttpClient.Builder()
            .connectTimeout(15, TimeUnit.SECONDS)
            .readTimeout(180, TimeUnit.SECONDS)
            .writeTimeout(180, TimeUnit.SECONDS)
            .build()
    }
}
