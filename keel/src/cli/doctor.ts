import { execFile } from "node:child_process";
import { z } from "zod";
import { KeelError } from "../core/error.ts";
import { resolveRipgrep } from "../tools/ripgrep.ts";
import {
  type ApiKeyDiagnostic,
  type BaseUrlDiagnostic,
  type ContextWindowDiagnostic,
  inspectProviderConfig,
  type ProviderConfigDiagnostic,
  type ProviderConfigRuntime,
  type ProviderSelection,
} from "./provider-config.ts";

export interface DoctorResult {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
}

export interface DoctorOptions {
  readonly runtime: ProviderConfigRuntime;
  readonly selection?: ProviderSelection;
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

function apiKeyLine(apiKey: ApiKeyDiagnostic): string {
  switch (apiKey.status) {
    case "not-required":
      return "api key: not required";
    case "present":
      return `api key: present (${apiKey.presentEnvKey})`;
    case "missing":
      return `api key: missing (expected ${apiKey.expectedEnvKeys.join(" or ")})`;
  }
}

function baseUrlLine(baseUrl: BaseUrlDiagnostic): string {
  switch (baseUrl.status) {
    case "none":
      return "base url: none";
    case "configured":
      return `base url: ${redactBaseUrl(baseUrl.value)} (source: ${baseUrl.source})`;
  }
}

function redactBaseUrl(value: string): string {
  try {
    const url = new URL(value);
    const path = url.pathname === "/" ? "" : url.pathname;
    return `${url.protocol}//${url.host}${path}`;
  } catch {
    return "<unparseable URL>";
  }
}

function contextWindowLine(contextWindow: ContextWindowDiagnostic): string {
  switch (contextWindow.status) {
    case "disabled":
      return "context window: disabled";
    case "enabled":
      return `context window: ${contextWindow.tokens} tokens (source: ${contextWindow.source})`;
    case "invalid":
      return `context window: invalid (source: ${contextWindow.source})`;
  }
}

function providerDiagnosticHasError(
  diagnostic: ProviderConfigDiagnostic,
): boolean {
  return diagnostic.issues.some((issue) => issue.severity === "error");
}

function providerDiagnosticLines(
  diagnostic: ProviderConfigDiagnostic,
): readonly string[] {
  return [
    `provider: ${diagnostic.providerId} (source: ${diagnostic.providerSource})`,
    `model: ${diagnostic.model} (source: ${diagnostic.modelSource})`,
    apiKeyLine(diagnostic.apiKey),
    baseUrlLine(diagnostic.baseUrl),
    contextWindowLine(diagnostic.contextWindow),
    `cost model: ${diagnostic.costModel}`,
    ...diagnostic.issues.map((issue) => `${issue.severity}: ${issue.message}`),
  ];
}

export async function runDoctor(options: DoctorOptions): Promise<DoctorResult> {
  const stdoutLines: string[] = ["Keel doctor"];
  const stderrLines: string[] = [];
  let exitCode = 0;

  try {
    const ripgrep = await resolveRipgrep();
    const version = await readRipgrepVersion(ripgrep.path);
    stdoutLines.push(
      `ripgrep: ok (${ripgrep.provider})`,
      `ripgrep path: ${ripgrep.path}`,
      `ripgrep version: ${version}`,
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    exitCode = 1;
    stderrLines.push(`ripgrep: failed: ${message}`);
  }

  try {
    const providerDiagnostic = inspectProviderConfig(
      options.runtime,
      options.selection,
    );
    stdoutLines.push("", ...providerDiagnosticLines(providerDiagnostic));
    if (providerDiagnosticHasError(providerDiagnostic)) {
      exitCode = 1;
    }
  } catch (error) {
    exitCode = 1;
    const message = error instanceof Error ? error.message : String(error);
    stdoutLines.push("", "provider: failed");
    stderrLines.push(message);
  }

  return {
    exitCode,
    stdout: `${stdoutLines.join("\n")}\n`,
    stderr: stderrLines.length === 0 ? "" : `${stderrLines.join("\n")}\n`,
  };
}
