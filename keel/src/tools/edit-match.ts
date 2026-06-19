export interface EditMatchSpan {
  readonly index: number;
  readonly length: number;
}

export type EditMatchResult =
  | {
      readonly status: "matched";
      readonly match: EditMatchSpan;
    }
  | {
      readonly status: "not_found";
    }
  | {
      readonly status: "not_unique";
      readonly occurrenceCount: number;
    };

interface LineRecord {
  readonly text: string;
  readonly start: number;
  readonly contentEnd: number;
  readonly end: number;
}

interface SearchBlock {
  readonly lines: readonly string[];
  readonly endsWithNewline: boolean;
}

function exactMatches(
  content: string,
  search: string,
): readonly EditMatchSpan[] {
  const matches: EditMatchSpan[] = [];
  let start = 0;
  while (true) {
    const index = content.indexOf(search, start);
    if (index < 0) return matches;
    matches.push({ index, length: search.length });
    start = index + search.length;
  }
}

function parseSearchBlock(search: string): SearchBlock {
  const endsWithNewline = search.endsWith("\n");
  const withoutFinalNewline = endsWithNewline ? search.slice(0, -1) : search;
  return {
    lines: withoutFinalNewline.split("\n"),
    endsWithNewline,
  };
}

function splitLineRecords(content: string): readonly LineRecord[] {
  const lines: LineRecord[] = [];
  let start = 0;
  for (let index = 0; index < content.length; index++) {
    if (content[index] === "\n") {
      lines.push({
        text: content.slice(start, index),
        start,
        contentEnd: index,
        end: index + 1,
      });
      start = index + 1;
    }
  }

  if (start < content.length || lines.length === 0) {
    lines.push({
      text: content.slice(start),
      start,
      contentEnd: content.length,
      end: content.length,
    });
  }
  return lines;
}

function trailingWhitespaceTrimmed(line: string): string {
  return line.replace(/[ \t]+$/u, "");
}

function leadingWhitespaceLength(line: string): number {
  let length = 0;
  while (length < line.length) {
    const character = line[length];
    if (character !== " " && character !== "\t") return length;
    length++;
  }
  /* v8 ignore next: whitespace-only lines are ignored before indent counting. */
  return length;
}

function commonIndentLength(lines: readonly string[]): number {
  let common: number | undefined;
  for (const line of lines) {
    if (line.trim() === "") continue;
    const indentLength = leadingWhitespaceLength(line);
    common =
      common === undefined ? indentLength : Math.min(common, indentLength);
  }
  /* v8 ignore next: blank-only windows match the trailing-whitespace fallback before indentation matching. */
  return common ?? 0;
}

function stripCommonIndent(lines: readonly string[]): readonly string[] {
  const indentLength = commonIndentLength(lines);
  return lines.map((line) => line.slice(indentLength));
}

function sameLengthArraysEqual(
  left: readonly string[],
  right: readonly string[],
): boolean {
  return left.every((value, index) => value === right[index]);
}

function candidateSpan(
  lines: readonly LineRecord[],
  startLine: number,
  lineCount: number,
  endsWithNewline: boolean,
): EditMatchSpan | null {
  // lineBasedMatches only calls this for bounds-checked line windows; the
  // nullable result is reserved for trailing-newline mismatches.
  const firstLine = lines[startLine];
  const lastLine = lines[startLine + lineCount - 1];
  /* v8 ignore next 3: lineBasedMatches bounds-checks candidate windows before computing spans. */
  if (firstLine === undefined || lastLine === undefined) {
    return null;
  }
  if (endsWithNewline && lastLine.end === lastLine.contentEnd) return null;
  return {
    index: firstLine.start,
    length:
      (endsWithNewline ? lastLine.end : lastLine.contentEnd) - firstLine.start,
  };
}

function lineWindowMatches(
  lines: readonly LineRecord[],
  startLine: number,
  searchLines: readonly string[],
  lineMatches: (
    candidateLines: readonly string[],
    searchLines: readonly string[],
  ) => boolean,
): boolean {
  const candidateLines = lines
    .slice(startLine, startLine + searchLines.length)
    .map((line) => line.text);
  return lineMatches(candidateLines, searchLines);
}

function lineBasedMatches(
  content: string,
  search: string,
  lineMatches: (
    candidateLines: readonly string[],
    searchLines: readonly string[],
  ) => boolean,
): readonly EditMatchSpan[] {
  const searchBlock = parseSearchBlock(search);
  const lines = splitLineRecords(content);
  const matches: EditMatchSpan[] = [];
  const maxStart = lines.length - searchBlock.lines.length;
  for (let startLine = 0; startLine <= maxStart; startLine++) {
    if (!lineWindowMatches(lines, startLine, searchBlock.lines, lineMatches)) {
      continue;
    }

    const span = candidateSpan(
      lines,
      startLine,
      searchBlock.lines.length,
      searchBlock.endsWithNewline,
    );
    if (span !== null) matches.push(span);
  }
  return matches;
}

function lineTrimmedMatches(
  candidateLines: readonly string[],
  searchLines: readonly string[],
): boolean {
  return sameLengthArraysEqual(
    candidateLines.map(trailingWhitespaceTrimmed),
    searchLines.map(trailingWhitespaceTrimmed),
  );
}

function indentationFlexibleMatches(
  candidateLines: readonly string[],
  searchLines: readonly string[],
): boolean {
  return sameLengthArraysEqual(
    stripCommonIndent(candidateLines),
    stripCommonIndent(searchLines),
  );
}

function uniqueMatchResult(matches: readonly EditMatchSpan[]): EditMatchResult {
  if (matches.length === 0) return { status: "not_found" };
  if (matches.length > 1) {
    return { status: "not_unique", occurrenceCount: matches.length };
  }
  const [match] = matches;
  /* v8 ignore next 3: length checks above guarantee the single-match element exists. */
  if (match === undefined) {
    return { status: "not_found" };
  }
  return { status: "matched", match };
}

export function locateUniqueEditSpan(
  content: string,
  search: string,
): EditMatchResult {
  const exact = exactMatches(content, search);
  if (exact.length > 0) return uniqueMatchResult(exact);

  const lineTrimmed = lineBasedMatches(content, search, lineTrimmedMatches);
  if (lineTrimmed.length > 0) return uniqueMatchResult(lineTrimmed);

  const indentationFlexible = lineBasedMatches(
    content,
    search,
    indentationFlexibleMatches,
  );
  return uniqueMatchResult(indentationFlexible);
}

export function locateExactEditSpans(
  content: string,
  search: string,
): readonly EditMatchSpan[] {
  return exactMatches(content, search);
}
