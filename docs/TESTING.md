# Phase 6 testing

## Verified in code/local runtime

- JavaScript syntax checks for application and services
- Deterministic schedule date fixtures: absolute date, relative date, Monday-start week semantics, year rollover, ambiguity, multiple lectures, multiple events, same-date different events, and confirmed filtering
- Schedule route responds successfully in the local server
- Board ownership controls, edit form, inline comment edit, and browser refresh persistence were previously exercised in the local browser

## User test required

- Real microphone → Google STT → Gemini translation end-to-end
- Saved audio persistence/replay and timestamp seeking on a newly recorded lecture
- Smart Note PDF file contents, including Korean glyph rendering, in a normal browser download environment
- Calendar confirmation/re-extraction with the user's existing schedule data
- Public-data API response with the user's permitted key
- Korean/English mobile viewport visual review

No Phase 6 verification should intentionally create duplicate calendar events or delete user data.

## Known audit findings

- Lecture deletion removes recording metadata, its Smart Note, quiz answers, and its IndexedDB audio blob. It does not currently remove an already-persisted pending schedule candidate for that lecture until the next extraction refreshes the candidate list. Confirmed calendar events remain intentionally independent.
- GitHub ZIP generation could not be performed in the current Windows environment because archive creation was blocked. The source, documentation, `.gitignore`, and `.env.example` are prepared; create and validate the archive after allowing the trusted archive tool to write in the project folder.
