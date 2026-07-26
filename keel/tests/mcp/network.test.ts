import type { IncomingMessage, ServerResponse } from "node:http";
import { createServer } from "node:http";
import { describe, expect, test } from "vitest";
import {
  createMcpPolicyFetch,
  type McpNetworkRuntime,
  validateMcpServerUrl,
} from "../../src/mcp/network.ts";

interface TestHttpServer {
  readonly url: string;
  readonly close: () => Promise<void>;
}

type Resolution =
  | {
      readonly status: "resolved";
      readonly addresses: readonly { readonly address: string }[];
    }
  | {
      readonly status: "failed";
      readonly error: NodeJS.ErrnoException;
    };

interface ConnectorCapture {
  calls: number;
  servername: string | null | undefined;
}

function deterministicNetworkRuntime(
  resolution: Resolution,
  capture: ConnectorCapture,
): McpNetworkRuntime {
  return {
    resolve: (_hostname, callback) => {
      if (resolution.status === "failed") {
        callback(resolution.error, []);
      } else {
        callback(null, resolution.addresses);
      }
    },
    createConnector: () => (options, callback) => {
      capture.calls += 1;
      capture.servername = options.servername;
      callback(new Error("deterministic connector stop"), null);
    },
  };
}

async function startHttpServer(
  handler: (request: IncomingMessage, response: ServerResponse) => void,
): Promise<TestHttpServer> {
  const server = createServer(handler);
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (address === null || typeof address === "string") {
    throw new Error("HTTP test server did not bind a TCP port");
  }
  return {
    url: `http://127.0.0.1:${address.port}`,
    close: async () => {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => {
          if (error === undefined) {
            resolve();
          } else {
            reject(error);
          }
        });
      });
    },
  };
}

async function requestBody(request: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks).toString("utf8");
}

describe("MCP network policy", () => {
  test.each([
    ["http://localhost:3000/mcp", false, "loopback"],
    ["http://api.localhost:3000/mcp", false, "loopback"],
    ["https://example.com/mcp", false, "public"],
    ["https://10.0.0.2/mcp", true, "private"],
    ["https://[::ffff:127.0.0.1]/mcp", false, "loopback"],
  ])(
    `Given allowed MCP URL %s,
    When its configured origin policy is validated,
    Then it receives the expected %s network access`,
    (url, allowPrivateNetwork, access) => {
      expect(validateMcpServerUrl(url, allowPrivateNetwork)).toMatchObject({
        access,
      });
    },
  );

  test.each([
    ["not a URL", "invalid MCP server URL"],
    [
      "https://:private-password@example.com/mcp",
      "must not contain credentials",
    ],
    ["https://example.com/mcp#fragment", "must not contain fragments"],
    ["ftp://example.com/mcp", "must use HTTPS"],
    ["http://example.com/mcp", "must use HTTPS"],
  ])(
    `Given disallowed MCP URL %s,
    When policy validation runs,
    Then it fails before DNS or connection work`,
    (url, message) => {
      expect(() => validateMcpServerUrl(url, false)).toThrow(message);
    },
  );

  test(`Given a loopback HTTP MCP response has a streamed body,
    When the policy fetch reads it and reuses the same origin,
    Then response bytes and headers survive the Undici-to-web bridge`, async () => {
    // Given
    const server = await startHttpServer((_request, response) => {
      response.writeHead(200, { "x-test": "present" });
      response.end("hello");
    });
    const network = createMcpPolicyFetch(
      validateMcpServerUrl(`${server.url}/mcp`, true),
    );

    try {
      // When
      const first = await network.fetch(`${server.url}/mcp`);
      const second = await network.fetch(`${server.url}/mcp`);

      // Then
      expect(first.headers.get("x-test")).toBe("present");
      await expect(first.text()).resolves.toBe("hello");
      await expect(second.text()).resolves.toBe("hello");
    } finally {
      await network.close();
      await server.close();
    }
  });

  test(`Given a loopback MCP endpoint returns no response body,
    When the policy fetch bridges the Undici response,
    Then the body remains empty without inventing stream data`, async () => {
    // Given
    const server = await startHttpServer((_request, response) => {
      response.writeHead(204);
      response.end();
    });
    const network = createMcpPolicyFetch(
      validateMcpServerUrl(`${server.url}/empty`, false),
    );

    try {
      // When
      const response = await network.fetch(`${server.url}/empty`);

      // Then
      expect(response.body).toBeNull();
      await expect(response.text()).resolves.toBe("");
    } finally {
      await network.close();
      await server.close();
    }
  });

  test(`Given a consumer cancels a streaming MCP response,
    When the web response bridge receives cancellation,
    Then it cancels the underlying Undici reader and releases the connection`, async () => {
    // Given
    const server = await startHttpServer((_request, response) => {
      response.writeHead(200);
      response.write("first chunk");
    });
    const network = createMcpPolicyFetch(
      validateMcpServerUrl(`${server.url}/stream`, false),
    );

    try {
      // When
      const response = await network.fetch(`${server.url}/stream`);
      const body = response.body;
      if (body === null) {
        throw new Error("policy fetch returned no streaming response body");
      }
      await body.cancel();

      // Then
      expect(body.locked).toBe(false);
    } finally {
      await network.close();
      await server.close();
    }
  });

  test(`Given a same-origin 302 follows a POST,
    When policy fetch follows the redirect,
    Then it changes to GET, removes body headers, and retains same-origin authorization`, async () => {
    // Given
    let finalRequest:
      | {
          readonly method: string | undefined;
          readonly authorization: string | undefined;
          readonly contentType: string | undefined;
          readonly body: string;
        }
      | undefined;
    const server = await startHttpServer((request, response) => {
      if (request.url === "/start") {
        response.writeHead(302, { location: "/final" });
        response.end();
        return;
      }
      void requestBody(request).then((body) => {
        finalRequest = {
          method: request.method,
          authorization: request.headers.authorization,
          contentType: request.headers["content-type"],
          body,
        };
        response.end("redirected");
      });
    });
    const network = createMcpPolicyFetch(
      validateMcpServerUrl(`${server.url}/start`, false),
    );

    try {
      // When
      const response = await network.fetch(`${server.url}/start`, {
        method: "POST",
        headers: {
          authorization: "Bearer same-origin",
          "content-type": "text/plain",
        },
        body: "payload",
      });

      // Then
      await expect(response.text()).resolves.toBe("redirected");
      expect(finalRequest).toEqual({
        method: "GET",
        authorization: "Bearer same-origin",
        contentType: undefined,
        body: "",
      });
    } finally {
      await network.close();
      await server.close();
    }
  });

  test(`Given a redirect crosses to another insecure origin with a query,
    When policy fetch validates the hop,
    Then it rejects the scheme and does not disclose the query`, async () => {
    // Given
    const server = await startHttpServer((_request, response) => {
      response.writeHead(307, {
        location: "http://127.0.0.1:9/private?token=do-not-print",
      });
      response.end();
    });
    const network = createMcpPolicyFetch(
      validateMcpServerUrl(`${server.url}/mcp`, false),
    );

    try {
      // When
      const request = network.fetch(`${server.url}/mcp`);

      // Then
      await expect(request).rejects.toThrow("must use HTTPS");
      await expect(request).rejects.not.toThrow("do-not-print");
    } finally {
      await network.close();
      await server.close();
    }
  });

  test(`Given a server never terminates its redirect chain,
    When policy fetch reaches the redirect limit,
    Then it cancels the response and fails with a bounded diagnostic`, async () => {
    // Given
    const server = await startHttpServer((_request, response) => {
      response.writeHead(307, { location: "/loop" });
      response.end();
    });
    const network = createMcpPolicyFetch(
      validateMcpServerUrl(`${server.url}/loop`, false),
    );

    try {
      // When / Then
      await expect(network.fetch(`${server.url}/loop`)).rejects.toThrow(
        "exceeded 5 redirects",
      );
    } finally {
      await network.close();
      await server.close();
    }
  });

  test(`Given a cloud-metadata address is IPv4-mapped into IPv6,
    When policy fetch resolves the literal target,
    Then normalization still denies the metadata endpoint`, async () => {
    // Given
    const endpoint = "https://[::ffff:169.254.169.254]/latest";
    const network = createMcpPolicyFetch(validateMcpServerUrl(endpoint, true));

    try {
      // When / Then
      await expect(network.fetch(endpoint)).rejects.toThrow(
        "MCP network policy denied resolved address",
      );
    } finally {
      await network.close();
    }
  });

  test(`Given a loopback server closes before a request connects,
    When policy fetch attempts the request,
    Then the non-policy transport error is preserved`, async () => {
    // Given
    const server = await startHttpServer((_request, response) => {
      response.end();
    });
    const endpoint = `${server.url}/closed`;
    await server.close();
    const network = createMcpPolicyFetch(validateMcpServerUrl(endpoint, false));

    try {
      // When / Then
      await expect(network.fetch(endpoint)).rejects.toThrow();
    } finally {
      await network.close();
    }
  });

  test.each([
    ["public", "https://public.example/mcp", false, "93.184.216.34"],
    ["private", "https://private.example/mcp", true, "10.0.0.8"],
    ["unique-local", "https://private.example/mcp", true, "fd00::8"],
    ["loopback", "https://private.example/mcp", true, "127.0.0.1"],
  ])(
    `Given a hostname resolves to an allowed %s address,
    When policy fetch prepares the physical connection,
    Then the validated address is pinned and hostname TLS identity is retained`,
    async (_range, endpoint, allowPrivateNetwork, address) => {
      // Given
      const capture: ConnectorCapture = {
        calls: 0,
        servername: null,
      };
      const runtime = deterministicNetworkRuntime(
        {
          status: "resolved",
          addresses: [{ address }],
        },
        capture,
      );
      const network = createMcpPolicyFetch(
        validateMcpServerUrl(endpoint, allowPrivateNetwork),
        runtime,
      );

      try {
        // When / Then
        await expect(network.fetch(endpoint)).rejects.toThrow("fetch failed");
        expect(capture.calls).toBe(1);
        expect(capture.servername).toBe(new URL(endpoint).hostname);
      } finally {
        await network.close();
      }
    },
  );

  test(`Given a public server hostname resolves to a private address,
    When policy fetch prepares the physical connection,
    Then it denies the address before invoking the connector`, async () => {
    // Given
    const capture: ConnectorCapture = { calls: 0, servername: null };
    const endpoint = "https://public.example/mcp";
    const network = createMcpPolicyFetch(
      validateMcpServerUrl(endpoint, false),
      deterministicNetworkRuntime(
        {
          status: "resolved",
          addresses: [{ address: "10.0.0.8" }],
        },
        capture,
      ),
    );

    try {
      // When / Then
      await expect(network.fetch(endpoint)).rejects.toThrow(
        "MCP network policy denied resolved address 10.0.0.8",
      );
      expect(capture.calls).toBe(0);
    } finally {
      await network.close();
    }
  });

  test.each([
    [
      {
        status: "resolved",
        addresses: [],
      },
      "could not resolve",
    ],
    [
      {
        status: "failed",
        error: Object.assign(new Error("DNS unavailable"), {
          code: "EAI_AGAIN",
        }),
      },
      "DNS unavailable",
    ],
  ] satisfies readonly [Resolution, string][])(
    `Given DNS produces an unusable external result,
    When policy fetch resolves the endpoint,
    Then it fails before connector creation`,
    async (resolution, expectedError) => {
      // Given
      const capture: ConnectorCapture = { calls: 0, servername: null };
      const endpoint = "https://public.example/mcp";
      const network = createMcpPolicyFetch(
        validateMcpServerUrl(endpoint, false),
        deterministicNetworkRuntime(resolution, capture),
      );

      try {
        // When / Then
        await expect(network.fetch(endpoint)).rejects.toThrow(
          resolution.status === "failed" ? "fetch failed" : expectedError,
        );
        expect(capture.calls).toBe(0);
      } finally {
        await network.close();
      }
    },
  );
});
