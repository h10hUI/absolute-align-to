// Absolute Align To — message shapes between the main thread and ui.html,
// plus the guards that validate anything arriving from the UI (spec §5.1, §8).
//
// The plugin boundary is untrusted input: payload fields stay `unknown` and are
// validated where they are consumed (handleAlign / handleDistribute). No `any`
// and no type assertions (CLAUDE.md).

export type LayerInfo = { id: string; name: string };

export type SelectionUpdatedMessage = {
  type: "selection-updated";
  layers: LayerInfo[];
  autoLayoutIds: string[];
  nonMovableIds: string[];
  // Whether every selected layer (key object included) shares one parent.
  // Distribute's pre-check (§9.2) needs only this boolean plus autoLayoutIds.
  sameParent: boolean;
};

export type AlignResultMessage = {
  type: "align-result";
  moved: number;
  skipped: { id: string; reason: string }[];
  warning?: string;
};

export type AlignErrorMessage = {
  type: "align-error";
  message: string;
};

// Same shape as AlignResultMessage (spec §5.1). A run-time refusal is reported
// as `moved: 0, skipped: [], warning: reason` so no extra message type is
// needed; the UI treats that combination as a refusal, not as "already
// distributed".
export type DistributeResultMessage = {
  type: "distribute-result";
  moved: number;
  skipped: { id: string; reason: string }[];
  warning?: string;
};

export type UiToMainMessage =
  | { type: "ui-ready" }
  | {
      type: "align";
      keyObjectId: unknown;
      direction: unknown;
      closeAfter: unknown;
    }
  | {
      type: "distribute";
      axis: unknown;
      keyObjectId: unknown;
      spacing: unknown;
      closeAfter: unknown;
    }
  | { type: "close" };

export const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;

// Per CLAUDE.md: no `any`; validate incoming messages with a type guard rather
// than a type assertion. Only the discriminant is checked structurally here.
// The payload fields stay `unknown` and are validated where they are consumed
// (keyObjectId / direction / axis / spacing are validated in
// handleAlign / handleDistribute).
export const isUiToMainMessage = (value: unknown): value is UiToMainMessage => {
  if (!isRecord(value)) return false;
  return (
    value.type === "ui-ready" ||
    value.type === "align" ||
    value.type === "distribute" ||
    value.type === "close"
  );
};

// `null` means "empty field" (automatic spacing). Anything else must be a
// finite, non-negative number; NaN / Infinity / negatives / wrong types are
// rejected BEFORE any computation (spec §8).
export const isValidSpacing = (value: unknown): value is number | null =>
  value === null ||
  (typeof value === "number" && Number.isFinite(value) && value >= 0);
