import { createInterface } from "node:readline/promises";
import type { CliArgs } from "./args.ts";
import { escapeTerminalText } from "./output.ts";
import {
  addProjectMemory,
  clearProjectMemory,
  forgetProjectMemory,
  listProjectMemory,
  ProjectMemoryError,
} from "./project-memory.ts";
import type { CliRuntime } from "./runtime.ts";

type MemoryCliArgs = Extract<CliArgs, { readonly command: "memory" }>;

const MEMORY_HELP = `Usage:
  keel memory add <durable-fact>
  keel memory list
  keel memory forget <id>
  keel memory clear [--yes]

Memory is saved only by these commands; saying “remember this” in chat does not save it.
Save small, durable project facts that are not cheaply derivable from the repository.
Memory is quoted low-authority context, not instructions or authorization, and current evidence wins conflicts.
Forget and clear provide logical removal, not physical deletion; audit events remain on disk.
Do not store credentials, secrets, or unnecessary sensitive personal data.
Use --no-memory on an agent run to skip memory discovery and injection.
`;

async function confirmClear(runtime: CliRuntime): Promise<boolean> {
  runtime.writeStderr(
    "Clear all active memory for this project? This is logical removal, not physical deletion. [y/N] ",
  );
  const input = createInterface({
    input: runtime.input,
    crlfDelay: Number.POSITIVE_INFINITY,
  });
  try {
    const answer = (await input.question("")).trim().toLowerCase();
    return answer === "y" || answer === "yes";
  } finally {
    input.close();
  }
}

export async function runMemoryCommand(
  cliArgs: MemoryCliArgs,
  runtime: CliRuntime,
): Promise<number> {
  try {
    if (cliArgs.mode === "help") {
      runtime.writeStdout(MEMORY_HELP);
      return 0;
    }
    if (cliArgs.mode === "add") {
      const saved = addProjectMemory(runtime, runtime.cwd(), cliArgs.text);
      runtime.writeStdout(
        `Saved project memory ${saved.entry.id} for ${saved.scope.id}.\n`,
      );
      return 0;
    }
    if (cliArgs.mode === "list") {
      const listed = listProjectMemory(runtime, runtime.cwd());
      if (listed.entries.length === 0) {
        runtime.writeStdout(
          `No active project memory for ${listed.scope.id}.\n`,
        );
        return 0;
      }
      runtime.writeStdout(
        [
          `Active project memory for ${listed.scope.id}:`,
          ...listed.entries.map(
            (entry) =>
              `${entry.id}\t${entry.createdAt}\t${entry.source}\t${escapeTerminalText(entry.text)}`,
          ),
          "",
        ].join("\n"),
      );
      return 0;
    }
    if (cliArgs.mode === "forget") {
      const scope = forgetProjectMemory(runtime, runtime.cwd(), cliArgs.id);
      runtime.writeStdout(
        `Forgot project memory ${cliArgs.id} for ${scope.id}. This removes it from the active view; its audit event remains on disk.\n`,
      );
      return 0;
    }

    if (!cliArgs.confirmed) {
      if (runtime.input.isTTY !== true) {
        runtime.writeStderr(
          "Error: memory clear requires an interactive confirmation or --yes in non-interactive use. Clear is logical removal, not physical deletion.\n",
        );
        return 1;
      }
      if (!(await confirmClear(runtime))) {
        runtime.writeStdout("Project memory unchanged.\n");
        return 0;
      }
    }
    const result = clearProjectMemory(runtime, runtime.cwd());
    runtime.writeStdout(
      `Cleared ${result.cleared} active project memory ${result.cleared === 1 ? "entry" : "entries"} for ${result.scope.id}. This is logical removal; audit events remain on disk.\n`,
    );
    return 0;
  } catch (error) {
    /* v8 ignore next -- unexpected errors belong to the shared top-level runtime boundary. */
    if (!(error instanceof ProjectMemoryError)) throw error;
    runtime.writeStderr(`${error.message}\n`);
    return 1;
  }
}
