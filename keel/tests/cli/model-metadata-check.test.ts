import { createServer, type Server } from "node:http";
import { describe, expect, test, vi } from "vitest";
import { runCheckModelMetadata } from "../../scripts/check-model-metadata.ts";

async function runCheck(
  options: Parameters<typeof runCheckModelMetadata>[0],
): Promise<{
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
}> {
  let stdout = "";
  let stderr = "";
  const exitCode = await runCheckModelMetadata({
    ...options,
    writeStdout: (text) => {
      stdout += text;
    },
    writeStderr: (text) => {
      stderr += text;
    },
  });
  return { exitCode, stdout, stderr };
}

async function listen(server: Server): Promise<string> {
  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (address === null || typeof address === "string") {
    throw new Error("test server did not bind to a TCP port");
  }
  return `http://127.0.0.1:${address.port}`;
}

async function close(server: Server): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    server.close((error) => {
      if (error === undefined) {
        resolve();
      } else {
        reject(error);
      }
    });
  });
}

describe("Model Metadata Check CLI", () => {
  test(`Given default process output streams and a configured source endpoint,
    When the metadata check runs,
    Then the command writes the report to stdout`, async () => {
    // Given
    const server = createServer((_request, response) => {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(
        JSON.stringify({
          deepseek: {
            models: {
              "deepseek-v4-flash": {
                limit: { context: 1_000_000, output: 384_000 },
                reasoning: true,
                tool_call: true,
                cost: {
                  input: 0.14,
                  cache_read: 0.0028,
                  output: 0.28,
                },
              },
            },
          },
        }),
      );
    });
    const apiUrl = `${await listen(server)}/api.json`;
    const stdoutWrite = vi
      .spyOn(process.stdout, "write")
      .mockImplementation(() => true);

    try {
      // When
      const exitCode = await runCheckModelMetadata({
        apiUrl,
        targets: [
          {
            providerId: "deepseek",
            model: "deepseek-v4-flash",
            modelsDevProviderId: "deepseek",
            modelsDevModel: "deepseek-v4-flash",
          },
        ],
        acceptedDifferences: [],
        acceptedUntrackedModels: [],
      });

      // Then
      expect(exitCode).toBe(0);
      expect(stdoutWrite).toHaveBeenCalledWith(
        expect.stringContaining(
          "No actionable model metadata drift detected against models.dev.",
        ),
      );
    } finally {
      stdoutWrite.mockRestore();
      await close(server);
    }
  });

  test(`Given a models.dev-compatible endpoint is configured,
    When the metadata check runs,
    Then the command fetches the catalog over HTTP and succeeds`, async () => {
    // Given
    const server = createServer((request, response) => {
      expect(request.url).toBe("/api.json");
      response.writeHead(200, { "content-type": "application/json" });
      response.end(
        JSON.stringify({
          deepseek: {
            models: {
              "deepseek-v4-flash": {
                limit: { context: 1_000_000, output: 384_000 },
                reasoning: true,
                tool_call: true,
                cost: {
                  input: 0.14,
                  cache_read: 0.0028,
                  output: 0.28,
                },
              },
            },
          },
        }),
      );
    });
    const apiUrl = `${await listen(server)}/api.json`;

    try {
      // When
      const result = await runCheck({
        apiUrl,
        targets: [
          {
            providerId: "deepseek",
            model: "deepseek-v4-flash",
            modelsDevProviderId: "deepseek",
            modelsDevModel: "deepseek-v4-flash",
          },
        ],
        acceptedDifferences: [],
        acceptedUntrackedModels: [],
      });

      // Then
      expect(result.exitCode).toBe(0);
      expect(result.stderr).toBe("");
      expect(result.stdout).toContain(
        "No actionable model metadata drift detected against models.dev.",
      );
    } finally {
      await close(server);
    }
  });

  test(`Given models.dev returns only reviewed drift,
    When the metadata check runs,
    Then the command succeeds and reports the accepted difference`, async () => {
    // Given
    const result = await runCheck({
      fetchCatalog: async () => ({
        moonshotai: {
          models: {
            "kimi-k2.6": {
              limit: { context: 262_144, output: 262_144 },
              reasoning: true,
              tool_call: true,
              cost: {
                input: 0.95,
                cache_read: 0.16,
                output: 4,
              },
            },
          },
        },
      }),
      targets: [
        {
          providerId: "kimi",
          model: "kimi-k2.6",
          modelsDevProviderId: "moonshotai",
          modelsDevModel: "kimi-k2.6",
        },
      ],
      acceptedDifferences: [
        {
          providerId: "kimi",
          model: "kimi-k2.6",
          modelsDevProviderId: "moonshotai",
          modelsDevModel: "kimi-k2.6",
          field: "maxOutputTokens",
          registryValue: "32768",
          modelsDevValue: "262144",
          reviewedAt: "2026-06-26",
          reason:
            "models.dev currently mirrors the Kimi context window into the output limit.",
        },
      ],
      acceptedUntrackedModels: [],
    });

    // Then
    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe("");
    expect(result.stdout).toContain(
      "No actionable model metadata drift detected against models.dev.",
    );
    expect(result.stdout).toContain(
      "Accepted model metadata drift against models.dev:",
    );
  });

  test(`Given models.dev returns a new unreviewed value,
    When the metadata check runs,
    Then the command fails with actionable drift`, async () => {
    // Given
    const result = await runCheck({
      fetchCatalog: async () => ({
        deepseek: {
          models: {
            "deepseek-v4-flash": {
              limit: { context: 1_000_000, output: 384_000 },
              reasoning: true,
              tool_call: true,
              cost: {
                input: 0.14,
                cache_read: 0.0028,
                output: 0.29,
              },
            },
          },
        },
      }),
      targets: [
        {
          providerId: "deepseek",
          model: "deepseek-v4-flash",
          modelsDevProviderId: "deepseek",
          modelsDevModel: "deepseek-v4-flash",
        },
      ],
      acceptedDifferences: [],
      acceptedUntrackedModels: [],
    });

    // Then
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toBe("");
    expect(result.stdout).toContain(
      "Actionable model metadata drift detected against models.dev:",
    );
    expect(result.stdout).toContain(
      "costModel.outputPerMillionTokens: registry=0.28 models.dev=0.29",
    );
  });

  test(`Given models.dev cannot be fetched,
    When the metadata check runs,
    Then the command returns a source failure without drift output`, async () => {
    // Given
    const result = await runCheck({
      fetchCatalog: async () => {
        throw new Error("source offline");
      },
    });

    // Then
    expect(result.exitCode).toBe(2);
    expect(result.stdout).toBe("");
    expect(result.stderr).toBe(
      "check:model-metadata source failure: source offline\n",
    );
  });

  test(`Given default process error output and a non-Error source failure,
    When the metadata check runs,
    Then the command writes the source failure to stderr`, async () => {
    // Given
    const stderrWrite = vi
      .spyOn(process.stderr, "write")
      .mockImplementation(() => true);

    try {
      // When
      const exitCode = await runCheckModelMetadata({
        fetchCatalog: async () => {
          throw "source offline";
        },
      });

      // Then
      expect(exitCode).toBe(2);
      expect(stderrWrite).toHaveBeenCalledWith(
        "check:model-metadata source failure: source offline\n",
      );
    } finally {
      stderrWrite.mockRestore();
    }
  });

  test(`Given models.dev returns an invalid monitored model shape,
    When the metadata check runs,
    Then the command returns a source failure instead of throwing`, async () => {
    // Given
    const result = await runCheck({
      fetchCatalog: async () => ({
        deepseek: {
          models: {
            "deepseek-v4-flash": {
              limit: { context: "1000000" },
            },
          },
        },
      }),
      targets: [
        {
          providerId: "deepseek",
          model: "deepseek-v4-flash",
          modelsDevProviderId: "deepseek",
          modelsDevModel: "deepseek-v4-flash",
        },
      ],
    });

    // Then
    expect(result.exitCode).toBe(2);
    expect(result.stdout).toBe("");
    expect(result.stderr).toBe(
      "check:model-metadata source failure: models.dev model deepseek/deepseek-v4-flash has invalid schema\n",
    );
  });

  test(`Given models.dev returns an HTTP error,
    When the metadata check runs,
    Then the command reports the HTTP status as a source failure`, async () => {
    // Given
    const server = createServer((_request, response) => {
      response.writeHead(503, { "content-type": "text/plain" });
      response.end("unavailable");
    });
    const apiUrl = `${await listen(server)}/api.json`;

    try {
      // When
      const result = await runCheck({ apiUrl });

      // Then
      expect(result.exitCode).toBe(2);
      expect(result.stdout).toBe("");
      expect(result.stderr).toBe(
        "check:model-metadata source failure: models.dev request failed: 503 Service Unavailable\n",
      );
    } finally {
      await close(server);
    }
  });
});
