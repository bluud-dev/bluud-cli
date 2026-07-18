/**
 * Leveled diagnostic logger.
 *
 * Logs are *diagnostics*, not program output: they always go to stderr so they
 * never contaminate stdout, which is reserved for command data (human lines or
 * `--json` payloads). This separation is what lets `bluud pull --json | jq` and
 * `bluud pull | claude` work while still surfacing warnings to the terminal.
 *
 * Level is resolved once at startup from flags and the `BLUUD_LOG` env var; the
 * threshold gates every call so disabled levels cost nothing but a comparison.
 */

import pc from "picocolors";

export type LogLevel = "debug" | "info" | "warn" | "error" | "silent";

const LEVEL_ORDER: Record<LogLevel, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
  silent: 100,
};

export interface Logger {
  readonly level: LogLevel;
  debug(message: string): void;
  info(message: string): void;
  warn(message: string): void;
  error(message: string): void;
  success(message: string): void;
  /** True when debug output is enabled — guard expensive message building. */
  isDebug(): boolean;
}

export interface LoggerOptions {
  level?: LogLevel;
  /** Sink for log lines. Defaults to process.stderr. Injectable for tests. */
  sink?: (line: string) => void;
  /** Disable ANSI colors regardless of TTY (also honors NO_COLOR). */
  noColor?: boolean;
}

/**
 * Resolve the effective log level from CLI flags and environment.
 *
 * Precedence (first match wins): explicit `--quiet` → `error`; `--debug` or
 * `--verbose` → `debug`; `BLUUD_LOG` (`debug|info|warn|error|silent`); else the
 * `info` default. `--json` does not change the level — logs stay on stderr and
 * JSON goes to stdout independently.
 */
export function resolveLogLevel(opts: {
  quiet?: boolean;
  verbose?: boolean;
  debug?: boolean;
  env?: string | undefined;
}): LogLevel {
  if (opts.quiet) {
    return "error";
  }
  if (opts.debug || opts.verbose) {
    return "debug";
  }
  const env = opts.env?.trim().toLowerCase();
  if (env && env in LEVEL_ORDER) {
    return env as LogLevel;
  }
  return "info";
}

export function createLogger(options: LoggerOptions = {}): Logger {
  const level = options.level ?? "info";
  const threshold = LEVEL_ORDER[level];
  const sink = options.sink ?? ((line: string) => process.stderr.write(`${line}\n`));
  const useColor = !options.noColor && !process.env.NO_COLOR && process.stderr.isTTY === true;

  const paint = (fn: (s: string) => string, s: string): string => (useColor ? fn(s) : s);

  const emit = (msgLevel: LogLevel, label: string, message: string): void => {
    if (LEVEL_ORDER[msgLevel] < threshold) {
      return;
    }
    sink(label ? `${label} ${message}` : message);
  };

  return {
    level,
    debug: (message) => emit("debug", paint(pc.gray, "debug"), message),
    info: (message) => emit("info", "", message),
    warn: (message) => emit("warn", paint(pc.yellow, "warning:"), message),
    error: (message) => emit("error", paint(pc.red, "error:"), message),
    success: (message) => emit("info", paint(pc.green, "✓"), message),
    isDebug: () => LEVEL_ORDER.debug >= threshold,
  };
}

/** A logger that discards everything — the default when none is injected. */
export const nullLogger: Logger = createLogger({ level: "silent", sink: () => {} });
