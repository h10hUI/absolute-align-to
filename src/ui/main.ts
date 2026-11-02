// Absolute Align To — UI script (bundled and inlined into ui.html).
//
// NOTE: The `data-direction` / `data-axis` values in index.html must stay in
// sync with `AlignDirection` / `DistributeAxis` in src/geometry.ts. Change both
// if you rename a value. The main thread validates the received value, so a
// mismatch surfaces an "align-error" instead of a silent no-op.
//
// The key object is NEVER auto-selected: spec §10 requires the user to click a
// layer, so the buttons stay disabled and #prompt explains why until a radio
// is chosen.

import { isRecord } from "../messages";
import type {
  AlignErrorMessage,
  AlignResultMessage,
  DistributeResultMessage,
  LayerInfo,
  SelectionUpdatedMessage,
  UiToMainMessage,
} from "../messages";

type IncomingMessage =
  | SelectionUpdatedMessage
  | AlignResultMessage
  | DistributeResultMessage
  | AlignErrorMessage;

type State = {
  keyObjectId: string | null;
  layers: LayerInfo[];
  autoLayoutIds: string[];
  nonMovableIds: string[];
  sameParent: boolean;
};

const state: State = {
  keyObjectId: null,
  layers: [],
  autoLayoutIds: [],
  nonMovableIds: [],
  sameParent: false,
};

const byId = <T extends HTMLElement>(id: string, ctor: new () => T): T => {
  const element = document.getElementById(id);
  if (!(element instanceof ctor)) {
    throw new Error(`#${id} is missing or has an unexpected element type`);
  }
  return element;
};

const countEl = byId("count", HTMLElement);
const layersEl = byId("layers", HTMLElement);
const emptyEl = byId("empty", HTMLElement);
const promptEl = byId("prompt", HTMLElement);
const statusEl = byId("status", HTMLElement);
const warningEl = byId("warning", HTMLElement);
const closeEl = byId("close", HTMLButtonElement);
const closeAfterEl = byId("close-after-input", HTMLInputElement);
const directionButtons =
  document.querySelectorAll<HTMLButtonElement>("#directions button");
const distributeButtons =
  document.querySelectorAll<HTMLButtonElement>("#space button");
const spacingEl = byId("spacing-input", HTMLInputElement);
const distributeHintEl = byId("distribute-hint", HTMLElement);
const spacingErrorEl = byId("spacing-error", HTMLElement);

const postToMain = (message: UiToMainMessage): void => {
  parent.postMessage({ pluginMessage: message }, "*");
};

const setStatus = (text: string): void => {
  statusEl.textContent = text;
  statusEl.hidden = !text;
};

const setWarning = (text: string): void => {
  warningEl.textContent = text;
  warningEl.hidden = !text;
};

const setSpacingError = (text: string): void => {
  spacingErrorEl.textContent = text;
  spacingErrorEl.hidden = !text;
};

const createBadge = (text: string, warn: boolean): HTMLSpanElement => {
  const badge = document.createElement("span");
  badge.className = warn ? "badge warn" : "badge";
  badge.textContent = text;
  return badge;
};

const render = (): void => {
  const previousScrollTop = layersEl.scrollTop;
  const listHadFocus = layersEl.contains(document.activeElement);

  countEl.textContent = String(state.layers.length);

  layersEl.replaceChildren();
  for (const layer of state.layers) {
    const li = document.createElement("li");
    const label = document.createElement("label");

    const radio = document.createElement("input");
    radio.type = "radio";
    radio.name = "keyObject";
    radio.value = layer.id;
    radio.checked = layer.id === state.keyObjectId;
    radio.addEventListener("change", () => {
      if (state.keyObjectId === layer.id) return;
      state.keyObjectId = layer.id;
      setStatus("");
      setWarning("");
      render();
    });

    const name = document.createElement("span");
    name.className = "name";
    name.textContent = layer.name;

    label.appendChild(radio);
    label.appendChild(name);

    if (layer.id === state.keyObjectId) {
      label.appendChild(createBadge("Key object", false));
    }
    if (state.autoLayoutIds.includes(layer.id)) {
      label.appendChild(createBadge("Auto Layout", true));
    }
    // Non-key layers that expose no x/y cannot be aligned directly. Flag them
    // so the user knows why "nothing moves".
    if (
      state.nonMovableIds.includes(layer.id) &&
      layer.id !== state.keyObjectId
    ) {
      label.appendChild(createBadge("Not movable", true));
    }

    li.appendChild(label);
    layersEl.appendChild(li);
  }

  const canAlign = state.layers.length >= 2 && state.keyObjectId !== null;
  for (const button of directionButtons) {
    button.disabled = !canAlign;
  }

  // Distribute pre-checks (§9.2). These are the conditions the UI can evaluate
  // without the skip rules. The run-time condition (fewer than two movable
  // layers after skipping) is decided by the main thread and cannot disable
  // the buttons here.
  //
  // Nothing is evaluated on an empty selection: #empty already explains the
  // state, and shareSameParent([]) is false, so the parent reason would be
  // pure noise.
  const distributeBlockers: string[] = [];
  if (state.layers.length > 0) {
    if (state.layers.length < 3) {
      distributeBlockers.push("Select 3 or more layers.");
    }
    if (state.keyObjectId === null) {
      distributeBlockers.push("Choose a key object.");
    }
    if (!state.sameParent) {
      distributeBlockers.push("All selected layers must share the same parent.");
    }
    if (state.autoLayoutIds.length > 0) {
      distributeBlockers.push("Auto Layout children are not supported.");
    }
  }
  const canDistribute =
    state.layers.length > 0 && distributeBlockers.length === 0;
  for (const button of distributeButtons) {
    button.disabled = !canDistribute;
  }
  spacingEl.disabled = !canDistribute;
  distributeHintEl.textContent = distributeBlockers.join(" ");
  // Hide when there is nothing to say; an empty section would still add the
  // flex gap between rows.
  distributeHintEl.hidden = distributeBlockers.length === 0;
  // A format error is meaningless once distribute cannot run.
  if (!canDistribute) setSpacingError("");

  emptyEl.hidden = state.layers.length >= 2;
  // Covers the "buttons disabled but nothing else is shown" case: 2+ layers
  // selected while no key object is designated (spec §9.2 asks us to prompt
  // the user to designate one).
  promptEl.hidden = !(state.layers.length >= 2 && state.keyObjectId === null);

  // Re-rendering replaces every <li>, which resets scroll position and drops
  // focus. Restore both so picking a key object in a long list does not jump
  // the view.
  layersEl.scrollTop = previousScrollTop;
  if (listHadFocus) {
    const checked = layersEl.querySelector<HTMLInputElement>(
      'input[name="keyObject"]:checked'
    );
    if (checked) checked.focus();
  }
};

for (const button of directionButtons) {
  button.addEventListener("click", () => {
    if (!state.keyObjectId) return;
    postToMain({
      type: "align",
      keyObjectId: state.keyObjectId,
      direction: button.dataset.direction,
      closeAfter: closeAfterEl.checked,
    });
  });
}

// Empty field = automatic spacing (`null`). Otherwise the value must be a
// non-negative number (decimals allowed); anything else is not sent.
const parseSpacing = (): { spacing: number | null } | null => {
  const raw = spacingEl.value.trim();
  if (raw === "") return { spacing: null };
  if (!/^\d+(\.\d+)?$/.test(raw)) return null;
  return { spacing: Number(raw) };
};

for (const button of distributeButtons) {
  button.addEventListener("click", () => {
    if (!state.keyObjectId) return;
    const parsed = parseSpacing();
    if (!parsed) {
      setSpacingError("Enter a number of px, or leave the field empty.");
      return;
    }
    setSpacingError("");
    postToMain({
      type: "distribute",
      axis: button.dataset.axis,
      keyObjectId: state.keyObjectId,
      spacing: parsed.spacing,
      closeAfter: closeAfterEl.checked,
    });
  });
}

spacingEl.addEventListener("input", () => {
  setSpacingError("");
});

// Shared rendering for align-result / distribute-result: same shape, different
// wording. `warningIsRejection` marks the distribute case where the main thread
// reports a run-time refusal as { moved: 0, skipped: [], warning: reason };
// that must not be shown as "already distributed".
const renderResult = (
  message: AlignResultMessage | DistributeResultMessage,
  doneText: (moved: number) => string,
  alreadyText: string,
  warningIsRejection: boolean
): void => {
  const { moved, skipped } = message;
  const warning = message.warning ?? "";
  const rejected =
    warningIsRejection && moved === 0 && skipped.length === 0 && warning !== "";

  if (moved > 0) {
    setStatus(doneText(moved));
  } else if (skipped.length === 0 && !rejected) {
    setStatus(alreadyText);
  } else {
    setStatus("");
  }

  const parts: string[] = [];
  if (skipped.length > 0) {
    const reasons = skipped.map((item) => item.reason).join(" / ");
    parts.push(`Skipped ${skipped.length} layer(s): ${reasons}`);
  }
  if (warning) parts.push(warning);
  setWarning(parts.join(" / "));
};

closeEl.addEventListener("click", () => {
  postToMain({ type: "close" });
});

const toStringArray = (value: unknown): string[] =>
  Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string")
    : [];

const toLayers = (value: unknown): LayerInfo[] => {
  const layers: LayerInfo[] = [];
  if (!Array.isArray(value)) return layers;
  for (const item of value) {
    if (isRecord(item) && typeof item.id === "string") {
      layers.push({
        id: item.id,
        name: typeof item.name === "string" ? item.name : "",
      });
    }
  }
  return layers;
};

const toSkipped = (value: unknown): { id: string; reason: string }[] => {
  const skipped: { id: string; reason: string }[] = [];
  if (!Array.isArray(value)) return skipped;
  for (const item of value) {
    if (isRecord(item)) {
      skipped.push({
        id: typeof item.id === "string" ? item.id : "",
        reason: typeof item.reason === "string" ? item.reason : "",
      });
    }
  }
  return skipped;
};

// The main thread is the only sender, but the boundary is still untrusted
// input: narrow `unknown` with guards instead of asserting a type.
const parseIncoming = (raw: unknown): IncomingMessage | null => {
  if (!isRecord(raw)) return null;

  if (raw.type === "selection-updated") {
    return {
      type: "selection-updated",
      layers: toLayers(raw.layers),
      autoLayoutIds: toStringArray(raw.autoLayoutIds),
      nonMovableIds: toStringArray(raw.nonMovableIds),
      sameParent: raw.sameParent === true,
    };
  }
  if (raw.type === "align-result" || raw.type === "distribute-result") {
    return {
      type: raw.type,
      moved: typeof raw.moved === "number" ? raw.moved : 0,
      skipped: toSkipped(raw.skipped),
      warning: typeof raw.warning === "string" ? raw.warning : undefined,
    };
  }
  if (raw.type === "align-error") {
    return {
      type: "align-error",
      message: typeof raw.message === "string" ? raw.message : "",
    };
  }
  return null;
};

window.onmessage = (event: MessageEvent<unknown>): void => {
  const data = event.data;
  const message = isRecord(data) ? parseIncoming(data.pluginMessage) : null;
  if (!message) return;

  if (message.type === "selection-updated") {
    const lostKeyObject =
      state.keyObjectId !== null &&
      !message.layers.some((layer) => layer.id === state.keyObjectId);

    state.layers = message.layers;
    state.autoLayoutIds = message.autoLayoutIds;
    state.nonMovableIds = message.nonMovableIds;
    state.sameParent = message.sameParent;

    if (lostKeyObject) {
      state.keyObjectId = null;
    }

    setStatus("");
    setSpacingError("");
    if (lostKeyObject) {
      // The Plugin API cannot lock canvas operations (deletion etc.), so this
      // is the only place we can detect it. Warn and let the user pick again —
      // never silently select another layer.
      setWarning(
        "The key object is no longer in the selection. Please choose a new one."
      );
    } else {
      setWarning("");
    }

    render();
    return;
  }

  if (message.type === "align-result") {
    renderResult(
      message,
      (moved) => `Aligned ${moved} layer(s).`,
      "Already aligned.",
      false
    );
    return;
  }

  if (message.type === "distribute-result") {
    renderResult(
      message,
      (moved) => `Distributed ${moved} layer(s).`,
      "Already distributed.",
      true
    );
    return;
  }

  setStatus("");
  setWarning(message.message || "Alignment failed.");
};

// Initial render so the direction buttons start disabled and the "select
// layers" hint is visible before the first snapshot arrives.
render();

postToMain({ type: "ui-ready" });
