import { readFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { describe, expect, test } from "vitest";
import { z } from "zod";
import { startMcpOAuthLoopbackCallback } from "../../src/cli/mcp-oauth-loopback.ts";
import {
  MCP_CIMD_CALLBACKS,
  MCP_CIMD_CLIENT_ID,
  MCP_CIMD_REDIRECT_URIS,
} from "../../src/mcp/cimd.ts";

const clientMetadataDocumentSchema = z
  .object({
    client_id: z.url(),
    client_name: z.string(),
    client_uri: z.url(),
    redirect_uris: z.array(z.url()),
    grant_types: z.array(z.string()),
    response_types: z.array(z.string()),
    token_endpoint_auth_method: z.literal("none"),
    application_type: z.literal("native"),
  })
  .strict();
const listenErrorSchema = z.object({ code: z.string() }).passthrough();

async function bindPort(port: number): Promise<Server | null> {
  const server = createServer((_request, response) => {
    response.end();
  });
  try {
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(port, "127.0.0.1", resolve);
    });
    return server;
  } catch (error) {
    const parsed = listenErrorSchema.safeParse(error);
    if (parsed.success && parsed.data.code === "EADDRINUSE") return null;
    throw error;
  }
}

async function closeServer(server: Server): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    server.close((error) => {
      if (error === undefined) {
        resolve();
        return;
      }
      reject(error);
    });
  });
}

describe("MCP release client identity", () => {
  test(`Given Keel publishes a release Client ID Metadata Document,
    When its OAuth identity contract is validated,
    Then the document exactly matches the runtime client and callback identities`, async () => {
    // Given
    const serialized = await readFile(
      new URL("../../docs/oauth/client-metadata.json", import.meta.url),
      "utf8",
    );

    // When
    const document = clientMetadataDocumentSchema.parse(JSON.parse(serialized));

    // Then
    expect(Buffer.byteLength(serialized)).toBeLessThanOrEqual(5 * 1024);
    expect(document).toEqual({
      client_id: MCP_CIMD_CLIENT_ID,
      client_name: "Keel",
      client_uri: "https://github.com/acmerfight/keel",
      redirect_uris: MCP_CIMD_REDIRECT_URIS,
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      token_endpoint_auth_method: "none",
      application_type: "native",
    });
  });

  test(`Given every release-declared loopback callback is unavailable,
    When Keel starts an OAuth callback listener,
    Then it fails with the bounded release port set instead of using an undeclared redirect`, async () => {
    // Given
    const occupied = (
      await Promise.all(
        MCP_CIMD_CALLBACKS.map(async ({ port }) => await bindPort(port)),
      )
    ).filter((server) => server !== null);

    try {
      // When
      const started = startMcpOAuthLoopbackCallback("s".repeat(43));

      // Then
      await expect(started).rejects.toThrow(
        "could not bind any release callback port",
      );
    } finally {
      await Promise.all(occupied.map(closeServer));
    }
  });
});
