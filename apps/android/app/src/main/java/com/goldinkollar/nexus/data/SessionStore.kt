package com.goldinkollar.nexus.data

import android.content.Context
import android.content.SharedPreferences
import android.util.Log
import androidx.security.crypto.EncryptedSharedPreferences
import androidx.security.crypto.MasterKey
import kotlinx.coroutines.channels.awaitClose
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.callbackFlow

/**
 * Key/value store for the device API key + paired user id.
 *
 * Tries `EncryptedSharedPreferences` first (AES-256 with a keystore
 * master key) and falls back to plain `SharedPreferences` if encryption
 * fails to initialize. This fallback exists because
 * `androidx.security:security-crypto:1.1.0-alpha06` is known to throw
 * `KeyStoreException` / `InvalidProtocolBufferException` on certain
 * Android 14+ devices and Samsung One UI builds — the v1 Tink-based
 * implementation is fragile.
 *
 * Trade-off: when fallback fires, the API key is stored unencrypted in
 * the app's private prefs file. That file is still process-private
 * (sandboxed by the Android per-app filesystem isolation), so the only
 * realistic exposure is a rooted device. Acceptable for v1; revisit if
 * we move to consumer scale.
 *
 * `apiKeyFlow` emits on writes so MainActivity flips screens
 * immediately after a successful pair-claim.
 */
class SessionStore private constructor(context: Context) {

    private val appContext = context.applicationContext

    private val prefs: SharedPreferences by lazy {
        try {
            EncryptedSharedPreferences.create(
                appContext,
                ENCRYPTED_PREFS_NAME,
                MasterKey.Builder(appContext)
                    .setKeyScheme(MasterKey.KeyScheme.AES256_GCM)
                    .build(),
                EncryptedSharedPreferences.PrefKeyEncryptionScheme.AES256_SIV,
                EncryptedSharedPreferences.PrefValueEncryptionScheme.AES256_GCM,
            )
        } catch (t: Throwable) {
            Log.w(
                "SessionStore",
                "EncryptedSharedPreferences failed; falling back to plain prefs",
                t,
            )
            appContext.getSharedPreferences(FALLBACK_PREFS_NAME, Context.MODE_PRIVATE)
        }
    }

    val apiKey: String?
        get() = prefs.getString(KEY_API, null)

    val userId: String?
        get() = prefs.getString(KEY_USER_ID, null)

    val deviceId: String?
        get() = prefs.getString(KEY_DEVICE_ID, null)

    val baseUrl: String
        get() = prefs.getString(KEY_BASE_URL, DEFAULT_BASE_URL) ?: DEFAULT_BASE_URL

    /**
     * Tree URI of the folder the user picked via SAF (Storage Access
     * Framework). The recording observer service watches this folder
     * for new audio files and uploads them. Null = no folder picked
     * yet → the service refuses to start.
     */
    val recordingFolderUri: String?
        get() = prefs.getString(KEY_RECORDING_FOLDER_URI, null)

    fun setRecordingFolderUri(uri: String?) {
        prefs.edit()
            .apply {
                if (uri == null) remove(KEY_RECORDING_FOLDER_URI)
                else putString(KEY_RECORDING_FOLDER_URI, uri)
            }
            .apply()
    }

    /**
     * Set of `documentId` strings we've already uploaded. Used by the
     * polling observer to skip files that already shipped — without
     * this we'd re-upload the entire folder on every service restart.
     */
    fun seenRecordingDocumentIds(): Set<String> =
        prefs.getStringSet(KEY_SEEN_RECORDING_IDS, emptySet()) ?: emptySet()

    fun markRecordingSeen(documentId: String) {
        val current = seenRecordingDocumentIds().toMutableSet()
        if (current.add(documentId)) {
            prefs.edit().putStringSet(KEY_SEEN_RECORDING_IDS, current).apply()
        }
    }

    /**
     * Set of E.164-normalised phone numbers whose call recordings the
     * user has explicitly opted in to upload. The recording filename
     * usually carries the counterparty number (e.g.
     * `+201234567890_2026-04-28.m4a`), and UploadRecordingWorker
     * checks this set before sending bytes to Nexus. An empty set
     * means "default-deny — upload nothing" so a fresh install can't
     * silently leak personal calls before the user has reviewed
     * their contacts.
     */
    fun optedInRecordingPhones(): Set<String> =
        prefs.getStringSet(KEY_OPTED_IN_PHONES, emptySet()) ?: emptySet()

    fun setOptedInRecordingPhones(phones: Set<String>) {
        prefs.edit().putStringSet(KEY_OPTED_IN_PHONES, phones).apply()
    }

    fun togglePhoneOptIn(phoneE164: String, optedIn: Boolean): Set<String> {
        val current = optedInRecordingPhones().toMutableSet()
        if (optedIn) current.add(phoneE164) else current.remove(phoneE164)
        prefs.edit().putStringSet(KEY_OPTED_IN_PHONES, current).apply()
        return current
    }

    /**
     * Master switch for the contact-policy filter. When OFF, the
     * upload worker bypasses the allowlist entirely and uploads
     * every recording — useful for the first run when the user
     * hasn't curated their contacts yet. Default is ON (default-deny).
     */
    val recordingFilterEnabled: Boolean
        get() = prefs.getBoolean(KEY_RECORDING_FILTER_ENABLED, true)

    fun setRecordingFilterEnabled(enabled: Boolean) {
        prefs.edit().putBoolean(KEY_RECORDING_FILTER_ENABLED, enabled).apply()
    }

    fun store(apiKey: String, userId: String, deviceId: String) {
        prefs.edit()
            .putString(KEY_API, apiKey)
            .putString(KEY_USER_ID, userId)
            .putString(KEY_DEVICE_ID, deviceId)
            .apply()
    }

    fun setBaseUrl(url: String) {
        prefs.edit().putString(KEY_BASE_URL, url).apply()
    }

    fun clear() {
        prefs.edit().clear().apply()
    }

    /** Flow that emits on every write — handy for top-level navigation gating. */
    val apiKeyFlow: Flow<String?> = callbackFlow {
        trySend(apiKey)
        val listener = android.content.SharedPreferences.OnSharedPreferenceChangeListener { _, key ->
            if (key == KEY_API) trySend(apiKey)
        }
        prefs.registerOnSharedPreferenceChangeListener(listener)
        awaitClose { prefs.unregisterOnSharedPreferenceChangeListener(listener) }
    }

    companion object {
        private const val KEY_API = "device_api_key"
        private const val KEY_USER_ID = "user_id"
        private const val KEY_DEVICE_ID = "device_id"
        private const val KEY_BASE_URL = "base_url"
        private const val KEY_RECORDING_FOLDER_URI = "recording_folder_uri"
        private const val KEY_SEEN_RECORDING_IDS = "seen_recording_ids"
        private const val KEY_OPTED_IN_PHONES = "opted_in_recording_phones"
        private const val KEY_RECORDING_FILTER_ENABLED = "recording_filter_enabled"
        // Vercel canonical alias. nexus.theoffsight.com isn't in DNS yet;
        // switch to it once the CNAME is added at the registrar.
        private const val DEFAULT_BASE_URL = "https://nexus-beta-coral.vercel.app"
        private const val ENCRYPTED_PREFS_NAME = "nexus.session"
        private const val FALLBACK_PREFS_NAME = "nexus.session.fallback"

        @Volatile private var instance: SessionStore? = null

        fun shared(context: Context): SessionStore =
            instance ?: synchronized(this) {
                instance ?: SessionStore(context).also { instance = it }
            }
    }
}
