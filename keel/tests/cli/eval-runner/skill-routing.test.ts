import { describe, expect, test, vi } from "vitest";
import {
  createEvalDir,
  createTask,
  join,
  readFile,
  readResultLines,
  rm,
  runEvalCommand,
  VALID_REPORT,
  writeFile,
} from "./fixtures.ts";

const TEST_ACTIVATIONS_ENV = "KEEL_EVAL_TEST_ACTIVATIONS";
const HOME_ENV = "HOME";
const KEEL_HOME_ENV = "KEEL_HOME";
const DEEPSEEK_API_KEY_ENV = "DEEPSEEK_API_KEY";

async function createSkillReportingCli(
  root: string,
  capturePath?: string,
): Promise<string> {
  const cliEntry = join(root, "skill-reporting-cli.mjs");
  await writeFile(
    cliEntry,
    [
      'import { existsSync, writeFileSync } from "node:fs";',
      'import { join } from "node:path";',
      `const baseReport = ${JSON.stringify(VALID_REPORT)};`,
      'const reportIndex = process.argv.indexOf("--report");',
      'const hasSkill = existsSync(join(process.cwd(), ".agents", "skills", "release-notes", "SKILL.md"));',
      'const configured = process.env.KEEL_EVAL_TEST_ACTIVATIONS ?? "";',
      'const names = configured === "auto" ? (hasSkill ? ["repo:release-notes"] : []) : configured.split(",").filter(Boolean);',
      'const report = { ...baseReport, turns: hasSkill ? 2 : 3, costUsd: hasSkill ? 0.002 : 0.003, skillActivations: names.map((name) => ({ name, relativePath: ".agents/skills/" + name.split(":").at(-1) + "/SKILL.md", trigger: "model_selected" })) };',
      'writeFileSync(process.argv[reportIndex + 1], JSON.stringify(report), "utf8");',
      ...(capturePath === undefined
        ? []
        : [
            `writeFileSync(${JSON.stringify(capturePath)}, JSON.stringify({ cwd: process.cwd(), argv: process.argv.slice(2), home: process.env.HOME, userProfile: process.env.USERPROFILE, keelHome: process.env.KEEL_HOME, systemRoots: process.env.KEEL_SYSTEM_SKILL_ROOTS, extraRoots: process.env.KEEL_EXTRA_SKILL_ROOTS, deepseekApiKey: process.env.DEEPSEEK_API_KEY }), "utf8");`,
          ]),
    ].join("\n"),
    "utf8",
  );
  return cliEntry;
}

function captureOutput(): {
  readonly stdout: () => string;
  readonly stderr: () => string;
  readonly restore: () => void;
} {
  let stdout = "";
  let stderr = "";
  const stdoutSpy = vi
    .spyOn(process.stdout, "write")
    .mockImplementation((chunk: string | Uint8Array) => {
      stdout += chunk.toString();
      return true;
    });
  const stderrSpy = vi
    .spyOn(process.stderr, "write")
    .mockImplementation((chunk: string | Uint8Array) => {
      stderr += chunk.toString();
      return true;
    });
  return {
    stdout: () => stdout,
    stderr: () => stderr,
    restore: () => {
      stdoutSpy.mockRestore();
      stderrSpy.mockRestore();
    },
  };
}

describe("Eval Runner Skill Routing", () => {
  test(`Given a natural task and private expected Skill activation,
    When the user runs the eval suite and the agent selects that Skill,
    Then the trial passes, routing metrics are visible, and no gold label enters the provider command or workspace path`, async () => {
    // Given
    const { root, suiteDir, outFile } = await createEvalDir();
    const capturePath = join(root, "capture.json");
    const transcriptDir = join(root, "transcripts");
    const cliEntry = await createSkillReportingCli(root, capturePath);
    const prompt =
      "Inspect the proposed change for correctness and summarize concrete defects.";
    await createTask(suiteDir, "route-positive-review", {
      prompt,
      verify: "exit 0\n",
      solution: "exit 0\n",
      skillRouting: { expectedActivations: ["repo:code-review"] },
    });
    const previous = process.env[TEST_ACTIVATIONS_ENV];
    const previousDeepseekApiKey = process.env[DEEPSEEK_API_KEY_ENV];
    process.env[TEST_ACTIVATIONS_ENV] = "repo:code-review";
    process.env[DEEPSEEK_API_KEY_ENV] = "must-not-reach-fake-provider";
    const output = captureOutput();

    try {
      // When
      const exitCode = await runEvalCommand({
        suiteDir,
        outFile,
        trials: 1,
        check: false,
        cliEntry,
        transcriptDir,
        resolveProviderSelection: () => ({
          providerId: "fake",
          model: "fake",
          environment: {},
        }),
      });

      // Then
      expect(exitCode).toBe(0);
      expect(output.stdout()).toContain(
        "skill routing: 1/1 exact; precision 100.0%; recall 100.0%",
      );
      expect(await readResultLines(outFile)).toMatchObject([
        {
          pass: true,
          outcome: "verified",
          skillRouting: {
            expectedActivations: ["repo:code-review"],
            actualActivations: ["repo:code-review"],
            exact: true,
          },
        },
      ]);
      const capture = JSON.parse(await readFile(capturePath, "utf8"));
      expect(capture.cwd).not.toContain("route-positive-review");
      expect(capture.argv).toContain(prompt);
      expect(JSON.stringify(capture.argv)).not.toContain("repo:code-review");
      const transcriptIndex = capture.argv.indexOf("--transcript");
      expect(transcriptIndex).toBeGreaterThanOrEqual(0);
      expect(capture.argv[transcriptIndex + 1]).not.toContain(
        "route-positive-review",
      );
      expect(capture.argv[transcriptIndex + 1]).not.toContain("code-review");
      expect(capture.home).not.toBe(process.env[HOME_ENV]);
      expect(capture.userProfile).toBe(capture.home);
      expect(capture.keelHome).not.toBe(process.env[KEEL_HOME_ENV]);
      expect(capture.systemRoots).toBe("");
      expect(capture.extraRoots).toBe("");
      expect(capture.deepseekApiKey).toBeUndefined();
    } finally {
      output.restore();
      if (previous === undefined) {
        delete process.env[TEST_ACTIVATIONS_ENV];
      } else {
        process.env[TEST_ACTIVATIONS_ENV] = previous;
      }
      if (previousDeepseekApiKey === undefined) {
        delete process.env[DEEPSEEK_API_KEY_ENV];
      } else {
        process.env[DEEPSEEK_API_KEY_ENV] = previousDeepseekApiKey;
      }
      await rm(root, { recursive: true, force: true });
    }
  });

  test(`Given the private routing gold expects one Skill,
    When the agent activates a different Skill,
    Then the trial fails separately from outcome verification and reports false-positive and false-negative routing`, async () => {
    // Given
    const { root, suiteDir, outFile } = await createEvalDir();
    const cliEntry = await createSkillReportingCli(root);
    await createTask(suiteDir, "route-wrong-skill", {
      prompt: "Find correctness defects in this change.",
      verify: "exit 0\n",
      solution: "exit 0\n",
      skillRouting: { expectedActivations: ["repo:code-review"] },
    });
    const previous = process.env[TEST_ACTIVATIONS_ENV];
    process.env[TEST_ACTIVATIONS_ENV] = "repo:qa";
    const output = captureOutput();

    try {
      // When
      const exitCode = await runEvalCommand({
        suiteDir,
        outFile,
        trials: 1,
        check: false,
        cliEntry,
      });

      // Then
      expect(exitCode).toBe(1);
      expect(output.stdout()).toContain(
        "skill routing: 0/1 exact; precision 0.0%; recall 0.0%",
      );
      expect(await readResultLines(outFile)).toMatchObject([
        {
          pass: false,
          outcome: "routing_failed",
          skillRouting: {
            truePositives: 0,
            falsePositives: 1,
            falseNegatives: 1,
            exact: false,
          },
        },
      ]);
    } finally {
      output.restore();
      if (previous === undefined) {
        delete process.env[TEST_ACTIVATIONS_ENV];
      } else {
        process.env[TEST_ACTIVATIONS_ENV] = previous;
      }
      await rm(root, { recursive: true, force: true });
    }
  });

  test(`Given a routing task embeds an explicit Skill invocation in its prompt,
    When the user checks the suite,
    Then the leaked answer is rejected before any provider run`, async () => {
    // Given
    const { root, suiteDir, outFile } = await createEvalDir();
    await createTask(suiteDir, "route-leaked-answer", {
      prompt: "Use $code-review to inspect this change.",
      verify: "exit 0\n",
      solution: "exit 0\n",
      skillRouting: { expectedActivations: ["repo:code-review"] },
    });
    const output = captureOutput();

    try {
      // When
      const exitCode = await runEvalCommand({
        suiteDir,
        outFile,
        trials: 1,
        check: true,
        cliEntry: join(root, "not-run.mjs"),
      });

      // Then
      expect(exitCode).toBe(1);
      expect(output.stderr()).toContain(
        'eval task "route-leaked-answer" leaks a Skill answer hint in prompt',
      );
    } finally {
      output.restore();
      await rm(root, { recursive: true, force: true });
    }
  });

  test(`Given a routing task names the privately expected package without invocation syntax,
    When the user checks the suite,
    Then the leaked package-name answer is rejected before provider spend`, async () => {
    // Given
    const { root, suiteDir, outFile } = await createEvalDir();
    await createTask(suiteDir, "route-leaked-package", {
      prompt: "Run code-review on this patch.",
      verify: "exit 0\n",
      solution: "exit 0\n",
      skillRouting: { expectedActivations: ["repo:code-review"] },
    });
    const output = captureOutput();

    try {
      // When
      const exitCode = await runEvalCommand({
        suiteDir,
        outFile,
        trials: 1,
        check: true,
        cliEntry: join(root, "not-run.mjs"),
      });

      // Then
      expect(exitCode).toBe(1);
      expect(output.stderr()).toContain(
        'eval task "route-leaked-package" leaks a Skill answer hint in prompt',
      );
    } finally {
      output.restore();
      await rm(root, { recursive: true, force: true });
    }
  });

  test(`Given matched with-Skill and without-Skill tasks use the same natural prompt,
    When the user runs both conditions,
    Then the suite reports task-success and efficiency deltas independently from routing correctness`, async () => {
    // Given
    const { root, suiteDir, outFile } = await createEvalDir();
    const cliEntry = await createSkillReportingCli(root);
    const prompt = "Create RELEASE_NOTES.md from changes.json.";
    const pair = { id: "release-notes", condition: "with_skill" } as const;
    await createTask(suiteDir, "route-release-notes-with", {
      prompt,
      files: {
        ".agents/skills/release-notes/SKILL.md": [
          "---",
          "name: release-notes",
          "description: Prepare repository release notes from structured change data.",
          "---",
          "Follow the repository release-note conventions.",
        ].join("\n"),
      },
      verify: "exit 0\n",
      solution: "exit 0\n",
      skillRouting: {
        expectedActivations: ["repo:release-notes"],
        pair,
      },
    });
    await createTask(suiteDir, "route-release-notes-without", {
      prompt,
      verify: "exit 0\n",
      solution: "exit 0\n",
      skillRouting: {
        expectedActivations: [],
        pair: { id: pair.id, condition: "without_skill" },
      },
    });
    const previous = process.env[TEST_ACTIVATIONS_ENV];
    process.env[TEST_ACTIVATIONS_ENV] = "auto";
    const output = captureOutput();

    try {
      // When
      const exitCode = await runEvalCommand({
        suiteDir,
        outFile,
        trials: 1,
        check: false,
        cliEntry,
      });

      // Then
      expect(exitCode).toBe(0);
      expect(output.stdout()).toContain(
        "skill value release-notes: task pass 1/1 (100.0%) -> 1/1 (100.0%) (+0.0pp)",
      );
      expect(output.stdout()).toContain("turns avg 3.0 -> 2.0 (-1.0)");
      expect(output.stdout()).toContain(
        "cost avg $0.003000 -> $0.002000 (-$0.001000)",
      );
    } finally {
      output.restore();
      if (previous === undefined) {
        delete process.env[TEST_ACTIVATIONS_ENV];
      } else {
        process.env[TEST_ACTIVATIONS_ENV] = previous;
      }
      await rm(root, { recursive: true, force: true });
    }
  });

  test(`Given a paired value eval changes a fixture outside the Skill package,
    When the user checks the suite,
    Then the runner rejects the confounded comparison`, async () => {
    // Given
    const { root, suiteDir, outFile } = await createEvalDir();
    const prompt = "Create RELEASE_NOTES.md from changes.json.";
    await createTask(suiteDir, "paired-with", {
      prompt,
      files: {
        ".agents/skills/release-notes/SKILL.md": "instructions\n",
        "changes.json": "[]\n",
      },
      verify: "exit 0\n",
      solution: "exit 0\n",
      skillRouting: {
        expectedActivations: ["repo:release-notes"],
        pair: { id: "confounded", condition: "with_skill" },
      },
    });
    await createTask(suiteDir, "paired-without", {
      prompt,
      files: { "changes.json": '[{"different":true}]\n' },
      verify: "exit 0\n",
      solution: "exit 0\n",
      skillRouting: {
        expectedActivations: [],
        pair: { id: "confounded", condition: "without_skill" },
      },
    });
    const output = captureOutput();

    try {
      // When
      const exitCode = await runEvalCommand({
        suiteDir,
        outFile,
        trials: 1,
        check: true,
        cliEntry: join(root, "not-run.mjs"),
      });

      // Then
      expect(exitCode).toBe(1);
      expect(output.stderr()).toContain(
        'eval Skill pair "confounded" must differ only by packages under workspace/.agents/skills',
      );
    } finally {
      output.restore();
      await rm(root, { recursive: true, force: true });
    }
  });

  test(`Given a value-eval pair has no matching without-Skill condition,
    When the user checks the suite,
    Then the runner rejects the incomplete pair`, async () => {
    // Given
    const { root, suiteDir, outFile } = await createEvalDir();
    await createTask(suiteDir, "paired-only", {
      prompt: "Create RELEASE_NOTES.md from changes.json.",
      verify: "exit 0\n",
      solution: "exit 0\n",
      skillRouting: {
        expectedActivations: ["repo:release-notes"],
        pair: { id: "incomplete", condition: "with_skill" },
      },
    });
    const output = captureOutput();

    try {
      // When
      const exitCode = await runEvalCommand({
        suiteDir,
        outFile,
        trials: 1,
        check: true,
        cliEntry: join(root, "not-run.mjs"),
      });

      // Then
      expect(exitCode).toBe(1);
      expect(output.stderr()).toContain(
        'eval Skill pair "incomplete" requires exactly one with_skill task and one without_skill task',
      );
    } finally {
      output.restore();
      await rm(root, { recursive: true, force: true });
    }
  });
});
