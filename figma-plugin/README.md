# designlang — Figma plugin

Pulls design tokens from any live website directly into Figma Variables.

Two entry points:

1. **From URL** — the plugin fetches `https://designlang.manavaryasingh.com/api/extract?format=figma&url=<url>` and imports the returned collections + variables.
2. **Paste JSON** — run `designlang <url>` locally and paste the resulting `<prefix>-figma-variables.json`.

## What it creates

- **Variables** — `Brand` (colour primitives, hidden from pickers via empty `scopes`), `Color` (semantic aliases onto Brand, same light/dark modes), `Typography` and `Spacing`. Every variable carries scopes and a `WEB` code syntax such as `var(--spacing-8)`.
- **Text styles** and **effect styles** (shadows) from the payload.
- Optionally a **Button** component set (tick the checkbox), with fills, padding and radius bound to variables.

Re-importing updates collections, variables and styles by name instead of duplicating them.

## Payload

`designlang` writes `*-figma-variables.json` with `version: 2`: `collections`, `textStyles`, `effectStyles`, `components` and `meta`. v1 payloads (`collections` only, formatter or per-mode shape) still import.

## Fonts

Figma cannot install fonts. If a brand font is not available the text style uses Inter (same weight where possible), and its description says `Brand font: X (fallback Inter)`. Install the font and re-import to switch it over.

## Development

`code.js` is generated from `src/figma/importer.js`. After changing the importer run `npm run build:figma-plugin`; never edit `code.js` by hand.

## Install (local dev)

1. Figma desktop → *Plugins* → *Development* → *Import plugin from manifest...*
2. Select `figma-plugin/manifest.json`.

## Publish

```bash
# after scoring the manifest + icons
# Community publishing is done through the Figma UI, not CLI.
```
