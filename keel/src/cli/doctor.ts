import { execFile } from "node:child_process";
import { z } from "zod";
import { KeelError } from "../core/error.ts";
import { resolveRipgrep } from "../tools/ripgrep.ts";
import {
  type ApiKeyDiagnostic,
  type BaseUrlDiagnostic,
  type ContextWindowDiagnostic,
  inspectProviderConfig,
  type ModelMetadataDiagnostic,
  type ProviderConfigDiagnostic,
  type ProviderConfigRuntime,
  type ProviderSelection,
} from "./provider-config.ts";

export interface DoctorResult {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
}

type DoctorOnlineMode = "online" | "offline";

export interface RipgrepDoctorDiagnostic {
  readonly provider: string;
  readonly path: string;
  readonly version: string;
}

export interface ProviderOnlineDiagnosticRequest {
  readonly baseUrl: string;
  readonly apiKey: string;
}

type ProviderAuthDiagnostic =
  | {
      readonly status: "ok";
      readonly method: "GET";
      readonly path: "/models";
    }
  | {
      readonly status: "failed";
      readonly message: string;
    }
  | {
      readonly status: "skipped";
      readonly reason:
        | "--offline"
        | "not required"
        | "missing API key"
        | "local provider diagnostics failed";
    };

export interface DoctorOptions {
  readonly runtime: ProviderConfigRuntime;
  readonly readRipgrepDiagnostic: () => Promise<RipgrepDoctorDiagnostic>;
  readonly readProviderOnlineDiagnostic: (
    request: ProviderOnlineDiagnosticRequest,
  ) => Promise<ProviderAuthDiagnostic>;
  readonly onlineMode: DoctorOnlineMode;
  readonly selection?: ProviderSelection;
}

const RIPGREP_DOCTOR_TIMEOUT_MS = 5_000;
const PROVIDER_MODELS_TIMEOUT_MS = 5_000;
const ripgrepVersionLineSchema = z
  .string()
  .regex(/^ripgrep\s+\S+/, "expected ripgrep version output");
const modelsListResponseSchema = z
  .object({
    data: z.array(z.unknown()),
  })
  .passthrough();

type ProviderModelsUrlResult =
  | { readonly status: "ok"; readonly url: URL }
  | {
      readonly status: "failed";
      readonly message: "base URL must not include credentials, query, or fragment";
    };

function ripgrepVersionError(error: Error, stderr: string): KeelError {
  const detail = stderr.trim() === "" ? error.message : stderr.trim();
  return new KeelError(
    "tool_unavailable",
    `grep failed: bundled ripgrep version check failed: ${detail}`,
  );
}

function parseRipgrepVersionOutput(stdout: string): string {
  const versionLine = stdout.trim().split(/\r?\n/)[0];
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

export async function readBundledRipgrepDiagnostic(): Promise<RipgrepDoctorDiagnostic> {
  const ripgrep = await resolveRipgrep();
  const version = await readRipgrepVersion(ripgrep.path);
  return {
    provider: ripgrep.provider,
    path: ripgrep.path,
    version,
  };
}

function providerModelsUrl(baseUrl: string): ProviderModelsUrlResult {
  const url = new URL(baseUrl);
  if (
    url.username !== "" ||
    url.password !== "" ||
    url.search !== "" ||
    url.hash !== ""
  ) {
    return {
      status: "failed",
      message: "base URL must not include credentials, query, or fragment",
    };
  }
  const basePath = url.pathname.endsWith("/")
    ? url.pathname.slice(0, -1)
    : url.pathname;
  url.pathname = `${basePath}/models`;
  return { status: "ok", url };
}

function responseStatusMessage(response: Response): string {
  return `HTTP ${response.status}`;
}

export async function readProviderModelsDiagnostic(
  request: ProviderOnlineDiagnosticRequest,
): Promise<ProviderAuthDiagnostic> {
  let url: URL;
  try {
    const result = providerModelsUrl(request.baseUrl);
    if (result.status === "failed") {
      return { status: "failed", message: result.message };
    }
    url = result.url;
  } catch {
    return { status: "failed", message: "invalid base URL" };
  }

  let response: Response;
  try {
    response = await fetch(url, {
      method: "GET",
      headers: {
        Accept: "application/json",
        Authorization: `Bearer ${request.apiKey}`,
      },
      signal: AbortSignal.timeout(PROVIDER_MODELS_TIMEOUT_MS),
    });
  } catch {
    return { status: "failed", message: "network request failed" };
  }

  if (!response.ok) {
    return { status: "failed", message: responseStatusMessage(response) };
  }

  let body: unknown;
  try {
    body = await response.json();
  } catch {
    return { status: "failed", message: "invalid /models response" };
  }

  const parsed = modelsListResponseSchema.safeParse(body);
  if (!parsed.success) {
    return { status: "failed", message: "invalid /models response" };
  }

  return { status: "ok", method: "GET", path: "/models" };
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
    case "unknown":
      return "context window: unknown";
    case "enabled":
      return `context window: ${contextWindow.tokens} tokens (source: ${contextWindow.source})`;
    case "invalid":
      return `context window: invalid (source: ${contextWindow.source})`;
  }
}

export function capabilityNames(
  capabilities: Extract<
    ModelMetadataDiagnostic,
    { readonly status: "known" }
  >["capabilities"],
): string {
  const names: string[] = [];
  if (capabilities.textInput) names.push("text-input");
  if (capabilities.toolCalls) names.push("tool-calls");
  if (capabilities.reasoning) names.push("reasoning");
  return names.length === 0 ? "none" : names.join(", ");
}

function modelMetadataLines(
  metadata: ModelMetadataDiagnostic,
): readonly string[] {
  if (metadata.status === "unknown") {
    return ["model metadata: unknown"];
  }
  const maxOutput =
    metadata.maxOutputTokens === null
      ? "max output: unknown"
      : `max output: ${metadata.maxOutputTokens} tokens`;
  return [
    `model metadata: ${metadata.source}`,
    maxOutput,
    `model capabilities: ${capabilityNames(metadata.capabilities)}`,
  ];
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
    ...modelMetadataLines(diagnostic.modelMetadata),
    `cost model: ${diagnostic.costModel}`,
    ...diagnostic.issues.map((issue) => `${issue.severity}: ${issue.message}`),
  ];
}

function providerAuthLine(diagnostic: ProviderAuthDiagnostic): string {
  switch (diagnostic.status) {
    case "ok":
      return `provider auth: ok (${diagnostic.method} ${diagnostic.path})`;
    case "failed":
      return `provider auth: failed (${diagnostic.message})`;
    case "skipped":
      return `provider auth: skipped (${diagnostic.reason})`;
  }
}

async function readProviderAuthDiagnostic(
  options: DoctorOptions,
  diagnostic: ProviderConfigDiagnostic,
): Promise<ProviderAuthDiagnostic> {
  if (options.onlineMode === "offline") {
    return { status: "skipped", reason: "--offline" };
  }

  if (diagnostic.apiKey.status === "missing") {
    return { status: "skipped", reason: "missing API key" };
  }

  if (providerDiagnosticHasError(diagnostic)) {
    return {
      status: "skipped",
      reason: "local provider diagnostics failed",
    };
  }

  if (
    diagnostic.apiKey.status === "not-required" ||
    diagnostic.baseUrl.status === "none"
  ) {
    return { status: "skipped", reason: "not required" };
  }

  const apiKey = options.runtime.env(diagnostic.apiKey.presentEnvKey);
  if (apiKey === undefined || apiKey === "") {
    return {
      status: "failed",
      message: "API key changed before auth probe",
    };
  }

  return await options.readProviderOnlineDiagnostic({
    baseUrl: diagnostic.baseUrl.value,
    apiKey,
  });
}

export async function runDoctor(options: DoctorOptions): Promise<DoctorResult> {
  const stdoutLines: string[] = ["Keel doctor"];
  const stderrLines: string[] = [];
  let exitCode = 0;

  try {
    const ripgrep = await options.readRipgrepDiagnostic();
    stdoutLines.push(
      `ripgrep: ok (${ripgrep.provider})`,
      `ripgrep path: ${ripgrep.path}`,
      `ripgrep version: ${ripgrep.version}`,
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
    const authDiagnostic = await readProviderAuthDiagnostic(
      options,
      providerDiagnostic,
    );
    stdoutLines.push(providerAuthLine(authDiagnostic));
    if (providerDiagnosticHasError(providerDiagnostic)) {
      exitCode = 1;
    }
    if (authDiagnostic.status === "failed") {
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
