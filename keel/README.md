# Keel

Keel is a local AI coding agent for terminal workflows. It can inspect and edit
files, run tool-assisted coding tasks, persist interactive sessions, and use
DeepSeek, Kimi, or Qwen providers.

## Quickstart

Build the CLI from this repository:

```bash
pnpm install
pnpm build
pnpm link --global
```

Configure a provider with an API key. DeepSeek is the default provider:

```bash
printf '%s\n' "$DEEPSEEK_API_KEY" | keel setup deepseek --with-api-key
```

For Kimi or Qwen:

```bash
printf '%s\n' "$KIMI_API_KEY" | keel setup kimi --with-api-key
printf '%s\n' "${DASHSCOPE_API_KEY:-$QWEN_API_KEY}" | keel setup qwen --with-api-key
```

`keel setup` stores the API key under `KEEL_HOME/auth.json`, stores the default
provider under `KEEL_HOME/config.json`, and runs `keel --doctor` to verify the
setup. API keys are not written to project files, reports, transcripts, or
doctor output.

Run a first one-shot task:

```bash
keel "Inspect this project and summarize the main directories."
```

Start an interactive session:

```bash
keel
```

Interactive sessions are saved by default. Use `keel sessions` to find the
resume command for prior work, or `keel --ephemeral` when you intentionally do
not want a session ledger.

Useful follow-up commands:

```bash
keel --doctor
keel auth status
keel config show
keel sessions
```

## Provider Options

Provider setup accepts optional model and base URL overrides:

```bash
printf '%s\n' "$DEEPSEEK_API_KEY" | keel setup deepseek --with-api-key --model deepseek-v4-flash
printf '%s\n' "$DASHSCOPE_API_KEY" | keel setup qwen --with-api-key --base-url https://dashscope.aliyuncs.com/compatible-mode/v1
```

Use `--offline` to store configuration without probing the provider:

```bash
printf '%s\n' "$DEEPSEEK_API_KEY" | keel setup deepseek --with-api-key --offline
```

Per-run CLI flags and environment variables still override stored defaults.
