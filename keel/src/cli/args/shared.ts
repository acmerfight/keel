import { z } from "zod";
import { type ProviderId, providerIds } from "../../core/provider-id.ts";
import type { BashPolicy } from "../../permissions/bash.ts";

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
const bashPolicySchema = z.enum(["ask", "deny", "trusted"]);
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

export function parseBashPolicy(
  raw: string | undefined,
): ParseResult<BashPolicy> {
  const result = bashPolicySchema.safeParse(raw);
  if (!result.success) {
    return parseError(
      "Error: --bash-policy must be one of: ask, deny, trusted.",
    );
  }
  return parseOk(result.data);
}

export function parseProviderId(
  raw: string | undefined,
): ParseResult<ProviderId> {
  const parsedValue = requireOptionValue("--provider", raw);
  if (!parsedValue.ok) return parsedValue;
  const result = providerIdSchema.safeParse(parsedValue.value);
  if (!result.success) {
    return parseError(
      "Error: --provider must be one of: fake, deepseek, kimi, qwen.",
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
