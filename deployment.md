# Study Mate Split Deployment Guide

This document describes the split deployment topology for Study Mate.

## Architecture Overview

```text
+----------------------------+
|      GenSpark Frontend     |  (Static Web App: HTML / CSS / Client JS)
|  https://<frontend-domain> |
+----------------------------+
               |
               | HTTPS (REST API) & WSS (/api/stt)
               v
+----------------------------+
|   Google Cloud Run Node    |  (server.js container via Dockerfile)
|  https://<backend-domain>  |
+----------------------------+
               |
               +---> Google Cloud Speech-to-Text (gRPC streaming recognize)
               +---> Google Cloud Vertex AI / Gemini API
               +---> OnTong Youth Policy Public API
```

## Security & Secret Isolation

- **Client / Frontend**:
  - Contains NO secret credentials, private keys, or tokens.
  - Only needs to know the public backend URL (`API_BASE_URL`).
  - Runtime configuration can be set via `window.__STUDY_MATE_CONFIG__ = { API_BASE_URL: 'https://<backend-url>' }` or saved in `localStorage.setItem('studyMateBackendUrl', 'https://<backend-url>')`.
- **Backend / Cloud Run**:
  - Executes `server.js` inside Node.js 20+ runtime.
  - Uses Google Cloud runtime Service Account Application Default Credentials (ADC) directly without static JSON key files.
  - Secret variables (`YOUTH_POLICY_API_KEY`, `GOOGLE_CLOUD_PROJECT`, `ALLOWED_ORIGINS`) are configured via Cloud Run environment variables or Secret Manager.

## Backend Deployment (Google Cloud Run)

1. **Prerequisites**:
   - Google Cloud Project with Cloud Run API, Speech-to-Text API, and Vertex AI API enabled.
   - Cloud Run runtime service account granted:
     - `roles/speech.client`
     - `roles/aiplatform.user`
2. **Build & Deploy Container**:
   ```bash
   gcloud run deploy study-mate-backend \
     --source . \
     --region <YOUR_GCP_REGION> \
     --platform managed \
     --allow-unauthenticated \
     --set-env-vars GOOGLE_CLOUD_PROJECT=<YOUR_PROJECT_ID>,ALLOWED_ORIGINS=https://<YOUR_GENSPARK_FRONTEND_URL>
   ```
3. **Verify Health**:
   - Check HTTP GET `/api/opportunities` or preflight OPTIONS `/api/translate` returns appropriate CORS headers.

## Frontend Configuration (GenSpark)

1. Obtain the deployed Cloud Run service URL (e.g. `https://study-mate-backend-xyz.run.app`).
2. Inject the backend URL into the web application:
   - Option A: In `index.html` head:
     ```html
     <script>
       window.__STUDY_MATE_CONFIG__ = {
         API_BASE_URL: 'https://study-mate-backend-xyz.run.app'
       };
     </script>
     ```
   - Option B: Through browser devtools console / UI setting via `localStorage`:
     ```javascript
     localStorage.setItem('studyMateBackendUrl', 'https://study-mate-backend-xyz.run.app');
     ```
3. Both HTTP API requests (`/api/*`) and WebSocket STT (`/api/stt` over `wss://`) will automatically connect to the Cloud Run backend.
