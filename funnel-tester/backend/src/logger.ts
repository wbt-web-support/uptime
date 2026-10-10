// Minimal structured console logger - timestamped, leveled, and prints
// errors with their stack (or full value, for anything that isn't an Error)
// so a crash server-side is actually diagnosable instead of a bare stack-less
// line or, worse, only visible to whoever happened to be looking at the
// dashboard at that moment.
type Level = "info" | "warn" | "error";

function write(level: Level, msg: string, meta?: Record<string, unknown>) {
  const ts = new Date().toISOString();
  const line = `${ts} [${level.toUpperCase()}] ${msg}`;
  const out = level === "error" ? console.error : level === "warn" ? console.warn : console.log;
  if (meta && Object.keys(meta).length > 0) {
    out(line, meta);
  } else {
    out(line);
  }
}

export const logger = {
  info: (msg: string, meta?: Record<string, unknown>) => write("info", msg, meta),
  warn: (msg: string, meta?: Record<string, unknown>) => write("warn", msg, meta),
  error: (msg: string, err?: unknown, meta?: Record<string, unknown>) => {
    const errInfo =
      err instanceof Error ? { message: err.message, stack: err.stack } : err !== undefined ? { value: String(err) } : undefined;
    write("error", msg, { ...meta, ...(errInfo ? { error: errInfo } : {}) });
  },
};
