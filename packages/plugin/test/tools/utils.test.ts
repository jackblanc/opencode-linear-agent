import { describe, test, expect } from "bun:test";
import { Result } from "better-result";
import {
  createLinearClientProvider,
  parseDateFilter,
  withWarnings,
  errMsg,
  errorJson,
} from "../../src/tools/utils";

describe("parseDateFilter", () => {
  test("parses ISO date string", () => {
    const result = parseDateFilter("2025-06-15T00:00:00Z");
    expect(result.toISOString()).toBe("2025-06-15T00:00:00.000Z");
  });

  test("parses -P1D as ~24h ago", () => {
    const before = Date.now() - 86400 * 1000 - 100;
    const result = parseDateFilter("-P1D");
    const after = Date.now() - 86400 * 1000 + 100;
    expect(result.getTime()).toBeGreaterThanOrEqual(before);
    expect(result.getTime()).toBeLessThanOrEqual(after);
  });

  test("parses -P7D as ~7 days ago", () => {
    const before = Date.now() - 7 * 86400 * 1000 - 100;
    const result = parseDateFilter("-P7D");
    const after = Date.now() - 7 * 86400 * 1000 + 100;
    expect(result.getTime()).toBeGreaterThanOrEqual(before);
    expect(result.getTime()).toBeLessThanOrEqual(after);
  });

  test("parses P1D as ~24h in the future", () => {
    const before = Date.now() + 86400 * 1000 - 100;
    const result = parseDateFilter("P1D");
    const after = Date.now() + 86400 * 1000 + 100;
    expect(result.getTime()).toBeGreaterThanOrEqual(before);
    expect(result.getTime()).toBeLessThanOrEqual(after);
  });

  test("parses -PT2H30M as 2.5 hours ago", () => {
    const expected = Date.now() - (2 * 3600 + 30 * 60) * 1000;
    const result = parseDateFilter("-PT2H30M");
    expect(Math.abs(result.getTime() - expected)).toBeLessThan(200);
  });

  test("parses -P1W as ~7 days ago", () => {
    const expected = Date.now() - 7 * 86400 * 1000;
    const result = parseDateFilter("-P1W");
    expect(Math.abs(result.getTime() - expected)).toBeLessThan(200);
  });

  test("parses -P2W3D as ~17 days ago", () => {
    const expected = Date.now() - 17 * 86400 * 1000;
    const result = parseDateFilter("-P2W3D");
    expect(Math.abs(result.getTime() - expected)).toBeLessThan(200);
  });

  test("parses -P1M as ~30 days ago", () => {
    const expected = Date.now() - 30 * 86400 * 1000;
    const result = parseDateFilter("-P1M");
    expect(Math.abs(result.getTime() - expected)).toBeLessThan(200);
  });

  test("parses -P3M as ~90 days ago", () => {
    const expected = Date.now() - 90 * 86400 * 1000;
    const result = parseDateFilter("-P3M");
    expect(Math.abs(result.getTime() - expected)).toBeLessThan(200);
  });

  test("parses -P1Y as ~365 days ago", () => {
    const expected = Date.now() - 365 * 86400 * 1000;
    const result = parseDateFilter("-P1Y");
    expect(Math.abs(result.getTime() - expected)).toBeLessThan(200);
  });

  test("parses -P1Y6M as ~547.5 days ago", () => {
    const expected = Date.now() - (365 + 180) * 86400 * 1000;
    const result = parseDateFilter("-P1Y6M");
    expect(Math.abs(result.getTime() - expected)).toBeLessThan(200);
  });

  test("falls back to new Date() for invalid duration", () => {
    const result = parseDateFilter("-Pgarbage");
    expect(result.getTime()).toBeNaN();
  });

  test("falls back to new Date() for plain date string", () => {
    const result = parseDateFilter("2025-01-01");
    expect(result.getFullYear()).toBe(2025);
    expect(result.getMonth()).toBe(0);
    expect(result.getDate()).toBe(1);
  });
});

describe("withWarnings", () => {
  test("returns data without warnings field when empty", () => {
    const result = JSON.parse(withWarnings({ success: true }, []));
    expect(result).toEqual({ success: true });
    expect(result.warnings).toBeUndefined();
  });

  test("includes warnings when present", () => {
    const result = JSON.parse(
      withWarnings({ success: true }, ["State not found"]),
    );
    expect(result).toEqual({
      success: true,
      warnings: ["State not found"],
    });
  });

  test("includes multiple warnings", () => {
    const result = JSON.parse(withWarnings({ id: "abc" }, ["warn1", "warn2"]));
    expect(result.warnings).toEqual(["warn1", "warn2"]);
  });
});

describe("errMsg", () => {
  test("extracts message from Error", () => {
    expect(errMsg(new Error("something broke"))).toBe("something broke");
  });

  test("returns 'Unknown error' for non-Error", () => {
    expect(errMsg("string error")).toBe("Unknown error");
    expect(errMsg(42)).toBe("Unknown error");
    expect(errMsg(null)).toBe("Unknown error");
    expect(errMsg(undefined)).toBe("Unknown error");
  });
});

describe("errorJson", () => {
  test("returns JSON with error field", () => {
    const result = JSON.parse(errorJson("bad input"));
    expect(result).toEqual({ error: "bad input" });
  });
});

describe("createLinearClientProvider", () => {
  test("passes provider errors through", async () => {
    const getClient = createLinearClientProvider(async () =>
      Result.err("token failed"),
    );

    const result = await getClient();

    expect(Result.isError(result)).toBe(true);
    if (Result.isError(result)) {
      expect(result.error).toBe("token failed");
    }
  });

  test("reuses client when token stays same", async () => {
    const getClient = createLinearClientProvider(async () =>
      Result.ok("token-1"),
    );

    const first = await getClient();
    const second = await getClient();

    expect(Result.isOk(first)).toBe(true);
    expect(Result.isOk(second)).toBe(true);
    if (Result.isOk(first) && Result.isOk(second)) {
      expect(first.value).toBe(second.value);
    }
  });

  test("creates new client when token changes", async () => {
    let token = "token-1";
    const getClient = createLinearClientProvider(async () => Result.ok(token));

    const first = await getClient();
    token = "token-2";
    const second = await getClient();

    expect(Result.isOk(first)).toBe(true);
    expect(Result.isOk(second)).toBe(true);
    if (Result.isOk(first) && Result.isOk(second)) {
      expect(first.value).not.toBe(second.value);
    }
  });
});
