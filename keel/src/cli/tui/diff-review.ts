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
  type GitDiffFileStatus,
  type GitDiffLine,
  gitDiffScopeLabel,
} from "../../tools/git-diff-document.ts";
import type { InteractiveDiffInspection } from "../interactive-session/diff-inspection.ts";
import { escapeTerminalText } from "../output.ts";
import {
  type DiffReviewAction,
  type DiffReviewRange,
  type DiffReviewState,
  type DiffReviewViewport,
  diffReviewRange,
  INITIAL_DIFF_REVIEW_STATE,
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
      readonly rows: readonly string[];
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

function changedBodyLines(
  document: GitDiffDocument,
  width: number,
  theme: InteractiveTerminalTheme,
): readonly string[] {
  const lines: string[] = [];
  let activeScope = "";
  for (const file of document.files) {
    const scope = gitDiffScopeLabel(file.scope);
    if (scope !== activeScope) {
      if (lines.length > 0) {
        lines.push("");
      }
      activeScope = scope;
      lines.push(...wrappedLine(theme.accentStrong(scope), width));
    }
    const fileSummary = `${fileStatusLabel(file.status)} ${escapeTerminalText(
      file.path,
    )}  +${file.additions} -${file.deletions}`;
    lines.push(...wrappedLine(theme.strong(fileSummary), width));
    for (const line of file.lines) {
      lines.push(...wrappedLine(styledDiffLine(line, theme), width));
    }
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
  return lines.length === 0
    ? wrappedLine(theme.muted("No reviewable file changes."), width)
    : lines;
}

function inspectionBodyLines(
  inspection: InteractiveDiffInspection,
  width: number,
  theme: InteractiveTerminalTheme,
): readonly string[] {
  switch (inspection.kind) {
    case "changes":
      return changedBodyLines(inspection.document, width, theme);
    case "clean":
      return inspection.statusOutput
        .split("\n")
        .flatMap((line) =>
          wrappedLine(theme.muted(escapeTerminalText(line)), width),
        );
    case "non-git":
      return wrappedLine(
        theme.warning(escapeTerminalText(inspection.message)),
        width,
      );
    case "failed":
      return wrappedLine(
        theme.error(escapeTerminalText(inspection.message)),
        width,
      );
  }
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
    return [rightAligned("↑↓ line · PgUp/PgDn page · Home/End · Esc/q close")];
  }
  return [
    paddedLine(` ${theme.strong("↑↓ line · PgUp/PgDn · Home/End")}`, width),
    rightAligned("Esc/q close"),
  ];
}

function footerHeight(width: number): number {
  return width >= 76 ? 1 : 2;
}

function bodyHeight(terminalHeight: number, width: number): number {
  return Math.max(1, terminalHeight - 4 - footerHeight(width));
}

function diffReviewViewport(
  totalRows: number,
  terminalHeight: number,
  width: number,
): DiffReviewViewport {
  return {
    totalRows,
    visibleRows: bodyHeight(terminalHeight, width),
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
  state: DiffReviewState,
  body: readonly string[],
  terminalHeight: number,
  width: number,
  theme: InteractiveTerminalTheme,
): string[] {
  const height = Math.max(1, terminalHeight);
  const viewport = diffReviewViewport(body.length, height, width);
  const range = diffReviewRange(state, viewport);
  const divider = theme.muted("─".repeat(Math.max(1, width)));
  const footer = footerLines(range, body.length, width, theme);
  const lines = [
    headerLine(inspectionSummary(inspection, theme), width, theme),
    paddedLine(` ${theme.muted(inspectionSubtitle(inspection))}`, width),
    paddedLine(divider, width),
    ...body
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
  private state = INITIAL_DIFF_REVIEW_STATE;
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

  private bodyRows(width: number): readonly string[] {
    if (this.rowsCache.kind === "ready" && this.rowsCache.width === width) {
      return this.rowsCache.rows;
    }
    const rows = inspectionBodyLines(this.inspection, width, this.theme);
    this.rowsCache = { kind: "ready", width, rows };
    return rows;
  }

  handleInput(data: string): void {
    const input = diffReviewInput(data);
    switch (input.kind) {
      case "close":
        this.onClose();
        break;
      case "navigate": {
        const totalRows = this.bodyRows(this.terminal.columns).length;
        this.state = updateDiffReviewState(
          this.state,
          input.action,
          diffReviewViewport(
            totalRows,
            this.terminal.rows,
            this.terminal.columns,
          ),
        );
        break;
      }
      case "ignored":
        break;
    }
  }

  render(width: number): string[] {
    return renderDiffReview(
      this.inspection,
      this.state,
      this.bodyRows(width),
      this.terminal.rows,
      width,
      this.theme,
    );
  }
}
