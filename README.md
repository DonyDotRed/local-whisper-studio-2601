# Local Whisper Studio 2.2 — Optimized GitHub Pages Edition

GitHub Pages에서 실행되는 **완전 정적(static), 서버 업로드 없는 로컬 오디오 변환·녹음·Whisper STT 웹앱**입니다.

이번 2.2 버전은 5분 정도의 파일에서도 이전 버전이 지나치게 느리거나 `처리중`으로만 보이던 문제를 중심으로 STT 경로를 다시 최적화했습니다.

## 2.2에서 달라진 핵심

1. **중복 오디오 decode 제거**
   - 이전: 파일 선택 시 파형용 전체 decode → STT 시작 시 다시 전체 decode.
   - 2.2: 파일 선택 시 전체 decode하지 않음 → STT 시작 시 **한 번만 decode/resample** → 같은 16 kHz PCM으로 파형까지 생성.

2. **빠른 전사(Tiny)가 기본값**
   - 5~30분 파일의 첫 테스트는 `Tiny`를 기본으로 사용.
   - `Base`는 균형, `Small`은 정확도 우선 프리셋으로 분리.

3. **장시간 STT 실제 진행률 표시**
   - 30초 이하: Whisper 1회 추론.
   - 30초 초과: Whisper chunk pipeline 사용.
   - 각 chunk가 끝날 때 `3/11 chunks · 27%`처럼 실제 진행률 표시.
   - 경과 시간과 처리 chunk가 계속 표시되므로 정상 추론 중인지 확인 가능.

4. **브라우저별 자동 dtype 최적화**
   - CPU/WASM `Auto` → `q8`.
   - WebGPU `Auto` → Whisper encoder는 fp32, decoder는 q4 조합.
   - 사용자가 FP32 전체 모델을 실수로 기본 로딩하는 문제를 방지.

5. **WebGPU 자동 fallback**
   - Auto 모드에서 WebGPU 모델 로딩이 실패하면 CPU/WASM으로 자동 전환.
   - WebGPU 추론에서 120초 동안 chunk 진행이 없으면 GPU Worker를 종료하고 CPU로 자동 재시도.

6. **CPU WASM 멀티스레드 지원 개선**
   - Service Worker가 COOP/COEP 헤더를 추가하여 지원 브라우저에서 `crossOriginIsolated` 활성화를 시도.
   - 활성화되면 ONNX Runtime WASM을 최대 4 threads까지 사용.
   - 환경 진단 화면에서 Cross-Origin Isolation 활성 여부 확인 가능.

7. **구버전 PWA 캐시 문제 수정**
   - 앱 JS/CSS/HTML은 network-first.
   - Service Worker cache version을 2.2로 변경.
   - GitHub Pages에 새 버전을 올렸는데도 옛 코드가 계속 실행되는 현상을 줄임.

8. **AI 모델 캐시 초기화 버튼 추가**
   - 모델 파일이 비정상적으로 캐시되었거나 설정을 완전히 새로 시작하고 싶을 때 사용.

## 권장 설정

### 5분 테스트 파일

```text
성능 프리셋    빠른 전사 · Tiny
실행 엔진      자동(WebGPU 우선)
언어           한국어
모델 정밀도    자동 최적화
Chunk          30초
Overlap        3초
Timestamp      구간 단위
```

### 정확도가 더 필요한 경우

1. 먼저 Tiny로 전체 동작 여부 확인
2. Base로 변경
3. GPU와 메모리 여유가 충분할 때만 Small 사용
4. Large-v3-Turbo는 GitHub Pages 브라우저 환경에서는 실험용으로 생각하는 것을 권장

## 정상 처리 여부 확인

STT 실행 후 아래처럼 상태가 변합니다.

```text
오디오를 16 kHz mono로 준비 중...
        ↓
모델 준비 완료
        ↓
Whisper 추론 시작 · 11개 chunk
        ↓
Whisper 추론 1/11 · 9%
Whisper 추론 2/11 · 18%
...
        ↓
완료 · 3,421자 · 53개 타임 구간
```

하단 성능 정보에는 다음처럼 표시됩니다.

```text
오디오 준비 1.8초 · 추론 01:42 · 2.94× 실시간 · 11 chunks · webgpu
```

`2.94× 실시간`은 1초 동안 약 2.94초 분량의 음성을 처리했다는 의미입니다.

## 처리중에서 오래 멈추는 경우

### 1. AI 모델 캐시 지우기

`환경 및 개인정보 → AI 모델 캐시 지우기`를 누른 뒤 Tiny 모델부터 다시 시험합니다.

### 2. GitHub Pages 강제 새로고침

기존 v1 Service Worker가 남아 있을 수 있으므로 배포 직후 한 번 다음을 수행하십시오.

- Chrome/Edge: `Ctrl + Shift + R`
- 또는 사이트 데이터/Service Worker 삭제 후 재접속

2.2 Service Worker가 설치될 때 앱이 한 번 자동 새로고침될 수 있습니다. 이는 CPU 멀티스레드 사용을 위한 cross-origin isolation 활성화 과정입니다.

### 3. WebGPU 문제

Auto 모드는 문제가 발생하면 CPU로 자동 전환합니다. GPU 자체를 배제하고 검사하려면:

```text
실행 엔진 → CPU · WebAssembly
성능 프리셋 → 빠른 전사 · Tiny
```

### 4. CPU에서 너무 느린 경우

환경 진단의 `Cross-Origin Isolation` 항목을 확인하십시오.

```text
✓ Cross-Origin Isolation
  WASM 멀티스레드 사용 가능 · 최대 4 threads
```

이면 CPU 최적화 경로입니다. 비활성이라면 최신 Chrome/Edge에서 한 번 새로고침하십시오.

## 전체 기능

- M4A / AAC / MP3 / WAV / FLAC / OGG / WebM 파일
- Drag & Drop / 다중 파일 큐
- 마이크 녹음 / 일시정지 / 재개 / 종료
- 마이크 선택 / 레벨 미터
- 재생 / Seek / ±10초 / 배속
- STT 준비 후 waveform 표시
- 선택 구간 재생 / 선택 구간 STT
- FFmpeg.wasm M4A → WAV
- 16 kHz Mono PCM16 STT WAV
- Tiny / Base / Small / Large-v3-Turbo
- WebGPU / WASM CPU
- 한국어/영어/일본어/중국어/독일어/프랑스어/스페인어
- 언어 자동 감지
- transcribe / translate
- segment / word timestamp
- chunk / overlap 조절
- Batch STT
- 결과 편집
- TXT / MD / JSON / SRT / VTT
- PWA
- 모델 Browser Cache
- AI 모델 캐시 정리
- 시스템 진단
- 다크모드 / 반응형 UI

## GitHub Pages 배포

1. 이 폴더의 **내용 전체**를 repository root에 업로드합니다.
2. `Settings → Pages`.
3. `Deploy from a branch`.
4. `main / (root)` 선택.
5. `https://<username>.github.io/<repository>/` 접속.

Python, Node.js, `uv`, API key 또는 별도 서버는 필요하지 않습니다.

## 로컬 테스트

`file://`가 아니라 HTTP 환경에서 실행하십시오.

```bash
python -m http.server 8080
```

그리고 Chrome/Edge에서:

```text
http://localhost:8080
```

으로 접속합니다.

## 개인정보 및 네트워크

음성 및 STT 결과를 서버에 업로드하는 코드는 없습니다.

최초 실행/모델 변경 시 네트워크에서 받는 것은 다음입니다.

- Transformers.js runtime
- ONNX Runtime Web/WASM
- Whisper ONNX model weights
- 필요 시 FFmpeg.wasm core

모델은 브라우저 Cache API에 저장되어 이후 실행에서 재사용됩니다.

## 기술 구조

```text
M4A/WAV/MP3/녹음
       │
       ├─ audio element → 즉시 재생/metadata
       │
       └─ STT 시작 시에만 decode 1회
                │
                ▼
       16 kHz Mono Float32
                │
                ├─ waveform 생성
                │
                ▼
          STT Web Worker
                │
          Transformers.js
                │
        ┌───────┴────────┐
        ▼                ▼
     WebGPU           WASM CPU
        │                │
  encoder fp32          q8
  decoder q4       1~4 threads
        └───────┬────────┘
                ▼
       30 s chunk inference
                │
        실제 진행률 표시
                │
                ▼
       TXT/MD/SRT/VTT/JSON
```

## 제한 사항

- GitHub Pages에서는 CUDA / faster-whisper / Python `uv` backend를 직접 실행할 수 없습니다.
- 브라우저 GPU는 CUDA가 아니라 WebGPU입니다.
- 매우 큰 파일은 브라우저 AudioBuffer 메모리 한계가 있습니다.
- 장시간 녹음은 chunk inference를 사용하지만 현재 2.2도 입력 오디오 decode 자체는 파일 전체에 대해 수행합니다.
- 수 시간 이상 파일을 안정적으로 처리하려면 다음 단계로 WebCodecs/OPFS 기반 streaming decode 구조가 필요합니다.

## Runtime dependencies

- Hugging Face Transformers.js
- ONNX Runtime Web
- FFmpeg.wasm core

자세한 사항은 `THIRD_PARTY_NOTICES.md`를 참고하십시오.
