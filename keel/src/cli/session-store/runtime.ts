import type { SessionStoreRuntime } from "./model.ts";

export function isoTimestamp(runtime: SessionStoreRuntime): string {
  return new Date(runtime.now()).toISOString();
}
