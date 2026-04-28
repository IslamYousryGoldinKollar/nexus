package com.goldinkollar.nexus.data

import android.content.ContentResolver
import android.content.Context
import android.provider.ContactsContract

/**
 * Reads the user's address book via ContactsContract. Used by the
 * ContactPolicyScreen so the user can pick which contacts have their
 * call recordings uploaded.
 *
 * We never write to the address book and never persist the raw
 * contact list — only a Set<String> of opted-in E.164 numbers lives
 * in SessionStore.
 */
data class ContactEntry(
    val displayName: String,
    /** All phone numbers attached to this contact, normalized to E.164
     *  with a best-effort default region. The same contact may have
     *  several numbers (mobile, work, home, …). */
    val phoneNumbersE164: List<String>,
)

object ContactsRepository {

    /**
     * @param defaultRegion ISO 3166-1 alpha-2, e.g. "EG". Used when a
     * stored phone number lacks a `+CC` prefix.
     */
    fun loadContacts(context: Context, defaultRegion: String = "EG"): List<ContactEntry> {
        val resolver: ContentResolver = context.contentResolver
        val byContactId = mutableMapOf<String, MutableList<String>>()
        val nameByContactId = mutableMapOf<String, String>()

        // Single query that joins Contacts with Phone — cheaper than
        // two passes when the address book has thousands of entries.
        val cursor = resolver.query(
            ContactsContract.CommonDataKinds.Phone.CONTENT_URI,
            arrayOf(
                ContactsContract.CommonDataKinds.Phone.CONTACT_ID,
                ContactsContract.CommonDataKinds.Phone.DISPLAY_NAME,
                ContactsContract.CommonDataKinds.Phone.NUMBER,
            ),
            null,
            null,
            "${ContactsContract.CommonDataKinds.Phone.DISPLAY_NAME} ASC",
        ) ?: return emptyList()

        cursor.use { c ->
            val idCol = c.getColumnIndexOrThrow(ContactsContract.CommonDataKinds.Phone.CONTACT_ID)
            val nameCol = c.getColumnIndexOrThrow(ContactsContract.CommonDataKinds.Phone.DISPLAY_NAME)
            val numberCol = c.getColumnIndexOrThrow(ContactsContract.CommonDataKinds.Phone.NUMBER)
            while (c.moveToNext()) {
                val id = c.getString(idCol) ?: continue
                val name = c.getString(nameCol) ?: continue
                val rawNumber = c.getString(numberCol) ?: continue
                val e164 = normalizeE164(rawNumber, defaultRegion) ?: continue
                nameByContactId.putIfAbsent(id, name)
                byContactId.getOrPut(id) { mutableListOf() }.add(e164)
            }
        }

        return nameByContactId.entries
            .map { (id, name) ->
                ContactEntry(
                    displayName = name,
                    phoneNumbersE164 = byContactId[id]!!.distinct(),
                )
            }
            .sortedBy { it.displayName.lowercase() }
    }

    /**
     * Best-effort E.164 normalisation without pulling in libphonenumber
     * (would add 1.5 MB to the APK). Egypt-specific quirks live here:
     *
     *   - "01XXXXXXXXX" (11 digits, leading 0) → "+201XXXXXXXXX"
     *   - "1XXXXXXXXX"  (10 digits) → "+201XXXXXXXXX"
     *   - "+xxx…" left as-is
     *   - International "00" prefix → "+"
     *
     * Non-Egyptian numbers stored as +CC… work natively. If the user
     * lives outside Egypt later we'll swap this for libphonenumber.
     */
    fun normalizeE164(raw: String, defaultRegion: String = "EG"): String? {
        val digits = raw.filter { it.isDigit() || it == '+' }.trim()
        if (digits.isEmpty()) return null
        if (digits.startsWith("+")) {
            // Already international.
            return digits.takeIf { it.length in 8..16 }
        }
        if (digits.startsWith("00")) {
            return "+" + digits.substring(2).takeIf { it.length in 8..16 }!!
        }
        return when (defaultRegion) {
            "EG" -> when {
                digits.startsWith("0") && digits.length == 11 -> "+20${digits.drop(1)}"
                digits.length == 10 -> "+20$digits"
                else -> null
            }
            else -> null
        }
    }
}
