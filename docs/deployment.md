# Deployment notes

This repository is prepared for GitHub transfer, not public deployment.

Deployment requires a Node.js host with WebSocket support, HTTPS, server-side Google Cloud authentication, and server-side environment variables. Do not upload `.env`, credential JSON, ADC files, or gcloud configuration folders. The host must support long-lived STT streaming connections; if it does not, host the Node backend separately.

Set the values named in `.env.example` only in the deployment platform's secret manager. Verify microphone permission, secure WebSocket connectivity, Google STT, Gemini, and the youth-policy proxy after deployment from an external browser.
