/**
 * 简易结构化日志工具。
 * 生产环境可替换为 pino / winston。
 */

type LogLevel = "debug" | "info" | "warn" | "error";

const LEVEL_ORDER: Record<LogLevel, number> = { debug: 0, info: 1, warn: 2, error: 3 };
const currentLevel: LogLevel = (process.env.LOG_LEVEL as LogLevel) || "info";

function shouldLog(level: LogLevel): boolean {
  return LEVEL_ORDER[level] >= LEVEL_ORDER[currentLevel];
}

function format(level: LogLevel, message: string, data?: unknown): string {
  const ts = new Date().toISOString();
  const payload = data !== undefined ? ` ${JSON.stringify(data)}` : "";
  return `[${ts}] [${level.toUpperCase()}] ${message}${payload}`;
}

export const logger = {
  debug(message: string, data?: unknown) {
    if (shouldLog("debug")) console.debug(format("debug", message, data));
  },
  info(message: string, data?: unknown) {
    if (shouldLog("info")) console.info(format("info", message, data));
  },
  warn(message: string, data?: unknown) {
    if (shouldLog("warn")) console.warn(format("warn", message, data));
  },
  error(message: string, data?: unknown) {
    if (shouldLog("error")) console.error(format("error", message, data));
  },
};
