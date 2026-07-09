import { describe, expect, test } from "vitest";
import {
  createEvalDir,
  createTask,
  FIX_NOTE_TASK,
  join,
  REPORT_CONTENT_ENV,
  readResultLines,
  rm,
  runEvalCommand,
  VALID_REPORT,
  writeFile,
} from "./fixtures.ts";

describe("Eval Runner", () => {
  test.each([
    {
      name: "invalid JSON",
      reportContent: "{not-json",
    },
    {
      name: "wrong schema",
      reportContent: JSON.stringify({ schemaVersion: 1 }),
    },
    {
      name: "negative usage",
      reportContent: JSON.stringify({
        ...VALID_REPORT,
        usage: { ...VALID_REPORT.usage, outputTokens: -1 },
      }),
    },
    {
      name: "fractional usage",
      reportContent: JSON.stringify({
        ...VALID_REPORT,
        usage: { ...VALID_REPORT.usage, inputTokens: 1.5 },
      }),
    },
    {
      name: "negative cost",
      reportContent: JSON.stringify({
        ...VALID_REPORT,
        costUsd: -0.01,
      }),
    },
  ])(`Given the agent writes a $name report,
    When the eval runner reads the report,
    Then it records a crashed result`, async ({ reportContent }) => {
    // Given
    const { root, suiteDir, outFile } = await createEvalDir();
    await createTask(suiteDir, "bad-report", FIX_NOTE_TASK);
    const cliEntry = join(root, "bad-report-cli.js");
    await writeFile(
      cliEntry,
      [
        "import { writeFileSync } from 'node:fs';",
        "const reportIndex = process.argv.indexOf('--report');",
        "writeFileSync(process.argv[reportIndex + 1], process.env.REPORT_CONTENT ?? '', 'utf8');",
      ].join("\n"),
      "utf8",
    );
    const previousReportContent = process.env[REPORT_CONTENT_ENV];
    process.env[REPORT_CONTENT_ENV] = reportContent;

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
      expect(await readResultLines(outFile)).toMatchObject([
        { taskId: "bad-report", pass: false, outcome: "crashed" },
      ]);
    } finally {
      if (previousReportContent === undefined) {
        delete process.env[REPORT_CONTENT_ENV];
      } else {
        process.env[REPORT_CONTENT_ENV] = previousReportContent;
      }
      await rm(root, { recursive: true, force: true });
    }
  });
});
