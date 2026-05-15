# Slicing

How to slice work in this project. Every task, feature, and iteration follows these rules.

## The Rule

Each deliverable is a vertical slice: a user can run it end-to-end and get a result. If a user can't use what you shipped, you shipped nothing.

## How to Slice

**Vertical (correct):** cut through all layers — input → logic → output. Each slice is a thinner system that works.

**Horizontal (wrong):** cut by layer — "finish types first", "finish tools next". No slice works until the last one is done.

Test: *Can someone run this and see it do something useful?* Yes = vertical. No = horizontal.

## Example

Building an agent that edits files:

| Slice | What ships | What a user can do |
|-------|-----------|-------------------|
| 1 | Fake LLM + loop + text-only response | Send a message, see agent reply |
| 2 | + tool call (edit), single round | Ask agent to fix a line, file changes |
| 3 | + multi-round tool calls | Agent reads a file, then edits it |
| 4 | + error recovery | Agent hits a failure, retries, completes |
| 5 | + cost tracking + budget stop | Agent stops when cost limit is reached |

Each slice is the previous slice plus one capability. Each slice is end-to-end usable. **New slices grow on top of the working system — never throw away and rebuild.** Software is soft: a bicycle can have an engine bolted on and become a motorcycle, and the bicycle keeps working right up until the moment the engine is ready.

Wrong way to slice the same work:

```
Slice 1: All LLM types and provider interfaces
Slice 2: All tool implementations
Slice 3: Agent loop
Slice 4: CLI entry point
→ Nothing works until slice 4 is done.
```

## Applying to Tests (BDD)

Each test is also a vertical slice. It starts with user intent and ends with an observable outcome:

```
Given [a situation a user is in]
When  [the user does something]
Then  [something the user can see changes]
```

A test like "LLMProvider.stream returns AsyncIterable" is horizontal — it tests a layer, not a behavior. Prefer: "Given a buggy file, When user asks to fix it, Then the file is corrected."

## When You're Stuck

If you can't figure out how to make the current slice end-to-end, you're probably trying to deliver too much. Remove scope until you can answer "what can a user do with this?" in one sentence.

Hardcode. Fake. Skip. Narrow the input. Limit to one file, one tool, one happy path. A working slice with hardcoded values beats a non-working slice with clean abstractions.

## Why Vertical Slicing Fails Without Tests

The reason most teams can't slice vertically: their code is too fragile to change. Each new slice modifies the existing system, and without test coverage, modifying means breaking. Developers get scared, demand "finalize requirements upfront," and fall back to horizontal slicing — which is just waterfall with extra meetings.

The causal chain: **no tests → afraid to change code → demand all requirements upfront → horizontal slicing → nothing works until the end → waterfall.**

Breaking the chain: **BDD test-first → code is safe to change → vertical slicing becomes possible → each slice is usable → actual agility.**

This is why the project enforces test-first. It is not a quality preference. It is the prerequisite that makes vertical slicing survivable.
