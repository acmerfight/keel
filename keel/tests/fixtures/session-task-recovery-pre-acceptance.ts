import type { SessionMessage } from "../../src/agent/session-message.ts";
import { createSessionTaskRecovery } from "../../src/cli/interactive-session/task-recovery.ts";
import { createSessionStore } from "../../src/cli/session-store.ts";

const [home, workspace, sessionId, mode] = process.argv.slice(2);
if (
  home === undefined ||
  workspace === undefined ||
  sessionId === undefined ||
  (mode !== "foreground" && mode !== "background")
) {
  throw new Error("missing pre-acceptance recovery fixture argument");
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
      "Use one read-only subagent to inspect note.txt, then report its exact content.",
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
  id: "delegate_pre_acceptance",
  tool: "delegate",
  profile: "explorer",
  mode,
  task: "Inspect note.txt and report its exact content.",
} as const;
lifecycle.settled({
  assistantMessage: { role: "assistant", content: "", toolCalls: [toolCall] },
  usage,
  stopReason: "stop",
});
lifecycle.beforeToolCalls([toolCall]);

process.stdout.write("ready\n");
process.stdin.resume();
