import { randomUUID } from "node:crypto";
import {
  mkdir,
  mkdtemp,
  rm,
  stat,
  symlink,
  utimes,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import {
  addMcpServer,
  deriveMcpServerId,
  findMcpServer,
  isMcpServerCurrentAndEnabled,
  listEnabledMcpServers,
  listEnabledMcpServersSync,
  listMcpServers,
  listMcpServersSync,
  type McpServerConfig,
  monitorMcpServerLifecycle,
  removeMcpServer,
  setMcpServerAuthenticationRequired,
  setMcpServerEnabled,
  validateMcpServerId,
} from "../../src/cli/mcp-config.ts";

function configRuntime(home: string) {
  return {
    env: (key: string) => (key === "KEEL_HOME" ? home : undefined),
  };
}

const noToolFilter = {
  allow: null,
  deny: [],
};

describe("MCP config", () => {
  test(`Given no MCP config exists,
    When configuration is read,
    Then the latest empty schema is returned without creating a file`, async () => {
    // Given
    const home = await mkdtemp(join(tmpdir(), "keel-mcp-config-empty-"));
    const runtime = configRuntime(home);

    try {
      // When / Then
      await expect(listMcpServers(runtime)).resolves.toEqual([]);
      await expect(stat(join(home, "mcp.json"))).rejects.toMatchObject({
        code: "ENOENT",
      });
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });

  test(`Given canonical host names and invalid server identities,
    When Keel derives or validates an id,
    Then valid ids are typed internally and invalid identities fail at the boundary`, () => {
    expect(deriveMcpServerId(new URL("https://Catalog.Example/mcp"))).toBe(
      "catalog",
    );
    expect(() => deriveMcpServerId(new URL("https://[::1]/mcp"))).toThrow(
      "cannot derive an MCP server id",
    );
    expect(() => validateMcpServerId("UPPER CASE")).toThrow(
      "invalid MCP server id",
    );
  });

  test(`Given an existing logical server or endpoint,
    When another mutation would duplicate it,
    Then serialized configuration rejects the duplicate and preserves one record`, async () => {
    // Given
    const home = await mkdtemp(join(tmpdir(), "keel-mcp-config-duplicate-"));
    const runtime = configRuntime(home);
    const catalog = {
      id: "catalog",
      url: "https://example.com/mcp",
      enabled: true,
      allowPrivateNetwork: false,
      authenticationRequired: false,
      toolFilter: noToolFilter,
    };

    try {
      const configured = await addMcpServer(runtime, catalog);

      // When / Then
      await expect(addMcpServer(runtime, catalog)).rejects.toThrow(
        'MCP server "catalog" is already configured',
      );
      await expect(
        addMcpServer(runtime, { ...catalog, id: "other" }),
      ).rejects.toThrow("MCP endpoint is already configured");
      await expect(findMcpServer(runtime, "missing")).rejects.toThrow(
        'MCP server "missing" is not configured',
      );
      await expect(listMcpServers(runtime)).resolves.toEqual([configured]);
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });

  test(`Given the MCP config already contains the maximum number of servers,
    When another server is added,
    Then Keel rejects the mutation without publishing an unreadable config`, async () => {
    // Given
    const home = await mkdtemp(join(tmpdir(), "keel-mcp-config-limit-"));
    const servers = Array.from({ length: 128 }, (_, index) => ({
      id: `server-${index}`,
      incarnation: randomUUID(),
      url: `https://server-${index}.example/mcp`,
      enabled: true,
      allowPrivateNetwork: false,
      authenticationRequired: false,
      toolFilter: noToolFilter,
    }));
    await writeFile(
      join(home, "mcp.json"),
      `${JSON.stringify({ schemaVersion: 4, servers })}\n`,
      "utf8",
    );

    try {
      // When / Then
      await expect(
        addMcpServer(configRuntime(home), {
          id: "overflow",
          url: "https://overflow.example/mcp",
          enabled: true,
          allowPrivateNetwork: false,
          authenticationRequired: false,
          toolFilter: noToolFilter,
        }),
      ).rejects.toThrow("supports at most 128 servers");
      await expect(listMcpServers(configRuntime(home))).resolves.toHaveLength(
        128,
      );
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });

  test(`Given authentication state is persisted beside a configured endpoint,
    When login, repeated login, and logout update that state,
    Then the mutation is atomic, idempotent, and rejects unknown server identities`, async () => {
    // Given
    const home = await mkdtemp(join(tmpdir(), "keel-mcp-config-auth-"));
    const runtime = configRuntime(home);

    try {
      const protectedServer = await addMcpServer(runtime, {
        id: "protected",
        url: "https://protected.example/mcp",
        enabled: true,
        allowPrivateNetwork: false,
        authenticationRequired: false,
        toolFilter: noToolFilter,
      });
      await addMcpServer(runtime, {
        id: "public",
        url: "https://public.example/mcp",
        enabled: true,
        allowPrivateNetwork: false,
        authenticationRequired: false,
        toolFilter: noToolFilter,
      });

      // When / Then
      await setMcpServerAuthenticationRequired(runtime, protectedServer, true);
      await setMcpServerAuthenticationRequired(runtime, protectedServer, true);
      await expect(findMcpServer(runtime, "protected")).resolves.toMatchObject({
        authenticationRequired: true,
      });
      await setMcpServerAuthenticationRequired(runtime, protectedServer, false);
      await expect(findMcpServer(runtime, "protected")).resolves.toMatchObject({
        authenticationRequired: false,
      });
      await expect(findMcpServer(runtime, "public")).resolves.toMatchObject({
        authenticationRequired: false,
      });
      await expect(
        setMcpServerAuthenticationRequired(
          runtime,
          { ...protectedServer, id: "missing" },
          true,
        ),
      ).rejects.toThrow('MCP server "missing" is not configured');
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });

  test(`Given a configured MCP server,
    When enable, disable, and remove mutations are repeated or interrupted,
    Then enabled selection and credential cleanup stay serialized, idempotent, and fail closed`, async () => {
    // Given
    const home = await mkdtemp(join(tmpdir(), "keel-mcp-config-lifecycle-"));
    const runtime = configRuntime(home);
    const catalog = {
      id: "catalog",
      url: "https://example.com/mcp",
      enabled: true,
      allowPrivateNetwork: false,
      authenticationRequired: true,
      toolFilter: noToolFilter,
    };

    try {
      const configured = await addMcpServer(runtime, catalog);

      // When / Then
      await expect(
        setMcpServerEnabled(runtime, configured, false),
      ).resolves.toBe(true);
      await expect(
        setMcpServerEnabled(runtime, configured, false),
      ).resolves.toBe(false);
      await expect(listMcpServers(runtime)).resolves.toEqual([
        { ...configured, enabled: false },
      ]);
      await expect(listEnabledMcpServers(runtime)).resolves.toEqual([]);
      expect(listEnabledMcpServersSync(runtime)).toEqual([]);

      await expect(
        setMcpServerEnabled(runtime, configured, true),
      ).resolves.toBe(true);
      await expect(
        setMcpServerEnabled(runtime, configured, true),
      ).resolves.toBe(false);
      await expect(listEnabledMcpServers(runtime)).resolves.toEqual([
        configured,
      ]);
      expect(listEnabledMcpServersSync(runtime)).toEqual([configured]);
      await expect(
        setMcpServerEnabled(runtime, { ...configured, id: "missing" }, false),
      ).rejects.toThrow('MCP server "missing" is not configured');

      await expect(
        removeMcpServer(runtime, configured, async () => {
          throw new Error("credential cleanup failed");
        }),
      ).rejects.toThrow("credential cleanup failed");
      await expect(findMcpServer(runtime, "catalog")).resolves.toEqual(
        configured,
      );

      let removedServer: McpServerConfig | null = null;
      await expect(
        removeMcpServer(runtime, configured, async (server) => {
          removedServer = server;
        }),
      ).resolves.toBe(true);
      expect(removedServer).toEqual(configured);
      await expect(
        removeMcpServer(runtime, configured, async () => {
          throw new Error("must not run for an absent server");
        }),
      ).resolves.toBe(false);
      await expect(listMcpServers(runtime)).resolves.toEqual([]);
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });

  test(`Given a lifecycle monitor is watching current configuration,
    When the persisted file becomes unreadable,
    Then the monitor aborts the in-flight operation with that config failure`, async () => {
    // Given
    const home = await mkdtemp(join(tmpdir(), "keel-mcp-config-monitor-"));
    const runtime = configRuntime(home);
    const configured = await addMcpServer(runtime, {
      id: "catalog",
      url: "https://example.com/mcp",
      enabled: true,
      allowPrivateNetwork: false,
      authenticationRequired: false,
      toolFilter: noToolFilter,
    });
    const parent = new AbortController();
    const monitor = monitorMcpServerLifecycle(
      runtime,
      configured,
      parent.signal,
    );

    try {
      // When
      await writeFile(join(home, "mcp.json"), "{\n", "utf8");
      await new Promise<void>((resolve) => {
        if (monitor.signal.aborted) {
          resolve();
          return;
        }
        monitor.signal.addEventListener("abort", () => resolve(), {
          once: true,
        });
      });

      // Then
      expect(monitor.signal.reason).toBeInstanceOf(Error);
      expect(String(monitor.signal.reason)).toContain("cannot read MCP config");
    } finally {
      parent.abort();
      await monitor.close();
      await rm(home, { recursive: true, force: true });
    }
  });

  test(`Given lifecycle mutations carry a stale server identity,
    When authentication, enablement, or removal tries to commit,
    Then each mutation rejects without changing the current server`, async () => {
    // Given
    const home = await mkdtemp(join(tmpdir(), "keel-mcp-config-cas-"));
    const runtime = configRuntime(home);
    const configured = await addMcpServer(runtime, {
      id: "catalog",
      url: "https://example.com/mcp",
      enabled: true,
      allowPrivateNetwork: false,
      authenticationRequired: false,
      toolFilter: noToolFilter,
    });
    const stale = { ...configured, incarnation: randomUUID() };

    try {
      // When / Then
      await expect(
        setMcpServerAuthenticationRequired(runtime, stale, true),
      ).rejects.toThrow("changed during the command");
      await expect(setMcpServerEnabled(runtime, stale, false)).rejects.toThrow(
        "changed during the command",
      );
      await expect(
        removeMcpServer(runtime, stale, async () => {
          throw new Error("stale removal must not clean credentials");
        }),
      ).rejects.toThrow("changed while it was being removed");
      await expect(findMcpServer(runtime, "catalog")).resolves.toEqual(
        configured,
      );
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });

  test(`Given enabling one server while another server is configured,
    When the mutation writes the sorted config,
    Then the unrelated server record remains unchanged`, async () => {
    // Given
    const home = await mkdtemp(join(tmpdir(), "keel-mcp-config-sibling-"));
    const runtime = configRuntime(home);
    const first = await addMcpServer(runtime, {
      id: "first",
      url: "https://first.example/mcp",
      enabled: false,
      allowPrivateNetwork: false,
      authenticationRequired: false,
      toolFilter: noToolFilter,
    });
    const second = await addMcpServer(runtime, {
      id: "second",
      url: "https://second.example/mcp",
      enabled: true,
      allowPrivateNetwork: false,
      authenticationRequired: false,
      toolFilter: noToolFilter,
    });

    try {
      // When
      await expect(setMcpServerEnabled(runtime, first, true)).resolves.toBe(
        true,
      );

      // Then
      await expect(listMcpServers(runtime)).resolves.toEqual([
        { ...first, enabled: true },
        second,
      ]);
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });

  test(`Given two removals race after credential cleanup starts,
    When the second removal commits first,
    Then the first removal also settles successfully without another config write`, async () => {
    // Given
    const home = await mkdtemp(join(tmpdir(), "keel-mcp-config-remove-race-"));
    const runtime = configRuntime(home);
    const configured = await addMcpServer(runtime, {
      id: "catalog",
      url: "https://example.com/mcp",
      enabled: true,
      allowPrivateNetwork: false,
      authenticationRequired: true,
      toolFilter: noToolFilter,
    });
    const cleanupStarted = Promise.withResolvers<void>();
    const finishCleanup = Promise.withResolvers<void>();

    try {
      const firstRemoval = removeMcpServer(runtime, configured, async () => {
        cleanupStarted.resolve();
        await finishCleanup.promise;
      });
      await cleanupStarted.promise;
      await expect(
        removeMcpServer(runtime, configured, async () => {}),
      ).resolves.toBe(true);

      // When
      finishCleanup.resolve();

      // Then
      await expect(firstRemoval).resolves.toBe(true);
      await expect(listMcpServers(runtime)).resolves.toEqual([]);
    } finally {
      finishCleanup.resolve();
      await rm(home, { recursive: true, force: true });
    }
  });

  test(`Given one removal waits on credential cleanup while another process removes and re-adds the same endpoint,
    When the first removal resumes,
    Then its stale incarnation cannot delete the replacement record`, async () => {
    // Given
    const home = await mkdtemp(join(tmpdir(), "keel-mcp-config-aba-"));
    const runtime = configRuntime(home);
    const server = {
      id: "catalog",
      url: "https://example.com/mcp",
      enabled: true,
      allowPrivateNetwork: false,
      authenticationRequired: true,
      toolFilter: noToolFilter,
    };
    const cleanupStarted = Promise.withResolvers<void>();
    const finishCleanup = Promise.withResolvers<void>();

    try {
      const original = await addMcpServer(runtime, server);
      const firstRemoval = removeMcpServer(runtime, original, async () => {
        cleanupStarted.resolve();
        await finishCleanup.promise;
      });
      await cleanupStarted.promise;
      await expect(
        removeMcpServer(runtime, original, async () => {}),
      ).resolves.toBe(true);
      const replacement = await addMcpServer(runtime, server);

      // When
      finishCleanup.resolve();

      // Then
      await expect(firstRemoval).rejects.toThrow(
        "changed while it was being removed",
      );
      expect(replacement.incarnation).not.toBe(original.incarnation);
      await expect(listMcpServers(runtime)).resolves.toEqual([replacement]);
      await expect(
        isMcpServerCurrentAndEnabled(runtime, original),
      ).resolves.toBe(false);
      await expect(
        isMcpServerCurrentAndEnabled(runtime, replacement),
      ).resolves.toBe(true);
    } finally {
      finishCleanup.resolve();
      await rm(home, { recursive: true, force: true });
    }
  });

  test.each([
    ["invalid JSON", "{\n", "invalid JSON"],
    [
      "duplicate records",
      `${JSON.stringify({
        schemaVersion: 4,
        servers: [
          {
            id: "same",
            incarnation: randomUUID(),
            url: "https://example.com:443/mcp",
            enabled: true,
            allowPrivateNetwork: false,
            authenticationRequired: false,
            toolFilter: noToolFilter,
          },
          {
            id: "same",
            incarnation: randomUUID(),
            url: "https://example.com/mcp",
            enabled: true,
            allowPrivateNetwork: false,
            authenticationRequired: false,
            toolFilter: noToolFilter,
          },
        ],
      })}\n`,
      "duplicate MCP server id",
    ],
    [
      "an oversized document",
      `${" ".repeat(1024 * 1024 + 1)}\n`,
      "file exceeds",
    ],
    [
      "duplicate tool filters",
      `${JSON.stringify({
        schemaVersion: 4,
        servers: [
          {
            id: "catalog",
            incarnation: randomUUID(),
            url: "https://example.com/mcp",
            enabled: true,
            allowPrivateNetwork: false,
            authenticationRequired: false,
            toolFilter: {
              allow: ["search", "search"],
              deny: ["delete", "delete"],
            },
          },
        ],
      })}\n`,
      "duplicate MCP tool filter",
    ],
  ])(
    `Given the persisted MCP config contains %s,
    When it is read,
    Then the external file is rejected before an internal config type is produced`,
    async (_description, content, expectedError) => {
      // Given
      const home = await mkdtemp(join(tmpdir(), "keel-mcp-config-invalid-"));
      await writeFile(join(home, "mcp.json"), content, "utf8");

      try {
        // When / Then
        await expect(listMcpServers(configRuntime(home))).rejects.toThrow(
          expectedError,
        );
      } finally {
        await rm(home, { recursive: true, force: true });
      }
    },
  );

  test(`Given the MCP config path is not a readable regular file,
    When configuration is read,
    Then the filesystem error is normalized as a config failure`, async () => {
    // Given
    const home = await mkdtemp(join(tmpdir(), "keel-mcp-config-directory-"));
    await mkdir(join(home, "mcp.json"));

    try {
      // When / Then
      await expect(listMcpServers(configRuntime(home))).rejects.toThrow(
        "cannot read MCP config",
      );
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });

  test(`Given KEEL_HOME points at a file instead of a directory,
    When configuration is read,
    Then the pre-read stat fault is normalized as a config failure`, async () => {
    // Given
    const home = join(
      await mkdtemp(join(tmpdir(), "keel-mcp-config-parent-file-")),
      "home",
    );
    await writeFile(home, "", "utf8");

    try {
      // When / Then
      await expect(listMcpServers(configRuntime(home))).rejects.toThrow(
        "cannot read MCP config",
      );
    } finally {
      await rm(join(home, ".."), { recursive: true, force: true });
    }
  });

  test(`Given synchronous startup reads missing, valid, oversized, and unreadable MCP configs,
    When interactive bootstrap crosses the filesystem boundary,
    Then the latest schema is returned or a normalized config error is raised`, async () => {
    // Given
    const missingHome = await mkdtemp(
      join(tmpdir(), "keel-mcp-config-sync-missing-"),
    );
    const validHome = await mkdtemp(
      join(tmpdir(), "keel-mcp-config-sync-valid-"),
    );
    const oversizedHome = await mkdtemp(
      join(tmpdir(), "keel-mcp-config-sync-oversized-"),
    );
    const directoryHome = await mkdtemp(
      join(tmpdir(), "keel-mcp-config-sync-directory-"),
    );
    const invalidParent = await mkdtemp(
      join(tmpdir(), "keel-mcp-config-sync-parent-"),
    );
    const invalidHome = join(invalidParent, "home");
    const server = {
      id: "catalog",
      incarnation: randomUUID(),
      url: "https://example.com/mcp",
      enabled: true,
      allowPrivateNetwork: false,
      authenticationRequired: false,
      toolFilter: noToolFilter,
    };
    await writeFile(
      join(validHome, "mcp.json"),
      `${JSON.stringify({ schemaVersion: 4, servers: [server] })}\n`,
      "utf8",
    );
    await writeFile(
      join(oversizedHome, "mcp.json"),
      " ".repeat(1024 * 1024 + 1),
      "utf8",
    );
    await mkdir(join(directoryHome, "mcp.json"));
    await writeFile(invalidHome, "", "utf8");

    try {
      // When / Then
      expect(listMcpServersSync(configRuntime(missingHome))).toEqual([]);
      expect(listMcpServersSync(configRuntime(validHome))).toEqual([server]);
      expect(() => listMcpServersSync(configRuntime(oversizedHome))).toThrow(
        "file exceeds",
      );
      expect(() => listMcpServersSync(configRuntime(directoryHome))).toThrow(
        "cannot read MCP config",
      );
      expect(() => listMcpServersSync(configRuntime(invalidHome))).toThrow(
        "cannot read MCP config",
      );
    } finally {
      await Promise.all([
        rm(missingHome, { recursive: true, force: true }),
        rm(validHome, { recursive: true, force: true }),
        rm(oversizedHome, { recursive: true, force: true }),
        rm(directoryHome, { recursive: true, force: true }),
        rm(invalidParent, { recursive: true, force: true }),
      ]);
    }
  });

  test(`Given a crashed writer left a stale configuration lock,
    When a new mutation starts,
    Then Keel removes the stale lock and atomically publishes the new config`, async () => {
    // Given
    const home = await mkdtemp(join(tmpdir(), "keel-mcp-config-stale-"));
    const lockPath = join(home, ".mcp-config.lock");
    await writeFile(lockPath, "", "utf8");
    const stale = new Date(Date.now() - 60_000);
    await utimes(lockPath, stale, stale);

    try {
      // When
      await addMcpServer(configRuntime(home), {
        id: "catalog",
        url: "https://example.com/mcp",
        enabled: true,
        allowPrivateNetwork: false,
        authenticationRequired: false,
        toolFilter: noToolFilter,
      });

      // Then
      await expect(listMcpServers(configRuntime(home))).resolves.toHaveLength(
        1,
      );
      await expect(stat(lockPath)).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });

  test(`Given another writer holds a fresh configuration lock,
    When a mutation reaches the bounded lock deadline,
    Then Keel fails without changing the existing lock`, async () => {
    // Given
    const home = await mkdtemp(join(tmpdir(), "keel-mcp-config-busy-"));
    const lockPath = join(home, ".mcp-config.lock");
    await writeFile(lockPath, "", "utf8");

    try {
      // When / Then
      await expect(
        addMcpServer(configRuntime(home), {
          id: "catalog",
          url: "https://example.com/mcp",
          enabled: true,
          allowPrivateNetwork: false,
          authenticationRequired: false,
          toolFilter: noToolFilter,
        }),
      ).rejects.toThrow("MCP config is busy");
      await expect(stat(lockPath)).resolves.toBeDefined();
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  }, 10_000);

  test(`Given a lock path resolves through a symlink cycle,
    When a mutation inspects the contended external lock,
    Then Keel normalizes the filesystem fault at the config boundary`, async () => {
    // Given
    const home = await mkdtemp(join(tmpdir(), "keel-mcp-config-lock-cycle-"));
    const lockPath = join(home, ".mcp-config.lock");
    await symlink(".mcp-config.lock", lockPath);

    try {
      // When / Then
      await expect(
        addMcpServer(configRuntime(home), {
          id: "catalog",
          url: "https://example.com/mcp",
          enabled: true,
          allowPrivateNetwork: false,
          authenticationRequired: false,
          toolFilter: noToolFilter,
        }),
      ).rejects.toThrow("cannot inspect MCP config lock");
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });
});
