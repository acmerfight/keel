import { describe, expectTypeOf, test } from "vitest";
import type { SessionMessage } from "../../src/agent/session-message.ts";
import type { ProviderMessage } from "../../src/llm/types.ts";

type Extends<Left, Right> = [Left] extends [Right] ? true : false;

describe("message boundaries", () => {
  test(`Given durable session messages carry Runtime-only state,
    When their types are compared with provider messages,
    Then neither message audience can be substituted for the other`, () => {
    expectTypeOf<
      Extends<SessionMessage, ProviderMessage>
    >().toEqualTypeOf<false>();
    expectTypeOf<
      Extends<ProviderMessage, SessionMessage>
    >().toEqualTypeOf<false>();
  });
});
