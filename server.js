const http = require('http');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { GoogleGenAI } = require('@google/genai');

// Optional local development variables. Production environments continue to use
// their own server environment; this never sends secrets to static files.
function loadLocalEnv() {
  const file = path.join(__dirname, '.env');
  try {
    fs.readFileSync(file, 'utf8').split(/\r?\n/).forEach(line => {
      const match = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
      if (!match || process.env[match[1]]) return;
      process.env[match[1]] = match[2].replace(/^['"]|['"]$/g, '');
    });
  } catch (_) {}
}
loadLocalEnv();

// Some local launch environments inject a placeholder proxy at 127.0.0.1:9.
// It is not a listening proxy and grpc-js honours it, preventing Google STT
// from establishing its HTTP/2 stream. Remove only that known-invalid value;
// legitimate user or organisation proxy settings remain untouched.
function removeInvalidLocalProxy() {
  for (const name of ['HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'http_proxy', 'https_proxy', 'all_proxy']) {
    if (/^https?:\/\/127\.0\.0\.1:9\/?$/i.test(process.env[name] || '')) delete process.env[name];
  }
}
removeInvalidLocalProxy();

const root = __dirname;
const contentTypes = { '.css': 'text/css', '.js': 'text/javascript', '.json': 'application/json', '.html': 'text/html' };
const sessionLimitMs = Number(process.env.STT_MAX_SESSION_MS || 270000);
const geminiModel = process.env.GEMINI_MODEL || 'gemini-2.5-flash';
const geminiLocation = process.env.GOOGLE_CLOUD_LOCATION || 'global';
let geminiClient;

function sendJson(res, status, payload) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(payload));
}
function readAdcQuotaProject() {
  const candidates = [
    process.env.APPDATA && path.join(process.env.APPDATA, 'gcloud', 'application_default_credentials.json'),
    path.join(os.homedir(), 'AppData', 'Roaming', 'gcloud', 'application_default_credentials.json')
  ].filter(Boolean);
  for (const file of candidates) {
    try { const value = JSON.parse(fs.readFileSync(file, 'utf8')); if (value.quota_project_id) return value.quota_project_id; } catch (_) {}
  }
  return null;
}
function resolveGoogleProject() {
  const project = process.env.GOOGLE_CLOUD_PROJECT || readAdcQuotaProject();
  if (!project) throw Object.assign(new Error('Google Cloud project is not configured for Gemini translation.'), { code: 'project-not-configured' });
  // Avoid an SDK attempt to spawn gcloud just to rediscover the project. Credentials
  // are still resolved through ADC on the server and never reach the browser.
  process.env.GOOGLE_CLOUD_PROJECT = project;
  return project;
}
function getGeminiClient() {
  const project = resolveGoogleProject();
  if (!geminiClient) geminiClient = new GoogleGenAI({ vertexai: true, project, location: geminiLocation, apiVersion: 'v1' });
  return geminiClient;
}
function translationFailure(error) {
  const detail = String(error?.message || 'Unknown Gemini translation failure.');
  if (/SERVICE_DISABLED|has not been used/i.test(detail)) return { status: 503, code: 'vertex-api-disabled', message: 'Vertex AI API is not enabled for this project.' };
  if (/RESOURCE_EXHAUSTED|quota|rate limit/i.test(detail)) return { status: 429, code: 'quota-or-rate-limit', message: 'Gemini translation quota is temporarily unavailable.' };
  if (/UNAUTHENTICATED|PERMISSION_DENIED|authentication/i.test(detail)) return { status: 401, code: 'authentication-or-permission', message: 'Gemini server authentication or permission failed.' };
  if (/deadline|timeout/i.test(detail)) return { status: 504, code: 'timeout', message: 'Gemini translation timed out.' };
  return { status: 502, code: 'gemini-request-failed', message: 'Gemini translation request failed.' };
}
async function translateWithGemini({ text, targetLanguage, glossary, previousSegments, course }) {
  if (typeof text !== 'string' || !text.trim()) throw Object.assign(new Error('A final transcript is required.'), { code: 'invalid-input' });
  const target = targetLanguage === 'ko' ? 'Korean' : 'English';
  const relevantGlossary = Array.isArray(glossary) ? glossary.slice(0, 6).map(item => ({ term: String(item.term || '').slice(0, 80), meaning: String(item.meaning || '').slice(0, 180) })).filter(item => item.term) : [];
  const recentContext = Array.isArray(previousSegments) ? previousSegments.slice(-2).map(segment => String(segment || '').trim().slice(0, 240)).filter(Boolean) : [];
  const safeCourse = String(course || '').trim().slice(0, 120);
  const prompt = [
    'You are a real-time lecture translator for an international student.',
    'Correct only clear Korean STT mistakes, especially a glossary term that is phonetically similar and unambiguously supported by the course context. Preserve all correct wording, sentence form, and lecture meaning. When uncertain, retain the raw Korean; do not rewrite, add explanations, facts, or examples.',
    `Target language: ${target}.`,
    `Korean STT final: ${text.trim()}`,
    `Current course: ${safeCourse}`,
    `Relevant glossary: ${JSON.stringify(relevantGlossary)}`,
    `Previous stable segments (context only, do not repeat): ${JSON.stringify(recentContext)}`,
    'Return only the requested JSON fields. correctedKorean must be Korean. translatedText must be the natural target-language subtitle.'
  ].join('\n');
  const response = await getGeminiClient().models.generateContent({
    model: geminiModel,
    contents: prompt,
    config: {
      temperature: 0,
      // Translation is a short deterministic transformation. Gemini 2.5 Flash
      // supports disabling thinking here, which avoids unnecessary latency and
      // thought-token cost without changing the selected model or output schema.
      thinkingConfig: { thinkingBudget: 0 },
      maxOutputTokens: 256,
      responseMimeType: 'application/json',
      responseJsonSchema: {
        type: 'object',
        properties: { correctedKorean: { type: 'string' }, translatedText: { type: 'string' } },
        required: ['correctedKorean', 'translatedText']
      }
    }
  });
  let value;
  try { value = JSON.parse(response.text); } catch (_) { throw Object.assign(new Error('Gemini returned invalid JSON.'), { code: 'invalid-response' }); }
  if (typeof value.correctedKorean !== 'string' || typeof value.translatedText !== 'string' || !value.correctedKorean.trim() || !value.translatedText.trim()) throw Object.assign(new Error('Gemini response did not include translation fields.'), { code: 'invalid-response' });
  return { correctedKorean: value.correctedKorean.trim(), translatedText: value.translatedText.trim(), model: geminiModel };
}
async function translateSegmentsWithGemini({ segments, targetLanguage, glossary, previousSegments, course }) {
  const source = Array.isArray(segments) ? segments.map(segment => ({ id: String(segment?.id || '').trim(), text: String(segment?.text || '').trim() })).filter(segment => segment.id && segment.text).slice(0, 12) : [];
  if (!source.length) throw Object.assign(new Error('Final transcript segments are required.'), { code: 'invalid-input' });
  if (source.length === 1) { const result = await translateWithGemini({ text: source[0].text, targetLanguage, glossary, previousSegments, course }); return { segments: [{ id: source[0].id, ...result }], model: result.model }; }
  const target = targetLanguage === 'ko' ? 'Korean' : 'English';
  const relevantGlossary = Array.isArray(glossary) ? glossary.slice(0, 6).map(item => ({ term: String(item.term || '').slice(0, 80), meaning: String(item.meaning || '').slice(0, 180) })).filter(item => item.term) : [];
  const recentContext = Array.isArray(previousSegments) ? previousSegments.slice(-2).map(segment => String(segment || '').trim().slice(0, 240)).filter(Boolean) : [];
  const prompt = [
    'You are a real-time lecture translator for an international student.',
    'For every supplied Korean STT segment, correct only clear Korean STT mistakes. Preserve the input order and IDs. Do not merge, omit, split, or add segments. When uncertain, retain raw Korean.',
    `Target language: ${target}.`,
    `Korean STT segments: ${JSON.stringify(source)}`,
    `Current course: ${String(course || '').trim().slice(0, 120)}`,
    `Relevant glossary: ${JSON.stringify(relevantGlossary)}`,
    `Previous stable segments (context only, do not repeat): ${JSON.stringify(recentContext)}`,
    'Return only JSON with a segments array. Each item must have id, correctedKorean, and translatedText.'
  ].join('\n');
  const response = await getGeminiClient().models.generateContent({ model: geminiModel, contents: prompt, config: { temperature: 0, thinkingConfig: { thinkingBudget: 0 }, maxOutputTokens: 1024, responseMimeType: 'application/json', responseJsonSchema: { type: 'object', properties: { segments: { type: 'array', items: { type: 'object', properties: { id: { type: 'string' }, correctedKorean: { type: 'string' }, translatedText: { type: 'string' } }, required: ['id', 'correctedKorean', 'translatedText'] } } }, required: ['segments'] } } });
  let value;
  try { value = JSON.parse(response.text); } catch (_) { throw Object.assign(new Error('Gemini returned invalid JSON.'), { code: 'invalid-response' }); }
  const byId = new Map(Array.isArray(value?.segments) ? value.segments.map(item => [String(item?.id || ''), item]) : []);
  const translated = source.map(segment => ({ id: segment.id, correctedKorean: String(byId.get(segment.id)?.correctedKorean || '').trim(), translatedText: String(byId.get(segment.id)?.translatedText || '').trim() }));
  if (translated.some(item => !item.correctedKorean || !item.translatedText)) throw Object.assign(new Error('Gemini translation batch response is incomplete.'), { code: 'invalid-response' });
  return { segments: translated, model: geminiModel };
}
function isContentLanguage(value, language) {
  const text = String(value || '').trim();
  if (!text) return false;
  return language === 'ko' ? /[가-힣]/.test(text) : !/[가-힣]/.test(text);
}
function validateSmartNote(value, language) {
  if (!value || !isContentLanguage(value.title, language) || !isContentLanguage(value.summary, language)) throw Object.assign(new Error('Gemini Smart Note title or summary did not match the selected language.'), { code: 'invalid-smart-note' });
  if (!Array.isArray(value.keywords) || !value.keywords.length || value.keywords.some(item => !item || !isContentLanguage(item.term, language) || !isContentLanguage(item.definition, language) || !isContentLanguage(item.lectureContext, language) || !isContentLanguage(item.studyTip, language))) throw Object.assign(new Error('Gemini Smart Note keyword details were incomplete.'), { code: 'invalid-smart-note' });
  if (!Array.isArray(value.studyTips) || !value.studyTips.length || value.studyTips.some(tip => !isContentLanguage(tip, language))) throw Object.assign(new Error('Gemini Smart Note study tips were incomplete.'), { code: 'invalid-smart-note' });
  if (!Array.isArray(value.quizzes) || value.quizzes.length < 2) throw Object.assign(new Error('Gemini Smart Note quizzes were incomplete.'), { code: 'invalid-smart-note' });
  for (const quiz of value.quizzes) {
    const options = Array.isArray(quiz.options) ? quiz.options.map(option => String(option || '').trim()).filter(Boolean) : [];
    const validLanguage = (quiz.type === 'OX' ? [quiz.question, quiz.explanation] : [quiz.question, quiz.explanation, ...options]).every(item => isContentLanguage(item, language));
    const validOptions = quiz.type === 'OX' ? options.length === 2 : options.length === 4;
    if (!validLanguage || !validOptions || new Set(options).size !== options.length || !options.includes(String(quiz.answer || '').trim())) throw Object.assign(new Error('Gemini Smart Note quiz validation failed.'), { code: 'invalid-smart-note' });
  }
}
async function generateSmartNoteWithGemini({ lecture, transcript, student, language, glossary }) {
  const lines = Array.isArray(transcript) ? transcript.map(line => String(line || '').trim()).filter(Boolean) : [];
  if (!lines.length) throw Object.assign(new Error('A final transcript is required.'), { code: 'invalid-input' });
  const outputLanguage = language === 'ko' ? 'Korean' : 'English';
  const safeLecture = { title: String(lecture?.title || '').slice(0, 160), course: String(lecture?.course || '').slice(0, 120) };
  const safeStudent = { department: String(student?.department || '').slice(0, 120), grade: String(student?.grade || '').slice(0, 16) };
  const safeGlossary = Array.isArray(glossary) ? glossary.slice(0, 12).map(item => ({ term: String(item.term || '').slice(0, 80), meaning: String(item.meaning || '').slice(0, 220) })).filter(item => item.term) : [];
  const prompt = [
    'You create a structured, transcript-grounded Smart Note for an international student.',
    `Write every generated field in ${outputLanguage}. Do not mix languages inside a quiz.`,
    'Use only the lecture transcript for claims. Do not invent examples, topics, or definitions unrelated to the transcript.',
    'Provide a concise descriptive title for the Smart Note in the selected language. For each keyword, give a concise core definition and separately explain its exact lecture context. Each study tip must name or directly use a concept from this transcript and must differ in learning activity.',
    'Create exactly two quizzes: one OX and one MC. OX has options O and X. MC has exactly four unique options in the same language; exactly one is the answer. Explanations must cite the lecture concept, not generic study advice.',
    `Lecture context: ${JSON.stringify(safeLecture)}`,
    `Student context: ${JSON.stringify(safeStudent)}`,
    `Glossary (use only when relevant): ${JSON.stringify(safeGlossary)}`,
    `Final transcript: ${JSON.stringify(lines.slice(0, 80))}`
  ].join('\n');
  const response = await getGeminiClient().models.generateContent({
    model: geminiModel,
    contents: prompt,
    config: {
      temperature: 0.2,
      responseMimeType: 'application/json',
      responseJsonSchema: {
        type: 'object',
        properties: {
          title: { type: 'string' }, summary: { type: 'string' }, keyPoints: { type: 'array', items: { type: 'string' } }, keySentences: { type: 'array', items: { type: 'string' } }, studyTips: { type: 'array', items: { type: 'string' } },
          keywords: { type: 'array', items: { type: 'object', properties: { term: { type: 'string' }, definition: { type: 'string' }, lectureContext: { type: 'string' }, majorExplanation: { type: 'string' }, studyTip: { type: 'string' } }, required: ['term', 'definition', 'lectureContext', 'majorExplanation', 'studyTip'] } },
          quizzes: { type: 'array', items: { type: 'object', properties: { type: { type: 'string' }, question: { type: 'string' }, options: { type: 'array', items: { type: 'string' } }, answer: { type: 'string' }, explanation: { type: 'string' } }, required: ['type', 'question', 'options', 'answer', 'explanation'] } }
        }, required: ['title', 'summary', 'keyPoints', 'keySentences', 'keywords', 'studyTips', 'quizzes']
      }
    }
  });
  let value;
  try { value = JSON.parse(response.text); } catch (_) { throw Object.assign(new Error('Gemini returned invalid Smart Note JSON.'), { code: 'invalid-smart-note' }); }
  validateSmartNote(value, language);
  const keywordDetails = Object.fromEntries(value.keywords.map(item => [item.term.trim(), { meaning: item.definition.trim(), context: item.lectureContext.trim(), major: item.majorExplanation.trim(), studyTip: item.studyTip.trim() }]));
  return { title: value.title.trim(), summary: value.summary.trim(), keyPoints: value.keyPoints.map(item => String(item).trim()).filter(Boolean).slice(0, 5), keySentences: value.keySentences.map(item => String(item).trim()).filter(Boolean).slice(0, 4), keywords: value.keywords.map(item => item.term.trim()), keywordDetails, studyTips: value.studyTips.map(item => String(item).trim()).filter(Boolean).slice(0, 3), quizzes: value.quizzes.map((item, index) => ({ id: `quiz-${Date.now()}-${index}`, type: item.type === 'OX' ? 'OX' : 'MC', question: item.question.trim(), options: item.options.map(option => option.trim()), answer: item.answer.trim(), explanation: item.explanation.trim() })), model: geminiModel, generationVersion: 2 };
}
async function extractSchedulesWithGemini({ transcript, lecture, currentDate }) {
  const lines = Array.isArray(transcript) ? transcript.map(line => String(line || '').trim()).filter(Boolean) : [];
  if (!lines.length) throw Object.assign(new Error('A final transcript is required.'), { code: 'invalid-input' });
  const localToday = () => { const now = new Date(); const offset = now.getTimezoneOffset() * 60000; return new Date(now.getTime() - offset).toISOString().slice(0, 10); };
  const today = /^\d{4}-\d{2}-\d{2}$/.test(String(currentDate || '')) ? currentDate : localToday();
  const source = lines.join(' ');
  const koreanDate = source.match(/(?:(20\d{2})\s*년\s*)?(\d{1,2})\s*월\s*(\d{1,2})\s*일/);
  const explicitDate = source.match(/\b(20\d{2})-(\d{2})-(\d{2})\b/);
  const validDate = (year, month, day) => { const value = new Date(year, month - 1, day); return value.getFullYear() === year && value.getMonth() === month - 1 && value.getDate() === day; };
  let transcriptDate = null;
  if (explicitDate && validDate(Number(explicitDate[1]), Number(explicitDate[2]), Number(explicitDate[3]))) transcriptDate = explicitDate[0];
  else if (koreanDate) {
    const [, statedYear, monthText, dayText] = koreanDate; const month = Number(monthText); const day = Number(dayText); const current = new Date(`${today}T12:00:00`); let year = statedYear ? Number(statedYear) : current.getFullYear();
    // A yearless date stays in the current academic year unless it is substantially
    // before today; only then is the next academic year the safer candidate.
    if (!statedYear) { const candidate = new Date(year, month - 1, day, 12); const daysBehind = Math.round((current - candidate) / 86400000); if (daysBehind > 120) year += 1; }
    if (validDate(year, month, day)) transcriptDate = `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
  }
  const prompt = [
    'Extract only explicitly stated academic schedule candidates from this lecture transcript.',
    'Never invent an event, date, time, or deadline. The user will review every candidate before it is saved.',
    `Current local date is ${today}. For a Korean month/day without a year, use the current academic year unless the date is more than 120 days before today; only then use the next year. A year stated in the transcript is authoritative.`,
    'Return date as YYYY-MM-DD. Leave time as an empty string when the transcript does not state a time.',
    'Use the transcript language for title and description. Include exams, assignments, presentations, and submission deadlines only when a date is explicit or safely resolvable.',
    `Lecture context: ${JSON.stringify({ title: String(lecture?.title || ''), course: String(lecture?.course || '') })}`,
    `Transcript: ${JSON.stringify(lines.slice(0, 100))}`
  ].join('\n');
  const response = await getGeminiClient().models.generateContent({
    model: geminiModel,
    contents: prompt,
    config: { temperature: 0, responseMimeType: 'application/json', responseJsonSchema: { type: 'object', properties: { candidates: { type: 'array', items: { type: 'object', properties: { title: { type: 'string' }, date: { type: 'string' }, time: { type: 'string' }, description: { type: 'string' }, eventType: { type: 'string' } }, required: ['title', 'date', 'time', 'description', 'eventType'] } } }, required: ['candidates'] } }
  });
  let value;
  try { value = JSON.parse(response.text); } catch (_) { throw Object.assign(new Error('Gemini returned invalid schedule JSON.'), { code: 'invalid-schedule' }); }
  if (!Array.isArray(value.candidates)) throw Object.assign(new Error('Gemini schedule response was incomplete.'), { code: 'invalid-schedule' });
  return value.candidates.filter(item => item && /^\d{4}-\d{2}-\d{2}$/.test(String(item.date || '')) && String(item.title || '').trim() && String(item.description || '').trim()).slice(0, 8).map((item, index) => ({ id: `candidate-${Date.now()}-${index}`, title: String(item.title).trim(), date: transcriptDate || String(item.date), rawDate: String(item.date), resolvedFromTranscript: Boolean(transcriptDate), time: /^\d{2}:\d{2}$/.test(String(item.time || '')) ? String(item.time) : '', description: String(item.description).trim(), eventType: String(item.eventType || 'academic').trim() }));
}
function readJsonBody(req, limit = 65536) {
  return new Promise((resolve, reject) => {
    let size = 0; const chunks = [];
    req.on('data', chunk => { size += chunk.length; if (size > limit) { reject(Object.assign(new Error('Request body is too large.'), { code: 'payload-too-large' })); req.destroy(); return; } chunks.push(chunk); });
    req.on('end', () => { try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}')); } catch (_) { reject(Object.assign(new Error('Invalid JSON request.'), { code: 'invalid-request' })); } });
    req.on('error', reject);
  });
}

function sendFrame(socket, payload) {
  const data = Buffer.from(typeof payload === 'string' ? payload : JSON.stringify(payload));
  const header = data.length < 126 ? Buffer.from([0x81, data.length]) : Buffer.from([0x81, 126, data.length >> 8, data.length & 255]);
  socket.write(Buffer.concat([header, data]));
}
function parseFrames(buffer, onFrame) {
  let offset = 0;
  while (offset + 2 <= buffer.length) {
    const byte1 = buffer[offset]; const byte2 = buffer[offset + 1]; let length = byte2 & 127; const masked = Boolean(byte2 & 128); let cursor = offset + 2;
    if (length === 126) { if (cursor + 2 > buffer.length) break; length = buffer.readUInt16BE(cursor); cursor += 2; }
    if (length === 127 || cursor + (masked ? 4 : 0) + length > buffer.length) break;
    const mask = masked ? buffer.subarray(cursor, cursor + 4) : null; cursor += masked ? 4 : 0; const payload = Buffer.from(buffer.subarray(cursor, cursor + length));
    if (mask) for (let index = 0; index < payload.length; index += 1) payload[index] ^= mask[index % 4];
    onFrame(byte1 & 15, payload); offset = cursor + length;
  }
  return buffer.subarray(offset);
}
function createGoogleStream(metadata, send, onFatal) {
  let SpeechClient;
  try { ({ SpeechClient } = require('@google-cloud/speech')); } catch (_) { throw new Error('Google STT server dependency is missing. Run npm install on the server.'); }
  // SpeechClient resolves Application Default Credentials itself. This supports
  // GOOGLE_APPLICATION_CREDENTIALS, local ADC, and an attached service account
  // without ever sending credential material to the browser.
  const client = new SpeechClient(process.env.GOOGLE_CLOUD_PROJECT ? { projectId: process.env.GOOGLE_CLOUD_PROJECT } : undefined);
  const sampleRateHertz = [8000, 12000, 16000, 24000, 48000].includes(Number(metadata.sampleRateHertz)) ? Number(metadata.sampleRateHertz) : 48000;
  const phraseHints = Array.isArray(metadata.phraseHints) ? [...new Set(metadata.phraseHints.map(value => String(value || '').trim().slice(0, 80)).filter(Boolean))].slice(0, 20) : [];
  const config = { encoding: 'WEBM_OPUS', sampleRateHertz, languageCode: metadata.languageCode || 'ko-KR', audioChannelCount: 1, enableAutomaticPunctuation: true, enableWordTimeOffsets: true, model: 'latest_long' };
  if (phraseHints.length) config.speechContexts = [{ phrases: phraseHints, boost: 8 }];
  const stream = client.streamingRecognize({ config, interimResults: true });
  // V1 returns resultEndTime; V2 uses resultEndOffset. Forward either value as
  // milliseconds so the browser can anchor captions to audio, rather than to
  // the later instant at which this WebSocket message happened to arrive.
  const durationMs = value => {
    if (!value) return null;
    const seconds = Number(value.seconds ?? 0);
    const nanos = Number(value.nanos ?? 0);
    const milliseconds = seconds * 1000 + nanos / 1000000;
    return Number.isFinite(milliseconds) && milliseconds >= 0 ? Math.round(milliseconds) : null;
  };
  stream.on('data', response => (response.results || []).forEach(result => {
    const alternative = result.alternatives?.[0];
    const transcript = alternative?.transcript?.trim();
    if (!transcript) return;
    const wordTimings = (alternative?.words || []).map(word => ({ word: String(word.word || ''), startMs: durationMs(word.startTime), endMs: durationMs(word.endTime) })).filter(word => word.word && word.startMs !== null && word.endMs !== null);
    send({
      type: result.isFinal ? 'final' : 'interim',
      transcript,
      confidence: alternative?.confidence ?? null,
      resultEndMs: durationMs(result.resultEndTime || result.resultEndOffset),
      wordTimings: result.isFinal ? wordTimings : []
    });
  }));
  stream.on('error', error => { send({ type: 'error', code: error.code || 'google-stream-error', message: error.message }); onFatal?.(); });
  return stream;
}
// Current HTTPS endpoint supplied by the OnTong Youth API provider. Keep the
// credential server-side and refuse every downgrade redirect.
const youthPolicyEndpoint = 'https://www.youthcenter.go.kr/go/ythip/getPlcy';
const youthPolicyCache = new Map();
const youthPolicyCacheMs = 5 * 60 * 1000;
function xmlText(block, names) {
  for (const name of names) {
    const match = block.match(new RegExp(`<${name}>([\\s\\S]*?)</${name}>`, 'i'));
    if (match) return match[1].replace(/<!\\[CDATA\\[|\\]\\]>/g, '').replace(/&amp;/g, '&').trim() || null;
  }
  return null;
}
function normalizeYouthPolicies(payload) {
  const records = Array.isArray(payload?.result?.youthPolicyList) ? payload.result.youthPolicyList : [];
  return records.map((record, index) => {
    const sourceId = record.plcyNo || `ontong-youth-${index}`;
    return {
      id: `ontong-youth:${sourceId}`, source: 'ontong-youth', sourceId, type: 'youth-policy',
      title: record.plcyNm || null, organization: record.operInstCdNm || record.sprvsnInstCdNm || null,
      description: record.plcyExplnCn || record.plcySprtCn || null,
      eligibility: record.addAplyQlfcCndCn || record.ptcpPrpTrgtCn || null,
      region: record.zipCd || null, major: record.plcyMajorCd || null, studentStatus: record.schoolCd || null,
      ageRange: { min: Number(record.sprtTrgtMinAge) || null, max: Number(record.sprtTrgtMaxAge) || null },
      applicationStart: record.aplyYmd || null, applicationDeadline: null,
      activityPeriod: [record.bizPrdBgngYmd, record.bizPrdEndYmd].filter(Boolean).join(' ~ ') || null,
      officialUrl: record.aplyUrlAddr || record.refUrlAddr1 || null,
      retrievedAt: new Date().toISOString()
    };
  }).filter(item => item.title);
}
function opportunityFailure(error) {
  const detail = String([error?.message, error?.cause?.message, error?.cause?.code].filter(Boolean).join(' ') || 'Unknown public API failure.');
  if (/SSL|TLS|certificate|SEC_E_/i.test(detail)) return { status: 502, code: 'upstream-tls-failure', message: 'The public-data service could not establish a secure TLS connection from this server.' };
  if (/timeout|UND_ERR_CONNECT_TIMEOUT|ETIMEDOUT/i.test(detail)) return { status: 504, code: 'upstream-connect-timeout', message: 'The public-data service did not respond before the server connection timed out.' };
  const httpStatus = detail.match(/HTTP\s+(\d{3})/i);
  if (httpStatus) return { status: Number(httpStatus[1]), code: `upstream-http-${httpStatus[1]}`, message: `The public-data service returned HTTP ${httpStatus[1]}.` };
  if (/401|403|unauthori[sz]ed|forbidden/i.test(detail)) return { status: 502, code: 'upstream-auth-failure', message: 'The public-data service rejected the server credential.' };
  return { status: 502, code: 'public-api-request-failed', message: 'The public-data service request failed.' };
}
async function listYouthPolicies() {
  const apiKey = process.env.YOUTH_POLICY_API_KEY;
  if (!apiKey) throw Object.assign(new Error('The server has no OnTong Youth API key.'), { code: 'api-key-missing' });
  // This documented endpoint does not expose a verified profile/keyword filter.
  // Keep one shared catalogue cache instead of fetching the same first page for
  // each chat wording; profile and intent filtering happen after normalization.
  const cacheKey = 'catalog-v2'; const cached = youthPolicyCache.get(cacheKey);
  if (cached && Date.now() - cached.createdAt < youthPolicyCacheMs) return { ...cached.value, cache: 'hit' };
  const url = new URL(youthPolicyEndpoint); url.searchParams.set('apiKeyNm', apiKey); url.searchParams.set('pageNum', '1'); url.searchParams.set('pageSize', '50'); url.searchParams.set('rtnType', 'json');
  let response;
  try { response = await fetch(url, { headers: { Accept: 'application/xml' }, redirect: 'manual', signal: AbortSignal.timeout(12000) }); }
  catch (error) { throw Object.assign(error, { code: error.code || 'network' }); }
  if (response.status >= 300 && response.status < 400) {
    const location = response.headers.get('location');
    const destination = location ? new URL(location, url) : null;
    if (!destination || destination.protocol !== 'https:') throw Object.assign(new Error('The public API redirected the credential-bearing request to an insecure endpoint.'), { code: 'insecure-redirect' });
    throw Object.assign(new Error('The public API redirected to an unsupported endpoint.'), { code: 'unexpected-redirect' });
  }
  if (!response.ok) throw Object.assign(new Error(`Youth policy API returned HTTP ${response.status}.`), { code: `http-${response.status}` });
  const contentType = response.headers.get('content-type') || ''; if (!/application\/json/i.test(contentType)) throw Object.assign(new Error('Youth policy API did not return JSON.'), { code: 'unexpected-response-type' });
  const payload = await response.json(); if (payload?.resultCode !== 200) throw Object.assign(new Error(`Youth policy API result code ${payload?.resultCode ?? 'unknown'}.`), { code: 'provider-result-error' });
  const opportunities = normalizeYouthPolicies(payload);
  const value = { opportunities, retrievedAt: new Date().toISOString(), cache: 'miss' }; youthPolicyCache.set(cacheKey, { createdAt: Date.now(), value }); return value;
}
const server = http.createServer((req, res) => {
  if (req.method === 'POST' && req.url.split('?')[0] === '/api/translate') {
    readJsonBody(req).then(body => Array.isArray(body.segments) ? translateSegmentsWithGemini(body) : translateWithGemini(body)).then(result => sendJson(res, 200, result)).catch(error => {
      const failure = error.code === 'invalid-input' || error.code === 'invalid-request' ? { status: 400, code: error.code, message: error.message } : translationFailure(error);
      sendJson(res, failure.status, { error: failure.code, message: failure.message });
    });
    return;
  }
  if (req.method === 'POST' && req.url.split('?')[0] === '/api/smart-note') {
    readJsonBody(req, 262144).then(body => generateSmartNoteWithGemini(body)).then(result => sendJson(res, 200, result)).catch(error => {
      const failure = error.code === 'invalid-input' || error.code === 'invalid-request' || error.code === 'invalid-smart-note' ? { status: 400, code: error.code, message: error.message } : translationFailure(error);
      sendJson(res, failure.status, { error: failure.code, message: failure.message });
    });
    return;
  }
  if (req.method === 'POST' && req.url.split('?')[0] === '/api/schedule-extract') {
    readJsonBody(req, 262144).then(body => extractSchedulesWithGemini(body)).then(result => sendJson(res, 200, { candidates: result })).catch(error => {
      const failure = error.code === 'invalid-input' || error.code === 'invalid-request' || error.code === 'invalid-schedule' ? { status: 400, code: error.code, message: error.message } : translationFailure(error);
      sendJson(res, failure.status, { error: failure.code, message: failure.message });
    });
    return;
  }
  if (req.method === 'GET' && req.url.split('?')[0] === '/api/opportunities') {
    listYouthPolicies().then(result => sendJson(res, 200, { source: 'ontong-youth', ...result })).catch(error => {
      const failure = error.code === 'api-key-missing' ? { status: 503, code: error.code, message: 'The public-data server key is not configured.' } : error.code === 'insecure-redirect' ? { status: 502, code: error.code, message: 'The public API redirected this credential-bearing request to an insecure endpoint.' } : opportunityFailure(error);
      sendJson(res, failure.status, { error: failure.code, message: failure.message });
    });
    return;
  }
  const requestPath = decodeURIComponent(req.url.split('?')[0]); const candidate = path.resolve(root, `.${requestPath}`); const isSafe = candidate.startsWith(root);
  const file = isSafe && fs.existsSync(candidate) && fs.statSync(candidate).isFile() ? candidate : path.join(root, 'index.html');
  res.writeHead(200, { 'Content-Type': `${contentTypes[path.extname(file)] || 'text/plain'}; charset=utf-8` }); fs.createReadStream(file).pipe(res);
});
server.on('upgrade', (request, socket) => {
  if (request.url.split('?')[0] !== '/api/stt') { socket.destroy(); return; }
  const key = request.headers['sec-websocket-key']; if (!key) { socket.destroy(); return; }
  const accept = crypto.createHash('sha1').update(`${key}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`).digest('base64');
  socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`);
  let pending = Buffer.alloc(0); let stream; let started = false; let sessionTimer; let streamFailed = false;
  const closeStream = () => { clearTimeout(sessionTimer); try { stream?.end(); } catch (_) {} stream = null; };
  socket.on('data', chunk => { pending = parseFrames(Buffer.concat([pending, chunk]), (opcode, payload) => {
    if (opcode === 8) { closeStream(); socket.end(); return; }
    if (opcode === 1) { try { const message = JSON.parse(payload.toString()); if (message.type === 'start' && !started) { started = true; stream = createGoogleStream(message, value => sendFrame(socket, value), () => { streamFailed = true; }); sendFrame(socket, { type: 'ready', engine: 'google', encoding: 'WEBM_OPUS', sampleRateHertz: message.sampleRateHertz }); sessionTimer = setTimeout(() => { sendFrame(socket, { type: 'session_limit' }); closeStream(); socket.end(); }, sessionLimitMs); } if (message.type === 'stop') { closeStream(); setTimeout(() => socket.end(), 800); } } catch (error) { sendFrame(socket, { type: 'error', code: 'proxy-start-error', message: error.message }); } return; }
    if (opcode === 2 && stream && !streamFailed && !stream.destroyed && stream.writable) { try { stream.write(payload); } catch (error) { streamFailed = true; sendFrame(socket, { type: 'error', code: error.code || 'google-stream-write-failed', message: error.message }); } }
  }); });
  socket.on('error', closeStream); socket.on('close', closeStream);
});
const port = Number(process.env.PORT || 4173);
server.listen(port, () => console.log(`Study Mate is running at http://localhost:${port}`));
