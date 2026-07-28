import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  type CallToolResult,
  Client,
  fromJsonSchema,
  type JsonSchemaType,
  type jsonSchemaValidator,
  type ProtocolEra,
  StreamableHTTPClientTransport,
  specTypeSchemas,
  type Tool,
} from "@modelcontextprotocol/client";
import {
  Ajv,
  AjvJsonSchemaValidator,
  addFormats,
} from "@modelcontextprotocol/client/validators/ajv";
import { z } from "zod";
import { errorMessage } from "../core/error.ts";
import { createMcpPolicyFetch, validateMcpServerUrl } from "./network.ts";
import {
  isMcpAuthenticationRequiredError,
  type McpRuntimeAuthProvider,
} from "./oauth.ts";
import {
  compileMcpProviderInputSchema,
  MCP_LOCAL_REFERENCE_CYCLE_SCAN_LIMITS,
  MCP_PROVIDER_SCHEMA_REFERENCE_LIMITS,
  type McpProviderSchemaTarget,
  scanMcpDegenerateLocalReferenceCycle,
} from "./provider-schema.ts";

const MCP_CLIENT_NAME = "keel";
const MCP_CONNECT_TIMEOUT_MS = 10_000;
const MCP_DISCOVERY_TIMEOUT_MS = 10_000;
const MCP_CALL_TIMEOUT_MS = 30_000;
const MCP_CALL_MAX_TOTAL_TIMEOUT_MS = 60_000;
const MCP_MAX_CATALOG_TOOLS = 1_000;
const MCP_MAX_CATALOG_PAGES = 64;
const MCP_MAX_CATALOG_BYTES = 8 * 1024 * 1024;
const MCP_MAX_CURSOR_LENGTH = 1_024;
const MCP_MAX_TOOL_DESCRIPTOR_BYTES = 64 * 1024;
const MCP_MAX_JSON_DEPTH = 32;
const MCP_MAX_DIAGNOSTIC_ISSUES = 10;
const MCP_ERROR_MAX_LENGTH = 300;
const MCP_IDENTITY_MAX_LENGTH = 256;
const MCP_HEADER_SCHEMA_KEY = "x-mcp-header";
const MCP_HEADER_TOKEN_PATTERN = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/u;
const MCP_HEADER_PRIMITIVE_TYPES = new Set([
  "string",
  "integer",
  "boolean",
  // Stable SDK conformance accepts number despite the current spec text.
  "number",
]);
const MCP_HEADER_UNREACHABLE_SCHEMA_KEYS = [
  "items",
  "prefixItems",
  "contains",
  "additionalProperties",
  "unevaluatedProperties",
  "unevaluatedItems",
  "propertyNames",
  "patternProperties",
  "dependentSchemas",
  "oneOf",
  "anyOf",
  "allOf",
  "not",
  "if",
  "then",
  "else",
  "$defs",
  "definitions",
] as const;
const MCP_HEADER_OBJECT_SCHEMA_KEYS = new Set([
  "patternProperties",
  "dependentSchemas",
  "$defs",
  "definitions",
]);
const MCP_JSON_SCHEMA_DRAFT_07_URIS = new Set([
  "http://json-schema.org/draft-07/schema",
  "http://json-schema.org/draft-07/schema#",
  "https://json-schema.org/draft-07/schema",
  "https://json-schema.org/draft-07/schema#",
]);

const jsonObjectSchema = z.record(z.string(), z.json());
const jsonSchemaDialectSchema = z
  .object({
    $id: z.json().optional(),
    $schema: z.string().optional(),
  })
  .passthrough();
const jsonSchemaNodeSchema = z
  .object({
    type: z.json().optional(),
    properties: z.json().optional(),
    [MCP_HEADER_SCHEMA_KEY]: z.json().optional(),
  })
  .catchall(z.json());
const inputObjectJsonSchema = jsonObjectSchema.superRefine(
  (schema, context) => {
    const type = Object.entries(schema).find(([key]) => key === "type")?.[1];
    if (type !== undefined && type !== "object") {
      context.addIssue({
        code: "custom",
        message: "schema.type must be object when present",
      });
    }
  },
);
const toolDescriptorSchema = z
  .object({
    name: z.string().min(1).max(128),
    title: z.string().max(256).optional(),
    description: z.string().max(4_096).optional(),
    inputSchema: inputObjectJsonSchema,
    outputSchema: jsonSchemaNodeSchema.optional(),
  })
  .passthrough();
const catalogPageSchema = z
  .object({
    tools: z.array(z.json()),
    nextCursor: z
      .string()
      .max(
        MCP_MAX_CURSOR_LENGTH,
        `pagination cursor exceeds ${MCP_MAX_CURSOR_LENGTH} characters`,
      )
      .optional(),
  })
  .passthrough();
const packageJsonSchema = z.object({ version: z.string().min(1) });
const sdkJsonSchemaBoundarySchema = z.custom<JsonSchemaType>((value) => {
  return jsonObjectSchema.safeParse(value).success;
});
export type McpJsonValue = z.infer<ReturnType<typeof z.json>>;

export interface McpServerEndpoint {
  readonly url: string;
  readonly allowPrivateNetwork: boolean;
  readonly authenticationRequired: boolean;
}

interface McpCatalogIssue {
  readonly tool: string;
  readonly reason: string;
}

interface McpJsonSchemaValidators {
  readonly defaultDialect: jsonSchemaValidator;
  readonly draft07: jsonSchemaValidator;
}

type McpCompiledJsonSchema =
  | {
      readonly ok: true;
      readonly validator: ReturnType<typeof fromJsonSchema>["~standard"];
    }
  | {
      readonly ok: false;
      readonly reason: string;
    };

interface McpCatalogSummary {
  readonly total: number;
  readonly valid: number;
  readonly quarantined: number;
  readonly digest: string;
  readonly issues: readonly McpCatalogIssue[];
}

interface McpProviderCatalogSummary {
  readonly target: McpProviderSchemaTarget;
  readonly usable: number;
  readonly quarantined: number;
  readonly validationWidened: number;
  readonly issues: readonly McpCatalogIssue[];
  readonly wideningIssues: readonly McpCatalogIssue[];
}

export interface McpCatalogTool {
  readonly descriptor: Tool;
  readonly descriptorDigest: string;
  readonly validateArguments: (value: unknown) => Promise<readonly string[]>;
  readonly validateOutput:
    | ((value: unknown) => Promise<readonly string[]>)
    | null;
}

export interface McpCatalog {
  readonly summary: McpCatalogSummary;
  readonly tools: readonly McpCatalogTool[];
}

export type McpDiscoveryStatus =
  | {
      readonly status: "ready";
      readonly protocolEra: ProtocolEra;
      readonly protocolVersion: string;
      readonly serverIdentity: string | null;
      readonly catalog: McpCatalogSummary;
      readonly provider: McpProviderCatalogSummary;
      readonly latencyMs: number;
    }
  | {
      readonly status: "needs-auth";
      readonly latencyMs: number;
    }
  | {
      readonly status: "failed";
      readonly error: string;
      readonly latencyMs: number;
    };

function boundedDiagnosticText(value: string, maxLength: number): string {
  return [...value]
    .map((character) => {
      const codeUnit = character.charCodeAt(0);
      return codeUnit <= 0x1f || codeUnit === 0x7f ? " " : character;
    })
    .join("")
    .replace(/\s+/gu, " ")
    .trim()
    .slice(0, maxLength);
}

function canonicalJson(value: McpJsonValue, depth = 0): string {
  if (depth >= MCP_MAX_JSON_DEPTH) {
    return JSON.stringify("<depth-limit>");
  }
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((item) => canonicalJson(item, depth + 1)).join(",")}]`;
  }
  return `{${Object.entries(value)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(
      ([key, item]) =>
        `${JSON.stringify(key)}:${canonicalJson(item, depth + 1)}`,
    )
    .join(",")}}`;
}

function exceedsJsonDepth(value: McpJsonValue, depth = 0): boolean {
  if (value === null || typeof value !== "object") return false;
  if (depth >= MCP_MAX_JSON_DEPTH) return true;
  return Array.isArray(value)
    ? value.some((item) => exceedsJsonDepth(item, depth + 1))
    : Object.values(value).some((item) => exceedsJsonDepth(item, depth + 1));
}

function keelVersion(): string {
  const packageJson = JSON.parse(
    readFileSync(join(import.meta.dirname, "../../package.json"), "utf8"),
  );
  return packageJsonSchema.parse(packageJson).version;
}

export function createMcpSdkClient(): Client {
  return new Client(
    { name: MCP_CLIENT_NAME, version: keelVersion() },
    {
      listMaxPages: MCP_MAX_CATALOG_PAGES,
      versionNegotiation: {
        mode: "auto",
        probe: {
          timeoutMs: MCP_DISCOVERY_TIMEOUT_MS,
          maxRetries: 0,
        },
      },
    },
  );
}

function toolLabel(value: unknown, index: number): string {
  const named = z.object({ name: z.string().min(1) }).safeParse(value);
  if (!named.success) return `tool #${index + 1}`;
  const safeName = boundedDiagnosticText(named.data.name, 160);
  return safeName === "" ? `tool #${index + 1}` : safeName;
}

function toolIssueReason(error: z.ZodError): string {
  return error.issues.map((issue) => issue.message).join("; ");
}

function sdkToolIssueReason(
  issues: readonly { readonly message: string }[],
): string {
  return issues.map((issue) => issue.message).join("; ");
}

function schemaPath(path: readonly string[]): string {
  return path.length === 0 ? "<root>" : path.join(".");
}

function xMcpHeaderIssue(inputSchema: McpJsonValue): string | null {
  const seenHeaders = new Map<string, string>();

  function visit(
    value: McpJsonValue,
    path: readonly string[],
    reachable: boolean,
  ): string | null {
    const parsed = jsonSchemaNodeSchema.safeParse(value);
    if (!parsed.success) return null;
    const schema = parsed.data;
    const rawHeader = schema[MCP_HEADER_SCHEMA_KEY];
    if (rawHeader !== undefined) {
      if (!reachable || path.length === 0) {
        return `${schemaPath(path)} is not reachable only through properties`;
      }
      if (typeof rawHeader !== "string" || rawHeader.length === 0) {
        return `${schemaPath(path)} must declare a non-empty string`;
      }
      if (!MCP_HEADER_TOKEN_PATTERN.test(rawHeader)) {
        return `${schemaPath(path)} declares an invalid HTTP header token`;
      }
      const type = schema.type;
      if (typeof type !== "string" || !MCP_HEADER_PRIMITIVE_TYPES.has(type)) {
        return `${schemaPath(path)} must have a primitive schema type`;
      }
      const normalizedHeader = rawHeader.toLowerCase();
      const prior = seenHeaders.get(normalizedHeader);
      if (prior !== undefined) {
        return `${rawHeader} duplicates ${prior} case-insensitively`;
      }
      seenHeaders.set(normalizedHeader, rawHeader);
    }

    const properties = jsonObjectSchema.safeParse(schema.properties);
    if (properties.success) {
      for (const [name, property] of Object.entries(properties.data)) {
        const issue = visit(property, [...path, name], reachable);
        if (issue !== null) return issue;
      }
    }

    for (const keyword of MCP_HEADER_UNREACHABLE_SCHEMA_KEYS) {
      const subschema = schema[keyword];
      if (subschema === undefined) continue;
      const objectSubschema = jsonObjectSchema.safeParse(subschema);
      const branches = Array.isArray(subschema)
        ? subschema
        : MCP_HEADER_OBJECT_SCHEMA_KEYS.has(keyword) && objectSubschema.success
          ? Object.values(objectSubschema.data)
          : [subschema];
      for (const branch of branches) {
        const issue = visit(branch, [...path, `<${keyword}>`], false);
        if (issue !== null) return issue;
      }
    }
    return null;
  }

  return visit(inputSchema, [], true);
}

function compileJsonSchema(
  schema: z.infer<typeof jsonObjectSchema>,
  validator: jsonSchemaValidator,
  path: "inputSchema" | "outputSchema",
): McpCompiledJsonSchema {
  try {
    const sdkSchema = sdkJsonSchemaBoundarySchema.parse(schema);
    return {
      ok: true,
      validator: fromJsonSchema(sdkSchema, validator)["~standard"],
    };
  } catch (error) {
    let diagnostic = sanitizedError(error);
    if (error instanceof RangeError) {
      const cycleScan = scanMcpDegenerateLocalReferenceCycle(
        schema,
        path,
        MCP_LOCAL_REFERENCE_CYCLE_SCAN_LIMITS,
      );
      if (cycleScan.status === "cycle") {
        diagnostic = boundedDiagnosticText(
          cycleScan.diagnostic,
          MCP_ERROR_MAX_LENGTH,
        );
      }
    }
    return {
      ok: false,
      reason: `invalid JSON Schema: ${diagnostic}`,
    };
  }
}

function createMcpJsonSchemaValidators(): McpJsonSchemaValidators {
  const draft07Ajv = new Ajv({
    strict: false,
    validateFormats: true,
    validateSchema: false,
    allErrors: true,
  });
  addFormats(draft07Ajv);
  return {
    defaultDialect: new AjvJsonSchemaValidator(),
    draft07: new AjvJsonSchemaValidator(draft07Ajv),
  };
}

function jsonSchemaValidatorFor(
  schema: z.infer<typeof jsonObjectSchema>,
  validators: McpJsonSchemaValidators,
): jsonSchemaValidator {
  const dialect = jsonSchemaDialectSchema.parse(schema).$schema;
  if (dialect === undefined || !MCP_JSON_SCHEMA_DRAFT_07_URIS.has(dialect)) {
    return validators.defaultDialect;
  }
  return validators.draft07;
}

function jsonSchemaIdentifier(
  schema: z.infer<typeof jsonObjectSchema>,
): string | null {
  const identifier = jsonSchemaDialectSchema.parse(schema).$id;
  return typeof identifier === "string"
    ? identifier.replace(/#\/?$/u, "")
    : null;
}

function conflictingJsonSchemaIdentifiers(
  tools: readonly McpJsonValue[],
): ReadonlySet<string> {
  const contentByIdentifier = new Map<string, string>();
  const conflicts = new Set<string>();
  for (const tool of tools) {
    const parsed = toolDescriptorSchema.safeParse(tool);
    if (!parsed.success) continue;
    const schemas = [
      parsed.data.inputSchema,
      ...(parsed.data.outputSchema === undefined
        ? []
        : [parsed.data.outputSchema]),
    ];
    for (const schema of schemas) {
      const identifier = jsonSchemaIdentifier(schema);
      if (identifier === null) continue;
      const content = canonicalJson(schema);
      const priorContent = contentByIdentifier.get(identifier);
      if (priorContent === undefined) {
        contentByIdentifier.set(identifier, content);
      } else if (priorContent !== content) {
        conflicts.add(identifier);
      }
    }
  }
  return conflicts;
}

function legacyOutputSchemaIssue(
  schema: z.infer<typeof jsonSchemaNodeSchema> | undefined,
): string | null {
  if (schema === undefined || schema.type === "object") return null;
  return "output schema.type must be object under the legacy protocol";
}

function appendCatalogIssue(
  issues: McpCatalogIssue[],
  issue: McpCatalogIssue,
): void {
  if (issues.length >= MCP_MAX_DIAGNOSTIC_ISSUES) return;
  issues.push(issue);
}

export async function buildMcpCatalog(
  tools: readonly McpJsonValue[],
  protocolEra: ProtocolEra,
): Promise<McpCatalog> {
  const issues: McpCatalogIssue[] = [];
  const validated: McpCatalogTool[] = [];
  const jsonSchemaValidators = createMcpJsonSchemaValidators();
  const conflictingIdentifiers = conflictingJsonSchemaIdentifiers(tools);
  for (const [index, tool] of tools.entries()) {
    if (exceedsJsonDepth(tool)) {
      appendCatalogIssue(issues, {
        tool: toolLabel(tool, index),
        reason: `descriptor exceeds ${MCP_MAX_JSON_DEPTH} JSON levels`,
      });
      continue;
    }
    const descriptorBytes = Buffer.byteLength(JSON.stringify(tool), "utf8");
    if (descriptorBytes > MCP_MAX_TOOL_DESCRIPTOR_BYTES) {
      appendCatalogIssue(issues, {
        tool: toolLabel(tool, index),
        reason: `descriptor exceeds ${MCP_MAX_TOOL_DESCRIPTOR_BYTES} bytes`,
      });
      continue;
    }
    const parsed = toolDescriptorSchema.safeParse(tool);
    if (!parsed.success) {
      appendCatalogIssue(issues, {
        tool: toolLabel(tool, index),
        reason: toolIssueReason(parsed.error),
      });
      continue;
    }
    const sdkParsed = await specTypeSchemas.Tool["~standard"].validate(
      parsed.data,
    );
    if (sdkParsed.issues !== undefined) {
      appendCatalogIssue(issues, {
        tool: toolLabel(tool, index),
        reason: sdkToolIssueReason(sdkParsed.issues),
      });
      continue;
    }
    const headerIssue =
      protocolEra === "modern"
        ? xMcpHeaderIssue(parsed.data.inputSchema)
        : null;
    if (headerIssue !== null) {
      appendCatalogIssue(issues, {
        tool: boundedDiagnosticText(parsed.data.name, 160),
        reason: `invalid x-mcp-header: ${headerIssue}`,
      });
      continue;
    }
    const conflictingIdentifier = [
      jsonSchemaIdentifier(parsed.data.inputSchema),
      ...(parsed.data.outputSchema === undefined
        ? []
        : [jsonSchemaIdentifier(parsed.data.outputSchema)]),
    ].find(
      (identifier) =>
        identifier !== null && conflictingIdentifiers.has(identifier),
    );
    if (typeof conflictingIdentifier === "string") {
      appendCatalogIssue(issues, {
        tool: boundedDiagnosticText(parsed.data.name, 160),
        reason: `conflicting JSON Schema identifier: ${boundedDiagnosticText(
          conflictingIdentifier,
          160,
        )}`,
      });
      continue;
    }
    const inputJsonSchemaValidator = jsonSchemaValidatorFor(
      parsed.data.inputSchema,
      jsonSchemaValidators,
    );
    const outputJsonSchemaValidator =
      parsed.data.outputSchema === undefined
        ? null
        : jsonSchemaValidatorFor(
            parsed.data.outputSchema,
            jsonSchemaValidators,
          );
    const inputCompilation = compileJsonSchema(
      parsed.data.inputSchema,
      inputJsonSchemaValidator,
      "inputSchema",
    );
    if (!inputCompilation.ok) {
      appendCatalogIssue(issues, {
        tool: boundedDiagnosticText(parsed.data.name, 160),
        reason: inputCompilation.reason,
      });
      continue;
    }
    const legacyOutputIssue =
      protocolEra === "legacy"
        ? legacyOutputSchemaIssue(parsed.data.outputSchema)
        : null;
    if (legacyOutputIssue !== null) {
      appendCatalogIssue(issues, {
        tool: boundedDiagnosticText(parsed.data.name, 160),
        reason: legacyOutputIssue,
      });
      continue;
    }
    const outputCompilation =
      parsed.data.outputSchema === undefined ||
      outputJsonSchemaValidator === null
        ? null
        : compileJsonSchema(
            parsed.data.outputSchema,
            outputJsonSchemaValidator,
            "outputSchema",
          );
    if (outputCompilation !== null && !outputCompilation.ok) {
      appendCatalogIssue(issues, {
        tool: boundedDiagnosticText(parsed.data.name, 160),
        reason: outputCompilation.reason,
      });
      continue;
    }
    const outputValidator =
      outputCompilation === null ? null : outputCompilation.validator;
    validated.push({
      descriptor: sdkParsed.value,
      descriptorDigest: createHash("sha256")
        .update(canonicalJson(tool))
        .digest("hex"),
      validateArguments: async (value) => {
        const validation = await inputCompilation.validator.validate(value);
        return validation.issues?.map((issue) => issue.message) ?? [];
      },
      validateOutput:
        outputValidator === null
          ? null
          : async (value) => {
              const validation = await outputValidator.validate(value);
              return validation.issues?.map((issue) => issue.message) ?? [];
            },
    });
  }
  const duplicateNames = new Set<string>();
  const seenNames = new Set<string>();
  for (const tool of validated) {
    if (seenNames.has(tool.descriptor.name)) {
      duplicateNames.add(tool.descriptor.name);
    }
    seenNames.add(tool.descriptor.name);
  }
  for (const name of duplicateNames) {
    appendCatalogIssue(issues, {
      tool: boundedDiagnosticText(name, 160),
      reason: "duplicate raw tool name",
    });
  }
  const usableTools = validated.filter(
    (tool) => !duplicateNames.has(tool.descriptor.name),
  );
  const digest = createHash("sha256")
    .update(canonicalJson([...tools]))
    .digest("hex");
  return {
    summary: {
      total: tools.length,
      valid: usableTools.length,
      quarantined: tools.length - usableTools.length,
      digest,
      issues,
    },
    tools: usableTools,
  };
}

function summarizeProviderCatalog(
  catalog: McpCatalog,
  target: McpProviderSchemaTarget,
): McpProviderCatalogSummary {
  const issues: McpCatalogIssue[] = [];
  const wideningIssues: McpCatalogIssue[] = [];
  let usable = 0;
  let validationWidened = 0;
  for (const tool of catalog.tools) {
    const compilation = compileMcpProviderInputSchema(
      tool.descriptor.inputSchema,
      {
        target,
        referenceLimits: MCP_PROVIDER_SCHEMA_REFERENCE_LIMITS,
      },
    );
    if (!compilation.ok) {
      appendCatalogIssue(issues, {
        tool: boundedDiagnosticText(tool.descriptor.name, 160),
        reason: compilation.reason,
      });
      continue;
    }
    usable += 1;
    if (compilation.fidelity === "validation-widened") {
      validationWidened += 1;
      appendCatalogIssue(wideningIssues, {
        tool: boundedDiagnosticText(tool.descriptor.name, 160),
        reason: compilation.validationWideningDiagnostics.join("; "),
      });
    }
  }
  return {
    target,
    usable,
    quarantined: catalog.tools.length - usable,
    validationWidened,
    issues,
    wideningIssues,
  };
}

async function listCatalogTools(
  client: Client,
  signal?: AbortSignal,
): Promise<readonly McpJsonValue[]> {
  if (client.getServerCapabilities()?.tools === undefined) return [];

  const tools: McpJsonValue[] = [];
  const seenCursors = new Set<string>();
  let catalogBytes = 0;
  let cursor: string | undefined;
  for (let page = 1; page <= MCP_MAX_CATALOG_PAGES; page += 1) {
    const result = await client.request(
      {
        method: "tools/list",
        params: cursor === undefined ? {} : { cursor },
      },
      catalogPageSchema,
      {
        timeout: MCP_DISCOVERY_TIMEOUT_MS,
        ...(signal !== undefined ? { signal } : {}),
      },
    );
    if (tools.length + result.tools.length > MCP_MAX_CATALOG_TOOLS) {
      throw new Error(
        `catalog contains more than ${MCP_MAX_CATALOG_TOOLS} tools`,
      );
    }
    for (const tool of result.tools) {
      catalogBytes += Buffer.byteLength(JSON.stringify(tool), "utf8");
      if (catalogBytes > MCP_MAX_CATALOG_BYTES) {
        throw new Error(
          `catalog descriptors exceed ${MCP_MAX_CATALOG_BYTES} bytes`,
        );
      }
    }
    tools.push(...result.tools);
    if (result.nextCursor === undefined) return tools;
    if (seenCursors.has(result.nextCursor)) {
      throw new Error(
        `tools/list pagination repeated cursor after page ${page}`,
      );
    }
    seenCursors.add(result.nextCursor);
    cursor = result.nextCursor;
  }
  throw new Error(`tools/list exceeded ${MCP_MAX_CATALOG_PAGES} pages`);
}

export interface McpConnection {
  readonly protocolEra: ProtocolEra;
  readonly protocolVersion: string;
  readonly serverIdentity: string | null;
  readonly listCatalog: (signal?: AbortSignal) => Promise<McpCatalog>;
  readonly callTool: (
    tool: McpCatalogTool,
    arguments_: Readonly<Record<string, McpJsonValue>>,
    signal: AbortSignal,
  ) => Promise<CallToolResult>;
  readonly close: () => Promise<void>;
}

export async function connectMcpServer(
  server: McpServerEndpoint,
  signal?: AbortSignal,
  authProvider?: McpRuntimeAuthProvider,
): Promise<McpConnection> {
  const validated = validateMcpServerUrl(
    server.url,
    server.allowPrivateNetwork,
  );
  const network = createMcpPolicyFetch(validated);
  const transport = new StreamableHTTPClientTransport(validated.url, {
    authProvider: authProvider ?? { token: async () => undefined },
    fetch: authProvider?.wrapFetch(network.fetch) ?? network.fetch,
  });
  const client = createMcpSdkClient();
  try {
    await client.connect(transport, {
      timeout: MCP_CONNECT_TIMEOUT_MS,
      ...(signal !== undefined ? { signal } : {}),
    });
    const protocolEra = client.getProtocolEra();
    const protocolVersion = client.getNegotiatedProtocolVersion();
    /* v8 ignore next 3 -- the SDK connect contract sets both values before resolving; fail closed if a future SDK violates it. */
    if (protocolEra === undefined || protocolVersion === undefined) {
      throw new Error("MCP SDK connected without a negotiated protocol");
    }
    const identity = client.getServerVersion();
    let closed = false;
    return {
      protocolEra,
      protocolVersion,
      serverIdentity:
        identity === undefined
          ? null
          : boundedDiagnosticText(
              `${identity.name}@${identity.version}`,
              MCP_IDENTITY_MAX_LENGTH,
            ),
      listCatalog: async (listSignal) =>
        await buildMcpCatalog(
          await listCatalogTools(client, listSignal),
          protocolEra,
        ),
      callTool: async (tool, arguments_, signal) =>
        await client.callTool(
          { name: tool.descriptor.name, arguments: arguments_ },
          {
            signal,
            timeout: MCP_CALL_TIMEOUT_MS,
            maxTotalTimeout: MCP_CALL_MAX_TOTAL_TIMEOUT_MS,
            resetTimeoutOnProgress: false,
            toolDefinition: tool.descriptor,
          },
        ),
      close: async () => {
        if (closed) return;
        closed = true;
        const cleanup = await Promise.allSettled([
          client.close(),
          network.close(),
        ]);
        const cleanupFailure = cleanup.find(
          (result) => result.status === "rejected",
        );
        /* v8 ignore next 3 -- third-party client/transport cleanup faults are nondeterministic; close still surfaces the first failure. */
        if (cleanupFailure !== undefined) {
          throw cleanupFailure.reason;
        }
      },
    };
  } catch (error) {
    await Promise.allSettled([client.close(), network.close()]);
    throw error;
  }
}

function sanitizedError(error: unknown): string {
  const firstLine = errorMessage(error)
    .replace(/[\r\n][\s\S]*/u, "")
    .replace(/https?:\/\/[^\s"'<>]+/gu, (raw) => {
      try {
        const url = new URL(raw);
        url.username = "";
        url.password = "";
        url.search = "";
        url.hash = "";
        return url.href;
      } catch {
        return "<redacted-url>";
      }
    })
    .trim();
  /* v8 ignore next -- third-party failures can theoretically carry an empty message; preserve a useful fail-closed diagnostic. */
  return firstLine.slice(0, MCP_ERROR_MAX_LENGTH) || "MCP discovery failed";
}

export async function discoverMcpServer(options: {
  readonly server: McpServerEndpoint;
  readonly now: () => number;
  readonly authProvider: McpRuntimeAuthProvider | null;
  readonly schemaTarget: McpProviderSchemaTarget;
}): Promise<McpDiscoveryStatus> {
  const { server, now, authProvider, schemaTarget } = options;
  const startedAt = now();
  let connection: McpConnection | null = null;
  let status: McpDiscoveryStatus;
  try {
    connection = await connectMcpServer(
      server,
      undefined,
      authProvider ?? undefined,
    );
    const catalog = await connection.listCatalog();
    status = {
      status: "ready",
      protocolEra: connection.protocolEra,
      protocolVersion: connection.protocolVersion,
      serverIdentity: connection.serverIdentity,
      catalog: catalog.summary,
      provider: summarizeProviderCatalog(catalog, schemaTarget),
      latencyMs: Math.max(0, now() - startedAt),
    };
  } catch (error) {
    if (isMcpAuthenticationRequiredError(error)) {
      status = {
        status: "needs-auth",
        latencyMs: Math.max(0, now() - startedAt),
      };
    } else {
      status = {
        status: "failed",
        error: sanitizedError(error),
        latencyMs: Math.max(0, now() - startedAt),
      };
    }
  }

  const cleanup = await Promise.allSettled(
    connection === null ? [] : [connection.close()],
  );
  const cleanupFailure = cleanup.find((result) => result.status === "rejected");
  /* v8 ignore next 7 -- third-party transport/agent close failures are nondeterministic cleanup faults; discovery must still report them. */
  if (cleanupFailure?.status === "rejected") {
    return {
      status: "failed",
      error: `MCP cleanup failed: ${sanitizedError(cleanupFailure.reason)}`,
      latencyMs: Math.max(0, now() - startedAt),
    };
  }
  return status;
}
