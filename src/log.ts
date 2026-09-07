/**
 * Extension log sink. Never write cookies, JWTs, or ItemTable values here.
 */

let sink: ((message: string) => void) | undefined;

export function setExtensionLogger(fn: (message: string) => void): void {
  sink = fn;
}

export function log(message: string): void {
  sink?.(message);
}

/** Stringify an error without leaking JWT-shaped tokens. */
export function sanitizeError(err: unknown): string {
  let raw: string;
  if (err instanceof Error) {
    const code =
      "code" in err && typeof (err as NodeJS.ErrnoException).code === "string"
        ? (err as NodeJS.ErrnoException).code
        : undefined;
    raw = code ? `${err.name} [${code}]: ${err.message}` : `${err.name}: ${err.message}`;
  } else {
    raw = String(err);
  }
  return raw.replace(/eyJ[\w-]+\.[\w-]+\.[\w-]+/g, "[jwt]");
}
