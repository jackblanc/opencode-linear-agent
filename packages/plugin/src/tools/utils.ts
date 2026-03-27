export function errorJson(message: string): string {
  return JSON.stringify({ error: message });
}

export function withWarnings(
  data: Record<string, unknown>,
  warnings: string[],
): string {
  return JSON.stringify(warnings.length > 0 ? { ...data, warnings } : data);
}

export function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : "Unknown error";
}

/**
 * Parse ISO dates and ISO 8601 durations into Date objects.
 * Supports: ISO date strings, -P1D, -P7D, -PT2H30M, P1W, etc.
 */
export function parseDateFilter(value: string): Date {
  if (value.startsWith("-P") || value.startsWith("P")) {
    const neg = value.startsWith("-");
    const dur = neg ? value.slice(1) : value;
    const match = dur.match(
      /^P(?:(\d+)Y)?(?:(\d+)M)?(?:(\d+)W)?(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?)?$/,
    );
    if (match) {
      const years = parseInt(match[1] ?? "0", 10);
      const months = parseInt(match[2] ?? "0", 10);
      const weeks = parseInt(match[3] ?? "0", 10);
      const days = parseInt(match[4] ?? "0", 10);
      const hours = parseInt(match[5] ?? "0", 10);
      const minutes = parseInt(match[6] ?? "0", 10);
      const ms =
        (years * 31536000 +
          months * 2592000 +
          weeks * 604800 +
          days * 86400 +
          hours * 3600 +
          minutes * 60) *
        1000;
      return new Date(Date.now() - (neg ? ms : -ms));
    }
  }
  return new Date(value);
}
