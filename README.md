# Local Whisper Studio 2.3 — Optimized GitHub Pages Edition

GitHub Pages에서 실행되는 **완전 정적(static), 서버 업로드 없는 로컬 오디오 변환·녹음·Whisper STT 웹앱**입니다.

이번 2.3 버전은 **Transformers.js 4.2.0 / ONNX Runtime 1.26 계열에서 발생하는 Whisper q4/q8 세션 생성 오류**와 5분 이상 음성에서 진행이 멈춘 것처럼 보이는 문제를 우선 해결한 안정화판입니다.

## 2.3에서 달라진 핵심

1. **Whisper 런타임을 Transformers.js 3.8.1로 고정**
   - 4.2.0 계열에서 보고된 `Missing required scale` / `TransposeDQWeightsForMatMulNBits` 회귀를 우회합니다.
   - `onnx-community/whisper-*` 모델과 WebGPU/WASM 조합을 계속 사용합니다.

2. **q4/q8 실패 시 fp32 자동 복구**
   - Auto 모드: CPU/WASM은 q8을 먼저 시도하고 실패하면 fp32로 재시도합니다.
   - Auto 모드: WebGPU는 encoder fp32 + decoder q4를 먼저 시도하고 실패하면 fp32 decoder로 자동 재시도합니다.
   - 사용자가 q4/q8/fp16을 직접 선택해도 세션 생성 오류가 나면 안전 정밀도로 복구합니다.

3. **장시간 오디오를 수동 순차 chunk 추론으로 변경**
   - 30초 이하의 작은 조각만 Whisper에 한 번씩 전달합니다.
   - 5분 음성은 기본값(30초, overlap 3초)에서 약 11개 chunk로 처리됩니다.
   - 각 chunk가 완료될 때 `3/11 chunks · 27%`처럼 실제 진행률을 표시합니다.
   - 전체 5분 배열을 Transformers.js 장음성 pipeline에 한 번에 맡기지 않습니다.

4. **Overlap 중복 제거**
   - 각 chunk에서 내부 timestamp를 받아 overlap의 절반씩 소유하도록 병합하여 경계 문장 중복을 줄였습니다.
   - 화면에서 timestamp를 끈 경우에도 내부 병합에는 timestamp를 사용합니다.

5. **중복 오디오 decode 제거 유지**
   - 파일 선택 시 전체 decode하지 않습니다.
   - STT 시작 시 한 번만 16 kHz mono로 decode/resample하고, 그 PCM을 파형 표시에도 재사용합니다.

6. **WebGPU → CPU 자동 fallback 유지**
   - WebGPU 모델 로딩 실패 시 CPU/WASM으로 자동 전환합니다.
   - Auto 모드에서 WebGPU 추론이 120초 동안 진전이 없으면 Worker를 종료하고 CPU로 재시도합니다.

7. **CPU WASM 멀티스레드 및 캐시 갱신**
   - cross-origin isolation이 활성화되면 WASM을 최대 4 threads까지 사용합니다.
   - Service Worker cache를 2.3으로 올리고 앱 코드는 network-first로 유지합니다.
   - `AI 모델 캐시 지우기` 버튼으로 이전 런타임에서 받은 모델 캐시를 초기화할 수 있습니다.

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
Whisper 순차 추론 시작 · 11개 chunk
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

2.3 Service Worker가 설치될 때 앱이 한 번 자동 새로고침될 수 있습니다. 이는 CPU 멀티스레드 사용을 위한 cross-origin isolation 활성화 과정입니다.

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
 fp32 + q4 우선        q8 우선
 fp32 자동복구      fp32 자동복구
        └───────┬────────┘
                ▼
   ≤30 s 수동 순차 inference
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
- 장시간 녹음은 chunk inference를 사용하지만 현재 2.3도 입력 오디오 decode 자체는 파일 전체에 대해 수행합니다.
- 수 시간 이상 파일을 안정적으로 처리하려면 다음 단계로 WebCodecs/OPFS 기반 streaming decode 구조가 필요합니다.

## Runtime dependencies

- Hugging Face Transformers.js
- ONNX Runtime Web
- FFmpeg.wasm core

자세한 사항은 `THIRD_PARTY_NOTICES.md`를 참고하십시오.
