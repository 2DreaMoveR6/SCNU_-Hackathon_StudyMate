# Server API

All endpoints are served by `server.js`. Credentials stay in the server environment.

| Endpoint | Method | Purpose |
|---|---:|---|
| `/api/stt` | WebSocket | Google STT streaming proxy for browser WebM/Opus chunks |
| `/api/translate` | POST | Gemini correction and translation for final transcript segments |
| `/api/smart-note` | POST | Gemini Smart Note generation |
| `/api/schedule-extract` | POST | Server schedule extraction endpoint retained for compatibility; current Schedule UI uses the local deterministic extractor |
| `/api/opportunities` | GET | Server-side youth-policy lookup |

Errors are returned as JSON for HTTP endpoints. The STT socket reports structured status, result, and error frames. Do not call Google APIs directly from browser code.
