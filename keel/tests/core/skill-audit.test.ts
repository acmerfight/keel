import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { auditSkillPackage } from "../../src/skills/audit.ts";

describe("skill package audit", () => {
  test.each([
    0x2061, 0x2062, 0x2063, 0x2064,
  ])(`Given content contains zero-width format character U+%i,
    When the deterministic package audit scans it,
    Then the content is blocked as concealed instructions`, (codePoint) => {
    const findings = auditSkillPackage({
      skillDirectory: "/unused",
      skillRelativePath: ".agents/skills/review/SKILL.md",
      content: `Review${String.fromCodePoint(codePoint)}concealed`,
      resourcePaths: [],
      inventoryFindings: [],
    });

    expect(findings).toEqual([
      expect.objectContaining({
        severity: "blocker",
        code: "invisible_content",
      }),
    ]);
  });

  test(`Given the same deterministic finding is produced by inventory and content checks,
    When the package audit combines its phases,
    Then the user receives one stable finding`, async () => {
    const skillDirectory = await mkdtemp(
      join(tmpdir(), "keel-skill-audit-deduplicate-"),
    );
    const skillPath = ".agents/skills/review/SKILL.md";

    try {
      const findings = auditSkillPackage({
        skillDirectory,
        skillRelativePath: skillPath,
        content: `Credential: ghp_${"a".repeat(36)}`,
        resourcePaths: [],
        inventoryFindings: [
          {
            severity: "blocker",
            code: "embedded_secret",
            relativePath: skillPath,
            message: "duplicate inventory finding",
          },
        ],
      });

      expect(findings).toEqual([
        {
          severity: "blocker",
          code: "embedded_secret",
          relativePath: skillPath,
          message: "duplicate inventory finding",
        },
      ]);
    } finally {
      await rm(skillDirectory, { recursive: true, force: true });
    }
  });

  test(`Given an inventoried resource disappears before its bytes are audited,
    When the deterministic package audit reads it,
    Then the package fails closed with a content-free unreadable-resource finding`, async () => {
    const skillDirectory = await mkdtemp(
      join(tmpdir(), "keel-skill-audit-missing-resource-"),
    );

    try {
      const findings = auditSkillPackage({
        skillDirectory,
        skillRelativePath: ".agents/skills/review/SKILL.md",
        content: "Review the change.",
        resourcePaths: ["references/disappeared.md"],
        inventoryFindings: [],
      });

      expect(findings).toEqual([
        {
          severity: "blocker",
          code: "resource_unreadable",
          relativePath: "references/disappeared.md",
          message: "could not be read completely during deterministic audit",
        },
      ]);
    } finally {
      await rm(skillDirectory, { recursive: true, force: true });
    }
  });
});
