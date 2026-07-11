import { existsSync } from "node:fs";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import xtermHeadless from "@xterm/headless";
import { spawn } from "node-pty";

const SOURCE_CLI_PATH = join(import.meta.dirname, "../cli/index.ts");
const DIST_CLI_PATH = join(import.meta.dirname, "../../dist/cli/index.js");

function cliNodeArgs(): readonly string[] {
  // biome-ignore lint/complexity/useLiteralKeys: ProcessEnv requires bracket access under noPropertyAccessFromIndexSignature.
  const entry = process.env["KEEL_TEST_CLI_ENTRY"];
  if (entry === undefined || entry === "source") {
    return ["--experimental-strip-types", SOURCE_CLI_PATH];
  }
  if (entry === "dist") {
    if (!existsSync(DIST_CLI_PATH)) {
      throw new Error(
        "KEEL_TEST_CLI_ENTRY=dist requires pnpm build before CLI process tests",
      );
    }
    return [DIST_CLI_PATH];
  }
  throw new Error(
    `Unsupported KEEL_TEST_CLI_ENTRY "${entry}". Use "source" or "dist".`,
  );
}

function processEnvironment(
  overrides: Readonly<Record<string, string>>,
): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined) {
      env[key] = value;
    }
  }
  return { ...env, ...overrides };
}

type HeadlessTerminal = InstanceType<typeof xtermHeadless.Terminal>;

function terminalText(terminal: HeadlessTerminal): string {
  const buffer = terminal.buffer.active;
  const lines: string[] = [];
  for (let index = 0; index < buffer.length; index++) {
    lines.push(buffer.getLine(index)?.translateToString(true) ?? "");
  }
  return lines.join("\n");
}

export function runCliPty(
  args: readonly string[],
  options: {
    readonly cwd: string;
    readonly env?: Readonly<Record<string, string>>;
    readonly columns?: number;
    readonly rows?: number;
  },
) {
  const columns = options.columns ?? 100;
  const rows = options.rows ?? 30;
  const terminal = new xtermHeadless.Terminal({
    cols: columns,
    rows,
    scrollback: 5_000,
    allowProposedApi: true,
  });
  const child = spawn(process.execPath, [...cliNodeArgs(), ...args], {
    name: "xterm-256color",
    cols: columns,
    rows,
    cwd: options.cwd,
    env: processEnvironment(options.env ?? {}),
  });
  let rawOutput = "";
  let terminalWrites = Promise.resolve();
  child.onData((data) => {
    rawOutput += data;
    terminalWrites = terminalWrites.then(
      () =>
        new Promise<void>((resolve) => {
          terminal.write(data, resolve);
        }),
    );
  });
  const exit = new Promise<{
    readonly exitCode: number;
    readonly signal?: number;
  }>((resolve) => {
    child.onExit(resolve);
  });

  return {
    write: (data: string) => {
      child.write(data);
    },
    resize: (nextColumns: number, nextRows: number) => {
      terminal.resize(nextColumns, nextRows);
      child.resize(nextColumns, nextRows);
    },
    screen: async () => {
      await terminalWrites;
      return terminalText(terminal);
    },
    rawOutput: () => rawOutput,
    waitForScreen: async (
      predicate: (screen: string) => boolean,
      message: string,
      timeoutMs = 5_000,
    ) => {
      const deadline = Date.now() + timeoutMs;
      while (Date.now() < deadline) {
        await terminalWrites;
        const screen = terminalText(terminal);
        if (predicate(screen)) {
          return screen;
        }
        await delay(10);
      }
      throw new Error(`${message}\n\nScreen:\n${terminalText(terminal)}`);
    },
    exit,
    kill: () => {
      child.kill("SIGKILL");
    },
  };
}
