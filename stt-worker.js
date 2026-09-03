let pipeline = null;
let env = null;
let transcriber = null;
let currentModel = null;
let currentDevice = null;
let currentDtype = 'auto';

async function getLibrary() {
  if (!pipeline) {
    const lib = await import('https://cdn.jsdelivr.net/npm/@huggingface/transformers@4.2.0');
    pipeline = lib.pipeline;
    env = lib.env;
    env.useBrowserCache = true;
    env.useWasmCache = true;
  }
}

async function loadModel({ model, device, dtype = 'auto' }) {
  await getLibrary();
  if (transcriber && currentModel === model && currentDevice === device && currentDtype === dtype) return;
  transcriber = null;
  currentModel = model;
  currentDevice = device;
  currentDtype = dtype;
  const loadOptions = {
    device,
    progress_callback: progress => self.postMessage({ type: 'model-progress', progress })
  };
  if (dtype && dtype !== 'auto') loadOptions.dtype = dtype;
  transcriber = await pipeline('automatic-speech-recognition', model, loadOptions);
}

self.onmessage = async ({ data }) => {
  try {
    if (data.type === 'load') {
      await loadModel(data);
      self.postMessage({ type: 'model-ready', model: data.model, device: data.device, dtype: data.dtype || 'auto' });
      return;
    }
    if (data.type === 'transcribe') {
      await loadModel({ model: data.model, device: data.device, dtype: data.dtype || 'auto' });
      const audio = new Float32Array(data.audioBuffer);
      const options = {
        chunk_length_s: data.options.chunkLength,
        stride_length_s: data.options.strideLength,
        task: data.options.task
      };
      if (data.options.language) options.language = data.options.language;
      if (data.options.timestamps === 'word') options.return_timestamps = 'word';
      else if (data.options.timestamps === 'segment') options.return_timestamps = true;
      else options.return_timestamps = false;

      self.postMessage({ type: 'inference-start' });
      const result = await transcriber(audio, options);
      self.postMessage({ type: 'transcription-result', id: data.id, result });
      return;
    }
  } catch (error) {
    self.postMessage({ type: 'error', id: data.id, error: error?.message || String(error), stack: error?.stack || '' });
  }
};
