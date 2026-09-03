# Changelog

## 2.2.0 — Performance / reliability update

- Removed eager full-audio decode on file selection.
- Reused STT-prepared 16 kHz PCM for waveform generation.
- Changed default preset to Whisper Tiny for fast first-run validation.
- Added Fast / Balanced / Accurate performance presets.
- Added device-aware automatic dtype selection: WASM q8, WebGPU Whisper split precision.
- Added real chunk inference progress and elapsed-time diagnostics.
- Added WebGPU load fallback to CPU/WASM.
- Added 120-second no-chunk watchdog for Auto WebGPU inference and CPU retry.
- Added AI model cache reset button.
- Added cross-origin-isolation Service Worker headers to enable WASM threads where supported.
- Changed application cache to v2.2 and app-code fetch to network-first.
- Added cache-busting query versions for CSS/JS/worker files.
