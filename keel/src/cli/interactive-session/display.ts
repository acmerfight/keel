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

interface StableInteractiveDisplayOptions {
  readonly inputEchoesToDisplay: boolean;
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
      runtime.writeStderr("Keel interactive session\n");
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
