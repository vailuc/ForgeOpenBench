# FOB Frontend

React 19 + TypeScript + Vite frontend for Forge Open Bench.

## Stack

- **React 19** with strict TypeScript
- **Vite 8** — dev server and production build
- **Tailwind CSS 4** — utility styling via CSS custom properties
- **uPlot** — high-performance waveform and FFT plots
- **xterm.js** — in-app shell terminal
- **Vitest** — unit tests (jsdom environment)
- **Lucide React** — icons

## Development

```bash
npm install
npm run dev        # Vite dev server on :5173 (proxy /api and /ws to :8000)
npm test           # vitest unit tests
npm run build      # tsc + vite build — must exit 0 with zero TS errors
```

## Project Layout

```
src/
  core/             — event bus, plugin loader, settings store, skin system
  shared/           — shell components (header, sidebar, footer, bottom panel)
  plugins/
    dashboard/      — project switcher, hardware health, templates
    pocketforge/    — Pokit Pro BLE multimeter + DSO
    waveforge/      — Hantek USB oscilloscope (DSO) + logic analyzer (LA)
    lensforge/      — USB/IP camera with annotation overlays
    noteforge/      — markdown engineering notebook with wiki-links
    settings/       — VS Code-style settings panel
    monitorforge/   — multi-pane serial monitor with plotter
```

## Key Invariants

- `npx tsc --noEmit` must pass with zero errors
- `npm run build` must exit 0 with zero TypeScript errors
- `npm test` must pass with zero failing tests
- No hardcoded `localhost` in WebSocket URLs — use `wsUrl()` from `core/ws_url.ts`
