import {
  appendFile,
  mkdtemp,
  readdir,
  readFile,
  realpath,
  rm,
  truncate,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { runCliMain } from "../../../src/cli/index.ts";
import { acquireSessionLock } from "../../../src/cli/session-store.ts";
import { createRuntime } from "../../../src/testing/cli-runtime-fixtures.ts";
import {
  appendSessionRecordLine,
  snapshotSessionRecordLine,
  writeSessionLedger,
} from "../../../src/testing/session-ledger-fixtures.ts";

const REPAIRED_AT = Date.parse("2026-04-02T12:34:56.789Z");
const REPAIR_STAMP = "2026-04-02T12-34-56-789Z";

async function sessionFixture(sessionId = "repair-case") {
  const workspace = await mkdtemp(join(tmpdir(), "keel-repair-workspace-"));
  const home = await mkdtemp(join(tmpdir(), "keel-repair-home-"));
  const ledgerWorkspace = await realpath(workspace);
  await writeSessionLedger({
    home,
    id: sessionId,
    workspace: ledgerWorkspace,
    createdAt: "2026-04-02T00:00:00.000Z",
    records: [
      appendSessionRecordLine("2026-04-02T00:00:01.000Z", [
        {
          role: "user",
          content: "keep this state",
          origin: { type: "user_prompt" },
        },
        {
          role: "assistant",
          content: "State retained.",
          toolCalls: [],
        },
      ]),
    ],
  });
  return {
    workspace,
    home,
    sessionId,
    ledgerPath: join(home, "sessions", sessionId, "ledger.jsonl"),
  };
}

function repairRuntime(options: {
  readonly workspace: string;
  readonly home: string;
  readonly sessionId: string;
}) {
  return createRuntime(
    ["sessions", "repair", options.sessionId, "--truncate-incomplete-tail"],
    {
      cwd: options.workspace,
      env: { KEEL_HOME: options.home },
      now: () => REPAIRED_AT,
    },
  );
}

async function backupNames(home: string, sessionId: string) {
  return (await readdir(join(home, "sessions", sessionId))).filter((name) =>
    name.startsWith("ledger.backup-"),
  );
}

describe("Session ledger repair", () => {
  test(`Given the final JSON record is valid but lacks a newline,
    When repair is requested,
    Then the record is preserved and the command makes no backup`, async () => {
    const fixture = await sessionFixture();
    const complete = await readFile(fixture.ledgerPath);
    const unterminated = complete.subarray(0, -1);
    await writeFile(fixture.ledgerPath, unterminated);
    const run = repairRuntime(fixture);

    try {
      expect(await runCliMain(run.runtime)).toBe(0);
      expect(run.stderr()).toBe("");
      expect(run.stdout()).toBe(
        `Session "${fixture.sessionId}" has no incomplete JSONL tail. No changes were made.\n`,
      );
      expect(await readFile(fixture.ledgerPath)).toEqual(unterminated);
      expect(await backupNames(fixture.home, fixture.sessionId)).toEqual([]);
    } finally {
      await rm(fixture.workspace, { recursive: true, force: true });
      await rm(fixture.home, { recursive: true, force: true });
    }
  });

  test(`Given a valid header-only ledger lacks its final newline,
    When repair is requested,
    Then the complete header is preserved as an unchanged session`, async () => {
    const fixture = await sessionFixture("header-only");
    const ledger = await readFile(fixture.ledgerPath, "utf8");
    const headerEnd = ledger.indexOf("\n");
    expect(headerEnd).toBeGreaterThan(0);
    await writeFile(fixture.ledgerPath, ledger.slice(0, headerEnd), "utf8");
    const original = await readFile(fixture.ledgerPath);
    const run = repairRuntime(fixture);

    try {
      expect(await runCliMain(run.runtime)).toBe(0);
      expect(run.stderr()).toBe("");
      expect(run.stdout()).toBe(
        `Session "${fixture.sessionId}" has no incomplete JSONL tail. No changes were made.\n`,
      );
      expect(await readFile(fixture.ledgerPath)).toEqual(original);
      expect(await backupNames(fixture.home, fixture.sessionId)).toEqual([]);
    } finally {
      await rm(fixture.workspace, { recursive: true, force: true });
      await rm(fixture.home, { recursive: true, force: true });
    }
  });

  test.each([
    {
      name: "newline-terminated invalid record",
      corrupt: async (ledgerPath: string) => {
        await appendFile(ledgerPath, "{not-json}\n", "utf8");
      },
    },
    {
      name: "invalid middle record before a torn tail",
      corrupt: async (ledgerPath: string) => {
        await appendFile(ledgerPath, '{not-json}\n{"schemaVersion":', "utf8");
      },
    },
  ])(
    `Given a $name,
    When repair is requested,
    Then the command rejects it without changing or backing up the ledger`,
    async ({ corrupt }) => {
      const fixture = await sessionFixture();
      await corrupt(fixture.ledgerPath);
      const original = await readFile(fixture.ledgerPath);
      const run = repairRuntime(fixture);

      try {
        expect(await runCliMain(run.runtime)).toBe(1);
        expect(run.stdout()).toBe("");
        expect(run.stderr()).toContain("Error:");
        expect(await readFile(fixture.ledgerPath)).toEqual(original);
        expect(await backupNames(fixture.home, fixture.sessionId)).toEqual([]);
      } finally {
        await rm(fixture.workspace, { recursive: true, force: true });
        await rm(fixture.home, { recursive: true, force: true });
      }
    },
  );

  test(`Given the incomplete content includes the session header,
    When repair is requested,
    Then the command rejects it without inventing a retained prefix`, async () => {
    const fixture = await sessionFixture();
    await writeFile(fixture.ledgerPath, '{"schemaVersion":4,"type":"session"');
    const original = await readFile(fixture.ledgerPath);
    const run = repairRuntime(fixture);

    try {
      expect(await runCliMain(run.runtime)).toBe(1);
      expect(run.stdout()).toBe("");
      expect(run.stderr()).toContain(
        "includes an invalid or incomplete session header",
      );
      expect(await readFile(fixture.ledgerPath)).toEqual(original);
      expect(await backupNames(fixture.home, fixture.sessionId)).toEqual([]);
    } finally {
      await rm(fixture.workspace, { recursive: true, force: true });
      await rm(fixture.home, { recursive: true, force: true });
    }
  });

  test(`Given another Keel process holds the session lock,
    When repair is requested,
    Then the command fails before inspecting or changing the ledger`, async () => {
    const fixture = await sessionFixture();
    await appendFile(fixture.ledgerPath, '{"schemaVersion":', "utf8");
    const original = await readFile(fixture.ledgerPath);
    const lockRuntime = createRuntime([], {
      env: { KEEL_HOME: fixture.home },
      now: () => REPAIRED_AT,
    });
    const lock = acquireSessionLock({
      sessionId: fixture.sessionId,
      runtime: lockRuntime.runtime,
    });
    const run = repairRuntime(fixture);

    try {
      expect(await runCliMain(run.runtime)).toBe(1);
      expect(run.stderr()).toContain(
        `session "${fixture.sessionId}" is already active`,
      );
      expect(await readFile(fixture.ledgerPath)).toEqual(original);
      expect(await backupNames(fixture.home, fixture.sessionId)).toEqual([]);
    } finally {
      lock.release();
      await rm(fixture.workspace, { recursive: true, force: true });
      await rm(fixture.home, { recursive: true, force: true });
    }
  });

  test.each([
    {
      name: "backup path already exists",
      conflictName: `ledger.backup-${REPAIR_STAMP}.jsonl`,
      backupPathExists: true,
    },
    {
      name: "replacement path already exists",
      conflictName: `ledger.repair-${REPAIR_STAMP}.tmp`,
      backupPathExists: false,
    },
  ])(
    `Given the $name,
    When repair cannot prepare its atomic replacement,
    Then the original and the conflicting file remain unchanged`,
    async ({ conflictName, backupPathExists }) => {
      const fixture = await sessionFixture();
      await appendFile(fixture.ledgerPath, '{"schemaVersion":', "utf8");
      const original = await readFile(fixture.ledgerPath);
      const conflictPath = join(
        fixture.home,
        "sessions",
        fixture.sessionId,
        conflictName,
      );
      await writeFile(conflictPath, "sentinel", "utf8");
      const run = repairRuntime(fixture);

      try {
        expect(await runCliMain(run.runtime)).toBe(1);
        expect(run.stderr()).toContain("cannot repair session ledger");
        expect(await readFile(fixture.ledgerPath)).toEqual(original);
        expect(await readFile(conflictPath, "utf8")).toBe("sentinel");
        expect(await backupNames(fixture.home, fixture.sessionId)).toHaveLength(
          backupPathExists ? 1 : 0,
        );
        const backupPath = join(
          fixture.home,
          "sessions",
          fixture.sessionId,
          `ledger.backup-${REPAIR_STAMP}.jsonl`,
        );
        if (backupPathExists) {
          expect(await readFile(backupPath)).toEqual(Buffer.from("sentinel"));
        }
      } finally {
        await rm(fixture.workspace, { recursive: true, force: true });
        await rm(fixture.home, { recursive: true, force: true });
      }
    },
  );

  test(`Given an oversized ledger has a bounded current-schema snapshot before a torn tail,
    When repair is requested,
    Then validation and recovery retain the bounded snapshot resume path`, async () => {
    const fixture = await sessionFixture("oversized-repair");
    await truncate(fixture.ledgerPath, 32 * 1024 * 1024 + 1);
    await appendFile(
      fixture.ledgerPath,
      [
        "",
        snapshotSessionRecordLine(
          "2026-04-02T00:00:02.000Z",
          [
            {
              role: "user",
              content: "state from the bounded snapshot",
              origin: { type: "user_prompt" },
            },
            {
              role: "assistant",
              content: "Bounded snapshot restored.",
              toolCalls: [],
            },
          ],
          "Oversized repair",
        ),
        '{"schemaVersion":4,"type":"append"',
      ].join("\n"),
      "utf8",
    );
    const run = repairRuntime(fixture);

    try {
      expect(await runCliMain(run.runtime)).toBe(0);
      expect(run.stderr()).toBe("");
      expect(run.stdout()).toContain("Recovered session");

      const show = createRuntime(
        ["sessions", "show", fixture.sessionId, "--all"],
        {
          cwd: fixture.workspace,
          env: { KEEL_HOME: fixture.home },
        },
      );
      expect(await runCliMain(show.runtime)).toBe(0);
      expect(show.stderr()).toBe("");
      expect(show.stdout()).toContain("state from the bounded snapshot");
      expect(show.stdout()).toContain("Bounded snapshot restored.");
    } finally {
      await rm(fixture.workspace, { recursive: true, force: true });
      await rm(fixture.home, { recursive: true, force: true });
    }
  });
});
