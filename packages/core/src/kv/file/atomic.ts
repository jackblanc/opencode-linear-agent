import { Result } from "better-result";
import { randomUUID } from "node:crypto";
import { mkdir, rename, rm, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

import type { KvError } from "../errors";

import { KvIoError } from "../errors";

export async function writeFileAtomic(
  path: string,
  content: string,
): Promise<Result<void, KvError>> {
  const dir = dirname(path);
  const tempPath = `${path}.${randomUUID()}.tmp`;

  const result = await Result.tryPromise({
    try: async () => {
      await mkdir(dir, { recursive: true });
      await writeFile(tempPath, content, "utf8");
      await rename(tempPath, path);
    },
    catch: (error) =>
      new KvIoError({
        path,
        operation: "write",
        reason: error instanceof Error ? error.message : String(error),
      }),
  });

  if (Result.isError(result)) {
    await rm(tempPath, { force: true }).catch(() => undefined);
  }

  return result;
}
