import type { AgentEvent } from "../agent/events.ts";
import { createTemporaryDirectory } from "./temporary-directory.ts";

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
  return await createTemporaryDirectory("keel-edit-");
}
