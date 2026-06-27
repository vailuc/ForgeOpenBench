# Dual-Window Zoom Navigator — Quick Spec

## Goal
Add an overview mini-plot above the main waveform plot. The overview shows the full capture window; the main plot shows a zoomed segment. Clicking on the overview centers the main plot on that time point.

## Architecture

### DOM (time mode only)
```
flex-col flex-1 min-h-0 gap-1
  ├─ overviewDiv  (h-20, only in time mode)
  └─ plotDiv      (flex-1, main plot)
```

### Two uPlot instances
- `plotRef` — main plot (existing)
- `overviewPlotRef` — new, small height, no axes labels, minimal grid

### Data flow
- `renderNow` sets data on **both** plots (same data, different scale)
- Overview always auto-scales to full data range
- Main plot scale is forced during acquisition, free when stopped

### Overview draw hook
- After uPlot draws traces, read `plotRef.current.scales.x.min/max`
- Draw a semi-transparent rectangle (`rgba(245,158,11,0.15)`) + border on overview canvas showing the main plot's current x-range
- Convert data values to pixels using overview's scale

### Click-to-center
- `mousedown` on overview div
- Convert clientX to overview canvas pixel x
- Map pixel to data value via overview's x scale
- Set main plot x-scale centered on that value with same span
- Only works when stopped (same guard as pan/zoom)

### Visibility
- Overview div hidden (h-0 or display:none) in FFT and XY modes
- Overview plot created/destroyed alongside main plot in `buildPlot`

## Files changed
- `WaveformDsoView.tsx` only

## Est. effort
~60 min
