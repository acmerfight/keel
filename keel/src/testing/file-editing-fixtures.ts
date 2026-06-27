import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentEvent } from "../agent/events.ts";

export async function collect(
  source: AsyncIterable<AgentEvent>,
): Promise<AgentEvent[]> {
  const events: AgentEvent[] = [];
  for await (const event of source) {
    events.push(event);
  }
  return events;
}

export function freshSignal(): AbortSignal {
  return new AbortController().signal;
}

export async function createWorkspace(): Promise<string> {
  return mkdtemp(join(tmpdir(), "keel-edit-"));
}
