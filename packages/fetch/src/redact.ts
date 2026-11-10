/** Query parameters whose values are credentials and must not be logged or shown. */
const SECRET_PARAMS = new Set([
  "key",
  "apikey",
  "api_key",
  "token",
  "sig",
  "access_token",
  "client_secret",
]);

const SECRET_HEADERS =
  /^(authorization|proxy-authorization|x-api-key|api-key|x-goog-api-key)$/i;

const SECRET_BODY =
  /(apikey|api_key|access_token|client_secret|password|key)=([^&\s'"]+)/gi;

/** Replace credential query parameters. The host and path are left intact. */
export function redactUrl(value: string): string {
  try {
    const url = new URL(value);
    let changed = false;
    for (const name of [...url.searchParams.keys()]) {
      if (SECRET_PARAMS.has(name.toLowerCase())) {
        url.searchParams.set(name, "REDACTED");
        changed = true;
      }
    }
    if (url.username || url.password) {
      url.username = url.username ? "REDACTED" : "";
      url.password = url.password ? "REDACTED" : "";
      changed = true;
    }
    return changed ? url.toString() : value;
  } catch {
    return value.replace(
      /([?&#](?:key|apikey|api_key|token|sig|access_token|client_secret)=)[^&#\s]*/gi,
      "$1REDACTED",
    );
  }
}

export function redactHeaderValue(name: string, value: string): string {
  return SECRET_HEADERS.test(name) ? "REDACTED" : value;
}

/** Form bodies can carry the same credentials a URL used to. */
export function redactBody(body: unknown): string {
  return String(body ?? "").replace(SECRET_BODY, "$1=REDACTED");
}
