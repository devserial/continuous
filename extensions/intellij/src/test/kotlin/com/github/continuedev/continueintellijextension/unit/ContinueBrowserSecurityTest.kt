package com.github.continuedev.continueintellijextension.unit

import com.github.continuedev.continueintellijextension.browser.ContinueBrowserSecurity
import junit.framework.TestCase

class ContinueBrowserSecurityTest : TestCase() {
    private val gui = "http://continue/index.html"

    fun `test origin of the bundled page`() {
        assertEquals("http://continue", ContinueBrowserSecurity.originOf(gui))
        assertEquals(
            "http://localhost:5173",
            ContinueBrowserSecurity.originOf("http://localhost:5173/"),
        )
    }

    fun `test bridge is injected only for the panel origin`() {
        assertTrue(ContinueBrowserSecurity.shouldInjectBridge("http://continue/index.html", gui))
        assertFalse(ContinueBrowserSecurity.shouldInjectBridge("about:blank", gui))
        assertFalse(ContinueBrowserSecurity.shouldInjectBridge("https://example.com/", gui))
        assertFalse(ContinueBrowserSecurity.shouldInjectBridge("http://continue.evil.com/", gui))
        assertFalse(ContinueBrowserSecurity.shouldInjectBridge(null, gui))
    }

    fun `test navigation stays on the panel and opens http links outside it`() {
        assertEquals(
            ContinueBrowserSecurity.Navigation.ALLOW,
            ContinueBrowserSecurity.navigation("http://continue/index.html", gui),
        )
        assertEquals(
            ContinueBrowserSecurity.Navigation.ALLOW,
            ContinueBrowserSecurity.navigation("about:blank", gui),
        )
        assertEquals(
            ContinueBrowserSecurity.Navigation.OPEN_EXTERNAL,
            ContinueBrowserSecurity.navigation("https://example.com/docs", gui),
        )
        assertEquals(
            ContinueBrowserSecurity.Navigation.CANCEL,
            ContinueBrowserSecurity.navigation("file:///tmp/tool", gui),
        )
        assertEquals(
            ContinueBrowserSecurity.Navigation.CANCEL,
            ContinueBrowserSecurity.navigation("javascript:alert(1)", gui),
        )
    }

    fun `test postMessage names the panel origin`() {
        val script = ContinueBrowserSecurity.postMessageScript("{}", gui)
        assertTrue(script.contains("\"http://continue\""))
        assertFalse(script.contains("\"*\""))
    }

    fun `test http urls require a host`() {
        assertTrue(ContinueBrowserSecurity.isHttpUrl("https://example.com/a"))
        assertTrue(ContinueBrowserSecurity.isHttpUrl("http://example.com"))
        assertFalse(ContinueBrowserSecurity.isHttpUrl("file:///tmp/tool"))
        assertFalse(ContinueBrowserSecurity.isHttpUrl("javascript:alert(1)"))
        assertFalse(ContinueBrowserSecurity.isHttpUrl("https://"))
    }
}
