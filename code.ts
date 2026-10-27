// Absolute Align To — main thread.
// Aligns selected layers relative to a designated key object.
// See spec/align-to-v2-design.md for the design.
//
// NOTE: manifest.json uses documentAccess: "dynamic-page", so the synchronous
// `figma.getNodeById` is unavailable. The key object is resolved by scanning
// `figma.currentPage.selection`.
//
// NOTE: Rotation is intentionally unsupported in this version (spec §4).
// `rotation !== 0` detection is a future extension point.

// ---------------------------------------------------------------------------
// Pure alignment math (no Figma API dependency)
// ---------------------------------------------------------------------------

type AlignDirection = "left" | "right" | "top" | "bottom" | "centerH" | "centerV";

// `Rect` ({ x, y, width, height }) is declared globally by @figma/plugin-typings
// with the same shape the spec (§8) defines, so it is reused instead of
// redeclared (a second declaration is a duplicate-identifier error).

type Point = {
  x: number;
  y: number;
};

const ALIGN_DIRECTIONS: readonly AlignDirection[] = [
  "left",
  "right",
  "top",
  "bottom",
  "centerH",
  "centerV",
];

// No cast needed: `value` is narrowed to string first, and AlignDirection is a
// subtype of string, so the comparison type-checks as-is.
const isAlignDirection = (value: unknown): value is AlignDirection =>
  typeof value === "string" &&
  ALIGN_DIRECTIONS.some((direction) => direction === value);

/**
 * Compute the new absolute (page-space) top-left position for a moving layer
 * so it aligns to the key object in the given direction.
 * The non-aligned axis keeps its original value.
 */
const computeTargetPosition = (
  keyObjectBox: Rect,
  movingBox: Rect,
  direction: AlignDirection,
): Point => {
  switch (direction) {
    case "left":
      return { x: keyObjectBox.x, y: movingBox.y };
    case "right":
      return {
        x: keyObjectBox.x + keyObjectBox.width - movingBox.width,
        y: movingBox.y,
      };
    case "top":
      return { x: movingBox.x, y: keyObjectBox.y };
    case "bottom":
      return {
        x: movingBox.x,
        y: keyObjectBox.y + keyObjectBox.height - movingBox.height,
      };
    case "centerH":
      return {
        x: keyObjectBox.x + (keyObjectBox.width - movingBox.width) / 2,
        y: movingBox.y,
      };
    case "centerV":
      return {
        x: movingBox.x,
        y: keyObjectBox.y + (keyObjectBox.height - movingBox.height) / 2,
      };
  }
};

/**
 * Convert a page-space absolute position into the parent's relative
 * coordinate space (spec §4, §8; CLAUDE.md).
 *
 * Only the parent's absolute ORIGIN participates in the conversion, so this
 * takes a Point instead of the full Rect shown in spec §8 (width/height would
 * be unused). Callers MUST pass the origin read at the moment of the write,
 * not a value captured earlier — see handleAlign.
 *
 * Rotation and scaling are unsupported (spec §4), so the parent's axes are
 * aligned with page-space and the offset between origins is a simple
 * subtraction.
 */
const absoluteToRelative = (
  absolutePos: Point,
  parentAbsoluteOrigin: Point,
): Point => ({
  x: absolutePos.x - parentAbsoluteOrigin.x,
  y: absolutePos.y - parentAbsoluteOrigin.y,
});

// ---------------------------------------------------------------------------
// Figma-side helpers
// ---------------------------------------------------------------------------

// Every SceneNode in the installed typings declares x/y, so this is a plain
// runtime check rather than a type guard (a guard would narrow the negative
// branch to `never`).
//
// Defensive check only: with the installed typings every SceneNode exposes x/y,
// so `nonMovableIds` in `selection-updated` is always empty in practice. It is
// kept (and typed) so a future node kind without x/y degrades to a warning
// instead of a crash; the UI branch for it is dormant by design.
const isMovableNode = (node: SceneNode): boolean =>
  "x" in node && "y" in node;

const getAbsoluteRect = (node: SceneNode): Rect | null => {
  const box = node.absoluteBoundingBox;
  if (!box) return null;
  return { x: box.x, y: box.y, width: box.width, height: box.height };
};

const rectsEqual = (a: Rect, b: Rect): boolean =>
  a.x === b.x && a.y === b.y && a.width === b.width && a.height === b.height;

// Structural guards. They keep the checks independent of the exact node-type
// unions declared by the installed @figma/plugin-typings version.
type NodeWithAbsoluteBox = BaseNode & {
  readonly absoluteBoundingBox: Rect | null;
};

const hasAbsoluteBox = (node: BaseNode): node is NodeWithAbsoluteBox =>
  "absoluteBoundingBox" in node;

type ContainerWithLayoutMode = BaseNode & { readonly layoutMode: string };

const hasLayoutMode = (node: BaseNode): node is ContainerWithLayoutMode =>
  "layoutMode" in node;

// A page-direct node is already expressed in page-space, so the page itself
// acts as a zero-origin parent.
const PAGE_ORIGIN: Point = { x: 0, y: 0 };

// Sub-pixel tolerance for deciding whether a write actually moved a layer.
// Figma coordinates carry fractional precision, so tiny float noise must not
// be reported as a move.
const POSITION_EPSILON = 0.001;

/**
 * Resolve the parent's absolute origin for the page -> parent-relative round
 * trip. After excluding PAGE / DOCUMENT, the remaining containers (frames,
 * groups, components, instances, sections, ...) expose absoluteBoundingBox.
 *
 * handleAlign re-reads this right before each write so origin shifts caused by
 * earlier writes in the same batch are accounted for.
 */
const getParentAbsoluteOrigin = (parent: BaseNode | null): Point | null => {
  if (!parent) return null;
  if (parent.type === "PAGE" || parent.type === "DOCUMENT") return PAGE_ORIGIN;
  if (!hasAbsoluteBox(parent)) return null;
  const box = parent.absoluteBoundingBox;
  if (!box) return null;
  return { x: box.x, y: box.y };
};

// Auto Layout parents (layoutMode HORIZONTAL / VERTICAL / GRID) manage their children; direct x/y writes are ignored or
// overridden. Skip such children and surface a warning (spec §9.2). Members
// with layoutPositioning === "ABSOLUTE" could technically move, but this
// version conservatively skips every Auto Layout child.
const isAutoLayoutChild = (node: SceneNode): boolean => {
  const parent = node.parent;
  if (!parent) return false;
  if (!hasLayoutMode(parent)) return false;
  return parent.layoutMode !== "NONE";
};

/**
 * True when `candidate` is an ancestor of `node`. Used both to keep the key
 * object fixed (moving an ancestor would carry the key object with it) and,
 * with the arguments swapped, to detect descendants of the key object.
 */
const isAncestorOf = (candidate: SceneNode, node: SceneNode): boolean => {
  let current: BaseNode | null = node.parent;
  while (current) {
    if (current.id === candidate.id) return true;
    current = current.parent;
  }
  return false;
};

/**
 * Nodes whose absoluteBoundingBox is computed from their descendants' bounds,
 * so moving a descendant changes the node's own box (size and/or origin).
 * GROUP, BOOLEAN_OPERATION and COMPONENT_SET are the cases we handle: moving a
 * variant inside a component set repositions/resizes the set's box. A FRAME has
 * an explicit size and does NOT resize when its children move (auto-layout
 * frames resize, but their children are already skipped as Auto Layout
 * children), so children of a FRAME remain valid move targets.
 * INSTANCE is deliberately absent: its box follows the main component's size,
 * and direct x/y writes on instance children throw, so those failures are
 * surfaced as skips instead.
 */
const isChildDerivedBoxNode = (node: BaseNode): boolean =>
  node.type === "GROUP" ||
  node.type === "BOOLEAN_OPERATION" ||
  node.type === "COMPONENT_SET";

/**
 * Distance from the page (0 for page-direct nodes, larger for deeper nodes).
 * Used to write ancestors before their descendants.
 */
const getNodeDepth = (node: SceneNode): number => {
  let depth = 0;
  let current: BaseNode | null = node.parent;
  while (current) {
    depth += 1;
    current = current.parent;
  }
  return depth;
};

// ---------------------------------------------------------------------------
// Messaging types & guards
// ---------------------------------------------------------------------------

type LayerInfo = { id: string; name: string };

type SelectionUpdatedMessage = {
  type: "selection-updated";
  layers: LayerInfo[];
  autoLayoutIds: string[];
  nonMovableIds: string[];
};

type AlignResultMessage = {
  type: "align-result";
  moved: number;
  skipped: { id: string; reason: string }[];
  warning?: string;
};

type AlignErrorMessage = {
  type: "align-error";
  message: string;
};

type UiToMainMessage =
  | { type: "ui-ready" }
  | {
      type: "align";
      keyObjectId: unknown;
      direction: unknown;
      closeAfter: unknown;
    }
  | { type: "close" };

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;

// Per CLAUDE.md: no `any`; validate incoming messages with a type guard rather
// than a type assertion. Only the discriminant is checked structurally here.
// The payload fields stay `unknown` and are validated where they are consumed
// (keyObjectId / direction are validated in handleAlign).
const isUiToMainMessage = (value: unknown): value is UiToMainMessage => {
  if (!isRecord(value)) return false;
  return (
    value.type === "ui-ready" ||
    value.type === "align" ||
    value.type === "close"
  );
};

const postAlignResult = (
  moved: number,
  skipped: { id: string; reason: string }[],
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

// ---------------------------------------------------------------------------
// Selection snapshot
// ---------------------------------------------------------------------------

const sendSelectionUpdate = (): void => {
  const selection = figma.currentPage.selection;
  const message: SelectionUpdatedMessage = {
    type: "selection-updated",
    layers: selection.map((node) => ({ id: node.id, name: node.name })),
    autoLayoutIds: selection.filter(isAutoLayoutChild).map((node) => node.id),
    nonMovableIds: selection
      .filter((node) => !isMovableNode(node))
      .map((node) => node.id),
  };
  figma.ui.postMessage(message);
};

// ---------------------------------------------------------------------------
// Align executor
// ---------------------------------------------------------------------------
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

const handleAlign = (
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
  type PlannedMove = { node: SceneNode; originalRect: Rect; depth: number };
  const planned: PlannedMove[] = [];
  const skipped: { id: string; reason: string }[] = [];
  const keyIsChildDerived = isChildDerivedBoxNode(keyNode);

  for (const node of selection) {
    if (node.id === keyNode.id) continue; // the key object never moves

    if (isAncestorOf(node, keyNode)) {
      // Moving an ancestor would drag the key object along with it, breaking
      // the rule that the key object stays fixed (spec §9.1). Skip it.
      skipped.push({
        id: node.id,
        reason: `${node.name}: contains the key object — skipped`,
      });
      continue;
    }

    // If the key object's box is derived from its descendants (GROUP, boolean
    // op), moving one of those descendants changes the key object's own box —
    // breaking "key object stays fixed" and invalidating the reference rect.
    // Skip descendants in that case. A FRAME's box does not depend on its
    // children, so frame children stay movable (aligning a child to the frame's
    // edge must keep working).
    if (keyIsChildDerived && isAncestorOf(keyNode, node)) {
      skipped.push({
        id: node.id,
        reason: `${node.name}: inside the key object — skipped`,
      });
      continue;
    }

    if (!isMovableNode(node)) {
      // Defensive guard for nodes without x/y. GROUP does expose x/y in the
      // plugin API, so groups are moved like any other node.
      skipped.push({
        id: node.id,
        reason: `${node.name}: cannot be moved directly — skipped`,
      });
      continue;
    }
    if (isAutoLayoutChild(node)) {
      skipped.push({
        id: node.id,
        reason: `${node.name}: Auto Layout child — skipped`,
      });
      continue;
    }
    const movingRect = getAbsoluteRect(node);
    if (!movingRect) {
      skipped.push({ id: node.id, reason: `${node.name}: no bounding box` });
      continue;
    }
    planned.push({ node, originalRect: movingRect, depth: getNodeDepth(node) });
  }

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

// ---------------------------------------------------------------------------
// Bootstrap
// ---------------------------------------------------------------------------

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
    case "close":
      figma.closePlugin();
      return;
  }
};
