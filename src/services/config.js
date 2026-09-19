// Runtime configuration for API endpoints and external backend connectivity.
// In local development (same-origin), endpoints remain relative or default to window.location.
// In split deployment, window.__STUDY_MATE_CONFIG__ or localStorage 'studyMateBackendUrl'
// supplies the external backend base URL (e.g. 'https://backend.example.run.app').

export function getBackendBaseUrl() {
  if (typeof window === 'undefined') return '';
  const injected = window.__STUDY_MATE_CONFIG__?.API_BASE_URL;
  if (injected && typeof injected === 'string' && injected.trim()) {
    return injected.trim().replace(/\/+$/, '');
  }
  try {
    const saved = localStorage.getItem('studyMateBackendUrl');
    if (saved && typeof saved === 'string' && saved.trim()) {
      return saved.trim().replace(/\/+$/, '');
    }
  } catch (_) {}
  return '';
}

export function getHttpApiUrl(path) {
  const base = getBackendBaseUrl();
  const cleanPath = path.startsWith('/') ? path : `/${path}`;
  if (!base) return cleanPath;
  return `${base}${cleanPath}`;
}

export function getWebSocketApiUrl(path = '/api/stt') {
  const base = getBackendBaseUrl();
  const cleanPath = path.startsWith('/') ? path : `/${path}`;
  if (base) {
    const wsScheme = base.startsWith('https://') ? 'wss://' : 'ws://';
    const host = base.replace(/^https?:\/\//, '');
    return `${wsScheme}${host}${cleanPath}`;
  }
  const defaultScheme = typeof location !== 'undefined' && location.protocol === 'https:' ? 'wss' : 'ws';
  const defaultHost = typeof location !== 'undefined' ? location.host : 'localhost:4173';
  return `${defaultScheme}://${defaultHost}${cleanPath}`;
}
