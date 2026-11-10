package com.github.continuedev.continueintellijextension.`continue`

/**
 * Splits a command string into arguments, keeping quoted paths together.
 * The IDE starts the process from this list, with no shell.
 */
internal object CommandArgs {
    fun split(command: String): List<String> {
        val args = mutableListOf<String>()
        val current = StringBuilder()
        var quote: Char? = null
        var i = 0
        while (i < command.length) {
            val ch = command[i]
            when {
                quote == null && ch.isWhitespace() -> {
                    if (current.isNotEmpty()) {
                        args.add(current.toString())
                        current.clear()
                    }
                }

                quote == null && (ch == '"' || ch == '\'') -> quote = ch
                quote == ch -> quote = null
                ch == '\\' && quote != '\'' && i + 1 < command.length -> {
                    i += 1
                    current.append(command[i])
                }

                else -> current.append(ch)
            }
            i += 1
        }
        if (current.isNotEmpty()) args.add(current.toString())
        return args
    }
}
