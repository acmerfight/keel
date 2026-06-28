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
      readonly matches: readonly EditMatchSpan[];
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

interface NormalizedTypographicPunctuation {
  readonly text: string;
  readonly sourceIndexByNormalizedIndex: readonly number[];
  readonly sourceLength: number;
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

function typographicPunctuationReplacement(character: string): string {
  switch (character) {
    case "\u2018":
    case "\u2019":
    case "\u201a":
    case "\u201b":
      return "'";
    case "\u201c":
    case "\u201d":
    case "\u201e":
    case "\u201f":
      return '"';
    case "\u2010":
    case "\u2011":
    case "\u2012":
    case "\u2013":
    case "\u2014":
    case "\u2015":
      return "-";
    case "\u2026":
      return "...";
    default:
      return character;
  }
}

function typographicPunctuationNormalizedWithSourceMap(
  text: string,
): NormalizedTypographicPunctuation {
  const normalized: string[] = [];
  const sourceIndexByNormalizedIndex: number[] = [];
  for (let index = 0; index < text.length; index++) {
    const replacement = typographicPunctuationReplacement(text.charAt(index));
    normalized.push(replacement);
    for (
      let replacementIndex = 0;
      replacementIndex < replacement.length;
      replacementIndex++
    ) {
      sourceIndexByNormalizedIndex.push(index);
    }
  }
  return {
    text: normalized.join(""),
    sourceIndexByNormalizedIndex,
    sourceLength: text.length,
  };
}

function typographicPunctuationNormalized(text: string): string {
  const normalized: string[] = [];
  for (let index = 0; index < text.length; index++) {
    normalized.push(typographicPunctuationReplacement(text.charAt(index)));
  }
  return normalized.join("");
}

function leadingWhitespaceLength(line: string): number {
  let length = 0;
  while (line[length] === " " || line[length] === "\t") {
    length++;
  }
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
    throw new Error("edit match invariant violated: candidate span is invalid");
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
  let match: EditMatchSpan | undefined;
  for (const candidate of matches) {
    if (match !== undefined) {
      return {
        status: "not_unique",
        occurrenceCount: matches.length,
        matches,
      };
    }
    match = candidate;
  }
  if (match === undefined) {
    return { status: "not_found" };
  }
  return { status: "matched", match };
}

function typographicPunctuationSourceSpan(
  normalized: NormalizedTypographicPunctuation,
  match: EditMatchSpan,
): EditMatchSpan | null {
  const sourceStart = normalized.sourceIndexByNormalizedIndex[match.index];
  /* v8 ignore next 3: typographic punctuation scan only returns spans inside the normalized text. */
  if (sourceStart === undefined) {
    throw new Error(
      "edit match invariant violated: punctuation span is invalid",
    );
  }
  if (
    match.index > 0 &&
    normalized.sourceIndexByNormalizedIndex[match.index - 1] === sourceStart
  ) {
    return null;
  }

  const normalizedEnd = match.index + match.length;
  let sourceEnd: number;
  if (normalizedEnd >= normalized.sourceIndexByNormalizedIndex.length) {
    sourceEnd = normalized.sourceLength;
  } else {
    const endSourceIndex =
      normalized.sourceIndexByNormalizedIndex[normalizedEnd];
    /* v8 ignore next 3: typographic punctuation scan only returns spans inside the normalized text. */
    if (endSourceIndex === undefined) {
      throw new Error(
        "edit match invariant violated: punctuation span is invalid",
      );
    }
    if (
      normalizedEnd > 0 &&
      normalized.sourceIndexByNormalizedIndex[normalizedEnd - 1] ===
        endSourceIndex
    ) {
      return null;
    }
    sourceEnd = endSourceIndex;
  }

  return { index: sourceStart, length: sourceEnd - sourceStart };
}

function typographicPunctuationMatches(
  content: string,
  search: string,
): readonly EditMatchSpan[] {
  const normalizedContent =
    typographicPunctuationNormalizedWithSourceMap(content);
  const normalizedSearch = typographicPunctuationNormalized(search);
  const matches: EditMatchSpan[] = [];
  let start = 0;
  while (true) {
    const index = normalizedContent.text.indexOf(normalizedSearch, start);
    if (index < 0) return matches;
    const sourceSpan = typographicPunctuationSourceSpan(normalizedContent, {
      index,
      length: normalizedSearch.length,
    });
    if (sourceSpan !== null) matches.push(sourceSpan);
    start = index + 1;
  }
}

export function locateUniqueEditSpan(
  content: string,
  search: string,
): EditMatchResult {
  const exact = exactMatches(content, search);
  if (exact.length > 0) return uniqueMatchResult(exact);

  const lineTrimmed = lineBasedMatches(content, search, lineTrimmedMatches);
  if (lineTrimmed.length > 0) return uniqueMatchResult(lineTrimmed);

  const typographicPunctuation = typographicPunctuationMatches(content, search);
  if (typographicPunctuation.length > 0) {
    return uniqueMatchResult(typographicPunctuation);
  }

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
