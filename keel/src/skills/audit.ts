import {
  closeSync,
  lstatSync,
  openSync,
  readFileSync,
  readSync,
} from "node:fs";
import { join } from "node:path";
import {
  redactSecretLikeText,
  secretLikeTextLabel,
} from "../core/secret-text.ts";
import {
  BINARY_SAMPLE_BYTES,
  hasBinaryControlBytes,
  isBinaryContentSample,
} from "../tools/text-file.ts";
import {
  hasForbiddenSkillTextCharacter,
  MAX_WORKFLOW_SKILL_BINARY_ASSET_BYTES,
  MAX_WORKFLOW_SKILL_TEXT_RESOURCE_BYTES,
} from "./resources.ts";

type SkillAuditSeverity = "blocker" | "warning";

type SkillAuditCode =
  | "allowed_tools_declared"
  | "binary_text_resource"
  | "destructive_instruction"
  | "download_and_execute"
  | "embedded_secret"
  | "executable_script"
  | "hard_coded_absolute_path"
  | "invalid_package"
  | "invalid_resource_path"
  | "invisible_content"
  | "metadata_prompt_injection"
  | "missing_compatibility"
  | "resource_scan_incomplete"
  | "resource_symlink"
  | "resource_too_large"
  | "resource_unreadable"
  | "safety_bypass_instruction";

export interface SkillAuditFinding {
  readonly severity: SkillAuditSeverity;
  readonly code: SkillAuditCode;
  readonly relativePath: string;
  readonly message: string;
}

export interface SkillPackageAudit {
  readonly qualifiedName: string;
  readonly relativePath: string;
  readonly findings: readonly SkillAuditFinding[];
}

interface AuditSkillPackageOptions {
  readonly skillDirectory: string;
  readonly skillRelativePath: string;
  readonly content: string;
  readonly description: string;
  readonly descriptionSource: string;
  readonly allowedTools?: string;
  readonly compatibility?: string;
  readonly resourcePaths: readonly string[];
  readonly inventoryFindings: readonly SkillAuditFinding[];
}

const DOWNLOAD_AND_EXECUTE_PATTERN =
  /\b(?:curl|wget)\b[^\n|]{0,240}\|\s*(?:ba|z|fi|da)?sh\b/iu;
const DESTRUCTIVE_INSTRUCTION_PATTERN =
  /\b(?:rm\s+-rf|git\s+reset\s+--hard|git\s+clean\s+-[a-z]*f|sudo\s+)\b/iu;
const SAFETY_BYPASS_PATTERN =
  /\b(?:bypass|disable|ignore|skip)\b.{0,80}\b(?:approval|permission|policy|safety|guardrail)\b/isu;
const HARD_CODED_ABSOLUTE_PATH_PATTERN =
  /(?:^|[\s'"`])(?:\/(?:Users|home)\/[^\s'"`]+|[a-zA-Z]:\\Users\\[^\s'"`]+)/mu;
const METADATA_AUTHORITY_OVERRIDE_PATTERN =
  /(?:^|[.!?;:]\s*)[ \t]*(?:(?:you|the\s+(?:assistant|agent|model))\s+(?:must|shall|have\s+to|are\s+required\s+to)\s+)?(?:ignore|disregard|override|forget)\s+(?:the\s+)?(?:current\s+)?(?:user(?:'s)?\s+(?:request|instructions?)|system\s+(?:message|instructions?)|developer\s+(?:message|instructions?)|(?:(?:all|any)\s+)?(?:previous|prior|above)\s+(?:request|message|instructions?))(?=$|[.!?;,:]|\s+(?:and|then|before)\b)/imu;
const METADATA_DIRECT_MODEL_CONTROL_PATTERN =
  /(?:^|[.!?;:]\s*)[ \t]*(?:you|the\s+(?:assistant|agent|model))\s+(?:must|shall|have\s+to|are\s+required\s+to)\s+(?:activate|invoke|call|obey|follow|answer|reply|respond|output|print|say)\b/imu;
const METADATA_DIRECT_SKILL_ACTIVATION_PATTERN =
  /(?:^|[.!?;:]\s*)[ \t]*(?:(?:always|first|immediately|kindly|now|please)\s+)?(?:activate|invoke|call)\s+(?:(?:(?:the|this|current|matching|available)\s+){0,2}(?:workflow\s+)?skill\b|(?:repo|user|system|extra):[a-z0-9][a-z0-9-]{0,63}\b)/imu;
const METADATA_CONTROL_ACTION_PATTERN =
  /\b(?:activate|invoke|call|obey|follow|answer|reply|respond|output|print|say)\b/iu;
const METADATA_AUTHORITY_OVERRIDE_ZH_PATTERN =
  /(?:^|[。！？；：;:]\s*)[ \t]*(?:(?:你|助手|模型|代理|AI).{0,6}(?:必须|务必|只能|需要).{0,8})?(?:忽略|无视|覆盖|不要遵循)(?:(?!字段|参数|属性|键|值|数据).){0,24}(?:(?:用户|系统|开发者)(?:的)?(?:请求|指令|要求|消息)(?!字段|参数|属性|键|值|数据)|(?:之前|以上|上述)(?!(?:的)?(?:(?:请求|指令|要求|消息))?(?:字段|参数|属性|键|值|数据))(?:的)?(?:请求|指令|要求|消息)?)/imu;
const METADATA_DIRECT_MODEL_CONTROL_ZH_PATTERN =
  /(?:^|[。！？；：;:]\s*)[ \t]*(?:(?:你|助手|模型|代理|AI).{0,6}(?:必须|务必|只能|需要).{0,8}|(?:请(?:务必)?|始终|总是|立即|先)\s*)(?:激活|调用|遵循|服从|回答|回复|输出|打印)/imu;
const METADATA_DIRECT_SKILL_ACTIVATION_ZH_PATTERN =
  /(?:^|[。！？；：;:]\s*)[ \t]*(?:(?:请(?:务必)?|始终|总是|立即|先)\s*)?(?:激活|调用)(?:(?:这个|本|当前|匹配的)?(?:工作流)?技能|(?:repo|user|system|extra):[a-z0-9][a-z0-9-]{0,63}\b)/imu;
const METADATA_CONTROL_ACTION_ZH_PATTERN =
  /(?:激活|调用|遵循|服从|回答|回复|输出|打印)/u;

function findingKey(finding: SkillAuditFinding): string {
  return `${finding.severity}:${finding.code}:${finding.relativePath}`;
}

function uniqueFindings(
  findings: readonly SkillAuditFinding[],
): readonly SkillAuditFinding[] {
  const seen = new Set<string>();
  return findings
    .filter((finding) => {
      const key = findingKey(finding);
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .map((finding) => ({
      ...finding,
      relativePath: redactSecretLikeText(finding.relativePath),
      message: redactSecretLikeText(finding.message),
    }));
}

function auditText(
  relativePath: string,
  text: string,
): readonly SkillAuditFinding[] {
  const findings: SkillAuditFinding[] = [];
  const secretLabel = secretLikeTextLabel(text);
  if (secretLabel !== undefined) {
    findings.push({
      severity: "blocker",
      code: "embedded_secret",
      relativePath,
      message: `contains a high-confidence ${secretLabel}; remove the credential before activation`,
    });
  }
  if (hasForbiddenSkillTextCharacter(text, { allowTextWhitespace: true })) {
    findings.push({
      severity: "blocker",
      code: "invisible_content",
      relativePath,
      message:
        "contains control, bidi, or zero-width characters that can conceal or alter instructions",
    });
  }
  if (DOWNLOAD_AND_EXECUTE_PATTERN.test(text)) {
    findings.push({
      severity: "warning",
      code: "download_and_execute",
      relativePath,
      message: "contains a download-and-execute pipeline that requires review",
    });
  }
  if (DESTRUCTIVE_INSTRUCTION_PATTERN.test(text)) {
    findings.push({
      severity: "warning",
      code: "destructive_instruction",
      relativePath,
      message: "contains a destructive shell instruction that requires review",
    });
  }
  if (SAFETY_BYPASS_PATTERN.test(text)) {
    findings.push({
      severity: "warning",
      code: "safety_bypass_instruction",
      relativePath,
      message: "contains guidance to bypass a permission or safety boundary",
    });
  }
  if (HARD_CODED_ABSOLUTE_PATH_PATTERN.test(text)) {
    findings.push({
      severity: "warning",
      code: "hard_coded_absolute_path",
      relativePath,
      message:
        "contains a user-specific absolute path that may not be portable",
    });
  }
  return findings;
}

function auditSkillDescription(
  relativePath: string,
  description: string,
): readonly SkillAuditFinding[] {
  const overridesAuthority =
    METADATA_AUTHORITY_OVERRIDE_PATTERN.test(description) &&
    METADATA_CONTROL_ACTION_PATTERN.test(description);
  const overridesAuthorityZh =
    METADATA_AUTHORITY_OVERRIDE_ZH_PATTERN.test(description) &&
    METADATA_CONTROL_ACTION_ZH_PATTERN.test(description);
  const directlyControlsModel =
    METADATA_DIRECT_MODEL_CONTROL_PATTERN.test(description);
  const directlyControlsModelZh =
    METADATA_DIRECT_MODEL_CONTROL_ZH_PATTERN.test(description);
  const directlyActivatesSkill =
    METADATA_DIRECT_SKILL_ACTIVATION_PATTERN.test(description);
  const directlyActivatesSkillZh =
    METADATA_DIRECT_SKILL_ACTIVATION_ZH_PATTERN.test(description);
  if (
    !overridesAuthority &&
    !overridesAuthorityZh &&
    !directlyControlsModel &&
    !directlyControlsModelZh &&
    !directlyActivatesSkill &&
    !directlyActivatesSkillZh
  ) {
    return [];
  }
  return [
    {
      severity: "blocker",
      code: "metadata_prompt_injection",
      relativePath,
      message:
        "description contains instructions that try to override user control or force model behavior; keep metadata limited to capability and trigger information",
    },
  ];
}

function readResourceSample(path: string, reportedSize: number): Uint8Array {
  const bytes = Buffer.allocUnsafe(Math.min(reportedSize, BINARY_SAMPLE_BYTES));
  const fd = openSync(path, "r");
  try {
    const bytesRead = readSync(fd, bytes, 0, bytes.length, 0);
    return bytes.subarray(0, bytesRead);
  } finally {
    closeSync(fd);
  }
}

function auditResource(options: {
  readonly skillDirectory: string;
  readonly relativePath: string;
}): readonly SkillAuditFinding[] {
  const absolutePath = join(options.skillDirectory, options.relativePath);
  try {
    const stat = lstatSync(absolutePath);
    const findings: SkillAuditFinding[] = [];
    /* v8 ignore next 10 -- the bounded inventory admits only regular files; this fail-closed branch protects a concurrent replacement. */
    if (!stat.isFile()) {
      return [
        {
          severity: "blocker",
          code: "resource_unreadable",
          relativePath: options.relativePath,
          message: "is no longer a regular file and cannot be audited safely",
        },
      ];
    }
    if (
      options.relativePath.startsWith("scripts/") &&
      (stat.mode & 0o111) !== 0
    ) {
      findings.push({
        severity: "warning",
        code: "executable_script",
        relativePath: options.relativePath,
        message:
          "is executable; discovery does not run it, and execution still requires ordinary Keel tool permission",
      });
    }
    const sample = readResourceSample(absolutePath, stat.size);
    // Classification must precede size enforcement: binary assets are opaque,
    // sampled resources, while provider-visible text must be audited completely.
    const binary = isBinaryContentSample(sample, sample.length === stat.size);
    if (binary) {
      if (!options.relativePath.startsWith("assets/")) {
        findings.push({
          severity: "blocker",
          code: "binary_text_resource",
          relativePath: options.relativePath,
          message:
            "is binary but scripts and references must be auditable text",
        });
      } else if (stat.size > MAX_WORKFLOW_SKILL_BINARY_ASSET_BYTES) {
        findings.push({
          severity: "blocker",
          code: "resource_too_large",
          relativePath: options.relativePath,
          message: `exceeds the ${MAX_WORKFLOW_SKILL_BINARY_ASSET_BYTES}-byte binary asset limit`,
        });
      }
      return findings;
    }
    if (stat.size > MAX_WORKFLOW_SKILL_TEXT_RESOURCE_BYTES) {
      findings.push({
        severity: "blocker",
        code: "resource_too_large",
        relativePath: options.relativePath,
        message: `exceeds the ${MAX_WORKFLOW_SKILL_TEXT_RESOURCE_BYTES}-byte text audit limit`,
      });
      return findings;
    }
    const bytes = readFileSync(absolutePath);
    if (hasBinaryControlBytes(bytes)) {
      if (!options.relativePath.startsWith("assets/")) {
        findings.push({
          severity: "blocker",
          code: "binary_text_resource",
          relativePath: options.relativePath,
          message:
            "is binary but scripts and references must be auditable text",
        });
      }
      return findings;
    }
    try {
      const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
      findings.push(...auditText(options.relativePath, text));
    } catch {
      if (!options.relativePath.startsWith("assets/")) {
        findings.push({
          severity: "blocker",
          code: "binary_text_resource",
          relativePath: options.relativePath,
          message:
            "is not valid UTF-8 but scripts and references must be auditable text",
        });
      }
    }
    return findings;
  } catch {
    return [
      {
        severity: "blocker",
        code: "resource_unreadable",
        relativePath: options.relativePath,
        message: "could not be read completely during deterministic audit",
      },
    ];
  }
}

export function auditSkillPackage(
  options: AuditSkillPackageOptions,
): readonly SkillAuditFinding[] {
  const findings: SkillAuditFinding[] = [
    ...options.inventoryFindings,
    ...auditText(options.skillRelativePath, options.content),
    ...auditText(options.skillRelativePath, options.description),
    ...auditSkillDescription(
      options.skillRelativePath,
      options.descriptionSource,
    ),
    ...auditSkillDescription(options.skillRelativePath, options.description),
  ];
  for (const resourcePath of options.resourcePaths) {
    const secretLabel = secretLikeTextLabel(resourcePath);
    if (secretLabel !== undefined) {
      findings.push({
        severity: "blocker",
        code: "embedded_secret",
        relativePath: resourcePath,
        message: `contains a high-confidence ${secretLabel}; remove the credential before activation`,
      });
    }
  }
  if (options.allowedTools !== undefined) {
    findings.push({
      severity: "warning",
      code: "allowed_tools_declared",
      relativePath: options.skillRelativePath,
      message:
        "declares allowed-tools as a compatibility requirement; it does not grant or preapprove Keel tools",
    });
  }
  if (
    options.compatibility === undefined &&
    options.resourcePaths.some((path) => path.startsWith("scripts/"))
  ) {
    findings.push({
      severity: "warning",
      code: "missing_compatibility",
      relativePath: options.skillRelativePath,
      message:
        "contains scripts without compatibility metadata describing their runtime requirements",
    });
  }
  for (const relativePath of options.resourcePaths) {
    findings.push(
      ...auditResource({
        skillDirectory: options.skillDirectory,
        relativePath,
      }),
    );
  }
  return uniqueFindings(findings);
}

export function firstSkillAuditBlocker(
  findings: readonly SkillAuditFinding[],
): SkillAuditFinding | undefined {
  return findings.find((finding) => finding.severity === "blocker");
}
