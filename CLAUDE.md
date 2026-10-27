# CLAUDE.md

This file provides guidance to Claude Code when working with this repository.

## Project Overview

**Absolute Align To** — a Figma plugin that aligns selected layers relative to a designated **key object**. It is a zero-based re-implementation of the classic "Align To" plugin, fixing coordinate-system issues that occur when selected layers belong to different parent frames.

The full design document lives at `spec/align-to-v2-design.md`. Consult it before making design-level decisions.

## Rules — always in effect

These are imported, so they are always loaded. Keep them short and imperative.

@.claude/rules/critical.md
@.claude/rules/ts-rules.md

## Scope

- Supported align directions: `left`, `right`, `top`, `bottom`, `centerH`, `centerV` (the basic 6).
- Not supported: distribute (even spacing), rotated layers / rotated frames.
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

### Edge cases

- Single layer selected: disable the align buttons.
- Auto Layout children: `x`/`y` writes are ignored or overridden by Auto Layout. **Skip** such layers and show a warning in the UI.
- Rotation: not supported (no guard for now). Treat `rotation !== 0` detection as a future extension point.

## Code Conventions

- Keep the alignment math (`computeTargetPosition`, `absoluteToRelative`) as Figma-API-independent helper functions at the top of `code.ts`.
- UI strings are English.
- Prefer explicit types (e.g. `AlignDirection`, `Rect`).
- The plugin needs no network access — keep `networkAccess.allowedDomains` as `["none"]` in `manifest.json`.

## Testing

No unit tests are configured. Verify behavior manually in the Figma editor (e.g. align layers that belong to different parent frames and confirm the positions match the key object).
