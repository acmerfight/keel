import type { SessionMessage } from "../../src/agent/session-message.ts";
import { resolveBuiltinSubagentProfile } from "../../src/agent/subagent-profile.ts";
import { createAgentTreeHistory } from "../../src/cli/agent-tree-store.ts";
import { createSessionTaskRecovery } from "../../src/cli/interactive-session/task-recovery.ts";
import {
  activeSessionTask,
  createSessionStore,
} from "../../src/cli/session-store.ts";

const [home, workspace, sessionId] = process.argv.slice(2);
if (home === undefined || workspace === undefined || sessionId === undefined) {
  throw new Error("missing accepted background recovery fixture argument");
}

let now = 1_700_000_000_000;
const runtime = {
  env: (key: string) => (key === "KEEL_HOME" ? home : undefined),
  now: () => now++,
};
const provider = {
  providerId: "deepseek" as const,
  model: "deepseek-v4-flash",
};
const usage = {
  inputTokens: 11,
  cachedInputTokens: 0,
  uncachedInputTokens: 11,
  outputTokens: 7,
};
let messages: readonly SessionMessage[] = [];
const session = createSessionStore({ sessionId, workspace, runtime });
const recovery = createSessionTaskRecovery({
  session: () => session,
  runtime,
  currentMessages: () => messages,
  onMessagesPersisted: (persisted) => {
    messages = persisted;
  },
});
recovery.admit({
  userMessage: {
    role: "user",
    content:
      "Start one background read-only subagent to inspect note.txt, then continue automatically.",
    origin: { type: "user_prompt" },
  },
  provider,
  consumedInputIds: [],
});
const lifecycle = recovery.providerLifecycle(provider);
lifecycle.providerRequestAttempts
  .begin()
  .finish({ outcome: "completed", usage });
const toolCall = {
  id: "delegate_background_accepted",
  tool: "delegate",
  profile: "explorer",
  mode: "background",
  task: "Inspect note.txt and report its exact content.",
} as const;
lifecycle.settled({
  assistantMessage: { role: "assistant", content: "", toolCalls: [toolCall] },
  usage,
  stopReason: "stop",
});
lifecycle.beforeToolCalls([toolCall]);
const activeTask = activeSessionTask(session);
if (activeTask?.phase !== "tool_execution") {
  throw new Error("background recovery fixture has no active tool execution");
}
const capability = resolveBuiltinSubagentProfile("explorer").snapshot;
createAgentTreeHistory({ sessionId, runtime }).persistence.accepted({
  delegationId: `${activeTask.runId}:${toolCall.id}`,
  childAgentId: "agent-11111111-1111-4111-8111-111111111111",
  childRunId: "subagent-11111111-1111-4111-8111-111111111111",
  parentRunId: activeTask.runId,
  parentToolCallId: toolCall.id,
  task: toolCall.task,
  focusPaths: [],
  mode: toolCall.mode,
  providerId: provider.providerId,
  model: provider.model,
  effort: null,
  systemPrompt: "Read-only child instructions.",
  threadCapabilityCeiling: capability,
  capability,
  workspace: null,
  lineage: { kind: "root" },
});

process.stdout.write("ready\n");
process.stdin.resume();
