# Development Guidance

Detailed engineering guidance for Keel. `AGENTS.md` and `CLAUDE.md` stay short because they are loaded often; use this file for lower-frequency rules that still matter during implementation and review.

## Code Style

- Biome handles formatting and linting. Do not use ESLint or Prettier.
- No comments unless the reason is non-obvious.
- All interface properties are `readonly`.
- Use function property syntax for interface functions, such as `readonly fn: (x: T) => R`, not method syntax like `fn(x: T): R`. Method syntax bypasses `strictFunctionTypes`.
- No `as` type assertions. Use type guards, `satisfies`, or schema validation to prove types. `as const` is allowed.
- External data boundaries must parse `unknown` through an explicit schema before business logic. Use Zod for JSON from HTTP/SSE, LLM/tool arguments, child process stdout, config files, disk JSON, and environment-derived structured data.
- Do not use `Record<string, unknown>` property-access helpers for known external protocols. Model the protocol shape with a schema and access typed data only after `safeParse` or `parse`.
- In review, any `JSON.parse`, process output parsing, HTTP response parsing, or LLM argument parsing must show the schema boundary in the same module.
- The pre-commit hook auto-formats staged files.

## Pre-Release Compatibility

Keel is pre-release. Implement only the latest product model.
Do not add compatibility shims, migrations, fallback readers, old CLI aliases,
legacy schema support, or compatibility tests for old internal data, draft
schemas, or unfinished command shapes unless explicitly requested.

Current-schema recovery may handle corrupted current data only; it must not
read, transform, or preserve old formats.

Allowed breaking changes:

- session ledger and snapshot records
- report and eval JSON schemas
- provider/model config structure
- CLI command syntax that has not shipped in a release
- internal module APIs and type shapes

Do not break these invariants:

- each merged slice must leave a runnable user entrypoint
- workspace, permission, approval, and provider-visibility safety boundaries must
  stay explicit and tested
- destructive or security-sensitive behavior still needs BDD coverage at the
  owning boundary

## Safety Boundary Discipline

When code normalizes, resolves, parses, or transforms untrusted input before enforcing a policy, preserve every representation that can carry authorization meaning.

Validate both the requested representation and the resolved representation before acting. A helper must not collapse policy-relevant context into one clean value before access checks.

Edit fuzzy matching is only a locator. Replacement must splice the original file content by the matched source span; never rewrite a file from normalized matching text.

For safety boundaries, prefer one authoritative execution path. Parallel allow/deny paths drift over time and can leave dead code that only looks protective.

## Anti-Drift Patterns

Use a paired table when two decisions must stay coupled. `EDIT_MATCH_STRATEGIES` is the model: each locate strategy owns its matching source-preserving reconstruct strategy in the same object literal. Consumers must derive from the table instead of maintaining parallel locate/reconstruct lists.

Use an authoritative resolver when callers need different error contracts but the policy decision is the same. `resolveWorkspaceCreateTargetCore` owns create-target path resolution and returns a non-throwing result; executor paths can throw the returned `KeelError`, while scheduling paths can fail closed without duplicating path policy.

Use a shared helper when two tools perform the same safety-sensitive transformation. `edit-match.ts` owns CRLF normalization, source span reprojection, and source-line-ending replacement for both `edit` and `apply_patch`; neither tool should reimplement that source-preserving path locally.

Use curated invariants for declared registries and mechanical completeness, not broad structural similarity scans. The shared invariant AST helpers in `tests/invariants/_ast.ts` are for focused checks such as builtin tool metadata, limited-output registrations, and edit matching single sources. Prefer behavioral tests when the risk is runtime semantics rather than source ownership.

## Shell And Provider Visibility

Keel's project ignore policy is enforced by the built-in file tools: `read`, `ls`, `glob`, `grep`, `edit`, and `write`.

`bash` is disabled by default. When enabled with `--allow-bash` or `--bash-policy trusted`, it is trusted shell mode: commands run with the current OS user's permissions and may read or modify gitignored files.

`--bash-policy ask` adds per-command user approval in interactive sessions, but it is still approval, not an OS sandbox. Do not describe bash approval as preserving the file-tool ignore boundary unless a real permission or sandbox layer exists.

Live provider requests are not a secret boundary. User text, tool results, and approved or trusted bash output can be sent to the selected provider unredacted because exact code, fixtures, diffs, and command output are required for reliable coding.

Transcript, eval transcript, and session-ledger redaction is best-effort at-rest hygiene. It reduces accidental durable storage of common secret-like values, but it is not complete secret detection and does not change live provider serialization.

Tool output artifacts are a full-fidelity recovery store for oversized tool results. They are intentionally written as raw, unredacted tool output under `KEEL_HOME` with 0700/0600 filesystem modes, and callers must treat `KEEL_HOME` as sensitive at-rest data.

Do not add generic live regex redaction of tool output without a separate design decision. It can corrupt valid coding context and will miss transformed secrets.

## Abstraction Discipline

Prefer concrete, linear code. Add abstraction only when it makes current code simpler, not future code imaginable.

- Start with the direct implementation for the slice in front of you.
- Abstract after the second real use case, proven duplication, or a clear external boundary.
- Keep control flow local and sequential when possible.
- Use indirection only when it names a real domain concept or protects a real boundary.
- Remove extension points that are not exercised by current behavior.
- Extract when inline detail obscures the calling function's control flow.
- Do not extract when the detail is the function's primary job, such as process lifecycle wiring in a spawn wrapper or accumulator state transitions in a parser.

## Type Precision

Default to required fields. Only use `?` or `| undefined` when you can name the semantic reason.

Decision:

1. Does this field always exist at runtime? Use a required field.
2. Is absence meaningful, not the same as a default value? Use `?`.
3. Must the field be present, but the value can explicitly be nothing? Use `| null`.
4. Never use `| undefined` on data types. With `exactOptionalPropertyTypes`, use `?` for absence or redesign to avoid it.

Common mistakes:

- Do not use `?` because the caller might not pass it. Put defaults in a factory function.
- Do not use `?` because the value might be zero or an empty string. Zero and empty string are values, not absence.
- Do not use `Partial<T>` as the data type. Use it only at call boundaries such as function params and spread overrides.
- Do not use broad truthy/falsy checks for sentinel values. Use `value === null`, `value !== undefined`, `value === ""`, or `value === 0` to name the exact state.

Pattern:

```typescript
interface Response {
  readonly text: string;
  readonly tokenize: boolean;
  readonly usage: Usage;
}

function response(text: string, tokenize = false, usage = DEFAULT_USAGE): Response {
  return { text, tokenize, usage };
}
```

Use `?` for:

- Config the user may omit, where absence means use the system default.
- External API fields that may be absent.
- PATCH DTOs where only changed fields are sent.

Litmus test: if you would write `?? defaultValue` every time you read a field, make the field required and put the default in a factory.

Signature honesty: a function's parameter type is its contract, not a convenience wrapper for the caller. If the function's job is appending a message, accept `Message`, not `Message | null`. Put the null guard at the call site where the conditional is visible.

Trust correct internal types. Do not guard against states an already-trusted internal type excludes. Runtime checks that enforce domain predicates the type system cannot encode, such as workspace safety, range constraints, or protocol validity, are not redundant.

Decision: does the type permit this state? If no, delete the check. If yes, either narrow the type or keep the guard when the predicate is beyond the type system's reach.
