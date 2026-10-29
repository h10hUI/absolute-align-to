// Absolute Align To — pure alignment / distribute math.
//
// No Figma API dependency (spec §7): the Figma side reads
// `absoluteBoundingBox`, converts it to a plain `Rect`, and passes it here.
// Everything is computed in page-absolute space (spec §4). Converting back to
// parent-relative coordinates is `absoluteToRelative`'s job and happens at
// write time in `src/align.ts` / `src/distribute.ts`.
//
// `Rect` ({ x, y, width, height }) is declared globally by @figma/plugin-typings
// with the same shape the spec (§8) defines, so it is reused instead of
// redeclared (a second declaration is a duplicate-identifier error).

export type AlignDirection = "left" | "right" | "top" | "bottom" | "centerH" | "centerV";

export type Point = {
  x: number;
  y: number;
};

export const ALIGN_DIRECTIONS: readonly AlignDirection[] = [
  "left",
  "right",
  "top",
  "bottom",
  "centerH",
  "centerV",
];

// No cast needed: `value` is narrowed to string first, and AlignDirection is a
// subtype of string, so the comparison type-checks as-is.
export const isAlignDirection = (value: unknown): value is AlignDirection =>
  typeof value === "string" &&
  ALIGN_DIRECTIONS.some((direction) => direction === value);

/**
 * Compute the new absolute (page-space) top-left position for a moving layer
 * so it aligns to the key object in the given direction.
 * The non-aligned axis keeps its original value.
 */
export const computeTargetPosition = (
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
 * not a value captured earlier — see handleAlign / handleDistribute.
 *
 * Rotation and scaling are unsupported (spec §4), so the parent's axes are
 * aligned with page-space and the offset between origins is a simple
 * subtraction.
 */
export const absoluteToRelative = (
  absolutePos: Point,
  parentAbsoluteOrigin: Point,
): Point => ({
  x: absolutePos.x - parentAbsoluteOrigin.x,
  y: absolutePos.y - parentAbsoluteOrigin.y,
});

export type DistributeAxis = "horizontal" | "vertical";

export const DISTRIBUTE_AXES: readonly DistributeAxis[] = ["horizontal", "vertical"];

export const isDistributeAxis = (value: unknown): value is DistributeAxis =>
  typeof value === "string" &&
  DISTRIBUTE_AXES.some((axis) => axis === value);

// The axis ordering (tie-break) needs `parent.children`, so it stays on the
// Figma side (`src/distribute.ts`); the pure function receives the
// already-ordered items.
export type DistributeItem = { id: string; rect: Rect };

export const axisStart = (rect: Rect, axis: DistributeAxis): number =>
  axis === "horizontal" ? rect.x : rect.y;

export const axisEnd = (rect: Rect, axis: DistributeAxis): number =>
  axis === "horizontal" ? rect.x + rect.width : rect.y + rect.height;

export const axisSize = (rect: Rect, axis: DistributeAxis): number =>
  axis === "horizontal" ? rect.width : rect.height;

/**
 * Mean of the existing gaps (next.start - previous.end) of the ordered items.
 * Negative when the original layout overlaps; the caller rejects that case
 * because placing items with a negative gap can reverse their order.
 */
export const computeAutomaticGap = (
  axis: DistributeAxis,
  orderedItems: readonly DistributeItem[],
): number => {
  let totalGap = 0;
  for (let i = 1; i < orderedItems.length; i += 1) {
    totalGap +=
      axisStart(orderedItems[i].rect, axis) -
      axisEnd(orderedItems[i - 1].rect, axis);
  }
  return totalGap / (orderedItems.length - 1);
};

/**
 * Compute the new page-space top-left position for every moving item (spec
 * §9.4). `orderedItems` MUST already be ordered by axis start (tie-broken by
 * document order) and MUST include the key object. The key object is the fixed
 * anchor and is never present in the returned map.
 *
 * `spacing === null` means automatic: the mean of the existing gaps (§9.4.3).
 * The main thread rejects a negative mean before calling this. An explicit
 * spacing is used verbatim — no rounding, zero allowed (§9.4.4).
 *
 * Defensive only: fewer than three items or a missing key object yields an
 * empty map instead of throwing; the main thread rejects those cases before
 * calling this.
 */
export const computeDistributedPositions = (
  axis: DistributeAxis,
  orderedItems: readonly DistributeItem[],
  keyObjectId: string,
  spacing: number | null,
): Map<string, Point> => {
  const positions = new Map<string, Point>();
  const keyIndex = orderedItems.findIndex((item) => item.id === keyObjectId);
  if (keyIndex < 0 || orderedItems.length < 3) return positions;

  const keyRect = orderedItems[keyIndex].rect;
  const keyStart = axisStart(keyRect, axis);
  const keyEnd = axisEnd(keyRect, axis);

  const gap = spacing === null ? computeAutomaticGap(axis, orderedItems) : spacing;

  // Place each side outward from the fixed key object, so the key object's
  // position never changes (§9.4.2). Widths are per item, not assumed equal.
  const starts = new Map<string, number>();

  let forward = keyEnd + gap;
  for (let i = keyIndex + 1; i < orderedItems.length; i += 1) {
    const item = orderedItems[i];
    starts.set(item.id, forward);
    forward += axisSize(item.rect, axis) + gap;
  }

  let backward = keyStart - gap;
  for (let i = keyIndex - 1; i >= 0; i -= 1) {
    const item = orderedItems[i];
    backward -= axisSize(item.rect, axis);
    starts.set(item.id, backward);
    backward -= gap;
  }

  for (const item of orderedItems) {
    if (item.id === keyObjectId) continue;
    const start = starts.get(item.id);
    if (start === undefined) continue;
    positions.set(
      item.id,
      axis === "horizontal"
        ? { x: start, y: item.rect.y }
        : { x: item.rect.x, y: start },
    );
  }

  return positions;
};
