export const SECRET_REDACTION_MARKER = "[REDACTED_SECRET]";

type SecretRedactionKind = "bearer" | "environment" | "whole";

interface SecretTextRule {
  readonly label: string;
  readonly redactionPattern: RegExp;
  readonly stricterAuditPattern?: RegExp;
  readonly redactionKind: SecretRedactionKind;
}

// Assignment and Bearer rules intentionally require a credential-shaped value:
// prose nouns, short examples, and common placeholders must remain documentable.
// Audit and persistence both consume this registry so an accepted Skill snapshot
// cannot later fail solely because persistence recognizes a broader secret class.
const ENVIRONMENT_SECRET_ASSIGNMENT_PATTERN =
  /(^|[\s("'`])([A-Z0-9_]*(?:SECRET|TOKEN|API[_-]?KEY|ACCESS[_-]?KEY|PRIVATE[_-]?KEY|PASSWORD)[A-Z0-9_]*\s*=\s*)(["']?)(?!(?:\$\{|\{\{|<|\[|(?:example|sample|placeholder|redacted|changeme|your(?:[_-][A-Z0-9]+)*)\b))([^\s"'`#]{12,})\3/giu;
const BEARER_SECRET_PATTERN =
  /\bBearer[ \t]+(?!(?:token|tokens|authentication|authorization|credential|credentials|value|example|placeholder|redacted|your[_-](?:access[_-])?token)\b)[-._~+/=A-Za-z0-9]{12,}/giu;

const SECRET_TEXT_RULES: readonly SecretTextRule[] = [
  {
    label: "private key",
    redactionPattern:
      /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z0-9 ]*PRIVATE KEY-----/gu,
    stricterAuditPattern: /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----/u,
    redactionKind: "whole",
  },
  {
    label: "environment secret assignment",
    redactionPattern: ENVIRONMENT_SECRET_ASSIGNMENT_PATTERN,
    redactionKind: "environment",
  },
  {
    label: "bearer token",
    redactionPattern: BEARER_SECRET_PATTERN,
    redactionKind: "bearer",
  },
  {
    label: "OpenAI-style API key",
    redactionPattern: /\bsk-[A-Za-z0-9][A-Za-z0-9_-]{3,}\b/gu,
    redactionKind: "whole",
  },
  {
    label: "GitHub token",
    redactionPattern:
      /\b(?:gh[opusr]_[A-Za-z0-9_]{20,}|github_pat_[A-Za-z0-9_]{40,})\b/gu,
    redactionKind: "whole",
  },
  {
    label: "Google API key",
    redactionPattern: /\bAIza[0-9A-Za-z_-]{35}\b/gu,
    redactionKind: "whole",
  },
  {
    label: "AWS access key",
    redactionPattern: /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/gu,
    redactionKind: "whole",
  },
  {
    label: "GitLab personal access token",
    redactionPattern: /\bglpat-[0-9A-Za-z_-]{20,}\b/gu,
    redactionKind: "whole",
  },
  {
    label: "Slack token",
    redactionPattern: /\bxox[baprs]-[0-9A-Za-z-]{20,}\b/gu,
    redactionKind: "whole",
  },
];

function patternMatches(pattern: RegExp, text: string): boolean {
  pattern.lastIndex = 0;
  const matches = pattern.test(text);
  pattern.lastIndex = 0;
  return matches;
}

export function secretLikeTextLabel(text: string): string | undefined {
  return SECRET_TEXT_RULES.find((rule) =>
    patternMatches(rule.stricterAuditPattern ?? rule.redactionPattern, text),
  )?.label;
}

function redactWithRule(text: string, rule: SecretTextRule): string {
  if (rule.redactionKind === "environment") {
    return text.replace(
      rule.redactionPattern,
      (_match, boundary: string, keyPrefix: string, quote: string) =>
        `${boundary}${keyPrefix}${quote}${SECRET_REDACTION_MARKER}${quote}`,
    );
  }
  if (rule.redactionKind === "bearer") {
    return text.replace(
      rule.redactionPattern,
      `Bearer ${SECRET_REDACTION_MARKER}`,
    );
  }
  return text.replace(rule.redactionPattern, SECRET_REDACTION_MARKER);
}

export function redactSecretLikeText(text: string): string {
  return SECRET_TEXT_RULES.reduce(redactWithRule, text);
}
