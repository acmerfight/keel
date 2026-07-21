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

export interface BashProjectApprovalGrant {
  readonly projectRoot: string;
  readonly cwd: string;
  readonly argvPrefix: readonly string[];
}

export function bashModeFromPolicy(policy: BashPolicy): BashMode {
  return policy === "deny" ? "disabled" : policy;
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

interface BashPermissionRequestBase {
  readonly command: string;
  readonly cwd: string;
  readonly signal: AbortSignal;
  readonly assessment: BashCommandAssessment;
}

interface BashPermissionApprovalMetadata {
  readonly type: "allow";
  readonly argvPrefix: readonly string[];
  readonly display: string;
  readonly promptLabel: "command family" | "this command";
}

// The private invariant token makes approval capabilities nominal and ties a
// prompt implementation to the request token it was given. Object.freeze also
// protects untyped callers from changing the grant data after review.
class BashPermissionPrefixApproval<RequestToken>
  implements BashPermissionApprovalMetadata
{
  private declare readonly requestToken: (
    requestToken: RequestToken,
  ) => RequestToken;
  readonly type = "allow" as const;
  readonly scope = "session-prefix" as const;
  readonly argvPrefix: readonly string[];
  readonly display: string;
  readonly promptLabel: "command family" | "this command";

  constructor(
    argvPrefix: readonly string[],
    display: string,
    promptLabel: "command family" | "this command",
  ) {
    this.argvPrefix = Object.freeze([...argvPrefix]);
    this.display = display;
    this.promptLabel = promptLabel;
    Object.freeze(this);
  }
}

class BashPermissionProjectApproval<RequestToken>
  implements BashPermissionApprovalMetadata
{
  private declare readonly requestToken: (
    requestToken: RequestToken,
  ) => RequestToken;
  readonly type = "allow" as const;
  readonly scope = "project-prefix" as const;
  readonly argvPrefix: readonly string[];
  readonly display: string;
  readonly promptLabel: "command family" | "this command";
  readonly projectRoot: string;

  constructor(
    argvPrefix: readonly string[],
    display: string,
    promptLabel: "command family" | "this command",
    projectRoot: string,
  ) {
    this.argvPrefix = Object.freeze([...argvPrefix]);
    this.display = display;
    this.promptLabel = promptLabel;
    this.projectRoot = projectRoot;
    Object.freeze(this);
  }
}

type BashPermissionRequest<RequestToken> = BashPermissionRequestBase &
  (
    | {
        readonly prefixApproval?: never;
        readonly projectApproval?: never;
      }
    | {
        readonly prefixApproval: BashPermissionPrefixApproval<RequestToken>;
        readonly projectApproval?: never;
      }
    | {
        readonly prefixApproval: BashPermissionPrefixApproval<RequestToken>;
        readonly projectApproval: BashPermissionProjectApproval<RequestToken>;
      }
  );

export type BashPermissionDecision =
  | {
      readonly type: "allow";
      readonly scope: "once" | "session" | "session-prefix" | "project-prefix";
    }
  | {
      readonly type: "deny";
      readonly message: string;
    };

type BashPermissionPromptDecision<RequestToken> =
  | Extract<BashPermissionDecision, { readonly type: "deny" }>
  | {
      readonly type: "allow";
      readonly scope: "once" | "session";
    }
  | BashPermissionPrefixApproval<RequestToken>
  | BashPermissionProjectApproval<RequestToken>;

type BashPermissionPrompt = <RequestToken>(
  request: BashPermissionRequest<RequestToken>,
) =>
  | BashPermissionPromptDecision<RequestToken>
  | Promise<BashPermissionPromptDecision<RequestToken>>;

interface BashPermissionPolicy {
  readonly review: (
    request: BashPermissionReviewRequest,
  ) => BashPermissionDecision | Promise<BashPermissionDecision>;
}

export type BashRuntime<
  Permission extends BashPermissionPolicy = BashPermissionPolicy,
> =
  | { readonly kind: "disabled" }
  | { readonly kind: "trusted" }
  | { readonly kind: "reviewed"; readonly permission: Permission };

export function bashRuntimeExposesTool(runtime: BashRuntime): boolean {
  return runtime.kind !== "disabled";
}

export interface SessionBashPermissionPolicy extends BashPermissionPolicy {
  readonly grants: () => readonly BashApprovalGrant[];
  readonly revokeGrant: (grant: BashApprovalGrant) => boolean;
  readonly clearGrants: () => readonly BashApprovalGrant[];
}

function sessionKey(request: BashPermissionReviewRequest): string {
  return exactApprovalKey(request.cwd, request.command);
}

function exactApprovalKey(cwd: string, command: string): string {
  return JSON.stringify([cwd, command]);
}

export function bashApprovalGrantKey(grant: BashApprovalGrant): string {
  switch (grant.type) {
    case "exact":
      return JSON.stringify(["exact", grant.cwd, grant.command]);
    case "prefix":
      return JSON.stringify(["prefix", grant.cwd, grant.argvPrefix]);
  }
}

function copyBashApprovalGrant(grant: BashApprovalGrant): BashApprovalGrant {
  switch (grant.type) {
    case "exact":
      return {
        type: "exact",
        cwd: grant.cwd,
        command: grant.command,
      };
    case "prefix":
      return {
        type: "prefix",
        cwd: grant.cwd,
        argvPrefix: [...grant.argvPrefix],
      };
  }
}

interface PrefixApprovalRule {
  readonly cwd: string;
  readonly argvPrefix: readonly string[];
}

interface ProjectPrefixApprovalRule {
  readonly projectRoot: string;
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

function commandPrefixApproval<RequestToken>(
  candidate: PrefixApprovalCandidate | undefined,
): BashPermissionPrefixApproval<RequestToken> | undefined {
  if (candidate === undefined) {
    return undefined;
  }
  return new BashPermissionPrefixApproval<RequestToken>(
    candidate.argvPrefix,
    candidate.argvPrefix.join(" "),
    candidate.trailing === "any" ? "command family" : "this command",
  );
}

function commandProjectApproval<RequestToken>(
  prefixApproval: BashPermissionPrefixApproval<RequestToken>,
  projectRoot: string,
): BashPermissionProjectApproval<RequestToken> {
  return new BashPermissionProjectApproval<RequestToken>(
    prefixApproval.argvPrefix,
    prefixApproval.display,
    prefixApproval.promptLabel,
    projectRoot,
  );
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

function projectPrefixKey(rule: ProjectPrefixApprovalRule): string {
  return JSON.stringify([rule.projectRoot, rule.argvPrefix]);
}

function copyBashProjectApprovalGrant(
  grant: BashProjectApprovalGrant,
): BashProjectApprovalGrant {
  return {
    projectRoot: grant.projectRoot,
    cwd: grant.cwd,
    argvPrefix: [...grant.argvPrefix],
  };
}

export function createSessionBashPermissionPolicy(options: {
  readonly prompt: BashPermissionPrompt;
  readonly initialGrants?: readonly BashApprovalGrant[];
  readonly onGrant?: (grant: BashApprovalGrant) => void;
  readonly projectRoot?: string;
  readonly initialProjectGrants?: readonly BashProjectApprovalGrant[];
  readonly onProjectGrant?: (grant: BashProjectApprovalGrant) => void;
}): SessionBashPermissionPolicy {
  const approved = new Set<string>();
  const approvedPrefixes = new Set<string>();
  const approvedProjectPrefixes = new Set<string>();
  const grantsByKey = new Map<string, BashApprovalGrant>();
  const addGrant = (grant: BashApprovalGrant): boolean => {
    const key = bashApprovalGrantKey(grant);
    if (grantsByKey.has(key)) {
      return false;
    }
    const copiedGrant = copyBashApprovalGrant(grant);
    grantsByKey.set(key, copiedGrant);
    switch (copiedGrant.type) {
      case "exact":
        approved.add(exactApprovalKey(copiedGrant.cwd, copiedGrant.command));
        break;
      case "prefix":
        approvedPrefixes.add(
          prefixKey({
            cwd: copiedGrant.cwd,
            argvPrefix: copiedGrant.argvPrefix,
          }),
        );
        break;
    }
    return true;
  };
  for (const grant of options.initialGrants ?? []) {
    addGrant(grant);
  }
  for (const grant of options.initialProjectGrants ?? []) {
    approvedProjectPrefixes.add(projectPrefixKey(grant));
  }

  return {
    grants: () => [...grantsByKey.values()].map(copyBashApprovalGrant),
    revokeGrant: (grant) => {
      const key = bashApprovalGrantKey(grant);
      const activeGrant = grantsByKey.get(key);
      if (activeGrant === undefined) {
        return false;
      }
      grantsByKey.delete(key);
      switch (activeGrant.type) {
        case "exact":
          approved.delete(
            exactApprovalKey(activeGrant.cwd, activeGrant.command),
          );
          break;
        case "prefix":
          approvedPrefixes.delete(
            prefixKey({
              cwd: activeGrant.cwd,
              argvPrefix: activeGrant.argvPrefix,
            }),
          );
          break;
      }
      return true;
    },
    clearGrants: () => {
      const cleared = [...grantsByKey.values()].map(copyBashApprovalGrant);
      grantsByKey.clear();
      approved.clear();
      approvedPrefixes.clear();
      return cleared;
    },
    review: async (request) => {
      const key = sessionKey(request);
      if (approved.has(key)) {
        return { type: "allow", scope: "session" };
      }

      const assessment = assessBashCommand(request.command);
      const matchingPrefix = matchingPrefixApprovalCandidate(assessment);
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
      if (
        matchingPrefix !== undefined &&
        options.projectRoot !== undefined &&
        approvedProjectPrefixes.has(
          projectPrefixKey({
            projectRoot: options.projectRoot,
            argvPrefix: matchingPrefix.argvPrefix,
          }),
        )
      ) {
        return { type: "allow", scope: "project-prefix" };
      }

      // A prompt must be valid for every fresh request token, so trusted
      // TypeScript cannot retain one request's capability for a later request.
      const reviewPrompt = async <
        RequestToken,
      >(): Promise<BashPermissionDecision> => {
        const prefixApproval =
          commandPrefixApproval<RequestToken>(matchingPrefix);
        const projectApproval =
          prefixApproval === undefined || options.projectRoot === undefined
            ? undefined
            : commandProjectApproval(prefixApproval, options.projectRoot);
        const promptRequest: BashPermissionRequest<RequestToken> =
          prefixApproval === undefined
            ? { ...request, assessment }
            : projectApproval === undefined
              ? { ...request, assessment, prefixApproval }
              : { ...request, assessment, prefixApproval, projectApproval };
        const decision = await options.prompt(promptRequest);
        if (decision.type === "deny") {
          return decision;
        }

        switch (decision.scope) {
          case "once":
            return decision;
          case "session": {
            const grant = {
              type: "exact",
              cwd: request.cwd,
              command: request.command,
            } satisfies BashApprovalGrant;
            if (addGrant(grant)) {
              options.onGrant?.(grant);
            }
            return decision;
          }
          case "session-prefix": {
            // Identity remains the runtime boundary for untyped or Proxy-based
            // callers; grant data always comes from the local capability.
            if (decision !== prefixApproval) {
              return {
                type: "deny",
                message: "Command family approval did not match this request.",
              };
            }
            const grant = {
              type: "prefix",
              cwd: request.cwd,
              argvPrefix: [...prefixApproval.argvPrefix],
            } satisfies BashApprovalGrant;
            if (addGrant(grant)) {
              options.onGrant?.(grant);
            }
            return { type: "allow", scope: "session-prefix" };
          }
          case "project-prefix": {
            // See the session-prefix boundary above.
            if (decision !== projectApproval) {
              return {
                type: "deny",
                message: "Project command approval did not match this request.",
              };
            }
            const grant = {
              projectRoot: projectApproval.projectRoot,
              cwd: request.cwd,
              argvPrefix: [...projectApproval.argvPrefix],
            } satisfies BashProjectApprovalGrant;
            approvedProjectPrefixes.add(projectPrefixKey(grant));
            options.onProjectGrant?.(copyBashProjectApprovalGrant(grant));
            return { type: "allow", scope: "project-prefix" };
          }
        }
      };

      return reviewPrompt();
    },
  };
}
