package com.github.continuedev.continueintellijextension.`continue`

import java.io.File

/**
 * `rg --files` does not honour `--max-count`. The file list is capped here,
 * and each workspace root is searched, not only the project base path.
 */
internal object FileSearch {
    fun fileArgs(ripgrep: String, pattern: String, defaultIgnorePattern: String): List<String> {
        return listOf(
            ripgrep,
            "--files",
            "--iglob",
            pattern,
            "--ignore-file",
            ".continueignore",
            "--ignore-file",
            ".gitignore",
            "--glob",
            "!{$defaultIgnorePattern}",
        )
    }

    fun lines(stdout: String): List<String> =
        stdout.split("\n").map { it.trimEnd('\r') }.filter { it.isNotBlank() }

    fun cap(lines: List<String>, maxResults: Int?): List<String> {
        if (maxResults == null) return lines
        if (maxResults <= 0) return emptyList()
        return lines.take(maxResults)
    }

    fun directories(workspaceUris: List<String>, basePath: String?): List<String> {
        val fromUris = workspaceUris.mapNotNull { uri ->
            try {
                UriUtils.uriToFile(uri).path
            } catch (_: Exception) {
                null
            }
        }
        if (fromUris.isNotEmpty()) return fromUris
        return listOfNotNull(basePath)
    }

    fun displayPath(root: String, line: String): String {
        val file = File(line)
        return if (file.isAbsolute) line else File(root, line).path
    }
}
