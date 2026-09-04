import { StaticFFmpeg } from './ffmpeg-client.js';

const $ = (id) => document.getElementById(id);
const els = Object.fromEntries([
  'fileInput','dropZone','sampleBtn','queueList','queueCount','clearQueueBtn','recordBtn','pauseRecordBtn','stopRecordBtn','recordTimer','meterCanvas','micSelect','micStatus',
  'currentFileName','currentFileMeta','waveform','audioPlayer','playBtn','back10Btn','forward10Btn','timeDisplay','seekBar','speedSelect',
  'rangeStart','rangeEnd','setStartBtn','setEndBtn','playRangeBtn','loadFfmpegBtn','convertBtn','convertRangeBtn','convertProgress','convertStatus','ffmpegBadge',
  'sampleRateSelect','channelSelect','customWavOptions','performancePreset','engineSelect','modelSelect','languageSelect','taskSelect','timestampSelect','dtypeSelect','chunkLength','strideLength','rangeOnlyCheckbox',
  'loadModelBtn','transcribeBtn','batchTranscribeBtn','cancelSttBtn','modelProgress','sttStatus','sttMetrics','engineBadge','transcriptView','transcriptEditor','showTimestamps','autoScrollTranscript',
  'copyBtn','downloadTxtBtn','downloadMdBtn','downloadSrtBtn','downloadVttBtn','downloadJsonBtn','clearTranscriptBtn','clearAiCacheBtn','refreshSystemBtn','systemCards','themeBtn','installBtn','helpBtn','helpDialog','toast','footerStatus'
].map(id => [id, $(id)]));

const state = {
  items: [],
  currentId: null,
  nextId: 1,
  waveform: null,
  waveformDuration: 0,
  ffmpeg: null,
  ffmpegLoaded: false,
  sttWorker: null,
  sttReadyKey: '',
  sttPending: new Map(),
  sttBusy: false,
  batchRunning: false,
  mediaRecorder: null,
  mediaStream: null,
  recordChunks: [],
  recordStart: 0,
  pauseStart: 0,
  pausedTotal: 0,
  timerRaf: 0,
  meterRaf: 0,
  recordAudioContext: null,
  deferredInstallPrompt: null,
  playRangeEnd: null,
  webgpuAvailable: false,
  sttStartedAt: 0,
  sttLastProgressAt: 0,
  sttCompletedChunks: 0,
  sttTotalChunks: 0,
  sttTicker: 0
};

const SETTINGS_KEY = 'local-whisper-studio-settings-v2-2';
const settingsFields = ['performancePreset','engineSelect','modelSelect','languageSelect','taskSelect','timestampSelect','dtypeSelect','chunkLength','strideLength','speedSelect','showTimestamps','autoScrollTranscript'];

function toast(message, ms = 2600) {
  els.toast.textContent = message;
  els.toast.classList.add('show');
  clearTimeout(toast._t);
  toast._t = setTimeout(() => els.toast.classList.remove('show'), ms);
}

function safeName(name) {
  return (name || 'audio').replace(/[\\/:*?"<>|]+/g, '_').replace(/\s+/g, ' ').trim();
}

function baseName(name) {
  return safeName(name).replace(/\.[^.]+$/, '') || 'audio';
}

function extName(name) {
  const m = safeName(name).match(/\.([a-zA-Z0-9]{1,8})$/);
  return m ? `.${m[1].toLowerCase()}` : '.bin';
}

function formatBytes(bytes) {
  if (!Number.isFinite(bytes)) return '-';
  const u = ['B','KB','MB','GB'];
  let i = 0, n = bytes;
  while (n >= 1024 && i < u.length - 1) { n /= 1024; i++; }
  return `${n.toFixed(i ? 1 : 0)} ${u[i]}`;
}

function formatTime(sec, withMs = false) {
  sec = Math.max(0, Number(sec) || 0);
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = Math.floor(sec % 60);
  const ms = Math.floor((sec - Math.floor(sec)) * 1000);
  const base = h > 0
    ? `${String(h).padStart(2,'0')}:${String(m).padStart(2,'0')}:${String(s).padStart(2,'0')}`
    : `${String(m).padStart(2,'0')}:${String(s).padStart(2,'0')}`;
  return withMs ? `${base}.${String(ms).padStart(3,'0')}` : base;
}

function srtTime(sec) {
  sec = Math.max(0, Number(sec) || 0);
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = Math.floor(sec % 60);
  const ms = Math.round((sec - Math.floor(sec)) * 1000);
  return `${String(h).padStart(2,'0')}:${String(m).padStart(2,'0')}:${String(s).padStart(2,'0')},${String(ms).padStart(3,'0')}`;
}

function vttTime(sec) { return srtTime(sec).replace(',', '.'); }
function escapeHtml(text) { return String(text ?? '').replace(/[&<>'"]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;',"'":'&#39;','"':'&quot;'}[c])); }

function currentItem() { return state.items.find(x => x.id === state.currentId) || null; }

function setStatus(item, status, label = status) {
  item.status = status;
  item.statusLabel = label;
  renderQueue();
}

function addFiles(files) {
  const valid = [...files].filter(f => f && (f.type.startsWith('audio/') || /\.(m4a|aac|mp3|wav|webm|ogg|flac|mp4)$/i.test(f.name)));
  if (!valid.length) return toast('지원되는 오디오 파일을 찾지 못했습니다.');
  for (const file of valid) {
    state.items.push({
      id: state.nextId++, file, url: URL.createObjectURL(file), status: 'ready', statusLabel: '대기', duration: null,
      transcript: '', chunks: [], wavBlob: null, createdAt: new Date().toISOString()
    });
  }
  if (!state.currentId) selectItem(state.items[0].id);
  renderQueue();
  toast(`${valid.length}개 파일을 추가했습니다.`);
}

function removeItem(id) {
  const idx = state.items.findIndex(x => x.id === id);
  if (idx < 0) return;
  const [item] = state.items.splice(idx, 1);
  URL.revokeObjectURL(item.url);
  if (state.currentId === id) {
    state.currentId = state.items[idx]?.id || state.items[idx - 1]?.id || null;
    if (state.currentId) selectItem(state.currentId); else clearCurrent();
  }
  renderQueue();
}

function clearCurrent() {
  els.audioPlayer.pause();
  els.audioPlayer.removeAttribute('src');
  els.currentFileName.textContent = '선택된 파일 없음';
  els.currentFileMeta.textContent = '파일을 추가하거나 녹음을 시작하세요.';
  state.waveform = null;
  drawWaveform();
  updateControls();
  renderTranscript(null);
}

async function selectItem(id) {
  const item = state.items.find(x => x.id === id);
  if (!item) return;
  state.currentId = id;
  renderQueue();
  els.audioPlayer.pause();
  els.audioPlayer.src = item.url;
  els.audioPlayer.load();
  els.currentFileName.textContent = item.file.name;
  els.currentFileMeta.textContent = `${formatBytes(item.file.size)} · ${item.file.type || 'audio'} · ${item.duration ? formatTime(item.duration) : '길이 확인 중'}`;
  // v2.3: 파일 선택 시 전체 오디오를 즉시 decode하지 않는다.
  // 큰 파일에서 UI가 느려지는 가장 큰 원인이었던 중복 decode를 제거한다.
  state.waveform = item.waveform || null;
  state.waveformDuration = item.duration || 0;
  drawWaveform();
  renderTranscript(item);
  updateControls();
}

function renderQueue() {
  els.queueCount.textContent = String(state.items.length);
  if (!state.items.length) {
    els.queueList.className = 'queue-list empty-state';
    els.queueList.textContent = '파일을 추가하세요.';
    return;
  }
  els.queueList.className = 'queue-list';
  els.queueList.innerHTML = state.items.map(item => `
    <div class="queue-item ${item.id === state.currentId ? 'active' : ''}" data-id="${item.id}">
      <div class="name" title="${escapeHtml(item.file.name)}">${escapeHtml(item.file.name)}</div>
      <div class="meta">${formatBytes(item.file.size)}${item.duration ? ` · ${formatTime(item.duration)}` : ''}</div>
      <div class="status">${escapeHtml(item.statusLabel || '대기')}</div>
      <button class="remove" data-remove="${item.id}" title="제거">✕</button>
    </div>`).join('');
  els.queueList.querySelectorAll('.queue-item').forEach(el => el.addEventListener('click', e => {
    if (e.target.closest('[data-remove]')) return;
    selectItem(Number(el.dataset.id));
  }));
  els.queueList.querySelectorAll('[data-remove]').forEach(btn => btn.addEventListener('click', e => {
    e.stopPropagation(); removeItem(Number(btn.dataset.remove));
  }));
}

function updateControls() {
  const has = !!currentItem();
  ['playBtn','back10Btn','forward10Btn','seekBar','setStartBtn','setEndBtn','playRangeBtn','convertBtn','convertRangeBtn','transcribeBtn'].forEach(k => els[k].disabled = !has || (k === 'transcribeBtn' && state.sttBusy));
  const item = currentItem();
  const hasText = !!(item?.transcript?.trim());
  ['copyBtn','downloadTxtBtn','downloadMdBtn','downloadJsonBtn'].forEach(k => els[k].disabled = !hasText);
  ['downloadSrtBtn','downloadVttBtn'].forEach(k => els[k].disabled = !hasText || !(item?.chunks?.length));
}

async function decodeBlob(blob) {
  const AudioCtx = window.AudioContext || window.webkitAudioContext;
  if (!AudioCtx) throw new Error('AudioContext를 지원하지 않는 브라우저입니다.');
  const ctx = new AudioCtx();
  try {
    const arr = await blob.arrayBuffer();
    return await ctx.decodeAudioData(arr);
  } finally {
    await ctx.close().catch(() => {});
  }
}

async function resampleMono16k(audioBuffer) {
  // 이미 Whisper 입력 규격이면 OfflineAudioContext를 만들지 않는다.
  if (audioBuffer.sampleRate === 16000 && audioBuffer.numberOfChannels === 1) {
    return audioBuffer.getChannelData(0).slice();
  }
  const OfflineCtx = window.OfflineAudioContext || window.webkitOfflineAudioContext;
  if (!OfflineCtx) throw new Error('OfflineAudioContext를 지원하지 않습니다.');
  const frames = Math.max(1, Math.ceil(audioBuffer.duration * 16000));
  const offline = new OfflineCtx(1, frames, 16000);
  const source = offline.createBufferSource();
  source.buffer = audioBuffer;
  source.connect(offline.destination);
  source.start(0);
  const rendered = await offline.startRendering();
  return rendered.getChannelData(0).slice();
}

function waveformFromPcm(item, audio, duration) {
  const bins = 900;
  const step = Math.max(1, Math.floor(audio.length / bins));
  const wave = new Float32Array(Math.min(bins, Math.ceil(audio.length / step)));
  for (let i = 0; i < wave.length; i++) {
    let peak = 0;
    const start = i * step, end = Math.min(audio.length, start + step);
    for (let j = start; j < end; j += 4) peak = Math.max(peak, Math.abs(audio[j]));
    wave[i] = peak;
  }
  item.waveform = wave;
  item.duration = duration || item.duration;
  if (item.id === state.currentId) {
    state.waveform = wave;
    state.waveformDuration = item.duration || duration || 0;
    drawWaveform();
    renderQueue();
  }
}

async function analyzeForWaveform(item) {
  const buffer = await decodeBlob(item.file);
  item.duration = buffer.duration;
  state.waveformDuration = buffer.duration;
  const samples = buffer.getChannelData(0);
  const bins = 900;
  const step = Math.max(1, Math.floor(samples.length / bins));
  const wave = new Float32Array(Math.min(bins, Math.ceil(samples.length / step)));
  for (let i = 0; i < wave.length; i++) {
    let peak = 0;
    const start = i * step, end = Math.min(samples.length, start + step);
    for (let j = start; j < end; j += 2) peak = Math.max(peak, Math.abs(samples[j]));
    wave[i] = peak;
  }
  state.waveform = wave;
  els.rangeStart.value = '0';
  els.rangeEnd.value = buffer.duration.toFixed(1);
  els.currentFileMeta.textContent = `${formatBytes(item.file.size)} · ${item.file.type || 'audio'} · ${formatTime(item.duration)}`;
  renderQueue(); drawWaveform(); updateTimeUI();
}

function canvasColors() {
  const s = getComputedStyle(document.documentElement);
  return { accent: s.getPropertyValue('--accent').trim(), line: s.getPropertyValue('--line').trim(), muted: s.getPropertyValue('--muted').trim(), panel2: s.getPropertyValue('--panel-2').trim() };
}

function drawWaveform() {
  const c = els.waveform, ctx = c.getContext('2d');
  const dpr = window.devicePixelRatio || 1;
  const rect = c.getBoundingClientRect();
  const w = Math.max(1, Math.floor(rect.width * dpr)), h = Math.max(1, Math.floor(rect.height * dpr));
  if (c.width !== w || c.height !== h) { c.width = w; c.height = h; }
  const colors = canvasColors();
  ctx.clearRect(0,0,w,h); ctx.fillStyle = colors.panel2; ctx.fillRect(0,0,w,h);
  ctx.strokeStyle = colors.line; ctx.lineWidth = 1 * dpr; ctx.beginPath(); ctx.moveTo(0,h/2); ctx.lineTo(w,h/2); ctx.stroke();
  if (!state.waveform?.length) {
    ctx.fillStyle = colors.muted; ctx.textAlign = 'center'; ctx.font = `${12*dpr}px sans-serif`; ctx.fillText('오디오 파형', w/2, h/2 + 4*dpr); return;
  }
  const start = Number(els.rangeStart.value) || 0, end = Number(els.rangeEnd.value) || state.waveformDuration;
  if (state.waveformDuration > 0 && end > start) {
    ctx.fillStyle = `${colors.accent}18`;
    ctx.fillRect((start/state.waveformDuration)*w, 0, ((end-start)/state.waveformDuration)*w, h);
  }
  ctx.strokeStyle = colors.accent; ctx.lineWidth = Math.max(1, dpr); ctx.beginPath();
  const mid = h/2;
  for (let i=0;i<state.waveform.length;i++) {
    const x = i/(state.waveform.length-1)*w; const amp = state.waveform[i]*h*.43;
    ctx.moveTo(x,mid-amp); ctx.lineTo(x,mid+amp);
  }
  ctx.stroke();
  const dur = els.audioPlayer.duration || state.waveformDuration;
  if (dur > 0) {
    const x = (els.audioPlayer.currentTime/dur)*w;
    ctx.strokeStyle = colors.muted; ctx.lineWidth = 1.5*dpr; ctx.beginPath(); ctx.moveTo(x,0); ctx.lineTo(x,h); ctx.stroke();
  }
}

function updateTimeUI() {
  const p = els.audioPlayer, dur = Number.isFinite(p.duration) ? p.duration : (currentItem()?.duration || 0);
  els.timeDisplay.textContent = `${formatTime(p.currentTime)} / ${formatTime(dur)}`;
  els.seekBar.value = dur ? Math.round((p.currentTime / dur) * 1000) : 0;
  drawWaveform(); highlightTranscriptAt(p.currentTime);
}

function highlightTranscriptAt(time) {
  if (!els.autoScrollTranscript.checked) return;
  let active = null;
  els.transcriptView.querySelectorAll('.segment').forEach(el => {
    const s = Number(el.dataset.start), e = Number(el.dataset.end);
    const yes = time >= s && time <= e;
    el.classList.toggle('active', yes);
    if (yes) active = el;
  });
  if (active && !active.matches(':hover')) active.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
}

async function ensureFFmpeg() {
  if (state.ffmpegLoaded) return state.ffmpeg;
  els.ffmpegBadge.textContent = 'FFmpeg 로딩'; els.ffmpegBadge.className = 'badge warn';
  els.convertStatus.textContent = 'FFmpeg WebAssembly 엔진을 불러오는 중...';
  if (!state.ffmpeg) {
    state.ffmpeg = new StaticFFmpeg('./ffmpeg-worker.js');
    state.ffmpeg.on('progress', ({ progress }) => {
      const pct = Math.max(0, Math.min(100, (progress || 0) * 100));
      els.convertProgress.style.width = `${pct}%`;
    });
    state.ffmpeg.on('log', ({ message }) => { if (message) els.convertStatus.textContent = message.slice(0, 130); });
  }
  await state.ffmpeg.load();
  state.ffmpegLoaded = true;
  els.ffmpegBadge.textContent = 'FFmpeg 준비됨'; els.ffmpegBadge.className = 'badge ok';
  els.convertStatus.textContent = '변환 엔진 준비 완료';
  return state.ffmpeg;
}

function wavSettings() {
  const preset = document.querySelector('input[name="wavPreset"]:checked')?.value || 'stt';
  if (preset === 'stt') return { sampleRate: 16000, channels: 1 };
  if (preset === 'original') return { sampleRate: 48000, channels: 2 };
  return { sampleRate: Number(els.sampleRateSelect.value), channels: Number(els.channelSelect.value) };
}

async function convertItemToWav(item, { range = false, download = true, forceStt = false } = {}) {
  if (!item) throw new Error('변환할 파일이 없습니다.');
  const ffmpeg = await ensureFFmpeg();
  els.convertProgress.style.width = '0%';
  setStatus(item, 'converting', 'WAV 변환 중');
  const input = `input_${item.id}${extName(item.file.name)}`;
  const output = `output_${item.id}_${Date.now()}.wav`;
  const bytes = new Uint8Array(await item.file.arrayBuffer());
  await ffmpeg.writeFile(input, bytes);
  const cfg = forceStt ? { sampleRate: 16000, channels: 1 } : wavSettings();
  const args = [];
  if (range) {
    const s = Math.max(0, Number(els.rangeStart.value) || 0), e = Math.max(s, Number(els.rangeEnd.value) || 0);
    args.push('-ss', String(s));
    if (e > s) args.push('-to', String(e));
  }
  args.push('-i', input, '-vn', '-ac', String(cfg.channels), '-ar', String(cfg.sampleRate), '-c:a', 'pcm_s16le', output);
  const code = await ffmpeg.exec(args);
  if (code !== 0) throw new Error(`FFmpeg 변환 실패 (exit ${code})`);
  const out = await ffmpeg.readFile(output);
  const blob = new Blob([out], { type: 'audio/wav' });
  if (!range && cfg.sampleRate === 16000 && cfg.channels === 1) item.wavBlob = blob;
  await ffmpeg.deleteFile(input); await ffmpeg.deleteFile(output);
  els.convertProgress.style.width = '100%';
  els.convertStatus.textContent = `완료 · WAV ${formatBytes(blob.size)} · ${cfg.sampleRate/1000} kHz · ${cfg.channels === 1 ? 'Mono' : 'Stereo'}`;
  setStatus(item, 'ready', item.transcript ? 'STT 완료' : '대기');
  if (download) downloadBlob(blob, `${baseName(item.file.name)}${range ? '_range' : ''}_${cfg.sampleRate}Hz.wav`);
  return blob;
}

async function audioToFloat32(item, rangeOnly = false) {
  let source = item.wavBlob || item.file;
  let decoded;
  const prepStart = performance.now();
  els.sttMetrics.textContent = `오디오 준비 중 · ${formatBytes(item.file.size)} · 전체 decode 1회`;
  try {
    decoded = await decodeBlob(source);
  } catch (firstError) {
    els.sttStatus.textContent = '브라우저 디코딩 불가 → FFmpeg로 16 kHz mono WAV 변환 중...';
    source = await convertItemToWav(item, { range: false, download: false, forceStt: true });
    decoded = await decodeBlob(source);
  }
  const decodedDuration = decoded.duration;
  let audio = await resampleMono16k(decoded);
  // STT용 16 kHz PCM으로 파형도 동시에 생성한다. 파일 선택 시 별도 decode하지 않는다.
  waveformFromPcm(item, audio, decodedDuration);
  let offset = 0;
  if (rangeOnly) {
    const s = Math.max(0, Number(els.rangeStart.value) || 0);
    const e = Math.min(decodedDuration, Math.max(s, Number(els.rangeEnd.value) || decodedDuration));
    const a = Math.floor(s * 16000), b = Math.max(a + 1, Math.floor(e * 16000));
    audio = audio.slice(a, Math.min(b, audio.length));
    offset = s;
  }
  const prepSec = (performance.now() - prepStart) / 1000;
  els.sttMetrics.textContent = `오디오 준비 완료 · ${formatTime(audio.length/16000)} · PCM ${(audio.byteLength/1048576).toFixed(1)} MB · ${prepSec.toFixed(1)}초`;
  return { audio, offset, duration: audio.length / 16000, prepSec };
}

async function detectWebGPU() {
  if (!navigator.gpu) return false;
  try {
    const adapter = await Promise.race([
      navigator.gpu.requestAdapter(),
      new Promise(resolve => setTimeout(() => resolve(null), 1800))
    ]);
    return !!adapter;
  } catch { return false; }
}

function selectedDevice() {
  const v = els.engineSelect.value;
  if (v === 'webgpu' && !state.webgpuAvailable) throw new Error('현재 브라우저에서 WebGPU GPU를 사용할 수 없습니다.');
  return v === 'auto' ? (state.webgpuAvailable ? 'webgpu' : 'wasm') : v;
}

function formatEffectiveDtype(dtype) {
  if (!dtype) return 'auto';
  if (typeof dtype === 'string') return dtype;
  return Object.entries(dtype).map(([k,v]) => `${k.replace('_model','')}:${v}`).join(' / ');
}

function applyPerformancePreset(value = els.performancePreset.value, persist = true) {
  if (value === 'fast') {
    els.modelSelect.value = 'onnx-community/whisper-tiny';
    els.dtypeSelect.value = 'auto';
    els.chunkLength.value = '30';
    els.strideLength.value = '3';
  } else if (value === 'balanced') {
    els.modelSelect.value = 'onnx-community/whisper-base';
    els.dtypeSelect.value = 'auto';
    els.chunkLength.value = '30';
    els.strideLength.value = '4';
  } else if (value === 'accurate') {
    els.modelSelect.value = 'onnx-community/whisper-small';
    els.dtypeSelect.value = 'auto';
    els.chunkLength.value = '30';
    els.strideLength.value = '5';
  }
  state.sttReadyKey = '';
  if (persist) saveSettings();
}

function stopSttTicker() {
  if (state.sttTicker) clearInterval(state.sttTicker);
  state.sttTicker = 0;
}

function startSttTicker(device, duration) {
  stopSttTicker();
  state.sttStartedAt = performance.now();
  state.sttLastProgressAt = performance.now();
  state.sttCompletedChunks = 0;
  state.sttTotalChunks = 0;
  state.sttTicker = setInterval(() => {
    if (!state.sttBusy) return stopSttTicker();
    const elapsed = (performance.now() - state.sttStartedAt) / 1000;
    const since = (performance.now() - state.sttLastProgressAt) / 1000;
    const chunkInfo = state.sttTotalChunks
      ? `${state.sttCompletedChunks}/${state.sttTotalChunks} chunks`
      : '첫 chunk 계산 중';
    els.sttMetrics.textContent = `${device === 'webgpu' ? 'GPU WebGPU' : 'CPU WASM'} · ${chunkInfo} · 경과 ${formatTime(elapsed)} · 오디오 ${formatTime(duration)}${since > 25 ? ' · 추론은 계속 실행 중' : ''}`;
  }, 1000);
}

function resetSttWorker() {
  if (state.sttWorker) state.sttWorker.terminate();
  state.sttWorker = null;
  state.sttReadyKey = '';
}

function initSttWorker() {
  if (state.sttWorker) return state.sttWorker;
  const worker = new Worker(new URL('./stt-worker.js?v=2.3.0', import.meta.url), { type: 'module' });
  worker.onmessage = ({ data }) => {
    if (data.type === 'model-progress') {
      const p = data.progress || {};
      let pct = Number(p.progress);
      if (p.status === 'progress_total' && Number.isFinite(pct)) {
        els.modelProgress.style.width = `${Math.min(100, Math.max(0, pct))}%`;
        els.sttStatus.textContent = `AI 모델 다운로드/준비 ${pct.toFixed(0)}%`;
      } else if (p.status === 'progress') {
        if (Number.isFinite(pct) && pct <= 1) pct *= 100;
        const file = p.file ? p.file.split('/').pop() : '';
        els.sttStatus.textContent = `모델 파일 준비 ${file}${Number.isFinite(pct) ? ` ${pct.toFixed(0)}%` : ''}`;
      } else if (p.status) {
        els.sttStatus.textContent = `AI 모델 준비 · ${p.status}`;
      }
      return;
    }
    if (data.type === 'model-fallback') {
      els.sttStatus.textContent = `양자화 모델 호환성 문제 → 안전 정밀도로 자동 전환`;
      els.sttMetrics.textContent = `Transformers.js ${data.runtimeVersion || '3.8.1'} · ${formatEffectiveDtype(data.from)} → ${formatEffectiveDtype(data.to)}`;
      toast('모델 정밀도를 자동으로 안전 모드로 전환했습니다.', 4500);
      return;
    }
    if (data.type === 'model-ready') {
      state.sttReadyKey = `${data.model}|${data.device}|${data.dtype || 'auto'}`;
      els.modelProgress.style.width = '100%';
      els.engineBadge.textContent = data.device === 'webgpu' ? 'WebGPU 준비됨' : 'CPU WASM 준비됨';
      els.engineBadge.className = 'badge ok';
      els.sttStatus.textContent = `모델 준비 완료 · ${data.model.split('/').pop()} · ${data.device}`;
      els.sttMetrics.textContent = `실제 정밀도: ${formatEffectiveDtype(data.effectiveDtype)} · Transformers.js ${data.runtimeVersion || '3.8.1'} · WASM threads ${data.wasmThreads || 1}`;
      const p = data.id ? state.sttPending.get(data.id) : null;
      if (p) { state.sttPending.delete(data.id); p.resolve(data); }
      return;
    }
    if (data.type === 'inference-start') {
      state.sttLastProgressAt = performance.now();
      state.sttTotalChunks = data.totalChunks || 1;
      state.sttCompletedChunks = 0;
      els.modelProgress.style.width = '0%';
      els.sttStatus.textContent = `Whisper 순차 추론 시작 · ${data.totalChunks || 1}개 chunk`;
      return;
    }
    if (data.type === 'inference-progress') {
      state.sttLastProgressAt = performance.now();
      state.sttCompletedChunks = data.completed || 0;
      state.sttTotalChunks = data.total || state.sttTotalChunks || 1;
      const pct = Math.max(0, Math.min(100, Number(data.progress) || 0));
      els.modelProgress.style.width = `${pct}%`;
      els.sttStatus.textContent = `Whisper 추론 ${state.sttCompletedChunks}/${state.sttTotalChunks} · ${pct.toFixed(0)}%`;
      return;
    }
    if (data.type === 'transcription-result') {
      const p = state.sttPending.get(data.id);
      if (p) { state.sttPending.delete(data.id); p.resolve({ result: data.result, stats: data.stats || null }); }
      return;
    }
    if (data.type === 'error') {
      const p = data.id ? state.sttPending.get(data.id) : [...state.sttPending.values()][0];
      if (p) { state.sttPending.delete(p.id); p.reject(new Error(data.error)); }
      els.sttStatus.textContent = `오류: ${data.error}`;
      els.engineBadge.textContent = '모델 오류'; els.engineBadge.className = 'badge warn';
    }
  };
  worker.onerror = (e) => {
    console.error(e); els.sttStatus.textContent = `STT Worker 오류: ${e.message}`;
    for (const [,p] of state.sttPending) p.reject(new Error(e.message || 'STT Worker 오류'));
    state.sttPending.clear();
    resetSttWorker();
  };
  state.sttWorker = worker;
  return worker;
}

async function loadModelFor(device, model, dtype) {
  const key = `${model}|${device}|${dtype}`;
  if (state.sttReadyKey === key) return { model, device, dtype };
  const worker = initSttWorker();
  els.engineBadge.textContent = '모델 로딩'; els.engineBadge.className = 'badge warn';
  els.modelProgress.style.width = '0%';
  const id = `load-${Date.now()}-${Math.random()}`;
  await new Promise((resolve, reject) => {
    state.sttPending.set(id, { id, kind: 'load', resolve, reject });
    worker.postMessage({ type: 'load', id, model, device, dtype });
  });
  return { model, device, dtype };
}

async function ensureModel() {
  let device = selectedDevice();
  const model = els.modelSelect.value;
  const dtype = els.dtypeSelect.value || 'auto';
  try {
    return await loadModelFor(device, model, dtype);
  } catch (error) {
    // Auto 모드에서 WebGPU 초기화 실패 시 사용자가 다시 누를 필요 없이 CPU q8로 전환한다.
    if (els.engineSelect.value === 'auto' && device === 'webgpu') {
      els.sttStatus.textContent = `WebGPU 준비 실패 → CPU WASM 자동 전환: ${error.message}`;
      resetSttWorker();
      device = 'wasm';
      return await loadModelFor(device, model, dtype);
    }
    throw error;
  }
}

function normalizeResult(result, offset, duration) {
  const text = (result?.text || '').trim();
  let chunks = Array.isArray(result?.chunks) ? result.chunks.map(c => {
    let ts = c.timestamp || c.timestamps || [0, null];
    const start = Number(ts?.[0] ?? 0) + offset;
    let end = ts?.[1] == null ? null : Number(ts[1]) + offset;
    if (!Number.isFinite(end)) end = start + 3;
    return { start, end, text: String(c.text || '').trim() };
  }).filter(c => c.text) : [];
  if (!chunks.length && text) chunks = [{ start: offset, end: offset + duration, text }];
  return { text, chunks };
}

async function dispatchInference({ audio, item, model, device, dtype, options, preserveAudio = false }) {
  const id = `stt-${item.id}-${Date.now()}-${Math.random()}`;
  const promise = new Promise((resolve, reject) => state.sttPending.set(id, { id, kind: 'stt', resolve, reject }));
  state.sttLastProgressAt = performance.now();
  const worker = initSttWorker();
  const message = { type: 'transcribe', id, model, device, dtype, audioBuffer: audio.buffer, options };
  if (preserveAudio) worker.postMessage(message); // WebGPU 실패 시 CPU 재시도용으로 원본 유지
  else worker.postMessage(message, [audio.buffer]);

  let watchdog = 0;
  if (els.engineSelect.value === 'auto' && device === 'webgpu') {
    watchdog = setInterval(() => {
      const idleMs = performance.now() - state.sttLastProgressAt;
      if (idleMs < 120000) return;
      clearInterval(watchdog); watchdog = 0;
      const pending = state.sttPending.get(id);
      if (pending) {
        state.sttPending.delete(id);
        pending.reject(new Error('WEBGPU_STALL'));
      }
      resetSttWorker();
    }, 5000);
  }
  try {
    return await promise;
  } finally {
    if (watchdog) clearInterval(watchdog);
  }
}

async function transcribeItem(item) {
  if (!item) throw new Error('STT할 파일을 선택하세요.');
  state.sttBusy = true; updateControls(); els.cancelSttBtn.disabled = false;
  setStatus(item, 'stt', 'STT 준비 중');
  const rangeOnly = els.rangeOnlyCheckbox.checked && item.id === state.currentId;
  els.sttStatus.textContent = '오디오를 16 kHz mono로 준비 중...';

  let audioInfo;
  try {
    audioInfo = await audioToFloat32(item, rangeOnly);
  } catch (e) {
    state.sttBusy = false; els.cancelSttBtn.disabled = true; updateControls();
    setStatus(item, 'ready', '오디오 준비 오류');
    throw e;
  }

  const { audio, offset, duration, prepSec } = audioInfo;
  let { model, device, dtype } = await ensureModel();
  const options = {
    language: els.languageSelect.value,
    task: els.taskSelect.value,
    timestamps: els.timestampSelect.value,
    // Whisper는 기본적으로 30초 컨텍스트를 사용. CPU/GPU 모두 최대 30초로 제한한다.
    chunkLength: Math.max(10, Math.min(30, Number(els.chunkLength.value) || 30)),
    strideLength: Math.max(0, Math.min(5, Number(els.strideLength.value) || 3))
  };

  startSttTicker(device, duration);
  setStatus(item, 'stt', `STT · ${device === 'webgpu' ? 'GPU' : 'CPU'}`);
  let bundle;
  try {
    bundle = await dispatchInference({
      audio, item, model, device, dtype, options,
      preserveAudio: els.engineSelect.value === 'auto' && device === 'webgpu'
    });
  } catch (error) {
    if (els.engineSelect.value === 'auto' && device === 'webgpu') {
      const reason = error.message === 'WEBGPU_STALL' ? '120초 동안 chunk 진행이 없음' : error.message;
      els.sttStatus.textContent = `WebGPU 추론 문제 → CPU WASM 자동 재시도 (${reason})`;
      els.sttMetrics.textContent = 'GPU 작업을 종료하고 CPU q8 모델로 안전하게 전환 중...';
      resetSttWorker();
      ({ model, device, dtype } = await loadModelFor('wasm', model, dtype));
      startSttTicker(device, duration);
      bundle = await dispatchInference({ audio, item, model, device, dtype, options, preserveAudio: false });
    } else {
      throw error;
    }
  }

  const result = bundle?.result || bundle;
  const stats = bundle?.stats || null;
  const normalized = normalizeResult(result, offset, duration);
  item.transcript = normalized.text;
  item.chunks = normalized.chunks;
  item.sttMeta = { model, device, dtype, ...options, rangeOnly, prepSec, stats, processedAt: new Date().toISOString() };
  setStatus(item, 'done', 'STT 완료');
  if (item.id === state.currentId) renderTranscript(item);
  els.modelProgress.style.width = '100%';
  els.sttStatus.textContent = `완료 · ${normalized.text.length.toLocaleString()}자 · ${normalized.chunks.length}개 타임 구간`;
  if (stats?.elapsedMs) {
    const inferSec = stats.elapsedMs / 1000;
    const speed = inferSec > 0 ? duration / inferSec : 0;
    els.sttMetrics.textContent = `오디오 준비 ${prepSec.toFixed(1)}초 · 추론 ${formatTime(inferSec)} · ${speed.toFixed(2)}× 실시간 · ${stats.totalChunks || 1} chunks · ${device} · TJS ${stats.runtimeVersion || '3.8.1'}`;
  }
  stopSttTicker();
  state.sttBusy = false; els.cancelSttBtn.disabled = true; updateControls(); saveSettings();
  return item;
}

function cancelStt() {
  if (!state.sttWorker) return;
  state.sttWorker.terminate(); state.sttWorker = null; state.sttReadyKey = '';
  for (const [,p] of state.sttPending) p.reject(new Error('사용자가 작업을 취소했습니다.'));
  state.sttPending.clear(); state.sttBusy = false; state.batchRunning = false; stopSttTicker();
  els.cancelSttBtn.disabled = true; els.sttStatus.textContent = 'STT 작업을 취소했습니다.'; els.sttMetrics.textContent='취소됨'; updateControls();
  const item = currentItem(); if (item?.status === 'stt') setStatus(item, 'ready', '취소됨');
}

function renderTranscript(item) {
  if (!item?.transcript) {
    els.transcriptView.className = 'transcript-view empty-state'; els.transcriptView.textContent = 'STT 결과가 여기에 표시됩니다.';
    els.transcriptEditor.value = item?.transcript || ''; updateControls(); return;
  }
  els.transcriptView.className = 'transcript-view';
  const showTs = els.showTimestamps.checked;
  if (item.chunks?.length) {
    els.transcriptView.innerHTML = item.chunks.map(c => `<div class="segment" data-start="${c.start}" data-end="${c.end}">
      <span class="segment-time" ${showTs ? '' : 'style="display:none"'}>${formatTime(c.start)} → ${formatTime(c.end)}</span>
      <span>${escapeHtml(c.text)}</span></div>`).join('');
  } else {
    els.transcriptView.textContent = item.transcript;
  }
  els.transcriptView.querySelectorAll('.segment').forEach(el => el.addEventListener('click', () => {
    els.audioPlayer.currentTime = Number(el.dataset.start) || 0; updateTimeUI();
  }));
  els.transcriptEditor.value = item.transcript;
  updateControls();
}

function effectiveText(item) { return (item?.transcript || els.transcriptEditor.value || '').trim(); }

function subtitleChunks(item) {
  const chunks = item?.chunks || [];
  if (!chunks.length) return [];
  const mostlyWords = chunks.length > 12 && chunks.filter(c => c.text.trim().split(/\s+/).length <= 2).length / chunks.length > .6;
  if (!mostlyWords) return chunks;
  const out = []; let group = null;
  for (const c of chunks) {
    if (!group) group = { start: c.start, end: c.end, text: c.text.trim() };
    else if ((c.end - group.start) <= 7 && group.text.length < 54) { group.end = c.end; group.text += (/[\u3131-\uD79D]$/.test(group.text) ? '' : ' ') + c.text.trim(); }
    else { out.push(group); group = { start: c.start, end: c.end, text: c.text.trim() }; }
  }
  if (group) out.push(group); return out;
}

function exportText(type) {
  const item = currentItem(); if (!item) return;
  const text = effectiveText(item); if (!text) return;
  const name = baseName(item.file.name);
  if (type === 'txt') downloadBlob(new Blob([text], {type:'text/plain;charset=utf-8'}), `${name}.txt`);
  if (type === 'md') {
    const meta = item.sttMeta ? `\n\n---\n- Model: ${item.sttMeta.model}\n- Device: ${item.sttMeta.device}\n- Language: ${item.sttMeta.language || 'auto'}\n- Processed: ${item.sttMeta.processedAt}\n` : '';
    downloadBlob(new Blob([`# ${name}\n\n${text}${meta}`], {type:'text/markdown;charset=utf-8'}), `${name}.md`);
  }
  if (type === 'json') downloadBlob(new Blob([JSON.stringify({ file: item.file.name, text, chunks: item.chunks, stt: item.sttMeta || null }, null, 2)], {type:'application/json;charset=utf-8'}), `${name}.json`);
  if (type === 'srt') {
    const s = subtitleChunks(item).map((c,i) => `${i+1}\n${srtTime(c.start)} --> ${srtTime(c.end)}\n${c.text}\n`).join('\n');
    downloadBlob(new Blob([s], {type:'application/x-subrip;charset=utf-8'}), `${name}.srt`);
  }
  if (type === 'vtt') {
    const s = `WEBVTT\n\n` + subtitleChunks(item).map(c => `${vttTime(c.start)} --> ${vttTime(c.end)}\n${c.text}\n`).join('\n');
    downloadBlob(new Blob([s], {type:'text/vtt;charset=utf-8'}), `${name}.vtt`);
  }
}

function downloadBlob(blob, filename) {
  const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = filename; document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 1200);
}

function chooseRecordingMime() {
  const candidates = ['audio/webm;codecs=opus','audio/webm','audio/mp4','audio/ogg;codecs=opus'];
  return candidates.find(x => window.MediaRecorder?.isTypeSupported?.(x)) || '';
}

async function refreshMicList() {
  if (!navigator.mediaDevices?.enumerateDevices) return;
  const devices = await navigator.mediaDevices.enumerateDevices();
  const mics = devices.filter(d => d.kind === 'audioinput');
  const old = els.micSelect.value;
  els.micSelect.innerHTML = '<option value="">기본 마이크</option>' + mics.map((d,i) => `<option value="${d.deviceId}">${escapeHtml(d.label || `마이크 ${i+1}`)}</option>`).join('');
  if ([...els.micSelect.options].some(o => o.value === old)) els.micSelect.value = old;
}

async function startRecording() {
  if (!navigator.mediaDevices?.getUserMedia || !window.MediaRecorder) return toast('이 브라우저는 마이크 녹음을 지원하지 않습니다.');
  const deviceId = els.micSelect.value;
  const stream = await navigator.mediaDevices.getUserMedia({ audio: { deviceId: deviceId ? { exact: deviceId } : undefined, echoCancellation: true, noiseSuppression: true, autoGainControl: true } });
  state.mediaStream = stream; state.recordChunks = []; state.pausedTotal = 0; state.pauseStart = 0;
  const mimeType = chooseRecordingMime();
  const rec = new MediaRecorder(stream, mimeType ? { mimeType } : undefined); state.mediaRecorder = rec;
  rec.ondataavailable = e => { if (e.data?.size) state.recordChunks.push(e.data); };
  rec.onstop = async () => {
    cancelAnimationFrame(state.timerRaf); cancelAnimationFrame(state.meterRaf);
    const mime = rec.mimeType || mimeType || 'audio/webm'; const blob = new Blob(state.recordChunks, { type: mime });
    const ext = mime.includes('mp4') ? 'm4a' : mime.includes('ogg') ? 'ogg' : 'webm';
    const stamp = new Date().toISOString().replace(/[:.]/g,'-').slice(0,19);
    addFiles([new File([blob], `recording_${stamp}.${ext}`, { type: mime })]);
    stopMediaStream(); els.recordTimer.textContent = '00:00:00'; els.micStatus.textContent = '저장됨'; els.micStatus.className = 'badge ok';
    els.recordBtn.disabled = false; els.pauseRecordBtn.disabled = true; els.stopRecordBtn.disabled = true; els.pauseRecordBtn.textContent = 'Ⅱ 일시정지';
    await refreshMicList().catch(()=>{});
  };
  rec.start(500); state.recordStart = performance.now();
  els.recordBtn.disabled = true; els.pauseRecordBtn.disabled = false; els.stopRecordBtn.disabled = false; els.micStatus.textContent = '녹음 중'; els.micStatus.className = 'badge warn';
  runRecordTimer(); runMeter(stream); await refreshMicList().catch(()=>{});
}

function toggleRecordPause() {
  const rec = state.mediaRecorder; if (!rec) return;
  if (rec.state === 'recording') { rec.pause(); state.pauseStart = performance.now(); els.pauseRecordBtn.textContent = '▶ 재개'; els.micStatus.textContent = '일시정지'; }
  else if (rec.state === 'paused') { rec.resume(); state.pausedTotal += performance.now() - state.pauseStart; state.pauseStart = 0; els.pauseRecordBtn.textContent = 'Ⅱ 일시정지'; els.micStatus.textContent = '녹음 중'; }
}

function stopRecording() { if (state.mediaRecorder && state.mediaRecorder.state !== 'inactive') state.mediaRecorder.stop(); }
function stopMediaStream() { state.mediaStream?.getTracks().forEach(t => t.stop()); state.mediaStream = null; state.recordAudioContext?.close().catch(()=>{}); state.recordAudioContext = null; }

function runRecordTimer() {
  const tick = () => {
    if (!state.mediaRecorder || state.mediaRecorder.state === 'inactive') return;
    const now = performance.now(); const currentPause = state.pauseStart ? now - state.pauseStart : 0;
    const elapsed = Math.max(0, now - state.recordStart - state.pausedTotal - currentPause) / 1000;
    els.recordTimer.textContent = formatTime(elapsed).padStart(8,'0'); state.timerRaf = requestAnimationFrame(tick);
  }; tick();
}

function runMeter(stream) {
  const AudioCtx = window.AudioContext || window.webkitAudioContext; if (!AudioCtx) return;
  const ctx = new AudioCtx(); state.recordAudioContext = ctx; const src = ctx.createMediaStreamSource(stream); const analyser = ctx.createAnalyser(); analyser.fftSize = 256; src.connect(analyser);
  const data = new Uint8Array(analyser.frequencyBinCount); const canvas = els.meterCanvas; const g = canvas.getContext('2d');
  const tick = () => {
    if (!state.mediaStream) return; analyser.getByteFrequencyData(data); const avg = data.reduce((a,b)=>a+b,0)/(data.length*255);
    const rect = canvas.getBoundingClientRect(), dpr = devicePixelRatio || 1; canvas.width = rect.width*dpr; canvas.height = rect.height*dpr;
    const colors = canvasColors(); g.fillStyle = colors.panel2; g.fillRect(0,0,canvas.width,canvas.height); g.fillStyle = colors.accent; g.fillRect(0,0,canvas.width*Math.min(1,avg*2.7),canvas.height);
    state.meterRaf = requestAnimationFrame(tick);
  }; tick();
}

async function inspectSystem() {
  els.systemCards.innerHTML = '<div class="system-card"><strong>검사 중…</strong><span>브라우저 기능 확인</span></div>';
  state.webgpuAvailable = await detectWebGPU();
  let storage = '확인 불가';
  try { const e = await navigator.storage?.estimate?.(); if (e?.quota) storage = `${formatBytes(e.usage || 0)} / ${formatBytes(e.quota)}`; } catch {}
  const cards = [
    ['Secure Context', window.isSecureContext, window.isSecureContext ? 'HTTPS · 마이크 사용 가능' : 'HTTPS 필요'],
    ['WebAssembly', typeof WebAssembly !== 'undefined', 'CPU 로컬 추론 기반'],
    ['WebGPU', state.webgpuAvailable, state.webgpuAvailable ? 'GPU 추론 가능' : 'CPU WASM으로 자동 전환'],
    ['Cross-Origin Isolation', self.crossOriginIsolated, self.crossOriginIsolated ? `WASM 멀티스레드 사용 가능 · 최대 ${Math.min(4, navigator.hardwareConcurrency || 4)} threads` : '첫 설치 후 한 번 새로고침하면 CPU 멀티스레드 활성화'],
    ['MediaRecorder', !!window.MediaRecorder, '녹음 · pause/resume'],
    ['Service Worker', 'serviceWorker' in navigator, 'PWA 앱 셸 캐시'],
    ['모델 캐시', 'caches' in window, 'Transformers.js Cache API'],
    ['CPU 논리 코어', true, `${navigator.hardwareConcurrency || '?'} cores`],
    ['Device Memory', true, navigator.deviceMemory ? `${navigator.deviceMemory} GB (브라우저 추정)` : '미제공'],
    ['Storage', true, storage],
    ['브라우저', true, navigator.userAgent.includes('Edg/') ? 'Microsoft Edge' : navigator.userAgent.includes('Chrome/') ? 'Chromium/Chrome' : navigator.userAgent.includes('Firefox/') ? 'Firefox' : navigator.userAgent.includes('Safari/') ? 'Safari' : '기타']
  ];
  els.systemCards.innerHTML = cards.map(([name,ok,desc]) => `<div class="system-card ${ok ? 'ok' : 'warn'}"><strong>${ok ? '✓' : '△'} ${escapeHtml(name)}</strong><span>${escapeHtml(desc)}</span></div>`).join('');
  els.engineBadge.textContent = state.webgpuAvailable ? 'WebGPU 사용 가능' : 'CPU WASM 사용'; els.engineBadge.className = state.webgpuAvailable ? 'badge ok' : 'badge warn';
  els.footerStatus.textContent = state.webgpuAvailable ? 'WebGPU GPU 사용 가능' : 'WebAssembly CPU 모드';
}

async function clearAiModelCache() {
  if (state.sttBusy) throw new Error('STT 작업 중에는 모델 캐시를 지울 수 없습니다.');
  resetSttWorker();
  let deleted = 0;
  if ('caches' in window) {
    const keys = await caches.keys();
    for (const key of keys) {
      if (/transformers|huggingface|onnx/i.test(key)) {
        if (await caches.delete(key)) deleted += 1;
      }
    }
  }
  els.modelProgress.style.width = '0%';
  els.sttStatus.textContent = 'AI 모델 캐시를 지웠습니다. 다음 실행 시 모델을 다시 다운로드합니다.';
  els.sttMetrics.textContent = `삭제된 AI 캐시: ${deleted}개`;
  toast('AI 모델 캐시를 정리했습니다.');
}

function saveSettings() {
  const obj = {};
  settingsFields.forEach(k => { const el = els[k]; obj[k] = el.type === 'checkbox' ? el.checked : el.value; });
  obj.theme = document.documentElement.dataset.theme || 'light';
  localStorage.setItem(SETTINGS_KEY, JSON.stringify(obj));
}

function loadSettings() {
  try {
    const obj = JSON.parse(localStorage.getItem(SETTINGS_KEY) || '{}');
    settingsFields.forEach(k => { if (!(k in obj)) return; const el = els[k]; if (el.type === 'checkbox') el.checked = !!obj[k]; else el.value = obj[k]; });
    if (obj.theme === 'dark') document.documentElement.dataset.theme = 'dark';
    if (els.performancePreset.value !== 'custom') applyPerformancePreset(els.performancePreset.value, false);
  } catch {}
}

function setupEvents() {
  els.fileInput.addEventListener('change', () => { addFiles(els.fileInput.files); els.fileInput.value = ''; });
  els.sampleBtn.addEventListener('click', async () => {
    try {
      const r = await fetch('./samples/whisper-test.wav');
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const blob = await r.blob();
      addFiles([new File([blob], 'whisper-test.wav', { type: 'audio/wav' })]);
      toast('예제 음성을 추가했습니다. 예상 문장: This is a local Whisper speech recognition test…', 4200);
    } catch (e) { toast(`예제 파일 로드 실패: ${e.message}`); }
  });
  ['dragenter','dragover'].forEach(ev => els.dropZone.addEventListener(ev, e => { e.preventDefault(); els.dropZone.classList.add('dragging'); }));
  ['dragleave','drop'].forEach(ev => els.dropZone.addEventListener(ev, e => { e.preventDefault(); els.dropZone.classList.remove('dragging'); }));
  els.dropZone.addEventListener('drop', e => addFiles(e.dataTransfer.files));
  els.dropZone.addEventListener('keydown', e => { if (e.key === 'Enter') els.fileInput.click(); });
  els.clearQueueBtn.addEventListener('click', () => { state.items.forEach(x => URL.revokeObjectURL(x.url)); state.items = []; state.currentId = null; renderQueue(); clearCurrent(); });

  els.audioPlayer.addEventListener('loadedmetadata', () => { const item = currentItem(); if (item && Number.isFinite(els.audioPlayer.duration)) { item.duration = els.audioPlayer.duration; state.waveformDuration=item.duration; els.rangeEnd.value = item.duration.toFixed(1); renderQueue(); } updateTimeUI(); });
  els.audioPlayer.addEventListener('timeupdate', () => { if (state.playRangeEnd != null && els.audioPlayer.currentTime >= state.playRangeEnd) { els.audioPlayer.pause(); state.playRangeEnd = null; } updateTimeUI(); });
  els.audioPlayer.addEventListener('play', () => els.playBtn.textContent = 'Ⅱ');
  els.audioPlayer.addEventListener('pause', () => els.playBtn.textContent = '▶');
  els.playBtn.addEventListener('click', () => els.audioPlayer.paused ? els.audioPlayer.play() : els.audioPlayer.pause());
  els.back10Btn.addEventListener('click', () => els.audioPlayer.currentTime = Math.max(0, els.audioPlayer.currentTime - 10));
  els.forward10Btn.addEventListener('click', () => els.audioPlayer.currentTime = Math.min(els.audioPlayer.duration || Infinity, els.audioPlayer.currentTime + 10));
  els.seekBar.addEventListener('input', () => { if (els.audioPlayer.duration) els.audioPlayer.currentTime = (Number(els.seekBar.value)/1000) * els.audioPlayer.duration; });
  els.speedSelect.addEventListener('change', () => { els.audioPlayer.playbackRate = Number(els.speedSelect.value); saveSettings(); });
  els.waveform.addEventListener('click', e => { const rect = els.waveform.getBoundingClientRect(); if (els.audioPlayer.duration) els.audioPlayer.currentTime = ((e.clientX - rect.left)/rect.width)*els.audioPlayer.duration; });
  els.setStartBtn.addEventListener('click', () => { els.rangeStart.value = els.audioPlayer.currentTime.toFixed(1); drawWaveform(); });
  els.setEndBtn.addEventListener('click', () => { els.rangeEnd.value = els.audioPlayer.currentTime.toFixed(1); drawWaveform(); });
  ['rangeStart','rangeEnd'].forEach(k => els[k].addEventListener('input', drawWaveform));
  els.playRangeBtn.addEventListener('click', async () => { const s=Number(els.rangeStart.value)||0,e=Number(els.rangeEnd.value)||0; if(e<=s)return toast('구간 끝은 시작보다 커야 합니다.'); els.audioPlayer.currentTime=s; state.playRangeEnd=e; await els.audioPlayer.play(); });

  document.querySelectorAll('input[name="wavPreset"]').forEach(r => r.addEventListener('change', () => { els.customWavOptions.classList.toggle('hidden', document.querySelector('input[name="wavPreset"]:checked').value !== 'custom'); }));
  els.loadFfmpegBtn.addEventListener('click', () => ensureFFmpeg().catch(e => { els.ffmpegBadge.textContent='FFmpeg 오류'; els.ffmpegBadge.className='badge warn'; els.convertStatus.textContent=e.message; toast(e.message); }));
  els.convertBtn.addEventListener('click', () => convertItemToWav(currentItem()).catch(e => { els.convertStatus.textContent=`오류: ${e.message}`; toast(e.message); const i=currentItem(); if(i)setStatus(i,'ready','변환 오류'); }));
  els.convertRangeBtn.addEventListener('click', () => convertItemToWav(currentItem(), {range:true}).catch(e => toast(e.message)));

  els.performancePreset.addEventListener('change', () => applyPerformancePreset(els.performancePreset.value));
  els.engineSelect.addEventListener('change', () => { state.sttReadyKey=''; saveSettings(); });
  ['modelSelect','dtypeSelect'].forEach(k => els[k].addEventListener('change', () => { els.performancePreset.value='custom'; state.sttReadyKey=''; saveSettings(); }));
  ['languageSelect','taskSelect','timestampSelect','chunkLength','strideLength'].forEach(k => els[k].addEventListener('change', saveSettings));
  els.loadModelBtn.addEventListener('click', () => ensureModel().catch(e => { els.sttStatus.textContent=`오류: ${e.message}`; toast(e.message); }));
  els.transcribeBtn.addEventListener('click', async () => { try { await transcribeItem(currentItem()); } catch(e) { state.sttBusy=false; els.cancelSttBtn.disabled=true; updateControls(); els.sttStatus.textContent=`오류: ${e.message}`; toast(e.message,4000); const i=currentItem(); if(i)setStatus(i,'ready','STT 오류'); } });
  els.batchTranscribeBtn.addEventListener('click', async () => {
    if (state.batchRunning) return; state.batchRunning=true;
    try {
      const targets = state.items.filter(x => !x.transcript);
      if (!targets.length) return toast('STT 대기 파일이 없습니다.');
      for (let n=0;n<targets.length;n++) { if(!state.batchRunning)break; await selectItem(targets[n].id); els.sttStatus.textContent=`일괄 STT ${n+1}/${targets.length} · ${targets[n].file.name}`; await transcribeItem(targets[n]); }
      if(state.batchRunning) toast('일괄 STT가 완료되었습니다.');
    } catch(e) { if(state.batchRunning) toast(`일괄 STT 중단: ${e.message}`,4000); }
    finally { state.batchRunning=false; state.sttBusy=false; els.cancelSttBtn.disabled=true; updateControls(); }
  });
  els.cancelSttBtn.addEventListener('click', cancelStt);

  els.showTimestamps.addEventListener('change', () => { renderTranscript(currentItem()); saveSettings(); });
  els.autoScrollTranscript.addEventListener('change', saveSettings);
  els.transcriptEditor.addEventListener('input', () => { const item=currentItem(); if(item){ item.transcript=els.transcriptEditor.value; updateControls(); } });
  els.clearTranscriptBtn.addEventListener('click', () => { const item=currentItem(); if(!item)return; item.transcript=''; item.chunks=[]; renderTranscript(item); setStatus(item,'ready','대기'); });
  els.copyBtn.addEventListener('click', async () => { const t=effectiveText(currentItem()); await navigator.clipboard.writeText(t); toast('텍스트를 복사했습니다.'); });
  els.downloadTxtBtn.addEventListener('click',()=>exportText('txt')); els.downloadMdBtn.addEventListener('click',()=>exportText('md')); els.downloadSrtBtn.addEventListener('click',()=>exportText('srt')); els.downloadVttBtn.addEventListener('click',()=>exportText('vtt')); els.downloadJsonBtn.addEventListener('click',()=>exportText('json'));

  els.recordBtn.addEventListener('click', () => startRecording().catch(e => toast(`녹음 시작 실패: ${e.message}`,4000)));
  els.pauseRecordBtn.addEventListener('click', toggleRecordPause); els.stopRecordBtn.addEventListener('click', stopRecording);
  els.clearAiCacheBtn.addEventListener('click', () => clearAiModelCache().catch(e => toast(e.message, 4000)));
  els.refreshSystemBtn.addEventListener('click', inspectSystem); els.helpBtn.addEventListener('click',()=>els.helpDialog.showModal());
  els.themeBtn.addEventListener('click', () => { document.documentElement.dataset.theme = document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark'; saveSettings(); drawWaveform(); });
  window.addEventListener('resize', drawWaveform);
  window.addEventListener('beforeinstallprompt', e => { e.preventDefault(); state.deferredInstallPrompt=e; els.installBtn.classList.remove('hidden'); });
  els.installBtn.addEventListener('click', async () => { if(!state.deferredInstallPrompt)return; state.deferredInstallPrompt.prompt(); await state.deferredInstallPrompt.userChoice; state.deferredInstallPrompt=null; els.installBtn.classList.add('hidden'); });
  window.addEventListener('keydown', e => {
    if ((e.ctrlKey||e.metaKey) && e.key.toLowerCase()==='o') { e.preventDefault(); els.fileInput.click(); return; }
    if (['INPUT','TEXTAREA','SELECT'].includes(document.activeElement?.tagName)) return;
    if (e.code==='Space' && currentItem()) { e.preventDefault(); els.audioPlayer.paused?els.audioPlayer.play():els.audioPlayer.pause(); }
    if (e.key==='ArrowLeft' && currentItem()) els.audioPlayer.currentTime=Math.max(0,els.audioPlayer.currentTime-5);
    if (e.key==='ArrowRight' && currentItem()) els.audioPlayer.currentTime=Math.min(els.audioPlayer.duration||Infinity,els.audioPlayer.currentTime+5);
  });
}

async function init() {
  loadSettings(); setupEvents(); renderQueue(); updateControls();
  els.audioPlayer.playbackRate = Number(els.speedSelect.value || 1);
  await inspectSystem();
  if ('serviceWorker' in navigator && location.protocol.startsWith('http')) {
    navigator.serviceWorker.addEventListener('controllerchange', () => {
      if (!sessionStorage.getItem('lws-coi-reload')) {
        sessionStorage.setItem('lws-coi-reload', '1');
        location.reload();
      }
    }, { once: true });
    navigator.serviceWorker.register('./sw.js', { updateViaCache: 'none' })
      .then(r => r.update().catch(()=>{}))
      .catch(console.warn);
  }
  refreshMicList().catch(()=>{});
}

init().catch(e => { console.error(e); toast(`초기화 오류: ${e.message}`, 5000); });
