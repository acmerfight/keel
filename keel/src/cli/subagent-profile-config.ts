import { lstatSync, readFileSync, realpathSync } from "node:fs";
import { isAbsolute, join, relative, sep } from "node:path";
import { z } from "zod";
import {
  EXPLORER_MAX_TURNS,
  MAX_SUBAGENT_MCP_TOOLS,
  MAX_SUBAGENT_SKILLS,
  REVIEWER_MAX_TURNS,
  type RepoSubagentProfileName,
  SUBAGENT_DEADLINE_MS,
  SUBAGENT_MAX_FINAL_TEXT_CHARS,
  subagentBuiltinToolNames,
  subagentProfileIds,
} from "../agent/subagent-capability.ts";
import type { RepoSubagentProfileDefinition } from "../agent/subagent-profile.ts";
import { reasoningEfforts } from "../core/model-metadata.ts";
import { projectRoot } from "./project-root.ts";

const SUBAGENT_PROFILE_CONFIG_RELATIVE_PATH = join(".agents", "subagents.json");
const MAX_SUBAGENT_PROFILE_CONFIG_BYTES = 128 * 1024;
const MAX_REPO_SUBAGENT_PROFILES = 32;
const MAX_REPO_PROFILE_TURNS = Math.max(EXPLORER_MAX_TURNS, REVIEWER_MAX_TURNS);

const profileKeySchema = z.string().regex(/^[a-z][a-z0-9-]{0,31}$/u);
const profileToolsSchema = z
  .array(z.enum(subagentBuiltinToolNames))
  .min(1)
  .max(subagentBuiltinToolNames.length)
  .refine((tools) => new Set(tools).size === tools.length, {
    message: "tools must not contain duplicates",
  });
const qualifiedSkillNameSchema = z
  .string()
  .regex(
    /^(?:repo|user|system|extra):(?:(?:[a-f0-9]{12}):)?[a-z0-9]+(?:-[a-z0-9]+)*$/u,
  );
const profileSkillsSchema = z
  .array(qualifiedSkillNameSchema)
  .max(MAX_SUBAGENT_SKILLS)
  .refine((skills) => new Set(skills).size === skills.length, {
    message: "skills must not contain duplicates",
  });
const profileMcpSchema = z
  .array(
    z
      .object({
        server: z.string().trim().min(1).max(64),
        tool: z.string().trim().min(1).max(128),
      })
      .strict(),
  )
  .max(MAX_SUBAGENT_MCP_TOOLS)
  .refine(
    (tools) =>
      new Set(tools.map(({ server, tool }) => `${server}\u0000${tool}`))
        .size === tools.length,
    { message: "mcp tools must not contain duplicates" },
  );
const profileDefinitionSchema = z
  .object({
    base: z.enum(subagentProfileIds),
    model: z.string().trim().min(1).max(128).optional(),
    effort: z.enum(reasoningEfforts).optional(),
    tools: profileToolsSchema.optional(),
    skills: profileSkillsSchema.optional(),
    mcp: profileMcpSchema.optional(),
    maxTurns: z
      .number()
      .int()
      .positive()
      .max(MAX_REPO_PROFILE_TURNS)
      .optional(),
    deadlineMs: z
      .number()
      .int()
      .positive()
      .max(SUBAGENT_DEADLINE_MS)
      .optional(),
    maxResultChars: z
      .number()
      .int()
      .positive()
      .max(SUBAGENT_MAX_FINAL_TEXT_CHARS)
      .optional(),
  })
  .strict();
const subagentProfileConfigSchema = z
  .object({
    schemaVersion: z.literal(1),
    profiles: z
      .record(profileKeySchema, profileDefinitionSchema)
      .refine(
        (profiles) =>
          Object.keys(profiles).length <= MAX_REPO_SUBAGENT_PROFILES,
        {
          message: `cannot contain more than ${MAX_REPO_SUBAGENT_PROFILES} profiles`,
        },
      ),
  })
  .strict();

class SubagentProfileConfigError extends Error {}

function configError(message: string): never {
  throw new SubagentProfileConfigError(
    `Error: invalid ${SUBAGENT_PROFILE_CONFIG_RELATIVE_PATH}: ${message}`,
  );
}

function pathIsWithin(root: string, candidate: string): boolean {
  const fromRoot = relative(root, candidate);
  return (
    fromRoot === "" ||
    (!fromRoot.startsWith(`..${sep}`) &&
      fromRoot !== ".." &&
      !isAbsolute(fromRoot))
  );
}

function repoProfileName(key: string): RepoSubagentProfileName {
  return `repo:${key}`;
}

export function loadRepoSubagentProfiles(
  workspace: string,
): readonly RepoSubagentProfileDefinition[] {
  const root = projectRoot(workspace);
  const configPath = join(root, SUBAGENT_PROFILE_CONFIG_RELATIVE_PATH);
  const stat = lstatSync(configPath, { throwIfNoEntry: false });
  if (stat === undefined) return [];
  if (!stat.isFile() || stat.isSymbolicLink()) {
    return configError("must be a local regular file");
  }
  if (stat.size > MAX_SUBAGENT_PROFILE_CONFIG_BYTES) {
    return configError(
      `exceeds ${MAX_SUBAGENT_PROFILE_CONFIG_BYTES.toLocaleString("en-US")} bytes`,
    );
  }
  const realRoot = realpathSync(root);
  const realConfigPath = realpathSync(configPath);
  if (!pathIsWithin(realRoot, realConfigPath)) {
    return configError("must resolve inside the project root");
  }

  let parsedJson: unknown;
  try {
    parsedJson = JSON.parse(readFileSync(configPath, "utf8"));
  } catch (error) {
    return configError(
      error instanceof SyntaxError ? "contains invalid JSON" : String(error),
    );
  }
  const parsed = subagentProfileConfigSchema.safeParse(parsedJson);
  if (!parsed.success) {
    return configError(z.prettifyError(parsed.error));
  }
  return Object.entries(parsed.data.profiles).map(([key, definition]) => ({
    name: repoProfileName(key),
    base: definition.base,
    ...(definition.model !== undefined ? { model: definition.model } : {}),
    ...(definition.effort !== undefined ? { effort: definition.effort } : {}),
    ...(definition.tools !== undefined ? { tools: definition.tools } : {}),
    ...(definition.skills !== undefined ? { skills: definition.skills } : {}),
    ...(definition.mcp !== undefined ? { mcp: definition.mcp } : {}),
    ...(definition.maxTurns !== undefined
      ? { maxTurns: definition.maxTurns }
      : {}),
    ...(definition.deadlineMs !== undefined
      ? { deadlineMs: definition.deadlineMs }
      : {}),
    ...(definition.maxResultChars !== undefined
      ? { maxResultChars: definition.maxResultChars }
      : {}),
  }));
}
