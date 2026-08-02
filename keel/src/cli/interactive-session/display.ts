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
    "Commands: /sessions /status /tasks /diff /undo /help",
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
