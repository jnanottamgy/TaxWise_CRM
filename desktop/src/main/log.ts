/**
 * One JSON line per event in the app's log folder. Never logs the device key, invite codes,
 * cookies or message content; strings that look like secrets are redacted.
 */

const SECRET = /\b[0-9a-f]{64}\b|code=[A-Za-z0-9]{10,40}|eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g;

export function scrub(text: string): string {
  return text.replace(SECRET, "[redacted]");
}

export interface LogSink {
  appendFileSync(path: string, data: string): void;
  statSync(path: string): { size: number };
  renameSync(from: string, to: string): void;
}

export type Logger = (message: string, details?: Record<string, unknown>) => void;

export function createLogger(path: string | null, fs: LogSink | null, echo: boolean, maxBytes = 1_000_000): Logger {
  return (message, details) => {
    const line = scrub(JSON.stringify({ ts: new Date().toISOString(), message, ...details }));
    if (echo) console.log(line);
    if (!path || !fs) return;
    try {
      try {
        if (fs.statSync(path).size > maxBytes) fs.renameSync(path, `${path}.1`);
      } catch {
        // no file yet
      }
      fs.appendFileSync(path, `${line}\n`);
    } catch {
      // logging must never take the app down
    }
  };
}
