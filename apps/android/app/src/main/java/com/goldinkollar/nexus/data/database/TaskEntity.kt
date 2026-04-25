package com.goldinkollar.nexus.data.database

import androidx.room.Entity
import androidx.room.ForeignKey
import androidx.room.PrimaryKey

@Entity(
    tableName = "tasks",
    foreignKeys = [
        ForeignKey(
            entity = SessionEntity::class,
            parentColumns = ["sessionId"],
            childColumns = ["sessionId"],
            onDelete = ForeignKey.CASCADE
        )
    ]
)
data class TaskEntity(
    @PrimaryKey
    val id: String,
    val sessionId: String,
    val title: String,
    val description: String,
    val priorityGuess: String?,
    val state: String,
    val dueDateGuess: String?,
    val assigneeGuess: String?,
    val createdAt: String,
    val updatedAt: String,
)
