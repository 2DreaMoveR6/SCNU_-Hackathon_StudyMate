// Shared service contracts. Provider-specific credentials always stay outside the browser.
export class StudentService { async getProfile() { throw new Error('Not implemented'); } }
export class MockStudentAdapter extends StudentService { constructor(student) { super(); this.student = student; } async getProfile() { return this.student; } }
export class CourseService { async list() { throw new Error('Course service is not configured.'); } async save() { throw new Error('Course service is not configured.'); } }
export class LocalCourseAdapter extends CourseService {
  constructor(defaultCourses = [], storageKey = 'studyMateCourses') { super(); this.defaultCourses = defaultCourses; this.storageKey = storageKey; }
  async list() { try { const saved = JSON.parse(localStorage.getItem(this.storageKey)); if (Array.isArray(saved)) return saved; } catch (_) {} return this.defaultCourses; }
  async save(courses) { localStorage.setItem(this.storageKey, JSON.stringify(courses)); return courses; }
}

// Audio is intentionally kept out of localStorage: recordings can be large and
// survive refreshes in the browser's IndexedDB instead.
export class AudioStorage {
  async saveAudio(_lectureId, _blob) { throw new Error('Audio storage is not configured.'); }
  async getAudio(_lectureId) { throw new Error('Audio storage is not configured.'); }
  async deleteAudio(_lectureId) { throw new Error('Audio storage is not configured.'); }
  async hasAudio(lectureId) { return Boolean(await this.getAudio(lectureId)); }
}
export class IndexedDbAudioStorage extends AudioStorage {
  constructor({ databaseName = 'studyMateAudio', storeName = 'recordings' } = {}) { super(); this.databaseName = databaseName; this.storeName = storeName; }
  open() {
    return new Promise((resolve, reject) => {
      if (!window.indexedDB) return reject(new Error('IndexedDB is unavailable in this browser.'));
      const request = window.indexedDB.open(this.databaseName, 1);
      request.onupgradeneeded = () => { if (!request.result.objectStoreNames.contains(this.storeName)) request.result.createObjectStore(this.storeName); };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error || new Error('IndexedDB could not be opened.'));
    });
  }
  async run(mode, operation) {
    const database = await this.open();
    try {
      return await new Promise((resolve, reject) => {
        const transaction = database.transaction(this.storeName, mode);
        const request = operation(transaction.objectStore(this.storeName));
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error || new Error('IndexedDB request failed.'));
        transaction.onabort = () => reject(transaction.error || new Error('IndexedDB transaction failed.'));
      });
    } finally { database.close(); }
  }
  async saveAudio(lectureId, blob) { if (!lectureId || !(blob instanceof Blob)) throw new Error('A recording blob is required.'); await this.run('readwrite', store => store.put(blob, lectureId)); return { audioRef: lectureId, bytes: blob.size, mimeType: blob.type }; }
  async getAudio(lectureId) { return this.run('readonly', store => store.get(lectureId)); }
  async deleteAudio(lectureId) { await this.run('readwrite', store => store.delete(lectureId)); }
}

export class SpeechToTextService { async startStream(_options) { throw new Error('Speech-to-text adapter is not configured.'); } stopStream() {} }
export class GoogleSpeechToTextAdapter extends SpeechToTextService {
  constructor({ endpoint } = {}) { super(); this.endpoint = endpoint || `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/api/stt`; this.active = false; this.reconnects = 0; this.bytesSent = 0; this.chunkCount = 0; this.duplicateChunks = 0; this.pendingChunks = []; this.sentChunks = new WeakSet(); this.lastSend = Promise.resolve(); this.streamSequence = 0; this.streamBaseAudioOffsetMs = null; }
  async startStream({ onInterim, onFinal, onStart, onEnd, onError, onDebug, onStreamAudioBase, audioConfig = {} }) {
    this.callbacks = { onInterim, onFinal, onStart, onEnd, onError, onDebug, onStreamAudioBase }; this.audioConfig = audioConfig; this.active = true; this.reconnects = 0; this.bytesSent = 0; this.chunkCount = 0; this.duplicateChunks = 0; this.pendingChunks = []; this.sentChunks = new WeakSet(); this.lastSend = Promise.resolve(); this.streamSequence = 0; this.streamBaseAudioOffsetMs = null; await this.connect();
  }
  connect() {
    return new Promise((resolve, reject) => {
      let settled = false; const socket = this.socket = new WebSocket(this.endpoint); socket.binaryType = 'arraybuffer'; this.callbacks.onDebug?.('Google STT connection requested', this.endpoint);
      socket.onopen = () => { socket.send(JSON.stringify({ type: 'start', languageCode: this.audioConfig.languageCode || 'ko-KR', encoding: 'WEBM_OPUS', sampleRateHertz: this.audioConfig.sampleRateHertz || 48000, channelCount: 1, phraseHints: Array.isArray(this.audioConfig.phraseHints) ? this.audioConfig.phraseHints.slice(0, 20) : [] })); };
      socket.onmessage = event => { const message = JSON.parse(event.data); if (message.type === 'ready') { settled = true; this.streamSequence += 1; this.streamBaseAudioOffsetMs = null; this.callbacks.onDebug?.('Google STT ready', `WEBM_OPUS ${message.sampleRateHertz}Hz · stream=${this.streamSequence}`); this.flushPendingChunks(); this.callbacks.onStart?.({ streamSequence: this.streamSequence }); resolve(); } else if (message.type === 'interim') { this.callbacks.onDebug?.('Google STT interim', message.transcript); this.callbacks.onInterim?.(message.transcript); } else if (message.type === 'final') { const timing = { resultEndMs: message.resultEndMs, wordTimings: Array.isArray(message.wordTimings) ? message.wordTimings : [], streamSequence: this.streamSequence, streamBaseAudioOffsetMs: this.streamBaseAudioOffsetMs }; this.callbacks.onDebug?.('Google STT final', `${message.transcript} · words=${timing.wordTimings.length}`); this.callbacks.onFinal?.(message.transcript, timing); } else if (message.type === 'error') { const error = `${message.code}: ${message.message}`; this.callbacks.onDebug?.('Google STT error', error); this.callbacks.onError?.(error); if (!settled) { settled = true; reject(new Error(error)); } else { this.active = false; this.pendingChunks = []; try { socket.close(); } catch (_) {} } } else if (message.type === 'session_limit') { this.callbacks.onDebug?.('Google STT session limit'); this.reconnect('session limit'); } };
      socket.onerror = () => { const error = 'Google STT WebSocket connection failed.'; this.callbacks.onDebug?.('Google STT socket error', error); this.callbacks.onError?.(error); if (!settled) { settled = true; reject(new Error(error)); } };
      socket.onclose = () => { this.callbacks.onEnd?.(); if (this.active && settled) this.reconnect('connection closed'); };
    });
  }
  reconnect(reason) { if (!this.active || this.reconnects >= 2 || this.reconnecting) return; this.reconnecting = true; this.reconnects += 1; this.callbacks.onDebug?.('Google STT reconnect scheduled', `${reason}; attempt=${this.reconnects}`); setTimeout(() => { this.reconnecting = false; this.connect().catch(() => {}); }, 500); }
  async sendAudioChunk(blob, timing = {}) { if (!this.active || !blob?.size) return; if (this.sentChunks.has(blob)) { this.duplicateChunks += 1; this.callbacks.onDebug?.('Google STT duplicate chunk prevented', `count=${this.duplicateChunks}`); return; } const chunk = { blob, startMs: Number(timing.startMs), endMs: Number(timing.endMs) }; if (this.socket?.readyState !== WebSocket.OPEN) { if (this.pendingChunks.length < 24 && !this.pendingChunks.some(item => item.blob === blob)) this.pendingChunks.push(chunk); return; } this.lastSend = this.lastSend.then(() => this.sendBlob(chunk)); return this.lastSend; }
  async flushPendingChunks() { const pending = this.pendingChunks.splice(0); for (const chunk of pending) { if (!this.active || this.socket?.readyState !== WebSocket.OPEN) break; await this.sendBlob(chunk); } }
  async sendBlob(chunk) { const { blob } = chunk; if (this.sentChunks.has(blob)) return; const bytes = await blob.arrayBuffer(); if (this.socket?.readyState !== WebSocket.OPEN) { if (this.active && this.pendingChunks.length < 24 && !this.pendingChunks.some(item => item.blob === blob)) this.pendingChunks.push(chunk); return; } this.socket.send(bytes); this.sentChunks.add(blob); if (this.streamBaseAudioOffsetMs === null) { this.streamBaseAudioOffsetMs = Number.isFinite(chunk.startMs) ? Math.max(0, chunk.startMs) : 0; this.callbacks.onStreamAudioBase?.({ streamSequence: this.streamSequence, streamBaseAudioOffsetMs: this.streamBaseAudioOffsetMs, firstChunkEndMs: Number.isFinite(chunk.endMs) ? chunk.endMs : null }); this.callbacks.onDebug?.('Google STT stream base', `stream=${this.streamSequence}, audio=${this.streamBaseAudioOffsetMs}ms`); } this.chunkCount += 1; this.bytesSent += bytes.byteLength; this.callbacks.onDebug?.('Google STT audio chunk', `chunk=${this.chunkCount}, bytes=${this.bytesSent}`); }
  async flushAudio() { await this.lastSend; }
  stopStream() { this.active = false; this.pendingChunks = []; try { this.socket?.send(JSON.stringify({ type: 'stop' })); } catch (_) { try { this.socket?.close(); } catch (_) {} } }
}
export class MockSpeechToTextAdapter extends SpeechToTextService {
  async startStream({ onInterim, onFinal }) {
    const phrases = ['Today we will review the linked list data structure.', 'Each node stores a value and a reference to the next node.', 'This is useful when the size of our data changes frequently.'];
    let index = 0;
    this.timer = setInterval(() => { const phrase = phrases[index++ % phrases.length]; onInterim(`${phrase.slice(0, Math.max(12, phrase.length - 16))}…`); setTimeout(() => onFinal(phrase), 750); }, 4300);
    onInterim('Listening for your lecture…');
  }
  stopStream() { clearInterval(this.timer); }
}

// Uses the browser's speech-recognition engine. It produces recognition results from
// the live microphone, unlike the Mock adapter. Browser support varies by vendor.
export class BrowserSpeechRecognitionAdapter extends SpeechToTextService {
  static isSupported() { return Boolean(window.SpeechRecognition || window.webkitSpeechRecognition); }
  constructor({ language = 'ko-KR' } = {}) { super(); this.language = language; this.active = false; }
  async startStream({ onInterim, onFinal, onStart, onEnd, onError, onDebug }) {
    const Recognition = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!Recognition) throw new Error('This browser does not provide live speech recognition.');
    this.active = true;
    this.restartCount = 0;
    this.recognition = new Recognition();
    onDebug?.('STT initialized', `engine=${window.SpeechRecognition ? 'SpeechRecognition' : 'webkitSpeechRecognition'}, lang=${this.language}`);
    this.recognition.lang = this.language;
    this.recognition.continuous = true;
    this.recognition.interimResults = true;
    this.recognition.onresult = event => {
      for (let i = event.resultIndex; i < event.results.length; i += 1) {
        const result = event.results[i]; const text = result[0]?.transcript?.trim();
        if (!text) continue;
        this.restartCount = 0;
        if (result.isFinal) { onDebug?.('STT final transcript', text); onFinal(text); }
        else { onDebug?.('STT interim transcript', text); onInterim(text); }
      }
    };
    this.recognition.onstart = () => { onDebug?.('STT onstart'); onStart?.(); };
    this.recognition.onerror = event => {
      if (event.error === 'aborted') return;
      onDebug?.('STT onerror', event.error || 'unknown'); onError?.(event.error);
      if (['not-allowed', 'service-not-allowed', 'audio-capture', 'language-not-supported'].includes(event.error)) this.active = false;
    };
    this.recognition.onend = () => {
      onDebug?.('STT onend', `active=${this.active}, restart=${this.restartCount}`); onEnd?.();
      if (!this.active) return;
      if (this.restartCount >= 2) { this.active = false; onError?.('recognition-ended'); return; }
      this.restartCount += 1; onDebug?.('STT restart scheduled', `attempt=${this.restartCount}`);
      this.restartTimer = window.setTimeout(() => { if (this.active) { try { this.recognition.start(); } catch (error) { onError?.('restart-failed'); } } }, 350);
    };
    try { onDebug?.('STT start requested', `lang=${this.recognition.lang}`); this.recognition.start(); } catch (error) { this.active = false; onDebug?.('STT start exception', `${error.name}: ${error.message}`); throw error; }
  }
  stopStream() { this.active = false; clearTimeout(this.restartTimer); try { this.recognition?.stop(); } catch (_) {} }
}

export class TranslationService { async translate(_text, _language, _glossary, _context) { throw new Error('Translation adapter is not configured.'); } }
export class GeminiTranslationAdapter extends TranslationService {
  constructor({ endpoint = '/api/translate' } = {}) { super(); this.endpoint = endpoint; }
  async translate(text, targetLanguage, glossary = [], context = {}) {
    const startedAt = performance.now();
    const timing = { geminiRequestStartedAt: startedAt, geminiResponseReceivedAt: null, responseParsedAt: null };
    let response;
    try {
      response = await fetch(this.endpoint, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text, targetLanguage, glossary, previousSegments: Array.isArray(context.previousSegments) ? context.previousSegments.slice(-2) : [], course: String(context.course || '').slice(0, 120) }) });
    } catch (_) { throw Object.assign(new Error('Gemini translation network request failed.'), { code: 'network' }); }
    timing.geminiResponseReceivedAt = performance.now();
    let body;
    try { body = await response.json(); } catch (_) { throw Object.assign(new Error('Gemini translation returned an invalid response.'), { code: 'invalid-response' }); }
    timing.responseParsedAt = performance.now();
    if (!response.ok) throw Object.assign(new Error(body.message || 'Gemini translation failed.'), { code: body.error || `http-${response.status}` });
    if (!body.correctedKorean || !body.translatedText) throw Object.assign(new Error('Gemini translation response is incomplete.'), { code: 'invalid-response' });
    return { ...body, latencyMs: Math.round(performance.now() - startedAt), timing };
  }
  async translateSegments(segments, targetLanguage, glossary = [], context = {}) {
    const source = Array.isArray(segments) ? segments.map(segment => ({ id: String(segment?.id || ''), text: String(segment?.content || '').trim() })).filter(segment => segment.id && segment.text) : [];
    if (!source.length) throw Object.assign(new Error('Final transcript segments are required.'), { code: 'invalid-input' });
    const startedAt = performance.now(); const timing = { geminiRequestStartedAt: startedAt, geminiResponseReceivedAt: null, responseParsedAt: null }; let response;
    try { response = await fetch(this.endpoint, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ segments: source, targetLanguage, glossary, previousSegments: Array.isArray(context.previousSegments) ? context.previousSegments.slice(-2) : [], course: String(context.course || '').slice(0, 120) }) }); }
    catch (_) { throw Object.assign(new Error('Gemini translation network request failed.'), { code: 'network' }); }
    timing.geminiResponseReceivedAt = performance.now();
    let body;
    try { body = await response.json(); } catch (_) { throw Object.assign(new Error('Gemini translation returned an invalid response.'), { code: 'invalid-response' }); }
    timing.responseParsedAt = performance.now();
    if (!response.ok && body.error === 'invalid-input') {
      // A running server from before this client update only understands the
      // single-final payload. Keep live captions working until it is restarted;
      // its validation rejects this request before Gemini is invoked.
      const legacy = await this.translate(source.map(segment => segment.text).join(' '), targetLanguage, glossary, context);
      return { segments: source.map((segment, index) => index === 0 ? { id: segment.id, correctedKorean: legacy.correctedKorean, translatedText: legacy.translatedText } : { id: segment.id, correctedKorean: segment.text, translatedText: '' }), latencyMs: Math.round(performance.now() - startedAt), timing: legacy.timing || timing, compatibilityMode: true };
    }
    if (!response.ok) throw Object.assign(new Error(body.message || 'Gemini translation failed.'), { code: body.error || `http-${response.status}` });
    if (!Array.isArray(body.segments) || body.segments.length !== source.length) throw Object.assign(new Error('Gemini translation batch response is incomplete.'), { code: 'invalid-response' });
    return { ...body, latencyMs: Math.round(performance.now() - startedAt), timing };
  }
}
export class MockTranslationAdapter extends TranslationService { async translate(text, language) { return { correctedKorean: text, translatedText: language === 'ko' ? `한국어 보정 번역: ${text}` : `Study translation: ${text}`, model: 'mock', latencyMs: 0 }; } }

export class GlossaryService { async findRelevant(_text) { throw new Error('Glossary adapter is not configured.'); } }
export class MockGlossaryAdapter extends GlossaryService {
  constructor(entries = []) { super(); this.entries = entries; }
  courseEntries(course) {
    const id = String(course?.id || '').trim();
    return this.entries.filter(entry => !entry.courseIds?.length || entry.courseIds.includes(id));
  }
  async findRelevant(text) {
    const source = String(text || '').toLowerCase();
    return this.entries.filter(entry => source.includes(String(entry.term || '').toLowerCase()) || (entry.aliases || []).some(alias => source.includes(String(alias).toLowerCase()))).slice(0, 6);
  }
  async findForCourse(course) { return this.courseEntries(course).slice(0, 20); }
  async findCandidates(text, course, limit = 6) {
    const tokens = String(text || '').match(/[가-힣]{2,}|[A-Za-z][A-Za-z0-9-]{1,}/g) || [];
    const score = (raw, candidate) => {
      const a = [...String(raw)]; const b = [...String(candidate)];
      if (a.join('') === b.join('')) return 1;
      const parts = value => [...value].map(char => { const code = char.charCodeAt(0) - 0xAC00; return code >= 0 && code < 11172 ? [Math.floor(code / 588), Math.floor((code % 588) / 28), code % 28] : [char]; });
      const x = parts(a.join('')); const y = parts(b.join('')); if (x.length !== y.length || !x.length) return 0;
      return x.reduce((total, item, index) => total + item.filter((value, part) => value === y[index][part]).length / item.length, 0) / x.length;
    };
    return this.courseEntries(course).map(entry => {
      const variants = [entry.term, ...(entry.aliases || [])]; const best = Math.max(...tokens.flatMap(token => variants.map(term => score(token.toLowerCase(), String(term).toLowerCase()))));
      return { ...entry, matchScore: best };
    }).filter(entry => entry.matchScore >= 0.62).sort((a, b) => b.matchScore - a.matchScore).slice(0, limit);
  }
}

export class TranscriptSegmenter {
  segment(text, { startMs = 0, endMs = startMs, timestampSource = 'estimated', wordTimings = [], streamSequence = null, streamBaseAudioOffsetMs = null } = {}) {
    const parts = text.split(/(?<=[.!?。！？])\s*/).filter(Boolean);
    const safeStart = Math.max(0, Number(startMs) || 0);
    const safeEnd = Math.max(safeStart, Number(endMs) || safeStart);
    const words = (Array.isArray(wordTimings) ? wordTimings : []).map(word => ({ word: String(word?.word || ''), startMs: Number(word?.startMs), endMs: Number(word?.endMs) })).filter(word => word.word && Number.isFinite(word.startMs) && Number.isFinite(word.endMs) && word.endMs >= word.startMs);
    const longFinal = safeEnd - safeStart >= 12000;
    const timingGroups = [];
    if (longFinal && words.length > 1) {
      let group = [words[0]];
      for (let index = 1; index < words.length; index += 1) {
        const previous = words[index - 1]; const current = words[index];
        const pauseMs = Math.max(0, current.startMs - previous.endMs);
        const punctuation = /[.!?。！？]$/.test(previous.word);
        if ((punctuation && pauseMs >= 250) || pauseMs >= 900) { timingGroups.push(group); group = [current]; }
        else group.push(current);
      }
      timingGroups.push(group);
    }
    // A long final without an actual word-boundary pause stays intact. We never
    // fabricate timing from character count or evenly divided durations.
    const sourceParts = timingGroups.length > 1 ? timingGroups.map(group => group.map(word => word.word).join(' ').replace(/\s+([.!?。！？])/g, '$1').trim()) : parts;
    const sourceWords = timingGroups.length > 1 ? timingGroups : words;
    const totalWeight = sourceParts.reduce((total, content) => total + Math.max(1, [...content].length), 0);
    const tokenCount = content => (String(content).match(/[가-힣A-Za-z0-9]+/g) || []).length;
    let offset = safeStart;
    let wordIndex = 0;
    return sourceParts.map((content, index) => {
      const isLast = index === sourceParts.length - 1;
      const requestedWordCount = tokenCount(content);
      const assignedWords = timingGroups.length > 1 ? sourceWords[index] : (words.length && requestedWordCount ? words.slice(wordIndex, isLast ? words.length : wordIndex + requestedWordCount) : []);
      wordIndex += assignedWords.length;
      const hasWordTiming = assignedWords.length > 0;
      const width = isLast ? safeEnd - offset : Math.round((safeEnd - safeStart) * Math.max(1, [...content].length) / totalWeight);
      const segmentStart = hasWordTiming ? assignedWords[0].startMs : offset;
      const segmentEnd = hasWordTiming ? assignedWords.at(-1).endMs : Math.max(offset, offset + width);
      const segment = { id: `${Date.now()}-${index}`, content, rawKorean: content, correctedKorean: '', translatedText: '', startMs: segmentStart, endMs: Math.max(segmentStart, segmentEnd), timestampSource: hasWordTiming ? 'google-word-offset' : timestampSource, googleStartMs: hasWordTiming ? assignedWords[0].startMs : null, googleEndMs: hasWordTiming ? assignedWords.at(-1).endMs : null, wordTimings: assignedWords, streamSequence, streamBaseAudioOffsetMs, status: 'final' };
      offset = segment.endMs;
      return segment;
    });
  }
}

export class RecordingService { async start() { throw new Error('Recording adapter is not configured.'); } }
export class BrowserRecordingService extends RecordingService {
  async start() {
    if (!navigator.mediaDevices?.getUserMedia || !window.MediaRecorder) throw new Error('This browser does not support microphone recording.');
    const originalStream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true } });
    const audioContext = window.AudioContext ? new AudioContext() : null;
    const destination = audioContext ? audioContext.createMediaStreamDestination() : null;
    if (audioContext && destination) audioContext.createMediaStreamSource(originalStream).connect(destination);
    const processedStream = destination?.stream || originalStream;
    const mimeType = ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4'].find(type => MediaRecorder.isTypeSupported(type));
    const recorder = new MediaRecorder(originalStream, mimeType ? { mimeType } : undefined);
    const chunks = [];
    recorder.addEventListener('dataavailable', event => { if (event.data.size) chunks.push(event.data); });
    return { originalStream, processedStream, audioContext, recorder, chunks, mimeType: recorder.mimeType || 'audio/webm' };
  }
}

export class NoteGenerator { async generate() { throw new Error('Note generator is not configured.'); } }
function hasExpectedLanguage(value, language) { const text = String(value || '').trim(); return Boolean(text) && (language === 'ko' ? /[가-힣]/.test(text) : !/[가-힣]/.test(text)); }
function validateSmartNotePayload(note, language) {
  if (!note || !hasExpectedLanguage(note.title, language) || !hasExpectedLanguage(note.summary, language) || !Array.isArray(note.keywords) || !note.keywords.length || !Array.isArray(note.studyTips) || !note.studyTips.length || !Array.isArray(note.quizzes) || note.quizzes.length < 2) throw Object.assign(new Error('Smart Note response is incomplete.'), { code: 'invalid-smart-note' });
  if (note.keywords.some(keyword => !keyword || !hasExpectedLanguage(keyword, language) || !note.keywordDetails?.[keyword]?.meaning || !note.keywordDetails?.[keyword]?.context || !note.keywordDetails?.[keyword]?.studyTip)) throw Object.assign(new Error('Smart Note keyword definitions are incomplete.'), { code: 'invalid-smart-note' });
  if (note.studyTips.some(tip => !hasExpectedLanguage(tip, language))) throw Object.assign(new Error('Smart Note study tips did not match the selected language.'), { code: 'invalid-smart-note' });
  for (const quiz of note.quizzes) { const options = Array.isArray(quiz.options) ? quiz.options : []; const languageItems = quiz.type === 'OX' ? [quiz.question, quiz.explanation] : [quiz.question, quiz.explanation, ...options]; if (!hasExpectedLanguage(quiz.question, language) || !hasExpectedLanguage(quiz.explanation, language) || !languageItems.every(item => hasExpectedLanguage(item, language)) || (quiz.type === 'OX' ? options.length !== 2 : options.length !== 4) || new Set(options).size !== options.length || !options.includes(quiz.answer)) throw Object.assign(new Error('Smart Note quiz validation failed.'), { code: 'invalid-smart-note' }); }
}
export class GeminiSmartNoteGenerator extends NoteGenerator {
  constructor({ endpoint = '/api/smart-note' } = {}) { super(); this.endpoint = endpoint; }
  async generate({ lecture, transcript, student, language, glossary = [] }) {
    const timing = { geminiRequestStartedAt: performance.now(), geminiResponseReceivedAt: null, responseParsedAt: null };
    let response;
    try { response = await fetch(this.endpoint, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ lecture, transcript, student, language, glossary }) }); } catch (_) { throw Object.assign(new Error('Smart Note network request failed.'), { code: 'network' }); }
    timing.geminiResponseReceivedAt = performance.now();
    let body;
    try { body = await response.json(); } catch (_) { throw Object.assign(new Error('Smart Note returned an invalid response.'), { code: 'invalid-response' }); }
    timing.responseParsedAt = performance.now();
    if (!response.ok) throw Object.assign(new Error(body.message || 'Smart Note generation failed.'), { code: body.error || `http-${response.status}` });
    validateSmartNotePayload(body, language);
    return { ...body, id: `note-${lecture.id}-${Date.now()}`, lectureId: lecture.id, title: body.title?.trim() || lecture.title, date: lecture.date || new Date().toLocaleDateString(), transcript: [...transcript], createdAt: new Date().toISOString(), timing };
  }
}
function unique(values) { return [...new Set(values.filter(Boolean))]; }
function transcriptKeywords(lines, student) {
  const source = lines.join(' ');
  const majorMatches = (student.majorKeywords || []).filter(keyword => new RegExp(keyword.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i').test(source));
  const koreanTerms = source.match(/[가-힣]{2,}/g) || [];
  const englishTerms = source.match(/[A-Za-z][A-Za-z-]{3,}/g) || [];
  const ignored = new Set(['today', 'lecture', 'about', 'this', 'that', 'with', 'will', 'have', 'from', '그리고', '오늘은', '대한', '설명', '합니다', '있습니다']);
  const terms = [...koreanTerms, ...englishTerms.map(term => term.toLowerCase())].filter(term => !ignored.has(term.toLowerCase()));
  const ranked = unique(terms).sort((a, b) => terms.filter(term => term === b).length - terms.filter(term => term === a).length);
  return unique([...majorMatches, ...ranked]).slice(0, 5);
}
export class TranscriptNoteGenerator extends NoteGenerator {
  async generate({ lecture, transcript, student }) {
    const lines = (transcript || []).map(line => String(line || '').trim()).filter(Boolean);
    if (!lines.length) throw Object.assign(new Error('A final transcript is required to create a note.'), { code: 'empty-transcript' });
    const keywords = transcriptKeywords(lines, student);
    const firstSentence = lines[0];
    const keywordDetails = Object.fromEntries(keywords.map(keyword => [keyword, {
      meaning: `${keyword} is a key term from this lecture.`,
      context: lines.find(line => line.toLowerCase().includes(keyword.toLowerCase())) || firstSentence,
      major: `${student.department} Year ${student.grade}: connect this term to the examples from ${lecture.course || lecture.title}.`
    }]));
    return {
      id: `note-${lecture.id}-${Date.now()}`, lectureId: lecture.id, title: lecture.title, date: lecture.date || new Date().toLocaleDateString(),
      summary: lines.slice(0, 3).join(' '), keyPoints: lines.slice(0, 5), keySentences: lines.slice(0, 3),
      reviewPoints: keywords.length ? keywords.map(keyword => `Explain ${keyword} using the lecture transcript.`) : ['Review the final transcript and identify the main concept in your own words.'],
      keywords, keywordDetails, transcript: lines, createdAt: new Date().toISOString()
    };
  }
}
export class MockNoteGenerator extends NoteGenerator {
  async generate({ lecture, transcript, student }) {
    const lines = transcript.filter(Boolean);
    const source = lines.join(' ') || 'No final transcript was captured for this lecture.';
    const keywords = student.majorKeywords.filter(keyword => new RegExp(keyword, 'i').test(source));
    const fallbackKeywords = keywords.length ? keywords : student.majorKeywords.slice(0, 3);
    return {
      id: `note-${lecture.id}-${Date.now()}`, lectureId: lecture.id, title: lecture.title, date: lecture.date || new Date().toLocaleDateString(),
      summary: `This ${student.department} lecture introduces ${fallbackKeywords.join(', ')} and connects the ideas to the course material. ${source.slice(0, 170)}`,
      keyPoints: lines.length ? lines.slice(0, 3) : ['Review the recording when a final transcript becomes available.', 'Identify the core concept before memorizing details.'],
      keySentences: lines.length ? lines.slice(0, 2) : ['A final transcript is needed for lecture-specific key sentences.'],
      reviewPoints: [`Explain ${fallbackKeywords[0]} in your own words.`, `Relate this lecture to ${student.courses[0]}.`, 'Revisit the examples before the next class.'],
      keywords: fallbackKeywords, transcript: lines, createdAt: new Date().toISOString()
    };
  }
}
export class QuizGenerator { async generate() { throw new Error('Quiz generator is not configured.'); } }
export class TranscriptQuizGenerator extends QuizGenerator {
  async generate(note) {
    const sentence = note.keySentences?.[0] || note.transcript?.[0];
    if (!sentence) return [];
    const keyword = note.keywords?.[0] || 'the main lecture concept';
    return [
      { id: `ox-${note.id}`, type: 'OX', question: `O/X: "${sentence}" is a sentence from this lecture.`, options: ['O', 'X'], answer: 'O', explanation: 'This statement comes directly from the final lecture transcript.' },
      { id: `mc-${note.id}`, type: 'MC', question: `Which item was discussed in this lecture?`, options: [sentence, `A topic unrelated to ${keyword}`, 'No lecture transcript was captured', 'A different course recording'], answer: sentence, explanation: 'The correct answer is taken from this lecture’s final transcript.' }
    ];
  }
}
export class MockQuizGenerator extends QuizGenerator {
  async generate(note) { const keyword = note.keywords[0] || 'the key concept'; return [
    { id: 'ox-1', type: 'OX', question: `${keyword} is unrelated to this lecture.`, options: ['O', 'X'], answer: 'X', explanation: `${keyword} is one of the concepts selected for this lecture.` },
    { id: 'mc-1', type: 'MC', question: 'What is the best first step for reviewing this lecture?', options: ['Ignore the transcript', 'Explain a key concept in your own words', 'Wait until the final exam', 'Delete the recording'], answer: 'Explain a key concept in your own words', explanation: 'Active recall helps turn lecture content into durable understanding.' }
  ]; }
}
export class ScheduleExtractor { async extract() { throw new Error('Schedule extraction is not connected yet.'); } }
const scheduleCue = /(?:시험|고사|퀴즈|과제|제출|마감|휴강|보강|회의|신청|예약|수업|발표\s*(?:가|를|은|는|입니다|있|하))/i;
const weekdayOffsets = { '월요일': 0, '화요일': 1, '수요일': 2, '목요일': 3, '금요일': 4, '토요일': 5, '일요일': 6 };
const koreanDigits = { 영: 0, 공: 0, 일: 1, 이: 2, 삼: 3, 사: 4, 오: 5, 육: 6, 칠: 7, 팔: 8, 구: 9 };
function pad(value) { return String(value).padStart(2, '0'); }
function localDate(value) { const raw = String(value || ''); const date = value instanceof Date ? new Date(value) : new Date(raw.includes('T') ? raw : `${raw}T12:00:00`); return Number.isNaN(date.getTime()) ? null : date; }
function isoDate(date) { return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`; }
function validCalendarDate(year, month, day) { const date = new Date(year, month - 1, day, 12); return date.getFullYear() === year && date.getMonth() === month - 1 && date.getDate() === day; }
function koreanNumber(value) { const text = String(value || '').replace(/\s/g, ''); if (/^\d+$/.test(text)) return Number(text); if (text === '십') return 10; const ten = text.indexOf('십'); if (ten >= 0) { const tens = ten === 0 ? 1 : koreanDigits[text[0]]; const ones = koreanDigits[text.at(-1)]; return (tens || 0) * 10 + (text.length > ten + 1 ? (ones ?? 0) : 0); } return koreanDigits[text] ?? NaN; }
export function normalizeKoreanDateText(value) {
  return String(value || '').replace(/다음\s*주/g, '다음 주').replace(/다다음\s*주/g, '다다음 주').replace(/이번\s*주/g, '이번 주').replace(/(영|공|일|이|삼|사|오|육|칠|팔|구|십)+월\s*(영|공|일|이|삼|사|오|육|칠|팔|구|십)+일/g, (_, month, day) => `${koreanNumber(month)}월 ${koreanNumber(day)}일`);
}
function weekStart(reference) { const result = new Date(reference); const sundayOffset = (result.getDay() + 6) % 7; result.setDate(result.getDate() - sundayOffset); result.setHours(12, 0, 0, 0); return result; }
export function normalizeScheduleDate(expression, referenceDate) {
  const expressionText = normalizeKoreanDateText(expression).trim(); const reference = localDate(referenceDate); if (!expressionText || !reference) return { status: 'UNRESOLVED', expression: expressionText };
  const addDays = days => { const date = new Date(reference); date.setDate(date.getDate() + days); return { status: 'RESOLVED', date: isoDate(date), expression: expressionText }; };
  const explicit = expressionText.match(/\b(20\d{2})[-./](\d{1,2})[-./](\d{1,2})\b/) || expressionText.match(/(20\d{2})\s*년\s*(\d{1,2})\s*월\s*(\d{1,2})\s*일/);
  if (explicit) { const [, year, month, day] = explicit; return validCalendarDate(Number(year), Number(month), Number(day)) ? { status: 'RESOLVED', date: `${year}-${pad(month)}-${pad(day)}`, expression: explicit[0] } : { status: 'UNRESOLVED', expression: explicit[0] }; }
  const monthDay = expressionText.match(/(?:^|\s)(\d{1,2})\s*(?:월|[/.])\s*(\d{1,2})(?:\s*일)?/);
  if (monthDay) { const [, monthText, dayText] = monthDay; const month = Number(monthText), day = Number(dayText); let year = reference.getFullYear(); if (!validCalendarDate(year, month, day)) return { status: 'UNRESOLVED', expression: monthDay[0].trim() }; const candidate = new Date(year, month - 1, day, 12); if (candidate < reference) year += 1; return { status: 'RESOLVED', date: `${year}-${pad(month)}-${pad(day)}`, expression: monthDay[0].trim() }; }
  const weekMatch = expressionText.match(/(이번 주|다음 주|다다음 주)\s*(월요일|화요일|수요일|목요일|금요일|토요일|일요일)/);
  if (weekMatch) { const offsets = { '이번 주': 0, '다음 주': 1, '다다음 주': 2 }; const date = weekStart(reference); date.setDate(date.getDate() + offsets[weekMatch[1]] * 7 + weekdayOffsets[weekMatch[2]]); return { status: 'RESOLVED', date: isoDate(date), expression: weekMatch[0] }; }
  if (/오늘/.test(expressionText)) return addDays(0);
  if (/내일/.test(expressionText)) return addDays(1);
  if (/모레/.test(expressionText)) return addDays(2);
  const daysLater = expressionText.match(/(\d+)\s*일\s*뒤/); if (daysLater) return addDays(Number(daysLater[1]));
  if (/일주일\s*뒤/.test(expressionText)) return addDays(7);
  const weeksLater = expressionText.match(/(\d+)\s*주\s*뒤/); if (weeksLater) return addDays(Number(weeksLater[1]) * 7);
  if (/(이번 주|다음 주|다다음 주|월요일|화요일|수요일|목요일|금요일|토요일|일요일|이번 달 말|다음 달 초|다음 시간|조만간|\d+\s*일까지)/.test(expressionText)) return { status: 'AMBIGUOUS', expression: expressionText.match(/이번 주|다음 주|다다음 주|월요일|화요일|수요일|목요일|금요일|토요일|일요일|이번 달 말|다음 달 초|다음 시간|조만간|\d+\s*일까지/)?.[0] || expressionText };
  return { status: 'UNRESOLVED', expression: expressionText };
}
function scheduleType(text) { if (/휴강/.test(text)) return { type: 'cancellation', title: '휴강' }; if (/보강/.test(text)) return { type: 'makeup-class', title: '보강 수업' }; if (/중간고사/.test(text)) return { type: 'exam', title: '중간고사' }; if (/기말고사/.test(text)) return { type: 'exam', title: '기말고사' }; if (/시험|고사/.test(text)) return { type: 'exam', title: '시험' }; if (/퀴즈/.test(text)) return { type: 'quiz', title: '퀴즈' }; if (/과제|제출|마감/.test(text)) return { type: 'assignment', title: '과제 제출' }; if (/발표/.test(text)) return { type: 'presentation', title: '발표' }; if (/회의/.test(text)) return { type: 'meeting', title: '회의' }; if (/신청/.test(text)) return { type: 'application', title: '신청' }; if (/예약/.test(text)) return { type: 'reservation', title: '예약' }; return { type: 'academic', title: '학사 일정' }; }
function segmentSource(value, index) { return typeof value === 'string' ? { id: `legacy-${index}`, text: value, timestamp: null } : { id: String(value?.id || `segment-${index}`), text: String(value?.correctedKorean || value?.content || value?.text || ''), timestamp: Number.isFinite(Number(value?.startMs)) ? Number(value.startMs) : null }; }
function stableHash(value) { let hash = 2166136261; for (const char of String(value || '')) hash = Math.imul(hash ^ char.charCodeAt(0), 16777619); return (hash >>> 0).toString(36); }
export function scheduleCandidateIdentity({ lectureId, sourceSegmentId, eventType, title, date }) { return `schedule-${stableHash([lectureId, sourceSegmentId, eventType, String(title || '').replace(/\s/g, '').toLowerCase(), date].join('|'))}`; }
export function filterPendingScheduleCandidates(candidates = [], events = [], dismissedCandidateIds = []) {
  const confirmed = new Set(events.flatMap(item => [item?.sourceCandidateId, item?.candidateFingerprint]).filter(Boolean)); const confirmedOrigins = new Set(events.filter(item => !item?.sourceCandidateId && !item?.candidateFingerprint).map(item => item?.sourceLectureId && item?.sourceSegmentId ? `${item.sourceLectureId}|${item.sourceSegmentId}` : '').filter(Boolean)); const dismissed = new Set(dismissedCandidateIds);
  const seen = new Set(); return candidates.filter(candidate => { const identity = candidate.candidateFingerprint || candidate.id; const origin = candidate.sourceLectureId && candidate.sourceSegmentId ? `${candidate.sourceLectureId}|${candidate.sourceSegmentId}` : ''; if (!identity || confirmed.has(identity) || (origin && confirmedOrigins.has(origin)) || dismissed.has(identity) || seen.has(identity)) return false; seen.add(identity); return true; });
}
export function extractLocalScheduleCandidates(transcript = [], context = {}) {
  const reference = context.recordedAt || context.createdAt || new Date().toISOString(); const sources = transcript.map(segmentSource).map((source, index) => ({ ...source, index, text: normalizeKoreanDateText(source.text).trim() })).filter(source => source.text);
  const candidates = sources.flatMap(source => source.text.split(/(?<=[.!?。]|다\.|요\.|니다\.)\s*/).filter(Boolean).map(sentence => ({ ...source, text: sentence }))).filter(source => scheduleCue.test(source.text)).map((source, index) => {
    const resolution = normalizeScheduleDate(source.text, reference); if (resolution.status === 'UNRESOLVED') return null; const event = scheduleType(source.text); const candidateFingerprint = scheduleCandidateIdentity({ lectureId: context.id || context.lectureId || context.title || 'lecture', sourceSegmentId: source.id, eventType: event.type, title: event.title, date: resolution.date || resolution.expression }); return { id: candidateFingerprint, candidateFingerprint, title: event.title, date: resolution.date || '', time: '', description: source.text, eventType: event.type, relatedLecture: context.course || context.title || 'Recorded lecture', sourceLectureId: context.id || context.lectureId || null, status: 'PENDING', source: 'corrected-transcript', sourceText: source.text, sourceSegmentId: source.id, sourceTimestamp: source.timestamp, originalDateExpression: resolution.expression, resolutionStatus: resolution.status };
  }).filter(Boolean);
  const seen = new Set(); return candidates.filter(candidate => { const key = candidate.candidateFingerprint; if (seen.has(key)) return false; seen.add(key); return true; });
}
export class TranscriptScheduleExtractor extends ScheduleExtractor { async extract(transcript = [], context = {}) { return extractLocalScheduleCandidates(transcript, context); } }
export class GeminiScheduleExtractor extends ScheduleExtractor {
  constructor({ endpoint = '/api/schedule-extract' } = {}) { super(); this.endpoint = endpoint; }
  async extract(transcript = [], context = {}) { return extractLocalScheduleCandidates(transcript, context); }
}
export class MockScheduleExtractor extends ScheduleExtractor {
  async extract(transcript = []) {
    const text = transcript.join(' ');
    const hasAssignment = /assignment|submit|과제|제출/i.test(text);
    return [{ id: `candidate-${Date.now()}`, title: hasAssignment ? 'Assignment submission' : 'Review linked-list lecture', date: '2026-09-23', time: '23:59', description: hasAssignment ? 'Candidate extracted from the lecture transcript.' : 'Review the lecture concepts and examples.', relatedLecture: 'Data Structures · Linked Lists', status: 'candidate', source: text || 'Sample lecture transcript' }];
  }
}
export class NotificationService { async requestPermission() { throw new Error('Notification service is not configured.'); } }
export class BrowserNotificationService extends NotificationService {
  async requestPermission() { if (!('Notification' in window)) return 'unsupported'; return Notification.permission === 'default' ? Notification.requestPermission() : Notification.permission; }
}
export class BoardService { async listPosts() { throw new Error('Board service is not configured.'); } }
export class MockBoardService extends BoardService { constructor(posts = []) { super(); this.posts = posts; } async listPosts() { return this.posts; } }
export class ChatService { async send() { throw new Error('Chat service is not configured.'); } }
export class GeminiChatAdapter extends ChatService { async send() { throw new Error('Gemini Chat requires a secure server-side endpoint.'); } }
export class MockChatAdapter extends ChatService {
  async send(message, { student, schedules, events, language = 'en' }) {
    const text = message.toLowerCase(); const ko = language === 'ko';
    if (/record|lecture|녹음|강의/.test(text)) return ko ? 'Lecture에서 Start recording을 누르고 마이크 권한을 허용하세요. 종료하면 오디오와 Transcript가 현재 세션에 저장됩니다.' : 'Open Lecture, choose Start recording, and allow microphone access. Finishing saves the audio and transcript in this session.';
    if (/assignment|submit|deadline|과제|제출|일정/.test(text)) { const list = schedules.filter(item => item.status === 'confirmed').map(item => `${item.title} (${item.date} ${item.time})`).join(', '); return ko ? `확정된 일정: ${list || '현재 등록된 일정이 없습니다.'}` : `Confirmed schedule: ${list || 'There are no confirmed events yet.'}`; }
    if (/event|campus|행사|추천/.test(text)) { const recommendation = events[0]; if (!recommendation) return ko ? '현재 연결된 캠퍼스 행사 데이터가 없습니다.' : 'There is no connected campus-event data yet.'; return ko ? `${student.department} ${student.grade}학년 학생에게 ${recommendation.title}을 추천합니다. ${recommendation.description}` : `For a Year ${student.grade} ${student.department} student, I recommend ${recommendation.title}. ${recommendation.description}`; }
    return ko ? `${student.name}님, 강의 녹음 방법, 이번 주 일정, 또는 캠퍼스 행사 추천을 물어보세요.` : `${student.name}, ask me about recording lectures, your schedule, or campus events.`;
  }
}

export class PublicOpportunityService { async search() { throw new Error('Public opportunity service is not configured.'); } }
export class YouthPolicyAdapter extends PublicOpportunityService {
  constructor({ endpoint = '/api/opportunities' } = {}) { super(); this.endpoint = endpoint; }
  async search({ query = '' } = {}) {
    const url = new URL(this.endpoint, location.origin); if (query) url.searchParams.set('query', query);
    let response; try { response = await fetch(url); } catch (_) { throw Object.assign(new Error('Public-data network request failed.'), { code: 'network' }); }
    let body; try { body = await response.json(); } catch (_) { throw Object.assign(new Error('Public-data server returned an invalid response.'), { code: 'invalid-response' }); }
    if (!response.ok) throw Object.assign(new Error(body.message || 'Public-data request failed.'), { code: body.error || `http-${response.status}` });
    return body;
  }
}
export class ScholarshipAdapter extends PublicOpportunityService { async search() { throw Object.assign(new Error('No connected real-time scholarship source is configured.'), { code: 'source-not-configured' }); } }
export class VolunteerAdapter extends PublicOpportunityService { async search() { throw Object.assign(new Error('No connected real-time volunteer source is configured.'), { code: 'source-not-configured' }); } }
export class ContestAdapter extends PublicOpportunityService { async search() { throw Object.assign(new Error('No connected real-time contest source is configured.'), { code: 'source-not-configured' }); } }
export class EligibilityMatcher {
  match(opportunity, student) {
    const age = Number(student?.age); const range = opportunity?.ageRange || {}; const knownAge = Number.isFinite(age) && (range.min || range.max);
    if (knownAge && ((range.min && age < range.min) || (range.max && age > range.max))) return { status: 'NOT_MATCHED', reason: 'The published age range does not match the saved profile.' };
    const details = [opportunity?.eligibility, opportunity?.major, opportunity?.studentStatus].filter(Boolean);
    const eligibilityText = details.join(' ').toLowerCase();
    if (student?.employmentStatus === 'EMPLOYED' && /미취업|구직|실업/.test(eligibilityText)) return { status: 'NOT_MATCHED', reason: 'The published employment condition does not match the saved profile.' };
    if (student?.employmentStatus === 'UNEMPLOYED' && /재직자|취업자/.test(eligibilityText)) return { status: 'NOT_MATCHED', reason: 'The published employment condition does not match the saved profile.' };
    if (!details.length && !knownAge) return { status: 'UNKNOWN', reason: 'The source did not provide enough eligibility fields to verify this profile.' };
    return { status: 'UNKNOWN', reason: 'Confirm the official eligibility details before applying.' };
  }
}
