export type DiffReviewScrollState =
  | { readonly kind: "at-top" }
  | { readonly kind: "at-bottom" }
  | { readonly kind: "scrolled"; readonly scrollTop: number };

export type DiffReviewFileState =
  | DiffReviewScrollState
  | { readonly kind: "at-file"; readonly fileIndex: number };

export interface DiffReviewFileTarget<T> {
  readonly index: number;
  readonly row: number;
  readonly value: T;
}

export interface DiffReviewViewport {
  readonly totalRows: number;
  readonly visibleRows: number;
}

export interface DiffReviewFileViewport<T> extends DiffReviewViewport {
  readonly files: readonly [
    DiffReviewFileTarget<T>,
    ...DiffReviewFileTarget<T>[],
  ];
}

export type DiffReviewAction =
  | { readonly kind: "line-up" }
  | { readonly kind: "line-down" }
  | { readonly kind: "page-up" }
  | { readonly kind: "page-down" }
  | { readonly kind: "previous-file" }
  | { readonly kind: "next-file" }
  | { readonly kind: "home" }
  | { readonly kind: "end" };

export interface DiffReviewRange {
  readonly scrollTop: number;
  readonly lineFrom: number;
  readonly lineTo: number;
}

export interface DiffReviewFileRange<T> extends DiffReviewRange {
  readonly currentFile: DiffReviewFileTarget<T>;
}

export const INITIAL_DIFF_REVIEW_SCROLL_STATE: DiffReviewScrollState = {
  kind: "at-top",
};

export const INITIAL_DIFF_REVIEW_FILE_STATE: DiffReviewFileState = {
  kind: "at-top",
};

function maxScroll(viewport: DiffReviewViewport): number {
  return Math.max(0, viewport.totalRows - viewport.visibleRows);
}

function rangeAt(
  scrollTop: number,
  viewport: DiffReviewViewport,
): DiffReviewRange {
  return {
    scrollTop,
    lineFrom: viewport.totalRows === 0 ? 0 : scrollTop + 1,
    lineTo: Math.min(viewport.totalRows, scrollTop + viewport.visibleRows),
  };
}

function scrollRange(
  state: DiffReviewScrollState,
  viewport: DiffReviewViewport,
): DiffReviewRange {
  const maximum = maxScroll(viewport);
  switch (state.kind) {
    case "at-top":
      return rangeAt(0, viewport);
    case "at-bottom":
      return rangeAt(maximum, viewport);
    case "scrolled":
      return rangeAt(Math.min(state.scrollTop, maximum), viewport);
  }
}

function selectedFileTarget<T>(
  fileIndex: number,
  files: DiffReviewFileViewport<T>["files"],
): DiffReviewFileTarget<T> {
  for (const file of files) {
    if (file.index === fileIndex) {
      return file;
    }
  }
  throw new Error("Selected diff review section is not in the viewport.");
}

function currentFileTarget<T>(
  state: DiffReviewScrollState,
  scrollTop: number,
  files: DiffReviewFileViewport<T>["files"],
): DiffReviewFileTarget<T> {
  let current = files[0];
  if (state.kind === "at-bottom") {
    for (const file of files) {
      current = file;
    }
    return current;
  }
  for (const file of files) {
    if (file.row <= scrollTop) {
      current = file;
    }
  }
  return current;
}

export function diffReviewRange(
  state: DiffReviewScrollState,
  viewport: DiffReviewViewport,
): DiffReviewRange {
  return scrollRange(state, viewport);
}

export function diffReviewFileRange<T>(
  state: DiffReviewFileState,
  viewport: DiffReviewFileViewport<T>,
): DiffReviewFileRange<T> {
  if (state.kind === "at-file") {
    const currentFile = selectedFileTarget(state.fileIndex, viewport.files);
    const range = rangeAt(
      Math.min(currentFile.row, maxScroll(viewport)),
      viewport,
    );
    return { ...range, currentFile };
  }
  const range = scrollRange(state, viewport);
  return {
    ...range,
    currentFile: currentFileTarget(state, range.scrollTop, viewport.files),
  };
}

function fromScrollTop(
  scrollTop: number,
  viewport: DiffReviewViewport,
): DiffReviewScrollState {
  if (scrollTop === 0) {
    return { kind: "at-top" };
  }
  if (scrollTop === maxScroll(viewport)) {
    return { kind: "at-bottom" };
  }
  return { kind: "scrolled", scrollTop };
}

function updateScrollState(
  state: DiffReviewScrollState,
  action: Exclude<
    DiffReviewAction,
    { readonly kind: "previous-file" | "next-file" }
  >,
  viewport: DiffReviewViewport,
): DiffReviewScrollState {
  const current = scrollRange(state, viewport).scrollTop;
  const maximum = maxScroll(viewport);
  switch (action.kind) {
    case "line-up":
      return fromScrollTop(Math.max(0, current - 1), viewport);
    case "line-down":
      return fromScrollTop(Math.min(maximum, current + 1), viewport);
    case "page-up":
      return fromScrollTop(
        Math.max(0, current - viewport.visibleRows),
        viewport,
      );
    case "page-down":
      return fromScrollTop(
        Math.min(maximum, current + viewport.visibleRows),
        viewport,
      );
    case "home":
      return { kind: "at-top" };
    case "end":
      return { kind: "at-bottom" };
  }
}

export function updateDiffReviewState(
  state: DiffReviewScrollState,
  action: DiffReviewAction,
  viewport: DiffReviewViewport,
): DiffReviewScrollState {
  switch (action.kind) {
    case "previous-file":
    case "next-file":
      return state;
    default:
      return updateScrollState(state, action, viewport);
  }
}

export function updateDiffReviewFileState<T>(
  state: DiffReviewFileState,
  action: DiffReviewAction,
  viewport: DiffReviewFileViewport<T>,
): DiffReviewFileState {
  const range = diffReviewFileRange(state, viewport);
  switch (action.kind) {
    case "previous-file": {
      let previous = viewport.files[0];
      if (range.currentFile.row === previous.row) {
        return { kind: "at-top" };
      }
      for (const file of viewport.files) {
        if (file.row >= range.currentFile.row) {
          break;
        }
        previous = file;
      }
      return { kind: "at-file", fileIndex: previous.index };
    }
    case "next-file":
      for (const file of viewport.files) {
        if (file.row > range.currentFile.row) {
          return { kind: "at-file", fileIndex: file.index };
        }
      }
      return state;
    default:
      return updateScrollState(
        fromScrollTop(range.scrollTop, viewport),
        action,
        viewport,
      );
  }
}
