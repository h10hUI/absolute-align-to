// Absolute Align To — align executor.
//
// Pass 1 (read only): pick the layers to move and record each one's ORIGINAL
//   absolute geometry, plus its depth.
// Pass 2 (write only): ancestors first. For each node, RE-READ both the key
//   object's box and the parent's absolute origin immediately before the
//   write, compute the target absolute position against the current key box,
//   then convert to current parent-relative coordinates.
//
// Why this is consistent:
//   - If both a container and its child move, the container is written first;
//     the child's write then sees the settled parent origin and lands on its
//     own absolute target.
//   - Inside a GROUP, moving one child reflows the group's bounds/origin, but
//     the siblings keep their absolute positions. Re-reading the parent origin
//     before each write (and the key box, as a safety net) places each node
//     correctly.
//   - The key object itself is never moved. A selected ancestor of the key is
//     skipped, because moving it would shift the key. Descendants of the key
//     are skipped ONLY when the key's box is child-derived (GROUP / boolean
//     op), since moving such a child would otherwise resize/move the key.
//
// NOTE: Rotation is intentionally unsupported in this version (spec §4).
// `rotation !== 0` detection is a future extension point.

import {
  absoluteToRelative,
  computeTargetPosition,
  isAlignDirection,
} from "./geometry";
import {
  getAbsoluteRect,
  getNodeDepth,
  getParentAbsoluteOrigin,
  planMovingLayers,
  POSITION_EPSILON,
  rectsEqual,
} from "./figma-nodes";
import type { SkippedLayer } from "./figma-nodes";
import type { AlignErrorMessage, AlignResultMessage } from "./messages";

const postAlignResult = (
  moved: number,
  skipped: SkippedLayer[],
  warning?: string,
): void => {
  const message: AlignResultMessage = { type: "align-result", moved, skipped };
  if (warning) message.warning = warning;
  figma.ui.postMessage(message);
};

const postAlignError = (message: string): void => {
  const payload: AlignErrorMessage = { type: "align-error", message };
  figma.ui.postMessage(payload);
};

export const handleAlign = (
  rawKeyObjectId: unknown,
  rawDirection: unknown,
  rawCloseAfter: unknown,
): void => {
  // Only an explicit `true` opts in to closing; anything else keeps the UI open.
  const closeAfter = rawCloseAfter === true;

  if (!isAlignDirection(rawDirection)) {
    postAlignError("Unknown align direction.");
    return;
  }
  const direction = rawDirection;

  if (typeof rawKeyObjectId !== "string" || rawKeyObjectId.length === 0) {
    postAlignError("No key object selected.");
    return;
  }
  const keyObjectId = rawKeyObjectId;

  const selection = figma.currentPage.selection;

  // Double guard: the UI also disables the align buttons in this case.
  if (selection.length < 2) {
    postAlignError("Select 2 or more layers to align.");
    return;
  }

  const keyNode = selection.find((node) => node.id === keyObjectId);
  if (!keyNode) {
    postAlignError("The key object is no longer in the selection.");
    return;
  }

  const keyRect = getAbsoluteRect(keyNode);
  if (!keyRect) {
    postAlignError("The key object has no bounding box.");
    return;
  }

  // Pass 1 (read only).
  const { moving, skipped } = planMovingLayers(selection, keyNode);
  const planned = moving.map(({ node, originalRect }) => ({
    node,
    originalRect,
    depth: getNodeDepth(node),
  }));

  // Ancestors before descendants (Array.prototype.sort is stable in ES2019+).
  planned.sort((a, b) => a.depth - b.depth);

  // Pass 2 (write only). Re-read the key box and the parent origin right before
  // each write. The node's own geometry (size and the non-aligned axis) comes
  // from the pass-1 original rect, so aligning one axis never drifts the other.
  // Direct x/y writes can still throw for exotic (e.g. instance) children;
  // convert those failures into skip warnings instead of aborting the batch.
  let moved = 0;
  let keyRectChanged = false;
  let processed = 0;
  for (const { node, originalRect } of planned) {
    processed += 1;
    // A write can throw halfway (node.x succeeded, node.y did not), leaving the
    // layer on a single axis. This is deliberately NOT rolled back: the key
    // object never moved, so re-running the align after the cause is fixed
    // converges, and the layer is reported in `skipped` either way.
    try {
      const freshKeyRect = getAbsoluteRect(keyNode);
      if (!freshKeyRect) {
        // Stop the batch, but account for the layers that will not be touched.
        const remaining = planned.length - processed;
        skipped.push({
          id: node.id,
          reason:
            remaining > 0
              ? `${node.name}: key object lost its bounding box — stopped (${remaining} layer${remaining === 1 ? "" : "s"} not processed)`
              : `${node.name}: key object lost its bounding box — stopped`,
        });
        break;
      }
      if (!rectsEqual(freshKeyRect, keyRect)) {
        keyRectChanged = true;
      }
      const parentOrigin = getParentAbsoluteOrigin(node.parent);
      if (!parentOrigin) {
        skipped.push({
          id: node.id,
          reason: `${node.name}: parent has no bounding box`,
        });
        continue;
      }
      const target = computeTargetPosition(freshKeyRect, originalRect, direction);
      const relative = absoluteToRelative(target, parentOrigin);
      // Always write (correctness: this also counteracts an ancestor move made
      // earlier in the batch), but count the layer as "moved" only when its
      // page-space position actually changes. Parent-relative x/y is not a
      // reliable signal: moving a group's leftmost child shifts the group's
      // origin and can leave the child's local x unchanged.
      node.x = relative.x;
      node.y = relative.y;
      const writtenRect = getAbsoluteRect(node);
      if (
        !writtenRect ||
        Math.abs(writtenRect.x - originalRect.x) > POSITION_EPSILON ||
        Math.abs(writtenRect.y - originalRect.y) > POSITION_EPSILON
      ) {
        moved += 1;
      }
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      skipped.push({ id: node.id, reason: `${node.name}: ${detail}` });
    }
  }

  // The in-loop checks run before each write, so a change caused by the LAST
  // write would otherwise go unnoticed. Re-check once more after the loop.
  const finalKeyRect = getAbsoluteRect(keyNode);
  if (finalKeyRect && !rectsEqual(finalKeyRect, keyRect)) {
    keyRectChanged = true;
  }

  // Deliberately no speculation about the cause: the box may change because a
  // shared container (group, component set) reflowed, so the user is asked to
  // verify rather than told what happened.
  const warning = keyRectChanged
    ? "The key object's box changed during alignment (a shared container reflowed). Verify the result."
    : undefined;

  // "Close after aligning" is on and the run was clean (nothing skipped, no
  // warning): close the plugin and report via a toast. Otherwise keep the UI
  // open so the user can read the details or keep aligning.
  if (closeAfter && skipped.length === 0 && !warning) {
    figma.closePlugin(
      moved > 0
        ? `Aligned ${moved} layer${moved === 1 ? "" : "s"}.`
        : "Already aligned.",
    );
    return;
  }

  postAlignResult(moved, skipped, warning);
};
