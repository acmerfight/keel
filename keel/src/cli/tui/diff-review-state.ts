export type DiffReviewState =
  | { readonly kind: "at-top" }
  | { readonly kind: "at-bottom" }
  | { readonly kind: "scrolled"; readonly scrollTop: number };

export interface DiffReviewViewport {
  readonly totalRows: number;
  readonly visibleRows: number;
}

export type DiffReviewAction =
  | { readonly kind: "line-up" }
  | { readonly kind: "line-down" }
  | { readonly kind: "page-up" }
  | { readonly kind: "page-down" }
  | { readonly kind: "home" }
  | { readonly kind: "end" };

export interface DiffReviewRange {
  readonly scrollTop: number;
  readonly lineFrom: number;
  readonly lineTo: number;
}

export const INITIAL_DIFF_REVIEW_STATE: DiffReviewState = { kind: "at-top" };

function maxScroll(viewport: DiffReviewViewport): number {
  return Math.max(0, viewport.totalRows - viewport.visibleRows);
}

export function diffReviewRange(
  state: DiffReviewState,
  viewport: DiffReviewViewport,
): DiffReviewRange {
  const maximum = maxScroll(viewport);
  const scrollTop = (() => {
    switch (state.kind) {
      case "at-top":
        return 0;
      case "at-bottom":
        return maximum;
      case "scrolled":
        return Math.min(state.scrollTop, maximum);
    }
  })();
  return {
    scrollTop,
    lineFrom: viewport.totalRows === 0 ? 0 : scrollTop + 1,
    lineTo: Math.min(viewport.totalRows, scrollTop + viewport.visibleRows),
  };
}

export function updateDiffReviewState(
  state: DiffReviewState,
  action: DiffReviewAction,
  viewport: DiffReviewViewport,
): DiffReviewState {
  const current = diffReviewRange(state, viewport).scrollTop;
  const maximum = maxScroll(viewport);
  const fromScrollTop = (scrollTop: number): DiffReviewState => {
    if (scrollTop === 0) {
      return { kind: "at-top" };
    }
    if (scrollTop === maximum) {
      return { kind: "at-bottom" };
    }
    return { kind: "scrolled", scrollTop };
  };
  switch (action.kind) {
    case "line-up":
      return fromScrollTop(Math.max(0, current - 1));
    case "line-down":
      return fromScrollTop(Math.min(maximum, current + 1));
    case "page-up":
      return fromScrollTop(Math.max(0, current - viewport.visibleRows));
    case "page-down":
      return fromScrollTop(Math.min(maximum, current + viewport.visibleRows));
    case "home":
      return { kind: "at-top" };
    case "end":
      return { kind: "at-bottom" };
  }
}
