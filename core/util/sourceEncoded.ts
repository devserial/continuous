/**
 * `bash -lc 'source <(echo <base64> | base64 -d)'`: bash runs `command`
 * exactly as written, whatever passes the command line between (wsl.exe,
 * `docker run`). The base64 alphabet has nothing for a command line parser to
 * mangle (`wsl.exe` was seen to drop the quotes from `<<'EOF'`), and sourcing
 * keeps the command in the login shell itself, so `exit N`, `cd` and standard
 * input behave as they do for `bash -c`. Shared by the WSL and container
 * executors. A Windows command line holds about 32,000 characters, so a very
 * long command (over about 24,000 before encoding) fails to start there.
 */
export function sourceEncodedArgs(command: string): string[] {
  const encoded = Buffer.from(command, "utf8").toString("base64");
  return ["bash", "-lc", `source <(echo ${encoded} | base64 -d)`];
}
