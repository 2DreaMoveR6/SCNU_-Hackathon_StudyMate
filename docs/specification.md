# Study Mate specification

Study Mate targets international students who need accessible lecture capture, translation, review, and academic planning.

Implemented flows:

- Lecture recording: microphone permission → MediaRecorder → Google STT WebSocket proxy → final transcript → optional Gemini correction/translation.
- Review: saved audio/transcript segments → timestamp seek → Smart Note, keyword popup, quiz, edit, and PDF download.
- Schedule: all saved lecture transcripts → deterministic schedule detection/date normalization → pending candidates → user confirmation → calendar event.
- Community: browser-local board posts/comments, including prototype ownership-based edit/delete controls.
- Profile and support: student profile/course persistence, chatbot responses, and server-proxied youth-policy opportunities.

The board ownership UI is a prototype convenience, not server-side authorization. Calendar candidates are never automatically added.
