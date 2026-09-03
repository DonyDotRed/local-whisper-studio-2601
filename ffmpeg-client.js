// Minimal same-origin FFmpeg.wasm client for static hosting.
// Uses @ffmpeg/core's public Emscripten API in a local module Worker.
export class StaticFFmpeg {
  constructor(workerUrl = './ffmpeg-worker.js') {
    this.workerUrl = workerUrl;
    this.worker = null;
    this.seq = 0;
    this.pending = new Map();
    this.listeners = { log: new Set(), progress: new Set() };
    this.loaded = false;
  }

  on(type, fn) { this.listeners[type]?.add(fn); }
  off(type, fn) { this.listeners[type]?.delete(fn); }

  _ensureWorker() {
    if (this.worker) return;
    this.worker = new Worker(new URL(this.workerUrl, import.meta.url), { type: 'module' });
    this.worker.onmessage = ({ data }) => {
      if (data.type === 'log' || data.type === 'progress') {
        this.listeners[data.type]?.forEach(fn => fn(data.data));
        return;
      }
      const job = this.pending.get(data.id);
      if (!job) return;
      this.pending.delete(data.id);
      if (data.type === 'error') job.reject(new Error(data.error || 'FFmpeg worker error'));
      else job.resolve(data.data);
    };
    this.worker.onerror = (event) => {
      for (const [, job] of this.pending) job.reject(event.error || new Error(event.message || 'FFmpeg worker crashed'));
      this.pending.clear();
    };
  }

  _call(type, data, transfer = []) {
    this._ensureWorker();
    const id = ++this.seq;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.worker.postMessage({ id, type, data }, transfer);
    });
  }

  async load(config = {}) {
    const result = await this._call('load', config);
    this.loaded = true;
    return result;
  }
  exec(args, timeout = -1) { return this._call('exec', { args, timeout }); }
  writeFile(path, bytes) {
    const data = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
    return this._call('writeFile', { path, data }, [data.buffer]);
  }
  readFile(path) { return this._call('readFile', { path }); }
  deleteFile(path) { return this._call('deleteFile', { path }); }
  terminate() {
    if (this.worker) this.worker.terminate();
    this.worker = null;
    this.loaded = false;
    for (const [, job] of this.pending) job.reject(new Error('FFmpeg terminated'));
    this.pending.clear();
  }
}
