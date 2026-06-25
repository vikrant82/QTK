import { redactSecrets } from "./redaction.ts";
import type { QtkConfig } from "./types.ts";

type LogField = string | number | boolean | null | undefined;

export interface QtkLogger {
  readonly debugEnabled: boolean;
  debug(event: string, fields?: Record<string, LogField>): void;
}

export interface QtkLoggerOptions {
  readonly logLevel: QtkConfig["logLevel"];
  readonly debugEnv?: string;
  readonly sink?: (line: string) => void;
}

export const NOOP_LOGGER: QtkLogger = {
  debugEnabled: false,
  debug() {},
};

export function createQtkLogger(opts: QtkLoggerOptions): QtkLogger {
  const debugEnabled = opts.logLevel === "debug" || isTruthy(opts.debugEnv);
  const sink = opts.sink ?? ((line: string) => console.log(line));
  return {
    debugEnabled,
    debug(event, fields = {}) {
      if (!debugEnabled) return;
      const suffix = formatFields(fields);
      sink(`[qtk] ${event}${suffix ? ` ${suffix}` : ""}`);
    },
  };
}

export function sanitizeLogLabel(value: string): string {
  return redactSecrets(value).text.replace(/\s+/g, " ").trim();
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}kB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
}

export function formatRatioSaved(inputBytes: number, outputBytes: number): string {
  if (inputBytes <= 0) return "0.0%";
  return `${((1 - outputBytes / inputBytes) * 100).toFixed(1)}%`;
}

export function formatArrow<T extends string | number>(from: T, to: T): string {
  return `${from}→${to}`;
}

function formatFields(fields: Record<string, LogField>): string {
  return Object.entries(fields)
    .filter((entry): entry is [string, Exclude<LogField, undefined>] => {
      return entry[1] !== undefined;
    })
    .map(([key, value]) => `${key}=${formatValue(value)}`)
    .join(" ");
}

function formatValue(value: Exclude<LogField, undefined>): string {
  if (value === null) return "null";
  if (typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }
  const safe = truncate(sanitizeLogLabel(value), 160);
  if (/^[A-Za-z0-9_./:%+\-=→]+$/.test(safe)) return safe;
  return JSON.stringify(safe);
}

function truncate(value: string, max: number): string {
  if (value.length <= max) return value;
  return `${value.slice(0, max - 1)}…`;
}

function isTruthy(value: string | undefined): boolean {
  if (!value) return false;
  const normalized = value.trim().toLowerCase();
  return !["", "0", "false", "no", "off"].includes(normalized);
}
