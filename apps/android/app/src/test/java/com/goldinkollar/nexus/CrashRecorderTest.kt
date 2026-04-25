package com.goldinkollar.nexus

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder

class CrashRecorderTest {

    @get:Rule
    val tempFolder = TemporaryFolder()

    @Test
    fun `record persists throwable to disk and consume reads it back`() {
        val dir = tempFolder.newFolder("files")
        val ex = IllegalStateException("boom: db failed")

        val ok = CrashRecorder.record(dir, "Application.onCreate", ex)
        assertTrue("record should succeed on a writable dir", ok)

        val text = CrashRecorder.consume(dir)
        assertNotNull(text)
        assertTrue(text!!.contains("where: Application.onCreate"))
        assertTrue(text.contains("type: java.lang.IllegalStateException"))
        assertTrue(text.contains("message: boom: db failed"))
        assertTrue(text.contains("at com.goldinkollar.nexus.CrashRecorderTest"))
    }

    @Test
    fun `consume deletes the crash file after reading`() {
        val dir = tempFolder.newFolder("files")
        CrashRecorder.record(dir, "x", RuntimeException("x"))

        // First consume returns content
        assertNotNull(CrashRecorder.consume(dir))
        // Second consume returns null because file is gone
        assertNull(CrashRecorder.consume(dir))
    }

    @Test
    fun `peek does not delete`() {
        val dir = tempFolder.newFolder("files")
        CrashRecorder.record(dir, "x", RuntimeException("x"))

        assertNotNull(CrashRecorder.peek(dir))
        assertNotNull(CrashRecorder.peek(dir))
        // Now consume; subsequent peek is null
        assertNotNull(CrashRecorder.consume(dir))
        assertNull(CrashRecorder.peek(dir))
    }

    @Test
    fun `consume returns null when no crash recorded`() {
        val dir = tempFolder.newFolder("files")
        assertNull(CrashRecorder.consume(dir))
    }

    @Test
    fun `record truncates oversize payloads`() {
        val dir = tempFolder.newFolder("files")
        val giantMessage = "a".repeat(200_000)
        val ex = RuntimeException(giantMessage)

        CrashRecorder.record(dir, "x", ex)
        val text = CrashRecorder.consume(dir)!!
        // 64 KB cap defined in the recorder; the file size must be <= that.
        assertTrue("payload should be capped", text.length <= 64 * 1024)
    }

    @Test
    fun `record on unwritable dir returns false instead of throwing`() {
        val nonExistent = java.io.File(tempFolder.root, "does/not/exist/yet")
        // Don't mkdir it. record() should swallow the IOException.
        val ok = CrashRecorder.record(nonExistent, "x", RuntimeException("x"))
        assertFalse(ok)
    }

    @Test
    fun `record-then-consume roundtrip preserves where tag`() {
        val dir = tempFolder.newFolder("files")
        CrashRecorder.record(dir, "MainActivity.onCreate.setContent", IllegalArgumentException("bad"))
        val text = CrashRecorder.consume(dir)!!
        assertEquals(true, text.contains("where: MainActivity.onCreate.setContent"))
        assertEquals(true, text.contains("message: bad"))
    }
}
