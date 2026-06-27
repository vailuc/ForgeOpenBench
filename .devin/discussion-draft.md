## Title: "WaveForge got a glow-up"

**Body:**

> WaveForge started as a weekend hack. Stream USB data, draw a line, done. It worked, but using it on real hardware felt like a waveform viewer in a scope costume.
>
> So I rebuilt the DSO UI from scratch. Goal: make it feel like sitting in front of a real bench scope. Decades of engineers refining "how do I look at a signal" got us something that actually works.

**The old state was rough:**

- Generic web app layout (panels everywhere)
- "Running" checkbox — that's it for acquisition modes
- Position knobs that didn't move the trace
- A "math" checkbox. The whole feature.

**What's new:**

- **Hardware layout** — vertical, horizontal, trigger, math, left-to-right. Color-coded. Measurements at the bottom.
- **Real acquisition modes** — Run, Single-shot, Average, Roll. They actually behave differently.
- **Trigger you can see** — magenta level line on the plot. Auto, Normal, and Single modes.
- **Math that does math** — FFT spectrum, XY / Lissajous, A+B, A−B, A×B, A÷B. Digital phosphor persistence for XY.
- **Knobs that turn** — probe attenuation (1×/10×/100×), BW limit, peak detect, position, delay.

**Branch:** `feat/fft-xy-phosphor` on GitHub

**Coming up:** reference waveform save/load, serial decoders (SPI/I2C/UART), cleaner state machine internals.

**Two questions:**

1. Does the "physical scope" metaphor actually help, or should I go more web-native?
2. FFT is basic (raw radix-2, no windowing). Good enough for audio tinkering?

Drop thoughts. Building in public is more fun with company.
