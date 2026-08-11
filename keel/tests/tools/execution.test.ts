import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  truncate,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import type { SessionMessage } from "../../src/agent/session-message.ts";
import { SubagentPersistenceError } from "../../src/agent/subagent-lifecycle.ts";
import {
  builtinSubagentProfileCatalog,
  resolveBuiltinSubagentProfile,
} from "../../src/agent/subagent-profile.ts";
import type { McpRuntime } from "../../src/mcp/runtime-types.ts";
import type { AgentControlCapability } from "../../src/tools/agent-control.ts";
import { createDelegationExecutor } from "../../src/tools/delegation.ts";
import {
  type ExecuteToolCallOptions,
  executeToolCall,
  type ToolExecution,
} from "../../src/tools/execution.ts";
import type { AgentMemoryToolContext } from "../../src/tools/memory.ts";
import type { ModelToolExposure } from "../../src/tools/registry.ts";

const unusedAgentMutationControl = {
  input: () => ({ ok: false, content: "unused" }),
  resume: async () => ({ ok: false, content: "unused" }),
} satisfies Pick<AgentControlCapability, "input" | "resume">;

const explorerCapability = resolveBuiltinSubagentProfile("explorer").snapshot;

const EDIT_FILE_SIZE_LIMIT_BYTES = 10 * 1024 * 1024;
const SHELL_ENV_KEY = "SHELL";
type Expect<T extends true> = T;
type Equal<TLeft, TRight> = [TLeft] extends [TRight]
  ? [TRight] extends [TLeft]
    ? true
    : false
  : false;
type FailedToolExecutionEffectKind = Extract<
  ToolExecution,
  { readonly ok: false }
>["effects"][number]["kind"];
type FailedToolExecutionEffectsAreRestricted = Expect<
  Equal<
    FailedToolExecutionEffectKind,
    | "delegation"
    | "external_tool_result"
    | "visible_project_instructions"
    | "session_goal"
  >
>;
const failedToolExecutionEffectsAreRestricted: FailedToolExecutionEffectsAreRestricted = true;
void failedToolExecutionEffectsAreRestricted;

function expectRecoverableToolFailure(
  result: Awaited<ReturnType<typeof executeToolCall>>,
  message: string,
): void {
  expect(result.ok).toBe(false);
  expect(result.content).toContain("Tool failed:");
  expect(result.content).toContain(message);
  expect(result.content).toContain("Recovery:");
}

describe("Tool Execution", () => {
  test(`Given a cancellable child reads text beyond its output window or binary bytes beyond the initial sample,
    When the abortable read implementation consumes the complete file,
    Then it preserves truncation metadata and rejects late binary content`, async () => {
    const workspace = await mkdtemp(join(tmpdir(), "keel-tool-read-only-"));
    await writeFile(
      join(workspace, "large.txt"),
      Buffer.from("line\n".repeat(20_000)),
    );
    await writeFile(
      join(workspace, "late-binary.txt"),
      Buffer.concat([Buffer.alloc(8_192, 0x61), Buffer.from([0, 0x62])]),
    );
    const base = {
      workspace,
      signal: new AbortController().signal,
      bash: { kind: "disabled" } as const,
      builtinToolAuthority: {
        kind: "auto",
        profile: "subagent",
        capability: explorerCapability,
      } as const,
    };

    try {
      const truncated = await executeToolCall({
        ...base,
        toolCall: { id: "large_read", tool: "read", path: "large.txt" },
      });
      const binary = await executeToolCall({
        ...base,
        toolCall: {
          id: "late_binary_read",
          tool: "read",
          path: "late-binary.txt",
        },
      });

      expect(truncated).toMatchObject({ ok: true, sourceTruncated: true });
      expect(truncated.effects).toEqual([
        expect.objectContaining({ kind: "read" }),
      ]);
      expectRecoverableToolFailure(binary, "binary file");
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  test(`Given read and ls are available to a cancellable read-only child,
    When cancellation arrives while filesystem work is in progress,
    Then both cooperative tools reject before scanning their full inputs`, async () => {
    const workspace = await mkdtemp(join(tmpdir(), "keel-tool-abort-"));
    const largeFile = join(workspace, "large.txt");
    const manyEntries = join(workspace, "many");
    await writeFile(largeFile, Buffer.alloc(8 * 1024 * 1024, 0x61));
    await mkdir(manyEntries);
    await Promise.all(
      Array.from({ length: 200 }, (_, index) =>
        writeFile(join(manyEntries, `entry-${index}.txt`), "entry\n"),
      ),
    );

    try {
      for (const toolCall of [
        { id: "abort_read", tool: "read", path: "large.txt" },
        { id: "abort_ls", tool: "ls", path: "many" },
      ] as const) {
        const controller = new AbortController();
        const cancellation = new Error(`cancel ${toolCall.tool}`);
        setTimeout(() => controller.abort(cancellation), 0);

        const rejection = expect(
          executeToolCall({
            workspace,
            toolCall,
            signal: controller.signal,
            bash: { kind: "disabled" },
            builtinToolAuthority: {
              kind: "auto",
              profile: "subagent",
              capability: explorerCapability,
            },
          }),
        ).rejects;
        if (toolCall.tool === "read") {
          await rejection.toMatchObject({
            name: "AbortError",
            code: "ABORT_ERR",
          });
        } else {
          await rejection.toBe(cancellation);
        }
        expect(controller.signal.reason).toBe(cancellation);
      }
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  test(`Given main delegation is disabled and a read-only child fabricates a write,
    When dispatcher authority checks both calls,
    Then both fail closed before either capability or filesystem mutation runs`, async () => {
    const workspace = await mkdtemp(join(tmpdir(), "keel-tool-delegation-"));
    let delegateCalled = false;

    try {
      const disabledDelegate = await executeToolCall({
        workspace,
        toolCall: {
          id: "forged_delegate",
          tool: "delegate",
          profile: "explorer",
          mode: "foreground",
          task: "Inspect the workspace.",
        },
        signal: new AbortController().signal,
        bash: { kind: "disabled" },
        builtinToolAuthority: { kind: "auto" },
        delegation: createDelegationExecutor(async () => {
          delegateCalled = true;
          return {
            delivery: "replayed",
            ok: true,
            content: "unexpected",
          };
        }),
      });
      const forgedWrite = await executeToolCall({
        workspace,
        toolCall: {
          id: "forged_write",
          tool: "write",
          path: "forbidden.txt",
          content: "must not exist",
        },
        signal: new AbortController().signal,
        bash: { kind: "disabled" },
        builtinToolAuthority: {
          kind: "auto",
          profile: "subagent",
          capability: explorerCapability,
        },
      });

      expect(disabledDelegate).toMatchObject({ ok: false, effects: [] });
      expect(disabledDelegate.content).toContain(
        "delegate is unavailable in the current tool authority context",
      );
      expect(forgedWrite).toMatchObject({ ok: false, effects: [] });
      expect(forgedWrite.content).toContain(
        "write is unavailable in the current tool authority context",
      );
      expect(delegateCalled).toBe(false);
      await expect(
        readFile(join(workspace, "forbidden.txt")),
      ).rejects.toThrow();
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  test(`Given a read-only child fabricates catalog and shell tool calls,
    When dispatcher authority checks each call,
    Then the specialized unavailable responses fail closed without invoking capabilities`, async () => {
    const base = {
      workspace: process.cwd(),
      signal: new AbortController().signal,
      bash: { kind: "disabled" } as const,
      builtinToolAuthority: {
        kind: "auto",
        profile: "subagent",
        capability: explorerCapability,
      } as const,
    };
    const results = await Promise.all([
      executeToolCall({
        ...base,
        toolCall: { id: "denied_bash", tool: "bash", command: "pwd" },
      }),
      executeToolCall({
        ...base,
        toolCall: {
          id: "denied_memory",
          tool: "memory_add",
          text: "remember this",
        },
      }),
      executeToolCall({
        ...base,
        toolCall: { id: "denied_skill", tool: "skill", name: "repo:qa" },
      }),
      executeToolCall({
        ...base,
        toolCall: {
          id: "denied_skill_search",
          tool: "skill_search",
          query: "qa",
        },
      }),
      executeToolCall({
        ...base,
        toolCall: {
          id: "denied_skill_resource",
          tool: "skill_resource",
          skill: "repo:qa",
          path: "references/checklist.md",
        },
      }),
      executeToolCall({
        ...base,
        toolCall: {
          id: "denied_mcp_search",
          tool: "mcp_search",
          query: "remote issue tracker",
        },
      }),
    ]);

    expect(results).toHaveLength(6);
    for (const result of results) {
      expect(result).toMatchObject({ ok: false, effects: [] });
      expect(result.content).toContain("Tool failed:");
    }
    expect(
      results
        .slice(1)
        .every((result) => result.content.includes("unavailable")),
    ).toBe(true);
  });

  test(`Given a delegation call reaches dispatcher without its host capability,
    When the execution layer evaluates it,
    Then it returns a recoverable unavailable result without side effects`, async () => {
    const base: Pick<ExecuteToolCallOptions, "workspace" | "signal" | "bash"> =
      {
        workspace: process.cwd(),
        signal: new AbortController().signal,
        bash: { kind: "disabled" },
      };
    const delegate = await executeToolCall({
      ...base,
      toolCall: {
        id: "missing_delegate_capability",
        tool: "delegate",
        profile: "explorer",
        mode: "foreground",
        task: "Inspect the workspace.",
      },
    });
    expect(delegate).toMatchObject({ ok: false, effects: [] });
    expect(delegate.content).toContain("delegate is unavailable");
  });

  test(`Given an enabled delegation is rejected, replayed, or settles fresh after root cancellation,
    When dispatcher receives each Supervisor result,
    Then rejection gives Main an actionable recovery, empty usage stays unattributed, and cancelled usage remains observable`, async () => {
    const authority: ModelToolExposure = {
      kind: "auto",
      delegation: {
        mode: "foreground",
        profileCatalog: builtinSubagentProfileCatalog,
      },
    };
    const base: Pick<
      ExecuteToolCallOptions,
      "workspace" | "bash" | "builtinToolAuthority" | "toolCall"
    > = {
      workspace: process.cwd(),
      bash: { kind: "disabled" },
      builtinToolAuthority: authority,
      toolCall: {
        id: "delegate_result",
        tool: "delegate",
        profile: "explorer",
        mode: "foreground",
        task: "Inspect the workspace.",
      },
    };
    const failed = await executeToolCall({
      ...base,
      signal: new AbortController().signal,
      delegation: createDelegationExecutor(async () => ({
        delivery: "rejected",
        ok: false,
        reason: "child failed",
        recovery: "Continue in Main without delegating.",
        maxResultChars: 6_000,
      })),
    });
    const noUsage = await executeToolCall({
      ...base,
      signal: new AbortController().signal,
      delegation: createDelegationExecutor(async () => ({
        delivery: "replayed",
        ok: true,
        content: "child completed",
      })),
    });
    const controller = new AbortController();
    const cancellation = new Error("cancel after child settlement");
    const cancelled = await executeToolCall({
      ...base,
      signal: controller.signal,
      delegation: createDelegationExecutor(async () => {
        controller.abort(cancellation);
        return {
          delivery: "fresh",
          ok: false,
          content: "child cancelled",
          usage: {
            inputTokens: 5,
            cachedInputTokens: 1,
            uncachedInputTokens: 4,
            outputTokens: 2,
          },
        };
      }),
    });

    expect(failed).toEqual({
      ok: false,
      content:
        "Tool failed: child failed\nRecovery: Continue in Main without delegating.",
      effects: [],
    });
    expect(noUsage).toEqual({
      ok: true,
      content: "child completed",
      effects: [],
    });
    expect(cancelled).toEqual({
      ok: false,
      content: "child cancelled",
      effects: [
        {
          kind: "delegation",
          usage: {
            inputTokens: 5,
            cachedInputTokens: 1,
            uncachedInputTokens: 4,
            outputTokens: 2,
          },
        },
      ],
    });
    expect(controller.signal.reason).toBe(cancellation);
  });

  test(`Given an accepted child can no longer persist its lifecycle,
    When delegation reaches the tool execution boundary,
    Then the failure terminates the session owner instead of becoming a recoverable tool result`, async () => {
    const failure = new SubagentPersistenceError("agent tree is unavailable");
    await expect(
      executeToolCall({
        workspace: process.cwd(),
        signal: new AbortController().signal,
        bash: { kind: "disabled" },
        builtinToolAuthority: {
          kind: "auto",
          delegation: {
            mode: "foreground",
            profileCatalog: builtinSubagentProfileCatalog,
          },
        },
        toolCall: {
          id: "delegate_persistence_failure",
          tool: "delegate",
          profile: "explorer",
          mode: "foreground",
          task: "Inspect the workspace.",
        },
        delegation: createDelegationExecutor(async () => {
          throw failure;
        }),
      }),
    ).rejects.toBe(failure);
  });

  test(`Given a saved-session agent control capability is exposed,
    When the model lists, waits for, cancels, steers, and resumes an attached child,
    Then dispatcher passes the typed stable ID and returns lifecycle facts without usage effects`, async () => {
    const observed: string[] = [];
    const signal = new AbortController().signal;
    const agentControl: AgentControlCapability = {
      ...unusedAgentMutationControl,
      list: (request) => {
        observed.push(`list:${request.maxResultChars}`);
        return { ok: true, content: "agent-a1 running" };
      },
      waitForSettlement: async () => {},
      wait: async (request) => {
        observed.push(`wait:${request.id}:${request.maxResultChars}`);
        expect(request.signal).toBe(signal);
        return { ok: true, content: "agent-a1 completed" };
      },
      cancel: async (request) => {
        observed.push(`cancel:${request.id}:${request.maxResultChars}`);
        expect(request.signal).toBe(signal);
        return { ok: true, content: "agent-a1 cancelled" };
      },
      input: (request) => {
        observed.push(`input:${request.id}:${request.message}`);
        return { ok: true, content: "input queued" };
      },
      resume: async (request) => {
        observed.push(
          `resume:${request.id}:${request.requestId}:${request.message}`,
        );
        return { ok: true, content: "agent-a1 resumed" };
      },
    };
    const base = {
      workspace: process.cwd(),
      signal,
      bash: { kind: "disabled" } as const,
      builtinToolAuthority: {
        kind: "auto",
        delegation: {
          mode: "background",
          profileCatalog: builtinSubagentProfileCatalog,
        },
        agentControl: true,
      } as const,
      agentControl,
      agentControlResultMaxChars: 1_234,
      admitAgentWaitResult: async () =>
        ({
          kind: "granted",
          maxResultChars: 1_234,
        }) as const,
    };

    const [listed, waited, cancelled, input, resumed] = await Promise.all([
      executeToolCall({
        ...base,
        toolCall: { id: "list", tool: "agent_list" },
      }),
      executeToolCall({
        ...base,
        toolCall: { id: "wait", tool: "agent_wait", agentId: "agent-a1" },
      }),
      executeToolCall({
        ...base,
        toolCall: {
          id: "cancel",
          tool: "agent_cancel",
          agentId: "agent-a1",
        },
      }),
      executeToolCall({
        ...base,
        toolCall: {
          id: "input",
          tool: "agent_input",
          agentId: "agent-a1",
          message: "Inspect callers.",
        },
      }),
      executeToolCall({
        ...base,
        toolCall: {
          id: "resume",
          tool: "agent_resume",
          agentId: "agent-a1",
          message: "Verify the fix.",
          skills: [],
        },
      }),
    ]);

    expect([listed, waited, cancelled, input, resumed]).toEqual([
      { ok: true, content: "agent-a1 running", effects: [] },
      { ok: true, content: "agent-a1 completed", effects: [] },
      { ok: true, content: "agent-a1 cancelled", effects: [] },
      { ok: true, content: "input queued", effects: [] },
      { ok: true, content: "agent-a1 resumed", effects: [] },
    ]);
    expect(observed).toHaveLength(5);
    expect(observed).toEqual(
      expect.arrayContaining([
        "list:1234",
        "wait:agent-a1:1234",
        "cancel:agent-a1:1234",
        "input:agent-a1:Inspect callers.",
        "resume:agent-a1:resume:Verify the fix.",
      ]),
    );

    const rejectedResumes = await Promise.all(
      (["mixed_tool_round", "budget_rejected"] as const).map((kind) =>
        executeToolCall({
          ...base,
          admitAgentWaitResult: async () => ({ kind }),
          toolCall: {
            id: `resume-${kind}`,
            tool: "agent_resume",
            agentId: "agent-a1",
            message: "Verify without consuming Main's continuation.",
            skills: [],
          },
        }),
      ),
    );
    expect(rejectedResumes).toMatchObject([
      { ok: false, content: expect.stringContaining("isolated") },
      {
        ok: false,
        content: expect.stringContaining("preserve a Main continuation"),
      },
    ]);
    expect(observed).toHaveLength(5);
  });

  test(`Given agent-control calls reach dispatch without a live saved-session capability,
    When list, wait, cancel, input, or resume is attempted,
    Then each call fails closed without fabricating lifecycle state`, async () => {
    const base = {
      workspace: process.cwd(),
      signal: new AbortController().signal,
      bash: { kind: "disabled" } as const,
    };
    const results = await Promise.all([
      executeToolCall({
        ...base,
        toolCall: { id: "list", tool: "agent_list" },
      }),
      executeToolCall({
        ...base,
        toolCall: { id: "wait", tool: "agent_wait", agentId: "agent-a1" },
      }),
      executeToolCall({
        ...base,
        toolCall: {
          id: "cancel",
          tool: "agent_cancel",
          agentId: "agent-a1",
        },
      }),
      executeToolCall({
        ...base,
        toolCall: {
          id: "input",
          tool: "agent_input",
          agentId: "agent-a1",
          message: "Inspect callers.",
        },
      }),
      executeToolCall({
        ...base,
        toolCall: {
          id: "resume",
          tool: "agent_resume",
          agentId: "agent-a1",
          message: "Verify the fix.",
          skills: [],
        },
      }),
    ]);

    for (const result of results) {
      expect(result).toEqual({
        ok: false,
        content: expect.stringContaining("Agent control is unavailable"),
        effects: [],
      });
    }
  });

  test(`Given delegation authority and a host capability are installed,
    When main delegates once,
    Then the fresh child usage is attributed exactly once`, async () => {
    const signal = new AbortController().signal;
    const delegated = await executeToolCall({
      workspace: process.cwd(),
      toolCall: {
        id: "delegate_once",
        tool: "delegate",
        profile: "explorer",
        mode: "foreground",
        task: "Inspect src/tools/delegation.ts.",
        focusPaths: ["src/tools/delegation.ts"],
      },
      signal,
      bash: { kind: "disabled" },
      builtinToolAuthority: {
        kind: "auto",
        delegation: {
          mode: "foreground",
          profileCatalog: builtinSubagentProfileCatalog,
        },
      },
      delegation: createDelegationExecutor(async (input) => ({
        delivery: "fresh",
        ok: true,
        content: `${input.task}:${input.focusPaths.join(",")}`,
        usage: {
          inputTokens: 10,
          cachedInputTokens: 2,
          uncachedInputTokens: 8,
          outputTokens: 3,
        },
      })),
    });
    expect(delegated).toEqual({
      ok: true,
      content: "Inspect src/tools/delegation.ts.:src/tools/delegation.ts",
      effects: [
        {
          kind: "delegation",
          usage: {
            inputTokens: 10,
            cachedInputTokens: 2,
            uncachedInputTokens: 8,
            outputTokens: 3,
          },
        },
      ],
    });
  });

  test(`Given an MCP search tool call is missing its required query,
    When the tool execution layer handles the invalid call,
    Then it returns a recoverable correction message for the next model turn`, async () => {
    // Given
    const workspace = await mkdtemp(join(tmpdir(), "keel-tool-mcp-search-"));

    try {
      // When
      const result = await executeToolCall({
        workspace,
        toolCall: {
          id: "mcp_search_1",
          tool: "mcp_search",
          invalidArguments: { server: "catalog", toolName: "ask_question" },
          validationError: "query: Required",
          recovery:
            "Provide a non-empty query describing the remote MCP capability. When known, include exact server and toolName string values; omit unknown filters instead of guessing.",
        },
        signal: new AbortController().signal,
        bash: { kind: "disabled" },
      });

      // Then
      expectRecoverableToolFailure(result, "mcp_search failed");
      expect(result.content).toContain("query: Required");
      expect(result.content).toContain("non-empty query");
      expect(result.effects).toEqual([]);
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  test(`Given a glob tool call has a recoverable input error,
    When the tool execution layer handles the call,
    Then it returns a tool failure message for the next model turn`, async () => {
    // Given
    const workspace = await mkdtemp(join(tmpdir(), "keel-tool-execution-"));

    try {
      // When
      const result = await executeToolCall({
        workspace,
        toolCall: {
          id: "glob_1",
          tool: "glob",
          pattern: "",
        },
        signal: new AbortController().signal,
        bash: { kind: "disabled" },
      });

      // Then
      expect(result.ok).toBe(false);
      expect(result.content).toContain("Tool failed:");
      expect(result.content).toContain("pattern is empty");
      expect(result.content).toContain("Recovery:");
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  test(`Given memory mutation tools are unavailable for the current run,
    When a provider still calls them,
    Then the execution layer returns recoverable failures without mutating memory`, async () => {
    // Given
    const workspace = await mkdtemp(join(tmpdir(), "keel-tool-memory-"));

    try {
      // When
      const addResult = await executeToolCall({
        workspace,
        toolCall: {
          id: "memory_add_1",
          tool: "memory_add",
          text: "release tags use a v prefix",
        },
        signal: new AbortController().signal,
        bash: { kind: "disabled" },
      });
      const forgetResult = await executeToolCall({
        workspace,
        toolCall: {
          id: "memory_forget_1",
          tool: "memory_forget",
          memoryId: "mem_release",
        },
        signal: new AbortController().signal,
        bash: { kind: "disabled" },
      });

      // Then
      expect(addResult.ok).toBe(false);
      expect(addResult.content).toContain(
        "memory_add failed: memory mutation is unavailable for this model step",
      );
      expect(forgetResult.ok).toBe(false);
      expect(forgetResult.content).toContain(
        "memory_forget failed: memory mutation is unavailable for this model step",
      );
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  test(`Given memory is enabled but no eligible current-user message exists,
    When the provider calls memory_add,
    Then the execution layer rejects the call before invoking the capability`, async () => {
    // Given
    const workspace = await mkdtemp(join(tmpdir(), "keel-tool-memory-"));
    let addCalls = 0;
    const memory: AgentMemoryToolContext = {
      proposal: null,
      capability: {
        list: () => [],
        add: () => {
          addCalls++;
          return { id: "mem_unexpected", scope: { kind: "project", id: "p" } };
        },
        forget: () => {
          throw new Error("forget should not run");
        },
      },
      currentUserMessage: () => null,
      claimSourceMutation: () => {
        throw new Error("claimSourceMutation should not run");
      },
    };

    try {
      // When
      const result = await executeToolCall({
        workspace,
        toolCall: {
          id: "memory_add_1",
          tool: "memory_add",
          text: "release tags use a v prefix",
        },
        signal: new AbortController().signal,
        bash: { kind: "disabled" },
        memory,
      });

      // Then
      expect(addCalls).toBe(0);
      expect(result.ok).toBe(false);
      expect(result.content).toContain(
        "no eligible current-user message authorizes memory mutation",
      );
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  test(`Given one current-user message authorizes one memory add,
    When the provider calls memory_add twice with the same source,
    Then the first call succeeds and the second call is rejected`, async () => {
    // Given
    const workspace = await mkdtemp(join(tmpdir(), "keel-tool-memory-"));
    const userMessage = "Remember that release tags use a v prefix.";
    const currentUserMessage = {
      role: "user" as const,
      content: userMessage,
      origin: { type: "user_prompt" as const },
    };
    const claimedMessages = new WeakSet<
      Extract<SessionMessage, { readonly role: "user" }>
    >();
    claimedMessages.add(currentUserMessage);
    let addCalls = 0;
    const memory: AgentMemoryToolContext = {
      proposal: null,
      capability: {
        list: () => [],
        add: (text, source) => {
          addCalls++;
          expect(text).toBe("release tags use a v prefix");
          expect(source).toBe(userMessage);
          return {
            id: "mem_release",
            scope: { kind: "project", id: "project_release" },
          };
        },
        forget: () => {
          throw new Error("forget should not run");
        },
      },
      currentUserMessage: () => currentUserMessage,
      claimSourceMutation: (message) => {
        if (claimedMessages.has(message)) return false;
        claimedMessages.add(message);
        return true;
      },
    };

    try {
      // When
      claimedMessages.delete(currentUserMessage);
      const first = await executeToolCall({
        workspace,
        toolCall: {
          id: "memory_add_1",
          tool: "memory_add",
          text: "release tags use a v prefix",
        },
        signal: new AbortController().signal,
        bash: { kind: "disabled" },
        memory,
      });
      const second = await executeToolCall({
        workspace,
        toolCall: {
          id: "memory_add_2",
          tool: "memory_add",
          text: "release tags use a v prefix",
        },
        signal: new AbortController().signal,
        bash: { kind: "disabled" },
        memory,
      });

      // Then
      expect(addCalls).toBe(1);
      expect(first).toEqual({
        content: "Saved project memory mem_release for project_release.",
        ok: true,
        effects: [
          {
            kind: "memory_operation",
            operation: {
              operation: "add",
              id: "mem_release",
              scope: { kind: "project", id: "project_release" },
              outcome: "saved",
            },
          },
        ],
      });
      expect(second.ok).toBe(false);
      expect(second.content).toContain(
        "this current-user source already authorized one memory mutation",
      );
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  test(`Given one current-user message unambiguously identifies a memory,
    When the provider calls memory_forget,
    Then the execution layer invokes the forget capability and returns an operation`, async () => {
    // Given
    const workspace = await mkdtemp(join(tmpdir(), "keel-tool-memory-"));
    const userMessage = "Forget the release tag prefix.";
    const currentUserMessage = {
      role: "user" as const,
      content: userMessage,
      origin: { type: "user_prompt" as const },
    };
    let forgetCalls = 0;
    const memory: AgentMemoryToolContext = {
      proposal: null,
      capability: {
        list: () => [
          { id: "mem_release", text: "The release tag prefix is v." },
          { id: "mem_notes", text: "Release notes remain chronological." },
        ],
        add: () => {
          throw new Error("add should not run");
        },
        forget: (id, source) => {
          forgetCalls++;
          expect(id).toBe("mem_release");
          expect(source).toBe(userMessage);
          return { id, scope: { kind: "project", id: "project_release" } };
        },
      },
      currentUserMessage: () => currentUserMessage,
      claimSourceMutation: () => true,
    };

    try {
      // When
      const result = await executeToolCall({
        workspace,
        toolCall: {
          id: "memory_forget_1",
          tool: "memory_forget",
          memoryId: "mem_release",
        },
        signal: new AbortController().signal,
        bash: { kind: "disabled" },
        memory,
      });

      // Then
      expect(forgetCalls).toBe(1);
      expect(result).toEqual({
        content: "Forgot project memory mem_release for project_release.",
        ok: true,
        effects: [
          {
            kind: "memory_operation",
            operation: {
              operation: "forget",
              id: "mem_release",
              scope: { kind: "project", id: "project_release" },
              outcome: "forgotten",
            },
          },
        ],
      });
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  test(`Given memory is enabled but no eligible current-user message exists,
    When the provider calls memory_forget,
    Then the execution layer rejects the call before invoking the capability`, async () => {
    // Given
    const workspace = await mkdtemp(join(tmpdir(), "keel-tool-memory-"));
    let forgetCalls = 0;
    const memory: AgentMemoryToolContext = {
      proposal: null,
      capability: {
        list: () => [
          { id: "mem_release", text: "The release tag prefix is v." },
        ],
        add: () => {
          throw new Error("add should not run");
        },
        forget: () => {
          forgetCalls++;
          return { id: "mem_release", scope: { kind: "project", id: "p" } };
        },
      },
      currentUserMessage: () => null,
      claimSourceMutation: () => {
        throw new Error("claimSourceMutation should not run");
      },
    };

    try {
      // When
      const result = await executeToolCall({
        workspace,
        toolCall: {
          id: "memory_forget_1",
          tool: "memory_forget",
          memoryId: "mem_release",
        },
        signal: new AbortController().signal,
        bash: { kind: "disabled" },
        memory,
      });

      // Then
      expect(forgetCalls).toBe(0);
      expect(result.ok).toBe(false);
      expect(result.content).toContain(
        "no eligible current-user message authorizes memory mutation",
      );
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  test(`Given one current-user message already authorized a memory add,
    When the provider next calls memory_forget with the same source,
    Then the execution layer rejects the second mutation`, async () => {
    // Given
    const workspace = await mkdtemp(join(tmpdir(), "keel-tool-memory-"));
    const userMessage = "Forget the release tag prefix.";
    const currentUserMessage = {
      role: "user" as const,
      content: userMessage,
      origin: { type: "user_prompt" as const },
    };
    let forgetCalls = 0;
    const memory: AgentMemoryToolContext = {
      proposal: null,
      capability: {
        list: () => [
          { id: "mem_release", text: "The release tag prefix is v." },
        ],
        add: () => {
          throw new Error("add should not run");
        },
        forget: () => {
          forgetCalls++;
          return {
            id: "mem_release",
            scope: { kind: "project", id: "project_release" },
          };
        },
      },
      currentUserMessage: () => currentUserMessage,
      claimSourceMutation: () => false,
    };

    try {
      // When
      const result = await executeToolCall({
        workspace,
        toolCall: {
          id: "memory_forget_1",
          tool: "memory_forget",
          memoryId: "mem_release",
        },
        signal: new AbortController().signal,
        bash: { kind: "disabled" },
        memory,
      });

      // Then
      expect(forgetCalls).toBe(0);
      expect(result.ok).toBe(false);
      expect(result.content).toContain(
        "this current-user source already authorized one memory mutation",
      );
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  test(`Given an ls tool call targets a file,
    When the tool execution layer handles the call,
    Then it returns a recoverable tool failure message for the next model turn`, async () => {
    // Given
    const workspace = await mkdtemp(join(tmpdir(), "keel-tool-execution-"));
    await writeFile(join(workspace, "note.txt"), "hello\n", "utf8");

    try {
      // When
      const result = await executeToolCall({
        workspace,
        toolCall: {
          id: "ls_1",
          tool: "ls",
          path: "note.txt",
        },
        signal: new AbortController().signal,
        bash: { kind: "disabled" },
      });

      // Then
      expect(result.ok).toBe(false);
      expect(result.content).toContain("Tool failed:");
      expect(result.content).toContain("not a directory");
      expect(result.content).toContain("Recovery:");
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  test(`Given an ls tool call lists the workspace with only a limit,
    When the tool execution layer handles the call,
    Then it executes the ls tool without serializing a path`, async () => {
    // Given
    const workspace = await mkdtemp(join(tmpdir(), "keel-tool-execution-"));
    await writeFile(join(workspace, "note.txt"), "hello\n", "utf8");

    try {
      // When
      const result = await executeToolCall({
        workspace,
        toolCall: {
          id: "ls_1",
          tool: "ls",
          limit: 1,
        },
        signal: new AbortController().signal,
        bash: { kind: "disabled" },
      });

      // Then
      expect(result).toEqual({
        ok: true,
        content: "note.txt",
        effects: [],
      });
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  test.skipIf(process.platform === "win32")(
    `Given an ls tool call hits an unreadable directory,
    When the tool execution layer handles the call,
    Then it returns recoverable output for the next model turn`,
    async () => {
      // Given
      const workspace = await mkdtemp(join(tmpdir(), "keel-tool-execution-"));
      const lockedPath = join(workspace, "locked");
      await mkdir(lockedPath);
      await chmod(lockedPath, 0);

      try {
        // When
        const result = await executeToolCall({
          workspace,
          toolCall: {
            id: "ls_1",
            tool: "ls",
            path: "locked",
          },
          signal: new AbortController().signal,
          bash: { kind: "disabled" },
        });

        // Then
        expectRecoverableToolFailure(result, "permission denied");
      } finally {
        await chmod(lockedPath, 0o700);
        await rm(workspace, { recursive: true, force: true });
      }
    },
  );

  test.skipIf(process.platform === "win32")(
    `Given a glob tool call hits a ripgrep filesystem failure,
    When the tool execution layer handles the call,
    Then it returns recoverable output for the next model turn`,
    async () => {
      // Given
      const workspace = await mkdtemp(join(tmpdir(), "keel-tool-execution-"));
      const lockedPath = join(workspace, "locked");
      await mkdir(lockedPath);
      await chmod(lockedPath, 0);

      try {
        // When
        const result = await executeToolCall({
          workspace,
          toolCall: {
            id: "glob_1",
            tool: "glob",
            pattern: "**/*.ts",
          },
          signal: new AbortController().signal,
          bash: { kind: "disabled" },
        });

        // Then
        expectRecoverableToolFailure(result, "ripgrep exited with code 2");
      } finally {
        await chmod(lockedPath, 0o700);
        await rm(workspace, { recursive: true, force: true });
      }
    },
  );

  test(`Given an edit tool call targets an oversized file,
    When the tool execution layer handles the call,
    Then it reports a recoverable tool failure instead of rethrowing`, async () => {
    // Given
    const workspace = await mkdtemp(join(tmpdir(), "keel-tool-execution-"));
    const filePath = join(workspace, "large.log");
    await writeFile(filePath, "");
    await truncate(filePath, EDIT_FILE_SIZE_LIMIT_BYTES + 1);

    try {
      // When
      const result = await executeToolCall({
        workspace,
        toolCall: {
          id: "edit_1",
          tool: "edit",
          path: "large.log",
          edits: [{ oldText: "old", newText: "new" }],
        },
        signal: new AbortController().signal,
        bash: { kind: "disabled" },
      });

      // Then
      expect(result.ok).toBe(false);
      expect(result.content).toContain("Tool failed:");
      expect(result.content).toContain("file is too large");
      expect(result.content).toContain("Recovery:");
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  test(`Given an edit tool call hits an unexpected filesystem error,
    When the tool execution layer handles the call,
    Then it returns recoverable output for the next model turn`, async () => {
    // Given
    const workspace = join(
      tmpdir(),
      `keel-tool-execution-missing-${crypto.randomUUID()}`,
    );

    // When
    const result = await executeToolCall({
      workspace,
      toolCall: {
        id: "edit_1",
        tool: "edit",
        path: "note.txt",
        edits: [{ oldText: "old", newText: "new" }],
      },
      signal: new AbortController().signal,
      bash: { kind: "disabled" },
    });

    // Then
    expectRecoverableToolFailure(result, "ENOENT");
  });

  test.skipIf(process.platform === "win32")(
    `Given read and edit hit unreadable files,
    When the tool execution layer handles the calls,
    Then each failure is returned to the model instead of thrown`,
    async () => {
      // Given
      const workspace = await mkdtemp(join(tmpdir(), "keel-tool-execution-"));
      const lockedPath = join(workspace, "locked.txt");
      await writeFile(lockedPath, "secret\n", "utf8");
      await chmod(lockedPath, 0);

      try {
        // When
        const readResult = await executeToolCall({
          workspace,
          toolCall: {
            id: "read_1",
            tool: "read",
            path: "locked.txt",
          },
          signal: new AbortController().signal,
          bash: { kind: "disabled" },
        });
        const editResult = await executeToolCall({
          workspace,
          toolCall: {
            id: "edit_1",
            tool: "edit",
            path: "locked.txt",
            edits: [{ oldText: "secret", newText: "public" }],
          },
          signal: new AbortController().signal,
          bash: { kind: "disabled" },
        });

        // Then
        expectRecoverableToolFailure(readResult, "permission denied");
        expectRecoverableToolFailure(editResult, "permission denied");
      } finally {
        await chmod(lockedPath, 0o600);
        await rm(workspace, { recursive: true, force: true });
      }
    },
  );

  test(`Given grep receives a pattern with a NUL byte,
    When the tool execution layer handles the call,
    Then it returns recoverable output for the next model turn`, async () => {
    // Given
    const workspace = await mkdtemp(join(tmpdir(), "keel-tool-execution-"));

    try {
      // When
      const result = await executeToolCall({
        workspace,
        toolCall: {
          id: "grep_1",
          tool: "grep",
          pattern: "a\u0000b",
        },
        signal: new AbortController().signal,
        bash: { kind: "disabled" },
      });

      // Then
      expectRecoverableToolFailure(result, "null bytes");
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  test(`Given bash cannot start the configured shell,
    When the tool execution layer handles the call,
    Then it preserves the tool-specific recovery guidance`, async () => {
    // Given
    const workspace = await mkdtemp(join(tmpdir(), "keel-tool-execution-"));
    const previousShell = process.env[SHELL_ENV_KEY];
    process.env[SHELL_ENV_KEY] = join(workspace, "missing-shell");

    try {
      // When
      const result = await executeToolCall({
        workspace,
        toolCall: {
          id: "bash_1",
          tool: "bash",
          command: "echo hi",
        },
        signal: new AbortController().signal,
        bash: { kind: "trusted" },
      });

      // Then
      expectRecoverableToolFailure(result, "could not start shell");
      expect(result.content).toContain(
        "Verify the workspace directory exists and is accessible, or use file tools instead.",
      );
    } finally {
      if (previousShell === undefined) {
        delete process.env[SHELL_ENV_KEY];
      } else {
        process.env[SHELL_ENV_KEY] = previousShell;
      }
      await rm(workspace, { recursive: true, force: true });
    }
  });

  test(`Given write receives invalid filesystem paths,
    When the tool execution layer handles the calls,
    Then each failure is returned to the model instead of thrown`, async () => {
    // Given
    const workspace = await mkdtemp(join(tmpdir(), "keel-tool-execution-"));
    const longName = `${"x".repeat(300)}.txt`;

    try {
      // When
      const longNameResult = await executeToolCall({
        workspace,
        toolCall: {
          id: "write_1",
          tool: "write",
          path: longName,
          content: "data",
        },
        signal: new AbortController().signal,
        bash: { kind: "disabled" },
      });
      const nulResult = await executeToolCall({
        workspace,
        toolCall: {
          id: "write_2",
          tool: "write",
          path: "bad\u0000name.txt",
          content: "data",
        },
        signal: new AbortController().signal,
        bash: { kind: "disabled" },
      });

      // Then
      expectRecoverableToolFailure(longNameResult, "ENAMETOOLONG");
      expectRecoverableToolFailure(nulResult, "null bytes");
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  test(`Given reviewed memory is bound to one saved current-user source,
    When the provider invents a quote and then submits two valid proposals,
    Then Runtime rejects the invented evidence and permits only the first valid proposal`, async () => {
    const workspace = await mkdtemp(join(tmpdir(), "keel-tool-memory-"));
    const currentUserMessage = {
      role: "user" as const,
      content: "Our release validation command is pnpm test:coverage.",
      origin: { type: "user_prompt" as const },
    };
    const claimed = new WeakSet<
      Extract<SessionMessage, { readonly role: "user" }>
    >();
    let proposalCalls = 0;
    let persistedSources = 0;
    const memory: AgentMemoryToolContext = {
      capability: {
        list: () => [],
        add: () => {
          throw new Error("add should not run");
        },
        forget: () => {
          throw new Error("forget should not run");
        },
      },
      proposal: {
        capability: {
          propose: async (proposal, source, review, signal) => {
            proposalCalls++;
            expect(proposal.sourceQuote).toBe("pnpm test:coverage");
            expect(source).toMatchObject({
              sessionId: "session_review",
              messageId: "msg_review",
              providerId: "fake",
              model: "fake",
            });
            expect(
              await review(
                {
                  candidateId: "cand_review",
                  scope: { kind: "project", id: "project_review" },
                  kind: proposal.kind,
                  statement: proposal.statement,
                  why: proposal.why,
                  sourceQuote: proposal.sourceQuote,
                  conflictMemoryIds: proposal.conflictMemoryIds,
                },
                signal,
              ),
            ).toEqual({ type: "approve" });
            return {
              candidateId: "cand_review",
              memoryId: "mem_review",
              scope: { kind: "project", id: "project_review" },
              outcome: "approved",
            };
          },
        },
        sourceFor: (message) =>
          message === currentUserMessage
            ? {
                sessionId: "session_review",
                messageId: "msg_review",
                providerId: "fake",
                model: "fake",
              }
            : undefined,
        persistSource: (message) => {
          expect(message).toBe(currentUserMessage);
          persistedSources++;
        },
        review: async () => ({ type: "approve" }),
      },
      currentUserMessage: () => currentUserMessage,
      claimSourceMutation: (message) => {
        if (claimed.has(message)) return false;
        claimed.add(message);
        return true;
      },
    };
    const proposal = {
      id: "memory_propose_1",
      tool: "memory_propose" as const,
      kind: "project_context" as const,
      statement: "Release validation uses pnpm test:coverage.",
      why: "Likely to be reused.",
      sourceQuote: "pnpm test:coverage",
      conflictMemoryIds: [],
    };

    try {
      const invented = await executeToolCall({
        workspace,
        toolCall: {
          ...proposal,
          id: "memory_propose_invented",
          sourceQuote: "pnpm deploy",
        },
        signal: new AbortController().signal,
        bash: { kind: "disabled" },
        memory,
      });
      const approved = await executeToolCall({
        workspace,
        toolCall: proposal,
        signal: new AbortController().signal,
        bash: { kind: "disabled" },
        memory,
      });
      const repeated = await executeToolCall({
        workspace,
        toolCall: { ...proposal, id: "memory_propose_2" },
        signal: new AbortController().signal,
        bash: { kind: "disabled" },
        memory,
      });

      expect(invented.ok).toBe(false);
      expect(invented.content).toContain(
        "sourceQuote must be one exact contiguous span",
      );
      expect(approved).toMatchObject({
        ok: true,
        effects: [
          {
            kind: "memory_operation",
            operation: {
              operation: "propose",
              candidateId: "cand_review",
              memoryId: "mem_review",
              outcome: "approved",
            },
          },
        ],
      });
      expect(repeated.ok).toBe(false);
      expect(repeated.content).toContain(
        "current-user source already authorized one memory mutation",
      );
      expect(proposalCalls).toBe(1);
      expect(persistedSources).toBe(1);
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  test(`Given reviewed memory is unavailable, ungrounded, rejected, or deferred,
    When memory_propose executes at each boundary,
    Then failures remain recoverable and inactive outcomes remain explicit`, async () => {
    const workspace = await mkdtemp(join(tmpdir(), "keel-tool-memory-"));
    const currentUserMessage = {
      role: "user" as const,
      content: "Our release validation command is pnpm test:coverage.",
      origin: { type: "user_prompt" as const },
    };
    const toolCall = {
      id: "memory_propose_boundary",
      tool: "memory_propose" as const,
      kind: "project_context" as const,
      statement: "Release validation uses pnpm test:coverage.",
      why: "Likely to be reused.",
      sourceQuote: "pnpm test:coverage",
      conflictMemoryIds: [],
    };
    const capability: AgentMemoryToolContext["capability"] = {
      list: () => [],
      add: () => {
        throw new Error("add should not run");
      },
      forget: () => {
        throw new Error("forget should not run");
      },
    };
    const source = {
      sessionId: "session_review",
      messageId: "msg_review",
      providerId: "fake" as const,
      model: "fake",
    };
    const contextForOutcome = (
      outcome: "rejected" | "pending",
    ): AgentMemoryToolContext => ({
      capability,
      proposal: {
        capability: {
          propose: async () => ({
            candidateId: `cand_${outcome}`,
            memoryId: null,
            scope: { kind: "project", id: "project_review" },
            outcome,
          }),
        },
        sourceFor: () => source,
        persistSource: () => {},
        review: async () => ({ type: "reject" }),
      },
      currentUserMessage: () => currentUserMessage,
      claimSourceMutation: () => true,
    });

    try {
      const missingContext = await executeToolCall({
        workspace,
        toolCall,
        signal: new AbortController().signal,
        bash: { kind: "disabled" },
      });
      const missingProposal = await executeToolCall({
        workspace,
        toolCall: { ...toolCall, id: "memory_propose_no_capability" },
        signal: new AbortController().signal,
        bash: { kind: "disabled" },
        memory: {
          capability,
          proposal: null,
          currentUserMessage: () => currentUserMessage,
          claimSourceMutation: () => true,
        },
      });
      const missingUser = await executeToolCall({
        workspace,
        toolCall: { ...toolCall, id: "memory_propose_no_user" },
        signal: new AbortController().signal,
        bash: { kind: "disabled" },
        memory: {
          ...contextForOutcome("pending"),
          currentUserMessage: () => null,
        },
      });
      const missingSource = await executeToolCall({
        workspace,
        toolCall: { ...toolCall, id: "memory_propose_no_source" },
        signal: new AbortController().signal,
        bash: { kind: "disabled" },
        memory: {
          capability,
          proposal: {
            capability: {
              propose: async () => ({
                candidateId: "cand_pending",
                memoryId: null,
                scope: { kind: "project", id: "project_review" },
                outcome: "pending",
              }),
            },
            sourceFor: () => undefined,
            persistSource: () => {},
            review: async () => ({ type: "reject" }),
          },
          currentUserMessage: () => currentUserMessage,
          claimSourceMutation: () => true,
        },
      });
      const rejected = await executeToolCall({
        workspace,
        toolCall: { ...toolCall, id: "memory_propose_rejected" },
        signal: new AbortController().signal,
        bash: { kind: "disabled" },
        memory: contextForOutcome("rejected"),
      });
      const pending = await executeToolCall({
        workspace,
        toolCall: { ...toolCall, id: "memory_propose_pending" },
        signal: new AbortController().signal,
        bash: { kind: "disabled" },
        memory: contextForOutcome("pending"),
      });

      for (const failure of [
        missingContext,
        missingProposal,
        missingUser,
        missingSource,
      ]) {
        expectRecoverableToolFailure(failure, "reviewed memory is unavailable");
      }
      expect(rejected).toMatchObject({
        ok: true,
        content: expect.stringContaining("Rejected project-memory candidate"),
        effects: [
          {
            kind: "memory_operation",
            operation: { outcome: "rejected", memoryId: null },
          },
        ],
      });
      expect(pending).toMatchObject({
        ok: true,
        content: expect.stringContaining("remains pending"),
        effects: [
          {
            kind: "memory_operation",
            operation: { outcome: "pending", memoryId: null },
          },
        ],
      });
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  test(`Given MCP control or dynamic tools are called without an active runtime,
    When the execution boundary routes their typed discriminants,
    Then both calls fail closed without attempting a fallback capability`, async () => {
    const workspace = process.cwd();
    const reference = {
      kind: "mcp" as const,
      serverId: "catalog",
      serverOrigin: "https://catalog.example",
      rawToolName: "search",
      configurationDigest: "a".repeat(64),
      catalogGeneration: `catalog:${"b".repeat(64)}`,
      descriptorDigest: "c".repeat(64),
    };

    const search = await executeToolCall({
      workspace,
      toolCall: { id: "search_1", tool: "mcp_search", query: "otters" },
      signal: new AbortController().signal,
      bash: { kind: "disabled" },
    });
    const dynamic = await executeToolCall({
      workspace,
      toolCall: {
        kind: "mcp",
        id: "remote_1",
        tool: "mcp__catalog__search",
        reference,
        arguments: { query: "otters" },
      },
      signal: new AbortController().signal,
      bash: { kind: "disabled" },
    });

    expect(search).toMatchObject({ ok: false });
    expect(search.content).toContain("no MCP servers are configured");
    expect(dynamic).toMatchObject({ ok: false });
    expect(dynamic.content).toContain("MCP runtime is unavailable");
  });

  test(`Given an active MCP runtime receives searches, resolved output, and an unresolved name,
    When the execution boundary delegates them,
    Then only identified output receives external provenance`, async () => {
    const searches: unknown[] = [];
    const mcp: McpRuntime = {
      prepareTurn: async () => {},
      exposureSnapshot: async () => ({
        snapshotId: "empty",
        catalogAvailable: true,
        tools: [],
      }),
      search: async (request) => {
        searches.push(request);
        return { ok: true, content: "activated" };
      },
      execute: async (toolCall) => {
        if (toolCall.kind === "mcp_unresolved") {
          return {
            identity: "unidentified",
            content: "unresolved MCP tool",
            ok: false,
          };
        }
        return {
          identity: "identified",
          content: "remote result",
          ok: true,
          sourceTruncated: true,
          artifact: {
            content: '{"result":"complete"}',
            previewContent: "remote result",
            sourceTruncated: false,
          },
          preserved: {
            origin: "external",
            trustedEvidence: false,
            serverId: toolCall.reference.serverId,
            rawToolName: toolCall.reference.rawToolName,
            value: { result: "complete" },
            valueBytes: 21,
            valueSha256: "d".repeat(64),
          },
        };
      },
      close: async () => {},
    };
    const workspace = process.cwd();
    const signal = new AbortController().signal;

    await executeToolCall({
      workspace,
      toolCall: { id: "search_sparse", tool: "mcp_search", query: "otters" },
      signal,
      bash: { kind: "disabled" },
      mcp,
    });
    await executeToolCall({
      workspace,
      toolCall: {
        id: "search_full",
        tool: "mcp_search",
        query: "otters",
        server: "catalog",
        toolName: "search",
        limit: 3,
        refresh: true,
      },
      signal,
      bash: { kind: "disabled" },
      mcp,
    });
    const dynamic = await executeToolCall({
      workspace,
      toolCall: {
        kind: "mcp",
        id: "remote_1",
        tool: "mcp__catalog__search",
        reference: {
          kind: "mcp",
          serverId: "catalog",
          serverOrigin: "https://catalog.example",
          rawToolName: "search",
          configurationDigest: "a".repeat(64),
          catalogGeneration: `catalog:${"b".repeat(64)}`,
          descriptorDigest: "c".repeat(64),
        },
        arguments: { query: "otters" },
      },
      signal,
      bash: { kind: "disabled" },
      mcp,
    });
    const unresolved = await executeToolCall({
      workspace,
      toolCall: {
        kind: "mcp_unresolved",
        id: "remote_stale",
        tool: "mcp__catalog__removed",
        arguments: { query: "otters" },
      },
      signal,
      bash: { kind: "disabled" },
      mcp,
    });

    expect(searches).toEqual([
      { query: "otters" },
      {
        query: "otters",
        server: "catalog",
        tool: "search",
        limit: 3,
        refresh: true,
      },
    ]);
    expect(dynamic).toMatchObject({
      ok: true,
      sourceTruncated: true,
      artifact: { content: '{"result":"complete"}' },
      effects: [{ kind: "external_tool_result" }],
    });
    expect(unresolved).toEqual({
      content: "unresolved MCP tool",
      ok: false,
      effects: [],
    });
  });

  test(`Given an MCP adapter throws implementation failure or cancellation,
    When dynamic execution normalizes the boundary,
    Then faults become recoverable while typed cancellation still propagates`, async () => {
    const baseRuntime: McpRuntime = {
      prepareTurn: async () => {},
      exposureSnapshot: async () => ({
        snapshotId: "empty",
        catalogAvailable: true,
        tools: [],
      }),
      search: async () => ({ ok: true, content: "unused" }),
      execute: async () => {
        throw new Error("adapter exploded");
      },
      close: async () => {},
    };
    const toolCall = {
      kind: "mcp" as const,
      id: "remote_failure",
      tool: "mcp__catalog__search",
      reference: {
        kind: "mcp" as const,
        serverId: "catalog",
        serverOrigin: "https://catalog.example",
        rawToolName: "search",
        configurationDigest: "a".repeat(64),
        catalogGeneration: `catalog:${"b".repeat(64)}`,
        descriptorDigest: "c".repeat(64),
      },
      arguments: { query: "otters" },
    };
    const failed = await executeToolCall({
      workspace: process.cwd(),
      toolCall,
      signal: new AbortController().signal,
      bash: { kind: "disabled" },
      mcp: baseRuntime,
    });
    const controller = new AbortController();
    const cancellation = new Error("cancelled");
    controller.abort(cancellation);

    expect(failed).toMatchObject({ ok: false });
    expect(failed.content).toContain("adapter exploded");
    await expect(
      executeToolCall({
        workspace: process.cwd(),
        toolCall,
        signal: controller.signal,
        bash: { kind: "disabled" },
        mcp: {
          ...baseRuntime,
          execute: async () => {
            throw cancellation;
          },
        },
      }),
    ).rejects.toBe(cancellation);
  });
});
