import { randomUUID } from "node:crypto";

export function createAutomaticSessionId(): string {
  return `session-${randomUUID()}`;
}
