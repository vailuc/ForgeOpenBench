# Changelog

## [0.9.1-rc11] — 2026-06-23 18:55

### Added
- **Settings plugin overhaul**
  - VS Code-style layout with a searchable left tree and a right settings panel
  - Tree categories: General, Appearance, Plugins, System
  - Plugins branch expands to show per-plugin settings: PocketForge, MonitorForge, NoteForge, WaveForge, LensForge
  - Live search filters settings across the whole tree

### Changed
- Settings controls are now grouped into cards with title, description, and control on the right
- Plugin toggles moved under Plugins → Core
- Keyboard shortcuts
  - `Ctrl+'` toggles the bottom panel (Shell / Events / Logs / Serial)
  - Removed `Ctrl+W` and `Ctrl+`` footer shortcuts to avoid browser conflicts
  - Removed NoteForge `Ctrl+S/N/F/Enter` shortcuts because they were browser-locked

### Fixed
- **Header tab visibility**
  - Inactive plugin tabs now have a `bg-fob-surface` background so they no longer blend into the dark header bar
  - Replaced invalid `bg-fob-accent` / `border-fob-accent` classes with `bg-fob-orange` / `border-fob-orange` so active tabs actually render the accent background
- **Theme tokens**
  - Added `--fob-blue` to every skin and the Tailwind bridge (fixes `text-fob-blue` / `accent-fob-blue` used in WaveForge)
  - Added `--fob-accent` to the Tailwind bridge so `bg-fob-accent` / `border-fob-accent` resolve correctly
  - Removed a mistaken `--fob-accent: var(--fob-orange)` alias that made the accent color undefined and broke the FOB button in dark skins
- **Shell security**
  - Footer shell now spawns in the active project directory, or `Projects/` root if no project is active
  - CWD is shown in the terminal welcome banner

---

## [0.9.1-rc10] — 2026-06-23 18:20

### Added
- **NoteForge project asset viewer**
  - New backend endpoint `GET /api/v1/workspace/projects/{name}/rawfile` serves any project asset for preview/download
  - Project tree files now open inside NoteForge instead of a new tab
  - Markdown/text files (`.md`, `.txt`, `.csv`) open as editable project notes
  - Binary assets (`.png`, `.jpg`, `.csv` captures, `.bin`, etc.) open as read-only markdown references
  - Images render in the preview pane; non-images show a clickable link
  - Read-only mode disables the editor, hides the formatting toolbar, and shows a 🔒 badge
- **NoteForge sidebar improvements**
  - Project tree height doubled (`max-h-96`) and scrollable
  - Sidebar width increased from 192px to 224px for better tree readability
  - Tag cloud is now scrollable with a max height
- **MonitorForge export feedback**
  - Export buttons now show toast notifications: saved to project, downloaded as fallback, or failed

### Changed
- **Project tree click behavior**
  - Plain click opens the file in the editor (markdown/text editable, binary read-only)
  - `Ctrl`/`Cmd`/`Shift`+click inserts a markdown reference into the current note

### Fixed
- **Backend asset upload**
  - Removed `UploadFile`/`python-multipart` dependency that was preventing uvicorn from starting
  - Asset upload endpoint now accepts JSON with either `{"content": "..."}` or `{"data": "base64..."}`
- **MonitorForge toolbar**
  - Main toolbar height now matches other plugins at 53px

---

## [0.9.1-rc9] — 2026-06-23 14:32

### Added
- **MonitorForge rename + rescan + plotter**
  - Renamed `BenchForge` → `MonitorForge` (frontend plugin, backend package, config key, bus events)
  - Added manual **Rescan** button to the toolbar for serial port discovery
  - Fixed `bg-fob-yellow text-black` outlier to `text-fob-accent-text`
  - Added MonitorForge to the dashboard quick nav and updated shortcuts to Ctrl+1–6
  - Added **Serial Plotter** toggle in each MonitorForge pane and in the bottom-panel Serial tab
  - Plotter parses CSV-style numeric serial lines (`25,1023,…`) into live `uPlot` charts with a rolling 500-sample window
  - Added **Export** buttons: terminal text, plotter CSV, and plotter PNG image
  - Exports are saved into the active project under `captures/serial/`; fallback to browser download if no project is active

### Fixed
- **Launcher signal handling**
  - `launch.sh --dev` now reliably shuts down on `Ctrl+C` by tracking PIDs and recursively killing child processes (Vite, uvicorn reload watcher, etc.)
- **MonitorForge serial backend**
  - Serial bridge is now shared across multiple WebSocket clients, so multiple panes/tabs can view the same port without serial port lock conflicts

- **NoteForge `#tags`**
  - Tags are markdown-native: `#tag` tokens stored inside note text
  - Sidebar tag cloud shows all tags across notes; click to filter the note list
  - Tags render as clickable pills in preview/split view; clicking sets the filter
  - Active tag filter combines with the search input (AND)
  - `clear` button resets the tag filter

### Changed
- **README v3**
  - Replaced stale `README.md` with merged version: `README_v2.0.md` voice + factual corrections
  - Fixed current version, plugin list, `Ctrl+1-5` shortcut, and removed unimplemented `#tags`/trigger claims
  - Archived `README_v2.0.md` to `.l4d/README_v2.0.md` without deleting the draft
  - Added `.l4d/` to `.gitignore`

---

## [0.9.1-rc8h] — 2026-06-23 12:45

### Fixed
- **Theme / skin contrast**
  - Added per-skin `--fob-accent-text` token so text on accent buttons stays readable in every skin
  - Replaced hardcoded `text-black` / `text-white` on `bg-fob-orange`, `bg-fob-accent`, `bg-fob-green` with `text-fob-accent-text`
  - Replaced hardcoded Tailwind semantic colors (`text-red-400`, `text-yellow-400`, `text-emerald-400`, `bg-emerald-700`, etc.) with `fob-red`, `fob-yellow`, `fob-green` across BottomPanel, BenchForge, PocketForge, WaveForge, and shared components
  - Removed unused `PluginSidebar` component that had hardcoded colors
  - Sidebar border now uses `border-fob-border` instead of `border-black`
  - `MeterHistory` ticker and sparkline now use theme CSS variables instead of hardcoded `rgba(255,255,255,…)` / `#FF9933`, fixing white-on-white in light skin
  - Toast backgrounds now use `text-fob-accent-text` so success/info toasts no longer appear green-on-green in Terminal skin
  - Terminal and Midnight skins now have correct contrast on active buttons, badges, and toasts

---

## [0.9.1-rc8g] — 2026-06-23 12:20

### Added
- **LensForge per-pane camera controls**
  - New "Camera" tab in each LensPane with focus, exposure, white balance, zoom, brightness, and contrast controls
  - Only shows controls that the camera actually supports via `getCapabilities()`
  - Manual focus / exposure / white balance should stop AE/AWB flickering on cameras with real lenses
  - Per-device settings persist in `localStorage` keyed by `deviceId`
  - Disabled in shared/clone mode to avoid conflicting with the pane that owns the stream
  - Quick **AF / AE / AWB** on/off buttons in the action bar near the Save button for fast access

---

## [0.9.1-rc8f] — 2026-06-23 11:45

### Added
- **NoteForge project notebook**
  - NoteForge auto-opens the active project's `README.md` on mount; creates it with a default template if missing
  - Collapsible project file tree in the NoteForge sidebar (README + captures, notes, waveforms, firmware, scripts)
  - Click a `.md` file in the tree to open it as a project note
  - Click any other file to insert a markdown reference at the cursor (`[[name]]`, `![name](path)`, or link + details block)
  - Save edits to `README.md` and other project text files via `POST /api/v1/workspace/projects/{name}/file`

### Added
- Backend file endpoints
  - `GET /api/v1/workspace/projects/{name}/file` reads a text file inside a project with path-traversal guards and binary refusal
  - `POST /api/v1/workspace/projects/{name}/file` writes a text file inside a project
  - `GET /api/v1/workspace/projects/{name}/tree` now includes the top-level `README.md` node when present

### Fixed
- NoteForge image lightbox now renders via a React portal, eliminating `<div> inside <p>` hydration warnings

---

## [0.9.1-rc8d/e] — 2026-06-23 04:30

### Added
- **WaveForge LA I2C + SPI decoders** (rc8d + rc8e)
  - Tabbed Decoders panel: UART | I2C | SPI
  - Frontend-only I2C decoder: START, STOP, repeated START, address + R/W, data, ACK/NACK
  - Frontend-only SPI decoder: modes 0-3, 8/16-bit words, CS active-low/high, MOSI/MISO
  - Decoder overlay bubbles rendered above the relevant channel traces
  - Decoder channel/baud/mode configuration persisted in `localStorage`

### Changed
- Bottom UART ticker replaced with tabbed Decoders panel

---

## [0.9.1-rc8b/c] — 2026-06-23 03:56

### Added
- **WaveForge LA cursors and pan/zoom** (rc8b + rc8c)
  - Two draggable vertical cursors (A/B) with floating measurements panel
  - Δt, 1/Δt frequency, and Δsamples shown between cursors
  - Mouse wheel zooms around cursor; drag pans when zoomed in
  - Zoom in/out buttons, Fit button, and Classic mode (scrollbar + buttons) for touch/RPi
  - Horizontal scrollbar appears in Classic mode when zoomed in

### Changed
- Frozen (stopped) LA view now uses independent pan/zoom window instead of timebase selector
- Time/div selector disabled while stopped to avoid confusion with zoom controls

---

## [0.9.1-rc8a] — 2026-06-23 03:33

### Added
- **WaveForge LA channel controls** (rc8a)
  - Per-channel rename, hide (👁), enable (✅), and drag-and-drop reorder
  - ↑/↓ arrow buttons as fallback for touch / RPi
  - Channel configuration persisted in `localStorage`
  - Reset button restores default labels and order
- **WaveForge LA snapshots to project captures folder**
  - Camera button saves PNG to `Projects/<active>/captures/`
  - File can be linked into any README/note later

### Fixed
- NoteForge auto-creates a note and saves the snapshot when none was open
- Global ToastContainer so save confirmations appear from any plugin tab
- Removed broken backend `CSV (N files)` export that caused 404s and stack overflow
- Expanded LA timebase presets to 1-2-5 series for tighter stop auto-fit
- Stopped info label now shows the timebase window instead of the frozen buffer duration

---

## [0.9.1-rc7] — 2026-06-23 01:56

### Fixed
- **Hantek DSO plot hanging and reconnect latency** — eliminated 4–15 second stalls when changing samplerate or voltage range
  - Non-blocking Rust subprocess teardown in `usb_server.py` via `asyncio.run_in_executor`, preventing event-loop starvation during stop/start
  - Dynamic `read_size` tuned to ~30fps to keep the Python bridge CPU load low and the frontend queue unbacklogged
  - Frontend `intentionalStopRef` added so the auto-restart path does not race with user-initiated `stop()`/`start()` cycles
  - Live buffer capped at 200k samples and plot decimated to canvas width to keep uPlot redraws fast
  - `CONNECT_WAIT_MS` raised to 15s so heavy-load reconnects do not time out immediately
  - Samplerate and CH1 Range dropdowns disabled while reconfigure is in progress

### Technical
- Added `wave4` and `wave5` roadmap items for pre-existing WaveForge transport edge cases (auto-start closure and `_rpc` wait/send race)
- Rust `hantek-capture` module now used for DSO streaming; verified stable 100ms frame intervals at 4–15 MS/s

---

## [0.9.1-rc4] — 2026-06-21 22:26

### Fixed
- **Complete theme unification across all plugins** — Eliminated hardcoded colors for consistent FOB branding
  - **LensForge**: Fixed purple theme → standard orange theme, updated status dots, hover states, error colors
  - **WaveForge**: Replaced red/blue buttons and status colors with FOB theme variables (`bg-fob-red`, `text-fob-orange`)
  - **PocketForge**: Fixed red/blue indicators, toast notifications, status badges, error states to use FOB theme
  - **NoteForge**: Converted purple accent colors to standard FOB orange theme across all components
  - **MonitorForge**: Standardized status dots and button colors to FOB theme system
  - **Dashboard**: Unified colorful category icons (purple/blue/green/yellow) to consistent FOB orange
  - **All plugins**: Replaced hardcoded Tailwind colors with CSS variable system (`--fob-orange: #FF9900`, `--fob-red: #FF3333`, `--fob-green: #33FF33`)
  - **Result**: Perfect visual harmony across entire FOB interface with professional unified appearance

### Technical
- Updated 20+ plugin files to use FOB CSS variable system instead of hardcoded colors
- Ensured theme consistency across light/dark skin switching
- Maintained accessibility and semantic color meanings (success=green, error=red, accent=orange)

---

## [0.9.1-rc3] — 2026-06-21 16:51

### Added
- **ExpandingHeader implementation** — Right-side floating FOB button that expands to reveal full header
  - Collapsed state: Compact "FOB" button fixed on right side, stays out of workspace
  - Expanded state: Full header with plugins, project pill, clock, and "ForgeOpenBench" branding
  - Keyboard shortcut: `Ctrl+Space` toggles header visibility
  - Smart positioning: Always anchored to right side, expands leftward to avoid UI interference
  - Dynamic branding: "FOB" when collapsed, "ForgeOpenBench" when expanded
  - Plugin reordering: Settings first, Home second, others configurable
  - Smooth animations: 300ms transitions with proper state management
  - Replaces previous UnifiedHeader and FloatingFOBButton components

### Fixed
- Removed `uppercase` CSS class that prevented text change visibility in expanding header
- Fixed right-side positioning to ensure consistent behavior in both collapsed and expanded states

---

## [0.9.1-rc2] — 2026-06-21 12:50

### Added
- **WaveForge firmware management** — symlink-based firmware switching for Hantek 6022BL
  - Settings → WaveForge section with device mode selector (8ch @ 24MHz / 16ch @ 12MHz)
  - Backend functions: `get_waveforge_firmware_dir()`, `set_waveforge_firmware_link()`, `get_waveforge_firmware_status()`
  - WebSocket handlers: `waveforge_firmware_get`, `waveforge_firmware_set`
  - User-local firmware directory: `~/.local/share/sigrok-firmware/`
  - Transparent symlink management: `fx2lafw-saleae-logic.fw` → selected firmware
  - Eliminates need for system-wide firmware file modifications or upstream sigrok patches

### Fixed
- Updated documentation references to point to new firmware management approach
- README.md now references Settings → WaveForge for firmware mode selection

---

## [0.9.6] — 2026-06-21 01:30

### Added
- **ide2 — Project templates** — `GET /api/v1/workspace/templates` returns 4 built-in templates (Blank, Teardown, Firmware Debug, Signal Capture) + any custom dirs under `Projects/_templates/`. `POST /api/v1/workspace/projects/{name}?template=X` writes the template README on creation. Dashboard new-project form shows a template picker row; selecting a non-blank template shows its description.
- **ide3 — Project archive/export** — `GET /api/v1/workspace/projects/{name}/export` streams a Deflate-compressed `.zip` of the entire project folder. Dashboard project cards each have a `⬇ .zip` button. `project_store.exportProject()` triggers a browser anchor download.

---

## [0.9.5] — 2026-06-21 01:15

### Added
- **wf5 — WaveForge measurement overlays** — after capture stops, a measurement bar appears below the LA canvas: Freq (Hz/kHz/MHz), Period (µs/ms/s), Duty cycle (%), edge count. Computed on the UART ticker channel. Auto-scales units.
- **wf6 — WaveForge trigger controls** — Trig dropdown in controls bar: None / ↑ Rise / ↓ Fall / ↕ Any, plus channel selector. On stop: frozen buffer is sliced from the first matching edge. Works on both manual Stop and auto-stop paths.
- **wf8 — WaveForge VCD export** — `VCD` button (alongside CSV) exports a GTKWave-compatible `.vcd` file. 1 ns timescale, all 8/16 channels as `$var wire`, only value-change events emitted (compact).

---

## [0.9.4] — 2026-06-21 01:05

### Added
- **nf4 — NoteForge export** — `⬇ Export` dropdown in toolbar. Three options: **Download .md** (current note), **All notes (.zip)** (JSZip, `noteforge-export-<ts>.zip`), **Print / PDF** (`window.print()`). Dropdown closes on outside click.

---

## [0.9.3] — 2026-06-21 01:00

### Added
- **nf3 — NoteForge tag system** — write `#tag` anywhere in note body. Tags parsed client-side via `extractTags()`. Sidebar: tag filter bar at top + pills under each note's date line. Search also matches tag text. Tags updated on every save and list refresh.

---

## [0.9.2] — 2026-06-21 00:53

### Added
- **lens2 — LensForge grid/reticle SVG overlay** — click-to-cycle button per pane. Five modes: none → crosshair → thirds → grid → dot. `pointer-events-none` SVG layer.

---

## [0.9.1] — 2026-06-21 00:39

### Added
- **lens1 — LensForge per-pane video recording** — ⏺ record button, MediaRecorder VP9/WebM, mm:ss timer. Saves to `captures/` via `POST /api/v1/lens/video`; fallback to browser download.
- **cam1 — LensForge CAM footer pill** — purple CAM pill reflects live camera count.
- **hw1a/b/c — BenchForge serial monitor** — footer SERIAL tab + `GET /api/v1/serial/ports` + `WS /api/v1/serial/stream` pyserial bridge + full multi-pane BenchForge plugin.
- **lens4 — NoteForge data: URI images** — confirmed already implemented via `NoteImage` custom renderer.

---

## [0.9.0-rc1] — 2026-06-20 22:44

### Fixed
- **R3 — clean build** — `npm run build` exits 0, zero TypeScript errors.
  - `MultimeterView`: `pendingSettingsRef` and `send()` type aligned to `updateIntervalMs` (was `intervalMs` — mismatch with `MultimeterSettings`). Unused scaffolding state suppressed via `_` prefix / ref pattern.
  - `OscilloscopeView`: non-null assertions on `buf` / `plotRef.current` (both are guarded by `hasJitter` / `hasPlot` before access). Explicit `boolean` type on `setContinuous` callback.
  - `Waveform.tsx`: removed `_mode` from destructure — optional prop, unused in body.
  - `waveforge/index.tsx`: `bus` → `_bus` (PluginBus not yet consumed in WaveForgeApp).
  - `BottomPanel.tsx`: `onClose` → `_onClose` (prop kept in interface, not yet wired to a close button).
  - `vite.config.ts`: `@ts-expect-error` on vitest `test` block (vitest augments vite config at runtime, not statically).

---

## [0.8.0] — 2026-06-20 22:15

### Added
- **install.sh** — idempotent setup script for Debian/Ubuntu/RPi/macOS. Detects package manager (apt/pacman/brew), installs node, python3, sigrok-cli, creates `.venv`, runs `npm install`, installs udev rule for Hantek 6022BL, creates optional `.desktop` launcher.

### Fixed
- **Dynamic WS URLs** — verified all WebSocket connections use `ws_url.ts` (`wsUrl(path, port)` resolves against `window.location.hostname`). No hardcoded `localhost` anywhere in frontend. LAN/RPi deployment works without code changes.
- **console.log cleanup** — removed all dev-noise `console.log` from production paths. EventBus connect/disconnect downgraded to `console.warn`. BleTransport GATT step logs removed. StatusService button-press byte dump removed. OscilloscopeView DSO meta/scale spam removed. UsbTransport connect/reconnect logs removed.

---

## [0.7.5] — 2026-06-20 22:05

### Added
- **WaveForge CSV export** (wf4) — `CSV` button appears in toolbar when stopped with data. Downloads `waveforge-YYYYMMDD-HHmmss.csv` with columns: `sample, time_us, ch0–ch15`. One row per sample, `time_us` = sample index / sampleRate × 1,000,000.
- **WaveForge screenshot → NoteForge** (wf3) — camera button in toolbar when stopped. Captures canvas as PNG via `toBlob`, emits `noteforge.insert.image` on `globalBus`. NoteForge listener appends `![caption](dataUrl)` to active note. Toast if no note is open.

### Notes
- N1 (NoteForge full-text search): backend endpoint `GET /api/v1/notes/search?q=` and frontend debounced search were already fully implemented — nothing to add.
- P1 (dynamic WS URLs): `ws_url.ts` and all consumers already correct — nothing to add.

---

## [0.7.4] — 2026-06-20 21:57

### Added
- **WaveForge LA — snap-to-latest live display**: replaced rolling rAF loop with chunk-triggered single-frame draw. On each USB chunk arrival, `readHead` snaps to `jitterWriteRef` (latest sample) and a single `requestAnimationFrame` fires. Zero latency, no buffering delay, no wasted frames between chunks. `snapDirtyRef` coalesces rapid back-to-back chunks into one draw.
- **WaveForge LA — Uint16 jitter ring**: 6M-sample `Uint16Array` ring (`JITTER_CAP_SAMPLES`) holds last 500ms of samples for live indexed access. Samples right-aligned into window buffer during priming phase — empty padding on left fills in as data arrives.
- **WaveForge LA — extended timebase presets**: added `100ms/div`, `1s/div`, `10s/div`, `100s/div` to `TIMEBASE_PRESETS`. Auto-fit on stop can now correctly handle captures up to ~1000s.
- **WaveForge LA — canvas info overlay**: top-right of canvas shows `Xs total / Ys shown` when stopped, so total capture duration is always visible even though the view shows only the last ring window.

### Fixed
- **WaveForge LA — live axis offset growing**: axis labels used `readHead / sampleRate` (USB delivery time, ~40ms after 20s due to bulk transfer pacing at ~3 chunks/sec). Fixed to use `(Date.now() - startTimeRef) / 1000` — wall-clock elapsed, matching the toolbar timer exactly.
- **WaveForge LA — axis labels during priming**: labels only rendered for the filled right portion of the axis during priming (before window fills). Empty left padding region is unlabelled.
- **WaveForge LA — auto-fit on stop reverted to 100ms**: `ringRef.current.count` capped at ~350ms (8MB ring fills at 12MHz 16-bit). Fixed to use `frozenBufRef` actual size for auto-fit computation.
- **WaveForge LA — draw() reading stale timebase after stop**: `setTimebaseIdx(best)` is async; `draw()` fired before React flushed the state. Fixed by setting `timebaseRef.current = best` synchronously before `draw()`.
- **WaveForge LA — frozen snapshot from ring**: freeze on stop now pulls from jitter ring (last 500ms, sample-indexed) rather than 8MB byte ring — consistent with live view and correct for auto-fit.
- **WaveForge LA — stopped info label using sample count**: `jitterWriteRef / rate` gave USB-delivery seconds not wall-clock. Fixed to use `elapsedSRef.current`.
- **WaveForge LA — axis label format**: cleaner rounding per magnitude — `<10ms` 2dp, `<100ms` 1dp, `≥100ms` integer, `≥1s` 1dp, `≥100s` integer.
- **WaveForge backend — SIGINT before stop_event**: `_stop_capture` sends `SIGINT` to sigrok-cli before setting `stop_event` — ensures clean FX2 shutdown (LED off) before capture thread exits.
- **WaveForge backend — stdin=PIPE**: `sigrok-cli --continuous` now launched with `stdin=subprocess.PIPE` — prevents EOF on stdin being interpreted as a stop signal.
- **WaveForge LA — auto-fit uses wall-clock elapsed**: `finalElapsedS` from `Date.now() - startTimeRef` used as primary fit source — immune to USB pacing artifacts. `elapsedSRef` reset to 0 on each start. `startTimeRef` nulled after stop.
- **NoteForge wiki-links navigation**: `[[Note Title]]` link used `<button>` inside ReactMarkdown `<a>`, causing browser to follow the `wikilink:` href to home URL. Fixed to `<a href="#" onClick={e.preventDefault()}>` so the anchor intercepts the click correctly. Fallback path also guards `wikilink:` hrefs.

---

## [0.7.3] — 2026-06-20 18:16

### Fixed
- **wave1** — `sharedUsbTransport` singleton now reset on plugin unmount via `resetSharedUsbTransport()` — prevents stale transport being reused on remount
- **wave2** — auto-scan on bridge reconnect uses `setSelectedDevice(prev => prev ?? found[0])` — user selection preserved across WS reconnects
- **wave3** — `connectDevice()` now accepts full `UsbDeviceInfo`, passes `bus`/`address` to RPC, reconstructs `_deviceInfo` via spread — no metadata loss
- **bug4** — `RingBuffer.tail()` non-wrap path now uses `.slice()` not `.subarray()` — `frozenBufRef` snapshot no longer corrupted by late-arriving chunks
- **bug5** — disconnect effect in `WaveformLaView` + `WaveformDsoView` now tests `runningRef.current` instead of `running` state — closes race where `start()` is in-flight and state hasn't updated, preventing skipped `transport.stop()`
- **bug6** — `timebaseIdx` now wired via `timebaseRef` into `draw()` in `WaveformLaView` — stopped-mode display window respects Time/div selector
- **sigrok re-enum race** — removed pre-scan loop from `_capture_loop_sigrok`; bare `fx2lafw` driver auto-discovers device, avoiding stale `conn=` address from firmware-upload-triggered re-enumeration
- **footer USB pill** — `waveforge.usb.status` globalBus event emitted on connect/disconnect/unmount; footer pill goes green with device name when connected
- **launch.sh** — USB bridge (`usb_server.py`, `:8766`) added to `--dev` stack; `--no-usb` flag to skip; `usb_server.py` added to `--shutdown` kill list; `logs/usb.log` symlink created
- **review** — `runningRef.current` guard in disconnect effect (both views), inline `import()` removed from `UsbTransport.connectDevice`, unmount emits status event before transport reset

---

## [0.7.2] — 2026-06-20 17:33

### Added
- **Keyboard shortcuts expansion** (`ux3`): global and plugin-local shortcuts added.
  - `F11` — toggle fullscreen
  - `Ctrl+W` — close bottom panel
  - `?` — show/hide shortcuts overlay (grouped by scope: Global / NoteForge / PocketForge)
  - `Esc` — dismiss overlay
  - NoteForge: `Ctrl+N` new note, `Ctrl+F` focus search, `Ctrl+Enter` cycle view mode (Edit→Preview→Split)
  - PocketForge Meter tab: `H` toggle Hold, `R` toggle REL (guarded — no effect when input focused)

### Fixed
- **Sidebar collapse button** (`ux`): collapse toggle was a tiny `h-7 «/»` button — easy to miss. Replaced with `▶/◀` arrows, `py-1.5 text-base font-bold`, full-width hit area, hover background.

---

## [0.7.1] — 2026-06-20 16:47

### Added
- **NoteForge wiki-links** (`nf2`): `[[Note Title]]` in markdown renders as a clickable orange link in Preview and Split panes. Click navigates to the matching note (case-insensitive, matches on title or filename slug). No match → toast `No note titled "…"`. Edit textarea unchanged — plain text.
  - `remarkWikiLinks` remark plugin in `noteComponents.tsx` transforms `[[…]]` to `wikilink:` href nodes in the mdast
  - `buildNoteMarkdownComponents(onWikiLink)` factory returns a components map with a custom `a` handler for `wikilink:` hrefs
  - `handleWikiLink` callback in `NoteForgeApp` closes over `notes` state for lookup

---

## [0.7.0] — 2026-06-20 16:41

### Added
- **Settings full plugin** (`pub8`): `SettingsModal` modal replaced with a full-screen plugin page. Registered as `settings` in the plugin system — same lifecycle as all other plugins. Left-nav sections: General · Appearance · PocketForge · Plugins · System.
- **Skin picker** (`theme3`): Appearance section shows 5 labelled swatches (Forge Dark, Forge Light, LCARS, Terminal, Midnight). Click applies skin live via `data-skin` on `<html>`, persisted to `localStorage("fob.skin")` and backend config. Skin rehydrated before first paint in `main.tsx` — no flash on reload.
- **Settings sidebar entry**: ⚙ Settings pill pinned at the bottom of the sidebar (below spacer, above hidden-plugins expander), works in both collapsed and expanded modes.
- **`Ctrl+,` shortcut**: opens Settings from any plugin. Added to the global `App.tsx` keydown handler. Shortcut listed in Settings → System.
- **FOB pill → Settings** menu item navigates to the Settings plugin (no modal).

### Removed
- `settingsOpen` / `setSettingsOpen` state from `App.tsx` — no longer needed.
- `<SettingsModal>` mount in `App.tsx` — Settings is now a plugin, not a modal overlay.

---

## [0.6.7] — 2026-06-20 13:23

### Fixed
- **Logger→DSO GATT crash** (`dso`): switching from Data Log to DSO tab while connected via Web BT caused a Chromium GATT collision crash. Root cause: `MultimeterView` stays `isActive=true` during the Logger tab (feeds it data), so `stopLive()` and DSO init raced on the GATT bearer.
  - Added `setSharedMeterBusy` flag to `sharedTransport.ts` — Meter sets it `true` at start of `stopLive`, `false` when done
  - Meter emits `pocketforge.meter.released` on `globalBus` when fully unsubbed
  - DSO replaced 50ms poll loop with event-driven listener — syncs transport immediately on event, no delay when meter already idle
  - Toast shown while waiting: *"Waiting for meter to release GATT…"* — auto-dismissed on event; 2s timeout fallback with warning toast

---

## [0.6.6] — 2026-06-20 12:17

### Refactored
- **PocketForge connection header** (`pocket`): stripped `Bridge` badge and `Offline` indicator from `ConnectionStatus` — footer pills now own all transport/bridge status. `useBridgeOnline` hook removed from PocketForge entirely.
- When disconnected, center header area is empty (no noise). Only shows device name + dot when connecting or connected.

---

## [0.6.5] — 2026-06-20 12:08

### Changed
- **PocketForge `ConnectionControls`** (`pocket`): replaced Web BT / Bridge transport toggle + Connect button with a single `⏻` power button. Transport selection moved exclusively to footer PyBT pill.
- **PyBT pill** (`ux2`): popover now shows active transport (`Bridge ✓` / `Web BT`) and a **Switch to Bridge / Switch to Web BT** action button. Fires `globalBus` `pocketforge.transport.set` — PocketForge reacts without navigation.
- **BT pill** (`ux2`): colour reflects active transport — teal for Web BT, orange for Bridge. Detail shows `via Python Bridge` or `via Web Bluetooth`.
- `App.tsx` listens to `pocketforge.transport.set` and updates `settingsStore.pluginTransport` so all pills re-render reactively.

---

## [0.6.4] — 2026-06-20 11:56

### Added
- **Actionable status pills** (`ux2`): footer pills now open a popover on click with:
  - Status detail line (device name, port, transport)
  - Action buttons per state: **Reconnect** (CORE), **Disconnect** (BT when connected), **Switch to Bridge/Web BT** (PyBT when bridge online)
  - **→ Open [Plugin]** navigation button for each pill (CORE→Dashboard, BT→PocketForge, PyBT→PocketForge, USB→WaveForge)
- `FooterItem` interface extended with `actions: FooterAction[]` and `pluginId?: string`
- `StatusPopover` upgraded with variant-styled action rows (danger=red, primary=orange, default=dim)
- `AppFooter` receives `onNavigate` prop → calls `setActivePlugin` in `App.tsx`

---

## [0.6.3] — 2026-06-20 11:28

### Added
- **Shell toolbar**: Auto-follow toggle (orange when active), ⌫ Clear (sends `clear\n` to PTY), ↺ New (kills + restarts session), font size −/+ (9–22px, persists to localStorage `fob.terminal.fontSize`)
- **Logs 4-tab split**: Backend / Bridge / Frontend / USB sub-tabs, each independently polled from `GET /api/v1/logs/recent?source=`
- **Logs controls per tab**: All/Info/Warn/Error level filter, ⬇ Follow toggle, font size −/+ (9–18px, persists `fob.logs.fontSize`), ↻ Refresh, Clear (calls `DELETE /api/v1/logs/{source}` to truncate file)
- **Backend `DELETE /api/v1/logs/{source}`**: truncates the named log symlink target; valid sources: backend, bridge, frontend, usb-bridge

---

## [0.6.2] — 2026-06-20 11:14

### Added
- **Bottom panel 3-tab split** (`events1`): Shell / Events / Logs
  - **Events tab**: subscribes to all known `globalBus` events, timestamped rows with per-event color coding, ring-buffer 200 entries, Clear button
  - **Logs tab**: polls `GET /api/v1/logs/recent` every 3s, filterable by All/Info/Warn/Error, auto-scroll with scroll-lock detection, manual Refresh button
  - **Backend**: `GET /api/v1/logs/recent?n=N` — reads last N lines from `logs/backend.log`, parses level from bracket notation

---

## [0.6.1] — 2026-06-20 11:06

### Fixed
- **Terminal banner bash pollution** (`terminal2`): banner was written to PTY fd before bash initialized — bash read ANSI art as commands and errored. Now sent directly via `websocket.send_text()` so xterm renders it, bash never sees it.

---

## [0.6.0] — 2026-06-20 10:58

### Added
- **Header clock** (`layout6`): live `HH:MM:ss` clock in header right zone — hours in orange, monospaced, ticks every second
- **Terminal welcome banner** (`terminal1`): ANSI FOB logo + active project name injected into PTY on connect
- **NoteForge full-text search** (`nf1`): `GET /api/v1/notes/search?q=` backend endpoint — scans all note bodies, returns matches with snippet of matching line; frontend debounces 300ms, shows results with orange snippet below note name; click to open, clears search

---

## [0.5.3] — 2026-06-20 10:29

### Fixed
- **Shell tab PTY**: `PtyProcessUnicode` → `PtyProcess` — raw fd I/O requires bytes class; was crashing silently on connect
- **Shell tab WS URL**: `SystemTerminal` now uses `wsUrl(..., 8000)` in dev — was hitting Vite `:5173` instead of backend `:8000`
- **Shell tab render**: xterm container gets `h-full` — without explicit height `fit()` measured 0×0 and rendered blank
- **React StrictMode guard**: `cancelled` ref in `SystemTerminal` prevents double-mount zombie connections

### Changed
- **Project pill**: split pill design — left = project selector, right = `+` new project button divided by border; `w-full max-w-xl` fills center header zone; `rounded-lg` replaces `rounded-full`

---

## [0.5.2] — 2026-06-20 09:53

### Added
- **Project pill — Set as default**: hover any project in dropdown → `★` button appears; persists via `PUT /api/v1/workspace/default`; active default shown with `★` in pill and list
- **`workspace.project.changed` bus event**: emitted on every `setActive` — NoteForge/LensForge can react
- **`PUT /api/v1/workspace/default`** backend endpoint; `default_project` returned in `GET /api/v1/workspace/projects`

### Changed
- **Project pill**: larger (`text-sm`, `px-4 py-1.5`, `max-w-[260px]`), bolder font — more prominent center header element

---

## [0.5.1] — 2026-06-20 09:47

### Added
- **`FileTreePanel`**: collapsible 192px panel between sidebar and plugin area — shows active project folder tree (notes, captures, waveforms, firmware, scripts) with per-section icons; click `.md` → NoteForge, click image → LensForge; `Ctrl+Shift+E` toggle
- **`GET /api/v1/workspace/projects/{name}/tree`**: new backend endpoint — recursive file listing, dirs before files, dotfiles skipped

---

## [0.5.0] — 2026-06-20 09:31

### Added
- **`BottomPanel`**: docked resizable panel (drag 120–600px), replaces `FloatingTerminal` modal. Tab strip: `>_ Shell` / `⚡ Events` — tabs live in footer bar, clicking active tab closes panel
- **`AppFooter`**: persistent `h-9` footer bar — clickable status pills (CORE, BT, PyBT, USB, PSU) with detail popovers; Shell/Events tab buttons on right
- **Sidebar collapse**: `«`/`»` toggle button, icon-only `w-10` ↔ full `w-28`, persists via `localStorage("fob.sidebar.collapsed")`, `Ctrl+B` shortcut
- **Keyboard shortcuts**: `Ctrl+1-5` switch plugins, `Ctrl+\`` toggle bottom panel, `Ctrl+B` toggle sidebar
- **FOB pill menu**: click FOB pill → dropdown (Settings, About); replaces standalone `☰` burger button
- **`docs/plans/plan-ide-layout.md`**: full layout1-5 scope with file tree and project pill rework plans

### Changed
- **`ForgeHeader`**: removed `>_` terminal button and `☰` burger — header now FOB pill (left) + project pill (center) only
- **`Sidebar`**: unified — retired separate `PluginSidebar.tsx` and `FloatingTerminal.tsx`
- **`toggleSidebar`** wrapped in `useCallback` — stable ref, correct `useEffect` dep array

### Removed
- `PluginSidebar.tsx` — retired, functionality absorbed into `Sidebar.tsx`
- `FloatingTerminal.tsx` — retired, replaced by docked `BottomPanel`
- Top `StatusBar` strip — status moved to `AppFooter` pills

---

## [0.4.1] — 2026-06-20 08:54

### Added
- **5-skin system** (`index.css`): Forge Dark, Forge Light, LCARS, Terminal, Midnight — switched via `data-skin` attribute on `<html>`
- **CSS var foundation**: all colour tokens as `--fob-*` CSS custom properties in `:root`; `@theme` bridge maps them to Tailwind utilities (`bg-fob-bg`, `text-fob-orange`, etc.)
- **`--fob-font-scale`** in `:root` — prerequisite for `ux8` font size control
- **LCARS authentic palette**: orange primary `#FF9900`, purple/violet `#CC99FF`, warm cream text `#FFCC99`, system-ok green `#99CC33`

### Changed
- **`tailwind.config.js`**: removed hardcoded hex color values — single source of truth is now `index.css`
- **`body`**: `background` and `color` now use `var(--fob-bg)` / `var(--fob-text)` — no hardcoded hex
- **`Sidebar.tsx`**: replaced `bg-white` active indicator and `bg-[#22222E]` hex values with `bg-fob-orange` / `bg-fob-surface` / `bg-fob-surface-hover`

---

## [0.4.0] — 2026-06-20 08:06

### Added
- **`ws_url.ts`**: shared dynamic WebSocket URL builder — resolves `ws://` or `wss://` from `window.location`, eliminating all hardcoded `localhost` URLs
- **`PluginErrorBoundary`**: React error boundary wrapping all 5 plugin roots — crashing plugin shows inline error card, rest of app stays alive
- **PWA manifest** (`public/manifest.json`): enables "Add to Home Screen" on Android/iOS; theme color `#FF9900`
- **`backend/requirements.txt`**: pinned versions for all backend dependencies (fastapi, uvicorn, pydantic, bleak, ptyprocess, websockets)
- **`docs/ROADMAP.md`**: public-facing engineering roadmap (v0.9 → v2.0)
- **`docs/HARDWARE.md`**: supported hardware reference and known quirks
- **`docs/sigrok-bugreport-draft.md`**: draft bug report for Hantek 6022BL / sigrok firmware issue

### Changed
- **Dynamic WebSocket URLs**: replaced all 5 hardcoded `ws://localhost:XXXX` URLs across `BridgeTransport.ts`, `UsbTransport.ts`, `event_bus.ts`, `App.tsx`, `pocketforge/index.tsx`
- **Terminal endpoint**: loopback-only guard — rejects non-`127.0.0.1`/`::1` connections with WS close code 1008
- **Plugin registry**: removed `benchforge` dummy stub; name reserved for future Serial/UART monitor plugin
- **Dev planning files**: moved 7 root-level `.plan-*.md` / `.review-*.md` / `.deferred-todos-*.md` to `docs/archive/`
- **Page title**: fixed from "frontend" to "Forge Open Bench"
- **`index.html`**: added mobile PWA meta tags (`theme-color`, `apple-mobile-web-app-*`, `maximum-scale=1`)

### Removed
- `libsigrok.so.4.0.0` binary from git index (`git rm --cached`); added `*.so.*` to `.gitignore`
- Debug `console.log` from `App.tsx`

---

## [0.3.2] — 2026-06-20 06:32

### Added
- **NoteForge lens capture sidebar**: meta/layers/fullsize panel on right of captured image; live layer editing in preview + split mode
- **NoteForge Jupyter-style renderer**: base64 image lightbox, annotation SVG overlay, styled code/details blocks
- **NoteForge formatting toolbar**: bold/italic/code/heading, search, title display, font size, `Ctrl+S`, Tab→spaces
- **LensForge → NoteForge bus injection**: snapshot emits `noteforge.insert`, NoteForge inserts at cursor position
- **Per-layer controls**: colour picker, stroke width, individual layer show/hide toggles in annotation preview
- **Projects/ workspace system**: dashboard plugin, header project pill, project-scoped file counts
- **NoteForge base64 collapse**: long image blobs collapse to placeholder line with click-to-reveal

### Fixed
- `deleteLayer` stale closure in LensForge; `stopActive` cleanup; `response.ok` check; toast timer leak; pane config migration
- NoteForge blank render crash — bus effect moved after `useCallback` declarations
- NoteForge cross-plugin bus — lens captures now appear in notes sidebar correctly
- `rehype-raw` for `details`/`summary` rendering; collapse details blocks in editor
- Dashboard live count refresh after lens/note saves
- Annotation `strokeWidth` in `AnnotationOverlay`; draw toolbar layout; lightbox shows overlay

---

## [0.3.1] — 2025-06-18

### Fixed
- **Pokit Pro firmware lockup** (required power cycle): `Promise.all` was flooding the ATT bearer with 3+ concurrent GATT reads during status service setup. Replaced with sequential reads + 80ms gaps.
- **Web BT stall after ~3s**: `writeValueWithResponse` immediately after `startNotifications` freezes Chromium's GATT scheduler. Added 150ms settle delay before first `setSettings` write (bridge transport unaffected).
- **DSO → Meter tab switch stall**: async race between `stopLive()` and `setupAfterConnect()` left `notifyHandlers` empty. Fixed with `prevIsActiveRef` tracking + `await stopLive().then(200ms).then(setupAfterConnect)`.
- **Transport switch stall** (Web BT → Bridge): `setupBusyRef` was never reset in `stopLive`, permanently blocking next transport's setup.
- **EventBus console spam**: reconnect was fixed at 3s forever. Now exponential backoff 3s → 6s → 12s → 30s cap, resets on successful connect.

---

## [0.3.0] — 2025-06-16

### Added
- **Python BLE bridge** (`server/pokit-bridge/pokit_server.py`): standalone bleak server on `ws://localhost:8765`, bypasses Chromium's 135–150ms BlueZ notification batching
- **BridgeTransport** (`BridgeTransport.ts`): WebSocket transport implementing `IPokitConnection`, scan/connect/reconnect/GATT ops
- **Auto-reconnect**: server-side `_reconnect_loop` with exponential backoff + BLE scan-before-retry; recovers within ~5s
- **Subscription dedup**: `subscriptionCounts` refcounting (frontend) + `_active_subscriptions` guard (server)
- **Separate timestamped logs** in `logs/` with stable symlinks (`bridge.log`, `backend.log`, `frontend.log`)
- **Keepalive**: reads Device Name char every 45s when idle; skipped when subscriptions active
- **Bridge status pill**: `ConnectionStatus` shows orange "Bridge" badge when `pokit_server.py` is online

### Fixed
- Stale `subscriptionCounts` on reconnect blocking re-subscription (A1)
- `setupBusyRef` early-return paths not resetting — permanently blocking future setup (B1)
- `gatt_unsubscribe` held `_gatt_lock` during 300ms settle sleep — deadlocked concurrent subscribe (C1)
- `asyncio.wait_for` on `ws.send` causing cancellation edge cases (D1)
- `_reconnect_loop` re-subscribe list always empty — snapshot taken before `ble_connect` clears it (E)
- `initialModeSent` stuck `true` after mid-setup failure (F)

---

## [0.1.0] — 2025-06-14

### Added
- **Layout shell rework**: ForgeHeader, StatusBar, PluginSidebar, FloatingTerminal components
- **Floating system terminal**: Draggable modal replacing bottom drawer, saves vertical real estate
- **Plugin sidebar**: Compact colored pill blocks for plugin navigation ("Dr. Mario" aesthetic)
- **DSO (Oscilloscope) support**: Continuous capture with jitter buffer, adaptive playback speed, sweep/roll modes
- **DSO phosphor effect**: Multi-trace sweep history with per-trace `dt` for correct x-spacing
- **DSO dynamic stale timeout**: `max(500, expected / rate * 1000 * 2)` prevents false "capture stalled" on large slow captures
- **Sample limit bump**: One-shot raised to 4096 samples, 8192 option added

### Changed
- **App.tsx restructured**: Removed inner content header bar; plugins fill the panel directly
- **Status bar**: Pill-style indicators `[● CORE] [● BT: Pokit Pro] [○ USB] [● PSU]`
- **Header**: Orange rounded elbow logo, `>_` terminal toggle, `☰` hamburger menu with Settings

### Fixed
- DSO hidden continuous mode now routes samples to jitter buffer correctly
- rAF loop no longer burns cycles when stopped (guarded by `runningRef.current`)
- Removed dead `DsoRingBuffer`/`DsoSweepBuffer` imports and refs

---

## [0.0.0] — Initial

- Base project scaffold with plugin system, WebSocket event bus, PocketForge multimeter support
