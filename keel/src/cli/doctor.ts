import { execFile } from "node:child_process";
import { z } from "zod";
import { KeelError } from "../core/error.ts";
import { resolveRipgrep } from "../tools/ripgrep.ts";

export interface DoctorResult {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
}

const RIPGREP_DOCTOR_TIMEOUT_MS = 5_000;
const ripgrepVersionLineSchema = z
  .string()
  .regex(/^ripgrep\s+\S+/, "expected ripgrep version output");

function ripgrepVersionError(error: Error, stderr: string): KeelError {
  const detail = stderr.trim() === "" ? error.message : stderr.trim();
  return new KeelError(
    "tool_unavailable",
    `grep failed: bundled ripgrep version check failed: ${detail}`,
  );
}

function parseRipgrepVersionOutput(stdout: string): string {
  const versionLine = stdout.trim().split(/\r?\n/)[0] ?? "";
  const result = ripgrepVersionLineSchema.safeParse(versionLine);
  if (!result.success) {
    throw new KeelError(
      "tool_unavailable",
      "grep failed: bundled ripgrep returned invalid version output",
    );
  }
  return result.data;
}

function readRipgrepVersion(path: string): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    execFile(
      path,
      ["--version"],
      {
        encoding: "utf8",
        timeout: RIPGREP_DOCTOR_TIMEOUT_MS,
        windowsHide: true,
      },
      (error, stdout, stderr) => {
        if (error !== null) {
          reject(ripgrepVersionError(error, stderr));
          return;
        }

        try {
          resolve(parseRipgrepVersionOutput(stdout));
        } catch (parseError) {
          reject(parseError);
        }
      },
    );
  });
}

export async function runDoctor(): Promise<DoctorResult> {
  try {
    const ripgrep = await resolveRipgrep();
    const version = await readRipgrepVersion(ripgrep.path);
    return {
      exitCode: 0,
      stdout: [
        "Keel doctor",
        `ripgrep: ok (${ripgrep.provider})`,
        `ripgrep path: ${ripgrep.path}`,
        `ripgrep version: ${version}`,
        "",
      ].join("\n"),
      stderr: "",
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      exitCode: 1,
      stdout: "Keel doctor\n",
      stderr: `ripgrep: failed: ${message}\n`,
    };
  }
}
