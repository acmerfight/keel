export type BashPolicy = "ask" | "deny" | "trusted";

// BashPolicy is the user-facing CLI vocabulary; BashMode is the internal state
// used to derive tool exposure and approval behavior.
export type BashMode = "disabled" | "ask" | "trusted";

export function bashModeFromPolicy(policy: BashPolicy): BashMode {
  return policy === "deny" ? "disabled" : policy;
}

export function bashModeExposesTool(mode: BashMode): boolean {
  return mode !== "disabled";
}

export interface BashPermissionRequest {
  readonly command: string;
  readonly cwd: string;
  readonly signal: AbortSignal;
  readonly prefixApproval?: BashPermissionPrefixApproval;
}

interface BashPermissionPrefixApproval {
  readonly argvPrefix: readonly string[];
  readonly display: string;
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
    request: BashPermissionRequest,
  ) => BashPermissionDecision | Promise<BashPermissionDecision>;
}

function sessionKey(request: BashPermissionRequest): string {
  return JSON.stringify([request.cwd, request.command]);
}

interface PrefixApprovalRule {
  readonly cwd: string;
  readonly argvPrefix: readonly string[];
}

const SIMPLE_COMMAND_TOKEN_PATTERN = /^[A-Za-z0-9_./:@%+=,-]+$/u;

const PREFIX_APPROVAL_CANDIDATES: readonly (readonly string[])[] = [
  ["pnpm", "vitest", "run"],
  ["pnpm", "test"],
  ["npm", "test"],
  ["git", "status"],
  // Do not add git diff without family-specific trailing argv validation:
  // --no-index, absolute paths, escaped paths, and external diff hooks can
  // reach outside the cwd-bound approval.
];

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

function commandPrefixApproval(
  command: string,
): BashPermissionPrefixApproval | undefined {
  const argv = parseSimpleCommandArgv(command);
  if (argv === null) {
    return undefined;
  }

  const argvPrefix = PREFIX_APPROVAL_CANDIDATES.find((candidate) =>
    argvStartsWith(argv, candidate),
  );
  if (argvPrefix === undefined) {
    return undefined;
  }
  return {
    argvPrefix,
    display: argvPrefix.join(" "),
  };
}

function prefixKey(rule: PrefixApprovalRule): string {
  return JSON.stringify([rule.cwd, rule.argvPrefix]);
}

export function createSessionBashPermissionPolicy(options: {
  readonly prompt: (
    request: BashPermissionRequest,
  ) => BashPermissionDecision | Promise<BashPermissionDecision>;
}): BashPermissionPolicy {
  const approved = new Set<string>();
  const approvedPrefixes = new Set<string>();

  return {
    review: async (request) => {
      const key = sessionKey(request);
      if (approved.has(key)) {
        return { type: "allow", scope: "session" };
      }

      const prefixApproval = commandPrefixApproval(request.command);
      const requestArgv = parseSimpleCommandArgv(request.command);
      if (requestArgv !== null) {
        const matchingPrefix = PREFIX_APPROVAL_CANDIDATES.find((candidate) =>
          argvStartsWith(requestArgv, candidate),
        );
        if (
          matchingPrefix !== undefined &&
          approvedPrefixes.has(
            prefixKey({ cwd: request.cwd, argvPrefix: matchingPrefix }),
          )
        ) {
          return { type: "allow", scope: "session-prefix" };
        }
      }

      const promptRequest =
        prefixApproval === undefined ? request : { ...request, prefixApproval };
      const decision = await options.prompt(promptRequest);
      if (decision.type === "allow" && decision.scope === "session") {
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
