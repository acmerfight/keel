import { z } from "zod";

import {
  MAX_SUBAGENT_MCP_TOOLS,
  MAX_SUBAGENT_SKILLS,
  type SubagentMcpToolSelector,
  type SubagentProfileName,
  subagentProfileIds,
} from "../agent/subagent-capability.ts";
import type { AgentId } from "../agent/subagent-lifecycle.ts";
import {
  builtinSubagentProfileCatalog,
  type SubagentProfileCatalog,
} from "../agent/subagent-profile.ts";
import {
  DEFAULT_COMMAND_TIMEOUT_MS,
  MAX_COMMAND_TIMEOUT_MS,
} from "../core/command-timeout.ts";
import { SESSION_GOAL_STATUS_REASON_MAX_LENGTH } from "../core/session-goal.ts";
import { sessionTaskPlanSchema } from "../core/task-progress.ts";
import { optionalToolArgument } from "./tool-schema.ts";

const delegationModeDescription =
  "Run in the foreground by default, or as an attached background child in a saved interactive session.";

const repoSubagentProfilePattern = /^repo:[a-z][a-z0-9-]{0,31}$/u;
const qualifiedSkillNameSchema = z
  .string()
  .regex(
    /^(?:repo|user|system|extra):(?:(?:[a-f0-9]{12}):)?[a-z0-9]+(?:-[a-z0-9]+)*$/u,
  );
const subagentProfileNameSchema = z
  .string()
  .refine(
    (value): value is SubagentProfileName =>
      subagentProfileIds.some((profile) => profile === value) ||
      repoSubagentProfilePattern.test(value),
    { message: "must name a built-in or repo subagent profile" },
  );

const foregroundDelegationModes = ["foreground"] as const;
const delegationModes = ["foreground", "background"] as const;

function profileDescription(catalog: SubagentProfileCatalog): string {
  if (
    catalog.length === 2 &&
    catalog[0]?.name === "explorer" &&
    catalog[1]?.name === "reviewer"
  ) {
    return "Use explorer for codebase investigation or reviewer for evidence-based code review. Defaults to explorer.";
  }
  const choices = catalog
    .map((entry) => {
      const skills =
        entry.skills.length === 0
          ? "no Skills"
          : `Skills: ${entry.skills.join(", ")}`;
      const mcp =
        entry.mcp.length === 0
          ? "no MCP"
          : `MCP: ${entry.mcp.map(({ server, tool }) => `${server}/${tool}`).join(", ")}`;
      return `${entry.name} (${entry.base} base; ${skills}; ${mcp})`;
    })
    .join(", ");
  return `Select an exact governed child profile from this catalog: ${choices}. Defaults to explorer.`;
}

function catalogSkillNames(catalog: SubagentProfileCatalog): readonly string[] {
  return [...new Set(catalog.flatMap((entry) => entry.skills))].toSorted();
}

function mcpSelectorKey(selector: SubagentMcpToolSelector): string {
  return `${selector.server}\u0000${selector.tool}`;
}

const mcpToolSelectorSchema = z
  .object({
    server: z.string().trim().min(1).max(64),
    tool: z.string().trim().min(1).max(128),
  })
  .strict();

function delegateMcpSchema(catalog: SubagentProfileCatalog) {
  const available = new Map(
    catalog.flatMap((entry) =>
      entry.mcp.map(
        (selector) => [mcpSelectorKey(selector), selector] as const,
      ),
    ),
  );
  const description =
    available.size === 0
      ? "No child MCP tools are available; omit this field."
      : `Optional exact task-approved MCP tool lease: ${[...available.values()].map(({ server, tool }) => `${server}/${tool}`).join(", ")}.`;
  return z
    .array(
      mcpToolSelectorSchema.refine(
        (selector) => available.has(mcpSelectorKey(selector)),
        { message: "must name an MCP tool allowed by a child profile" },
      ),
    )
    .max(Math.min(MAX_SUBAGENT_MCP_TOOLS, available.size))
    .refine(
      (tools) => new Set(tools.map(mcpSelectorKey)).size === tools.length,
      { message: "mcp tools must not contain duplicates" },
    )
    .describe(description);
}

function delegateSkillsSchema(catalog: SubagentProfileCatalog) {
  const names = new Set(catalogSkillNames(catalog));
  const catalogDescription =
    names.size === 0
      ? "No child Skills are available; omit this field."
      : `Optional exact task-approved Skill lease. Every name must be allowed by the selected profile: ${[...names].join(", ")}.`;
  return z
    .array(
      z.string().refine((name) => names.has(name), {
        message: "must name a Skill allowed by a child profile",
      }),
    )
    .max(Math.min(MAX_SUBAGENT_SKILLS, names.size))
    .refine((skills) => new Set(skills).size === skills.length, {
      message: "skills must not contain duplicates",
    })
    .describe(catalogDescription);
}

function validateProfileSkillLease(
  catalog: SubagentProfileCatalog,
  input: {
    readonly profile?: SubagentProfileName | undefined;
    readonly skills?: readonly string[] | undefined;
  },
  context: z.RefinementCtx,
): void {
  const profileName = input.profile ?? "explorer";
  const profile = catalog.find((entry) => entry.name === profileName);
  const allowed = new Set(profile?.skills ?? []);
  if ((input.skills ?? []).every((skill) => allowed.has(skill))) return;
  context.addIssue({
    code: "custom",
    path: ["skills"],
    message: `skills must be allowed by selected profile ${JSON.stringify(profileName)}`,
  });
}

function validateProfileMcpLease(
  catalog: SubagentProfileCatalog,
  input: {
    readonly profile?: SubagentProfileName | undefined;
    readonly mcp?: readonly SubagentMcpToolSelector[] | undefined;
  },
  context: z.RefinementCtx,
): void {
  const profileName = input.profile ?? "explorer";
  const profile = catalog.find((entry) => entry.name === profileName);
  const allowed = new Set((profile?.mcp ?? []).map(mcpSelectorKey));
  if ((input.mcp ?? []).every((tool) => allowed.has(mcpSelectorKey(tool)))) {
    return;
  }
  context.addIssue({
    code: "custom",
    path: ["mcp"],
    message: `mcp tools must be allowed by selected profile ${JSON.stringify(profileName)}`,
  });
}

function validateProfileLeases(
  catalog: SubagentProfileCatalog,
  input: {
    readonly profile?: SubagentProfileName | undefined;
    readonly skills?: readonly string[] | undefined;
    readonly mcp?: readonly SubagentMcpToolSelector[] | undefined;
  },
  context: z.RefinementCtx,
): void {
  validateProfileSkillLease(catalog, input, context);
  validateProfileMcpLease(catalog, input, context);
}

function catalogProfileSchema(
  catalog: SubagentProfileCatalog,
): z.ZodType<SubagentProfileName> {
  const [first, ...remaining] = catalog;
  const names: [SubagentProfileName, ...SubagentProfileName[]] = [
    first.name,
    ...remaining.map((entry) => entry.name),
  ];
  return z.enum(names);
}

function delegateProviderSchema(
  profile: z.ZodType<SubagentProfileName>,
  catalogDescription: string,
  modes: readonly ["foreground", ...("foreground" | "background")[]],
  catalog: SubagentProfileCatalog,
) {
  return z
    .object({
      profile: optionalToolArgument(profile.describe(catalogDescription)),
      mode: optionalToolArgument(
        z
          .enum(modes)
          .describe(
            modes.length === 1
              ? "Run as a foreground child and return its result here."
              : delegationModeDescription,
          ),
      ),
      task: z
        .string()
        .trim()
        .min(1)
        .max(4_000)
        .describe(
          "Self-contained read-only investigation task with scope, expected output, and completion criteria.",
        ),
      focusPaths: optionalToolArgument(
        z
          .array(z.string().trim().min(1).max(500))
          .min(1)
          .max(20)
          .describe(
            "Optional workspace-relative files or directories that should receive most of the child agent's attention.",
          ),
      ),
      skills: optionalToolArgument(delegateSkillsSchema(catalog)),
      mcp: optionalToolArgument(delegateMcpSchema(catalog)),
    })
    .strict();
}

const delegatedSkillLeaseSchema = z
  .array(qualifiedSkillNameSchema)
  .max(MAX_SUBAGENT_SKILLS)
  .refine((skills) => new Set(skills).size === skills.length, {
    message: "skills must not contain duplicates",
  });
const delegatedMcpLeaseSchema = z
  .array(mcpToolSelectorSchema)
  .max(MAX_SUBAGENT_MCP_TOOLS)
  .refine((tools) => new Set(tools.map(mcpSelectorKey)).size === tools.length, {
    message: "mcp tools must not contain duplicates",
  });

export const delegateProviderArgumentsSchema = delegateProviderSchema(
  z.enum(["explorer", "reviewer"]),
  "Use explorer for codebase investigation or reviewer for evidence-based code review. Defaults to explorer.",
  ["foreground", "background"],
  builtinSubagentProfileCatalog,
);

export const delegateToolArgumentsSchema =
  delegateProviderArgumentsSchema.extend({
    profile: z.preprocess(
      (value) => (value === null ? undefined : value),
      subagentProfileNameSchema.default("explorer"),
    ),
    mode: z.preprocess(
      (value) => (value === null ? undefined : value),
      z
        .enum(["foreground", "background"])
        .default("foreground")
        .describe(delegationModeDescription),
    ),
    skills: z.preprocess(
      (value) => (value === null ? undefined : value),
      delegatedSkillLeaseSchema.optional(),
    ),
    mcp: z.preprocess(
      (value) => (value === null ? undefined : value),
      delegatedMcpLeaseSchema.optional(),
    ),
  });

export const foregroundDelegateProviderArgumentsSchema = delegateProviderSchema(
  z.enum(["explorer", "reviewer"]),
  "Use explorer for codebase investigation or reviewer for evidence-based code review. Defaults to explorer.",
  ["foreground"],
  builtinSubagentProfileCatalog,
);

export function delegateProviderArgumentsSchemaForCatalog(
  catalog: SubagentProfileCatalog,
  mode: "foreground" | "background",
) {
  return delegateProviderSchema(
    catalogProfileSchema(catalog),
    profileDescription(catalog),
    mode === "foreground" ? foregroundDelegationModes : delegationModes,
    catalog,
  ).superRefine((input, context) =>
    validateProfileLeases(catalog, input, context),
  );
}

export function delegateToolArgumentsSchemaForCatalog(
  catalog: SubagentProfileCatalog,
  mode: "foreground" | "background",
) {
  return delegateProviderSchema(
    catalogProfileSchema(catalog),
    profileDescription(catalog),
    mode === "foreground" ? foregroundDelegationModes : delegationModes,
    catalog,
  )
    .extend({
      profile: z.preprocess(
        (value) => (value === null ? undefined : value),
        catalogProfileSchema(catalog).default("explorer"),
      ),
      mode: z.preprocess(
        (value) => (value === null ? undefined : value),
        z
          .enum(
            mode === "foreground" ? foregroundDelegationModes : delegationModes,
          )
          .default("foreground")
          .describe(delegationModeDescription),
      ),
      skills: z.preprocess(
        (value) => (value === null ? undefined : value),
        delegateSkillsSchema(catalog).default([]),
      ),
      mcp: z.preprocess(
        (value) => (value === null ? undefined : value),
        delegateMcpSchema(catalog).default([]),
      ),
    })
    .superRefine((input, context) =>
      validateProfileLeases(catalog, input, context),
    );
}

export const agentListToolArgumentsSchema = z.object({}).strict();

const agentIdToolArgumentSchema: z.ZodType<AgentId> = z.templateLiteral([
  "agent-",
  z.string().regex(/^[a-f0-9-]+$/u),
]);

export const agentWaitToolArgumentsSchema = z
  .object({
    agentId: agentIdToolArgumentSchema.describe(
      "Stable agent ID returned by a background delegate call.",
    ),
  })
  .strict();

export const agentCancelToolArgumentsSchema = z
  .object({
    agentId: agentIdToolArgumentSchema.describe(
      "Stable agent ID returned by a background delegate call.",
    ),
  })
  .strict();

const agentMessageShape = {
  agentId: agentIdToolArgumentSchema.describe(
    "Stable agent ID returned by delegate or agent_list.",
  ),
  message: z
    .string()
    .trim()
    .min(1)
    .max(16_000)
    .describe("Follow-up instruction for the selected subagent thread."),
};

export const agentInputToolArgumentsSchema = z
  .object(agentMessageShape)
  .strict();

export const agentResumeToolArgumentsSchema = z
  .object({
    ...agentMessageShape,
    skills: optionalToolArgument(delegatedSkillLeaseSchema),
    mcp: optionalToolArgument(delegatedMcpLeaseSchema),
  })
  .strict();

export const skillToolArgumentsSchema = z
  .object({
    name: z
      .string()
      .describe("Exact project skill name from the available skills catalog."),
  })
  .strict();

export const skillSearchToolArgumentsSchema = z
  .object({
    query: z
      .string()
      .trim()
      .min(1)
      .max(200)
      .describe("Words describing the workflow skill to find."),
  })
  .strict();

export const mcpSearchToolArgumentsSchema = z
  .object({
    query: z
      .string()
      .trim()
      .min(1)
      .max(200)
      .describe("Words describing the remote MCP capability to find."),
    server: optionalToolArgument(
      z
        .string()
        .trim()
        .min(1)
        .max(64)
        .describe("Optional exact configured MCP server ID."),
    ),
    toolName: optionalToolArgument(
      z
        .string()
        .trim()
        .min(1)
        .max(128)
        .describe("Optional exact raw MCP tool name."),
    ),
    limit: optionalToolArgument(
      z
        .number()
        .int()
        .min(1)
        .max(10)
        .describe("Optional maximum matches to activate. Defaults to 5."),
    ),
    refresh: optionalToolArgument(
      z
        .boolean()
        .describe(
          "When true, refresh matching server catalogs before searching.",
        ),
    ),
  })
  .strict();

export const skillResourceToolArgumentsSchema = z
  .object({
    skill: z.string().describe("Exact qualified name of an active skill."),
    path: z
      .string()
      .describe(
        "Skill-relative resource path under references/, scripts/, or assets/.",
      ),
  })
  .strict();

export const memoryAddToolArgumentsSchema = z
  .object({
    text: z
      .string()
      .trim()
      .min(1)
      .describe(
        "One exact contiguous durable-claim span copied from the latest current-user message. Preserve meaningful punctuation; do not paraphrase, broaden, or infer it.",
      ),
  })
  .strict();

export const memoryForgetToolArgumentsSchema = z
  .object({
    memoryId: z
      .string()
      .describe(
        "Exact active project-memory ID selected from the current project memory block.",
      ),
  })
  .strict();

export const memoryProposeToolArgumentsSchema = z
  .object({
    kind: z.enum([
      "user_preference",
      "feedback",
      "project_context",
      "reference",
    ]),
    statement: z
      .string()
      .trim()
      .min(1)
      .max(1_000)
      .describe("One concise durable project-memory statement to review."),
    why: z
      .string()
      .trim()
      .min(1)
      .max(1_000)
      .describe("Why this statement is likely to help in a later session."),
    sourceQuote: z
      .string()
      .min(1)
      .max(2_000)
      .describe(
        "One exact contiguous quote copied from the latest current-user message that supports the proposed statement.",
      ),
    conflictMemoryIds: z
      .array(z.string())
      .max(8)
      .describe(
        "Every active project-memory ID that conflicts with this proposal; use an empty array when none conflict.",
      ),
  })
  .strict();

export const readToolArgumentsSchema = z
  .object({
    path: z.string().describe("Workspace-relative file path to read."),
    offset: optionalToolArgument(
      z
        .number()
        .int()
        .min(1)
        .describe("Optional 1-indexed line number to start reading from."),
    ),
    limit: optionalToolArgument(
      z
        .number()
        .int()
        .min(1)
        .describe("Optional maximum number of lines to read."),
    ),
  })
  .strict();

export const lsToolArgumentsSchema = z
  .object({
    path: optionalToolArgument(
      z
        .string()
        .describe(
          "Optional workspace-relative directory to list. Defaults to the workspace root.",
        ),
    ),
    limit: optionalToolArgument(
      z
        .number()
        .int()
        .min(1)
        .max(1000)
        .describe(
          "Optional maximum number of entries to return. Defaults to 200.",
        ),
    ),
  })
  .strict();

export const globToolArgumentsSchema = z
  .object({
    pattern: z
      .string()
      .describe(
        'Glob pattern for file paths, such as "**/*.test.ts" or "src/**/*.tsx".',
      ),
    path: optionalToolArgument(
      z
        .string()
        .describe(
          "Optional workspace-relative directory to search. Defaults to the whole workspace.",
        ),
    ),
  })
  .strict();

export const grepToolArgumentsSchema = z
  .object({
    pattern: z.string().describe("Literal text to search for."),
    path: optionalToolArgument(
      z
        .string()
        .describe(
          "Optional workspace-relative file or directory to search. Defaults to the whole workspace.",
        ),
    ),
  })
  .strict();

export const gitDiffToolArgumentsSchema = z
  .object({
    mode: optionalToolArgument(
      z
        .enum(["all", "unstaged", "staged"])
        .describe(
          "Which current git changes to inspect. Defaults to all, which includes unstaged, staged, and untracked changes. Do not combine with baseRef.",
        ),
    ),
    baseRef: optionalToolArgument(
      z
        .string()
        .describe(
          "Optional older/base Git ref to compare from, such as HEAD~1 or origin/main. Must be a single safe ref, not a range, option, blob spec, or shell string.",
        ),
    ),
    headRef: optionalToolArgument(
      z
        .string()
        .describe(
          "Optional newer/head Git ref to compare to when baseRef is set. Defaults to HEAD. Must be a single safe ref.",
        ),
    ),
    mergeBase: optionalToolArgument(
      z
        .boolean()
        .describe(
          "When true with baseRef, compare the merge base of baseRef and headRef to headRef, matching PR-style base...head diffs.",
        ),
    ),
    paths: optionalToolArgument(
      z
        .array(
          z
            .string()
            .describe(
              "Workspace-relative literal path filter. Absolute paths, '..', NUL bytes, and git pathspec magic are rejected.",
            ),
        )
        .min(1)
        .max(100)
        .describe(
          "Optional path filters to narrow the diff to specific workspace-relative files or directories.",
        ),
    ),
  })
  .strict();

export const gitStatusToolArgumentsSchema = z
  .object({
    paths: optionalToolArgument(
      z
        .array(
          z
            .string()
            .describe(
              "Workspace-relative literal path filter. Absolute paths, '..', NUL bytes, and git pathspec magic are rejected.",
            ),
        )
        .min(1)
        .max(100)
        .describe(
          "Optional path filters to narrow the status to specific workspace-relative files or directories.",
        ),
    ),
  })
  .strict();

const editReplacementArgumentsSchema = z
  .object({
    oldText: z
      .string()
      .describe(
        "Text to replace. Copy it from read output; by default it must identify one target.",
      ),
    newText: z.string().describe("Replacement text."),
    replaceAll: optionalToolArgument(
      z
        .boolean()
        .describe(
          "When true, replace every exact occurrence of oldText for this edit. Defaults to false, which requires oldText to identify one target.",
        ),
    ),
  })
  .strict()
  .describe("One targeted replacement inside the file.");

export const editToolArgumentsSchema = z
  .object({
    path: z.string().describe("Workspace-relative file path to edit."),
    edits: z
      .array(editReplacementArgumentsSchema)
      .describe(
        "One or more targeted replacements. Each oldText is matched against the original file content. Non-replaceAll edits must be unique and all matched regions must be non-overlapping.",
      ),
  })
  .strict();

export const writeToolArgumentsSchema = z
  .object({
    path: z.string().describe("Workspace-relative file path to create."),
    content: z.string().describe("Complete file content to write."),
  })
  .strict();

export const applyPatchToolArgumentsSchema = z
  .object({
    patch: z
      .string()
      .describe(
        "Full apply_patch text. Supports Add File, Update File, Delete File, Update File with Move to sections, and standard Git-style unified diffs for text file updates, additions, deletions, 100644/100755 regular file mode changes, renames, and copies.",
      ),
  })
  .strict();

export const bashToolArgumentsSchema = z
  .object({
    command: z.string().describe("Shell command to execute."),
    timeoutMs: optionalToolArgument(
      z
        .number()
        .int()
        .min(1)
        .max(MAX_COMMAND_TIMEOUT_MS)
        .describe(
          `Optional command timeout in milliseconds. Defaults to ${DEFAULT_COMMAND_TIMEOUT_MS}ms.`,
        ),
    ),
  })
  .strict();

export const updatePlanToolArgumentsSchema = z
  .object({
    plan: sessionTaskPlanSchema.describe(
      "The full replacement list of task steps and statuses. Pass an empty list to clear task progress.",
    ),
  })
  .strict();

export const updateGoalToolArgumentsSchema = z
  .object({
    status: z
      .enum(["completed", "blocked"])
      .describe(
        "Propose a lifecycle state for the active saved session goal. Use completed only when the completion gate passes. Use blocked only when progress is genuinely blocked.",
      ),
    reason: optionalToolArgument(
      z
        .string()
        .trim()
        .min(1)
        .max(SESSION_GOAL_STATUS_REASON_MAX_LENGTH)
        .describe(
          "Required when status is blocked. Concisely state the blocking condition. Omit for completed.",
        ),
    ),
  })
  .strict()
  .superRefine((args, ctx) => {
    if (args.status === "blocked" && args.reason === undefined) {
      ctx.addIssue({
        code: "custom",
        path: ["reason"],
        message: "reason is required when status is blocked",
      });
    }
    if (args.status === "completed" && args.reason !== undefined) {
      ctx.addIssue({
        code: "custom",
        path: ["reason"],
        message: "reason is only valid when status is blocked",
      });
    }
  });
