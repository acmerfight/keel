import { z } from "zod";
import { type AgentPolicy, agentPolicies } from "../../core/agent-policy.ts";
import type { ExecutionPosture } from "../../core/execution-posture.ts";
import { type ProviderId, providerIds } from "../../core/provider-id.ts";
import type { SessionToolEffectRecoveryPolicy } from "../session-store.ts";

export type ParseErrorKind = "unknownOption";

export type ParseResult<T> =
  | { readonly ok: true; readonly value: T }
  | {
      readonly ok: false;
      readonly message: string;
      readonly kind?: ParseErrorKind;
    };

export function parseOk<T>(value: T): ParseResult<T> {
  return { ok: true, value };
}

export function parseError(
  message: string,
  kind?: ParseErrorKind,
): ParseResult<never> {
  if (kind !== undefined) {
    return { ok: false, message, kind };
  }
  return { ok: false, message };
}

const maxCostSchema = z
  .string()
  .regex(/^(?:\d+(?:\.\d+)?|\.\d+)$/u)
  .transform((value) => Number(value))
  .pipe(z.number().finite().positive());
const approvalPolicySchema = z.literal("ask");
const agentPolicySchema = z.enum(agentPolicies);
const recoveryPolicySchema = z.enum(["block", "accept-unknown"]);
const providerIdSchema = z.enum(providerIds);
const trialsSchema = z
  .string()
  .regex(/^\d+$/u)
  .transform((value) => Number(value))
  .pipe(z.number().int().positive());

export function parseMaxCost(raw: string | undefined): ParseResult<number> {
  const result = maxCostSchema.safeParse(raw);
  if (!result.success) {
    return parseError("Error: --max-cost must be a positive number.");
  }
  return parseOk(result.data);
}

export function parseReportFile(raw: string | undefined): ParseResult<string> {
  if (raw === undefined || raw === "") {
    return parseError("Error: --report requires a file path.");
  }
  return parseOk(raw);
}

export function parseApprovalPolicy(
  raw: string | undefined,
): ParseResult<ExecutionPosture> {
  const result = approvalPolicySchema.safeParse(raw);
  if (!result.success) {
    return parseError("Error: --approval-policy must be: ask.");
  }
  return parseOk("reviewed");
}

export function parseAgentPolicy(
  raw: string | undefined,
): ParseResult<AgentPolicy> {
  const result = agentPolicySchema.safeParse(raw);
  if (!result.success) {
    return parseError(
      "Error: --agent-policy must be one of: off, explicit, auto.",
    );
  }
  return parseOk(result.data);
}

export function parseRecoveryPolicy(
  raw: string | undefined,
): ParseResult<SessionToolEffectRecoveryPolicy> {
  const result = recoveryPolicySchema.safeParse(raw);
  if (!result.success) {
    return parseError(
      "Error: --recovery-policy must be one of: block, accept-unknown.",
    );
  }
  return parseOk(result.data === "accept-unknown" ? "accept_unknown" : "block");
}

export function parseProviderId(
  raw: string | undefined,
): ParseResult<ProviderId> {
  return parseProviderIdValue("--provider", raw);
}

export function parseProviderIdValue(
  label: string,
  raw: string | undefined,
): ParseResult<ProviderId> {
  const parsedValue = requireOptionValue(label, raw);
  if (!parsedValue.ok) return parsedValue;
  const result = providerIdSchema.safeParse(parsedValue.value);
  if (!result.success) {
    return parseError(
      `Error: ${label} must be one of: fake, deepseek, kimi, qwen.`,
    );
  }
  return parseOk(result.data);
}

export function parseModel(raw: string | undefined): ParseResult<string> {
  return requireOptionValue("--model", raw);
}

export function parseSkillName(raw: string | undefined): ParseResult<string> {
  return requireOptionValue("--skill", raw);
}

export function parseTrials(raw: string | undefined): ParseResult<number> {
  const result = trialsSchema.safeParse(raw);
  if (!result.success) {
    return parseError("Error: --trials must be a positive integer.");
  }
  return parseOk(result.data);
}

export function parseForkBeforeMessage(
  raw: string | undefined,
): ParseResult<string> {
  return requireOptionValue("--fork-before-message", raw);
}

export function parseBeforeMessage(
  raw: string | undefined,
): ParseResult<string> {
  return requireOptionValue("--before-message", raw);
}

export function requireOptionValue(
  option: string,
  raw: string | undefined,
): ParseResult<string> {
  if (raw === undefined || raw === "") {
    return parseError(`Error: ${option} requires a value.`);
  }
  return parseOk(raw);
}

export function requireSeparatedOptionValue(
  option: string,
  raw: string | undefined,
  recognizedOptions: readonly string[],
): ParseResult<string> {
  const parsed = requireOptionValue(option, raw);
  if (!parsed.ok) return parsed;
  if (isRecognizedOptionToken(parsed.value, recognizedOptions)) {
    return parseError(
      `Error: ${option} requires a value, but got option "${parsed.value}".`,
    );
  }
  return parsed;
}

export function isRecognizedOptionToken(
  token: string,
  recognizedOptions: readonly string[],
): boolean {
  if (!token.startsWith("--")) return false;
  const equalsIndex = token.indexOf("=");
  const optionName = equalsIndex === -1 ? token : token.slice(0, equalsIndex);
  return recognizedOptions.includes(optionName);
}
