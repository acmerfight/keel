import { isScalar, parseDocument } from "yaml";
import { z } from "zod";
import { errorMessage } from "../core/error.ts";
import type { SkillActivationPolicy } from "./model.ts";
import { WorkflowSkillError } from "./model.ts";

const skillNameSchema = z
  .string()
  .min(1)
  .max(64)
  .regex(
    /^[a-z0-9]+(?:-[a-z0-9]+)*$/u,
    "skill names may contain only lowercase letters, numbers, and hyphens, without leading, trailing, or consecutive hyphens",
  );

const skillFrontmatterSchema = z
  .object({
    name: skillNameSchema,
    description: z.string().trim().min(1).max(1024),
    license: z.string().trim().min(1).optional(),
    compatibility: z.string().trim().min(1).max(500).optional(),
    metadata: z.record(z.string(), z.string()).optional(),
    "allowed-tools": z.string().trim().min(1).optional(),
  })
  .strict();

export interface ParsedSkillDocument {
  readonly name: string;
  readonly description: string;
  readonly descriptionSource: string;
  readonly content: string;
  readonly activationPolicy: SkillActivationPolicy;
  readonly allowedTools?: string;
  readonly compatibility?: string;
  readonly license?: string;
}

export function validateSkillName(name: string): void {
  const result = skillNameSchema.safeParse(name);
  if (!result.success) {
    throw new WorkflowSkillError(`Error: ${result.error.issues[0]?.message}.`);
  }
}

function frontmatterBounds(
  skillFilePath: string,
  normalized: string,
): { readonly yaml: string; readonly content: string } {
  const lines = normalized.split("\n");
  if (lines[0] !== "---") {
    throw new WorkflowSkillError(
      `Error: workflow skill ${skillFilePath} must start with YAML frontmatter.`,
    );
  }
  const endIndex = lines.findIndex(
    (line, index) => index > 0 && line === "---",
  );
  if (endIndex === -1) {
    throw new WorkflowSkillError(
      `Error: workflow skill ${skillFilePath} has unterminated YAML frontmatter.`,
    );
  }
  return {
    yaml: lines.slice(1, endIndex).join("\n"),
    content: lines
      .slice(endIndex + 1)
      .join("\n")
      .trimEnd(),
  };
}

function frontmatterValue(
  skillFilePath: string,
  yaml: string,
): {
  readonly value: unknown;
  readonly descriptionSource: string;
} {
  const document = parseDocument(yaml, {
    schema: "core",
    strict: true,
    uniqueKeys: true,
  });
  const issue = document.errors[0] ?? document.warnings[0];
  if (issue !== undefined) {
    throw new WorkflowSkillError(
      `Error: workflow skill ${skillFilePath} has invalid YAML frontmatter: ${issue.message}.`,
    );
  }
  try {
    const descriptionNode = document.get("description", true);
    return {
      value: document.toJS({ maxAliasCount: 0 }),
      descriptionSource:
        isScalar(descriptionNode) && descriptionNode.range != null
          ? yaml.slice(descriptionNode.range[0], descriptionNode.range[1])
          : "",
    };
  } catch (error) {
    throw new WorkflowSkillError(
      `Error: workflow skill ${skillFilePath} has invalid YAML frontmatter: ${errorMessage(error)}.`,
    );
  }
}

function frontmatterErrorText(error: z.ZodError): string {
  return error.issues
    .map((issue) => {
      const path = issue.path.join(".");
      return path === "" ? issue.message : `${path}: ${issue.message}`;
    })
    .join("; ");
}

export function parseSkillDocument(
  skillFilePath: string,
  text: string,
): ParsedSkillDocument {
  const normalized = text.replaceAll("\r\n", "\n").replaceAll("\r", "\n");
  const bounds = frontmatterBounds(skillFilePath, normalized);
  const frontmatter = frontmatterValue(skillFilePath, bounds.yaml);
  const parsed = skillFrontmatterSchema.safeParse(frontmatter.value);
  if (!parsed.success) {
    throw new WorkflowSkillError(
      `Error: workflow skill ${skillFilePath} has invalid Agent Skills frontmatter: ${frontmatterErrorText(parsed.error)}.`,
    );
  }
  return {
    name: parsed.data.name,
    description: parsed.data.description,
    descriptionSource: frontmatter.descriptionSource,
    content: bounds.content,
    activationPolicy: parseActivationPolicy(parsed.data.metadata),
    ...(parsed.data["allowed-tools"] !== undefined
      ? { allowedTools: parsed.data["allowed-tools"] }
      : {}),
    ...(parsed.data.compatibility !== undefined
      ? { compatibility: parsed.data.compatibility }
      : {}),
    ...(parsed.data.license !== undefined
      ? { license: parsed.data.license }
      : {}),
  };
}

function parseActivationPolicy(
  metadata: Readonly<Record<string, string>> | undefined,
): SkillActivationPolicy {
  const value = metadata?.["keel.activation"];
  if (value === undefined || value === "implicit") {
    return "implicit";
  }
  if (value === "explicit") {
    return "explicit";
  }
  throw new WorkflowSkillError(
    'Error: workflow skill metadata.keel.activation must be "implicit" or "explicit".',
  );
}
