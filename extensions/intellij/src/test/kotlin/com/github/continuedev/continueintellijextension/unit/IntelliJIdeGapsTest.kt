package com.github.continuedev.continueintellijextension.unit

import com.github.continuedev.continueintellijextension.`continue`.CommandArgs
import com.github.continuedev.continueintellijextension.`continue`.FileSearch
import junit.framework.TestCase

class IntelliJIdeGapsTest : TestCase() {
    fun `test quoted paths stay one argument`() {
        assertEquals(
            listOf("tool", "/tmp/my file", "tail"),
            CommandArgs.split("tool \"/tmp/my file\" tail"),
        )
        assertEquals(listOf("echo", "hello world"), CommandArgs.split("echo 'hello world'"))
        assertEquals(listOf("echo", "hello world"), CommandArgs.split("echo hello\\ world"))
    }

    fun `test empty command has no arguments`() {
        assertTrue(CommandArgs.split("   ").isEmpty())
    }

    fun `test file search args do not use max-count`() {
        val args = FileSearch.fileArgs("rg", "*.kt", "*.env")
        assertFalse(args.contains("--max-count"))
        assertTrue(args.contains("--files"))
        assertTrue(args.contains("*.kt"))
    }

    fun `test file search results are capped`() {
        val lines = FileSearch.lines("a.kt\nb.kt\n\nc.kt\n")
        assertEquals(listOf("a.kt", "b.kt", "c.kt"), lines)
        assertEquals(listOf("a.kt", "b.kt"), FileSearch.cap(lines, 2))
        assertEquals(emptyList<String>(), FileSearch.cap(lines, 0))
        assertEquals(lines, FileSearch.cap(lines, null))
    }

    fun `test workspace roots are searched and the base path is the fallback`() {
        assertEquals(
            listOf("/work/a", "/work/b"),
            FileSearch.directories(listOf("file:///work/a", "file:///work/b"), "/ignored"),
        )
        assertEquals(listOf("/proj"), FileSearch.directories(emptyList(), "/proj"))
    }

    fun `test relative file results are joined to the root`() {
        assertEquals("/work/src/A.kt", FileSearch.displayPath("/work", "src/A.kt"))
        assertEquals("/other/A.kt", FileSearch.displayPath("/work", "/other/A.kt"))
    }
}
