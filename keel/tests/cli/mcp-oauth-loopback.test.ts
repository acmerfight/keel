import { createServer, type Server } from "node:http";
import { describe, expect, test, vi } from "vitest";
import { startMcpOAuthLoopbackCallback } from "../../src/cli/mcp-oauth-loopback.ts";
import {
  MCP_CIMD_CALLBACKS,
  MCP_CIMD_REDIRECT_URIS,
} from "../../src/mcp/cimd.ts";

async function bindPort(port: number): Promise<Server> {
  const server = createServer((_request, response) => {
    response.end();
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", resolve);
  });
  return server;
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

describe("MCP OAuth loopback callback", () => {
  test(`Given the first release-declared callback port is occupied,
    When Keel starts an OAuth callback listener,
    Then it selects another redirect URI declared by the release identity`, async () => {
    // Given
    const occupied = await bindPort(MCP_CIMD_CALLBACKS[0].port);
    let callback: Awaited<
      ReturnType<typeof startMcpOAuthLoopbackCallback>
    > | null = null;
    try {
      // When
      callback = await startMcpOAuthLoopbackCallback("s".repeat(43));

      // Then
      expect(callback.redirectUrl).not.toContain(
        `:${MCP_CIMD_CALLBACKS[0].port}/`,
      );
      expect(MCP_CIMD_REDIRECT_URIS).toContain(callback.redirectUrl);
    } finally {
      await callback?.close();
      await closeServer(occupied);
    }
  });

  test(`Given a callback listener is bound to its exact loopback path,
    When one valid terminal callback arrives,
    Then all callback parameters are preserved and the listener releases its port`, async () => {
    // Given
    const state = "s".repeat(43);
    const callback = await startMcpOAuthLoopbackCallback(state);
    const redirect = new URL(callback.redirectUrl);
    const wrongPath = new URL("/not-the-callback", redirect);
    const ignored = await fetch(wrongPath);
    expect(ignored.status).toBe(404);
    const terminal = new URL(redirect);
    terminal.searchParams.set("code", "authorization-code");
    terminal.searchParams.set("state", state);
    terminal.searchParams.set("iss", "https://auth.example");

    // When
    const response = await fetch(terminal);
    const params = await callback.waitForCallback();
    await callback.close();

    // Then
    expect(response.status).toBe(200);
    expect(Object.fromEntries(params)).toEqual({
      code: "authorization-code",
      state,
      iss: "https://auth.example",
    });
    const rebound = await bindPort(Number(redirect.port));
    await closeServer(rebound);
  });

  test(`Given a loopback callback carries the wrong state,
    When it reaches the exact terminal path,
    Then Keel rejects it without echoing query data and closes the listener`, async () => {
    // Given
    const callback = await startMcpOAuthLoopbackCallback("s".repeat(43));
    const terminal = new URL(callback.redirectUrl);
    terminal.searchParams.set("code", "secret-authorization-code");
    terminal.searchParams.set("state", "x".repeat(43));

    // When
    const response = await fetch(terminal);
    const body = await response.text();

    // Then
    expect(response.status).toBe(400);
    expect(body).not.toContain("secret-authorization-code");
    await expect(callback.waitForCallback()).rejects.toThrow("invalid state");
    await callback.close();
    const rebound = await bindPort(Number(terminal.port));
    await closeServer(rebound);
  });

  test(`Given the exact callback path receives a non-GET request,
    When the callback becomes terminal,
    Then Keel rejects the method and releases the listener`, async () => {
    // Given
    const callback = await startMcpOAuthLoopbackCallback("s".repeat(43));
    const terminal = new URL(callback.redirectUrl);
    terminal.searchParams.set("state", "s".repeat(43));

    // When
    const response = await fetch(terminal, { method: "POST" });

    // Then
    expect(response.status).toBe(405);
    await expect(callback.waitForCallback()).rejects.toThrow(
      "invalid HTTP method",
    );
    await callback.close();
    const rebound = await bindPort(Number(terminal.port));
    await closeServer(rebound);
  });

  test(`Given a pending callback listener is cancelled,
    When cleanup runs before a callback,
    Then the waiter settles and the loopback port is released`, async () => {
    // Given
    const callback = await startMcpOAuthLoopbackCallback("s".repeat(43));
    const redirect = new URL(callback.redirectUrl);

    // When
    await callback.close();
    await callback.close();

    // Then
    await expect(callback.waitForCallback()).rejects.toThrow("cancelled");
    const rebound = await bindPort(Number(redirect.port));
    await closeServer(rebound);
  });

  test(`Given no OAuth callback arrives before the short-lived flow expires,
    When the callback timeout elapses,
    Then the waiter rejects and the listener releases its port`, async () => {
    // Given
    vi.useFakeTimers();
    try {
      const callback = await startMcpOAuthLoopbackCallback("s".repeat(43));
      const redirect = new URL(callback.redirectUrl);
      const timedOut = expect(callback.waitForCallback()).rejects.toThrow(
        "timed out",
      );

      // When
      await vi.advanceTimersByTimeAsync(2 * 60 * 1000);

      // Then
      await timedOut;
      await callback.close();
      const rebound = await bindPort(Number(redirect.port));
      await closeServer(rebound);
    } finally {
      vi.useRealTimers();
    }
  });
});
