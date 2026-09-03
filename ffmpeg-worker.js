let ffmpeg = null;

const DEFAULT_CORE = 'https://cdn.jsdelivr.net/npm/@ffmpeg/core@0.12.10/dist/esm/ffmpeg-core.js';

async function loadCore({ coreURL = DEFAULT_CORE, wasmURL = null } = {}) {
  const first = !ffmpeg;
  if (ffmpeg) return false;
  const mod = await import(/* @vite-ignore */ coreURL);
  const factory = mod.default || self.createFFmpegCore;
  if (!factory) throw new Error('FFmpeg core factory를 불러오지 못했습니다.');
  const resolvedWasm = wasmURL || coreURL.replace(/\.js$/i, '.wasm');
  const mainScriptUrlOrBlob = `${coreURL}#${btoa(JSON.stringify({ wasmURL: resolvedWasm, workerURL: '' }))}`;
  ffmpeg = await factory({ mainScriptUrlOrBlob });
  ffmpeg.setLogger(data => self.postMessage({ type: 'log', data }));
  ffmpeg.setProgress(data => self.postMessage({ type: 'progress', data }));
  return first;
}

function ensureLoaded() {
  if (!ffmpeg) throw new Error('FFmpeg 엔진이 아직 준비되지 않았습니다.');
}

self.onmessage = async ({ data: message }) => {
  const { id, type, data } = message;
  try {
    let out;
    switch (type) {
      case 'load':
        out = await loadCore(data || {});
        break;
      case 'exec':
        ensureLoaded();
        ffmpeg.setTimeout(data.timeout ?? -1);
        ffmpeg.exec('-nostdin', '-y', ...data.args);
        out = ffmpeg.ret;
        ffmpeg.reset();
        break;
      case 'writeFile':
        ensureLoaded();
        ffmpeg.FS.writeFile(data.path, data.data);
        out = true;
        break;
      case 'readFile': {
        ensureLoaded();
        const bytes = ffmpeg.FS.readFile(data.path);
        out = bytes;
        self.postMessage({ id, type: 'result', data: out }, [out.buffer]);
        return;
      }
      case 'deleteFile':
        ensureLoaded();
        try { ffmpeg.FS.unlink(data.path); } catch (_) {}
        out = true;
        break;
      default:
        throw new Error(`알 수 없는 FFmpeg 명령: ${type}`);
    }
    self.postMessage({ id, type: 'result', data: out });
  } catch (error) {
    self.postMessage({ id, type: 'error', error: error?.message || String(error) });
  }
};
