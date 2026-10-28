// Absolute Align To — selection snapshot broadcast.
//
// Sent on `ui-ready` (handshake) and on every `selectionchange`. The UI needs
// the raw lists plus two derived facts (Auto Layout children, same parent) to
// decide which buttons to disable (spec §9.2, §10).

import {
  isAutoLayoutChild,
  isMovableNode,
  shareSameParent,
} from "./figma-nodes";
import type { SelectionUpdatedMessage } from "./messages";

export const sendSelectionUpdate = (): void => {
  const selection = figma.currentPage.selection;
  const message: SelectionUpdatedMessage = {
    type: "selection-updated",
    layers: selection.map((node) => ({ id: node.id, name: node.name })),
    autoLayoutIds: selection.filter(isAutoLayoutChild).map((node) => node.id),
    nonMovableIds: selection
      .filter((node) => !isMovableNode(node))
      .map((node) => node.id),
    sameParent: shareSameParent(selection),
  };
  figma.ui.postMessage(message);
};
