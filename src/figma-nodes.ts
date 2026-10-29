// Absolute Align To — Figma-side node helpers.
//
// Everything here touches the Plugin API (SceneNode, absoluteBoundingBox, the
// parent chain). The pure coordinate math lives in `src/geometry.ts` and this
// module must not grow math of its own, so `geometry` never depends on Figma.

import type { Point } from "./geometry";

// Every SceneNode in the installed typings declares x/y, so this is a plain
// runtime check rather than a type guard (a guard would narrow the negative
// branch to `never`).
//
// Defensive check only: with the installed typings every SceneNode exposes x/y,
// so `nonMovableIds` in `selection-updated` is always empty in practice. It is
// kept (and typed) so a future node kind without x/y degrades to a warning
// instead of a crash; the UI branch for it is dormant by design.
export const isMovableNode = (node: SceneNode): boolean =>
  "x" in node && "y" in node;

export const getAbsoluteRect = (node: SceneNode): Rect | null => {
  const box = node.absoluteBoundingBox;
  if (!box) return null;
  return { x: box.x, y: box.y, width: box.width, height: box.height };
};

export const rectsEqual = (a: Rect, b: Rect): boolean =>
  a.x === b.x && a.y === b.y && a.width === b.width && a.height === b.height;

// Structural guards. They keep the checks independent of the exact node-type
// unions declared by the installed @figma/plugin-typings version.
export type NodeWithAbsoluteBox = BaseNode & {
  readonly absoluteBoundingBox: Rect | null;
};

export const hasAbsoluteBox = (node: BaseNode): node is NodeWithAbsoluteBox =>
  "absoluteBoundingBox" in node;

export type ContainerWithLayoutMode = BaseNode & { readonly layoutMode: string };

export const hasLayoutMode = (
  node: BaseNode,
): node is ContainerWithLayoutMode => "layoutMode" in node;

// A page-direct node is already expressed in page-space, so the page itself
// acts as a zero-origin parent.
export const PAGE_ORIGIN: Point = { x: 0, y: 0 };

// Sub-pixel tolerance for deciding whether a write actually moved a layer.
// Figma coordinates carry fractional precision, so tiny float noise must not
// be reported as a move.
//
// Kept here rather than in `src/geometry.ts` on purpose: the value is not part
// of the coordinate math — it is the tolerance for comparing two
// `absoluteBoundingBox` reads taken from the Figma document (§9.3 "moved の
// 数え方"). The pure functions never compare boxes.
export const POSITION_EPSILON = 0.001;

/**
 * Resolve the parent's absolute origin for the page -> parent-relative round
 * trip. After excluding PAGE / DOCUMENT, the remaining containers (frames,
 * groups, components, instances, sections, ...) expose absoluteBoundingBox.
 *
 * GROUP and BOOLEAN_OPERATION are not coordinate spaces: Figma expresses the
 * x/y of their children relative to the closest ancestor that is neither, so
 * those ancestors are skipped before the origin is read.
 *
 * handleAlign / handleDistribute re-read this right before each write so origin
 * shifts caused by earlier writes in the same batch are accounted for.
 */
export const getParentAbsoluteOrigin = (start: BaseNode | null): Point | null => {
  let parent = start;
  while (
    parent &&
    (parent.type === "GROUP" || parent.type === "BOOLEAN_OPERATION")
  ) {
    parent = parent.parent;
  }
  if (!parent) return null;
  if (parent.type === "PAGE" || parent.type === "DOCUMENT") return PAGE_ORIGIN;
  if (!hasAbsoluteBox(parent)) return null;
  const box = parent.absoluteBoundingBox;
  if (!box) return null;
  return { x: box.x, y: box.y };
};

/**
 * True when every selected layer (key object included) has the same parent,
 * compared by `parent.id`. Page-direct siblings share the PageNode, so they
 * count as the same parent (spec §9.2). A missing parent is a mismatch.
 */
export const shareSameParent = (nodes: readonly SceneNode[]): boolean => {
  if (nodes.length === 0) return false;
  const firstParent = nodes[0].parent;
  if (!firstParent) return false;
  return nodes.every(
    (node) => node.parent !== null && node.parent.id === firstParent.id,
  );
};

export type ContainerWithChildren = BaseNode & {
  readonly children: readonly SceneNode[];
};

export const hasChildren = (node: BaseNode): node is ContainerWithChildren =>
  "children" in node;

/**
 * Map of child id -> index within `parent.children` (layer panel order). Built
 * once per distribute run to tie-break equal axis positions (spec §9.4.1).
 */
export const getDocumentOrderIndex = (
  parent: BaseNode | null,
): Map<string, number> => {
  const order = new Map<string, number>();
  if (!parent || !hasChildren(parent)) return order;
  parent.children.forEach((child, index) => {
    order.set(child.id, index);
  });
  return order;
};

// Auto Layout parents (layoutMode HORIZONTAL / VERTICAL / GRID) manage their children; direct x/y writes are ignored or
// overridden. Skip such children and surface a warning (spec §9.2). Members
// with layoutPositioning === "ABSOLUTE" could technically move, but this
// version conservatively skips every Auto Layout child.
export const isAutoLayoutChild = (node: SceneNode): boolean => {
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
export const isAncestorOf = (candidate: SceneNode, node: SceneNode): boolean => {
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
export const isChildDerivedBoxNode = (node: BaseNode): boolean =>
  node.type === "GROUP" ||
  node.type === "BOOLEAN_OPERATION" ||
  node.type === "COMPONENT_SET";

/**
 * Distance from the page (0 for page-direct nodes, larger for deeper nodes).
 * Used to write ancestors before their descendants.
 */
export const getNodeDepth = (node: SceneNode): number => {
  let depth = 0;
  let current: BaseNode | null = node.parent;
  while (current) {
    depth += 1;
    current = current.parent;
  }
  return depth;
};

export type SkippedLayer = { id: string; reason: string };

export type MovingLayer = { node: SceneNode; originalRect: Rect };

/**
 * Pass 1 skip rules shared by align and distribute (spec §9.3). Read only:
 * returns the layers that can be moved (with their ORIGINAL absolute rect) and
 * a reason for every selected layer that is left out. The key object is always
 * excluded.
 */
export const planMovingLayers = (
  selection: readonly SceneNode[],
  keyNode: SceneNode,
): { moving: MovingLayer[]; skipped: SkippedLayer[] } => {
  const moving: MovingLayer[] = [];
  const skipped: SkippedLayer[] = [];
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
    const originalRect = getAbsoluteRect(node);
    if (!originalRect) {
      skipped.push({ id: node.id, reason: `${node.name}: no bounding box` });
      continue;
    }
    moving.push({ node, originalRect });
  }

  return { moving, skipped };
};
