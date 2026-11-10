/**
 * Rebuild a file after a non-streaming apply.
 *
 * The model only sees a pruned head and tail, so those strings must not be
 * used as the file. `fullPrefix` and `fullSuffix` are the unpruned text on
 * either side of the edited range.
 */
export function assembleAppliedContent(
  fullPrefix: string,
  streamedLines: string[],
  fullSuffix: string,
): string {
  return `${fullPrefix}${streamedLines.join("\n")}${fullSuffix}`;
}
