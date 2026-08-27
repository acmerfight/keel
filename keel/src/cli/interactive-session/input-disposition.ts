import { parseInteractiveCommand } from "./commands.ts";
import type {
  InteractiveComposerMode,
  InteractiveInputDisposition,
} from "./display.ts";

export function createInteractiveInputDispositionTracker() {
  let composerMode: InteractiveComposerMode = "ready";
  let activeTurnCommandBarrier = false;

  return {
    setComposerMode: (mode: InteractiveComposerMode): void => {
      composerMode = mode;
      if (mode === "ready") {
        activeTurnCommandBarrier = false;
      }
    },
    dispositionFor: (line: string): InteractiveInputDisposition => {
      if (composerMode === "ready") return "keel";
      if (composerMode === "approval") return "approve";
      if (composerMode === "queue") return "queue";
      if (activeTurnCommandBarrier || parseInteractiveCommand(line) !== null) {
        activeTurnCommandBarrier = true;
        return "queue";
      }
      return "steer/next";
    },
  };
}
