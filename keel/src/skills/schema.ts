import { parseDocument } from "yaml";
import { z } from "zod";
import { errorMessage } from "../core/error.ts";
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
  readonly content: string;
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

function frontmatterValue(skillFilePath: string, yaml: string): unknown {
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
    return document.toJS({ maxAliasCount: 0 });
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
  const parsed = skillFrontmatterSchema.safeParse(
    frontmatterValue(skillFilePath, bounds.yaml),
  );
  if (!parsed.success) {
    throw new WorkflowSkillError(
      `Error: workflow skill ${skillFilePath} has invalid Agent Skills frontmatter: ${frontmatterErrorText(parsed.error)}.`,
    );
  }
  return {
    name: parsed.data.name,
    description: parsed.data.description,
    content: bounds.content,
  };
}
