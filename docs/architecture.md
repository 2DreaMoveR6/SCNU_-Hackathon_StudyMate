# Architecture

## Runtime boundaries

```text
Browser
  ├─ localStorage: profile, courses, notes, schedules, board data
  ├─ IndexedDB: recorded audio blobs
  ├─ MediaRecorder/Web Audio constraints
  └─ WebSocket /api/stt and HTTP API calls

Node server
  ├─ Google Cloud Speech-to-Text streaming
  ├─ Gemini translation and Smart Note endpoints
  └─ Youth Policy API proxy
```

## Lecture path

`Microphone → MediaRecorder WebM/Opus chunks → /api/stt → Google STT final results → transcript segmenter with word offsets → Gemini correction/translation → caption UI`.

## Schedule path

`Saved corrected transcript segments → local keyword detection → deterministic Korean date normalization using recording time → stable candidate identity → confirmed/dismissed filtering → user-reviewed calendar event`.

The current Schedule UI does not call Gemini for candidate extraction.
