import type { z } from "zod";

import { FileKeyValueStore } from "./FileKeyValueStore";

class FileStateRoot {
  constructor(readonly path: string) {}

  namespace<T>(name: string, schema: z.ZodType<T>): FileKeyValueStore<T> {
    return new FileKeyValueStore(name, this.path, schema);
  }
}

export function createFileStateRoot(path: string): FileStateRoot {
  return new FileStateRoot(path);
}
