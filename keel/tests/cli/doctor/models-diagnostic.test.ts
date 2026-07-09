import { describe, expect, test } from "vitest";
import {
  close,
  createServer,
  getPort,
  listen,
  readProviderModelsDiagnostic,
} from "./fixtures.ts";

describe("CLI Doctor", () => {
  test(`Given a models endpoint returns an HTTP failure with server text,
    When provider online diagnostics run,
    Then it reports only the status code`, async () => {
    // Given
    const upstreamStatusSecret = "upstream-status-secret";
    const server = createServer((_req, res) => {
      res.statusMessage = upstreamStatusSecret;
      res.writeHead(403);
      res.end();
    });
    await listen(server);

    try {
      // When
      const result = await readProviderModelsDiagnostic({
        baseUrl: `http://127.0.0.1:${getPort(server)}`,
        apiKey: "test-key",
      });

      // Then
      expect(result).toEqual({ status: "failed", message: "HTTP 403" });
      expect(JSON.stringify(result)).not.toContain(upstreamStatusSecret);
    } finally {
      await close(server);
    }
  });

  test(`Given provider online diagnostics receive unsupported base URL text,
    When the models probe is prepared,
    Then it fails without echoing the URL text`, async () => {
    // Given / When / Then
    await expect(
      readProviderModelsDiagnostic({
        baseUrl: "not a url with secret-token",
        apiKey: "test-key",
      }),
    ).resolves.toEqual({ status: "failed", message: "invalid base URL" });
  });

  test(`Given provider online diagnostics receive URL credentials or query text,
    When the models probe is prepared,
    Then it fails without echoing the secret-bearing URL parts`, async () => {
    // Given / When
    const result = await readProviderModelsDiagnostic({
      baseUrl:
        "https://user:password-secret@example.test/v1?api_key=query-secret#fragment-secret",
      apiKey: "test-key",
    });

    // Then
    expect(result).toEqual({
      status: "failed",
      message: "base URL must not include credentials, query, or fragment",
    });
    expect(JSON.stringify(result)).not.toContain("password-secret");
    expect(JSON.stringify(result)).not.toContain("query-secret");
    expect(JSON.stringify(result)).not.toContain("fragment-secret");
  });

  test(`Given the models endpoint closes the connection,
    When provider online diagnostics run,
    Then it reports a network request failure`, async () => {
    // Given
    const server = createServer((req) => {
      req.socket.destroy();
    });
    await listen(server);

    try {
      // When
      const result = await readProviderModelsDiagnostic({
        baseUrl: `http://127.0.0.1:${getPort(server)}`,
        apiKey: "test-key",
      });

      // Then
      expect(result).toEqual({
        status: "failed",
        message: "network request failed",
      });
    } finally {
      await close(server);
    }
  });

  test(`Given the models endpoint returns invalid JSON,
    When provider online diagnostics run,
    Then it reports an invalid models response`, async () => {
    // Given
    const server = createServer((_req, res) => {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end("not json");
    });
    await listen(server);

    try {
      // When
      const result = await readProviderModelsDiagnostic({
        baseUrl: `http://127.0.0.1:${getPort(server)}`,
        apiKey: "test-key",
      });

      // Then
      expect(result).toEqual({
        status: "failed",
        message: "invalid /models response",
      });
    } finally {
      await close(server);
    }
  });

  test(`Given the models endpoint returns a non-list JSON shape,
    When provider online diagnostics run,
    Then it reports an invalid models response`, async () => {
    // Given
    const server = createServer((_req, res) => {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ object: "not-a-model-list" }));
    });
    await listen(server);

    try {
      // When
      const result = await readProviderModelsDiagnostic({
        baseUrl: `http://127.0.0.1:${getPort(server)}`,
        apiKey: "test-key",
      });

      // Then
      expect(result).toEqual({
        status: "failed",
        message: "invalid /models response",
      });
    } finally {
      await close(server);
    }
  });
});
