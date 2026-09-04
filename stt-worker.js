// Local Whisper Studio 2.3 - stable Whisper worker
// Pinned to Transformers.js 3.8.1 because the 4.2.0 / ORT 1.26 line has a
// confirmed quantized Whisper session-creation regression (Missing required scale).
let pipeline = null;
let env = null;
let transcriber = null;
let currentKey = '';
let currentEffectiveDtype = null;
let currentRequestKey = '';
let runtimeVersion = '3.8.1';

function dtypeKey(x) {
  return typeof x === 'string' ? x : JSON.stringify(x);
}

function errorText(error) {
  return String(error?.message || error || 'Unknown error');
}

function isQuantizedSessionError(error) {
  const s = errorText(error);
  return /Missing required scale|TransposeDQWeightsForMatMulNBits|qdq_actions\.cc|DequantizeLinear|MatMulNBits|Can't create a session|Cannot create a session/i.test(s);
}

async function getLibrary() {
  if (pipeline) return;
  // 3.8.1 is intentionally pinned: it uses an older ORT-Web generation that
  // is compatible with the current onnx-community Whisper q4/q8 exports.
  const lib = await import('https://cdn.jsdelivr.net/npm/@huggingface/transformers@3.8.1');
  pipeline = lib.pipeline;
  env = lib.env;
  env.useBrowserCache = true;
  // Safe if unavailable in this release; assigning an extra property is harmless.
  try { env.useWasmCache = true; } catch (_) {}

  if (env?.backends?.onnx?.wasm) {
    env.backends.onnx.wasm.numThreads = self.crossOriginIsolated
      ? Math.min(4, self.navigator?.hardwareConcurrency || 4)
      : 1;
  }
}

function autoDtypeCandidates(device) {
  if (device === 'wasm') {
    return ['q8', 'fp32'];
  }
  return [
    { encoder_model: 'fp32', decoder_model_merged: 'q4' },
    { encoder_model: 'fp32', decoder_model_merged: 'fp32' },
    'fp32',
  ];
}

function requestedDtypeCandidates(device, requested = 'auto') {
  if (!requested || requested === 'auto') return autoDtypeCandidates(device);

  const out = [requested];
  // Explicit reduced precision remains user-selectable, but session creation
  // automatically falls back to full precision instead of leaving the UI stuck.
  if (requested !== 'fp32') {
    if (device === 'webgpu') out.push({ encoder_model: 'fp32', decoder_model_merged: 'fp32' });
    out.push('fp32');
  }
  return out;
}

async function disposeTranscriber() {
  if (!transcriber) return;
  try {
    if (typeof transcriber.dispose === 'function') await transcriber.dispose();
  } catch (_) {}
  transcriber = null;
}

async function tryLoadModel(model, device, effectiveDtype) {
  const key = `${model}|${device}|${dtypeKey(effectiveDtype)}|tjs-${runtimeVersion}`;
  if (transcriber && currentKey === key) return { effectiveDtype };

  await disposeTranscriber();
  currentKey = '';

  const loadOptions = {
    device,
    dtype: effectiveDtype,
    progress_callback: progress => self.postMessage({ type: 'model-progress', progress }),
  };
  transcriber = await pipeline('automatic-speech-recognition', model, loadOptions);
  currentKey = key;
  currentEffectiveDtype = effectiveDtype;
  return { effectiveDtype };
}

async function loadModel({ model, device, dtype = 'auto' }) {
  await getLibrary();
  const requestKey = `${model}|${device}|${dtype}|tjs-${runtimeVersion}`;
  if (transcriber && currentRequestKey === requestKey) {
    return { effectiveDtype: currentEffectiveDtype };
  }
  const candidates = requestedDtypeCandidates(device, dtype);
  let lastError = null;

  for (let i = 0; i < candidates.length; i++) {
    const candidate = candidates[i];
    try {
      const loaded = await tryLoadModel(model, device, candidate);
      currentRequestKey = requestKey;
      if (i > 0) {
        self.postMessage({
          type: 'model-fallback',
          from: candidates[0],
          to: candidate,
          reason: errorText(lastError),
          runtimeVersion,
        });
      }
      return loaded;
    } catch (error) {
      lastError = error;
      await disposeTranscriber();
      currentKey = '';
      currentRequestKey = '';
      // Network/model-not-found errors should not trigger multiple large downloads.
      // Quantized-session/precision errors are safe to retry with fp32.
      if (!isQuantizedSessionError(error) && dtype === 'auto' && i === 0) {
        // Still allow one safe fallback for WebGPU shader/precision startup errors.
        if (device !== 'webgpu') throw error;
      }
      if (i === candidates.length - 1) throw error;
    }
  }
  throw lastError || new Error('모델을 불러오지 못했습니다.');
}

function chunkPlan(duration, chunkLength, overlap) {
  if (!Number.isFinite(duration) || duration <= 0) return [{ start: 0, end: 0, keepStart: 0, keepEnd: 0 }];
  if (duration <= chunkLength) return [{ start: 0, end: duration, keepStart: 0, keepEnd: duration }];

  const hop = Math.max(1, chunkLength - overlap);
  const items = [];
  let start = 0;
  while (start < duration - 0.001) {
    const end = Math.min(duration, start + chunkLength);
    const isFirst = items.length === 0;
    const isLast = end >= duration - 0.001;
    items.push({
      start,
      end,
      // Split overlap ownership at the midpoint to avoid duplicate text.
      keepStart: isFirst ? start : start + overlap / 2,
      keepEnd: isLast ? end : end - overlap / 2,
    });
    if (isLast) break;
    start += hop;
  }
  return items;
}

function normalizeLocalChunks(result, offset, keepStart, keepEnd) {
  const raw = Array.isArray(result?.chunks) ? result.chunks : [];
  const out = [];
  for (const c of raw) {
    const ts = c.timestamp || c.timestamps || [0, null];
    let s = Number(ts?.[0] ?? 0) + offset;
    let e = ts?.[1] == null ? s + 0.01 : Number(ts[1]) + offset;
    if (!Number.isFinite(s)) continue;
    if (!Number.isFinite(e)) e = s + 0.01;
    const mid = (s + e) / 2;
    if (mid < keepStart - 1e-6 || mid >= keepEnd + 1e-6) continue;
    out.push({ timestamp: [Math.max(s, keepStart), Math.min(Math.max(e, s), keepEnd)], text: String(c.text || '') });
  }
  return out;
}

function textFromChunks(chunks, wordMode = false) {
  if (!chunks.length) return '';
  if (wordMode) return chunks.map(c => c.text || '').join('').trim();
  return chunks.map(c => String(c.text || '').trim()).filter(Boolean).join(' ').replace(/\s+/g, ' ').trim();
}

async function transcribeManualChunks(data, effectiveDtype) {
  const audio = new Float32Array(data.audioBuffer);
  const duration = audio.length / 16000;
  const chunkLength = Math.max(10, Math.min(30, Number(data.options.chunkLength) || 30));
  const overlap = Math.max(0, Math.min(5, chunkLength / 4, Number(data.options.strideLength) || 0));
  const plan = chunkPlan(duration, chunkLength, overlap);
  const started = performance.now();
  const requestedTs = data.options.timestamps || 'segment';
  const allChunks = [];
  const textPieces = [];

  self.postMessage({
    type: 'inference-start', id: data.id, duration,
    totalChunks: plan.length, chunkLength, strideLength: overlap,
    effectiveDtype, runtimeVersion,
  });

  for (let i = 0; i < plan.length; i++) {
    const part = plan[i];
    const a = Math.max(0, Math.floor(part.start * 16000));
    const b = Math.min(audio.length, Math.ceil(part.end * 16000));
    const chunkAudio = audio.slice(a, b);

    const options = {
      task: data.options.task,
      force_full_sequences: false,
      // Always request timestamps internally so overlap can be deduplicated.
      return_timestamps: requestedTs === 'word' ? 'word' : true,
    };
    if (data.options.language) options.language = data.options.language;

    const local = await transcriber(chunkAudio, options);
    const accepted = normalizeLocalChunks(local, part.start, part.keepStart, part.keepEnd);
    allChunks.push(...accepted);

    let piece = textFromChunks(accepted, requestedTs === 'word');
    if (!piece) piece = String(local?.text || '').trim();
    if (piece) textPieces.push(piece);

    self.postMessage({
      type: 'inference-progress', id: data.id,
      completed: i + 1, total: plan.length,
      progress: ((i + 1) / plan.length) * 100,
      elapsedMs: performance.now() - started,
      chunkStart: part.start, chunkEnd: part.end,
    });

    // Yield to the Worker event loop between chunks. This improves cancellation
    // responsiveness and gives browser runtimes a chance to reclaim temporary CPU buffers.
    await new Promise(resolve => setTimeout(resolve, 0));
  }

  const result = {
    text: textPieces.join(' ').replace(/\s+/g, ' ').trim(),
    chunks: requestedTs === 'none' ? [] : allChunks,
  };
  return {
    result,
    stats: {
      duration,
      elapsedMs: performance.now() - started,
      totalChunks: plan.length,
      chunkLength,
      strideLength: overlap,
      effectiveDtype,
      runtimeVersion,
      manualChunking: true,
    },
  };
}

self.onmessage = async ({ data }) => {
  try {
    if (data.type === 'load') {
      const { effectiveDtype } = await loadModel(data);
      self.postMessage({
        type: 'model-ready', id: data.id, model: data.model, device: data.device,
        dtype: data.dtype || 'auto', effectiveDtype,
        wasmThreads: env?.backends?.onnx?.wasm?.numThreads || 1,
        runtimeVersion,
      });
      return;
    }

    if (data.type === 'transcribe') {
      const { effectiveDtype } = await loadModel({
        model: data.model, device: data.device, dtype: data.dtype || 'auto',
      });
      const bundle = await transcribeManualChunks(data, effectiveDtype);
      self.postMessage({
        type: 'transcription-result', id: data.id,
        result: bundle.result, stats: bundle.stats,
      });
      return;
    }

    if (data.type === 'dispose') {
      await disposeTranscriber();
      currentKey = '';
      currentRequestKey = '';
      self.postMessage({ type: 'disposed' });
    }
  } catch (error) {
    self.postMessage({
      type: 'error', id: data.id,
      error: errorText(error),
      stack: error?.stack || '',
      runtimeVersion,
    });
  }
};
