import * as URI from "uri-js";

/** The document an apply started on, and its version at that moment. */
export interface DocumentStamp {
  uri: string;
  version: number;
}

/**
 * True when the document is gone, a different file, or has been edited since
 * the stamp. A tab switch is a different uri; keystrokes bump the version.
 */
export function documentChanged(
  captured: DocumentStamp,
  current: DocumentStamp | undefined,
): boolean {
  if (!current || current.version !== captured.version) {
    return true;
  }
  if (current.uri === captured.uri) {
    return false;
  }
  try {
    return !URI.equal(current.uri, captured.uri);
  } catch {
    return true;
  }
}

/** Whether an open editor is the file `filepath` names (a URI or a filesystem path). */
export function editorMatchesFilepath(
  editor: { uri: string; fsPath: string },
  filepath: string,
): boolean {
  if (editor.uri === filepath || editor.fsPath === filepath) {
    return true;
  }
  try {
    return URI.equal(editor.uri, filepath);
  } catch {
    return false;
  }
}
