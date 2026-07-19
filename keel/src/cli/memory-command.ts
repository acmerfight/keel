import { createInterface } from "node:readline/promises";
import type { CliArgs } from "./args.ts";
import {
  isMemoryCandidateCliArgs,
  runMemoryCandidateCommand,
} from "./memory-candidate-command.ts";
import { escapeTerminalText } from "./output.ts";
import {
  addProjectMemory,
  clearProjectMemory,
  forgetProjectMemory,
  listProjectMemory,
  type ProjectMemoryEntry,
  ProjectMemoryError,
  purgeAllProjectMemory,
  purgeProjectMemory,
  reviewProjectMemory,
  showProjectMemory,
  updateProjectMemory,
  verifyProjectMemory,
} from "./project-memory.ts";
import type { CliRuntime } from "./runtime.ts";

type MemoryCliArgs = Extract<CliArgs, { readonly command: "memory" }>;

const MEMORY_HELP = `Usage:
  keel memory add <durable-fact> [--review-after <timestamp>] [--expires-at <timestamp>]
  keel memory list [--all]
  keel memory show <id>
  keel memory update <id> <replacement> [--review-after <timestamp>] [--expires-at <timestamp>]
  keel memory review [--due]
  keel memory verify <id>
  keel memory forget <id>
  keel memory purge <id>
  keel memory clear [--purge] [--yes]
  keel memory candidates extract <completed-root-session-id> --max-cost <usd> [--provider <id>] [--model <id>] [--retry]
  keel memory candidates list
  keel memory candidates show <candidate-id>
  keel memory candidates edit <candidate-id> <replacement>
  keel memory candidates approve <candidate-id> [--keep | --supersede <memory-id>]
  keel memory candidates reject <candidate-id>
  keel memory candidates purge <candidate-id> [--purge-memory <memory-id>]
  keel memory candidates clear [--purge] [--purge-memories] [--yes]

Memory is saved by these commands, a direct unambiguous current-user “remember” request, or an explicitly approved proposal shown during a saved interactive TTY session.
Candidate extraction is off by default and runs only after an explicit extract command. It inspects bounded current-user evidence from one completed, persisted root session and creates inactive candidates.
During a saved interactive TTY session, the current model may propose one durable fact from an exact current-user quote. Keel records the candidate first and activates only the exact displayed candidate after a Runtime-owned y/n prompt. Conflicts, interruptions, and closed input stay pending for the existing candidate review CLI.
Review candidate sources, conflicts, sensitivity validation, provider usage, and cost before approving. Pending candidates expire after 30 days and are never injected into agent context.
Direct “forget” requests must identify one active entry unambiguously; use an ID when needed.
Save small, durable project facts that are not cheaply derivable from the repository.
Memory is quoted low-authority context, not instructions or authorization. Current repository, tests, Git, configuration, live APIs, project instructions, and current user requests win conflicts.
Update creates a new entry that explicitly supersedes the selected ID. Verify records current-user review and clears a due review-after marker.
Forget and ordinary clear provide logical removal, not physical deletion; audit payloads remain on disk. Purge and clear --purge remove payloads from addressable Keel-owned local memory, but cannot erase provider retention, exports, backups, filesystem snapshots, or storage-media remnants.
Do not store credentials, secrets, or unnecessary sensitive personal data.
Use --no-memory on an agent run to skip memory discovery and injection.
`;

function entryDetails(entry: ProjectMemoryEntry): readonly string[] {
  return [
    `id: ${entry.id}`,
    `status: ${entry.status}`,
    `created: ${entry.createdAt}`,
    `last verified: ${entry.lastVerifiedAt}`,
    `review after: ${entry.reviewAfter ?? "none"}`,
    `expires at: ${entry.expiresAt ?? "none"}`,
    `supersedes: ${entry.supersedes.length === 0 ? "none" : entry.supersedes.join(",")}`,
    `superseded by: ${entry.supersededBy ?? "none"}`,
    `source: ${entry.source.type}:${entry.source.channel}`,
    ...(entry.source.type === "user_approved"
      ? [`source candidate: ${entry.source.candidateId}`]
      : []),
    `text: ${escapeTerminalText(entry.text)}`,
  ];
}

function entryLine(entry: ProjectMemoryEntry): string {
  const relationships = [
    ...(entry.source.type === "user_approved"
      ? [`candidate=${entry.source.candidateId}`]
      : []),
    ...(entry.supersedes.length === 0
      ? []
      : [`supersedes=${entry.supersedes.join(",")}`]),
    ...(entry.supersededBy === null
      ? []
      : [`superseded-by=${entry.supersededBy}`]),
    ...(entry.reviewAfter === null
      ? []
      : [`review-after=${entry.reviewAfter}`]),
    ...(entry.expiresAt === null ? [] : [`expires-at=${entry.expiresAt}`]),
  ];
  const relationshipFields =
    relationships.length === 0 ? "" : `\t${relationships.join(";")}`;
  return `${entry.id}\t${entry.status}\t${entry.createdAt}\t${entry.source.type}:${entry.source.channel}${relationshipFields}\t${escapeTerminalText(entry.text)}`;
}

async function confirmClear(
  runtime: CliRuntime,
  purge: boolean,
): Promise<boolean> {
  runtime.writeStderr(
    purge
      ? "Purge all project-memory payloads from addressable Keel-owned local storage? This cannot erase provider retention, exports, backups, snapshots, or storage-media remnants. [y/N] "
      : "Clear all active memory for this project? This is logical removal, not physical deletion. [y/N] ",
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
    if (isMemoryCandidateCliArgs(cliArgs)) {
      return runMemoryCandidateCommand(cliArgs, runtime);
    }
    if (cliArgs.mode === "help") {
      runtime.writeStdout(MEMORY_HELP);
      return 0;
    }
    if (cliArgs.mode === "add") {
      const saved = addProjectMemory(
        runtime,
        runtime.cwd(),
        cliArgs.text,
        {
          type: "user_explicit",
          channel: "cli",
          evidence: `memory add ${cliArgs.text}`,
        },
        {
          reviewAfter: cliArgs.reviewAfter,
          expiresAt: cliArgs.expiresAt,
        },
      );
      runtime.writeStdout(
        `Saved project memory ${saved.entry.id} for ${saved.scope.id}.\n`,
      );
      return 0;
    }
    if (cliArgs.mode === "list") {
      const listed = listProjectMemory(runtime, runtime.cwd(), {
        all: cliArgs.all,
      });
      if (listed.entries.length === 0) {
        runtime.writeStdout(
          cliArgs.all
            ? `No project memory history for ${listed.scope.id}.\n`
            : `No active project memory for ${listed.scope.id}.\n`,
        );
        return 0;
      }
      runtime.writeStdout(
        [
          `${cliArgs.all ? "All" : "Active"} project memory for ${listed.scope.id}:`,
          ...listed.entries.map(entryLine),
          "",
        ].join("\n"),
      );
      return 0;
    }
    if (cliArgs.mode === "show") {
      const shown = showProjectMemory(runtime, runtime.cwd(), cliArgs.id);
      runtime.writeStdout(
        [
          `Project memory ${shown.entry.id} for ${shown.scope.id}:`,
          ...entryDetails(shown.entry),
          "",
        ].join("\n"),
      );
      return 0;
    }
    if (cliArgs.mode === "update") {
      const updated = updateProjectMemory(
        runtime,
        runtime.cwd(),
        cliArgs.id,
        cliArgs.text,
        {
          type: "user_explicit",
          channel: "cli",
          evidence: "memory update",
        },
        {
          reviewAfter: cliArgs.reviewAfter,
          expiresAt: cliArgs.expiresAt,
        },
      );
      runtime.writeStdout(
        `Updated project memory ${cliArgs.id} with ${updated.entry.id} for ${updated.scope.id}; the prior entry is superseded and remains auditable.\n`,
      );
      return 0;
    }
    if (cliArgs.mode === "review") {
      const review = reviewProjectMemory(runtime, runtime.cwd(), {
        due: cliArgs.due,
      });
      if (review.entries.length === 0) {
        runtime.writeStdout(
          `${cliArgs.due ? "No project memory is due for review" : "No reviewable project memory"} for ${review.scope.id}.\n`,
        );
        return 0;
      }
      runtime.writeStdout(
        [
          `${cliArgs.due ? "Project memory due for review" : "Reviewable project memory"} for ${review.scope.id}:`,
          ...review.entries.map(entryLine),
          "",
        ].join("\n"),
      );
      return 0;
    }
    if (cliArgs.mode === "verify") {
      const verified = verifyProjectMemory(runtime, runtime.cwd(), cliArgs.id, {
        type: "user_explicit",
        channel: "cli",
        evidence: `memory verify ${cliArgs.id}`,
      });
      runtime.writeStdout(
        `Verified project memory ${cliArgs.id} for ${verified.scope.id} at ${verified.verifiedAt}.\n`,
      );
      return 0;
    }
    if (cliArgs.mode === "forget") {
      const scope = forgetProjectMemory(runtime, runtime.cwd(), cliArgs.id, {
        type: "user_explicit",
        channel: "cli",
        evidence: `memory forget ${cliArgs.id}`,
      });
      runtime.writeStdout(
        `Forgot project memory ${cliArgs.id} for ${scope.id}. This removes it from the active view; its audit event remains on disk.\n`,
      );
      return 0;
    }
    if (cliArgs.mode === "purge") {
      const scope = purgeProjectMemory(runtime, runtime.cwd(), cliArgs.id, {
        type: "user_explicit",
        channel: "cli",
        evidence: "memory purge",
      });
      runtime.writeStdout(
        `Purged project memory ${cliArgs.id} for ${scope.id}: its payload was removed from addressable Keel-owned local memory. This does not erase provider retention, exports, backups, snapshots, or storage-media remnants.\n`,
      );
      return 0;
    }

    if (!cliArgs.confirmed) {
      if (runtime.input.isTTY !== true) {
        runtime.writeStderr(
          cliArgs.purge
            ? "Error: memory clear --purge requires an interactive confirmation or --yes in non-interactive use. Purge is limited to addressable Keel-owned local memory.\n"
            : "Error: memory clear requires an interactive confirmation or --yes in non-interactive use. Clear is logical removal, not physical deletion.\n",
        );
        return 1;
      }
      if (!(await confirmClear(runtime, cliArgs.purge))) {
        runtime.writeStdout("Project memory unchanged.\n");
        return 0;
      }
    }
    if (cliArgs.purge) {
      const result = purgeAllProjectMemory(runtime, runtime.cwd());
      runtime.writeStdout(
        `Purged all project memory for ${result.scope.id} (${result.purged} payload ${result.purged === 1 ? "entry" : "entries"}) from addressable Keel-owned local memory. This does not erase provider retention, exports, backups, snapshots, or storage-media remnants.\n`,
      );
      return 0;
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
