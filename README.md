# Study Mate

Study Mate is a local-first learning companion designed for international students attending Korean-language university lectures. It captures lectures directly in the browser, streams audio to a backend Google Speech-to-Text proxy, provides real-time Korean correction and translated captions, and retains lecture review materials and Smart Notes in the browser.

## Key Features

- **Lecture Capture & Audio Storage**: In-browser microphone recording with pause/resume, client-side audio download, and persistent IndexedDB audio storage.
- **Real-Time Speech-to-Text**: Low-latency streaming via WebSocket to Google Cloud Speech-to-Text with interim and final transcription results.
- **Gemini Correction & Translation**: Automatic correction of classroom Korean terminology and simultaneous translation into the student's selected language.
- **Smart Notes & Quizzes**: Structured lecture summaries, key concepts, study tips, timestamped review moments, and auto-generated review quizzes.
- **Schedule Extraction & Calendar**: Deterministic extraction of assignment deadlines and exam dates from lecture transcripts with user review and browser calendar integration.
- **Student Community & Board**: Campus bulletin board prototype with post creation, category filtering, and threaded comments.
- **AI Chatbot & Policy Recommendations**: Interactive study assistant integrated with South Korea's OnTong Youth Policy data, providing personalized policy matching and transparent recommendation reasons based on student profiles.
- **Personalized Profile (My Page)**: Student learning profile managing age, residence, enrollment/employment status, and topic interests with instant feedback.
- **Bilingual Interface**: Full interface toggle between Korean and English.

## Architecture

Study Mate operates on a split deployment topology separating the static client-side frontend from the containerized edge backend:

```text
Browser Client
   │
   ▼
GenSpark Frontend (Static Web App)
   │
   ├── HTTPS (/api/*)  ──>  Google Cloud Run Backend (Node.js 20)
   │                               ├── Google Cloud Speech-to-Text (gRPC streaming)
   └── WSS (/api/stt)  ──>         ├── Google Cloud Vertex AI / Gemini API
                                   └── OnTong Youth Policy Public API
```

- **Frontend Routing**: `src/services/config.js` dynamically resolves the backend base URL (supporting environment injection via `window.__STUDY_MATE_CONFIG__`, `localStorage`, or default remote endpoints) for both HTTP requests and WebSocket connections.
- **Audio Streaming**: Audio is recorded as WebM/Opus chunks and transmitted over a persistent WebSocket (`/api/stt`) to `server.js`, which manages gRPC streaming recognition sessions with Google Cloud Speech-to-Text.

## Technology Stack

- **Frontend**: HTML5, CSS3, Vanilla JavaScript (ES Modules), and a zero-dependency outline SVG icon system based on Lucide conventions.
- **Backend**: Node.js 20, WebSocket (`ws`), `@google-cloud/speech`, `@google/genai`.
- **Cloud & AI**: Google Cloud Run, Google Cloud Speech-to-Text API, Google Cloud Vertex AI (Gemini 2.5 Flash).
- **Hosting**: GenSpark static hosting pipeline (`wrangler.jsonc` and `scripts/build.js`).

## Production Deployment

- **Live Production URL**: [https://3859f8ff-0a84-4229-a667-bf9a904f984a.vip.gensparksite.com/](https://3859f8ff-0a84-4229-a667-bf9a904f984a.vip.gensparksite.com/)
- **Frontend Build**: Built into the `public/` directory via `npm run build` and published through GenSpark Hosting.
- **Backend Deployment**: Containerized via `Dockerfile` and deployed on Google Cloud Run. Production deployments utilize Cloud Run runtime Service Account Application Default Credentials (ADC), eliminating static JSON credentials.

## API Overview

All server endpoints are provided by `server.js`:

| Endpoint | Protocol | Purpose |
|---|---|---|
| `/api/stt` | WebSocket | Google Cloud STT streaming recognition proxy for browser audio chunks |
| `/api/translate` | POST (HTTPS) | Gemini-backed Korean correction and subtitle translation |
| `/api/smart-note` | POST (HTTPS) | Gemini-backed Smart Note synthesis |
| `/api/schedule-extract` | POST (HTTPS) | Server-side schedule candidate extraction endpoint |
| `/api/opportunities` | GET (HTTPS) | Server-side OnTong Youth Policy query and proxy |

## Environment Variables

Server-side variables are configured via `.env` for local execution or Cloud Run runtime environment variables:

| Variable | Required | Default | Description |
|---|---|---|---|
| `GOOGLE_CLOUD_PROJECT` | Yes | — | Google Cloud project ID for Speech-to-Text and Vertex AI |
| `GOOGLE_CLOUD_LOCATION` | No | `global` | Region location for Google Cloud Vertex AI |
| `GEMINI_MODEL` | No | `gemini-2.5-flash` | Gemini model version |
| `STT_MAX_SESSION_MS` | No | `270000` | Maximum STT streaming session duration in milliseconds |
| `YOUTH_POLICY_API_KEY` | Optional | — | API key for OnTong Youth Policy public data integration |
| `PORT` | No | `8080` (or `4173`) | Server listening port (injected automatically by Cloud Run) |
| `HOST` | No | `0.0.0.0` | Host binding address |
| `ALLOWED_ORIGINS` | No | `http://localhost:4173,...` | Comma-separated CORS and WebSocket Origin allowlist |

*Note: In production on Cloud Run, Google Cloud authentication is provided directly by runtime Application Default Credentials (ADC). `GOOGLE_APPLICATION_CREDENTIALS` is only needed when testing locally with a static service account key file.*

## Local Development

### 1. Prerequisites
- Node.js 20 or higher
- Google Cloud project with Speech-to-Text and Vertex AI APIs enabled (if running live backend features)

### 2. Setup & Execution
1. Clone the repository and install dependencies:
   ```bash
   npm install
   ```
2. Configure environment variables:
   ```bash
   cp .env.example .env
   # Edit .env with your project configuration
   ```
3. Run the development server:
   ```bash
   npm start
   ```
4. Access the application in your browser (default `http://localhost:8080` or `http://localhost:4173` depending on `PORT`).

## Storage & Security

- **Client-Side Privacy**: Lecture transcripts, notes, schedules, board posts, and student profiles are stored exclusively in the browser's `localStorage`. Audio blobs remain in client-side `IndexedDB`.
- **Zero Client Secrets**: Frontend assets contain no API keys, private tokens, or Google credentials.
- **Server Identity**: The backend running on Cloud Run relies on the Cloud Run runtime service account (ADC) with granular IAM roles (`roles/speech.client`, `roles/aiplatform.user`).
- **Origin Validation**: Both HTTP preflight requests and WebSocket connection upgrades enforce strict `ALLOWED_ORIGINS` header validation.

## Project Structure

```text
├── docs/                 # Architectural specifications, API and deployment notes
├── public/               # Synced static frontend output for production hosting
├── scripts/
│   ├── build.js          # Static assets build/sync script
│   └── test-schedule-date.mjs # Schedule date normalization test suite
├── src/
│   ├── components/
│   │   └── icons.js      # Zero-dependency Lucide outline SVG icon system
│   ├── data/
│   │   └── student.js    # Default mock models and course definitions
│   ├── services/
│   │   ├── config.js     # Unified backend and WebSocket URL resolution
│   │   └── index.js      # Client adapters (STT, translation, notes, storage)
│   ├── app.js            # Main client single-page application logic
│   └── styles.css        # Responsive styling and design system
├── .env.example          # Template for backend configuration
├── Dockerfile            # Container specification for Cloud Run deployment
├── package.json          # Node.js project scripts and dependencies
├── server.js             # Node.js backend server, WebSocket STT proxy & APIs
└── wrangler.jsonc        # Static deployment output directory configuration
```

## Testing & Validation

Execute automated regression and syntax checks with npm scripts:

```bash
npm run check          # Validates syntax for server.js, app.js, and services
npm run test:schedule  # Executes schedule date extraction normalization fixtures
npm run build          # Builds and syncs static assets to public/
```

## Known Limitations

- **Browser-Bound Persistence**: Because data is saved locally in the browser's `localStorage` and `IndexedDB`, clearing browser data removes stored recordings and notes.
- **Live Media Permissions**: Microphone capture and real-time STT streaming require explicit browser user permissions.

---

# 🇰🇷 Study Mate — 한국어

Study Mate는 한국어 대학교 강의를 수강하는 외국인 유학생을 위해 설계된 로컬 우선(local-first) 학습 도우미입니다. 브라우저에서 직접 강의를 캡처하고, 오디오를 백엔드 Google Speech-to-Text 프록시로 스트리밍하며, 실시간 한국어 교정 및 번역 자막을 제공하고, 강의 복습 자료와 Smart Note를 브라우저 내에 안전하게 보관합니다.

## 주요 기능

- **강의 캡처 및 오디오 저장**: 브라우저 마이크 녹음(일시정지/재개 지원), 클라이언트 측 오디오 다운로드 및 영구적인 IndexedDB 오디오 저장소 지원.
- **실시간 Speech-to-Text**: WebSocket을 통한 Google Cloud Speech-to-Text 저지연 스트리밍으로 중간(interim) 및 최종(final) 자막 실시간 생성.
- **Gemini 기반 교정 및 번역**: 강의실 한국어 전문 용어 자동 교정 및 학생이 선택한 언어로의 실시간 자막 번역.
- **Smart Note 및 퀴즈**: 구조화된 강의 요약, 핵심 개념, 학습 팁, 타임스탬프 기반 다시 듣기 구간 및 자동 생성된 복습 퀴즈 제공.
- **일정 추출 및 캘린더**: 강의 자막에서 과제 마감일과 시험 일정을 결정론적으로 추출하며, 사용자 검토 후 브라우저 캘린더에 연동 저장.
- **학생 커뮤니티 및 게시판**: 게시글 작성, 카테고리 필터링 및 댓글 기능을 갖춘 캠퍼스 게시판 프로토타입.
- **AI 챗봇 및 정책 추천**: 대한민국 온통청년 공공데이터와 연동된 대화형 학습 도우미로, 학생 프로필 기반 맞춤형 정책 매칭 및 투명한 추천 사유 제시.
- **개인화 프로필 (마이페이지)**: 만 나이, 거주지, 학적/취업 상태, 관심 분야를 관리하며 실시간 저장 피드백 제공.
- **이중 언어 인터페이스**: 한국어와 영어 간 완전한 UI 전환 지원.

## 아키텍처

Study Mate는 정적 클라이언트 프론트엔드와 컨테이너 기반 엣지 백엔드를 분리한 스플릿 배포(split deployment) 토폴로지로 작동합니다:

```text
Browser Client
   │
   ▼
GenSpark Frontend (Static Web App)
   │
   ├── HTTPS (/api/*)  ──>  Google Cloud Run Backend (Node.js 20)
   │                               ├── Google Cloud Speech-to-Text (gRPC streaming)
   └── WSS (/api/stt)  ──>         ├── Google Cloud Vertex AI / Gemini API
                                   └── OnTong Youth Policy Public API
```

- **프론트엔드 라우팅**: `src/services/config.js`가 백엔드 기본 URL을 동적으로 해석하여(환경 변수 주입 `window.__STUDY_MATE_CONFIG__`, `localStorage`, 또는 기본 원격 엔드포인트 지원), HTTP 요청 및 WebSocket 연결 모두를 원활히 처리합니다.
- **오디오 스트리밍**: 오디오는 WebM/Opus 청크 단위로 녹음되어 지속적인 WebSocket(`/api/stt`)을 통해 `server.js`로 전송되며, 백엔드에서 Google Cloud Speech-to-Text와의 gRPC 스트리밍 인식 세션을 관리합니다.

## 기술 스택

- **프론트엔드**: HTML5, CSS3, Vanilla JavaScript(ES Modules), Lucide 규격 기반의 무의존성 인라인 SVG 아이콘 시스템.
- **백엔드**: Node.js 20, WebSocket(`ws`), `@google-cloud/speech`, `@google/genai`.
- **클라우드 및 AI**: Google Cloud Run, Google Cloud Speech-to-Text API, Google Cloud Vertex AI(Gemini 2.5 Flash).
- **호스팅**: GenSpark 정적 호스팅 파이프라인(`wrangler.jsonc` 및 `scripts/build.js`).

## 프로덕션 배포

- **라이브 프로덕션 URL**: [https://3859f8ff-0a84-4229-a667-bf9a904f984a.vip.gensparksite.com/](https://3859f8ff-0a84-4229-a667-bf9a904f984a.vip.gensparksite.com/)
- **프론트엔드 빌드**: `npm run build`를 통해 `public/` 디렉터리로 빌드 및 동기화된 후 GenSpark Hosting을 통해 배포.
- **백엔드 배포**: `Dockerfile` 기반으로 컨테이너화되어 Google Cloud Run에 배포. 프로덕션 환경은 런타임 서비스 계정 애플리케이션 기본 자격 증명(ADC)을 사용하여 정적 JSON 자격 증명 파일이 필요 없습니다.

## API 개요

모든 서버 엔드포인트는 `server.js`에서 제공됩니다:

| 엔드포인트 | 프로토콜 | 용도 |
|---|---|---|
| `/api/stt` | WebSocket | 브라우저 오디오 청크를 위한 Google Cloud STT 스트리밍 인식 프록시 |
| `/api/translate` | POST (HTTPS) | Gemini 기반 한국어 교정 및 자막 번역 |
| `/api/smart-note` | POST (HTTPS) | Gemini 기반 Smart Note 요약 및 생성 |
| `/api/schedule-extract` | POST (HTTPS) | 서버 측 일정 후보 추출 엔드포인트 |
| `/api/opportunities` | GET (HTTPS) | 서버 측 온통청년 정책 조회 및 프록시 |

## 환경 변수

서버 측 환경 변수는 로컬 실행 시 `.env` 파일에 설정하거나 Cloud Run 런타임 환경 변수로 구성합니다:

| 변수명 | 필수 여부 | 기본값 | 설명 |
|---|---|---|---|
| `GOOGLE_CLOUD_PROJECT` | 필수 | — | Speech-to-Text 및 Vertex AI 연동용 Google Cloud 프로젝트 ID |
| `GOOGLE_CLOUD_LOCATION` | 선택 | `global` | Google Cloud Vertex AI 리전 위치 |
| `GEMINI_MODEL` | 선택 | `gemini-2.5-flash` | Gemini 모델 버전 |
| `STT_MAX_SESSION_MS` | 선택 | `270000` | STT 스트리밍 최대 세션 지속 시간 (밀리초 단위) |
| `YOUTH_POLICY_API_KEY` | 선택 사항 | — | 온통청년 공공데이터 연동용 API 키 |
| `PORT` | 선택 | `8080` (또는 `4173`) | 서버 수신 포트 (Cloud Run에서 자동 주입) |
| `HOST` | 선택 | `0.0.0.0` | 호스트 바인딩 주소 |
| `ALLOWED_ORIGINS` | 선택 | `http://localhost:4173,...` | 쉼표로 구분된 CORS 및 WebSocket Origin 허용 목록 |

*참고: Cloud Run 프로덕션 환경에서는 런타임 애플리케이션 기본 자격 증명(ADC)을 통해 Google Cloud 인증이 직접 제공됩니다. `GOOGLE_APPLICATION_CREDENTIALS`는 로컬에서 정적 서비스 계정 키 파일로 테스트할 때만 필요합니다.*

## 로컬 개발

### 1. 사전 요구사항
- Node.js 20 이상
- Speech-to-Text 및 Vertex AI API가 활성화된 Google Cloud 프로젝트 (라이브 백엔드 기능 실행 시)

### 2. 설정 및 실행
1. 저장소를 클론하고 의존성을 설치합니다:
   ```bash
   npm install
   ```
2. 환경 변수를 구성합니다:
   ```bash
   cp .env.example .env
   # 프로젝트 설정에 맞게 .env 파일을 수정합니다
   ```
3. 개발 서버를 실행합니다:
   ```bash
   npm start
   ```
4. 브라우저에서 애플리케이션에 접속합니다 (`PORT` 설정에 따라 기본 `http://localhost:8080` 또는 `http://localhost:4173`).

## 저장소 및 보안

- **클라이언트 측 개인정보 보호**: 강의 자막, 노트, 일정, 게시판 글 및 학생 프로필은 브라우저의 `localStorage`에만 저장됩니다. 오디오 Blob은 클라이언트 측 `IndexedDB`에 보관됩니다.
- **클라이언트 시크릿 제로화**: 프론트엔드 자산에는 API 키, 비공개 토큰 또는 Google 자격 증명이 일체 포함되지 않습니다.
- **서버 ID 및 권한**: Cloud Run에서 실행되는 백엔드는 세분화된 IAM 역할(`roles/speech.client`, `roles/aiplatform.user`)을 가진 Cloud Run 런타임 서비스 계정(ADC)을 사용합니다.
- **오리진 검증**: HTTP 사전 요청(preflight) 및 WebSocket 연결 업그레이드 모두 엄격한 `ALLOWED_ORIGINS` 헤더 검증을 수행합니다.

## 프로젝트 구조

```text
├── docs/                 # 아키텍처 사양, API 및 배포 문서
├── public/               # 프로덕션 호스팅을 위한 동기화된 정적 프론트엔드 출력물
├── scripts/
│   ├── build.js          # 정적 자산 빌드 및 동기화 스크립트
│   └── test-schedule-date.mjs # 일정 날짜 정규화 테스트 스위트
├── src/
│   ├── components/
│   │   └── icons.js      # Lucide 아웃라인 규격 기반 무의존성 SVG 아이콘 시스템
│   ├── data/
│   │   └── student.js    # 기본 목업 모델 및 수강 과목 정의
│   ├── services/
│   │   ├── config.js     # 통합 백엔드 및 WebSocket URL 해석 모듈
│   │   └── index.js      # 클라이언트 어댑터 (STT, 번역, 노트, 스토리지)
│   ├── app.js            # 메인 클라이언트 단일 페이지 애플리케이션 로직
│   └── styles.css        # 반응형 스타일링 및 디자인 시스템
├── .env.example          # 백엔드 환경 변수 템플릿
├── Dockerfile            # Cloud Run 배포용 컨테이너 사양서
├── package.json          # Node.js 프로젝트 스크립트 및 의존성 정의
├── server.js             # Node.js 백엔드 서버, WebSocket STT 프록시 및 API
└── wrangler.jsonc        # 정적 배포 출력 디렉터리 구성 파일
```

## 테스트 및 검증

npm 스크립트를 사용하여 자동화된 회귀 및 구문 검사를 실행합니다:

```bash
npm run check          # server.js, app.js 및 services 구문 유효성 검사
npm run test:schedule  # 일정 날짜 추출 정규화 픽스처 테스트 실행
npm run build          # 정적 자산 빌드 및 public/ 동기화 실행
```

## 알려진 제한사항

- **브라우저 종속 영속성**: 데이터가 브라우저의 `localStorage` 및 `IndexedDB`에 로컬 저장되므로, 브라우저 캐시 및 사이트 데이터를 초기화하면 저장된 녹음본과 노트가 삭제됩니다.
- **실시간 미디어 권한**: 마이크 캡처 및 실시간 STT 스트리밍을 사용하려면 브라우저 사용자의 명시적인 마이크 권한 허용이 필요합니다.
