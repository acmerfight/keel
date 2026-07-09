import { describe, expect, test, vi } from "vitest";
import {
  CLI_ENTRY,
  createEvalDir,
  createTask,
  FIX_NOTE_TASK,
  join,
  mkdir,
  readFile,
  rm,
  runEvalCommand,
  VALID_REPORT,
  writeFile,
} from "./fixtures.ts";

describe("Eval Runner", () => {
  test(`Given the eval results output parent is a file,
    When the eval runner prepares the output file,
    Then it returns a clean output-path error without throwing a stack trace`, async () => {
    // Given
    const { root, suiteDir } = await createEvalDir();
    await createTask(suiteDir, "fix-note", FIX_NOTE_TASK);
    await writeFile(join(root, "blocked"), "not a directory\n", "utf8");
    let stderr = "";
    const writeStderr = vi
      .spyOn(process.stderr, "write")
      .mockImplementation((chunk: string | Uint8Array) => {
        stderr += chunk.toString();
        return true;
      });

    try {
      // When
      const exitCode = await runEvalCommand({
        suiteDir,
        outFile: join(root, "blocked", "results.jsonl"),
        trials: 1,
        check: false,
        cliEntry: CLI_ENTRY,
      });

      // Then
      expect(exitCode).toBe(1);
      expect(stderr).toContain("Error: cannot write eval results");
      expect(stderr).toContain("mkdir");
      expect(stderr).not.toContain("\n    at ");
    } finally {
      writeStderr.mockRestore();
      await rm(root, { recursive: true, force: true });
    }
  });

  test(`Given the eval results output path is a directory,
    When the eval runner prepares the output file,
    Then it fails before running a trial`, async () => {
    // Given
    const { root, suiteDir, outFile } = await createEvalDir();
    await createTask(suiteDir, "fix-note", FIX_NOTE_TASK);
    await mkdir(outFile);
    const markerPath = join(root, "agent-ran.txt");
    const cliEntry = join(root, "mark-run-cli.js");
    await writeFile(
      cliEntry,
      [
        "import { writeFileSync } from 'node:fs';",
        `writeFileSync(${JSON.stringify(markerPath)}, 'ran\\n', 'utf8');`,
      ].join("\n"),
      "utf8",
    );
    let stderr = "";
    const writeStderr = vi
      .spyOn(process.stderr, "write")
      .mockImplementation((chunk: string | Uint8Array) => {
        stderr += chunk.toString();
        return true;
      });

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
      expect(stderr).toContain("Error: cannot write eval results");
      expect(stderr).not.toContain("\n    at ");
      await expect(readFile(markerPath, "utf8")).rejects.toMatchObject({
        code: "ENOENT",
      });
    } finally {
      writeStderr.mockRestore();
      await rm(root, { recursive: true, force: true });
    }
  });

  test(`Given the eval output parent becomes a file after preflight,
    When the eval runner records a trial result,
    Then it returns a clean output-path error`, async () => {
    // Given
    const { root, suiteDir } = await createEvalDir();
    const outParent = join(root, "results");
    const outFile = join(outParent, "results.jsonl");
    await createTask(suiteDir, "output-parent-race", {
      ...FIX_NOTE_TASK,
      verify: "exit 0\n",
    });
    const cliEntry = join(root, "replace-output-parent-cli.js");
    const validReportJson = JSON.stringify(VALID_REPORT);
    await writeFile(
      cliEntry,
      [
        "import { rmSync, writeFileSync } from 'node:fs';",
        "const args = process.argv.slice(2);",
        "const reportIndex = args.indexOf('--report');",
        `writeFileSync(args[reportIndex + 1], ${JSON.stringify(validReportJson)}, 'utf8');`,
        `rmSync(${JSON.stringify(outParent)}, { recursive: true, force: true });`,
        `writeFileSync(${JSON.stringify(outParent)}, 'not a directory\\n', 'utf8');`,
      ].join("\n"),
      "utf8",
    );
    let stderr = "";
    const writeStderr = vi
      .spyOn(process.stderr, "write")
      .mockImplementation((chunk: string | Uint8Array) => {
        stderr += chunk.toString();
        return true;
      });

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
      expect(stderr).toContain("Error: cannot write eval results");
      expect(stderr).not.toContain("\n    at ");
    } finally {
      writeStderr.mockRestore();
      await rm(root, { recursive: true, force: true });
    }
  });

  test(`Given the eval output file becomes a directory after preflight,
    When the eval runner appends a trial result,
    Then it returns a clean output-path error`, async () => {
    // Given
    const { root, suiteDir, outFile } = await createEvalDir();
    await createTask(suiteDir, "output-file-race", {
      ...FIX_NOTE_TASK,
      verify: "exit 0\n",
    });
    const cliEntry = join(root, "replace-output-file-cli.js");
    const validReportJson = JSON.stringify(VALID_REPORT);
    await writeFile(
      cliEntry,
      [
        "import { mkdirSync, rmSync, writeFileSync } from 'node:fs';",
        "const args = process.argv.slice(2);",
        "const reportIndex = args.indexOf('--report');",
        `writeFileSync(args[reportIndex + 1], ${JSON.stringify(validReportJson)}, 'utf8');`,
        `rmSync(${JSON.stringify(outFile)}, { force: true });`,
        `mkdirSync(${JSON.stringify(outFile)});`,
      ].join("\n"),
      "utf8",
    );
    let stderr = "";
    const writeStderr = vi
      .spyOn(process.stderr, "write")
      .mockImplementation((chunk: string | Uint8Array) => {
        stderr += chunk.toString();
        return true;
      });

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
      expect(stderr).toContain("Error: cannot write eval results");
      expect(stderr).not.toContain("\n    at ");
    } finally {
      writeStderr.mockRestore();
      await rm(root, { recursive: true, force: true });
    }
  });

  test(`Given the eval transcript parent is a file,
    When the eval runner prepares transcript artifacts,
    Then it returns a clean transcript-path error without throwing a stack trace`, async () => {
    // Given
    const { root, suiteDir, outFile } = await createEvalDir();
    await createTask(suiteDir, "fix-note", FIX_NOTE_TASK);
    await writeFile(join(root, "blocked"), "not a directory\n", "utf8");
    let stderr = "";
    const writeStderr = vi
      .spyOn(process.stderr, "write")
      .mockImplementation((chunk: string | Uint8Array) => {
        stderr += chunk.toString();
        return true;
      });

    try {
      // When
      const exitCode = await runEvalCommand({
        suiteDir,
        outFile,
        trials: 1,
        transcriptDir: join(root, "blocked", "transcripts"),
        check: false,
        cliEntry: CLI_ENTRY,
      });

      // Then
      expect(exitCode).toBe(1);
      expect(stderr).toContain(
        "Error: cannot create eval transcript directory",
      );
      expect(stderr).toContain("ENOTDIR");
      expect(stderr).not.toContain("\n    at ");
      await expect(readFile(outFile, "utf8")).rejects.toMatchObject({
        code: "ENOENT",
      });
    } finally {
      writeStderr.mockRestore();
      await rm(root, { recursive: true, force: true });
    }
  });
});
