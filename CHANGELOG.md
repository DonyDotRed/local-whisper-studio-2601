# Changelog

## 2.3.0 — Whisper runtime stabilization

- Pinned browser ASR runtime to `@huggingface/transformers@3.8.1`.
- Worked around the 4.2.0 / ORT 1.26 quantized Whisper `Missing required scale` session-creation regression.
- Added q4/q8/fp16 → fp32 automatic precision fallback.
- Replaced Transformers.js long-audio pipeline chunking with explicit sequential <=30 s Whisper calls.
- Added overlap-aware timestamp merging to reduce duplicated boundary text.
- Kept real per-chunk progress, elapsed time, WebGPU watchdog, and CPU fallback.
- Kept one-time audio decode/resample and PCM waveform reuse.
- Bumped Service Worker/app cache to v2.3.0.
- Improved diagnostics to display actual dtype and Transformers.js runtime version.

## 2.2.0 — Performance / reliability update

- Removed eager full-audio decode on file selection.
- Reused STT-prepared 16 kHz PCM for waveform generation.
- Changed default preset to Whisper Tiny for fast first-run validation.
- Added Fast / Balanced / Accurate performance presets.
- Added device-aware automatic dtype selection.
- Added real chunk inference progress and elapsed-time diagnostics.
- Added WebGPU load fallback to CPU/WASM and a 120-second watchdog.
- Added AI model cache reset button.
- Added cross-origin-isolation Service Worker headers where supported.
- Changed app-code fetch to network-first.
