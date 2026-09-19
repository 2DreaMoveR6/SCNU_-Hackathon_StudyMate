# Study Mate

Study Mate is a local-first learning companion for international students. It records lectures in the browser, sends audio to a server-side Google Speech-to-Text proxy, displays corrected Korean and translated captions, and keeps lecture review materials in the browser.

## What it supports

- Browser microphone recording, pause/resume, audio download, and IndexedDB audio storage
- Google Cloud Speech-to-Text streaming through `/api/stt`
- Gemini-backed Korean correction and subtitle translation through `/api/translate`
- Timestamped lecture review, Smart Notes, keyword explanations, quizzes, editing, and PDF download
- Schedule candidate extraction from saved corrected transcripts, user review, reminders, and calendar storage
- Board post/comment prototype CRUD, student profile/course storage, chatbot, and youth-policy recommendations
- Korean and English interface modes

## Architecture

```text
Browser microphone → MediaRecorder/WebSocket → Study Mate server → Google STT
Google STT final → corrected transcript → Gemini translation → subtitle history
Saved transcript → Smart Note or local schedule detection → user-reviewed calendar event
```

Secrets remain server-side. The browser never receives Google credentials or the youth-policy API key.

## Local setup

1. Install Node.js 20+.
2. Copy `.env.example` to `.env` and set only the server environment values you have permission to use.
3. Install dependencies with `npm install`.
4. Run `npm start`.
5. Open `http://localhost:4173` (or set `PORT` before starting).

The current development workspace may use another port, such as 4174, when `PORT` is configured externally.

## Environment variables

See `.env.example` for names only. Google STT supports server-side Application Default Credentials, `GOOGLE_APPLICATION_CREDENTIALS`, or an attached service account. Gemini uses the Google Cloud authentication available to the server runtime. `YOUTH_POLICY_API_KEY` is optional and is used only by the server-side policy proxy.

## Storage and limitations

Lecture metadata, notes, schedules, board content, profile settings, and candidate state use browser localStorage. Audio is stored in IndexedDB when available. This is not shared cloud storage and is tied to the browser profile. Real microphone, Google Cloud, PDF-file, and public-data verification require a user browser/environment with the relevant permissions.

## Deployment status

Local prototype; public deployment is pending. A production host must support Node.js, secure WebSocket connections, Google Cloud authentication, and server-side environment variables.
