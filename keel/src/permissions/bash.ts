export type BashPolicy = "ask" | "deny" | "trusted";

// BashPolicy is the user-facing CLI vocabulary; BashMode is the internal state
// used to derive tool exposure and approval behavior.
export type BashMode = "disabled" | "ask" | "trusted";

type BashCommandRisk =
  | "workspace-read"
  | "project-verification"
  | "workspace-write"
  | "unknown-or-dangerous";

export type BashApprovalGrant =
  | {
      readonly type: "exact";
      readonly cwd: string;
      readonly command: string;
    }
  | {
      readonly type: "prefix";
      readonly cwd: string;
      readonly argvPrefix: readonly string[];
    };

export function bashModeFromPolicy(policy: BashPolicy): BashMode {
  return policy === "deny" ? "disabled" : policy;
}

export function bashModeExposesTool(mode: BashMode): boolean {
  return mode !== "disabled";
}

interface BashPermissionReviewRequest {
  readonly command: string;
  readonly cwd: string;
  readonly signal: AbortSignal;
}

interface BashCommandAssessment {
  readonly argv: readonly string[] | null;
  readonly risk: BashCommandRisk;
  readonly summary: string;
}

export interface BashPermissionRequest {
  readonly command: string;
  readonly cwd: string;
  readonly signal: AbortSignal;
  readonly assessment: BashCommandAssessment;
  readonly prefixApproval?: BashPermissionPrefixApproval;
}

interface BashPermissionPrefixApproval {
  readonly argvPrefix: readonly string[];
  readonly display: string;
  readonly promptLabel: "command family" | "this command";
}

export type BashPermissionDecision =
  | {
      readonly type: "allow";
      readonly scope: "once" | "session" | "session-prefix";
    }
  | {
      readonly type: "deny";
      readonly message: string;
    };

export interface BashPermissionPolicy {
  readonly review: (
    request: BashPermissionReviewRequest,
  ) => BashPermissionDecision | Promise<BashPermissionDecision>;
}

function sessionKey(request: BashPermissionReviewRequest): string {
  return JSON.stringify([request.cwd, request.command]);
}

interface PrefixApprovalRule {
  readonly cwd: string;
  readonly argvPrefix: readonly string[];
}

interface PrefixApprovalCandidate {
  readonly argvPrefix: readonly string[];
  readonly risk: BashCommandRisk;
  readonly trailing: "any" | "exact";
}

const SIMPLE_COMMAND_TOKEN_PATTERN = /^[A-Za-z0-9_./:@%+=,-]+$/u;

const PREFIX_APPROVAL_CANDIDATES: readonly PrefixApprovalCandidate[] = [
  {
    argvPrefix: ["pnpm", "vitest", "run"],
    risk: "project-verification",
    trailing: "exact",
  },
  {
    argvPrefix: ["pnpm", "test"],
    risk: "project-verification",
    trailing: "exact",
  },
  {
    argvPrefix: ["pnpm", "test:coverage"],
    risk: "project-verification",
    trailing: "exact",
  },
  {
    argvPrefix: ["pnpm", "typecheck"],
    risk: "project-verification",
    trailing: "exact",
  },
  {
    argvPrefix: ["pnpm", "lint"],
    risk: "project-verification",
    trailing: "exact",
  },
  {
    argvPrefix: ["pnpm", "build"],
    risk: "project-verification",
    trailing: "exact",
  },
  {
    argvPrefix: ["npm", "test"],
    risk: "project-verification",
    trailing: "exact",
  },
  { argvPrefix: ["git", "status"], risk: "workspace-read", trailing: "any" },
  // Do not add git diff without family-specific trailing argv validation:
  // --no-index, absolute paths, escaped paths, and external diff hooks can
  // reach outside the cwd-bound approval.
];

const WORKSPACE_WRITE_PREFIXES: readonly (readonly string[])[] = [
  ["pnpm", "lint:fix"],
  ["git", "add"],
  ["git", "commit"],
  ["git", "checkout"],
  ["git", "switch"],
  ["git", "reset"],
  ["git", "clean"],
  ["rm"],
  ["rmdir"],
  ["mv"],
  ["cp"],
  ["mkdir"],
  ["touch"],
];

const MUTATING_VERIFICATION_ARGUMENTS = [
  "--write",
  "--fix",
  "--apply",
  "--unsafe",
  "--update",
  "-u",
] as const;

const MUTATING_VERIFICATION_ARGUMENT_SET: ReadonlySet<string> = new Set(
  MUTATING_VERIFICATION_ARGUMENTS,
);

function parseSimpleCommandArgv(command: string): readonly string[] | null {
  const trimmed = command.trim();
  if (trimmed === "") {
    return null;
  }

  const tokens = trimmed.split(/[ \t]+/u);
  if (
    tokens.some((token) => !SIMPLE_COMMAND_TOKEN_PATTERN.test(token)) ||
    tokens.some((token) => token === "." || token === "..")
  ) {
    return null;
  }
  return tokens;
}

function argvStartsWith(
  argv: readonly string[],
  prefix: readonly string[],
): boolean {
  return (
    argv.length >= prefix.length &&
    prefix.every((token, index) => argv[index] === token)
  );
}

function argvMatchesPrefixCandidate(
  argv: readonly string[],
  candidate: PrefixApprovalCandidate,
): boolean {
  if (!argvStartsWith(argv, candidate.argvPrefix)) {
    return false;
  }
  return (
    candidate.trailing === "any" || argv.length === candidate.argvPrefix.length
  );
}

function matchingPrefixApprovalCandidate(
  assessment: BashCommandAssessment,
): PrefixApprovalCandidate | undefined {
  const argv = assessment.argv;
  if (argv === null) {
    return undefined;
  }

  return PREFIX_APPROVAL_CANDIDATES.find(
    (candidate) =>
      candidate.risk === assessment.risk &&
      argvMatchesPrefixCandidate(argv, candidate),
  );
}

function commandPrefixApproval(
  candidate: PrefixApprovalCandidate | undefined,
): BashPermissionPrefixApproval | undefined {
  if (candidate === undefined) {
    return undefined;
  }
  return {
    argvPrefix: candidate.argvPrefix,
    display: candidate.argvPrefix.join(" "),
    promptLabel:
      candidate.trailing === "any" ? "command family" : "this command",
  };
}

function isMutatingVerificationArgument(argument: string): boolean {
  if (MUTATING_VERIFICATION_ARGUMENT_SET.has(argument)) {
    return true;
  }

  if (
    MUTATING_VERIFICATION_ARGUMENTS.some((candidate) =>
      argument.startsWith(`${candidate}=`),
    )
  ) {
    return true;
  }

  return /^-[A-Za-z]+$/u.test(argument) && argument.slice(1).includes("u");
}

function hasMutatingVerificationArgument(argv: readonly string[]): boolean {
  return argv.some((argument) => isMutatingVerificationArgument(argument));
}

function assessParsedCommand(argv: readonly string[]): BashCommandAssessment {
  const prefixCandidate = PREFIX_APPROVAL_CANDIDATES.find((candidate) =>
    argvStartsWith(argv, candidate.argvPrefix),
  );
  if (
    prefixCandidate?.risk === "project-verification" &&
    hasMutatingVerificationArgument(argv)
  ) {
    return {
      argv,
      risk: "workspace-write",
      summary:
        "adds a mutating flag to a project verification command; approval is not a sandbox",
    };
  }

  const workspaceWritePrefix = WORKSPACE_WRITE_PREFIXES.find((prefix) =>
    argvStartsWith(argv, prefix),
  );
  if (workspaceWritePrefix !== undefined) {
    return {
      argv,
      risk: "workspace-write",
      summary:
        "may modify workspace files or repository state; approval is not a sandbox",
    };
  }

  if (prefixCandidate !== undefined) {
    if (prefixCandidate.risk === "workspace-read") {
      return {
        argv,
        risk: "workspace-read",
        summary:
          "expected to inspect workspace state without writing; approval is not a sandbox",
      };
    }
    return {
      argv,
      risk: "project-verification",
      summary:
        "runs project code or tooling and may write caches, coverage, or build output",
    };
  }

  return {
    argv,
    risk: "unknown-or-dangerous",
    summary:
      "not in Keel's conservative bash family allowlist; approve only if you trust this exact command",
  };
}

function assessBashCommand(command: string): BashCommandAssessment {
  const argv = parseSimpleCommandArgv(command);
  if (argv === null) {
    return {
      argv: null,
      risk: "unknown-or-dangerous",
      summary:
        "uses shell syntax Keel cannot safely classify; approve only if you trust this exact command",
    };
  }
  return assessParsedCommand(argv);
}

function prefixKey(rule: PrefixApprovalRule): string {
  return JSON.stringify([rule.cwd, rule.argvPrefix]);
}

export function createSessionBashPermissionPolicy(options: {
  readonly prompt: (
    request: BashPermissionRequest,
  ) => BashPermissionDecision | Promise<BashPermissionDecision>;
  readonly initialGrants?: readonly BashApprovalGrant[];
  readonly onGrant?: (grant: BashApprovalGrant) => void;
}): BashPermissionPolicy {
  const approved = new Set<string>();
  const approvedPrefixes = new Set<string>();
  for (const grant of options.initialGrants ?? []) {
    switch (grant.type) {
      case "exact":
        approved.add(JSON.stringify([grant.cwd, grant.command]));
        break;
      case "prefix":
        approvedPrefixes.add(
          prefixKey({ cwd: grant.cwd, argvPrefix: grant.argvPrefix }),
        );
        break;
    }
  }

  return {
    review: async (request) => {
      const key = sessionKey(request);
      if (approved.has(key)) {
        return { type: "allow", scope: "session" };
      }

      const assessment = assessBashCommand(request.command);
      const matchingPrefix = matchingPrefixApprovalCandidate(assessment);
      const prefixApproval = commandPrefixApproval(matchingPrefix);
      if (
        matchingPrefix !== undefined &&
        approvedPrefixes.has(
          prefixKey({
            cwd: request.cwd,
            argvPrefix: matchingPrefix.argvPrefix,
          }),
        )
      ) {
        return { type: "allow", scope: "session-prefix" };
      }

      const promptRequest =
        prefixApproval === undefined
          ? { ...request, assessment }
          : { ...request, assessment, prefixApproval };
      const decision = await options.prompt(promptRequest);
      if (decision.type === "allow" && decision.scope === "session") {
        options.onGrant?.({
          type: "exact",
          cwd: request.cwd,
          command: request.command,
        });
        approved.add(key);
      } else if (
        decision.type === "allow" &&
        decision.scope === "session-prefix"
      ) {
        if (prefixApproval === undefined) {
          return {
            type: "deny",
            message: "No command family approval is available.",
          };
        }
        const grant = {
          type: "prefix",
          cwd: request.cwd,
          argvPrefix: [...prefixApproval.argvPrefix],
        } satisfies BashApprovalGrant;
        options.onGrant?.(grant);
        approvedPrefixes.add(
          prefixKey({
            cwd: request.cwd,
            argvPrefix: prefixApproval.argvPrefix,
          }),
        );
      }
      return decision;
    },
  };
}
