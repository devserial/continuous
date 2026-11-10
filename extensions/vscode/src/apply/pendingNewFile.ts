/**
 * Files apply is showing that do not exist on disk yet.
 * The editor URI is an untitled document; the filepath is where it will be
 * written if the person accepts.
 */
const pending = new Map<string, string>();

export function trackPendingNewFile(editorUri: string, filepath: string): void {
  pending.set(editorUri, filepath);
}

export function pendingEditorForFilepath(filepath: string): string | undefined {
  for (const [editorUri, path] of pending) {
    if (path === filepath) {
      return editorUri;
    }
  }
  return undefined;
}

export function pendingFilepathForEditor(
  editorUri: string,
): string | undefined {
  return pending.get(editorUri);
}

export function forgetPendingNewFile(filepathOrEditorUri: string): void {
  if (pending.delete(filepathOrEditorUri)) {
    return;
  }
  for (const [editorUri, path] of pending) {
    if (path === filepathOrEditorUri) {
      pending.delete(editorUri);
      return;
    }
  }
}
