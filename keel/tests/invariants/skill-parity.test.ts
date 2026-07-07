import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "vitest";

const codexSkillsRoot = "../.agents/skills";
const claudeSkillsRoot = "../.claude/skills";
const obsoleteReviewSections = [
  "Open Questions Or Assumptions",
  "Verification And Residual Risk",
];

interface SkillDocument {
  readonly path: string;
  readonly name: string;
  readonly description: string;
  readonly frontmatterKeys: readonly string[];
  readonly body: string;
}

function sortedDirectoryNames(path: string): readonly string[] {
  return readdirSync(path, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();
}

function pairedSkillNames(): readonly string[] {
  return [
    ...new Set([
      ...sortedDirectoryNames(codexSkillsRoot),
      ...sortedDirectoryNames(claudeSkillsRoot),
    ]),
  ].sort();
}

function parseFrontmatterLine(line: string): readonly [string, string] {
  const match = /^([a-z-]+):\s*(.*)$/.exec(line);
  if (match === null || match[1] === undefined || match[2] === undefined) {
    throw new Error(`Invalid skill frontmatter line: ${line}`);
  }
  return [match[1], match[2]];
}

function requiredFrontmatterValue(
  path: string,
  values: Map<string, string>,
  key: string,
): string {
  const value = values.get(key);
  if (value === undefined) {
    throw new Error(`${path} missing required frontmatter key: ${key}`);
  }
  return value;
}

function readSkill(path: string): SkillDocument {
  const text = readFileSync(path, "utf8").replaceAll("\r\n", "\n");
  const marker = "---\n";
  if (!text.startsWith(marker)) {
    throw new Error(`${path} missing frontmatter start marker`);
  }

  const endIndex = text.indexOf("\n---\n", marker.length);
  if (endIndex < 0) {
    throw new Error(`${path} missing frontmatter end marker`);
  }

  const values = new Map<string, string>();
  for (const line of text.slice(marker.length, endIndex).split("\n")) {
    const [key, value] = parseFrontmatterLine(line);
    values.set(key, value);
  }

  return {
    path,
    name: requiredFrontmatterValue(path, values, "name"),
    description: requiredFrontmatterValue(path, values, "description"),
    frontmatterKeys: [...values.keys()].sort(),
    body: text.slice(endIndex + "\n---\n".length),
  };
}

function pairedSkills(skillName: string): {
  readonly codex: SkillDocument;
  readonly claude: SkillDocument;
} {
  return {
    codex: readSkill(join(codexSkillsRoot, skillName, "SKILL.md")),
    claude: readSkill(join(claudeSkillsRoot, skillName, "SKILL.md")),
  };
}

function normalizeSkillText(text: string): string {
  // Allowed platform differences: Codex uses $skill syntax, Claude uses /skill
  // syntax, Codex may keep legacy /goal $slice invocation examples, and each
  // surface may name its conversation container as a thread or conversation.
  return text
    .replaceAll("\r\n", "\n")
    .replace(
      /\$(agent-research|code-review|merge-pr|modularization-review|next-slice|qa|slice)\b/g,
      "/$1",
    )
    .replaceAll("current thread", "current conversation")
    .replaceAll(", `/goal /slice #123`", "")
    .replaceAll("`/goal /slice #123`, ", "")
    .split("\n")
    .filter((line) => !isAllowedCodexGoalSliceLine(line))
    .join("\n")
    .trim();
}

function isAllowedCodexGoalSliceLine(line: string): boolean {
  const trimmed = line.trim();
  return trimmed === "- `/goal /slice #123`" || trimmed === "- `/goal /slice`";
}

describe("skill parity", () => {
  test(`Given Codex and Claude Code skill folders,
    When skill names are compared,
    Then every workflow exists on both surfaces`, () => {
    // Given / When
    const codexSkillNames = sortedDirectoryNames(codexSkillsRoot);
    const claudeSkillNames = sortedDirectoryNames(claudeSkillsRoot);

    // Then
    expect(codexSkillNames.length).toBeGreaterThan(0);
    expect(codexSkillNames).toEqual(claudeSkillNames);
  });

  test(`Given paired skill metadata,
    When frontmatter is inspected,
    Then only supported platform fields are used`, () => {
    for (const skillName of pairedSkillNames()) {
      // Given / When
      const { codex, claude } = pairedSkills(skillName);

      // Then
      expect(codex.name).toBe(skillName);
      expect(claude.name).toBe(skillName);
      expect(codex.frontmatterKeys, codex.path).toEqual([
        "description",
        "name",
      ]);
      expect(claude.frontmatterKeys, claude.path).toEqual([
        "argument-hint",
        "description",
        "name",
        "user-invocable",
      ]);
      const codexAgentsPath = join(codexSkillsRoot, skillName, "agents");
      if (existsSync(codexAgentsPath)) {
        expect(readdirSync(codexAgentsPath).sort()).toEqual(["openai.yaml"]);
      }
    }
  });

  test(`Given paired skill guidance,
    When platform invocation syntax is normalized,
    Then workflow semantics stay aligned`, () => {
    for (const skillName of pairedSkillNames()) {
      // Given / When
      const { codex, claude } = pairedSkills(skillName);

      // Then
      expect(
        normalizeSkillText(codex.description),
        `${skillName} description drift`,
      ).toBe(normalizeSkillText(claude.description));
      expect(normalizeSkillText(codex.body), `${skillName} body drift`).toBe(
        normalizeSkillText(claude.body),
      );
    }
  });

  test(`Given code-review output guidance,
    When skill parity is checked,
    Then obsolete review sections are not accepted on either surface`, () => {
    // Given
    const { codex, claude } = pairedSkills("code-review");
    const combinedGuidance = `${codex.body}\n${claude.body}`;

    // When / Then
    for (const section of obsoleteReviewSections) {
      expect(combinedGuidance).not.toContain(section);
    }
  });
});
