import { lookup } from "node:dns";
import { isIP } from "node:net";
import ipaddr from "ipaddr.js";
import { Agent, buildConnector, fetch as undiciFetch } from "undici";
import { z } from "zod";

const MCP_MAX_REDIRECTS = 5;
const MCP_MAX_RESPONSE_BYTES = 8 * 1024 * 1024;
const MCP_NETWORK_TIMEOUT_MS = 10_000;
const BODY_REDIRECT_HEADERS = [
  "content-encoding",
  "content-language",
  "content-length",
  "content-location",
  "content-type",
] as const;
const CLOUD_METADATA_ADDRESSES = new Set([
  "100.100.100.200",
  "168.63.129.16",
  "169.254.169.254",
  "169.254.170.2",
  "fd00:ec2::254",
]);
const wrappedCauseSchema = z
  .object({
    cause: z.unknown(),
  })
  .passthrough();

type NetworkAccess = "public" | "loopback" | "private";

export interface ValidatedMcpServerUrl {
  readonly url: URL;
  readonly access: NetworkAccess;
}

export interface McpPolicyFetch {
  readonly fetch: (url: string | URL, init?: RequestInit) => Promise<Response>;
  readonly close: () => Promise<void>;
}

interface McpResolvedAddress {
  readonly address: string;
}

export interface McpNetworkRuntime {
  readonly resolve: (
    hostname: string,
    callback: (
      error: NodeJS.ErrnoException | null,
      addresses: readonly McpResolvedAddress[],
    ) => void,
  ) => void;
  readonly createConnector: () => ReturnType<typeof buildConnector>;
}

export class McpNetworkPolicyError extends Error {}

const defaultNetworkRuntime: McpNetworkRuntime = {
  resolve: (hostname, callback) => {
    lookup(hostname, { all: true, verbatim: true }, (error, addresses) => {
      callback(error, addresses);
    });
  },
  createConnector: () =>
    buildConnector({
      timeout: MCP_NETWORK_TIMEOUT_MS,
    }),
};

function networkPolicyCause(error: unknown): McpNetworkPolicyError | null {
  let current = error;
  for (let depth = 0; depth < 5; depth += 1) {
    if (current instanceof McpNetworkPolicyError) return current;
    const wrapped = wrappedCauseSchema.safeParse(current);
    if (!wrapped.success) return null;
    current = wrapped.data.cause;
  }
  /* v8 ignore next -- bounds traversal of adversarial third-party error cause chains. */
  return null;
}

function networkPolicyError(message: string): never {
  throw new McpNetworkPolicyError(message);
}

function hostnameWithoutBrackets(hostname: string): string {
  return hostname.startsWith("[") && hostname.endsWith("]")
    ? hostname.slice(1, -1)
    : hostname;
}

function parsedIpRange(address: string): string {
  const parsed = ipaddr.parse(address);
  if (parsed instanceof ipaddr.IPv6 && parsed.isIPv4MappedAddress()) {
    return parsed.toIPv4Address().range();
  }
  return parsed.range();
}

function normalizedIp(address: string): string {
  const parsed = ipaddr.parse(address);
  if (parsed instanceof ipaddr.IPv6 && parsed.isIPv4MappedAddress()) {
    return parsed.toIPv4Address().toString();
  }
  return parsed.toString();
}

function isCloudMetadataAddress(address: string): boolean {
  return CLOUD_METADATA_ADDRESSES.has(normalizedIp(address));
}

function addressAllowed(address: string, access: NetworkAccess): boolean {
  if (!ipaddr.isValid(address) || isCloudMetadataAddress(address)) return false;
  const range = parsedIpRange(address);
  if (access === "public") return range === "unicast";
  if (access === "loopback") return range === "loopback";
  return (
    range === "unicast" ||
    range === "private" ||
    range === "uniqueLocal" ||
    range === "loopback"
  );
}

function literalHostAccess(hostname: string): NetworkAccess | null {
  const unbracketed = hostnameWithoutBrackets(hostname);
  if (unbracketed === "localhost" || unbracketed.endsWith(".localhost")) {
    return "loopback";
  }
  if (isIP(unbracketed) === 0) return null;
  return parsedIpRange(unbracketed) === "loopback" ? "loopback" : "public";
}

function parseMcpUrl(raw: string): URL {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    networkPolicyError("Error: invalid MCP server URL.");
  }
  if (url.username !== "" || url.password !== "") {
    networkPolicyError("Error: MCP server URLs must not contain credentials.");
  }
  if (url.hash !== "") {
    networkPolicyError("Error: MCP server URLs must not contain fragments.");
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    networkPolicyError(
      "Error: MCP server URLs must use HTTPS, except loopback HTTP development.",
    );
  }
  return url;
}

export function validateMcpServerUrl(
  raw: string,
  allowPrivateNetwork: boolean,
): ValidatedMcpServerUrl {
  const url = parseMcpUrl(raw);
  const literalAccess = literalHostAccess(url.hostname);
  if (url.protocol === "http:" && literalAccess !== "loopback") {
    networkPolicyError(
      "Error: MCP server URLs must use HTTPS, except loopback HTTP development.",
    );
  }
  return {
    url,
    access: allowPrivateNetwork ? "private" : (literalAccess ?? "public"),
  };
}

function validateRedirectTarget(
  target: URL,
  base: ValidatedMcpServerUrl,
): NetworkAccess {
  const parsed = parseMcpUrl(target.href);
  if (parsed.origin !== base.url.origin) {
    networkPolicyError(
      "Error: cross-origin MCP redirect rejected because the destination was not approved as this server origin.",
    );
  }
  return base.access;
}

function requestTargetAccess(
  target: URL,
  base: ValidatedMcpServerUrl,
): NetworkAccess {
  const parsed = parseMcpUrl(target.href);
  if (parsed.origin === base.url.origin) return base.access;
  if (parsed.protocol !== "https:") {
    networkPolicyError("Error: cross-origin MCP OAuth targets must use HTTPS.");
  }
  const literalAccess = literalHostAccess(parsed.hostname);
  if (literalAccess === "loopback") {
    networkPolicyError(
      "Error: cross-origin private MCP OAuth target rejected because it was not explicitly approved.",
    );
  }
  return "public";
}

function requestBodyRedirectsToGet(status: number, method: string): boolean {
  return (
    status === 303 ||
    ((status === 301 || status === 302) && method.toUpperCase() === "POST")
  );
}

function responseFromUndici(response: Awaited<ReturnType<typeof undiciFetch>>) {
  const headers = new Headers();
  response.headers.forEach((value, name) => {
    headers.append(name, value);
  });
  const reader = response.body?.getReader();
  const body =
    reader === undefined
      ? null
      : new ReadableStream<Uint8Array>({
          pull: async (controller) => {
            const next = await reader.read();
            if (next.done) {
              controller.close();
              return;
            }
            controller.enqueue(next.value);
          },
          cancel: async () => {
            await reader.cancel();
          },
        });
  return new Response(body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

class PolicyFetch implements McpPolicyFetch {
  private readonly agents = new Map<string, Agent>();
  private readonly base: ValidatedMcpServerUrl;
  private readonly runtime: McpNetworkRuntime;

  constructor(base: ValidatedMcpServerUrl, runtime: McpNetworkRuntime) {
    this.base = base;
    this.runtime = runtime;
  }

  private agentFor(target: URL): Agent {
    const access = requestTargetAccess(target, this.base);
    const key = `${target.origin}\0${access}`;
    const existing = this.agents.get(key);
    if (existing !== undefined) return existing;

    const baseConnector = this.runtime.createConnector();
    const agent = new Agent({
      connect: (options, callback) => {
        const hostname = hostnameWithoutBrackets(options.hostname);
        this.runtime.resolve(hostname, (error, addresses) => {
          if (error !== null) {
            callback(error, null);
            return;
          }
          const selected = addresses[0];
          if (selected === undefined) {
            callback(
              new McpNetworkPolicyError(
                `MCP network policy could not resolve "${hostname}".`,
              ),
              null,
            );
            return;
          }
          const denied = addresses.find(
            (address) => !addressAllowed(address.address, access),
          );
          if (denied !== undefined) {
            callback(
              new McpNetworkPolicyError(
                `MCP network policy denied resolved address ${denied.address} for "${hostname}".`,
              ),
              null,
            );
            return;
          }
          baseConnector(
            {
              ...options,
              hostname: selected.address,
              host: selected.address,
              ...(options.protocol === "https:" && isIP(hostname) === 0
                ? { servername: hostname }
                : {}),
            },
            callback,
          );
        });
      },
      bodyTimeout: MCP_NETWORK_TIMEOUT_MS,
      connectTimeout: MCP_NETWORK_TIMEOUT_MS,
      headersTimeout: MCP_NETWORK_TIMEOUT_MS,
      maxResponseSize: MCP_MAX_RESPONSE_BYTES,
      pipelining: 1,
    });
    this.agents.set(key, agent);
    return agent;
  }

  readonly fetch = async (
    input: string | URL,
    init?: RequestInit,
  ): Promise<Response> => {
    const request = new Request(input, init);
    const signal = request.signal;
    let target = new URL(request.url);
    let method = request.method;
    const headers = new Headers(request.headers);
    let body =
      request.body === null
        ? undefined
        : new Uint8Array(await request.arrayBuffer());

    for (let redirectCount = 0; ; redirectCount += 1) {
      let response: Awaited<ReturnType<typeof undiciFetch>>;
      try {
        response = await undiciFetch(target, {
          method,
          headers: [...headers.entries()],
          ...(body !== undefined ? { body } : {}),
          dispatcher: this.agentFor(target),
          redirect: "manual",
          signal,
        });
      } catch (error) {
        const policyError = networkPolicyCause(error);
        if (policyError !== null) throw policyError;
        throw error;
      }
      const location = response.headers.get("location");
      if (
        location === null ||
        ![301, 302, 303, 307, 308].includes(response.status)
      ) {
        return responseFromUndici(response);
      }
      if (redirectCount === MCP_MAX_REDIRECTS) {
        await response.body?.cancel();
        networkPolicyError(
          `Error: MCP request exceeded ${MCP_MAX_REDIRECTS} redirects.`,
        );
      }

      const next = new URL(location, target);
      try {
        validateRedirectTarget(next, this.base);
      } catch (error) {
        await response.body?.cancel();
        throw error;
      }
      if (requestBodyRedirectsToGet(response.status, method)) {
        method = "GET";
        body = undefined;
        for (const header of BODY_REDIRECT_HEADERS) {
          headers.delete(header);
        }
      }
      await response.body?.cancel();
      target = next;
    }
  };

  readonly close = async (): Promise<void> => {
    await Promise.all([...this.agents.values()].map((agent) => agent.close()));
    this.agents.clear();
  };
}

export function createMcpPolicyFetch(
  base: ValidatedMcpServerUrl,
  runtime: McpNetworkRuntime = defaultNetworkRuntime,
): McpPolicyFetch {
  return new PolicyFetch(base, runtime);
}

/**
 * Rejects a currently denied authorization destination before handing it to
 * the RFC 8252 external user agent. This is deliberately a browser preflight,
 * not connection pinning: the system browser resolves independently. Every
 * OAuth request that Keel itself performs uses the pinned policy fetch above.
 */
export async function preflightMcpOAuthBrowserTarget(
  target: URL,
  base: ValidatedMcpServerUrl,
  runtime: Pick<McpNetworkRuntime, "resolve"> = defaultNetworkRuntime,
): Promise<void> {
  const access = requestTargetAccess(target, base);
  const hostname = hostnameWithoutBrackets(target.hostname);
  const literal = isIP(hostname) === 0 ? null : hostname;
  if (literal !== null) {
    if (!addressAllowed(literal, access)) {
      networkPolicyError(
        "Error: MCP OAuth authorization target is denied by network policy.",
      );
    }
    return;
  }
  const addresses = await new Promise<readonly McpResolvedAddress[]>(
    (resolve, reject) => {
      runtime.resolve(hostname, (error, resolved) => {
        if (error !== null) {
          reject(
            new McpNetworkPolicyError(
              `MCP network policy could not resolve "${hostname}".`,
            ),
          );
          return;
        }
        resolve(resolved);
      });
    },
  );
  if (
    addresses.length === 0 ||
    addresses.some((address) => !addressAllowed(address.address, access))
  ) {
    networkPolicyError(
      "Error: MCP OAuth authorization target is denied by network policy.",
    );
  }
}
