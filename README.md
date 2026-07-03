# FlowBoard

A dependency-free **pan/zoom whiteboard** for cards (nodes) and connectors — vanilla JS, no build
step, no framework, **CSP-safe** (makes zero external requests, so it runs happily inside sandboxed
HTML artifacts, Electron, intranet pages, etc.).

**▶ Live demo:** https://palmarhealer.github.io/flowboard/

<sub>Files · Chat-style boards · flowcharts · mindmaps · migration plans · anything made of boxes and arrows.</sub>

---

## Features

- **Pan / zoom / fit** with an infinite dotted (or lined) grid that hides itself when zoomed out
- **Draggable cards** with optional grid snapping (toggle in the toolbar)
- **Connectors** with automatic edge routing, arrowheads, labels, dashed/dotted styles, colors
- **Draw connections** by dragging from a card's port; drop on empty space to spawn a linked card
- **Rich-text editing** inside cards (bold / italic / underline / lists / heading) — just click a card
- **Inspector panel** to restyle the selection — background, border, width, style, and edge look — with a **custom color picker (hex input + presets)**
- **Multi-select** via **Shift + drag** (marquee) or Shift + click; edit many cards at once
- **Undo / redo** (buttons + `Ctrl/⌘+Z`, `Ctrl/⌘+Shift+Z`)
- **Minimap** (click or drag to move the viewport)
- **Light / dark / auto** theming with a toggle
- **`toJSON()` / `fromJSON()`** for save & restore
- **Tabler icons** inlined (MIT)

---

## Quick start (one line)

Add a single script — the stylesheet is injected automatically:

```html
<div id="app" style="position:fixed; inset:0"></div>

<script src="https://cdn.jsdelivr.net/gh/PalmarHealer/flowboard@v1.0.0/dist/flowboard.auto.js"></script>
<script>
  const board = new FlowBoard('#app', { theme: 'auto', minimap: true });
  board.setNodes([
    { id: 'a', x: 40,  y: 40, title: 'Idea',  body: 'Click to edit me', variant: 'accent' },
    { id: 'b', x: 380, y: 40, title: 'Next',  body: 'Drag a port to connect' }
  ]);
  board.setEdges([{ from: 'a', to: 'b', dir: 'h', arrow: true, label: 'then' }]);
  board.fit();
</script>
```

> The container needs a real size (e.g. `position:fixed; inset:0`, or any element with width & height).
> Pin a version (`@v1.0.0`) for stability, or use `@1` to follow the latest v1 release.

### Alternative: load the two files separately

```html
<link rel="stylesheet" href="https://cdn.jsdelivr.net/gh/PalmarHealer/flowboard@v1.0.0/dist/flowboard.css">
<script src="https://cdn.jsdelivr.net/gh/PalmarHealer/flowboard@v1.0.0/dist/flowboard.js"></script>
```

---

## Controls

| Action | Result |
|---|---|
| Drag background | pan · **Mouse wheel** = zoom |
| Drag a card | move it (multiple selected move together) |
| **Click** a card | edit its text (rich-text). Click the title to rename. **Esc** to finish |
| Drag a card's **port** | draw a connection; drop on a card to link, or on empty space to create a linked card |
| Click a card / connection | select it → the **inspector** (top-right) shows style options |
| **Shift + drag** on empty space | rubber-band multi-select · **Shift + click** = add/remove one |
| **Delete / Backspace** | remove the selection |
| **Ctrl/⌘ + Z** / **Ctrl/⌘ + Shift + Z** | undo / redo |
| Toolbar (top-right) | undo/redo · zoom · fit · grid-snap toggle · theme |
| Minimap (bottom-right) | click or drag to move the viewport |

Set **`readOnly: true`** to disable all editing (presentation mode).

---

## Options

```js
new FlowBoard(target, options)
```
`target` is a selector string or an element.

| Option | Default | Description |
|---|---|---|
| `theme` | `'auto'` | `'auto'` \| `'light'` \| `'dark'` |
| `grid` | `true` | show the background grid |
| `gridStyle` | `'dots'` | `'dots'` \| `'lines'` \| `'none'` |
| `gridSize` | `26` | grid spacing in px (scales with zoom) |
| `gridHideBelow` | `0.75` | hide the grid when zoom drops below this (`0`/`false` = never) |
| `snap` | `0` | grid-snap step in px (0 = off; also toggled in the toolbar) |
| `clickToEdit` | `true` | a single click on a card opens the editor |
| `toolbar` | `true` | show the zoom/fit/snap/theme toolbar |
| `minimap` | `true` | show the overview map |
| `inspector` | `true` | show the style panel for the selection |
| `readOnly` | `false` | presentation mode (no editing) |
| `connectable` | `true` | allow drawing connections from ports |
| `minZoom` / `maxZoom` | `0.2` / `2.4` | zoom limits |
| `defaultNodeWidth` | `280` | fallback card width |
| `fitPadding` | `60` | padding used by `fit()` |

## Node object

```js
{ id, x, y, width, tag, title, body /* HTML string */, variant, className,
  bg, border, borderWidth, borderStyle,   // per-card look (also editable in the inspector)
  data }                                    // your own arbitrary payload
```
`variant`: `'accent'` · `'safe'` · `'warn'` · `'muted'` · `'banner'` (or omit).
`bg` / `border` are CSS colors, `borderWidth` px, `borderStyle` = `'solid' | 'dashed' | 'dotted'`.

## Edge object

```js
{ id, from, to, dir /* 'h' | 'v' | auto */, fromSide, toSide,
  arrow /* bool */, style /* 'solid' | 'dashed' | 'dotted' */, width /* px */, color, label }
```
Without `dir` / sides, FlowBoard picks connection sides automatically from the cards' positions.

---

## API

```
addNode(n) · updateNode(id, patch) · removeNode(id) · setNodes(list) · getNode(id)
addEdge(e) · updateEdge(id, patch) · removeEdge(id) · setEdges(list)
startEdit(id, 'body'|'title') · endEdit()
fit() · zoomBy(f) · setZoom(s) · centerOn(x, y)
undo() · redo() · setSnap(px) · toggleSnap()
setTheme('auto'|'light'|'dark') · getTheme() · setReadOnly(bool)
getSelection() · toJSON() · fromJSON(data) · destroy()
on(event, cb) · off(event, cb)
FlowBoard.ICON(name)   // returns an inline Tabler SVG string
```

## Events

`change` · `nodemove` · `nodeclick` · `select` (ids[]) · `connect` (edge) · `edgeclick` (edge) ·
`zoom` (scale) · `theme` (`'light'|'dark'`) · `edit` (node)

```js
board.on('connect', e => console.log('linked', e.from, '→', e.to));
board.on('change',  () => localStorage.setItem('board', JSON.stringify(board.toJSON())));
```

## Save & restore

```js
const data = board.toJSON();   // { nodes, edges, view }
board.fromJSON(data);          // rebuild
```

---

## Development

Source lives in `src/`. The published files in `dist/` are generated:

```bash
node build.js   # writes dist/flowboard.js, dist/flowboard.css, dist/flowboard.auto.js
```

The demo (`index.html`) is deployed to GitHub Pages by `.github/workflows/pages.yml` on every push to `main`.

## License

MIT. UI icons from [Tabler Icons](https://tabler.io/icons) (MIT).
