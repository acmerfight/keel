export const SECRET_REDACTION_MARKER = "[REDACTED_SECRET]";

interface SecretTextRule {
  readonly label: string;
  readonly matches: (text: string) => boolean;
  readonly redact: (text: string) => string;
}

interface SecretValueSpan {
  readonly start: number;
  readonly end: number;
}

const BEARER_SECRET_PATTERN =
  /\bBearer[ \t]+(?!(?:token|tokens|authentication|authorization|credential|credentials|value|example|placeholder|redacted|your[_-](?:access[_-])?token)\b)[-._~+/=A-Za-z0-9]{12,}/giu;

function patternMatches(pattern: RegExp, text: string): boolean {
  pattern.lastIndex = 0;
  const matches = pattern.test(text);
  pattern.lastIndex = 0;
  return matches;
}

function regexSecretRule(options: {
  readonly label: string;
  readonly redactionPattern: RegExp;
  readonly auditPattern?: RegExp;
  readonly bearer?: boolean;
}): SecretTextRule {
  return {
    label: options.label,
    matches: (text) =>
      patternMatches(options.auditPattern ?? options.redactionPattern, text),
    redact: (text) =>
      text.replace(
        options.redactionPattern,
        options.bearer === true
          ? `Bearer ${SECRET_REDACTION_MARKER}`
          : SECRET_REDACTION_MARKER,
      ),
  };
}

function isEnvironmentSecretPlaceholder(value: string): boolean {
  const normalized = value.trim().toLowerCase();
  if (
    normalized.startsWith("${") ||
    normalized.startsWith("{{") ||
    normalized.startsWith("<") ||
    normalized.startsWith("[")
  ) {
    return true;
  }
  return /^(?:example|sample|placeholder|redacted|changeme|your)(?:$|[-_\s])/u.test(
    normalized,
  );
}

function isEnvironmentKeyCharacterAt(text: string, index: number): boolean {
  const code = text.charCodeAt(index);
  return (
    (code >= 48 && code <= 57) ||
    (code >= 65 && code <= 90) ||
    code === 95 ||
    (code >= 97 && code <= 122)
  );
}

function isEnvironmentAssignmentWhitespace(
  character: string | undefined,
): boolean {
  return character !== undefined && /\s/u.test(character);
}

function isEnvironmentSecretKey(key: string): boolean {
  const normalized = key.toUpperCase();
  return (
    normalized.includes("SECRET") ||
    normalized.includes("TOKEN") ||
    normalized.includes("APIKEY") ||
    normalized.includes("API_KEY") ||
    normalized.includes("ACCESSKEY") ||
    normalized.includes("ACCESS_KEY") ||
    normalized.includes("PRIVATEKEY") ||
    normalized.includes("PRIVATE_KEY") ||
    normalized.includes("PASSWORD")
  );
}

function hasEnvironmentSecretKeyBefore(
  text: string,
  equalsIndex: number,
): boolean {
  let keyEnd = equalsIndex;
  while (keyEnd > 0 && isEnvironmentAssignmentWhitespace(text[keyEnd - 1])) {
    keyEnd -= 1;
  }

  let keyStart = keyEnd;
  while (keyStart > 0 && isEnvironmentKeyCharacterAt(text, keyStart - 1)) {
    keyStart -= 1;
  }
  if (keyStart === keyEnd) return false;

  const trailingSegment = text.slice(keyStart, keyEnd);
  if (isEnvironmentSecretKey(trailingSegment)) return true;

  // API-KEY, ACCESS-KEY, and PRIVATE-KEY are the only accepted hyphenated
  // spellings. A preceding unrelated hyphen remains a boundary, matching the
  // non-hyphenated key grammar without backtracking over the whole input.
  if (
    text[keyStart - 1] !== "-" ||
    !trailingSegment.toUpperCase().startsWith("KEY")
  ) {
    return false;
  }
  const precedingSegmentEnd = keyStart - 1;
  let precedingSegmentStart = precedingSegmentEnd;
  while (
    precedingSegmentStart > 0 &&
    isEnvironmentKeyCharacterAt(text, precedingSegmentStart - 1)
  ) {
    precedingSegmentStart -= 1;
  }
  const precedingSegment = text
    .slice(precedingSegmentStart, precedingSegmentEnd)
    .toUpperCase();
  return (
    precedingSegment.endsWith("API") ||
    precedingSegment.endsWith("ACCESS") ||
    precedingSegment.endsWith("PRIVATE")
  );
}

function environmentSecretValueSpans(text: string): readonly SecretValueSpan[] {
  const spans: SecretValueSpan[] = [];
  let searchIndex = 0;
  for (;;) {
    const equalsIndex = text.indexOf("=", searchIndex);
    if (equalsIndex < 0) break;
    if (!hasEnvironmentSecretKeyBefore(text, equalsIndex)) {
      searchIndex = equalsIndex + 1;
      continue;
    }

    let rawValueStart = equalsIndex + 1;
    while (isEnvironmentAssignmentWhitespace(text[rawValueStart])) {
      rawValueStart += 1;
    }
    const quote = text[rawValueStart];
    const quoted = quote === '"' || quote === "'";
    const valueStart = quoted ? rawValueStart + 1 : rawValueStart;
    let valueEnd = valueStart;
    while (valueEnd < text.length) {
      const character = text[valueEnd];
      if (
        character === "\n" ||
        character === "\r" ||
        (quoted
          ? character === quote
          : character === undefined || /[\s"'`#]/u.test(character))
      ) {
        break;
      }
      valueEnd += 1;
    }
    const value = text.slice(valueStart, valueEnd);
    if (value.trim().length >= 12 && !isEnvironmentSecretPlaceholder(value)) {
      spans.push({ start: valueStart, end: valueEnd });
    }
    searchIndex =
      valueEnd > rawValueStart ? valueEnd + (quoted ? 1 : 0) : equalsIndex + 1;
  }
  return spans;
}

function redactEnvironmentSecrets(text: string): string {
  return environmentSecretValueSpans(text).reduceRight(
    (redacted, span) =>
      `${redacted.slice(0, span.start)}${SECRET_REDACTION_MARKER}${redacted.slice(span.end)}`,
    text,
  );
}

// Audit and persistence both consume this registry so an accepted Skill snapshot
// cannot later fail solely because persistence recognizes a broader secret class.
const SECRET_TEXT_RULES: readonly SecretTextRule[] = [
  regexSecretRule({
    label: "private key",
    redactionPattern:
      /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z0-9 ]*PRIVATE KEY-----/gu,
    auditPattern: /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----/u,
  }),
  {
    label: "environment secret assignment",
    matches: (text) => environmentSecretValueSpans(text).length > 0,
    redact: redactEnvironmentSecrets,
  },
  regexSecretRule({
    label: "bearer token",
    redactionPattern: BEARER_SECRET_PATTERN,
    bearer: true,
  }),
  regexSecretRule({
    label: "OpenAI-style API key",
    redactionPattern: /\bsk-[A-Za-z0-9][A-Za-z0-9_-]{3,}\b/gu,
  }),
  regexSecretRule({
    label: "GitHub token",
    redactionPattern:
      /\b(?:gh[opusr]_[A-Za-z0-9_]{20,}|github_pat_[A-Za-z0-9_]{40,})\b/gu,
  }),
  regexSecretRule({
    label: "Google API key",
    redactionPattern: /\bAIza[0-9A-Za-z_-]{35}\b/gu,
  }),
  regexSecretRule({
    label: "AWS access key",
    redactionPattern: /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/gu,
  }),
  regexSecretRule({
    label: "GitLab personal access token",
    redactionPattern: /\bglpat-[0-9A-Za-z_-]{20,}\b/gu,
  }),
  regexSecretRule({
    label: "Slack token",
    redactionPattern: /\bxox[baprs]-[0-9A-Za-z-]{20,}\b/gu,
  }),
];

export function secretLikeTextLabel(text: string): string | undefined {
  return SECRET_TEXT_RULES.find((rule) => rule.matches(text))?.label;
}

export function redactSecretLikeText(text: string): string {
  return SECRET_TEXT_RULES.reduce(
    (redacted, rule) => rule.redact(redacted),
    text,
  );
}
