// Local Whisper Studio 2.2 - optimized Transformers.js worker
let pipeline = null;
let env = null;
let transcriber = null;
let currentKey = '';
let currentEffectiveDtype = null;

function dtypeKey(x) {
  return typeof x === 'string' ? x : JSON.stringify(x);
}

async function getLibrary() {
  if (pipeline) return;
  const lib = await import('https://cdn.jsdelivr.net/npm/@huggingface/transformers@4.2.0');
  pipeline = lib.pipeline;
  env = lib.env;
  env.useBrowserCache = true;
  env.useWasmCache = true;

  // GitHub Pages cannot normally send COOP/COEP headers, so WASM threading is
  // generally unavailable. Explicitly using one thread avoids repeated thread
  // capability probing / SharedArrayBuffer-related startup problems.
  if (env?.backends?.onnx?.wasm) {
    env.backends.onnx.wasm.numThreads = self.crossOriginIsolated
      ? Math.min(4, self.navigator?.hardwareConcurrency || 4)
      : 1;
  }
}

function resolveDtype(device, requested = 'auto') {
  if (requested && requested !== 'auto') return requested;
  if (device === 'wasm') {
    // ONNX Runtime Web recommends uint8/q8 quantized weights for CPU/WASM.
    return 'q8';
  }
  // Whisper's encoder is sensitive to aggressive quantization. This split is
  // substantially lighter than full fp32 while retaining encoder quality.
  return {
    encoder_model: 'fp32',
    decoder_model_merged: 'q4',
  };
}

async function disposeTranscriber() {
  if (!transcriber) return;
  try {
    if (typeof transcriber.dispose === 'function') await transcriber.dispose();
  } catch (_) {}
  transcriber = null;
}

async function loadModel({ model, device, dtype = 'auto' }) {
  await getLibrary();
  const effectiveDtype = resolveDtype(device, dtype);
  const key = `${model}|${device}|${dtypeKey(effectiveDtype)}`;
  if (transcriber && currentKey === key) {
    return { effectiveDtype };
  }

  await disposeTranscriber();
  currentKey = '';
  currentEffectiveDtype = effectiveDtype;

  const loadOptions = {
    device,
    dtype: effectiveDtype,
    progress_callback: progress => self.postMessage({ type: 'model-progress', progress }),
  };

  transcriber = await pipeline('automatic-speech-recognition', model, loadOptions);
  currentKey = key;
  return { effectiveDtype };
}

function expectedChunkCount(duration, chunkLength, stride) {
  if (!Number.isFinite(duration) || duration <= 0 || duration <= chunkLength) return 1;
  const hop = Math.max(1, chunkLength - 2 * stride);
  return 1 + Math.ceil(Math.max(0, duration - chunkLength) / hop);
}

self.onmessage = async ({ data }) => {
  try {
    if (data.type === 'load') {
      const { effectiveDtype } = await loadModel(data);
      self.postMessage({
        type: 'model-ready',
        id: data.id,
        model: data.model,
        device: data.device,
        dtype: data.dtype || 'auto',
        effectiveDtype,
        wasmThreads: env?.backends?.onnx?.wasm?.numThreads || 1,
      });
      return;
    }

    if (data.type === 'transcribe') {
      const { effectiveDtype } = await loadModel({
        model: data.model,
        device: data.device,
        dtype: data.dtype || 'auto',
      });

      const audio = new Float32Array(data.audioBuffer);
      const duration = audio.length / 16000;
      const chunkLength = Math.max(10, Math.min(30, Number(data.options.chunkLength) || 30));
      const strideLength = Math.max(0, Math.min(Math.min(5, chunkLength / 4), Number(data.options.strideLength) || 0));
      const totalChunks = expectedChunkCount(duration, chunkLength, strideLength);
      let completedChunks = 0;
      const started = performance.now();

      const options = {
        task: data.options.task,
        force_full_sequences: false,
      };
      if (data.options.language) options.language = data.options.language;
      if (data.options.timestamps === 'word') options.return_timestamps = 'word';
      else if (data.options.timestamps === 'segment') options.return_timestamps = true;
      else options.return_timestamps = false;

      // Whisper natively handles <=30 s. For longer files use pipeline chunking,
      // but expose each completed chunk to the UI so it never looks frozen.
      if (duration > chunkLength) {
        options.chunk_length_s = chunkLength;
        options.stride_length_s = strideLength;
        options.chunk_callback = () => {
          completedChunks += 1;
          self.postMessage({
            type: 'inference-progress',
            id: data.id,
            completed: completedChunks,
            total: totalChunks,
            progress: Math.min(99, (completedChunks / totalChunks) * 100),
            elapsedMs: performance.now() - started,
          });
        };
      }

      self.postMessage({
        type: 'inference-start',
        id: data.id,
        duration,
        totalChunks,
        chunkLength,
        strideLength,
        effectiveDtype,
      });

      const result = await transcriber(audio, options);
      self.postMessage({
        type: 'inference-progress',
        id: data.id,
        completed: totalChunks,
        total: totalChunks,
        progress: 100,
        elapsedMs: performance.now() - started,
      });
      self.postMessage({
        type: 'transcription-result',
        id: data.id,
        result,
        stats: {
          duration,
          elapsedMs: performance.now() - started,
          totalChunks,
          chunkLength,
          strideLength,
          effectiveDtype,
        },
      });
      return;
    }

    if (data.type === 'dispose') {
      await disposeTranscriber();
      currentKey = '';
      self.postMessage({ type: 'disposed' });
    }
  } catch (error) {
    self.postMessage({
      type: 'error',
      id: data?.id,
      phase: data?.type || 'unknown',
      error: error?.message || String(error),
      stack: error?.stack || '',
    });
  }
};
