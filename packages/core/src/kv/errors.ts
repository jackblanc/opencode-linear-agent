import { TaggedError } from "better-result";

export class KvInvalidKeyError extends TaggedError("KvInvalidKeyError")<{
  key: string;
  message: string;
}>() {
  constructor(args: { key: string; reason: string }) {
    super({
      key: args.key,
      message: `Invalid KV key '${args.key}': ${args.reason}`,
    });
  }
}

export class KvIoError extends TaggedError("KvIoError")<{
  path: string;
  operation: string;
  message: string;
}>() {
  constructor(args: { path: string; operation: string; reason: string }) {
    super({
      path: args.path,
      operation: args.operation,
      message: `KV ${args.operation} failed at ${args.path}: ${args.reason}`,
    });
  }
}

export class KvJsonParseError extends TaggedError("KvJsonParseError")<{
  path: string;
  message: string;
}>() {
  constructor(args: { path: string; reason: string }) {
    super({
      path: args.path,
      message: `Invalid JSON at ${args.path}: ${args.reason}`,
    });
  }
}

export class KvSchemaError extends TaggedError("KvSchemaError")<{
  path: string;
  issues: string[];
  message: string;
}>() {
  constructor(args: { path: string; issues: string[] }) {
    super({
      path: args.path,
      issues: args.issues,
      message: `Schema validation failed at ${args.path}: ${args.issues.join(", ")}`,
    });
  }
}

export class KvLockError extends TaggedError("KvLockError")<{
  path: string;
  message: string;
}>() {
  constructor(args: { path: string; reason: string }) {
    super({
      path: args.path,
      message: `KV lock failed at ${args.path}: ${args.reason}`,
    });
  }
}

export type KvError =
  | KvInvalidKeyError
  | KvIoError
  | KvJsonParseError
  | KvSchemaError
  | KvLockError;
