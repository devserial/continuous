package com.github.continuedev.continueintellijextension.unit

import com.github.continuedev.continueintellijextension.nextEdit.DeletionSpan
import com.github.continuedev.continueintellijextension.nextEdit.DiffChar
import com.github.continuedev.continueintellijextension.nextEdit.deletionSpans
import junit.framework.TestCase

class NextEditDeletionRangesTest : TestCase() {
    fun `test consecutive deletions are one span`() {
        val diffs = listOf(
            DiffChar(type = "old", char = "a", oldLineIndex = 0, oldCharIndexInLine = 0),
            DiffChar(type = "old", char = "b", oldLineIndex = 0, oldCharIndexInLine = 1),
            DiffChar(type = "same", char = "c", oldLineIndex = 0, oldCharIndexInLine = 2),
            DiffChar(type = "old", char = "d", oldLineIndex = 0, oldCharIndexInLine = 3),
        )
        assertEquals(
            listOf(
                DeletionSpan(0, 0, 2),
                DeletionSpan(0, 3, 4),
            ),
            deletionSpans(diffs),
        )
    }

    fun `test equal deletion values are not paired with the first match`() {
        val deleted = DiffChar(type = "old", char = "a", oldLineIndex = 0, oldCharIndexInLine = 0)
        val inserted = DiffChar(type = "new", char = "b", newLineIndex = 0, newCharIndexInLine = 0)
        val sameAgain = DiffChar(type = "old", char = "a", oldLineIndex = 0, oldCharIndexInLine = 0)
        assertEquals(
            listOf(
                DeletionSpan(0, 0, 1),
                DeletionSpan(0, 0, 1),
            ),
            deletionSpans(listOf(deleted, inserted, sameAgain)),
        )
    }
}
