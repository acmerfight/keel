import { accessSync, constants, statSync } from "node:fs";
import { z } from "zod";
import { KeelError } from "../core/error.ts";

export type RipgrepProvider = "vscode-ripgrep";

export interface RipgrepCommand {
  readonly path: string;
  readonly provider: RipgrepProvider;
}

const vscodeRipgrepModuleSchema = z.object({
  rgPath: z.string().min(1),
});

let cachedRipgrepCommand: RipgrepCommand | undefined;

function ripgrepUnavailable(error: unknown): KeelError {
  const message = error instanceof Error ? error.message : String(error);
  return new KeelError(
    "tool_unavailable",
    `grep failed: bundled ripgrep is not available: ${message}`,
  );
}

function validateRipgrepBinary(path: string): void {
  try {
    if (!statSync(path).isFile()) {
      throw new Error("not a file");
    }
    accessSync(path, constants.X_OK);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new KeelError(
      "tool_unavailable",
      `grep failed: bundled ripgrep is not executable: ${message}`,
    );
  }
}

export function createRipgrepCommandFromVscodeModule(
  ripgrepModule: unknown,
): RipgrepCommand {
  const result = vscodeRipgrepModuleSchema.safeParse(ripgrepModule);
  if (!result.success) {
    throw new KeelError(
      "tool_unavailable",
      "grep failed: bundled ripgrep did not expose a valid rgPath",
    );
  }

  validateRipgrepBinary(result.data.rgPath);

  return {
    path: result.data.rgPath,
    provider: "vscode-ripgrep",
  };
}

export async function resolveRipgrep(): Promise<RipgrepCommand> {
  if (cachedRipgrepCommand !== undefined) return cachedRipgrepCommand;

  let ripgrepModule: unknown;
  try {
    ripgrepModule = await import("@vscode/ripgrep");
  } catch (error) {
    throw ripgrepUnavailable(error);
  }

  cachedRipgrepCommand = createRipgrepCommandFromVscodeModule(ripgrepModule);
  return cachedRipgrepCommand;
}
