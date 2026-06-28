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

export type SourcePreservingReplacementResult =
  | {
      readonly status: "matched";
      readonly replacement: string;
    }
  | {
      readonly status: "not_preservable";
      readonly reason: string;
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

type SourcePreservingReplacementAttempt =
  | SourcePreservingReplacementResult
  | {
      readonly status: "not_applicable";
    };

const MAX_ALIGNMENT_CELLS = 1_000_000;

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

function formatSearchBlock(block: SearchBlock): string {
  const content = block.lines.join("\n");
  return block.endsWithNewline ? `${content}\n` : content;
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

function trailingWhitespaceSuffix(line: string): string {
  return line.slice(trailingWhitespaceTrimmed(line).length);
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

function commonIndent(lines: readonly string[]): string {
  const indentLength = commonIndentLength(lines);
  for (const line of lines) {
    /* v8 ignore next: blank-only windows match the trailing-whitespace fallback before indentation replacement. */
    if (line.trim() !== "") return line.slice(0, indentLength);
  }
  /* v8 ignore next */
  return "";
}

function sourceLineIndent(line: string, indentLength: number): string {
  return line.slice(0, indentLength);
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

function requiredSequenceItem(items: readonly string[], index: number): string {
  const item = items[index];
  /* v8 ignore next 3: LCS callers only request indexes inside bounds checked loops. */
  if (item === undefined) {
    throw new Error("edit match invariant violated: sequence index is invalid");
  }
  return item;
}

function alignedOldIndexes(
  oldItems: readonly string[],
  newItems: readonly string[],
  itemMatches: (oldItem: string, newItem: string) => boolean,
): readonly (number | null)[] | null {
  if (oldItems.length * newItems.length > MAX_ALIGNMENT_CELLS) {
    return null;
  }

  const columnCount = newItems.length + 1;
  const scoreIndex = (oldIndex: number, newIndex: number): number =>
    oldIndex * columnCount + newIndex;
  const scores = new Uint32Array((oldItems.length + 1) * columnCount);
  const score = (oldIndex: number, newIndex: number): number => {
    const value = scores[scoreIndex(oldIndex, newIndex)];
    /* v8 ignore next 3: alignment only asks for initialized score cells. */
    if (value === undefined) {
      throw new Error("edit match invariant violated: score index is invalid");
    }
    return value;
  };

  for (let oldIndex = oldItems.length - 1; oldIndex >= 0; oldIndex--) {
    for (let newIndex = newItems.length - 1; newIndex >= 0; newIndex--) {
      if (
        itemMatches(
          requiredSequenceItem(oldItems, oldIndex),
          requiredSequenceItem(newItems, newIndex),
        )
      ) {
        scores[scoreIndex(oldIndex, newIndex)] =
          1 + score(oldIndex + 1, newIndex + 1);
      } else {
        scores[scoreIndex(oldIndex, newIndex)] = Math.max(
          score(oldIndex + 1, newIndex),
          score(oldIndex, newIndex + 1),
        );
      }
    }
  }

  const alignedIndexes: (number | null)[] = [];
  let oldIndex = 0;
  let newIndex = 0;
  while (newIndex < newItems.length) {
    if (oldIndex >= oldItems.length) {
      alignedIndexes.push(null);
      newIndex++;
      continue;
    }

    if (
      itemMatches(
        requiredSequenceItem(oldItems, oldIndex),
        requiredSequenceItem(newItems, newIndex),
      ) &&
      score(oldIndex, newIndex) === 1 + score(oldIndex + 1, newIndex + 1)
    ) {
      alignedIndexes.push(oldIndex);
      oldIndex++;
      newIndex++;
      continue;
    }

    if (score(oldIndex, newIndex + 1) >= score(oldIndex + 1, newIndex)) {
      alignedIndexes.push(null);
      newIndex++;
    } else {
      oldIndex++;
    }
  }

  return alignedIndexes;
}

function alignedOldIndexesWithSubstitutions(
  oldItems: readonly string[],
  newItems: readonly string[],
  itemMatches: (oldItem: string, newItem: string) => boolean,
): readonly (number | null)[] | null {
  if (oldItems.length * newItems.length > MAX_ALIGNMENT_CELLS) {
    return null;
  }

  const columnCount = newItems.length + 1;
  const scoreIndex = (oldIndex: number, newIndex: number): number =>
    oldIndex * columnCount + newIndex;
  const scores = new Uint32Array((oldItems.length + 1) * columnCount);
  const score = (oldIndex: number, newIndex: number): number => {
    const value = scores[scoreIndex(oldIndex, newIndex)];
    /* v8 ignore next 3: alignment only asks for initialized score cells. */
    if (value === undefined) {
      throw new Error("edit match invariant violated: score index is invalid");
    }
    return value;
  };

  for (let newIndex = newItems.length - 1; newIndex >= 0; newIndex--) {
    scores[scoreIndex(oldItems.length, newIndex)] = newItems.length - newIndex;
  }
  for (let oldIndex = oldItems.length - 1; oldIndex >= 0; oldIndex--) {
    scores[scoreIndex(oldIndex, newItems.length)] = oldItems.length - oldIndex;
  }

  for (let oldIndex = oldItems.length - 1; oldIndex >= 0; oldIndex--) {
    for (let newIndex = newItems.length - 1; newIndex >= 0; newIndex--) {
      const substitutionCost = itemMatches(
        requiredSequenceItem(oldItems, oldIndex),
        requiredSequenceItem(newItems, newIndex),
      )
        ? 0
        : 1;
      scores[scoreIndex(oldIndex, newIndex)] = Math.min(
        substitutionCost + score(oldIndex + 1, newIndex + 1),
        1 + score(oldIndex + 1, newIndex),
        1 + score(oldIndex, newIndex + 1),
      );
    }
  }

  const alignedIndexes: (number | null)[] = [];
  let oldIndex = 0;
  let newIndex = 0;
  while (newIndex < newItems.length) {
    if (oldIndex >= oldItems.length) {
      alignedIndexes.push(null);
      newIndex++;
      continue;
    }

    const matches = itemMatches(
      requiredSequenceItem(oldItems, oldIndex),
      requiredSequenceItem(newItems, newIndex),
    );
    const substitutionCost = matches ? 0 : 1;
    const diagonalCost = substitutionCost + score(oldIndex + 1, newIndex + 1);
    const insertCost = 1 + score(oldIndex, newIndex + 1);
    const deleteCost = 1 + score(oldIndex + 1, newIndex);
    const currentScore = score(oldIndex, newIndex);
    if (matches && diagonalCost === currentScore) {
      alignedIndexes.push(oldIndex);
      oldIndex++;
      newIndex++;
      continue;
    }
    if (
      !matches &&
      insertCost === currentScore &&
      insertCost <= diagonalCost &&
      insertCost <= deleteCost
    ) {
      alignedIndexes.push(null);
      newIndex++;
      continue;
    }
    if (diagonalCost === currentScore) {
      alignedIndexes.push(oldIndex);
      oldIndex++;
      newIndex++;
      continue;
    }
    oldIndex++;
  }

  return alignedIndexes;
}

function lineTrimmedReplacement(
  source: string,
  oldText: string,
  newText: string,
): SourcePreservingReplacementAttempt {
  const sourceBlock = parseSearchBlock(source);
  const oldBlock = parseSearchBlock(oldText);
  if (
    sourceBlock.lines.length !== oldBlock.lines.length ||
    !lineTrimmedMatches(sourceBlock.lines, oldBlock.lines)
  ) {
    return { status: "not_applicable" };
  }

  const newBlock = parseSearchBlock(newText);
  const alignedOldLines = alignedOldIndexes(
    oldBlock.lines,
    newBlock.lines,
    (oldLine, newLine) =>
      trailingWhitespaceTrimmed(oldLine) === trailingWhitespaceTrimmed(newLine),
  );
  if (alignedOldLines === null) {
    return {
      status: "not_preservable",
      reason: "fuzzy line alignment is too large to preserve safely",
    };
  }

  const lines = newBlock.lines.map((line, index) => {
    const oldIndex = alignedOldLines[index] ?? null;
    const sourceLine =
      oldIndex === null ? undefined : sourceBlock.lines[oldIndex];
    if (sourceLine !== undefined) {
      return `${trailingWhitespaceTrimmed(line)}${trailingWhitespaceSuffix(sourceLine)}`;
    }
    return line;
  });
  return {
    status: "matched",
    replacement: formatSearchBlock({
      lines,
      endsWithNewline: newBlock.endsWithNewline,
    }),
  };
}

function sourceIndexAtNormalizedBoundary(
  normalized: NormalizedTypographicPunctuation,
  boundary: number,
): number | null {
  if (boundary === normalized.sourceIndexByNormalizedIndex.length) {
    return normalized.sourceLength;
  }
  const sourceIndex = normalized.sourceIndexByNormalizedIndex[boundary];
  /* v8 ignore next: callers only ask for ranges inside normalized text. */
  if (sourceIndex === undefined) return null;
  if (
    boundary > 0 &&
    normalized.sourceIndexByNormalizedIndex[boundary - 1] === sourceIndex
  ) {
    return null;
  }
  return sourceIndex;
}

function sourceSpanFromNormalizedRange(
  normalized: NormalizedTypographicPunctuation,
  start: number,
  end: number,
): EditMatchSpan | null {
  const sourceStart = sourceIndexAtNormalizedBoundary(normalized, start);
  const sourceEnd = sourceIndexAtNormalizedBoundary(normalized, end);
  if (sourceStart === null || sourceEnd === null) return null;
  return { index: sourceStart, length: sourceEnd - sourceStart };
}

function textSliceFromNormalizedRange(
  normalized: NormalizedTypographicPunctuation,
  text: string,
  start: number,
  end: number,
): string | null {
  const span = sourceSpanFromNormalizedRange(normalized, start, end);
  if (span === null) return null;
  return text.slice(span.index, span.index + span.length);
}

function replacementTextFromNormalizedRange(
  normalized: NormalizedTypographicPunctuation,
  text: string,
  start: number,
  end: number,
): string {
  const slice = textSliceFromNormalizedRange(normalized, text, start, end);
  /* v8 ignore next 3: if neither source nor replacement can be sliced at typographic boundaries, the local normalized fallback is the only safe non-corrupting segment. */
  if (slice === null) {
    return normalized.text.slice(start, end);
  }
  return slice;
}

function appendTypographicSourceOrReplacementSlices(
  replacement: string[],
  normalizedSource: NormalizedTypographicPunctuation,
  source: string,
  normalizedNew: NormalizedTypographicPunctuation,
  newText: string,
  sourceStart: number,
  sourceEnd: number,
  newStart: number,
): void {
  let segmentStart = sourceStart;
  while (segmentStart < sourceEnd) {
    let sourceSlice: string | null = null;
    let segmentEnd = sourceEnd;
    while (segmentEnd > segmentStart) {
      sourceSlice = textSliceFromNormalizedRange(
        normalizedSource,
        source,
        segmentStart,
        segmentEnd,
      );
      if (sourceSlice !== null) break;
      segmentEnd--;
    }
    if (sourceSlice !== null) {
      replacement.push(sourceSlice);
      segmentStart = segmentEnd;
      continue;
    }

    let fallbackEnd = segmentStart + 1;
    while (
      fallbackEnd < sourceEnd &&
      sourceIndexAtNormalizedBoundary(normalizedSource, fallbackEnd) === null
    ) {
      fallbackEnd++;
    }
    const newSegmentStart = newStart + segmentStart - sourceStart;
    const newSegmentEnd = newStart + fallbackEnd - sourceStart;
    replacement.push(
      replacementTextFromNormalizedRange(
        normalizedNew,
        newText,
        newSegmentStart,
        newSegmentEnd,
      ),
    );
    segmentStart = fallbackEnd;
  }
}

function normalizedCharacters(text: string): readonly string[] {
  const characters: string[] = [];
  for (let index = 0; index < text.length; index++) {
    characters.push(text.charAt(index));
  }
  return characters;
}

function typographicPunctuationReplacementText(
  source: string,
  oldText: string,
  newText: string,
): SourcePreservingReplacementAttempt {
  const normalizedSource =
    typographicPunctuationNormalizedWithSourceMap(source);
  if (normalizedSource.text !== typographicPunctuationNormalized(oldText)) {
    return { status: "not_applicable" };
  }

  const normalizedNew = typographicPunctuationNormalizedWithSourceMap(newText);
  const alignedOldCharacters = alignedOldIndexes(
    normalizedCharacters(normalizedSource.text),
    normalizedCharacters(normalizedNew.text),
    (oldCharacter, newCharacter) => oldCharacter === newCharacter,
  );
  if (alignedOldCharacters === null) {
    return {
      status: "not_preservable",
      reason: "fuzzy punctuation alignment is too large to preserve safely",
    };
  }

  const replacement: string[] = [];
  let newIndex = 0;
  while (newIndex < alignedOldCharacters.length) {
    const oldIndex = alignedOldCharacters[newIndex] ?? null;
    if (oldIndex === null) {
      const start = newIndex;
      while (
        newIndex < alignedOldCharacters.length &&
        alignedOldCharacters[newIndex] === null
      ) {
        newIndex++;
      }
      const newSlice = textSliceFromNormalizedRange(
        normalizedNew,
        newText,
        start,
        newIndex,
      );
      replacement.push(newSlice ?? normalizedNew.text.slice(start, newIndex));
      continue;
    }

    const sourceStart = oldIndex;
    const newStart = newIndex;
    let sourceEnd = oldIndex + 1;
    newIndex++;
    while (newIndex < alignedOldCharacters.length) {
      const nextOldIndex = alignedOldCharacters[newIndex] ?? null;
      if (nextOldIndex !== sourceEnd) break;
      sourceEnd++;
      newIndex++;
    }
    const sourceSlice = textSliceFromNormalizedRange(
      normalizedSource,
      source,
      sourceStart,
      sourceEnd,
    );
    if (sourceSlice !== null) {
      replacement.push(sourceSlice);
      continue;
    }

    appendTypographicSourceOrReplacementSlices(
      replacement,
      normalizedSource,
      source,
      normalizedNew,
      newText,
      sourceStart,
      sourceEnd,
      newStart,
    );
  }
  return { status: "matched", replacement: replacement.join("") };
}

function indentationFlexibleReplacement(
  source: string,
  oldText: string,
  newText: string,
): SourcePreservingReplacementResult {
  const sourceBlock = parseSearchBlock(source);
  const sourceIndentLength = commonIndentLength(sourceBlock.lines);
  const indent = commonIndent(sourceBlock.lines);
  const oldBlock = parseSearchBlock(oldText);
  const newBlock = parseSearchBlock(newText);
  const strippedOldLines = stripCommonIndent(oldBlock.lines);
  const strippedNewLines = stripCommonIndent(newBlock.lines);
  const alignedOldLines = alignedOldIndexesWithSubstitutions(
    strippedOldLines,
    strippedNewLines,
    (oldLine, newLine) => oldLine === newLine,
  );
  if (alignedOldLines === null) {
    return {
      status: "not_preservable",
      reason: "fuzzy indentation alignment is too large to preserve safely",
    };
  }

  return {
    status: "matched",
    replacement: formatSearchBlock({
      lines: strippedNewLines.map((line, index) => {
        const oldIndex = alignedOldLines[index] ?? null;
        const sourceLine =
          oldIndex === null ? undefined : sourceBlock.lines[oldIndex];
        if (line.trim() === "") {
          return sourceLine !== undefined && sourceLine.trim() === ""
            ? sourceLine
            : line;
        }
        return `${sourceLine === undefined ? indent : sourceLineIndent(sourceLine, sourceIndentLength)}${line}`;
      }),
      endsWithNewline: newBlock.endsWithNewline,
    }),
  };
}

export function sourcePreservingReplacement(
  source: string,
  oldText: string,
  newText: string,
): SourcePreservingReplacementResult {
  if (source === oldText) return { status: "matched", replacement: newText };

  // Keep this fallback order in sync with locateUniqueEditSpan; it rebuilds
  // the replacement for the same fuzzy strategy that found the source span.
  const lineTrimmed = lineTrimmedReplacement(source, oldText, newText);
  if (lineTrimmed.status !== "not_applicable") return lineTrimmed;

  const typographic = typographicPunctuationReplacementText(
    source,
    oldText,
    newText,
  );
  if (typographic.status !== "not_applicable") return typographic;

  return indentationFlexibleReplacement(source, oldText, newText);
}
