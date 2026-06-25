export function intOption(
  config: Record<string, unknown>,
  key: string,
  fallback: number,
  opts: { readonly min?: number; readonly max?: number } = {},
): number {
  const value = config[key];
  if (!Number.isFinite(value) || !Number.isInteger(value)) return fallback;
  return clamp(value as number, opts.min, opts.max);
}

export function numberOption(
  config: Record<string, unknown>,
  key: string,
  fallback: number,
  opts: { readonly min?: number; readonly max?: number } = {},
): number {
  const value = config[key];
  if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
  return clamp(value, opts.min, opts.max);
}

export function boolOption(
  config: Record<string, unknown>,
  key: string,
  fallback: boolean,
): boolean {
  const value = config[key];
  return typeof value === "boolean" ? value : fallback;
}

export function stringArrayOption(
  config: Record<string, unknown>,
  key: string,
  fallback: readonly string[] = [],
): readonly string[] {
  const value = config[key];
  if (!Array.isArray(value)) return fallback;
  return value.filter((item): item is string => typeof item === "string");
}

function clamp(value: number, min?: number, max?: number): number {
  if (min != null && value < min) return min;
  if (max != null && value > max) return max;
  return value;
}
