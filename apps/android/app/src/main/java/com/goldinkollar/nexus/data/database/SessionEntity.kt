package com.goldinkollar.nexus.data.database

import androidx.room.Entity
import androidx.room.PrimaryKey

@Entity(tableName = "sessions")
data class SessionEntity(
    @PrimaryKey
    val sessionId: String,
    val contactName: String?,
    val state: String,
    val openedAt: String,
    val lastActivityAt: String,
    val syncedAt: String?,
    val updatedAt: String,
)
