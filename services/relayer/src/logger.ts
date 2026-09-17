export type LogLevel = "debug" | "info" | "warn" | "error";
const ORDER: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

/** Field names whose values are never written, whatever their content. */
const REDACT = /^(private_?key|relayer_private_key|secret|password|mnemonic|seed)$/i;

export interface Logger {
  debug(msg: string, fields?: Record<string, unknown>): void;
  info(msg: string, fields?: Record<string, unknown>): void;
  warn(msg: string, fields?: Record<string, unknown>): void;
  error(msg: string, fields?: Record<string, unknown>): void;
  /** New logger that adds `bindings` (e.g. `tickId`, `round`) to every line: the correlation ids. */
  child(bindings: Record<string, unknown>): Logger;
}

export function serializeError(err: unknown): Record<string, unknown> {
  if (!(err instanceof Error)) return { message: String(err) };
  const e = err as Error & { code?: unknown; errorName?: unknown; shortMessage?: unknown };
  const out: Record<string, unknown> = { name: e.name, message: e.shortMessage ?? e.message.split("\n")[0] };
  if (e.code !== undefined) out.code = e.code;
  if (e.errorName !== undefined) out.errorName = e.errorName;
  return out;
}

function replacer(key: string, value: unknown): unknown {
  if (key && REDACT.test(key)) return "[REDACTED]";
  if (typeof value === "bigint") return value.toString();
  if (value instanceof Error) return serializeError(value);
  return value;
}

/**
 * JSON-lines logger: one object per line with `ts, level, msg, service, runId` plus bindings and fields.
 * Hand-rolled to keep the relayer dependency-free beyond viem and zod.
 */
export function createLogger(opts: {
  level: LogLevel;
  service?: string;
  bindings?: Record<string, unknown>;
  write?: (line: string) => void;
  now?: () => Date;
}): Logger {
  const min = ORDER[opts.level];
  const write = opts.write ?? ((line: string) => process.stdout.write(`${line}\n`));
  const now = opts.now ?? (() => new Date());
  const base = { service: opts.service ?? "relayer", ...opts.bindings };

  const log = (level: LogLevel, msg: string, fields?: Record<string, unknown>) => {
    if (ORDER[level] < min) return;
    let line: string;
    try {
      line = JSON.stringify({ ts: now().toISOString(), level, msg, ...base, ...fields }, replacer);
    } catch (err) {
      line = JSON.stringify({ ts: now().toISOString(), level, msg, ...base, logError: serializeError(err) });
    }
    write(line);
  };

  return {
    debug: (m, f) => log("debug", m, f),
    info: (m, f) => log("info", m, f),
    warn: (m, f) => log("warn", m, f),
    error: (m, f) => log("error", m, f),
    child: (bindings) =>
      createLogger({ ...opts, level: opts.level, write, now, bindings: { ...opts.bindings, ...bindings } }),
  };
}
