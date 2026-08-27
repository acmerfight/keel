import {
  type Component,
  type Focusable,
  Key,
  matchesKey,
  type Terminal,
  truncateToWidth,
  visibleWidth,
  wrapTextWithAnsi,
} from "@earendil-works/pi-tui";
import {
  type GitDiffDocument,
  type GitDiffFile,
  type GitDiffFileStatus,
  type GitDiffLine,
  gitDiffScopeLabel,
} from "../../tools/git-diff-document.ts";
import type { InteractiveDiffInspection } from "../interactive-session/diff-inspection.ts";
import { escapeTerminalText } from "../terminal-text.ts";
import {
  type DiffReviewAction,
  type DiffReviewFileRange,
  type DiffReviewFileState,
  type DiffReviewFileTarget,
  type DiffReviewRange,
  type DiffReviewScrollState,
  type DiffReviewViewport,
  diffReviewFileRange,
  diffReviewRange,
  INITIAL_DIFF_REVIEW_FILE_STATE,
  INITIAL_DIFF_REVIEW_SCROLL_STATE,
  updateDiffReviewFileState,
  updateDiffReviewState,
} from "./diff-review-state.ts";
import type { InteractiveTerminalTheme } from "./interactive-transcript.ts";

type DiffReviewInput =
  | { readonly kind: "close" }
  | { readonly kind: "navigate"; readonly action: DiffReviewAction }
  | { readonly kind: "ignored" };

type DiffReviewRowsCache =
  | { readonly kind: "empty" }
  | {
      readonly kind: "ready";
      readonly width: number;
      readonly body: DiffReviewBody;
    };

interface DiffReviewFileContext {
  readonly scope: string;
  readonly path: string;
  readonly fileNumber: number;
  readonly fileCount: number;
}

type DiffReviewBody =
  | { readonly kind: "plain"; readonly rows: readonly string[] }
  | {
      readonly kind: "files";
      readonly rows: readonly string[];
      readonly files: readonly [
        DiffReviewFileTarget<DiffReviewFileContext>,
        ...DiffReviewFileTarget<DiffReviewFileContext>[],
      ];
    };

function fileStatusLabel(status: GitDiffFileStatus): string {
  switch (status) {
    case "modified":
      return "M";
    case "added":
      return "A";
    case "deleted":
      return "D";
    case "renamed":
      return "R";
    case "copied":
      return "C";
    case "binary":
      return "BINARY";
    case "mode-only":
      return "MODE";
    case "conflicted":
      return "CONFLICT";
  }
}

function styledDiffLine(
  line: GitDiffLine,
  theme: InteractiveTerminalTheme,
): string {
  const text = escapeTerminalText(line.text);
  switch (line.kind) {
    case "addition":
      return theme.success(text);
    case "deletion":
      return theme.error(text);
    case "hunk":
      return theme.accent(text);
    case "metadata":
      return theme.muted(text);
    case "notice":
      return theme.warning(text);
    case "conflict":
      return theme.warning(text);
    case "context":
      return text;
  }
}

function wrappedLine(text: string, width: number): readonly string[] {
  return wrapTextWithAnsi(text, Math.max(1, width - 2)).map(
    (line) => ` ${line}`,
  );
}

function changedBody(
  document: GitDiffDocument,
  width: number,
  theme: InteractiveTerminalTheme,
): DiffReviewBody {
  const [firstFile, ...remainingFiles] = document.files;
  if (firstFile === undefined) {
    return {
      kind: "plain",
      rows: wrappedLine(theme.muted("No reviewable file changes."), width),
    };
  }
  const lines: string[] = [];
  let activeScope = "";
  const reviewedFileNumbers = new Map<string, number>();
  const appendFile = (
    file: GitDiffFile,
    fileIndex: number,
  ): DiffReviewFileTarget<DiffReviewFileContext> => {
    const scope = gitDiffScopeLabel(file.scope);
    const scopeChanged = scope !== activeScope;
    if (scopeChanged) {
      if (lines.length > 0) {
        lines.push("");
      }
      activeScope = scope;
    }
    const row = lines.length;
    if (scopeChanged) {
      lines.push(...wrappedLine(theme.accentStrong(scope), width));
    }
    const knownFileNumber = reviewedFileNumbers.get(file.path);
    const fileNumber = knownFileNumber ?? reviewedFileNumbers.size + 1;
    if (knownFileNumber === undefined) {
      reviewedFileNumbers.set(file.path, fileNumber);
    }
    const fileSummary = `${fileStatusLabel(file.status)} ${escapeTerminalText(
      file.path,
    )}  +${file.additions} -${file.deletions}`;
    lines.push(...wrappedLine(theme.strong(fileSummary), width));
    for (const line of file.lines) {
      lines.push(...wrappedLine(styledDiffLine(line, theme), width));
    }
    return {
      index: fileIndex,
      row,
      value: {
        scope,
        path: file.path,
        fileNumber,
        fileCount: document.changedFileCount,
      },
    };
  };
  const firstTarget = appendFile(firstFile, 0);
  const files: [
    DiffReviewFileTarget<DiffReviewFileContext>,
    ...DiffReviewFileTarget<DiffReviewFileContext>[],
  ] = [firstTarget];
  for (const [index, file] of remainingFiles.entries()) {
    files.push(appendFile(file, index + 1));
  }
  for (const line of document.preludeLines) {
    lines.push(...wrappedLine(theme.warning(escapeTerminalText(line)), width));
  }
  if (document.completeness.kind === "truncated") {
    lines.push(
      ...wrappedLine(
        theme.warning(
          "Diff output is truncated. Narrow the workspace changes before relying on this review.",
        ),
        width,
      ),
    );
  }
  return { kind: "files", rows: lines, files };
}

function inspectionBody(
  inspection: InteractiveDiffInspection,
  width: number,
  theme: InteractiveTerminalTheme,
): DiffReviewBody {
  switch (inspection.kind) {
    case "changes":
      return changedBody(inspection.document, width, theme);
    case "clean":
      return {
        kind: "plain",
        rows: inspection.statusOutput
          .split("\n")
          .flatMap((line) =>
            wrappedLine(theme.muted(escapeTerminalText(line)), width),
          ),
      };
    case "non-git":
      return {
        kind: "plain",
        rows: wrappedLine(
          theme.warning(escapeTerminalText(inspection.message)),
          width,
        ),
      };
    case "failed":
      return {
        kind: "plain",
        rows: wrappedLine(
          theme.error(escapeTerminalText(inspection.message)),
          width,
        ),
      };
  }
}

function inspectionCompleteness(inspection: InteractiveDiffInspection): string {
  return inspection.kind === "changes" &&
    inspection.document.completeness.kind === "truncated"
    ? " · incomplete output"
    : "";
}

function inspectionSummary(
  inspection: InteractiveDiffInspection,
  theme: InteractiveTerminalTheme,
): string {
  switch (inspection.kind) {
    case "changes": {
      const fileLabel =
        inspection.document.changedFileCount === 1 ? "file" : "files";
      const conflictSummary =
        inspection.document.conflictedFileCount === 0
          ? ""
          : ` · ${inspection.document.conflictedFileCount} conflict${inspection.document.conflictedFileCount === 1 ? "" : "s"}`;
      return `${inspection.document.changedFileCount} ${fileLabel}${conflictSummary}  ${theme.success(`+${inspection.document.additions}`)} ${theme.error(`-${inspection.document.deletions}`)}`;
    }
    case "clean":
      return theme.success("Working tree is clean");
    case "non-git":
      return theme.warning("Not a Git repository");
    case "failed":
      return theme.error("Could not load changes");
  }
}

function inspectionSubtitle(inspection: InteractiveDiffInspection): string {
  switch (inspection.kind) {
    case "changes":
      return inspection.document.completeness.kind === "truncated"
        ? "Current workspace · incomplete output"
        : "Current workspace · staged, unstaged, and untracked";
    case "clean":
      return "Current workspace · no changes";
    case "non-git":
      return "Change review is unavailable";
    case "failed":
      return "Git inspection failed";
  }
}

function paddedLine(text: string, width: number): string {
  return truncateToWidth(text, width, "…", true);
}

function truncateStartToWidth(text: string, width: number): string {
  if (visibleWidth(text) <= width) {
    return text;
  }
  let suffix = "";
  for (const character of Array.from(text).reverse()) {
    if (visibleWidth(`…${character}${suffix}`) > width) {
      break;
    }
    suffix = `${character}${suffix}`;
  }
  return `…${suffix}`;
}

function headerLine(
  summary: string,
  width: number,
  theme: InteractiveTerminalTheme,
): string {
  const title = ` ${theme.strong("Workspace changes")}`;
  const right = `${summary} `;
  const gap = width - visibleWidth(title) - visibleWidth(right);
  return paddedLine(
    gap >= 2 ? `${title}${" ".repeat(gap)}${right}` : `${title} · ${summary}`,
    width,
  );
}

function plainContextLine(
  inspection: InteractiveDiffInspection,
  width: number,
  theme: InteractiveTerminalTheme,
): string {
  return paddedLine(` ${theme.muted(inspectionSubtitle(inspection))}`, width);
}

function fileContextLines(
  inspection: InteractiveDiffInspection,
  range: DiffReviewFileRange<DiffReviewFileContext>,
  width: number,
  theme: InteractiveTerminalTheme,
): readonly string[] {
  const context = range.currentFile.value;
  const path = escapeTerminalText(context.path);
  const right = `${theme.muted(
    `file ${context.fileNumber}/${context.fileCount}${inspectionCompleteness(
      inspection,
    )}`,
  )} `;
  if (width < 24) {
    return [
      paddedLine(` ${theme.accentStrong(context.scope)}`, width),
      paddedLine(
        ` ${theme.strong(truncateStartToWidth(path, Math.max(1, width - 1)))}`,
        width,
      ),
      paddedLine(
        `${" ".repeat(Math.max(0, width - visibleWidth(right)))}${right}`,
        width,
      ),
    ];
  }
  if (width < 76) {
    const fullPrefix = ` ${theme.accentStrong(context.scope)} · `;
    const pathWidth = Math.max(1, width - visibleWidth(fullPrefix));
    const pathLine = `${fullPrefix}${theme.strong(
      truncateStartToWidth(path, pathWidth),
    )}`;
    return [
      paddedLine(pathLine, width),
      paddedLine(
        `${" ".repeat(Math.max(0, width - visibleWidth(right)))}${right}`,
        width,
      ),
    ];
  }
  const prefix = ` ${theme.accentStrong(context.scope)} · `;
  const availablePathWidth = Math.max(
    1,
    width - visibleWidth(prefix) - visibleWidth(right),
  );
  const left = `${prefix}${theme.strong(
    truncateStartToWidth(path, availablePathWidth),
  )}`;
  const gap = width - visibleWidth(left) - visibleWidth(right);
  return [paddedLine(`${left}${" ".repeat(Math.max(0, gap))}${right}`, width)];
}

function footerLines(
  range: DiffReviewRange,
  totalRows: number,
  width: number,
  theme: InteractiveTerminalTheme,
): readonly string[] {
  const position = `${range.lineFrom}-${range.lineTo}/${totalRows}`;
  const rightAligned = (leftText: string): string => {
    const left = ` ${theme.strong(leftText)}`;
    const right = `${theme.muted(position)} `;
    const gap = width - visibleWidth(left) - visibleWidth(right);
    return paddedLine(
      gap >= 1 ? `${left}${" ".repeat(gap)}${right}` : `${left} · ${right}`,
      width,
    );
  };
  if (width >= 76) {
    return [
      rightAligned(
        "↑↓ line · PgUp/PgDn page · [ ] section · Home/End · Esc/q close",
      ),
    ];
  }
  if (width >= 36) {
    return [
      paddedLine(` ${theme.strong("↑↓ line · PgUp/PgDn · Home/End")}`, width),
      rightAligned("[ ] section · Esc/q close"),
    ];
  }
  return [
    paddedLine(` ${theme.strong("↑↓ line · PgUp/PgDn")}`, width),
    paddedLine(` ${theme.strong("[ ] section · Home/End")}`, width),
    rightAligned("Esc/q close"),
  ];
}

function footerHeight(width: number): number {
  return width >= 76 ? 1 : width >= 36 ? 2 : 3;
}

function contextHeight(body: DiffReviewBody, width: number): number {
  if (body.kind === "plain" || width >= 76) {
    return 1;
  }
  return width < 24 ? 3 : 2;
}

function diffReviewViewport(
  body: DiffReviewBody,
  terminalHeight: number,
  width: number,
): DiffReviewViewport {
  return {
    totalRows: body.rows.length,
    visibleRows: Math.max(
      1,
      terminalHeight - 3 - contextHeight(body, width) - footerHeight(width),
    ),
  };
}

function diffReviewInput(data: string): DiffReviewInput {
  if (
    matchesKey(data, Key.escape) ||
    matchesKey(data, "q") ||
    matchesKey(data, "shift+q")
  ) {
    return { kind: "close" };
  }
  if (matchesKey(data, Key.up)) {
    return { kind: "navigate", action: { kind: "line-up" } };
  }
  if (matchesKey(data, Key.down)) {
    return { kind: "navigate", action: { kind: "line-down" } };
  }
  if (matchesKey(data, Key.pageUp)) {
    return { kind: "navigate", action: { kind: "page-up" } };
  }
  if (matchesKey(data, Key.pageDown)) {
    return { kind: "navigate", action: { kind: "page-down" } };
  }
  if (matchesKey(data, "[")) {
    return { kind: "navigate", action: { kind: "previous-file" } };
  }
  if (matchesKey(data, "]")) {
    return { kind: "navigate", action: { kind: "next-file" } };
  }
  if (matchesKey(data, Key.home)) {
    return { kind: "navigate", action: { kind: "home" } };
  }
  if (matchesKey(data, Key.end)) {
    return { kind: "navigate", action: { kind: "end" } };
  }
  return { kind: "ignored" };
}

function renderDiffReview(
  inspection: InteractiveDiffInspection,
  scrollState: DiffReviewScrollState,
  fileState: DiffReviewFileState,
  body: DiffReviewBody,
  terminalHeight: number,
  width: number,
  theme: InteractiveTerminalTheme,
): string[] {
  const height = Math.max(1, terminalHeight);
  const viewport = diffReviewViewport(body, height, width);
  let range: DiffReviewRange;
  let context: readonly string[];
  if (body.kind === "files") {
    const fileRange = diffReviewFileRange(fileState, {
      ...viewport,
      files: body.files,
    });
    range = fileRange;
    context = fileContextLines(inspection, fileRange, width, theme);
  } else {
    range = diffReviewRange(scrollState, viewport);
    context = [plainContextLine(inspection, width, theme)];
  }
  const divider = theme.muted("─".repeat(Math.max(1, width)));
  const footer = footerLines(range, body.rows.length, width, theme);
  const lines = [
    headerLine(inspectionSummary(inspection, theme), width, theme),
    ...context,
    paddedLine(divider, width),
    ...body.rows
      .slice(range.scrollTop, range.scrollTop + viewport.visibleRows)
      .map((line) => paddedLine(line, width)),
  ];
  while (lines.length < height - 1 - footer.length) {
    lines.push(" ".repeat(width));
  }
  lines.push(paddedLine(divider, width));
  lines.push(...footer);
  return lines.slice(0, height);
}

export class InteractiveDiffReview implements Component, Focusable {
  focused = false;
  private readonly inspection: InteractiveDiffInspection;
  private readonly onClose: () => void;
  private readonly terminal: Terminal;
  private readonly theme: InteractiveTerminalTheme;
  private scrollState = INITIAL_DIFF_REVIEW_SCROLL_STATE;
  private fileState = INITIAL_DIFF_REVIEW_FILE_STATE;
  private rowsCache: DiffReviewRowsCache = { kind: "empty" };

  constructor(
    inspection: InteractiveDiffInspection,
    terminal: Terminal,
    theme: InteractiveTerminalTheme,
    onClose: () => void,
  ) {
    this.inspection = inspection;
    this.terminal = terminal;
    this.theme = theme;
    this.onClose = onClose;
  }

  invalidate(): void {}

  private body(width: number): DiffReviewBody {
    if (this.rowsCache.kind === "ready" && this.rowsCache.width === width) {
      return this.rowsCache.body;
    }
    const body = inspectionBody(this.inspection, width, this.theme);
    this.rowsCache = { kind: "ready", width, body };
    return body;
  }

  handleInput(data: string): void {
    const input = diffReviewInput(data);
    switch (input.kind) {
      case "close":
        this.onClose();
        break;
      case "navigate": {
        const body = this.body(this.terminal.columns);
        const viewport = diffReviewViewport(
          body,
          this.terminal.rows,
          this.terminal.columns,
        );
        if (body.kind === "files") {
          this.fileState = updateDiffReviewFileState(
            this.fileState,
            input.action,
            { ...viewport, files: body.files },
          );
        } else {
          this.scrollState = updateDiffReviewState(
            this.scrollState,
            input.action,
            viewport,
          );
        }
        break;
      }
      case "ignored":
        break;
    }
  }

  render(width: number): string[] {
    return renderDiffReview(
      this.inspection,
      this.scrollState,
      this.fileState,
      this.body(width),
      this.terminal.rows,
      width,
      this.theme,
    );
  }
}
