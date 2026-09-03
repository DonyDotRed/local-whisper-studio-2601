# Third-party notices

This static application loads the following third-party runtime components.

- **Transformers.js** (`@huggingface/transformers` 4.2.0) — Apache-2.0. Loaded from jsDelivr; model files are loaded from Hugging Face Hub and cached by the browser when supported.
- **FFmpeg WebAssembly core** (`@ffmpeg/core` 0.12.10) — FFmpeg.wasm upstream distribution; check the upstream package and FFmpeg licensing terms before redistribution. The application loads the single-thread ESM core from jsDelivr at runtime.
- **Whisper ONNX model repositories** (`onnx-community/...`) — model-specific licenses and terms are controlled by their respective Hugging Face repositories.

No third-party runtime is used to upload the user's audio to a transcription API. The application performs inference locally in the browser.
