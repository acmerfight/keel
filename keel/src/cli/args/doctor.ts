import {
  type ParseResult,
  parseError,
  parseModel,
  parseOk,
  parseProviderId,
} from "./shared.ts";
import type { DoctorCliArgs } from "./types.ts";

export function parseDoctorArgs(
  args: readonly string[],
): ParseResult<DoctorCliArgs> {
  let providerId: DoctorCliArgs["providerId"] | undefined;
  let model: string | undefined;
  const providerPrefix = "--provider=";
  const modelPrefix = "--model=";
  let offline = false;

  let skipNext = false;
  for (const [index, arg] of args.entries()) {
    if (skipNext) {
      skipNext = false;
      continue;
    }

    if (arg === "--provider") {
      const parsed = parseProviderId(args[index + 1]);
      if (!parsed.ok) return parsed;
      providerId = parsed.value;
      skipNext = true;
      continue;
    }

    if (arg.startsWith(providerPrefix)) {
      const parsed = parseProviderId(arg.slice(providerPrefix.length));
      if (!parsed.ok) return parsed;
      providerId = parsed.value;
      continue;
    }

    if (arg === "--model") {
      const parsed = parseModel(args[index + 1]);
      if (!parsed.ok) return parsed;
      model = parsed.value;
      skipNext = true;
      continue;
    }

    if (arg.startsWith(modelPrefix)) {
      const parsed = parseModel(arg.slice(modelPrefix.length));
      if (!parsed.ok) return parsed;
      model = parsed.value;
      continue;
    }

    if (arg === "--offline") {
      offline = true;
      continue;
    }

    return parseError(`Error: unknown doctor option "${arg}"`);
  }

  return parseOk({
    command: "doctor",
    offline,
    ...(providerId !== undefined ? { providerId } : {}),
    ...(model !== undefined ? { model } : {}),
  });
}
