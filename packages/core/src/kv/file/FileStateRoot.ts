import type { z } from "zod";

import { FileNamespaceStore } from "./FileNamespaceStore";

class FileStateRoot {
  constructor(readonly path: string) {}

  namespace<T>(name: string, schema: z.ZodType<T>): FileNamespaceStore<T> {
    return new FileNamespaceStore(name, this.path, schema);
  }
}

export function createFileStateRoot(path: string): FileStateRoot {
  return new FileStateRoot(path);
}
