import type { AgentEvent, CostReport } from "../../agent/events.ts";
import type { InteractiveDiffInspection } from "./diff-inspection.ts";
import { createInteractiveInputDispositionTracker } from "./input-disposition.ts";

export type InteractiveComposerMode = "approval" | "queue" | "ready" | "steer";

export type InteractiveInputDisposition =
  | "approve"
  | "keel"
  | "queue"
  | "steer/next";

export type InteractiveSessionEndEvent = Extract<
  AgentEvent,
  { readonly type: "end" }
>;

export interface StableInteractiveDisplay {
  readonly writeIntro: () => void;
  readonly renderPrompt: () => void;
  readonly acceptInput: () => void;
  readonly closePrompt: () => void;
  readonly writeStdout: (text: string) => void;
  readonly writeStderr: (text: string) => void;
  readonly writeAssistantHeader: () => void;
  readonly writeStatusLine: (text: string) => void;
}

export interface InteractiveSessionDisplay {
  readonly writeStdout: (text: string) => void;
  readonly writeStderr: (text: string) => void;
  readonly renderPrompt: () => void;
  readonly acceptInput: () => void;
  readonly closePrompt: () => void;
  readonly setComposerMode: (mode: InteractiveComposerMode) => void;
  readonly renderSubmittedInput: (line: string) => void;
  readonly setGoalStatus: (text: string | null) => void;
  readonly renderDiffReview: (inspection: InteractiveDiffInspection) => boolean;
  readonly printAgentEvents: (
    stream: AsyncIterable<AgentEvent>,
  ) => Promise<InteractiveSessionEndEvent | undefined>;
  readonly formatCostReport: (cost: CostReport) => string;
}

interface StableInteractiveDisplayRuntime {
  readonly writeStdout: (text: string) => void;
  readonly writeStderr: (text: string) => void;
}

export interface StableInteractiveDisplayOptions {
  readonly inputEchoesToDisplay: boolean;
  readonly session:
    | {
        readonly kind: "saved";
        readonly sessionId: string;
        readonly resumeAvailable: boolean;
      }
    | {
        readonly kind: "ephemeral";
      };
}

interface InteractiveSessionDisplayOutput {
  readonly writeStdout: (text: string) => void;
  readonly writeStderr: (text: string) => void;
}

interface InteractiveSessionDisplayControls {
  readonly renderPrompt?: () => void;
  readonly acceptInput?: () => void;
  readonly closePrompt?: () => void;
  readonly setComposerMode?: (mode: InteractiveComposerMode) => void;
  readonly renderSubmittedInput?: (
    line: string,
    disposition: InteractiveInputDisposition,
  ) => void;
  readonly setGoalStatus?: (text: string | null) => void;
  readonly renderDiffReview?: (inspection: InteractiveDiffInspection) => void;
}

export interface InteractiveSessionDisplayOptions {
  readonly output: InteractiveSessionDisplayOutput;
  readonly controls?: InteractiveSessionDisplayControls;
  readonly printAgentEvents: (
    stream: AsyncIterable<AgentEvent>,
  ) => Promise<InteractiveSessionEndEvent | undefined>;
  readonly formatCostReport: (cost: CostReport) => string;
}

function formatInteractiveIntro(
  session: StableInteractiveDisplayOptions["session"],
): string {
  if (session.kind === "ephemeral") {
    return [
      "Keel interactive session (ephemeral)",
      "Not saved. Start without --ephemeral to resume later.",
      "Continue the task here; send follow-ups or corrections until it is done.",
      "Commands: /status /tasks /diff /undo /help",
      "",
    ].join("\n");
  }

  return [
    "Keel interactive session",
    `session: ${session.sessionId}`,
    "Continue the task here; send follow-ups or corrections until it is done.",
    session.resumeAvailable
      ? `Resume later with: keel --resume ${session.sessionId}`
      : `After a completed turn, resume with: keel --resume ${session.sessionId}`,
    "Commands: /sessions /status /agents /tasks /diff /undo /help",
    "",
  ].join("\n");
}

export function createStableInteractiveDisplay(
  runtime: StableInteractiveDisplayRuntime,
  options: StableInteractiveDisplayOptions,
): StableInteractiveDisplay {
  let promptVisible = false;

  const finishPromptLine = () => {
    if (!promptVisible) {
      return;
    }
    runtime.writeStderr("\n");
    promptVisible = false;
  };

  return {
    writeIntro: () => {
      runtime.writeStderr(formatInteractiveIntro(options.session));
    },
    renderPrompt: () => {
      runtime.writeStderr("keel> ");
      promptVisible = true;
    },
    acceptInput: () => {
      if (options.inputEchoesToDisplay) {
        promptVisible = false;
        return;
      }
      finishPromptLine();
    },
    closePrompt: () => {
      finishPromptLine();
    },
    writeStdout: (text) => {
      runtime.writeStdout(text);
    },
    writeStderr: (text) => {
      finishPromptLine();
      runtime.writeStderr(text);
    },
    writeAssistantHeader: () => {
      finishPromptLine();
      runtime.writeStderr("assistant:\n");
    },
    writeStatusLine: (text) => {
      finishPromptLine();
      runtime.writeStderr(`status: ${text}\n`);
    },
  };
}

export function createInteractiveSessionDisplay(
  options: InteractiveSessionDisplayOptions,
): InteractiveSessionDisplay {
  const inputDisposition = createInteractiveInputDispositionTracker();
  const controls = options.controls;

  return {
    writeStdout: (text) => {
      options.output.writeStdout(text);
    },
    writeStderr: (text) => {
      options.output.writeStderr(text);
    },
    renderPrompt: () => {
      controls?.renderPrompt?.();
    },
    acceptInput: () => {
      controls?.acceptInput?.();
    },
    closePrompt: () => {
      controls?.closePrompt?.();
    },
    setComposerMode: (mode) => {
      inputDisposition.setComposerMode(mode);
      controls?.setComposerMode?.(mode);
    },
    renderSubmittedInput: (line) => {
      controls?.renderSubmittedInput?.(
        line,
        inputDisposition.dispositionFor(line),
      );
    },
    setGoalStatus: (text) => {
      controls?.setGoalStatus?.(text);
    },
    renderDiffReview: (inspection) => {
      if (controls?.renderDiffReview === undefined) {
        return false;
      }
      controls.renderDiffReview(inspection);
      return true;
    },
    printAgentEvents: (stream) => options.printAgentEvents(stream),
    formatCostReport: (cost) => options.formatCostReport(cost),
  };
}
