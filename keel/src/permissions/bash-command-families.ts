import { posix, win32 } from "node:path";

export const bashCommandFamilyIds = [
  "pnpm_vitest_run_workspace_test_selectors",
  "pnpm_exec_vitest_run_workspace_test_selectors",
] as const;

export type BashCommandFamily = (typeof bashCommandFamilyIds)[number];

export type BashCommandRisk =
  | "workspace-read"
  | "project-verification"
  | "workspace-write"
  | "unknown-or-dangerous";

interface BashCommandFamilyDefinition {
  readonly argvPrefix: readonly string[];
  readonly display: string;
  readonly risk: BashCommandRisk;
  readonly matchesTrailingArgv: (argv: readonly string[]) => boolean;
}

export interface BashCommandFamilyMatch {
  readonly commandFamily: BashCommandFamily;
  readonly argvPrefix: readonly string[];
  readonly display: string;
  readonly risk: BashCommandRisk;
}

function vitestSelectorFilename(selector: string): string {
  // Mirror Vitest's location-filter parse: a final numeric suffix is a line
  // number, so path safety must be checked against the filename before it.
  const colonIndex = selector.lastIndexOf(":");
  if (colonIndex === -1) {
    return selector;
  }
  const lineNumber = selector.slice(colonIndex + 1);
  return /^\d+$/u.test(lineNumber) ? selector.slice(0, colonIndex) : selector;
}

function isSafeWorkspaceTestSelector(selector: string): boolean {
  const filename = vitestSelectorFilename(selector);
  if (
    selector.startsWith("-") ||
    filename === "" ||
    posix.isAbsolute(filename) ||
    win32.isAbsolute(filename) ||
    /^[A-Za-z]:/u.test(selector)
  ) {
    return false;
  }
  const pathSegments = filename.split("/");
  return (
    pathSegments.every((segment) => segment !== "..") &&
    pathSegments.some((segment) => segment !== "" && segment !== ".")
  );
}

function matchesWorkspaceTestSelectors(argv: readonly string[]): boolean {
  return argv.length > 0 && argv.every(isSafeWorkspaceTestSelector);
}

const bashCommandFamilies: Readonly<
  Record<BashCommandFamily, BashCommandFamilyDefinition>
> = {
  pnpm_vitest_run_workspace_test_selectors: {
    argvPrefix: ["pnpm", "vitest", "run"],
    display: "pnpm vitest run <workspace test selectors>",
    risk: "project-verification",
    matchesTrailingArgv: matchesWorkspaceTestSelectors,
  },
  pnpm_exec_vitest_run_workspace_test_selectors: {
    argvPrefix: ["pnpm", "exec", "vitest", "run"],
    display: "pnpm exec vitest run <workspace test selectors>",
    risk: "project-verification",
    matchesTrailingArgv: matchesWorkspaceTestSelectors,
  },
};

export function bashArgvStartsWith(
  argv: readonly string[],
  prefix: readonly string[],
): boolean {
  return (
    argv.length >= prefix.length &&
    prefix.every((token, index) => argv[index] === token)
  );
}

export function bashCommandFamilyDisplay(family: BashCommandFamily): string {
  return bashCommandFamilies[family].display;
}

export function matchingBashCommandFamily(
  argv: readonly string[],
): BashCommandFamilyMatch | undefined {
  for (const commandFamily of bashCommandFamilyIds) {
    const definition = bashCommandFamilies[commandFamily];
    if (
      bashArgvStartsWith(argv, definition.argvPrefix) &&
      definition.matchesTrailingArgv(argv.slice(definition.argvPrefix.length))
    ) {
      return {
        commandFamily,
        argvPrefix: definition.argvPrefix,
        display: definition.display,
        risk: definition.risk,
      };
    }
  }
  return undefined;
}

export function bashCommandFamilyRisk(
  argv: readonly string[],
): BashCommandRisk | undefined {
  for (const commandFamily of bashCommandFamilyIds) {
    const definition = bashCommandFamilies[commandFamily];
    if (bashArgvStartsWith(argv, definition.argvPrefix)) {
      return definition.risk;
    }
  }
  return undefined;
}
