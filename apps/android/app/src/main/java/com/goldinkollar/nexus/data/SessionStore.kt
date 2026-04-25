package com.goldinkollar.nexus.data

import android.content.Context
import androidx.security.crypto.EncryptedSharedPreferences
import androidx.security.crypto.MasterKey
import kotlinx.coroutines.channels.awaitClose
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.callbackFlow

/**
 * Encrypted key/value store for the device API key + paired user id.
 *
 * Backed by androidx.security `EncryptedSharedPreferences` with a master
 * key in the Android keystore. AES-256-GCM-SIV under the hood.
 *
 * `apiKeyFlow` emits on writes so MainActivity flips screens immediately
 * after a successful pair-claim.
 */
class SessionStore private constructor(context: Context) {

    private val prefs by lazy {
        EncryptedSharedPreferences.create(
            context.applicationContext,
            "nexus.session",
            MasterKey.Builder(context.applicationContext)
                .setKeyScheme(MasterKey.KeyScheme.AES256_GCM)
                .build(),
            EncryptedSharedPreferences.PrefKeyEncryptionScheme.AES256_SIV,
            EncryptedSharedPreferences.PrefValueEncryptionScheme.AES256_GCM,
        )
    }

    val apiKey: String?
        get() = prefs.getString(KEY_API, null)

    val userId: String?
        get() = prefs.getString(KEY_USER_ID, null)

    val deviceId: String?
        get() = prefs.getString(KEY_DEVICE_ID, null)

    val baseUrl: String
        get() = prefs.getString(KEY_BASE_URL, DEFAULT_BASE_URL) ?: DEFAULT_BASE_URL

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
        // Vercel canonical alias. nexus.theoffsight.com isn't in DNS yet;
        // switch to it once the CNAME is added at the registrar.
        private const val DEFAULT_BASE_URL = "https://nexus-beta-coral.vercel.app"

        @Volatile private var instance: SessionStore? = null

        fun shared(context: Context): SessionStore =
            instance ?: synchronized(this) {
                instance ?: SessionStore(context).also { instance = it }
            }
    }
}
