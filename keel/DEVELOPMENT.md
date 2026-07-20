# Development Guidance

Detailed engineering guidance for Keel. `AGENTS.md` and `CLAUDE.md` stay short because they are loaded often; use this file for lower-frequency rules that still matter during implementation and review.

## Code Style

- Biome handles formatting and linting. Do not use ESLint or Prettier.
- No comments unless the reason is non-obvious.
- All interface properties are `readonly`; use function property syntax such as `readonly fn: (x: T) => R` because method syntax bypasses `strictFunctionTypes`.
- No `as` type assertions. Use type guards, `satisfies`, or schema validation to prove types. `as const` is allowed.
- Parse external data as `unknown` through an explicit Zod schema before business logic. Keep the schema at the JSON, process, network, LLM/tool, disk, config, or environment boundary; do not replace it with `Record<string, unknown>` property-access helpers.
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

Normalization or fuzzy matching may locate a target, but side effects must apply to the original source representation. Never reconstruct protected data from a lossy normalized view.

Give each safety policy one authoritative decision path. Adapters may translate its result or error contract, but must not reimplement the decision.

## Ownership And Anti-Drift

Give shared policies, transformations, and structured state one named owner. Consumers derive from that owner and may adapt presentation or errors; they do not maintain parallel decisions.

Keep decisions that must stay coupled in the same typed registry or table, including any inverse or reconstruction operation. Do not synchronize parallel lists by convention.

Hand-written projections of structured state are lossy until proven otherwise. Every semantic field must be preserved, derived, or intentionally dropped. Preserved and derived fields need roundtrip or invariant coverage; dropped fields need a named boundary reason.

An architecture invariant must name the relationship it owns and fail only when that relationship breaks. Prefer forbidden dependency directions, required facades or owners, and completeness checks for declared registries. Do not snapshot complete import, export, or file inventories unless that exact inventory is itself the contract. Use the shared AST helpers in `tests/invariants/_ast.ts` for focused, parser-aware checks, and prefer behavioral tests when the risk is runtime semantics rather than source ownership.

Automate stable repository-wide mechanical rules with a focused lint or invariant. Keep semantic decisions such as boundary ownership, behavioral equivalence, and test value in review; a broad source-shape scan is not a substitute for that judgment.

## Trust Boundaries

- File-tool access policy does not constrain shell execution. Shell approval is user consent, not sandboxing; do not claim an enforced filesystem boundary without OS-level enforcement.
- Live provider requests may contain user text, tool results, and approved shell output. At-rest redaction does not change live visibility, and generic live regex redaction is neither complete nor semantics-preserving.
- Tool-output artifacts contain raw, unredacted data under `KEEL_HOME`, use `0700` directories and `0600` files, and default to 30-day retention. Treat them as sensitive full-fidelity recovery state.
- Persist credentials only in designated secret state with `0600` file permissions. Never deliberately copy them to project files, logs, reports, transcripts, diagnostics, or non-secret configuration.
- Diagnostics must use the same authoritative resolver as the execution setting they report.

## Abstraction Discipline

Prefer concrete, linear code. Add abstraction only when it makes current code simpler, not future code imaginable.

- Start with the direct implementation for the slice in front of you.
- Abstract after the second real use case, proven duplication, or a clear external boundary.
- Keep control flow local and sequential when possible.
- Use indirection only when it names a real domain concept or protects a real boundary.
- Remove extension points that are not exercised by current behavior.
- Extract when inline detail obscures the calling function's control flow.
- Do not extract when the detail is the function's primary job.

## Type Precision

Default to required fields. Model the runtime meaning directly:

| Meaning | Type |
| --- | --- |
| Value always exists | Required field |
| Absence is meaningful | Optional field (`?`) |
| Field is present but may explicitly contain no value | `null` |

Make illegal states unrepresentable. Design internal types so invalid states
cannot be constructed. When fields are mutually exclusive or conditionally
required, model the valid modes with a discriminated union and put each mode's
required data on that variant. Do not use independently optional fields plus
downstream guards to encode a relationship. Couple values that must vary
together in one type so invalid constructions fail typecheck at the call site.

This rule applies to trusted internal state, not unvalidated external data. Parse
external values as `unknown` with a schema at the trust boundary, then convert
them into precise internal types. Tests prove reachable behavior, transitions,
and side effects; do not construct TypeScript-invalid combinations or retain
runtime guards to compensate for a type model that admits illegal internal
states.

Do not use `| undefined` on data properties. Put defaults in constructors or factories instead of making stable state optional, and remember that zero and empty strings are values. Reserve `Partial<T>` for update or override boundaries, not stored domain state. Check sentinels explicitly rather than with broad truthiness.

Function parameter types are contracts, not caller conveniences. Put conditional absence at the call site where it is visible.

Trust correct internal types. Delete guards for states the type excludes; narrow the type or keep a named runtime guard only when the predicate cannot be encoded.
