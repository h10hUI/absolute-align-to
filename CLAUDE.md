# CLAUDE.md

This file provides guidance to Claude Code when working with this repository.

## Project Overview

**Absolute Align To** — a Figma plugin that aligns selected layers relative to a designated **key object**. It is a zero-based re-implementation of the classic "Align To" plugin, fixing coordinate-system issues that occur when selected layers belong to different parent frames.

The full design document lives at `spec/align-to-v2-design.md`. Consult it before making design-level decisions.

## Rules — always in effect

These are imported, so they are always loaded. Keep them short and imperative.

@.claude/rules/critical.md
@.claude/rules/ts-rules.md
@.claude/rules/figma-rules.md

## Scope

- Supported align directions: `left`, `right`, `top`, `bottom`, `centerH`, `centerV` (the basic 6).
- Planned, **not implemented yet** (the docs land before the code): distribute — `Space H` / `Space V` buttons that space layers evenly relative to the key object, with an optional `px` gap (empty input = automatic spacing). Needs **three or more** selected layers, one shared parent node for every selected layer (key object included), and no selected layer being an Auto Layout child.
- Not supported: rotated layers / rotated frames (distribute included).
- UI language: English.
- Editor: `figma` only (`editorType: ["figma"]`).

## Tech Stack

- TypeScript
- Figma Plugin API (`api: "1.0.0"`)
- Custom UI (`ui.html` with inline JS)

## File Structure

```
code.ts       main thread: selection monitoring, postMessage to/from UI, alignment math, invokes alignment
ui.html       inline JS: layer list rendering, key-object selection, direction button handlers
manifest.json
tsconfig.json
package.json
```

## Architecture / Key Rules

### Coordinate handling (core design)

Do **not** read/write `node.x` / `node.y` naively across different frames — this is the bug the old plugin suffered from. Always:

1. Read each node's `absoluteBoundingBox` (page-space absolute coords).
2. Compute the new absolute coords using the key object's box.
3. Convert back to parent-relative coords using the **parent's** `absoluteBoundingBox`.
4. Write to `node.x` / `node.y`.

All calculations happen in page-absolute space, so alignment works correctly regardless of which frame a layer belongs to. Rotation is not supported, so matrix math is unnecessary.

### Key object

- Exactly one layer is the key object (radio-style selection in the UI).
- The key object stays fixed; it is **always** excluded from the set of layers being moved.
- If the key object is deleted or deselected, detect it, show a warning in the UI, and prompt the user to re-select. (The Plugin API cannot lock canvas operations such as deletion.)

### Distribute spacing (`Space H` / `Space V`) — planned

- Same coordinate rules as align: compute in page-absolute space, convert back with the parent's absolute origin, then write `node.x` / `node.y`. No shortcuts, even though every selected layer shares one parent.
- The key object stays fixed and is always excluded from the layers being moved.
- Validity is judged in two stages. **Before the click (UI can evaluate):** every selected layer (key object included) must share the **same parent node**, no selected layer may be an Auto Layout child, and at least three layers must be selected — disable the buttons and input in these cases. **At run time (only known after the skip rules):** fewer than two effective moving layers disables distribute — the main thread must reject it **before computing or writing anything** and return the reason.
- "Same parent node", not "same frame": layers nested in different groups inside one frame have different parents and are rejected; layers directly under the page share `PageNode` and are allowed. Selecting across multiple frames is a subset of "different parents".
- Disabled entirely (not "skip and continue") when invalid. Dropping layers would produce spacing that does not match what the user selected — that is the reason, not that the math breaks.
- No exception for a key object that is an Auto Layout child: under the same-parent rule, if any moving layer is an Auto Layout child then every selected layer — key object included — is a child of that same Auto Layout parent, so an exception would never be reachable.
- Implement as a Figma-API-independent pure helper next to the align helpers, reusing `absoluteToRelative`. `Space H` / `Space V` are UI labels, not type names.
- Parent reflow (GROUP and friends derive bounds from children) is not covered by the key-box change detection; do not claim it is. See `spec/align-to-v2-design.md` §4 and §9.4.
- Placement, tie-break, the key object's anchor role, the empty-input meaning and validation ownership are settled in `spec/align-to-v2-design.md` §9.4.

### Edge cases

- Single layer selected: disable the align buttons.
- Auto Layout children: `x`/`y` writes are ignored or overridden by Auto Layout. **Skip** such layers and show a warning in the UI — for align.
- Distribute validity (fewer than three layers, different parents, Auto Layout children): disable `Space H` / `Space V` and show the reason in the UI. Align stays available.
- Rotation: not supported (no guard for now). Treat `rotation !== 0` detection as a future extension point.

## Code Conventions

- Keep the alignment math (`computeTargetPosition`, `absoluteToRelative`) as Figma-API-independent helper functions at the top of `code.ts`.
- Add the distribute math as another pure function alongside them, reusing `absoluteToRelative`. Align the identifiers (direction values, type and function names) with `spec/align-to-v2-design.md` §8 once they are settled there; until then, do not introduce concrete names of your own.
- UI strings are English.
- Prefer explicit types (e.g. `AlignDirection`, `Rect`).
- The plugin needs no network access — keep `networkAccess.allowedDomains` as `["none"]` in `manifest.json`.

## Testing

No unit tests are configured. Verify behavior manually in the Figma editor (e.g. align layers that belong to different parent frames and confirm the positions match the key object).
