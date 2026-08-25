import {
  type ModelMetadata,
  modelMetadataMaxOutputTokens,
} from "../core/model-metadata.ts";
import type { ProviderId } from "../core/provider-id.ts";
import {
  type McpProviderSchemaTarget,
  mcpProviderSchemaTarget,
} from "../mcp/provider-schema.ts";

export interface AgentInvocationProvider {
  readonly providerId: ProviderId;
  readonly model: string;
  readonly modelMetadata?: ModelMetadata;
}

interface AgentInvocationContextValues {
  readonly schemaTarget: McpProviderSchemaTarget;
  readonly modelMaxOutputTokens?: number;
}

export type AgentInvocationContext<
  Provider extends AgentInvocationProvider = AgentInvocationProvider,
> = Provider & AgentInvocationContextValues;

export function createAgentInvocationContext<
  Provider extends AgentInvocationProvider,
>(provider: Provider): AgentInvocationContext<Provider> {
  const modelMaxOutputTokens = modelMetadataMaxOutputTokens(
    provider.modelMetadata,
  );
  return {
    ...provider,
    schemaTarget: mcpProviderSchemaTarget(provider.providerId, provider.model),
    ...(modelMaxOutputTokens === undefined ? {} : { modelMaxOutputTokens }),
  };
}
