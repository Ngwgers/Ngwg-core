// Ngwg logging system.
//
// Three user-facing verbosity levels, switched from the CLI:
//   --quiet    only errors and warnings
//   (default)  core version, plugin list, reload progress, errors, warnings
//   --verbose  default + a trace of every operation (read/write/parse/…)
//
// "silent" is an internal level used by tests to hush everything.
//
// Loggers pick up the global level unless they were constructed with an
// explicit one; core-internal code (fs helpers etc.) logs through trace().

export type LogLevel = "silent" | "quiet" | "default" | "verbose";

let globalLevel: LogLevel = "default";

export function setLogLevel(level: LogLevel): void {
  globalLevel = level;
}

export function getLogLevel(): LogLevel {
  return globalLevel;
}

const colors = {
  info: (s: string) => `\x1b[36m${s}\x1b[0m`,
  ok: (s: string) => `\x1b[32m${s}\x1b[0m`,
  warn: (s: string) => `\x1b[33m${s}\x1b[0m`,
  error: (s: string) => `\x1b[31m${s}\x1b[0m`,
  debug: (s: string) => `\x1b[2m${s}\x1b[0m`,
} as const;

export class Logger {
  constructor(
    private prefix = "ngwg",
    private explicit?: LogLevel,
  ) {}

  child(prefix: string): Logger {
    return new Logger(prefix, this.explicit);
  }

  private get level(): LogLevel {
    return this.explicit ?? globalLevel;
  }

  private write(kind: keyof typeof colors, msg: string) {
    const tag = colors[kind](`${this.prefix}`);
    const line = `${tag} ${msg}`;
    if (kind === "error") console.error(line);
    else console.log(line);
  }

  /** quiet=false, default=true, verbose=true */
  private at(...levels: LogLevel[]): boolean {
    return levels.includes(this.level);
  }

  info(msg: string) {
    if (this.at("default", "verbose")) this.write("info", msg);
  }
  ok(msg: string) {
    if (this.at("default", "verbose")) this.write("ok", msg);
  }
  /** quiet、default、verbose 都显示 */
  warn(msg: string) {
    if (this.at("quiet", "default", "verbose")) this.write("warn", `⚠ ${msg}`);
  }
  /** 任何档位都显示（silent 除外——那是测试用的静音档） */
  error(msg: string) {
    if (this.level !== "silent") this.write("error", `✗ ${msg}`);
  }
  /** 仅 verbose */
  debug(msg: string) {
    if (this.at("verbose")) this.write("debug", `· ${msg}`);
  }
}

/** Core-internal system logger (file operations, theme loading, …). */
const systemLogger = new Logger("fs");

/** Trace a low-level operation; printed only at --verbose. */
export function trace(msg: string): void {
  if (globalLevel === "verbose") systemLogger.debug(msg);
}
