import { join } from "node:path";
import { z } from "zod";
import { errorMessage } from "../core/error.ts";
import {
  PrivateStateError,
  privateStateRootPath,
  readPrivateStateFile,
  writePrivateStateFile,
} from "../core/private-state.ts";
import {
  type ApiKeyProviderId,
  type ProviderId,
  providerIds,
} from "../core/provider-id.ts";

interface ProviderUserConfigRuntime {
  readonly env: (key: string) => string | undefined;
}

export interface UserProviderConfig {
  readonly providerId: ProviderId;
  readonly model?: string;
  readonly baseUrl?: string;
}

export class ProviderUserConfigError extends Error {}

const providerConfigFileSchema = z
  .object({
    schemaVersion: z.literal(1),
    provider: z
      .object({
        id: z.enum(providerIds),
        model: z.string().min(1).optional(),
        baseUrl: z.string().min(1).optional(),
      })
      .strict(),
  })
  .strict();
const providerAuthCredentialSchema = z
  .object({
    apiKey: z.string().min(1),
  })
  .strict();
const providerAuthFileSchema = z
  .object({
    schemaVersion: z.literal(1),
    providers: z
      .object({
        deepseek: providerAuthCredentialSchema.optional(),
        kimi: providerAuthCredentialSchema.optional(),
        qwen: providerAuthCredentialSchema.optional(),
      })
      .strict(),
  })
  .strict();

type ProviderConfigFile = z.infer<typeof providerConfigFileSchema>;
type ProviderAuthFile = z.infer<typeof providerAuthFileSchema>;
type ProviderAuthProviders = ProviderAuthFile["providers"];
type ProviderAuthCredential = z.infer<typeof providerAuthCredentialSchema>;

function userConfigError(message: string): never {
  throw new ProviderUserConfigError(message);
}

function userProviderConfigPath(runtime: ProviderUserConfigRuntime): string {
  return join(privateStateRootPath(runtime), "config.json");
}

function userProviderAuthPath(runtime: ProviderUserConfigRuntime): string {
  return join(privateStateRootPath(runtime), "auth.json");
}

function readOptionalJsonFile(
  runtime: ProviderUserConfigRuntime,
  fileName: "auth.json" | "config.json",
  label: string,
  options: { readonly missingParentAsAbsent: boolean },
): unknown | null {
  const filePath = join(privateStateRootPath(runtime), fileName);
  let content: string;
  try {
    const stored = readPrivateStateFile({
      runtime,
      segments: [fileName],
      label,
    });
    if (stored === null) return null;
    content = stored;
  } catch (error) {
    if (
      options.missingParentAsAbsent &&
      error instanceof PrivateStateError &&
      error.reason === "not_directory"
    ) {
      return null;
    }
    userConfigError(
      `Error: cannot read ${label} ${filePath}: ${errorMessage(error)}`,
    );
  }

  try {
    return JSON.parse(content);
  } catch {
    userConfigError(`Error: cannot read ${label} ${filePath}: invalid JSON.`);
  }
}

function invalidFileMessage(
  label: string,
  filePath: string,
  result: z.ZodError,
): string {
  const message = result.issues
    .map((issue) => issue.message)
    .slice(0, 1)
    .join("");
  return `Error: cannot read ${label} ${filePath}: ${message}.`;
}

function readProviderConfigFile(
  runtime: ProviderUserConfigRuntime,
  options: { readonly missingParentAsAbsent: boolean },
): ProviderConfigFile | null {
  const filePath = userProviderConfigPath(runtime);
  const json = readOptionalJsonFile(
    runtime,
    "config.json",
    "provider config",
    options,
  );
  if (json === null) {
    return null;
  }
  const result = providerConfigFileSchema.safeParse(json);
  if (!result.success) {
    userConfigError(
      invalidFileMessage("provider config", filePath, result.error),
    );
  }
  return result.data;
}

function readProviderAuthFile(
  runtime: ProviderUserConfigRuntime,
  options: { readonly missingParentAsAbsent: boolean },
): ProviderAuthFile {
  const filePath = userProviderAuthPath(runtime);
  const json = readOptionalJsonFile(
    runtime,
    "auth.json",
    "provider auth",
    options,
  );
  if (json === null) {
    return { schemaVersion: 1, providers: {} };
  }
  const result = providerAuthFileSchema.safeParse(json);
  if (!result.success) {
    userConfigError(
      invalidFileMessage("provider auth", filePath, result.error),
    );
  }
  return result.data;
}

function writePrivateJsonFile(
  runtime: ProviderUserConfigRuntime,
  fileName: "auth.json" | "config.json",
  label: string,
  data: unknown,
): void {
  const filePath = join(privateStateRootPath(runtime), fileName);
  try {
    writePrivateStateFile({
      runtime,
      segments: [fileName],
      label,
      content: `${JSON.stringify(data, null, 2)}\n`,
    });
  } catch (error) {
    userConfigError(
      `Error: cannot write ${label} ${filePath}: ${errorMessage(error)}`,
    );
  }
}

function configFromFile(file: ProviderConfigFile): UserProviderConfig {
  return {
    providerId: file.provider.id,
    ...(file.provider.model !== undefined
      ? { model: file.provider.model }
      : {}),
    ...(file.provider.baseUrl !== undefined
      ? { baseUrl: file.provider.baseUrl }
      : {}),
  };
}

function configFileFromInput(input: UserProviderConfig): ProviderConfigFile {
  return {
    schemaVersion: 1,
    provider: {
      id: input.providerId,
      ...(input.model !== undefined ? { model: input.model } : {}),
      ...(input.baseUrl !== undefined ? { baseUrl: input.baseUrl } : {}),
    },
  };
}

export function readUserProviderConfig(
  runtime: ProviderUserConfigRuntime,
): UserProviderConfig | null {
  const file = readProviderConfigFile(runtime, {
    missingParentAsAbsent: false,
  });
  return file === null ? null : configFromFile(file);
}

export function readOptionalUserProviderConfig(
  runtime: ProviderUserConfigRuntime,
): UserProviderConfig | null {
  const file = readProviderConfigFile(runtime, {
    missingParentAsAbsent: true,
  });
  return file === null ? null : configFromFile(file);
}

export function writeUserProviderConfig(
  runtime: ProviderUserConfigRuntime,
  input: UserProviderConfig,
): void {
  writePrivateJsonFile(
    runtime,
    "config.json",
    "provider config",
    configFileFromInput(input),
  );
}

function credentialForProvider(
  providers: ProviderAuthProviders,
  providerId: ProviderId,
): ProviderAuthCredential | null {
  const credentials: Readonly<
    Record<ProviderId, ProviderAuthCredential | null>
  > = {
    deepseek: providers.deepseek ?? null,
    kimi: providers.kimi ?? null,
    qwen: providers.qwen ?? null,
    fake: null,
  };
  return credentials[providerId];
}

function providersWithCredential(
  providers: ProviderAuthProviders,
  providerId: ApiKeyProviderId,
  credential: ProviderAuthCredential,
): ProviderAuthProviders {
  switch (providerId) {
    case "deepseek":
      return { ...providers, deepseek: credential };
    case "kimi":
      return { ...providers, kimi: credential };
    case "qwen":
      return { ...providers, qwen: credential };
  }
}

function providersWithoutCredential(
  providers: ProviderAuthProviders,
  providerId: ApiKeyProviderId,
): ProviderAuthProviders {
  switch (providerId) {
    case "deepseek": {
      const { deepseek, ...remaining } = providers;
      return remaining;
    }
    case "kimi": {
      const { kimi, ...remaining } = providers;
      return remaining;
    }
    case "qwen": {
      const { qwen, ...remaining } = providers;
      return remaining;
    }
  }
}

export function readProviderAuthApiKey(
  runtime: ProviderUserConfigRuntime,
  providerId: ProviderId,
): string | null {
  return (
    credentialForProvider(
      readProviderAuthFile(runtime, { missingParentAsAbsent: true }).providers,
      providerId,
    )?.apiKey ?? null
  );
}

export function writeProviderAuthApiKey(
  runtime: ProviderUserConfigRuntime,
  providerId: ApiKeyProviderId,
  apiKey: string,
): void {
  const file = readProviderAuthFile(runtime, {
    missingParentAsAbsent: false,
  });
  writePrivateJsonFile(runtime, "auth.json", "provider auth", {
    schemaVersion: 1,
    providers: providersWithCredential(file.providers, providerId, {
      apiKey,
    }),
  });
}

export function removeProviderAuthApiKey(
  runtime: ProviderUserConfigRuntime,
  providerId: ApiKeyProviderId,
): boolean {
  const file = readProviderAuthFile(runtime, {
    missingParentAsAbsent: false,
  });
  const hadCredential =
    credentialForProvider(file.providers, providerId) !== null;
  writePrivateJsonFile(runtime, "auth.json", "provider auth", {
    schemaVersion: 1,
    providers: providersWithoutCredential(file.providers, providerId),
  });
  return hadCredential;
}

export function providerAuthStatus(
  runtime: ProviderUserConfigRuntime,
): readonly {
  readonly providerId: ProviderId;
  readonly status: "not-required" | "present" | "missing";
}[] {
  const file = readProviderAuthFile(runtime, {
    missingParentAsAbsent: false,
  });
  return providerIds.map((providerId) => {
    if (providerId === "fake") {
      return { providerId, status: "not-required" };
    }
    return {
      providerId,
      status:
        credentialForProvider(file.providers, providerId) === null
          ? "missing"
          : "present",
    };
  });
}
