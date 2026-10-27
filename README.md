# Absolute Align To

A Figma plugin that aligns selected layers relative to a designated **key object**. It is a zero-based re-implementation of the classic [Align To](https://www.figma.com/community/plugin/742450159822269057/align-to) plugin, fixing the coordinate-system issues that occur when selected layers belong to different parent frames.

## Features

- Align selected layers **relative to a key object** in six directions:
  - Left / Right / Top / Bottom
  - Center H (horizontal center) / Center V (vertical center)
- Pick exactly one layer as the key object (radio-style selection).
- The key object stays fixed and is **always** excluded from the layers being moved.
- Works correctly when selected layers belong to **different parent frames**, because all alignment is computed in page-absolute space and converted back to parent-relative coordinates before writing `node.x` / `node.y`.

## Not supported

- Distribute (even spacing) — reserved for a future extension.
- Rotated layers / rotated frames.
- Auto Layout children — `x`/`y` writes are ignored by Auto Layout, so such layers are skipped with a UI warning.

## Usage

1. Select two or more layers on the canvas.
2. Open the plugin and choose one layer as the **key object**.
3. Click an align direction button. All other layers move so they align to the key object.

## Development

### Requirements

- Node.js / npm
- TypeScript

### Setup

```sh
npm install
```

### Build

The plugin is written in TypeScript and must be compiled to JavaScript before running in Figma. Run the watch task and it will regenerate the JavaScript on every save:

```sh
npm run watch
```

### Project structure

```
code.ts       main thread: selection monitoring, postMessage to/from UI, alignment math, invokes alignment
ui.html       inline JS: layer list rendering, key-object selection, direction button handlers
manifest.json
tsconfig.json
package.json
```

For the architecture and design details, see [`spec/align-to-v2-design.md`](spec/align-to-v2-design.md). For guidance on working in this repository with Claude Code, see [`CLAUDE.md`](CLAUDE.md).
