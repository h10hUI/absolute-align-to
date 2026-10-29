// Absolute Align To — distribute executor.
//
// Same coordinate path as handleAlign: targets are computed ONCE in page space,
// then each write re-reads the parent's absolute origin and converts back with
// absoluteToRelative. No depth sort here: the same-parent constraint means no
// moving layer can be an ancestor of another (spec §9.4.6).
//
// Every refusal is decided BEFORE any computation or write (§5.1, §9.2) and is
// reported as `moved: 0, skipped, warning: reason`.

import {
  absoluteToRelative,
  axisStart,
  computeAutomaticGap,
  computeDistributedPositions,
  isDistributeAxis,
} from "./geometry";
import type { DistributeItem } from "./geometry";
import {
  getAbsoluteRect,
  getDocumentOrderIndex,
  getParentAbsoluteOrigin,
  isAutoLayoutChild,
  planMovingLayers,
  POSITION_EPSILON,
  rectsEqual,
  shareSameParent,
} from "./figma-nodes";
import type { SkippedLayer } from "./figma-nodes";
import { isValidSpacing } from "./messages";
import type { DistributeResultMessage } from "./messages";

const postDistributeResult = (
  moved: number,
  skipped: SkippedLayer[],
  warning?: string,
): void => {
  const message: DistributeResultMessage = {
    type: "distribute-result",
    moved,
    skipped,
  };
  if (warning) message.warning = warning;
  figma.ui.postMessage(message);
};

export const handleDistribute = (
  rawAxis: unknown,
  rawKeyObjectId: unknown,
  rawSpacing: unknown,
  rawCloseAfter: unknown,
): void => {
  // Only an explicit `true` opts in to closing.
  const closeAfter = rawCloseAfter === true;

  if (!isDistributeAxis(rawAxis)) {
    postDistributeResult(0, [], "Unknown distribute axis.");
    return;
  }
  const axis = rawAxis;

  if (typeof rawKeyObjectId !== "string" || rawKeyObjectId.length === 0) {
    postDistributeResult(0, [], "No key object selected.");
    return;
  }
  const keyObjectId = rawKeyObjectId;

  if (!isValidSpacing(rawSpacing)) {
    postDistributeResult(
      0,
      [],
      "Spacing must be empty or a non-negative number.",
    );
    return;
  }
  const spacing = rawSpacing;

  const selection = figma.currentPage.selection;

  // Double guard: the UI also disables the buttons in these cases.
  if (selection.length < 3) {
    postDistributeResult(0, [], "Select 3 or more layers to distribute.");
    return;
  }

  const keyNode = selection.find((node) => node.id === keyObjectId);
  if (!keyNode) {
    postDistributeResult(0, [], "The key object is no longer in the selection.");
    return;
  }

  if (!shareSameParent(selection)) {
    postDistributeResult(
      0,
      [],
      "All selected layers must share the same parent.",
    );
    return;
  }

  if (selection.some(isAutoLayoutChild)) {
    postDistributeResult(
      0,
      [],
      "Auto Layout children cannot be distributed.",
    );
    return;
  }

  const keyRect = getAbsoluteRect(keyNode);
  if (!keyRect) {
    postDistributeResult(0, [], "The key object has no bounding box.");
    return;
  }

  // Skip rules shared with align's Pass 1 (§9.3). Skipped layers take part in
  // neither the ordering nor the spacing (§9.4.5).
  const { moving, skipped } = planMovingLayers(selection, keyNode);

  // Run-time condition (§9.2): only known after the skip rules, so it cannot be
  // a UI disable. Nothing has been computed or written yet.
  if (moving.length < 2) {
    postDistributeResult(
      0,
      skipped,
      "Distribute needs at least 2 movable layers after skipping.",
    );
    return;
  }

  // §9.4.1: axis start ascending, ties broken by document order.
  const orderIndex = getDocumentOrderIndex(keyNode.parent);
  const getOrder = (id: string): number => {
    const index = orderIndex.get(id);
    return index === undefined ? Number.MAX_SAFE_INTEGER : index;
  };

  const orderedItems: DistributeItem[] = [
    { id: keyNode.id, rect: keyRect },
    ...moving.map((item) => ({ id: item.node.id, rect: item.originalRect })),
  ];
  orderedItems.sort((a, b) => {
    const delta = axisStart(a.rect, axis) - axisStart(b.rect, axis);
    if (delta !== 0) return delta;
    return getOrder(a.id) - getOrder(b.id);
  });

  // Resolve the automatic gap once: the same value drives the overlap check and
  // the placement. Overlapping layers give a negative mean gap, which can
  // reverse the order. Reject before any write.
  const gap = spacing === null ? computeAutomaticGap(axis, orderedItems) : spacing;
  if (spacing === null && gap < 0) {
    postDistributeResult(
      0,
      skipped,
      "Layers overlap, so automatic spacing is not possible. Enter a spacing value.",
    );
    return;
  }

  const targets = computeDistributedPositions(
    axis,
    orderedItems,
    keyObjectId,
    gap,
  );
  const movingById = new Map<string, SceneNode>();
  for (const item of moving) {
    movingById.set(item.node.id, item.node);
  }

  // Pass 2 (write only). Targets are fixed now: the key object cannot move, so
  // recomputing would only risk drift (§9.4.6). The key box is still re-read to
  // DETECT a change, never to recompute.
  let moved = 0;
  let keyRectChanged = false;

  for (const item of orderedItems) {
    if (item.id === keyNode.id) continue;
    const node = movingById.get(item.id);
    const target = targets.get(item.id);
    if (!node || !target) continue;

    try {
      const freshKeyRect = getAbsoluteRect(keyNode);
      if (freshKeyRect && !rectsEqual(freshKeyRect, keyRect)) {
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
      const relative = absoluteToRelative(target, parentOrigin);
      node.x = relative.x;
      node.y = relative.y;
      const writtenRect = getAbsoluteRect(node);
      if (
        !writtenRect ||
        Math.abs(writtenRect.x - item.rect.x) > POSITION_EPSILON ||
        Math.abs(writtenRect.y - item.rect.y) > POSITION_EPSILON
      ) {
        moved += 1;
      }
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      skipped.push({ id: node.id, reason: `${node.name}: ${detail}` });
    }
  }

  // The in-loop checks run before each write, so a change caused by the LAST
  // write would otherwise go unnoticed.
  const finalKeyRect = getAbsoluteRect(keyNode);
  if (finalKeyRect && !rectsEqual(finalKeyRect, keyRect)) {
    keyRectChanged = true;
  }

  // Under the same-parent constraint siblings keep their absolute positions
  // when a container reflows (§9.4.6), so this is effectively unreachable. It
  // stays as a safety net in case that constraint is ever relaxed.
  const warning = keyRectChanged
    ? "The key object's box changed during distribution (a shared container reflowed). Verify the result."
    : undefined;

  if (closeAfter && skipped.length === 0 && !warning) {
    figma.closePlugin(
      moved > 0
        ? `Distributed ${moved} layer${moved === 1 ? "" : "s"}.`
        : "Already distributed.",
    );
    return;
  }

  postDistributeResult(moved, skipped, warning);
};
