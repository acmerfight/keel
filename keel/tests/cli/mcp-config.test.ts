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
  listMcpServers,
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
      allowPrivateNetwork: false,
      toolFilter: noToolFilter,
    };

    try {
      await addMcpServer(runtime, catalog);

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
      await expect(listMcpServers(runtime)).resolves.toEqual([catalog]);
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
      url: `https://server-${index}.example/mcp`,
      allowPrivateNetwork: false,
      toolFilter: noToolFilter,
    }));
    await writeFile(
      join(home, "mcp.json"),
      `${JSON.stringify({ schemaVersion: 2, servers })}\n`,
      "utf8",
    );

    try {
      // When / Then
      await expect(
        addMcpServer(configRuntime(home), {
          id: "overflow",
          url: "https://overflow.example/mcp",
          allowPrivateNetwork: false,
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

  test.each([
    ["invalid JSON", "{\n", "invalid JSON"],
    [
      "duplicate records",
      `${JSON.stringify({
        schemaVersion: 2,
        servers: [
          {
            id: "same",
            url: "https://example.com:443/mcp",
            allowPrivateNetwork: false,
            toolFilter: noToolFilter,
          },
          {
            id: "same",
            url: "https://example.com/mcp",
            allowPrivateNetwork: false,
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
        allowPrivateNetwork: false,
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
          allowPrivateNetwork: false,
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
          allowPrivateNetwork: false,
          toolFilter: noToolFilter,
        }),
      ).rejects.toThrow("cannot inspect MCP config lock");
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });
});
