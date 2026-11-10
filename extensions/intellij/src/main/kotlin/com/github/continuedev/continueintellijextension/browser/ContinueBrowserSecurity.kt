package com.github.continuedev.continueintellijextension.browser

import java.net.URI

/**
 * The panel bridge is only installed on the Continuous page, and messages
 * are posted to that origin rather than to every frame.
 */
internal object ContinueBrowserSecurity {
    enum class Navigation { ALLOW, OPEN_EXTERNAL, CANCEL }

    fun originOf(url: String?): String? {
        if (url.isNullOrBlank()) return null
        return try {
            val uri = URI(url)
            val scheme = uri.scheme?.lowercase() ?: return null
            val host = uri.host?.lowercase() ?: return null
            val port = if (uri.port == -1) "" else ":${uri.port}"
            "$scheme://$host$port"
        } catch (_: Exception) {
            null
        }
    }

    fun shouldInjectBridge(frameUrl: String?, guiUrl: String): Boolean {
        val frame = originOf(frameUrl) ?: return false
        val gui = originOf(guiUrl) ?: return false
        return frame == gui
    }

    fun navigation(targetUrl: String?, guiUrl: String): Navigation {
        if (targetUrl.isNullOrBlank()) return Navigation.CANCEL
        if (targetUrl == "about:blank") return Navigation.ALLOW
        if (shouldInjectBridge(targetUrl, guiUrl)) return Navigation.ALLOW
        if (isHttpUrl(targetUrl)) return Navigation.OPEN_EXTERNAL
        return Navigation.CANCEL
    }

    fun isHttpUrl(url: String): Boolean {
        return try {
            val uri = URI(url)
            val scheme = uri.scheme?.lowercase()
            (scheme == "http" || scheme == "https") && !uri.host.isNullOrBlank()
        } catch (_: Exception) {
            false
        }
    }

    fun jsString(value: String): String {
        val escaped = buildString {
            for (ch in value) {
                when (ch) {
                    '\\' -> append("\\\\")
                    '"' -> append("\\\"")
                    '\n' -> append("\\n")
                    '\r' -> append("\\r")
                    '<' -> append("\\u003c")
                    else -> append(ch)
                }
            }
        }
        return "\"$escaped\""
    }

    fun postMessageScript(json: String, guiUrl: String): String {
        val origin = originOf(guiUrl) ?: "http://continue"
        return "window.postMessage($json, ${jsString(origin)});"
    }
}
