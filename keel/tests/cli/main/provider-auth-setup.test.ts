import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { describe, expect, test } from "vitest";
import { runCliMain } from "../../../src/cli/index.ts";
import { requestModelSchema } from "../../../src/testing/cli-main-schemas.ts";
import { createRuntime } from "../../../src/testing/cli-runtime-fixtures.ts";
import {
  close,
  getPort,
  listen,
  sseTextReplyWithUsage,
} from "../../../src/testing/provider-sse-fixtures.ts";

function inputText(text: string): PassThrough {
  const input = new PassThrough();
  input.end(text);
  return input;
}

function stringInputText(text: string): PassThrough {
  const input = new PassThrough();
  input.setEncoding("utf8");
  input.end(text);
  return input;
}

describe("CLI Main - Provider Auth Setup", () => {
  test(`Given a user stores a provider key and default provider,
    When the user runs doctor without provider env,
    Then Keel reports config-selected provider auth without printing the secret`, async () => {
    // Given
    const home = await mkdtemp(join(tmpdir(), "keel-provider-auth-home-"));
    const secret = "stored-deepseek-secret";
    const requests: string[] = [];
    const server = createServer((req, res) => {
      if (req.url !== "/models") {
        res.writeHead(404);
        res.end();
        return;
      }
      requests.push(req.headers.authorization ?? "");
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ data: [] }));
    });
    await listen(server);

    try {
      const login = createRuntime(
        ["auth", "login", "deepseek", "--with-api-key"],
        {
          env: { KEEL_HOME: home },
          input: inputText(`${secret}\n`),
        },
      );
      const configured = createRuntime(
        [
          "config",
          "set-provider",
          "deepseek",
          "--model",
          "deepseek-v4-flash",
          "--base-url",
          `http://127.0.0.1:${getPort(server)}`,
        ],
        { env: { KEEL_HOME: home } },
      );
      const doctor = createRuntime(["--doctor"], {
        env: { KEEL_HOME: home },
      });

      // When
      const loginExit = await runCliMain(login.runtime);
      const configExit = await runCliMain(configured.runtime);
      const doctorExit = await runCliMain(doctor.runtime);

      // Then
      expect(loginExit).toBe(0);
      expect(login.stdout()).toBe("Stored API key for deepseek.\n");
      expect(login.stderr()).toBe("");
      expect(configExit).toBe(0);
      expect(configured.stdout()).toBe("Configured provider deepseek.\n");
      expect(configured.stderr()).toBe("");
      expect(doctorExit).toBe(0);
      expect(doctor.stdout()).toContain("provider: deepseek (source: config)");
      expect(doctor.stdout()).toContain(
        "model: deepseek-v4-flash (source: config)",
      );
      expect(doctor.stdout()).toContain("api key: present (auth: deepseek)");
      expect(doctor.stdout()).toContain(
        `base url: http://127.0.0.1:${getPort(server)} (source: config)`,
      );
      expect(doctor.stdout()).toContain("provider auth: ok (GET /models)");
      expect(doctor.stdout()).not.toContain(secret);
      expect(doctor.stderr()).toBe("");
      expect(requests).toEqual([`Bearer ${secret}`]);
      expect((await stat(join(home, "auth.json"))).mode & 0o777).toBe(0o600);
    } finally {
      await close(server);
      await rm(home, { recursive: true, force: true });
    }
  });

  test(`Given a user stores provider auth and config,
    When the user runs a one-shot prompt without provider env,
    Then Keel sends the request with the stored provider credentials`, async () => {
    // Given
    const home = await mkdtemp(join(tmpdir(), "keel-provider-run-home-"));
    const secret = "stored-run-secret";
    const requests: {
      readonly authorization: string;
      readonly body: unknown;
    }[] = [];
    const server = createServer((req, res) => {
      if (req.url !== "/chat/completions") {
        res.writeHead(404);
        res.end();
        return;
      }

      const chunks: Buffer[] = [];
      req.on("data", (chunk: Buffer) => {
        chunks.push(chunk);
      });
      req.on("end", () => {
        requests.push({
          authorization: req.headers.authorization ?? "",
          body: JSON.parse(Buffer.concat(chunks).toString("utf8")),
        });
        res.writeHead(200, {
          "Content-Type": "text/event-stream",
          "Cache-Control": "no-cache",
          Connection: "keep-alive",
        });
        res.end(sseTextReplyWithUsage("configured run ok"));
      });
    });
    await listen(server);
    const login = createRuntime(
      ["auth", "login", "deepseek", "--with-api-key"],
      {
        env: { KEEL_HOME: home },
        input: inputText(`${secret}\n`),
      },
    );
    const configured = createRuntime(
      [
        "config",
        "set-provider",
        "deepseek",
        "--model",
        "deepseek-v4-flash",
        "--base-url",
        `http://127.0.0.1:${getPort(server)}`,
      ],
      { env: { KEEL_HOME: home } },
    );
    const run = createRuntime(["hello"], {
      env: { KEEL_HOME: home },
    });

    try {
      // When
      const loginExit = await runCliMain(login.runtime);
      const configExit = await runCliMain(configured.runtime);
      const runExit = await runCliMain(run.runtime);

      // Then
      expect(loginExit).toBe(0);
      expect(configExit).toBe(0);
      expect(runExit).toBe(0);
      expect(run.stdout()).toBe("configured run ok\n");
      expect(run.stderr()).toBe("");
      expect(run.stdout()).not.toContain(secret);
      expect(requests).toHaveLength(1);
      expect(requests[0]).toMatchObject({
        authorization: `Bearer ${secret}`,
      });
      expect(requestModelSchema.parse(requests[0]?.body)).toEqual({
        model: "deepseek-v4-flash",
      });
    } finally {
      await close(server);
      await rm(home, { recursive: true, force: true });
    }
  });

  test(`Given stored provider config has a trailing-slash base URL,
    When the user runs a one-shot prompt,
    Then Keel sends the request to the chat completions endpoint`, async () => {
    // Given
    const home = await mkdtemp(
      join(tmpdir(), "keel-provider-config-slash-home-"),
    );
    const requests: string[] = [];
    const server = createServer((req, res) => {
      requests.push(req.url ?? "");
      if (req.url !== "/chat/completions") {
        res.writeHead(404);
        res.end();
        return;
      }

      req.resume();
      req.on("end", () => {
        res.writeHead(200, {
          "Content-Type": "text/event-stream",
          "Cache-Control": "no-cache",
          Connection: "keep-alive",
        });
        res.end(sseTextReplyWithUsage("configured slash ok"));
      });
    });
    await listen(server);
    const login = createRuntime(
      ["auth", "login", "deepseek", "--with-api-key"],
      {
        env: { KEEL_HOME: home },
        input: inputText("stored-slash-secret\n"),
      },
    );
    const configured = createRuntime(
      [
        "config",
        "set-provider",
        "deepseek",
        "--base-url",
        `http://127.0.0.1:${getPort(server)}/`,
      ],
      { env: { KEEL_HOME: home } },
    );
    const run = createRuntime(["hello"], {
      env: { KEEL_HOME: home },
    });

    try {
      // When
      const loginExit = await runCliMain(login.runtime);
      const configExit = await runCliMain(configured.runtime);
      const runExit = await runCliMain(run.runtime);

      // Then
      expect(loginExit).toBe(0);
      expect(configExit).toBe(0);
      expect(runExit).toBe(0);
      expect(run.stdout()).toBe("configured slash ok\n");
      expect(run.stderr()).toBe("");
      expect(requests).toEqual(["/chat/completions"]);
    } finally {
      await close(server);
      await rm(home, { recursive: true, force: true });
    }
  });

  test(`Given provider env has a trailing-slash base URL,
    When the user runs a one-shot prompt,
    Then Keel sends the request to the chat completions endpoint`, async () => {
    // Given
    const requests: string[] = [];
    const server = createServer((req, res) => {
      requests.push(req.url ?? "");
      if (req.url !== "/chat/completions") {
        res.writeHead(404);
        res.end();
        return;
      }

      req.resume();
      req.on("end", () => {
        res.writeHead(200, {
          "Content-Type": "text/event-stream",
          "Cache-Control": "no-cache",
          Connection: "keep-alive",
        });
        res.end(sseTextReplyWithUsage("env slash ok"));
      });
    });
    await listen(server);
    const run = createRuntime(["hello"], {
      env: {
        KEEL_PROVIDER: "deepseek",
        DEEPSEEK_API_KEY: "env-slash-secret",
        DEEPSEEK_BASE_URL: `http://127.0.0.1:${getPort(server)}/`,
      },
    });

    try {
      // When
      const runExit = await runCliMain(run.runtime);

      // Then
      expect(runExit).toBe(0);
      expect(run.stdout()).toBe("env slash ok\n");
      expect(run.stderr()).toBe("");
      expect(requests).toEqual(["/chat/completions"]);
    } finally {
      await close(server);
    }
  });

  test(`Given a stored API key exists,
    When the user checks and then logs out provider auth,
    Then status shows only redacted credential state`, async () => {
    // Given
    const home = await mkdtemp(join(tmpdir(), "keel-auth-status-home-"));
    const secret = "status-secret";
    const login = createRuntime(
      ["auth", "login", "deepseek", "--with-api-key"],
      {
        env: { KEEL_HOME: home },
        input: inputText(`${secret}\n`),
      },
    );
    const statusBefore = createRuntime(["auth", "status"], {
      env: { KEEL_HOME: home },
    });
    const logout = createRuntime(["auth", "logout", "deepseek"], {
      env: { KEEL_HOME: home },
    });
    const statusAfter = createRuntime(["auth", "status"], {
      env: { KEEL_HOME: home },
    });

    try {
      // When
      const loginExit = await runCliMain(login.runtime);
      const statusBeforeExit = await runCliMain(statusBefore.runtime);
      const logoutExit = await runCliMain(logout.runtime);
      const statusAfterExit = await runCliMain(statusAfter.runtime);

      // Then
      expect(loginExit).toBe(0);
      expect(statusBeforeExit).toBe(0);
      expect(statusBefore.stdout()).toContain("deepseek: present");
      expect(statusBefore.stdout()).not.toContain(secret);
      expect(logoutExit).toBe(0);
      expect(logout.stdout()).toBe("Removed API key for deepseek.\n");
      expect(statusAfterExit).toBe(0);
      expect(statusAfter.stdout()).toContain("deepseek: missing");
      expect(statusAfter.stdout()).not.toContain(secret);
      expect(statusBefore.stderr()).toBe("");
      expect(logout.stderr()).toBe("");
      expect(statusAfter.stderr()).toBe("");
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });

  test(`Given no provider credentials are stored,
    When the user checks auth status and logs out,
    Then Keel reports missing credentials without treating it as an error`, async () => {
    // Given
    const home = await mkdtemp(join(tmpdir(), "keel-auth-empty-home-"));
    const status = createRuntime(["auth", "status"], {
      env: { KEEL_HOME: home },
    });
    const logout = createRuntime(["auth", "logout", "deepseek"], {
      env: { KEEL_HOME: home },
    });

    try {
      // When
      const statusExit = await runCliMain(status.runtime);
      const logoutExit = await runCliMain(logout.runtime);

      // Then
      expect(statusExit).toBe(0);
      expect(status.stdout()).toContain("fake: not-required");
      expect(status.stdout()).toContain("deepseek: missing");
      expect(logoutExit).toBe(0);
      expect(logout.stdout()).toBe("No API key stored for deepseek.\n");
      expect(status.stderr()).toBe("");
      expect(logout.stderr()).toBe("");
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });

  test(`Given auth login receives empty stdin,
    When the user tries to store a provider key,
    Then Keel rejects the missing key`, async () => {
    // Given
    const fixture = createRuntime(
      ["auth", "login", "deepseek", "--with-api-key"],
      {
        input: inputText("\n"),
      },
    );

    // When
    const exitCode = await runCliMain(fixture.runtime);

    // Then
    expect(exitCode).toBe(1);
    expect(fixture.stdout()).toBe("");
    expect(fixture.stderr()).toBe(
      "Error: auth login requires an API key on stdin.\n",
    );
  });

  test(`Given auth login receives a multi-line stdin value,
    When the user tries to store a provider key,
    Then Keel rejects it before writing auth state`, async () => {
    // Given
    const home = await mkdtemp(join(tmpdir(), "keel-auth-multiline-home-"));
    const fixture = createRuntime(
      ["auth", "login", "deepseek", "--with-api-key"],
      {
        env: { KEEL_HOME: home },
        input: inputText("first-line\nsecond-line\n"),
      },
    );

    try {
      // When
      const exitCode = await runCliMain(fixture.runtime);

      // Then
      expect(exitCode).toBe(1);
      expect(fixture.stdout()).toBe("");
      expect(fixture.stderr()).toBe(
        "Error: auth login requires a single-line API key on stdin.\n",
      );
      await expect(readFile(join(home, "auth.json"), "utf8")).rejects.toThrow(
        /ENOENT/u,
      );
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });

  test(`Given auth login receives string chunks,
    When the user stores a provider key,
    Then Keel stores the API key from stdin`, async () => {
    // Given
    const home = await mkdtemp(join(tmpdir(), "keel-auth-string-home-"));
    const fixture = createRuntime(
      ["auth", "login", "deepseek", "--with-api-key"],
      {
        env: { KEEL_HOME: home },
        input: stringInputText("string-chunk-secret\n"),
      },
    );

    try {
      // When
      const exitCode = await runCliMain(fixture.runtime);

      // Then
      expect(exitCode).toBe(0);
      expect(fixture.stdout()).toBe("Stored API key for deepseek.\n");
      expect(fixture.stderr()).toBe("");
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });

  test(`Given Kimi and Qwen credentials are stored,
    When the user logs both providers out,
    Then Keel updates each provider credential independently`, async () => {
    // Given
    const home = await mkdtemp(join(tmpdir(), "keel-auth-multi-home-"));
    const kimiLogin = createRuntime(
      ["auth", "login", "kimi", "--with-api-key"],
      {
        env: { KEEL_HOME: home },
        input: inputText("kimi-secret\n"),
      },
    );
    const qwenLogin = createRuntime(
      ["auth", "login", "qwen", "--with-api-key"],
      {
        env: { KEEL_HOME: home },
        input: inputText("qwen-secret\n"),
      },
    );
    const statusBefore = createRuntime(["auth", "status"], {
      env: { KEEL_HOME: home },
    });
    const kimiLogout = createRuntime(["auth", "logout", "kimi"], {
      env: { KEEL_HOME: home },
    });
    const qwenLogout = createRuntime(["auth", "logout", "qwen"], {
      env: { KEEL_HOME: home },
    });
    const statusAfter = createRuntime(["auth", "status"], {
      env: { KEEL_HOME: home },
    });

    try {
      // When
      const kimiLoginExit = await runCliMain(kimiLogin.runtime);
      const qwenLoginExit = await runCliMain(qwenLogin.runtime);
      const statusBeforeExit = await runCliMain(statusBefore.runtime);
      const kimiLogoutExit = await runCliMain(kimiLogout.runtime);
      const qwenLogoutExit = await runCliMain(qwenLogout.runtime);
      const statusAfterExit = await runCliMain(statusAfter.runtime);

      // Then
      expect(kimiLoginExit).toBe(0);
      expect(qwenLoginExit).toBe(0);
      expect(statusBeforeExit).toBe(0);
      expect(statusBefore.stdout()).toContain("kimi: present");
      expect(statusBefore.stdout()).toContain("qwen: present");
      expect(kimiLogoutExit).toBe(0);
      expect(qwenLogoutExit).toBe(0);
      expect(statusAfterExit).toBe(0);
      expect(statusAfter.stdout()).toContain("kimi: missing");
      expect(statusAfter.stdout()).toContain("qwen: missing");
      expect(statusBefore.stdout()).not.toContain("secret");
      expect(statusAfter.stdout()).not.toContain("secret");
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });

  test.each([
    [["auth", "login"], "Error: <provider> requires a value.\n"],
    [
      ["auth", "status", "extra"],
      'Error: unknown auth status option "extra"\n',
    ],
    [
      ["auth", "login", "deepseek"],
      "Error: auth login requires --with-api-key.\n",
    ],
    [
      ["auth", "login", "deepseek", "--with-api-key", "extra"],
      'Error: unknown auth login option "extra"\n',
    ],
    [
      ["auth", "logout", "deepseek", "extra"],
      'Error: unknown auth logout option "extra"\n',
    ],
    [
      ["auth", "logout", "fake"],
      "Error: <provider> must be one of: deepseek, kimi, qwen.\n",
    ],
    [
      ["auth", "rotate", "deepseek"],
      'Error: unknown auth subcommand "rotate"\n',
    ],
    [
      ["auth"],
      "Error: auth requires a subcommand: login, logout, or status.\n",
    ],
  ])(`Given invalid auth command syntax %j,
    When the user runs Keel,
    Then Keel reports the auth syntax problem`, async (args, message) => {
    // Given
    const fixture = createRuntime(args);

    // When
    const exitCode = await runCliMain(fixture.runtime);

    // Then
    expect(exitCode).toBe(1);
    expect(fixture.stdout()).toBe("");
    expect(fixture.stderr()).toBe(message);
  });

  test(`Given auth storage contains invalid JSON,
    When the user checks auth status,
    Then Keel reports the corrupt auth file`, async () => {
    // Given
    const home = await mkdtemp(join(tmpdir(), "keel-auth-corrupt-home-"));
    await writeFile(join(home, "auth.json"), "{not-json", "utf8");
    const fixture = createRuntime(["auth", "status"], {
      env: { KEEL_HOME: home },
    });

    try {
      // When
      const exitCode = await runCliMain(fixture.runtime);

      // Then
      expect(exitCode).toBe(1);
      expect(fixture.stdout()).toBe("");
      expect(fixture.stderr()).toContain("cannot read provider auth");
      expect(fixture.stderr()).toContain("invalid JSON");
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });

  test(`Given auth storage contains the wrong schema,
    When the user checks auth status,
    Then Keel reports the invalid auth file`, async () => {
    // Given
    const home = await mkdtemp(join(tmpdir(), "keel-auth-invalid-home-"));
    await writeFile(join(home, "auth.json"), '{"schemaVersion":1}', "utf8");
    const fixture = createRuntime(["auth", "status"], {
      env: { KEEL_HOME: home },
    });

    try {
      // When
      const exitCode = await runCliMain(fixture.runtime);

      // Then
      expect(exitCode).toBe(1);
      expect(fixture.stdout()).toBe("");
      expect(fixture.stderr()).toContain("cannot read provider auth");
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });

  test(`Given KEEL_HOME is not a directory,
    When the user stores provider auth,
    Then Keel reports that auth cannot be written`, async () => {
    // Given
    const homeParent = await mkdtemp(join(tmpdir(), "keel-auth-blocked-"));
    const blockedHome = join(homeParent, "blocked-home");
    await writeFile(blockedHome, "not a directory", "utf8");
    const fixture = createRuntime(
      ["auth", "login", "deepseek", "--with-api-key"],
      {
        env: { KEEL_HOME: blockedHome },
        input: inputText("blocked-secret\n"),
      },
    );

    try {
      // When
      const exitCode = await runCliMain(fixture.runtime);

      // Then
      expect(exitCode).toBe(1);
      expect(fixture.stdout()).toBe("");
      expect(fixture.stderr()).toContain("cannot read provider auth");
      expect(fixture.stderr()).not.toContain("blocked-secret");
    } finally {
      await rm(homeParent, { recursive: true, force: true });
    }
  });

  test(`Given the fake provider does not require credentials,
    When the user tries to store an API key for fake,
    Then Keel rejects the login as an unsupported auth target`, async () => {
    // Given
    const fixture = createRuntime(["auth", "login", "fake", "--with-api-key"], {
      input: inputText("fake-secret\n"),
    });

    // When
    const exitCode = await runCliMain(fixture.runtime);

    // Then
    expect(exitCode).toBe(1);
    expect(fixture.stdout()).toBe("");
    expect(fixture.stderr()).toBe(
      "Error: <provider> must be one of: deepseek, kimi, qwen.\n",
    );
  });

  test(`Given provider config is stored under KEEL_HOME,
    When environment provider and model values are present,
    Then doctor uses environment values before user config`, async () => {
    // Given
    const home = await mkdtemp(join(tmpdir(), "keel-provider-config-home-"));
    const configured = createRuntime(
      ["config", "set-provider", "deepseek", "--model", "deepseek-v4-flash"],
      { env: { KEEL_HOME: home } },
    );
    const doctor = createRuntime(["--doctor", "--offline"], {
      env: {
        KEEL_HOME: home,
        KEEL_PROVIDER: "qwen",
        QWEN_MODEL: "qwen3.7-plus",
        QWEN_API_KEY: "env-qwen-secret",
      },
    });

    try {
      // When
      const configExit = await runCliMain(configured.runtime);
      const doctorExit = await runCliMain(doctor.runtime);

      // Then
      expect(configExit).toBe(0);
      expect(doctorExit).toBe(0);
      expect(doctor.stdout()).toContain(
        "provider: qwen (source: KEEL_PROVIDER)",
      );
      expect(doctor.stdout()).toContain(
        "model: qwen3.7-plus (source: QWEN_MODEL)",
      );
      expect(doctor.stdout()).toContain("api key: present (QWEN_API_KEY)");
      expect(doctor.stdout()).not.toContain("env-qwen-secret");
      expect(doctor.stderr()).toBe("");
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });

  test(`Given provider auth is stored and an API key env is present,
    When doctor probes the configured provider,
    Then Keel uses the environment key before the auth file`, async () => {
    // Given
    const home = await mkdtemp(join(tmpdir(), "keel-provider-auth-env-home-"));
    const authSecret = "stored-auth-secret";
    const envSecret = "env-secret";
    const requests: string[] = [];
    const server = createServer((req, res) => {
      requests.push(req.headers.authorization ?? "");
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ data: [] }));
    });
    await listen(server);

    try {
      const login = createRuntime(
        ["auth", "login", "deepseek", "--with-api-key"],
        {
          env: { KEEL_HOME: home },
          input: inputText(`${authSecret}\n`),
        },
      );
      const configured = createRuntime(
        [
          "config",
          "set-provider",
          "deepseek",
          "--base-url",
          `http://127.0.0.1:${getPort(server)}`,
        ],
        { env: { KEEL_HOME: home } },
      );
      const doctor = createRuntime(["--doctor"], {
        env: {
          KEEL_HOME: home,
          DEEPSEEK_API_KEY: envSecret,
        },
      });

      // When
      const loginExit = await runCliMain(login.runtime);
      const configExit = await runCliMain(configured.runtime);
      const doctorExit = await runCliMain(doctor.runtime);

      // Then
      expect(loginExit).toBe(0);
      expect(configExit).toBe(0);
      expect(doctorExit).toBe(0);
      expect(doctor.stdout()).toContain("api key: present (DEEPSEEK_API_KEY)");
      expect(doctor.stdout()).not.toContain(authSecret);
      expect(doctor.stdout()).not.toContain(envSecret);
      expect(requests).toEqual([`Bearer ${envSecret}`]);
      expect(doctor.stderr()).toBe("");
    } finally {
      await close(server);
      await rm(home, { recursive: true, force: true });
    }
  });

  test(`Given a provider base URL contains secret-bearing components,
    When the user stores provider config,
    Then Keel rejects it without echoing the URL`, async () => {
    // Given
    const fixture = createRuntime([
      "config",
      "set-provider",
      "deepseek",
      "--base-url",
      "https://user:secret@example.test/v1?token=secret#secret",
    ]);

    // When
    const exitCode = await runCliMain(fixture.runtime);

    // Then
    expect(exitCode).toBe(1);
    expect(fixture.stdout()).toBe("");
    expect(fixture.stderr()).toBe(
      "Error: --base-url base URL must not include credentials, query, or fragment.\n",
    );
    expect(fixture.stderr()).not.toContain("secret");
  });

  test.each([
    [
      ["config", "set-provider", "deepseek", "--base-url="],
      "Error: --base-url requires a value.\n",
    ],
    [["config", "set-provider"], "Error: <provider> requires a value.\n"],
    [
      ["config", "set-provider", "deepseek", "--model", "--base-url"],
      'Error: --model requires a value, but got option "--base-url".\n',
    ],
    [
      ["config", "set-provider", "deepseek", "--model="],
      "Error: --model requires a value.\n",
    ],
    [
      ["config", "set-provider", "deepseek", "--base-url", "--model"],
      'Error: --base-url requires a value, but got option "--model".\n',
    ],
    [
      ["config", "set-provider", "deepseek", "--unknown"],
      'Error: unknown config set-provider option "--unknown"\n',
    ],
    [
      ["config", "show", "extra"],
      'Error: unknown config show option "extra"\n',
    ],
    [
      ["config", "remove-provider"],
      'Error: unknown config subcommand "remove-provider"\n',
    ],
    [
      ["config"],
      "Error: config requires a subcommand: set-provider or show.\n",
    ],
  ])(`Given invalid config command syntax %j,
    When the user runs Keel,
    Then Keel reports the config syntax problem`, async (args, message) => {
    // Given
    const fixture = createRuntime(args);

    // When
    const exitCode = await runCliMain(fixture.runtime);

    // Then
    expect(exitCode).toBe(1);
    expect(fixture.stdout()).toBe("");
    expect(fixture.stderr()).toBe(message);
  });

  test(`Given fake provider config includes an unused model override,
    When the user stores provider config,
    Then Keel rejects the unsupported fake setting`, async () => {
    // Given
    const fixture = createRuntime([
      "config",
      "set-provider",
      "fake",
      "--model",
      "custom-fake",
    ]);

    // When
    const exitCode = await runCliMain(fixture.runtime);

    // Then
    expect(exitCode).toBe(1);
    expect(fixture.stdout()).toBe("");
    expect(fixture.stderr()).toBe(
      "Error: fake provider does not use a model override.\n",
    );
  });

  test(`Given fake provider config includes an unused base URL,
    When the user stores provider config,
    Then Keel rejects the unsupported fake endpoint`, async () => {
    // Given
    const fixture = createRuntime([
      "config",
      "set-provider",
      "fake",
      "--base-url",
      "https://example.test",
    ]);

    // When
    const exitCode = await runCliMain(fixture.runtime);

    // Then
    expect(exitCode).toBe(1);
    expect(fixture.stdout()).toBe("");
    expect(fixture.stderr()).toBe(
      "Error: fake provider does not use a base URL.\n",
    );
  });

  test(`Given no provider config exists,
    When the user asks to show config,
    Then Keel reports built-in defaults without creating secrets`, async () => {
    // Given
    const home = await mkdtemp(join(tmpdir(), "keel-config-empty-home-"));
    const fixture = createRuntime(["config", "show"], {
      env: { KEEL_HOME: home },
    });

    try {
      // When
      const exitCode = await runCliMain(fixture.runtime);

      // Then
      expect(exitCode).toBe(0);
      expect(fixture.stdout()).toContain("provider: default");
      expect(fixture.stdout()).toContain("model: default");
      expect(fixture.stdout()).toContain("base url: default");
      expect(fixture.stdout()).not.toContain("api key");
      expect(fixture.stderr()).toBe("");
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });

  test(`Given provider config only stores the provider id,
    When the user asks to show config,
    Then Keel reports default model and base URL values`, async () => {
    // Given
    const home = await mkdtemp(join(tmpdir(), "keel-config-partial-home-"));
    const config = createRuntime(["config", "set-provider", "deepseek"], {
      env: { KEEL_HOME: home },
    });
    const show = createRuntime(["config", "show"], {
      env: { KEEL_HOME: home },
    });

    try {
      // When
      const configExit = await runCliMain(config.runtime);
      const showExit = await runCliMain(show.runtime);

      // Then
      expect(configExit).toBe(0);
      expect(showExit).toBe(0);
      expect(show.stdout()).toContain("provider: deepseek");
      expect(show.stdout()).toContain("model: default");
      expect(show.stdout()).toContain("base url: default");
      expect(show.stdout()).not.toContain("api key");
      expect(show.stderr()).toBe("");
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });

  test(`Given provider config selects an unknown-priced model,
    When the user enables cost tracking,
    Then Keel reports the config model source`, async () => {
    // Given
    const home = await mkdtemp(join(tmpdir(), "keel-config-cost-home-"));
    const config = createRuntime(
      ["config", "set-provider", "deepseek", "--model", "deepseek-unknown"],
      { env: { KEEL_HOME: home } },
    );
    const run = createRuntime(["--max-cost", "1", "hello"], {
      env: {
        KEEL_HOME: home,
        DEEPSEEK_API_KEY: "test-key",
      },
    });

    try {
      // When
      const configExit = await runCliMain(config.runtime);
      const runExit = await runCliMain(run.runtime);

      // Then
      expect(configExit).toBe(0);
      expect(runExit).toBe(1);
      expect(run.stdout()).toBe("");
      expect(run.stderr()).toBe(
        'Error: cost tracking is only supported for known DeepSeek model pricing; configured config model="deepseek-unknown".\n',
      );
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });

  test(`Given provider config contains invalid JSON,
    When the user asks to show config,
    Then Keel reports the corrupt config file`, async () => {
    // Given
    const home = await mkdtemp(join(tmpdir(), "keel-config-corrupt-home-"));
    await writeFile(join(home, "config.json"), "{not-json", "utf8");
    const fixture = createRuntime(["config", "show"], {
      env: { KEEL_HOME: home },
    });

    try {
      // When
      const exitCode = await runCliMain(fixture.runtime);

      // Then
      expect(exitCode).toBe(1);
      expect(fixture.stdout()).toBe("");
      expect(fixture.stderr()).toContain("cannot read provider config");
      expect(fixture.stderr()).toContain("invalid JSON");
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });

  test(`Given provider config contains the wrong schema,
    When the user asks to show config,
    Then Keel reports the invalid config file`, async () => {
    // Given
    const home = await mkdtemp(join(tmpdir(), "keel-config-invalid-home-"));
    await writeFile(
      join(home, "config.json"),
      '{"schemaVersion":1,"provider":{"id":"deepseek","model":""}}',
      "utf8",
    );
    const fixture = createRuntime(["config", "show"], {
      env: { KEEL_HOME: home },
    });

    try {
      // When
      const exitCode = await runCliMain(fixture.runtime);

      // Then
      expect(exitCode).toBe(1);
      expect(fixture.stdout()).toBe("");
      expect(fixture.stderr()).toContain("cannot read provider config");
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });

  test(`Given provider config is corrupt during provider resolution,
    When doctor resolves the provider from user config,
    Then Keel reports the provider config read error`, async () => {
    // Given
    const home = await mkdtemp(join(tmpdir(), "keel-config-doctor-invalid-"));
    await writeFile(join(home, "config.json"), "{not-json", "utf8");
    const fixture = createRuntime(["--doctor", "--offline"], {
      env: { KEEL_HOME: home },
    });

    try {
      // When
      const exitCode = await runCliMain(fixture.runtime);

      // Then
      expect(exitCode).toBe(1);
      expect(fixture.stdout()).toContain("provider: failed");
      expect(fixture.stderr()).toContain("cannot read provider config");
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });

  test(`Given provider auth cannot be parsed during provider resolution,
    When doctor checks a provider selected from env,
    Then Keel reports the provider auth read error`, async () => {
    // Given
    const home = await mkdtemp(join(tmpdir(), "keel-auth-doctor-invalid-"));
    await writeFile(join(home, "auth.json"), "{not-json", "utf8");
    const fixture = createRuntime(["--doctor", "--offline"], {
      env: {
        KEEL_HOME: home,
        KEEL_PROVIDER: "deepseek",
      },
    });

    try {
      // When
      const exitCode = await runCliMain(fixture.runtime);

      // Then
      expect(exitCode).toBe(1);
      expect(fixture.stdout()).toContain("provider: failed");
      expect(fixture.stderr()).toContain("cannot read provider auth");
      expect(fixture.stderr()).toContain("invalid JSON");
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });

  test(`Given provider auth is unreadable current data,
    When the user checks auth status,
    Then Keel reports the read failure`, async () => {
    // Given
    const home = await mkdtemp(join(tmpdir(), "keel-auth-eisdir-home-"));
    await mkdir(join(home, "auth.json"));
    const fixture = createRuntime(["auth", "status"], {
      env: { KEEL_HOME: home },
    });

    try {
      // When
      const exitCode = await runCliMain(fixture.runtime);

      // Then
      expect(exitCode).toBe(1);
      expect(fixture.stdout()).toBe("");
      expect(fixture.stderr()).toContain("cannot read provider auth");
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });

  test(`Given KEEL_HOME is not a directory,
    When the user stores provider config,
    Then Keel reports that the config cannot be written`, async () => {
    // Given
    const homeParent = await mkdtemp(join(tmpdir(), "keel-config-blocked-"));
    const blockedHome = join(homeParent, "blocked-home");
    await writeFile(blockedHome, "not a directory", "utf8");
    const fixture = createRuntime(["config", "set-provider", "deepseek"], {
      env: { KEEL_HOME: blockedHome },
    });

    try {
      // When
      const exitCode = await runCliMain(fixture.runtime);

      // Then
      expect(exitCode).toBe(1);
      expect(fixture.stdout()).toBe("");
      expect(fixture.stderr()).toContain("cannot write provider config");
    } finally {
      await rm(homeParent, { recursive: true, force: true });
    }
  });

  test(`Given provider config exists,
    When the user asks to show config,
    Then Keel prints non-secret provider defaults from KEEL_HOME`, async () => {
    // Given
    const home = await mkdtemp(join(tmpdir(), "keel-config-show-home-"));
    const config = createRuntime(
      [
        "config",
        "set-provider",
        "kimi",
        "--model=kimi-k2.6",
        "--base-url=https://api.moonshot.cn/v1",
      ],
      { env: { KEEL_HOME: home } },
    );
    const show = createRuntime(["config", "show"], {
      env: { KEEL_HOME: home },
    });

    try {
      // When
      const configExit = await runCliMain(config.runtime);
      const showExit = await runCliMain(show.runtime);

      // Then
      expect(configExit).toBe(0);
      expect(showExit).toBe(0);
      expect(show.stdout()).toContain("provider: kimi");
      expect(show.stdout()).toContain("model: kimi-k2.6");
      expect(show.stdout()).toContain("base url: https://api.moonshot.cn/v1");
      expect(show.stdout()).not.toContain("api key");
      expect(show.stderr()).toBe("");
      expect(
        JSON.parse(await readFile(join(home, "config.json"), "utf8")),
      ).toEqual({
        schemaVersion: 1,
        provider: {
          id: "kimi",
          model: "kimi-k2.6",
          baseUrl: "https://api.moonshot.cn/v1",
        },
      });
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });
});
