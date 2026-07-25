import { describe, expect, test } from "vitest";
import {
  locateExactEditSpans,
  locateUniqueEditSpan,
  originalSpan,
  sourcePreservingReplacement,
} from "../../src/tools/edit-match.ts";

interface FuzzyRoundTripCase {
  readonly content: string;
  readonly name: string;
  readonly oldText: string;
}

const fuzzyRoundTripCases: readonly FuzzyRoundTripCase[] = [
  {
    name: "trailing whitespace",
    content: "before\nalpha  \nbeta\t\nafter\n",
    oldText: "alpha\nbeta",
  },
  {
    name: "typographic punctuation",
    content: "before\nsay \u201chello\u201d now\nafter\n",
    oldText: 'say "hello" now',
  },
  {
    name: "indentation",
    content: "before\n    if (ready) {\n        run();\n    }\nafter\n",
    oldText: "if (ready) {\n    run();\n}\n",
  },
];

interface MismatchedSourceSpanCase {
  readonly name: string;
  readonly newText: string;
  readonly oldText: string;
  readonly source: string;
}

const mismatchedSourceSpanCases: readonly MismatchedSourceSpanCase[] = [
  {
    name: "different content",
    source: "alpha",
    oldText: "beta",
    newText: "gamma",
  },
  {
    name: "missing required final newline",
    source: "alpha",
    oldText: "alpha\n",
    newText: "beta\n",
  },
  {
    name: "missing required source line",
    source: "alpha",
    oldText: "alpha\nbeta",
    newText: "gamma",
  },
];

describe("Edit Match", () => {
  test(`Given a mapped edit span that starts outside the normalized text,
    When translating it back to the original CRLF source,
    Then the source-map invariant rejects the invalid span`, () => {
    // Given
    const normalized = {
      kind: "mapped" as const,
      text: "a\n",
      sourceIndexByNormalizedIndex: [0, 1],
    };

    // When
    const translate = () =>
      originalSpan(normalized, { index: 2, length: 0 }, 3);

    // Then
    expect(translate).toThrow(
      "source map invariant violated: match is invalid",
    );
  });

  test(`Given an empty search string,
    When locating a unique edit span,
    Then it reports not found without scanning forever`, () => {
    // Given / When
    const result = locateUniqueEditSpan("alpha\n", "");

    // Then
    expect(result).toEqual({ status: "not_found" });
    expect(locateExactEditSpans("alpha\n", "")).toEqual([]);
  });

  test.each(fuzzyRoundTripCases)(
    `Given a $name fuzzy edit target,
    When the matched source span is reconstructed for an identity edit,
    Then the original source bytes are preserved`,
    ({ content, oldText }) => {
      // Given / When
      const matchResult = locateUniqueEditSpan(content, oldText);

      // Then
      expect(matchResult.status).toBe("matched");
      if (matchResult.status !== "matched") {
        throw new Error("expected the fuzzy edit target to match");
      }
      const source = content.slice(
        matchResult.match.index,
        matchResult.match.index + matchResult.match.length,
      );
      expect(source).not.toBe(oldText);

      const replacementResult = sourcePreservingReplacement(
        source,
        oldText,
        oldText,
      );
      expect(replacementResult.status).toBe("matched");
      if (replacementResult.status !== "matched") {
        throw new Error("expected the fuzzy edit target to be preservable");
      }
      expect(replacementResult.replacement).toBe(source);
    },
  );

  test.each(mismatchedSourceSpanCases)(
    `Given a $name source span mismatch,
    When reconstructing a source-preserving replacement,
    Then it refuses the mismatched span`,
    ({ newText, oldText, source }) => {
      // Given / When
      const result = sourcePreservingReplacement(source, oldText, newText);

      // Then
      expect(result).toEqual({
        status: "not_preservable",
        reason: "fuzzy source span does not match any edit strategy",
      });
    },
  );
});
