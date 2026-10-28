// Absolute Align To — plugin entry point.
//
// The implementation lives in `src/` and is bundled into `code.js` by esbuild
// (spec §7). This file only wires the plugin lifecycle:
//   - show the UI
//   - forward selection changes to the UI
//   - dispatch messages from the UI
//
// NOTE: manifest.json uses documentAccess: "dynamic-page", so the synchronous
// `figma.getNodeById` is unavailable. The key object is resolved by scanning
// `figma.currentPage.selection` (see src/align.ts, src/distribute.ts).

import { handleAlign } from "./src/align";
import { handleDistribute } from "./src/distribute";
import { isUiToMainMessage } from "./src/messages";
import { sendSelectionUpdate } from "./src/selection";

figma.showUI(__html__, { width: 320, height: 480, themeColors: true });

figma.on("selectionchange", () => {
  sendSelectionUpdate();
});

figma.ui.onmessage = (raw: unknown) => {
  if (!isUiToMainMessage(raw)) return;
  switch (raw.type) {
    case "ui-ready":
      // Handshake: the UI is ready to receive postMessage. This avoids losing
      // an early selection snapshot sent right after showUI().
      sendSelectionUpdate();
      return;
    case "align":
      handleAlign(raw.keyObjectId, raw.direction, raw.closeAfter);
      return;
    case "distribute":
      handleDistribute(
        raw.axis,
        raw.keyObjectId,
        raw.spacing,
        raw.closeAfter,
      );
      return;
    case "close":
      figma.closePlugin();
      return;
  }
};
