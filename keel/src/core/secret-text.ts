export const PERSISTENCE_REDACTION_MARKER = "[REDACTED_SECRET]";

type SecretRedactionKind = "bearer" | "environment" | "whole";

interface SecretTextRule {
  readonly label: string;
  readonly redactionPattern: RegExp;
  readonly stricterAuditPattern?: RegExp;
  readonly redactionKind: SecretRedactionKind;
}

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
    redactionPattern:
      /(^|[\r\n])([A-Z0-9_]*(?:SECRET|TOKEN|API[_-]?KEY|ACCESS[_-]?KEY|PRIVATE[_-]?KEY|PASSWORD)[A-Z0-9_]*\s*=\s*)([^\r\n#]+)/giu,
    redactionKind: "environment",
  },
  {
    label: "bearer token",
    redactionPattern: /\bBearer[ \t]+[-._~+/=A-Za-z0-9]+/gu,
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
      (_match, lineStart: string, keyPrefix: string) =>
        `${lineStart}${keyPrefix}${PERSISTENCE_REDACTION_MARKER}`,
    );
  }
  if (rule.redactionKind === "bearer") {
    return text.replace(
      rule.redactionPattern,
      `Bearer ${PERSISTENCE_REDACTION_MARKER}`,
    );
  }
  return text.replace(rule.redactionPattern, PERSISTENCE_REDACTION_MARKER);
}

export function redactSecretLikeTextForPersistence(text: string): string {
  return SECRET_TEXT_RULES.reduce(redactWithRule, text);
}
