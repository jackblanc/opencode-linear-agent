import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { Result } from "better-result";
import { z } from "zod";

import { withFileLock } from "../../src/kv/file/lock";
import { encodeKvKey } from "../../src/kv/key";
import { writeFileAtomic } from "../../src/kv/file/atomic";
import { FileNamespaceStore } from "../../src/kv/file/FileNamespaceStore";
import { getStateRootPath } from "../../src/paths";
import { createFileAgentState } from "../../src/state/root";

const TEST_DIR = join(import.meta.dir, ".test-kv");
const schema = z.object({ value: z.string() });

function createStore(namespace: string): FileNamespaceStore<{ value: string }> {
  return new FileNamespaceStore(namespace, TEST_DIR, schema);
}

beforeEach(async () => {
  await rm(TEST_DIR, { recursive: true, force: true });
  await mkdir(TEST_DIR, { recursive: true });
});

afterEach(async () => {
  await rm(TEST_DIR, { recursive: true, force: true });
});

describe("KV key encoding", () => {
  test("rejects multi-segment keys", () => {
    const encoded = encodeKvKey("session/abc:123");
    expect(encoded.isOk()).toBe(false);
  });

  test("roundtrips safe keys", () => {
    const encoded = encodeKvKey("linear-1");
    expect(encoded.isOk()).toBe(true);
    if (!encoded.isOk()) {
      return;
    }

    expect(encoded.value).toBe("linear-1");
  });
});

describe("FileNamespaceStore", () => {
  test("put/get roundtrip", async () => {
    const store = createStore("session");

    const put = await store.put("linear-1", { value: "ok" });
    expect(put.isOk()).toBe(true);

    const got = await store.get("linear-1");
    expect(got.isOk()).toBe(true);
    if (!got.isOk()) {
      return;
    }

    expect(got.value).toEqual({ value: "ok" });
  });

  test("delete removes stored record", async () => {
    const store = createStore("question");

    await store.put("linear-1", { value: "ok" });
    const del = await store.delete("linear-1");
    expect(del.isOk()).toBe(true);

    const got = await store.get("linear-1");
    expect(got.isOk()).toBe(true);
    if (!got.isOk()) {
      return;
    }

    expect(got.value).toBeNull();
  });

  test("missing key returns null", async () => {
    const store = createStore("permission");

    const got = await store.get("missing");
    expect(got.isOk()).toBe(true);
    if (!got.isOk()) {
      return;
    }

    expect(got.value).toBeNull();
  });

  test("invalid json fails narrow", async () => {
    const store = createStore("session");
    const file = join(TEST_DIR, "session", "linear-1.json");

    await mkdir(join(TEST_DIR, "session"), { recursive: true });
    await writeFile(file, "{", "utf8");

    const got = await store.get("linear-1");
    expect(got.isOk()).toBe(false);
    if (got.isOk()) {
      return;
    }

    expect(got.error._tag).toBe("KvJsonParseError");
  });

  test("invalid schema fails narrow", async () => {
    const store = createStore("session");
    const file = join(TEST_DIR, "session", "linear-1.json");

    await mkdir(join(TEST_DIR, "session"), { recursive: true });
    await writeFile(file, JSON.stringify({ value: 1 }), "utf8");

    const got = await store.get("linear-1");
    expect(got.isOk()).toBe(false);
    if (got.isOk()) {
      return;
    }

    expect(got.error._tag).toBe("KvSchemaError");
  });

  test("atomic overwrite replaces full file", async () => {
    const path = join(TEST_DIR, "atomic.json");

    await writeFileAtomic(path, JSON.stringify({ value: "one" }));
    await writeFileAtomic(path, JSON.stringify({ value: "two" }));

    expect(await readFile(path, "utf8")).toBe('{"value":"two"}');
  });

  test("concurrent writes same key do not corrupt file", async () => {
    const store = createStore("session");

    const writes = Array.from({ length: 20 }, async (_, i) =>
      store.put("linear-1", { value: `v-${i}` }),
    );
    const out = await Promise.all(writes);

    expect(out.every((x) => x.isOk())).toBe(true);

    const got = await store.get("linear-1");
    expect(got.isOk()).toBe(true);
    if (!got.isOk() || got.value === null) {
      return;
    }

    expect(got.value.value.startsWith("v-")).toBe(true);
  });

  test("different namespaces do not collide", async () => {
    const a = createStore("session");
    const b = createStore("question");

    await a.put("same", { value: "session" });
    await b.put("same", { value: "question" });

    const gotA = await a.get("same");
    const gotB = await b.get("same");

    expect(gotA.isOk()).toBe(true);
    expect(gotB.isOk()).toBe(true);
    if (
      !gotA.isOk() ||
      !gotB.isOk() ||
      gotA.value === null ||
      gotB.value === null
    ) {
      return;
    }

    expect(gotA.value.value).toBe("session");
    expect(gotB.value.value).toBe("question");
  });

  test("state root wires planned namespaces", async () => {
    const state = createFileAgentState(TEST_DIR);

    await state.session.put("one", { id: 1 });
    await state.question.put("one", { id: 2 });

    const session = await state.session.get("one");
    const question = await state.question.get("one");

    expect(session.isOk()).toBe(true);
    expect(question.isOk()).toBe(true);
    if (!session.isOk() || !question.isOk()) {
      return;
    }

    expect(session.value).toEqual({ id: 1 });
    expect(question.value).toEqual({ id: 2 });
  });
});

describe("withFileLock", () => {
  test("releases lock when callback throws", async () => {
    const first = await withFileLock(TEST_DIR, "lock-a", async () => {
      throw new Error("boom");
    });
    expect(first.isOk()).toBe(false);

    const second = await withFileLock(TEST_DIR, "lock-a", async () =>
      Promise.resolve(Result.ok("ok")),
    );
    expect(second.isOk()).toBe(true);
    if (!second.isOk()) {
      return;
    }

    expect(second.value).toBe("ok");
  });

  test("times out instead of deleting active lock", async () => {
    const held = withFileLock(
      TEST_DIR,
      "lock-b",
      async () =>
        await new Promise<ReturnType<typeof Result.ok<string>>>((resolve) => {
          setTimeout(() => resolve(Result.ok("held")), 100);
        }),
    );

    await new Promise((resolve) => setTimeout(resolve, 10));

    const blocked = await withFileLock(
      TEST_DIR,
      "lock-b",
      async () => Promise.resolve(Result.ok("blocked")),
      { timeoutMs: 30, retryMs: 5 },
    );

    expect(blocked.isOk()).toBe(false);
    if (blocked.isOk()) {
      return;
    }

    expect(blocked.error._tag).toBe("KvLockError");
    await held;
  });
});

describe("getStateRootPath", () => {
  test("builds state root from xdg data root", () => {
    expect(getStateRootPath()).toBe("/tmp/data/opencode-linear-agent/state");
  });
});
