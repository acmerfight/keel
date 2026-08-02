import type { SessionQueuedInput } from "../session-store.ts";

export interface InteractiveLineInput {
  readonly on: (
    event: "line",
    listener: (line: string) => void,
  ) => InteractiveLineInput;
  readonly once: (event: "close", listener: () => void) => InteractiveLineInput;
  readonly off: (
    event: "line" | "close",
    listener: ((line: string) => void) | (() => void),
  ) => InteractiveLineInput;
  readonly close: () => void;
}

export interface LineReader {
  readonly readLine: () => Promise<QueuedLine | null>;
  readonly readLineAfter: (
    sequence: number,
    signal: AbortSignal,
  ) => Promise<string | null>;
  readonly drainLinesAfter: (sequence: number) => readonly QueuedLine[];
  readonly restoreLines: (lines: readonly QueuedLine[]) => void;
  readonly sequence: () => number;
  readonly needsInput: () => boolean;
  readonly pendingInputCount: () => number;
  readonly dispose: () => void;
}

export interface QueuedLine {
  readonly sequence: number;
  readonly line: string;
  readonly inputId?: string;
}

interface LineWaiter {
  readonly after: number;
  readonly resolve: (line: string | null) => void;
}

function queuedLineFromSessionInput(input: SessionQueuedInput): QueuedLine {
  return {
    sequence: input.sequence,
    line: input.line,
    inputId: input.id,
  };
}

function queuedLineWithInputId(
  sequence: number,
  line: string,
  inputId: string | undefined,
): QueuedLine {
  if (inputId === undefined) {
    return { sequence, line };
  }
  return { sequence, line, inputId };
}

export function trimQueuedLine(queuedLine: QueuedLine): QueuedLine {
  return queuedLineWithInputId(
    queuedLine.sequence,
    queuedLine.line.trim(),
    queuedLine.inputId,
  );
}

export function queuedInputIds(
  lines: readonly QueuedLine[],
): readonly string[] {
  const inputIds: string[] = [];
  for (const line of lines) {
    if (line.inputId !== undefined) {
      inputIds.push(line.inputId);
    }
  }
  return inputIds;
}

export function createLineReader(
  input: InteractiveLineInput,
  options: {
    readonly initialQueuedInputs?: readonly SessionQueuedInput[];
    readonly initialInputLines?: readonly string[];
    readonly persistQueuedInput?: (input: {
      readonly sequence: number;
      readonly line: string;
    }) => SessionQueuedInput;
    readonly onLineSubmitted?: (line: string) => void;
  },
): LineReader {
  const queued: QueuedLine[] = (options.initialQueuedInputs ?? []).map(
    queuedLineFromSessionInput,
  );
  let currentSequence = queued.reduce(
    (highest, queuedLine) => Math.max(highest, queuedLine.sequence),
    0,
  );
  for (const line of options.initialInputLines ?? []) {
    currentSequence++;
    const admittedInput =
      line.trim() === ""
        ? undefined
        : options.persistQueuedInput?.({
            sequence: currentSequence,
            line,
          });
    queued.push(
      queuedLineWithInputId(currentSequence, line, admittedInput?.id),
    );
  }
  const waiters: Array<(line: QueuedLine | null) => void> = [];
  const freshWaiters: LineWaiter[] = [];
  let closed = false;
  let inputFailure: { readonly error: unknown } | null = null;

  // Approval answers must be typed after the approval prompt appears. The
  // sequence lets approval waits ignore already-queued user messages.
  const onLine = (line: string) => {
    if (inputFailure !== null) return;
    options.onLineSubmitted?.(line);
    currentSequence++;
    const queuedLine = { sequence: currentSequence, line };
    const freshWaiterIndex = freshWaiters.findIndex(
      (waiter) => queuedLine.sequence > waiter.after,
    );
    if (freshWaiterIndex >= 0) {
      const freshWaiter = freshWaiters[freshWaiterIndex];
      freshWaiters.splice(freshWaiterIndex, 1);
      freshWaiter?.resolve(queuedLine.line);
      return;
    }

    const waiter = waiters.shift();
    if (waiter !== undefined) {
      waiter(queuedLine);
      return;
    }
    let admittedInput: SessionQueuedInput | undefined;
    try {
      admittedInput =
        line.trim() === ""
          ? undefined
          : options.persistQueuedInput?.({
              sequence: queuedLine.sequence,
              line: queuedLine.line,
            });
    } catch (error) {
      inputFailure = { error };
      closed = true;
      return;
    }
    queued.push(
      queuedLineWithInputId(
        queuedLine.sequence,
        queuedLine.line,
        admittedInput?.id,
      ),
    );
  };
  input.on("line", onLine);

  const onClose = () => {
    closed = true;
    for (;;) {
      const waiter = waiters.shift();
      if (waiter === undefined) break;
      waiter(null);
    }
    for (;;) {
      const waiter = freshWaiters.shift();
      if (waiter === undefined) return;
      waiter.resolve(null);
    }
  };
  input.once("close", onClose);

  return {
    readLine: () => {
      if (inputFailure !== null) {
        return Promise.reject(inputFailure.error);
      }
      const queuedLine = queued.shift();
      if (queuedLine !== undefined) {
        return Promise.resolve(queuedLine);
      }
      if (closed) {
        return Promise.resolve(null);
      }
      return new Promise((resolve) => {
        waiters.push(resolve);
      });
    },
    readLineAfter: (sequence, signal) => {
      if (inputFailure !== null) {
        return Promise.reject(inputFailure.error);
      }
      for (const [index, queuedLine] of queued.entries()) {
        if (queuedLine.sequence > sequence) {
          queued.splice(index, 1);
          return Promise.resolve(queuedLine.line);
        }
      }
      if (closed) {
        return Promise.resolve(null);
      }
      return new Promise((resolve) => {
        if (signal.aborted) {
          resolve(null);
          return;
        }
        let waiter: LineWaiter;
        const onAbort = () => {
          const index = freshWaiters.indexOf(waiter);
          /* v8 ignore next 3: while the abort listener is registered, the waiter is registered; this guard is defensive against future lifecycle changes. */
          if (index >= 0) {
            freshWaiters.splice(index, 1);
          }
          resolve(null);
        };
        waiter = {
          after: sequence,
          resolve: (line) => {
            signal.removeEventListener("abort", onAbort);
            resolve(line);
          },
        };
        signal.addEventListener("abort", onAbort, { once: true });
        freshWaiters.push(waiter);
      });
    },
    drainLinesAfter: (sequence) => {
      const drained: QueuedLine[] = [];
      for (let index = 0; index < queued.length; ) {
        const queuedLine = queued[index];
        if (queuedLine !== undefined && queuedLine.sequence > sequence) {
          queued.splice(index, 1);
          drained.push(queuedLine);
          continue;
        }
        index++;
      }
      return drained;
    },
    restoreLines: (lines) => {
      queued.push(...lines);
      queued.sort((left, right) => left.sequence - right.sequence);
    },
    sequence: () => currentSequence,
    needsInput: () => queued.length === 0 && !closed,
    pendingInputCount: () =>
      queued.filter((queuedLine) => queuedLine.line.trim() !== "").length,
    dispose: () => {
      input.off("line", onLine);
      input.off("close", onClose);
    },
  };
}
