package com.github.continuedev.continueintellijextension.`continue`.process

import java.io.InputStream
import java.io.OutputStream
import java.net.Socket

/**
 * The first line the dev control port expects, ending in CR LF.
 * `token` is the same value as the core process's CONTINUE_TCP_TOKEN.
 */
internal fun devTcpAuthLine(token: String): String {
    val escaped = buildString {
        for (ch in token) {
            when {
                ch == '\\' -> append("\\\\")
                ch == '"' -> append("\\\"")
                ch == '\n' -> append("\\n")
                ch == '\r' -> append("\\r")
                ch.code < 0x20 -> append("\\u%04x".format(ch.code))
                else -> append(ch)
            }
        }
    }
    return """{"messageType":"tcpAuth","messageId":"auth","data":"$escaped"}""" + "\r\n"
}

class ContinueSocketProcess : ContinueProcess {

    private val socket: Socket
    override val input: InputStream
    override val output: OutputStream

    init {
        val token = System.getenv("CONTINUE_TCP_TOKEN")?.trim().orEmpty()
        require(token.length >= 16) {
            "Set CONTINUE_TCP_TOKEN (at least 16 characters) to the same value as the core process."
        }
        val connected = Socket("127.0.0.1", 3000)
        socket = connected
        input = connected.inputStream
        output = connected.outputStream
        output.write(devTcpAuthLine(token).toByteArray(Charsets.UTF_8))
        output.flush()
    }

    override fun close() =
        socket.close()

}
