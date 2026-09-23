import { student, boardPosts } from './data/student.js';
import { icon } from './components/icons.js';
import { BrowserRecordingService, GoogleSpeechToTextAdapter, BrowserSpeechRecognitionAdapter, MockSpeechToTextAdapter, GeminiTranslationAdapter, MockTranslationAdapter, MockGlossaryAdapter, TranscriptSegmenter, GeminiSmartNoteGenerator, TranscriptNoteGenerator, TranscriptQuizGenerator, GeminiScheduleExtractor, TranscriptScheduleExtractor, filterPendingScheduleCandidates, BrowserNotificationService, MockStudentAdapter, LocalCourseAdapter, IndexedDbAudioStorage, MockChatAdapter, YouthPolicyAdapter, EligibilityMatcher } from './services/index.js';

const routes = [
  ['/', 'Home', 'home'], ['/lecture', 'Lecture', 'mic'], ['/notes', 'Notes', 'file-text'],
  ['/schedule', 'Schedule', 'calendar'], ['/board', 'Board', 'message-square'], ['/chat', 'AI Chatbot', 'sparkles'], ['/profile', 'My Page', 'user']
];
const app = document.querySelector('#app');
try { Object.assign(student, JSON.parse(localStorage.getItem('studyMateStudentProfile') || '{}')); } catch (_) {}
const initials = student.name.split(' ').map(x => x[0]).join('').slice(0, 2);
const icons = { lecture: 'mic', notes: 'file-text', schedule: 'calendar', board: 'message-square', chat: 'sparkles' };
const isDevelopment = location.hostname === 'localhost' || location.hostname === '127.0.0.1';
const recordingService = new BrowserRecordingService();
const audioStorage = new IndexedDbAudioStorage();
const segmenter = new TranscriptSegmenter();
const useLocalNoteGenerator = isDevelopment && new URLSearchParams(location.search).get('note') === 'local';
const noteGenerator = useLocalNoteGenerator ? new TranscriptNoteGenerator() : new GeminiSmartNoteGenerator();
const quizGenerator = new TranscriptQuizGenerator();
const useLocalScheduleExtractor = isDevelopment && new URLSearchParams(location.search).get('schedule') === 'local';
const scheduleExtractor = useLocalScheduleExtractor ? new TranscriptScheduleExtractor() : new GeminiScheduleExtractor();
const notificationService = new BrowserNotificationService();
const studentService = new MockStudentAdapter(student);
let lectureSession = null;
const demoMode = isDevelopment && new URLSearchParams(location.search).get('demo') === '1';
const defaultCourses = (student.courses || []).map((name, index) => ({ id: `course-${index + 1}`, name, professor: '', dayOfWeek: '', startTime: '', endTime: '' }));
const courseService = new LocalCourseAdapter(defaultCourses);
let courses = await courseService.list();
if (!Array.isArray(courses) || !courses.length) courses = defaultCourses;
const legacySelectedCourse = localStorage.getItem('studyMateSelectedCourse') || '';
let selectedCourseId = courses.find(course => course.id === legacySelectedCourse || course.name === legacySelectedCourse)?.id || courses[0]?.id || '';
const selectedCourse = () => courses.find(course => course.id === selectedCourseId) || null;
const courseName = (courseId, fallback = '') => courses.find(course => course.id === courseId)?.name || fallback || 'Unknown course';
let translationTarget = localStorage.getItem('studyMateTranslationTarget') || (student.preferredLanguage === 'Korean' ? 'ko' : 'en');
let recordings = restoreRecordings();
let reviewState = { lectureId: null, tab: 'transcript', audioUrl: '', ownsAudioUrl: false, audioStatus: 'idle', audioError: '', currentTime: 0, duration: 0, speed: 1, loading: false };
let sttDebug = { lastEvent: 'Idle', interim: '—', final: '—', lines: [], engine: '—', connection: 'idle', language: '—', audio: '—', chunks: 0, bytes: 0, interimCount: 0, finalCount: 0, reconnects: 0, startedAt: null, lastError: '—', latency: {} };
let translationDebug = { engine: '—', model: '—', connection: 'idle', targetLanguage: '—', requests: 0, success: 0, failure: 0, latencyMs: 0, lastError: '—', lastMetric: null, metricHistory: [] };
let smartNoteLatencyDebug = { lastMetric: null, metricHistory: [] };
const activeTranslationReveals = new Map();
let noteState = { selectedLectureId: null, notes: {}, editing: false, draft: null, quizAnswers: {}, generation: { status: 'idle', lectureId: null, error: '' }, localization: { status: 'idle', noteId: null, language: null, error: '' }, revealLectureId: null };
const keywordDetails = {
  Algorithm: { meaning: 'A step-by-step method for solving a problem.', context: 'Used to organize the method discussed in this lecture.', major: 'Algorithms are foundational to computer science and efficient program design.' },
  Database: { meaning: 'An organized collection of structured information.', context: 'Connects lecture examples to stored and queried data.', major: 'Understanding databases helps you design reliable applications.' },
  JavaScript: { meaning: 'A programming language commonly used for web applications.', context: 'Appears when discussing implementation examples.', major: 'At Year 2 level, focus on how code structure affects maintainability.' },
  Network: { meaning: 'A system that connects computers and devices to exchange data.', context: 'Supports the broader context of system communication.', major: 'Build from core concepts such as protocols and data flow.' }
};
const glossaryService = new MockGlossaryAdapter([
  { term: '정규화', aliases: ['normalization'], courseIds: ['course-1'], meaning: 'A database design process that organizes data to reduce duplication and improve integrity.' },
  { term: '데이터베이스', aliases: ['database'], courseIds: ['course-1'], meaning: 'An organized collection of structured data that can be stored and queried.' },
  { term: '알고리즘', aliases: ['algorithm'], courseIds: ['course-1'], meaning: 'A step-by-step procedure for solving a computational problem.' },
  { term: '네트워크', aliases: ['network'], courseIds: ['course-2'], meaning: 'Connected computers and systems that exchange data.' }
]);
function phraseHintsFromGlossary(course, entries = []) { return [...new Set([course?.name, ...entries.flatMap(entry => [entry.term, ...(entry.aliases || [])])].map(value => String(value || '').trim()).filter(Boolean))].slice(0, 20); }
const smartNoteCache = new Map();
function smartNoteCacheKey(lecture, language) { const source = `${lecture?.courseId || lecture?.course || ''}|${language}|${(lecture?.transcript || []).map(value => String(value).trim()).join('\n')}`; let hash = 2166136261; for (let index = 0; index < source.length; index += 1) hash = Math.imul(hash ^ source.charCodeAt(index), 16777619); return `${language}:${(hash >>> 0).toString(36)}`; }
let scheduleState = { items: demoMode ? [{ id: 'demo-schedule-1', title: 'Web programming assignment', date: '2026-09-22', time: '23:59', description: 'Complete responsive layout exercise.', relatedLecture: 'Web Programming', status: 'confirmed', reminders: ['5 days', '3 days'] }] : [], candidates: [], dismissedCandidateIds: [], notification: 'not requested', extraction: { status: 'idle', error: '' }, calendarMonth: new Date().toISOString().slice(0, 7) };
let scheduleEditor = { mode: null, id: null, error: '' };
let boardState = { posts: demoMode ? boardPosts.map((post, index) => ({ ...post, id: `demo-post-${index + 1}`, body: 'Share what you have tried so other students can help clearly.', comments: index === 0 ? [{ author: 'Jin', body: 'Try drawing the nodes first, then update the reference.' }] : [] })) : [], selectedId: null, filter: '', category: 'All', composing: false, editingPostId: null, editingCommentIndex: null, error: '' };
const useMockChat = new URLSearchParams(location.search).get('chat') === 'mock';
const chatService = useMockChat ? new MockChatAdapter() : null;
const youthPolicyService = new YouthPolicyAdapter();
const eligibilityMatcher = new EligibilityMatcher();
const campusEvents = demoMode ? [{ title: 'International Tech Career Fair', description: 'Meet campus labs and local technology companies.', tags: ['Computer Science', 'Career'] }, { title: 'Academic Korean Workshop', description: 'Practice presentation and classroom communication skills.', tags: ['Academic Korean'] }] : [];
let appLanguage = localStorage.getItem('studyMateLanguage') || (student.preferredLanguage === 'Korean' ? 'ko' : 'en');
let profileState = { saved: false, timer: null };
let chatState = { messages: [], loading: false, loadingLabel: '', error: '', publicData: null };
const translations = { ko: { Home: '홈', Lecture: '강의', Notes: '노트', Schedule: '일정', Board: '게시판', 'AI Chatbot': 'AI 챗봇', 'My Page': '마이페이지', 'Good morning, Minh Anh!': '안녕하세요, Minh Anh님!', 'Study Mate': 'Study Mate', 'Start recording': '녹음 시작', 'Save PDF': 'PDF 저장', 'Write a post': '글 작성' } };
const t = text => translations[appLanguage]?.[text] || text;
const ui = (en, ko) => appLanguage === 'ko' ? ko : en;
const uiKorean = {
  'Open menu':'메뉴 열기','App language':'앱 언어','Course':'과목','Lecture title':'강의 제목','Speech recognition language':'음성 인식 언어','Translation language':'번역 언어','Chat message':'채팅 메시지','Search board':'게시글 검색','Microphone: not requested':'마이크: 권한 요청 전','Ready to record':'녹음 준비됨','ORIGINAL CAPTIONS':'원문 자막','TRANSLATION':'번역 자막','Live STT':'실시간 STT','Audio processing':'오디오 처리','Recognize Korean':'한국어 인식','Recognize English':'영어 인식','Translate to English':'영어로 번역','Translate to Korean':'한국어로 번역','Start recording':'녹음 시작','Pause':'일시정지','Resume':'재개','Finish':'종료','STT status:':'STT 상태:','Storage:':'저장 상태:',
  'Capture the lecture as it happens.':'실시간으로 강의를 기록하세요.','Your browser records audio locally. Live captions only use actual recognition results unless the explicit development mock mode is selected.':'브라우저에서 오디오를 로컬로 녹음합니다. 개발용 Mock 모드를 명시적으로 선택한 경우를 제외하면 실제 인식 결과만 자막에 표시됩니다.','Your lecture canvas is ready':'강의 자막 화면이 준비되었습니다','Start recording to display your speech as interim and final captions.':'녹음을 시작하면 음성이 임시 및 최종 자막으로 표시됩니다.','Translation is waiting':'번역 대기 중','Final captions are translated into your selected language.':'최종 자막이 선택한 언어로 번역됩니다.','recording and speech recognition run independently. A recognition error does not stop the audio recording.':'녹음과 음성 인식은 독립적으로 동작합니다. 인식 오류가 발생해도 녹음은 중단되지 않습니다.','audio Blob, transcript buffer, translations, and segments remain available in this app session after finishing.':'녹음 종료 후 오디오, transcript, 번역, 구간 정보가 이 앱 세션에 보관됩니다.',
  'Ready to make today<br />count?':'오늘의 학습을<br />시작해 볼까요?','Keep your lectures, notes, and deadlines in one clear place.':'강의, 노트, 마감 일정을 한곳에서 정리하세요.','Start a lecture':'강의 시작','Today’s learning':'오늘의 학습','Notes to review':'복습할 노트','Upcoming tasks':'다가오는 일정','Recent lectures':'최근 강의','View all lectures →':'모든 강의 보기 →','Upcoming schedule':'다가오는 일정','Open calendar →':'캘린더 열기 →','Continue reviewing':'복습 이어가기','Have a question?':'궁금한 점이 있나요?','Ask about your studies or how to use Study Mate.':'학습 내용이나 Study Mate 사용법을 물어보세요.','Ask AI Chatbot →':'AI 챗봇에게 물어보기 →','No finished lectures':'완료된 강의가 없습니다','Finish a recording with final captions to create a note.':'최종 자막이 있는 녹음을 완료하면 노트를 만들 수 있습니다.',
  'Turn lectures into clear study material.':'강의를 명확한 학습 자료로 정리하세요.','Select a finished lecture to create an editable note and revision quiz.':'완료된 강의를 선택해 편집 가능한 노트와 복습 퀴즈를 만드세요.','Lectures':'강의 목록','Your recording':'내 녹음','Sample transcript':'샘플 transcript','transcript lines':'자막 줄','no final transcript':'최종 자막 없음','Transcript-based note':'Transcript 기반 노트','Cancel':'취소','Save':'저장','Edit':'편집','Lecture summary':'강의 요약','Key points':'주요 내용','Key sentences':'주요 문장','Review points':'복습 포인트','Review quiz':'복습 퀴즈','Instant feedback':'즉시 채점','Multiple choice':'객관식','Correct!':'정답입니다!','Not quite.':'오답입니다.','Answer:':'정답:','Ready to create a Smart Note?':'Smart Note를 만들 준비가 되었습니다','Transcript required':'Transcript가 필요합니다','This lecture has transcript content ready for an organized review note.':'이 강의에는 정리된 복습 노트를 만들 수 있는 transcript가 있습니다.','There is no lecture transcript to summarize yet.':'요약할 강의 내용이 없습니다.','Generate Smart Note →':'Smart Note 만들기 →','No lecture selected':'선택된 강의가 없습니다','Finish a recording with final captions before creating a Smart Note.':'최종 자막이 포함된 녹음을 완료한 뒤 Smart Note를 만드세요.','Basic meaning':'기본 의미','In this lecture':'이 강의에서의 의미','For your major':'전공과의 연결','Study tip':'학습 팁','Close':'닫기','Creating Smart Note…':'Smart Note 생성 중…','Analyzing the lecture and creating your summary note…':'강의 내용을 분석하고 요약 노트를 생성하고 있습니다…','Converting this note to your selected language…':'선택한 언어로 노트를 변환하고 있습니다…',
  'Plan, confirm, and remember.':'계획하고, 확인하고, 기억하세요.','Schedule suggestions are never added automatically. Review every date first.':'일정 후보는 자동 등록되지 않습니다. 모든 날짜를 먼저 확인하세요.','Extract schedule suggestions':'일정 후보 추출','Upcoming schedule':'다가오는 일정','Schedule candidates':'일정 후보','No calendar events':'등록된 일정이 없습니다','Confirm a suggestion to add it to your calendar.':'후보를 확인한 뒤 캘린더에 추가하세요.','No pending suggestions':'대기 중인 후보가 없습니다','Extract possible dates from a selected lecture, then review them before adding anything.':'선택한 강의에서 날짜 후보를 추출한 뒤 검토하세요.','Needs your review':'검토 필요','From ':'출처: ','Title':'제목','Date':'날짜','Time':'시간','Add to calendar':'캘린더에 추가','Reminder permission:':'알림 권한:','Set reminders at 5 and 3 days before confirmed events.':'확정된 일정에 5일 전과 3일 전 알림을 설정합니다.','Enable reminders':'알림 사용',
  'Learn better, together.':'함께 더 잘 배워요.','Ask questions, share ideas, and find study partners.':'질문하고, 아이디어를 나누고, 학습 파트너를 찾아보세요.','Search posts':'게시글 검색','Search':'검색','Write a post':'글 작성','No posts found':'게시글이 없습니다','Try another keyword or category.':'다른 검색어 또는 카테고리를 사용해 보세요.','All posts':'전체 게시글','Comments':'댓글','Write a comment':'댓글 작성','Comment':'댓글 등록','Publish post':'게시글 등록','Content':'내용','Category':'카테고리','What would you like to ask?':'무엇을 질문하고 싶나요?','Add context, what you tried, and your question.':'시도한 내용과 질문의 맥락을 작성하세요.',
  'Your study companion.':'나만의 학습 도우미','Ask about recording lectures, your schedule, or campus events.':'강의 녹음, 일정, 캠퍼스 행사에 대해 물어보세요.','Study Mate에게 질문하세요…':'Study Mate에게 질문하세요…','Mock Chat Adapter is active. External AI keys are never stored in the browser.':'현재 채팅은 개발용 응답을 사용하며 외부 AI 키는 브라우저에 저장하지 않습니다.','Chat service is not connected yet.':'채팅 서비스가 아직 연결되지 않았습니다.','My learning profile.':'나의 학습 프로필','Your information personalizes your Study Mate experience.':'학생 정보는 Study Mate 경험을 개인화합니다.','Student information':'학생 정보','Current courses':'수강 과목','Major keywords':'전공 키워드','Student ID':'학번','Nationality':'국적','Department':'학과','Year':'학년','Preferred language':'선호 언어','Edit profile':'프로필 편집'
};
function localizeUi(markup) { if (appLanguage !== 'ko') return markup; return Object.entries(uiKorean).sort(([a], [b]) => b.length - a.length).reduce((result, [source, target]) => result.split(source).join(target), markup); }
function restoreRecordings() { try { const stored = JSON.parse(localStorage.getItem('studyMateRecordings')); return Array.isArray(stored) ? stored.filter(item => item?.id && Array.isArray(item.originalTranscript)).map(item => ({ ...item, audio: null, audioUrl: null })) : []; } catch (_) { return []; } }
function restoreAppState() { try { const schedule = JSON.parse(localStorage.getItem('studyMateSchedules')); const board = JSON.parse(localStorage.getItem('studyMateBoard')); const notes = JSON.parse(localStorage.getItem('studyMateNotes')); if (schedule) scheduleState = { ...scheduleState, ...schedule, candidates: Array.isArray(schedule.candidates) ? schedule.candidates : [], dismissedCandidateIds: Array.isArray(schedule.dismissedCandidateIds) ? schedule.dismissedCandidateIds : [] }; if (board) boardState = { ...boardState, ...board, selectedId: null, composing: false }; if (notes) { const noteEntries = Object.entries(notes.notes || {}); const currentNotes = Object.fromEntries(noteEntries.filter(([, note]) => note?.generationVersion === 2)); const legacyNotes = Object.fromEntries(noteEntries.filter(([, note]) => note?.generationVersion !== 2)); if (Object.keys(legacyNotes).length) localStorage.setItem('studyMateLegacyNotes', JSON.stringify(legacyNotes)); noteState = { ...noteState, ...notes, notes: currentNotes, editing: false, draft: null }; } } catch (_) {} }
function persistAppState() { try { localStorage.setItem('studyMateSchedules', JSON.stringify(scheduleState)); localStorage.setItem('studyMateBoard', JSON.stringify({ posts: boardState.posts, filter: boardState.filter, category: boardState.category })); localStorage.setItem('studyMateNotes', JSON.stringify({ selectedLectureId: noteState.selectedLectureId, notes: noteState.notes, quizAnswers: noteState.quizAnswers })); localStorage.setItem('studyMateSelectedCourse', selectedCourseId); localStorage.setItem('studyMateCourses', JSON.stringify(courses)); localStorage.setItem('studyMateTranslationTarget', translationTarget); localStorage.setItem('studyMateRecordings', JSON.stringify(recordings.map(({ audio, audioUrl, ...metadata }) => metadata))); } catch (_) {} }
restoreAppState();
const requestedSttMode = new URLSearchParams(location.search).get('stt') || 'google';
const useMockStt = requestedSttMode === 'mock';
const getSttService = () => useMockStt ? new MockSpeechToTextAdapter() : requestedSttMode === 'browser' ? new BrowserSpeechRecognitionAdapter({ language: document.querySelector('#stt-input-language')?.value || 'ko-KR' }) : new GoogleSpeechToTextAdapter();
const sttModeLabel = useMockStt ? 'STT Engine: Mock (development only)' : requestedSttMode === 'browser' ? 'STT Engine: Browser Speech Recognition (fallback)' : 'STT Engine: Google STT (server proxy)';
const requestedTranslationMode = new URLSearchParams(location.search).get('translation') || 'gemini';
const useMockTranslation = requestedTranslationMode === 'mock';
const getTranslationService = () => useMockTranslation ? new MockTranslationAdapter() : new GeminiTranslationAdapter();
const translationModeLabel = useMockTranslation ? 'Mock Translation (development only)' : 'Gemini · gemini-2.5-flash';

const navigate = path => { history.pushState({}, '', path); render(); window.scrollTo(0, 0); };
document.addEventListener('click', e => {
  const link = e.target.closest('[data-route]');
  if (link) { e.preventDefault(); navigate(link.dataset.route); }
  if (e.target.closest('[data-menu]')) app.classList.toggle('menu-open');
  if (e.target.closest('[data-close-menu]')) app.classList.remove('menu-open');
  const action = e.target.closest('[data-lecture-action]')?.dataset.lectureAction;
  if (action) handleLectureAction(action);
  if (e.target.closest('[data-download-recording]')) downloadRecording();
  const noteAction = e.target.closest('[data-note-action]')?.dataset.noteAction;
  if (noteAction) handleNoteAction(noteAction, e.target.closest('[data-note-action]'));
  const reviewAction = e.target.closest('[data-review-action]')?.dataset.reviewAction;
  if (reviewAction) handleReviewAction(reviewAction, e.target.closest('[data-review-action]'));
  const keyword = e.target.closest('[data-keyword]')?.dataset.keyword;
  if (keyword) openKeywordPopup(keyword);
  const answer = e.target.closest('[data-quiz-answer]');
  if (answer) submitQuizAnswer(answer.dataset.quizId, answer.dataset.quizAnswer);
  const scheduleAction = e.target.closest('[data-schedule-action]')?.dataset.scheduleAction;
  if (scheduleAction) handleScheduleAction(scheduleAction, e.target.closest('[data-schedule-action]'));
  const boardAction = e.target.closest('[data-board-action]')?.dataset.boardAction;
  if (boardAction) handleBoardAction(boardAction, e.target.closest('[data-board-action]'));
  const chatAction = e.target.closest('[data-chat-action]')?.dataset.chatAction;
  if (chatAction) handleChatAction(chatAction, e.target.closest('[data-chat-action]'));
  const courseAction = e.target.closest('[data-course-action]')?.dataset.courseAction;
  if (courseAction) handleCourseAction(courseAction, e.target.closest('[data-course-action]'));
  if (e.target.closest('[data-profile-action="save"]')) {
    if (profileState.saved) return;
    const age = Number(document.querySelector('#profile-age')?.value);
    if (!Number.isInteger(age) || age < 0 || age > 120) return;
    student.age = age;
    student.residence = document.querySelector('#profile-residence')?.value || '';
    student.enrollmentStatus = document.querySelector('#profile-enrollment')?.value || 'ENROLLED';
    student.employmentStatus = document.querySelector('#profile-employment')?.value || 'UNEMPLOYED';
    student.interests = [...document.querySelectorAll('[data-profile-interest]:checked')].map(x => x.value);
    localStorage.setItem('studyMateStudentProfile', JSON.stringify({
      age: student.age,
      residence: student.residence,
      enrollmentStatus: student.enrollmentStatus,
      employmentStatus: student.employmentStatus,
      interests: student.interests
    }));
    profileState.saved = true;
    render();
    if (profileState.timer) clearTimeout(profileState.timer);
    profileState.timer = setTimeout(() => {
      profileState.saved = false;
      profileState.timer = null;
      render();
    }, 1500);
  }
});
document.addEventListener('change', e => {
  if (e.target.id === 'app-language') {
    const previousLanguage = appLanguage;
    appLanguage = e.target.value;
    localStorage.setItem('studyMateLanguage', appLanguage);
    if (location.pathname === '/notes' || location.pathname.startsWith('/lectures/')) {
      localizeSelectedNote(appLanguage, previousLanguage);
    }
    render();
  }
  if (e.target.id === 'translation-language') { translationTarget = e.target.value; localStorage.setItem('studyMateTranslationTarget', translationTarget); }
  if (e.target.id === 'lecture-course') { selectedCourseId = e.target.value; localStorage.setItem('studyMateSelectedCourse', selectedCourseId); const title = document.querySelector('#lecture-title'); if (title) title.value = lectureTitleForCourse(selectedCourse()?.name); }
  if (e.target.id === 'review-speed') { reviewState.speed = Number(e.target.value) || 1; const audio = document.querySelector('#review-audio'); if (audio) audio.playbackRate = reviewState.speed; }
});
document.addEventListener('input', e => { if (e.target.id === 'review-progress') { const audio = document.querySelector('#review-audio'); if (audio) audio.currentTime = Number(e.target.value) || 0; } });
document.addEventListener('keydown', e => { if (e.key === 'Enter' && e.target.id === 'chat-message') { e.preventDefault(); handleChatAction('send'); } });
window.addEventListener('popstate', render);

function nav() {
  const path = location.pathname;
  return `<aside class="sidebar"><a class="brand" data-route="/" href="/"><span>✦</span> Study Mate</a><p class="side-label">${appLanguage === 'ko' ? '메뉴' : 'MENU'}</p><nav>${routes.map(([url, label, iconName]) => `<a class="nav-link ${path === url ? 'active' : ''}" data-route="${url}" href="${url}"><span class="nav-icon">${icon(iconName, { size: 'md' })}</span>${t(label)}</a>`).join('')}</nav><div class="side-help"><span>?</span><div><strong>${appLanguage === 'ko' ? '도움이 필요하신가요?' : 'Need help?'}</strong><small>${appLanguage === 'ko' ? 'Study Mate에게 물어보기' : 'Ask Study Mate'}</small></div></div></aside>`;
}
function topbar(title) { const displayTitle = /^Good morning,/.test(title) && appLanguage === 'ko' ? `안녕하세요, ${student.name}님!` : t(title); return `<header class="topbar"><button class="menu-button" data-menu aria-label="Open menu">${icon('menu', { size: 'md' })}</button><div><p class="eyebrow">STUDY MATE</p><h1>${displayTitle}</h1></div><div class="profile-chip"><select id="app-language" aria-label="App language"><option value="en" ${appLanguage === 'en' ? 'selected' : ''}>EN</option><option value="ko" ${appLanguage === 'ko' ? 'selected' : ''}>한국어</option></select><span class="avatar">${initials}</span><span class="profile-name">${student.name}</span></div></header>`; }
function lectureTitleForCourse(course) { return course ? `${course} lecture` : 'Lecture'; }
function card(title, body, cls = '') { return `<section class="card ${cls}"><div class="card-heading"><h2>${title}</h2></div>${body}</section>`; }
function empty(title, copy) { return `<div class="state empty"><span>${icon('inbox', { size: 'lg' })}</span><strong>${title}</strong><p>${copy}</p></div>`; }
function error(title, copy) { return `<div class="state error"><span>!</span><strong>${title}</strong><p>${copy}</p><button class="button secondary" onclick="location.reload()">Try again</button></div>`; }
function loading(label = 'Loading your study space…') { return `<div class="state loading"><span class="spinner"></span><strong>${label}</strong><p>Please wait a moment.</p></div>`; }
function resetSttDebug() { sttDebug = { lastEvent: 'Idle', interim: '—', final: '—', lines: [], engine: '—', connection: 'idle', language: '—', audio: '—', chunks: 0, bytes: 0, interimCount: 0, finalCount: 0, reconnects: 0, startedAt: null, lastError: '—', latency: {} }; translationDebug = { engine: useMockTranslation ? 'MOCK TRANSLATION' : 'GEMINI', model: useMockTranslation ? 'mock' : 'gemini-2.5-flash', connection: 'idle', targetLanguage: '—', requests: 0, success: 0, failure: 0, latencyMs: 0, lastError: '—', lastMetric: null, metricHistory: [] }; smartNoteLatencyDebug = { lastMetric: null, metricHistory: [] }; refreshSttDebug(); }
function recordSttDebug(event, detail = '') {
  sttDebug.lastEvent = event;
  if (event.includes('engine')) sttDebug.engine = detail;
  if (event.includes('Audio format')) { sttDebug.audio = detail; sttDebug.language = lectureSession?.audioConfig?.languageCode || '—'; }
  if (event.includes('ready')) { sttDebug.connection = 'connected'; sttDebug.startedAt = Date.now(); }
  if (event.includes('connection requested')) sttDebug.connection = 'connecting';
  if (event.includes('interim')) { sttDebug.interim = detail; sttDebug.interimCount += 1; }
  if (event.includes('final')) { sttDebug.final = detail; sttDebug.finalCount += 1; }
  if (event.includes('audio chunk')) { sttDebug.chunks += 1; const bytes = detail.match(/bytes=(\d+)/); if (bytes) sttDebug.bytes = Number(bytes[1]); }
  if (event.includes('reconnect')) sttDebug.reconnects += 1;
  if (event.includes('error')) { sttDebug.lastError = detail; sttDebug.connection = 'error'; }
  sttDebug.lines = [`${new Date().toLocaleTimeString()} · ${event}${detail ? ` — ${detail}` : ''}`, ...sttDebug.lines].slice(0, 12);
  console.info('[Study Mate STT]', event, detail); refreshSttDebug();
}
function refreshSttDebug() {
  const target = document.querySelector('#stt-debug'); if (!target) return;
  target.querySelector('[data-debug-last]').textContent = sttDebug.lastEvent;
  target.querySelector('[data-debug-interim]').textContent = sttDebug.interim;
  target.querySelector('[data-debug-final]').textContent = sttDebug.final;
  target.querySelector('[data-debug-engine]').textContent = sttDebug.engine;
  target.querySelector('[data-debug-connection]').textContent = sttDebug.connection;
  target.querySelector('[data-debug-language]').textContent = sttDebug.language;
  target.querySelector('[data-debug-audio]').textContent = sttDebug.audio;
  target.querySelector('[data-debug-chunks]').textContent = `${sttDebug.chunks} / ${sttDebug.bytes} bytes`;
  target.querySelector('[data-debug-counts]').textContent = `interim ${sttDebug.interimCount}, final ${sttDebug.finalCount}, reconnect ${sttDebug.reconnects}`;
  target.querySelector('[data-debug-error]').textContent = sttDebug.lastError;
  target.querySelector('[data-debug-latency]').textContent = Object.entries(sttDebug.latency || {}).map(([name, value]) => `${name}: ${Math.round(value)} ms`).join(' · ') || '—';
  target.querySelector('[data-debug-log]').textContent = sttDebug.lines.join('\n') || 'No STT event yet.';
  target.querySelector('[data-translation-engine]').textContent = translationDebug.engine;
  target.querySelector('[data-translation-model]').textContent = translationDebug.model;
  target.querySelector('[data-translation-connection]').textContent = translationDebug.connection;
  target.querySelector('[data-translation-language]').textContent = translationDebug.targetLanguage;
  target.querySelector('[data-translation-requests]').textContent = `request ${translationDebug.requests}, success ${translationDebug.success}, failure ${translationDebug.failure}`;
  target.querySelector('[data-translation-latency]').textContent = translationDebug.latencyMs ? `${translationDebug.latencyMs} ms` : '—';
  target.querySelector('[data-translation-error]').textContent = translationDebug.lastError;
  const metric = translationDebug.lastMetric;
  target.querySelector('[data-translation-breakdown]').textContent = metric ? `batch=${metric.batchId} · segments=${metric.segmentCount} · final→segment ${metric.finalToSegmentMs}ms · queue ${metric.queueWaitMs}ms · Gemini ${metric.geminiMs}ms · parse ${metric.parseMs}ms · UI ${metric.uiRenderMs}ms · total ${metric.totalMs}ms` : '—';
  target.querySelector('[data-translation-input]').textContent = metric ? `raw ${metric.input.rawChars} · context ${metric.input.contextChars} · glossary ${metric.input.glossaryCandidateCount}/${metric.input.glossaryChars} · approx ${metric.input.approximateTotalChars} chars` : '—';
}
function recordTranslationDebug(event, detail = '') {
  if (event === 'request') { translationDebug.connection = 'requesting'; translationDebug.requests += 1; }
  if (event === 'success') { translationDebug.connection = 'connected'; translationDebug.success += 1; translationDebug.latencyMs = Number(detail) || 0; translationDebug.lastError = '—'; }
  if (event === 'error') { translationDebug.connection = 'error'; translationDebug.failure += 1; translationDebug.lastError = detail || 'Translation failed.'; }
  refreshSttDebug();
}
function durationMs(later, earlier) { return Number.isFinite(later) && Number.isFinite(earlier) ? Math.max(0, Math.round(later - earlier)) : null; }
function measureTranslationInput(segments, previousSegments = [], glossary = [], course = '') {
  const rawChars = (segments || []).reduce((total, segment) => total + String(segment?.content || '').trim().length, 0);
  const contextChars = (previousSegments || []).slice(-2).reduce((total, value) => total + String(value || '').trim().slice(0, 240).length, 0);
  const trimmedGlossary = (glossary || []).slice(0, 6).map(item => ({ term: String(item?.term || '').slice(0, 80), meaning: String(item?.meaning || '').slice(0, 180) })).filter(item => item.term);
  const glossaryChars = trimmedGlossary.reduce((total, item) => total + item.term.length + item.meaning.length, 0);
  const courseChars = String(course || '').trim().slice(0, 120).length;
  return { segmentCount: (segments || []).length, rawChars, contextChars, glossaryCandidateCount: trimmedGlossary.length, glossaryChars, approximateTotalChars: rawChars + contextChars + glossaryChars + courseChars };
}
function recordTranslationMetric(metric) {
  const input = metric.input || { segmentCount: metric.segmentCount || 0, rawChars: 0, contextChars: 0, glossaryCandidateCount: 0, glossaryChars: 0, approximateTotalChars: 0 };
  const finalized = { ...metric, input, finalToSegmentMs: durationMs(metric.segmentationCompletedAt, metric.sttFinalReceivedAt), segmentToQueueMs: durationMs(metric.translationQueuedAt, metric.segmentationCompletedAt), queueWaitMs: durationMs(metric.workerStartedAt, metric.queueEnteredAt), preGeminiMs: durationMs(metric.geminiRequestStartedAt, metric.workerStartedAt), geminiMs: durationMs(metric.geminiResponseReceivedAt, metric.geminiRequestStartedAt), parseMs: durationMs(metric.responseParsedAt, metric.geminiResponseReceivedAt), uiRenderMs: durationMs(metric.subtitleRenderedAt, metric.responseParsedAt), totalMs: durationMs(metric.subtitleRenderedAt, metric.sttFinalReceivedAt) };
  translationDebug.lastMetric = finalized; translationDebug.metricHistory = [...translationDebug.metricHistory, finalized].slice(-24);
  if (isDevelopment) console.info('[Study Mate latency] translation', finalized);
  refreshSttDebug();
}
function recordSubtitleRendered(metric) { requestAnimationFrame(() => { metric.subtitleRenderedAt = performance.now(); recordTranslationMetric(metric); }); }
function measureSmartNoteInput(lecture, glossary = []) {
  const transcript = (lecture?.transcript || []).map(value => String(value || '').trim()).filter(Boolean).slice(0, 80);
  const safeGlossary = (glossary || []).slice(0, 12).map(item => ({ term: String(item?.term || '').slice(0, 80), meaning: String(item?.meaning || '').slice(0, 220) })).filter(item => item.term);
  const transcriptChars = transcript.reduce((total, line) => total + line.length, 0);
  const glossaryChars = safeGlossary.reduce((total, item) => total + item.term.length + item.meaning.length, 0);
  const contextChars = String(lecture?.title || '').slice(0, 160).length + String(lecture?.course || '').slice(0, 120).length + String(student?.department || '').slice(0, 120).length + String(student?.grade || '').slice(0, 16).length;
  return { transcriptLines: transcript.length, transcriptChars, glossaryCount: safeGlossary.length, glossaryChars, approximateTotalChars: transcriptChars + glossaryChars + contextChars };
}
function recordSmartNoteMetric(metric) {
  const finalized = { ...metric, transcriptPreparationMs: durationMs(metric.transcriptPreparedAt, metric.generationRequestedAt), preGeminiWaitMs: durationMs(metric.geminiRequestStartedAt, metric.transcriptPreparedAt), geminiMs: durationMs(metric.geminiResponseReceivedAt, metric.geminiRequestStartedAt), parsePostProcessMs: durationMs(metric.cacheSavedAt, metric.geminiResponseReceivedAt), cacheSaveMs: durationMs(metric.cacheSavedAt, metric.responseParsedAt), uiRenderMs: durationMs(metric.noteRenderedAt, metric.cacheSavedAt), totalMs: durationMs(metric.noteRenderedAt, metric.generationRequestedAt) };
  smartNoteLatencyDebug.lastMetric = finalized; smartNoteLatencyDebug.metricHistory = [...smartNoteLatencyDebug.metricHistory, finalized].slice(-12);
  if (isDevelopment) console.info('[Study Mate latency] smart-note', finalized);
}

function actualHome() {
  const recentLectures = recordings; const recentNotes = Object.values(noteState.notes); const events = scheduleState.items.filter(item => item.status === 'confirmed').slice(0, 2).map(item => ({ title: item.title, date: scheduleDateLabel(item.date), color: 'blue' }));
  return `${topbar('Good morning, Minh Anh!')}<main><section class="hero"><div><p class="tag">YOUR LEARNING SPACE</p><h2>Ready to make today<br />count?</h2><p>Keep your lectures, notes, and deadlines in one clear place.</p><button class="button" data-route="/lecture">Start a lecture <b>→</b></button></div><div class="hero-orb">✦<small>Focus<br/>mode</small></div></section><section class="metrics"><div><span>Today’s learning</span><strong>2h 30m</strong><small>↑ 20% from last week</small></div><div><span>Notes to review</span><strong>3</strong><small>2 from this week</small></div><div><span>Upcoming tasks</span><strong>2</strong><small>Next one in 5 days</small></div></section><div class="grid two"><div>${card('Recent lectures', `<div class="list">${recentLectures.map(x => `<a data-route="/lecture" href="/lecture" class="list-row"><span class="round-icon">${icon('mic', { size: 'sm' })}</span><span><strong>${x.title}</strong><small>${x.time}</small></span><em>${x.status}</em><b class="row-chevron">${icon('chevron-right', { size: 'sm' })}</b></a>`).join('')}</div><a data-route="/lecture" href="/lecture" class="text-link">View all lectures →</a>`)}</div><div>${card('Upcoming schedule', `<div class="list">${events.map(x => `<a data-route="/schedule" href="/schedule" class="list-row"><span class="date-tile ${x.color}">${x.date.split(' ')[0]}<small>${x.date.split(' ')[1]}</small></span><span><strong>${x.title}</strong><small>Personal schedule</small></span><b class="row-chevron">${icon('chevron-right', { size: 'sm' })}</b></a>`).join('')}</div><a data-route="/schedule" href="/schedule" class="text-link">Open calendar →</a>`)}</div></div><div class="grid two bottom-grid"><div>${card('Continue reviewing', recentNotes.map(x => `<a data-route="/notes" href="/notes" class="note-line"><span class="note-icon">${icon('file-text', { size: 'sm' })}</span><span><strong>${x.title}</strong><small>${x.course} · ${x.date}</small></span><b class="row-chevron">${icon('chevron-right', { size: 'sm' })}</b></a>`).join(''))}</div><div class="chat-promo"><span>${icon('sparkles', { size: 'md' })}</span><div><p class="tag">STUDY ASSISTANT</p><h2>Have a question?</h2><p>Ask about your studies or how to use Study Mate.</p><button data-route="/chat" class="button light">Ask AI Chatbot →</button></div></div></div></main>`;
}
function lecture() { return `${topbar('Lecture')}<main><div class="page-intro"><p class="tag">LECTURE CAPTURE · PHASE 2</p><h2>Capture the lecture as it happens.</h2><p>Your browser records audio locally. Live captions only use actual recognition results unless the explicit development mock mode is selected.</p></div><div class="lecture-meta"><select id="lecture-course" aria-label="Course">${courses.map(course => `<option value="${esc(course.id)}" ${course.id === selectedCourseId ? 'selected' : ''}>${esc(course.name)}</option>`).join('')}</select><input id="lecture-title" aria-label="Lecture title" value="${esc(lectureTitleForCourse(selectedCourse()?.name))}"/><span id="permission-state" class="permission-pill">Microphone: not requested</span><span id="stt-mode" class="permission-pill stt-pill">${sttModeLabel}</span></div><section class="lecture-stage"><div class="stage-head"><span id="record-dot" class="status-dot idle"></span><strong id="record-status">Ready to record</strong><span id="recording-time">00:00:00</span></div><div class="caption-columns"><div><p class="caption-label">ORIGINAL CAPTIONS <span id="original-mode">${useMockStt ? 'Mock STT' : 'Live STT'}</span></p><div id="original-captions" class="caption-history">${empty('Your lecture canvas is ready', 'Start recording to display your speech as interim and final captions.')}</div></div><div><p class="caption-label">TRANSLATION <span id="translation-mode">${translationModeLabel}</span></p><div id="translated-captions" class="caption-history">${empty('Translation is waiting', 'Final captions are translated into your selected language.')}</div></div></div></section><section id="lecture-error" class="lecture-error" hidden></section><div class="control-panel recording-controls"><div><strong>Audio processing</strong><p>AEC · noise suppression · automatic gain control requested</p></div><select id="stt-input-language" aria-label="Speech recognition language"><option value="ko-KR" selected>Recognize Korean</option><option value="en-US">Recognize English</option></select><select id="translation-language" aria-label="Translation language"><option value="en" ${translationTarget === 'en' ? 'selected' : ''}>Translate to English</option><option value="ko" ${translationTarget === 'ko' ? 'selected' : ''}>Translate to Korean</option></select><button class="button" data-lecture-action="start">${icon('circle', { size: 'sm' })} <span>Start recording</span></button><button class="button secondary" data-lecture-action="pause" disabled>${icon('pause', { size: 'sm' })} <span>Pause</span></button><button class="button secondary" data-lecture-action="resume" disabled>${icon('play', { size: 'sm' })} <span>Resume</span></button><button class="button stop" data-lecture-action="stop" disabled>${icon('square', { size: 'sm' })} <span>Finish</span></button></div><div id="stt-notice" class="info-banner">${icon('activity', { size: 'sm' })} <span><strong>STT status:</strong> recording and speech recognition run independently. A recognition error does not stop the audio recording.</span></div><div id="saved-recording" class="info-banner">${icon('info', { size: 'sm' })} <span><strong>Storage:</strong> audio Blob, transcript buffer, translations, and segments remain available in this app session after finishing.</span></div></main>`; }
function getLectureControls() { return { start: document.querySelector('[data-lecture-action="start"]'), pause: document.querySelector('[data-lecture-action="pause"]'), resume: document.querySelector('[data-lecture-action="resume"]'), stop: document.querySelector('[data-lecture-action="stop"]'), course: document.querySelector('#lecture-course'), title: document.querySelector('#lecture-title') }; }
function setLectureStatus(status, permission = null) {
  const label = document.querySelector('#record-status'); const dot = document.querySelector('#record-dot');
  if (label) label.textContent = status;
  if (dot) dot.className = `status-dot ${status.toLowerCase().includes('record') ? 'recording' : status.toLowerCase().includes('pause') ? 'paused' : 'idle'}`;
  if (permission) document.querySelector('#permission-state').textContent = `Microphone: ${permission}`;
}
function formatDuration(ms) { const seconds = Math.floor(ms / 1000); return [Math.floor(seconds / 3600), Math.floor(seconds / 60) % 60, seconds % 60].map((x, i) => i === 0 ? String(x).padStart(2, '0') : String(x).padStart(2, '0')).join(':'); }
function updateTimer() { if (lectureSession?.startedAt) document.querySelector('#recording-time').textContent = formatDuration(Date.now() - lectureSession.startedAt - lectureSession.pausedMs); }
function showLectureError(message) { const target = document.querySelector('#lecture-error'); if (target) { target.hidden = false; target.innerHTML = `<div class="state error"><span>!</span><strong>Microphone recording could not start</strong><p>${message}</p></div>`; } }
function appendCaption(kind, text, state = 'final', captionId = '') {
  const target = document.querySelector(kind === 'original' ? '#original-captions' : '#translated-captions'); if (!target) return;
  target.querySelector('.state')?.remove();
  const interim = target.querySelector('.caption-line.interim:not(.pending)');
  if (state === 'interim') { if (interim) interim.textContent = text; else target.insertAdjacentHTML('beforeend', `<p class="caption-line interim">${text}</p>`); }
  else { interim?.remove(); target.insertAdjacentHTML('beforeend', `<p class="caption-line final ${state === 'pending' ? 'pending' : ''}" ${captionId ? `data-caption-id="${esc(captionId)}"` : ''}><span>${new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</span>${esc(text)}</p>`); }
  target.scrollTop = target.scrollHeight;
}
function completeTranslationReveal(captionId) {
  const reveal = activeTranslationReveals.get(captionId); if (!reveal) return;
  cancelAnimationFrame(reveal.frameId); reveal.textNode.textContent = reveal.fullText; reveal.cursor.remove(); reveal.line.classList.remove('revealing'); activeTranslationReveals.delete(captionId);
}
function completeActiveTranslationReveals() { [...activeTranslationReveals.keys()].forEach(completeTranslationReveal); }
function revealTranslation(captionId, text, allowConcurrent = false) {
  const target = document.querySelector('#translated-captions'); const line = target?.querySelector(`[data-caption-id="${CSS.escape(captionId)}"]`);
  if (!line) { appendCaption('translation', text, 'final', captionId); return; }
  if (!allowConcurrent) completeActiveTranslationReveals();
  const time = line.querySelector('span')?.outerHTML || '';
  const reducedMotion = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
  if (reducedMotion || !text) { line.classList.remove('pending', 'revealing'); line.innerHTML = `${time}${esc(text)}`; return; }
  line.classList.remove('pending'); line.classList.add('revealing'); line.innerHTML = `${time}<span class="translation-reveal-text"></span><span class="translation-reveal-cursor" aria-hidden="true">▌</span>`;
  const textNode = line.querySelector('.translation-reveal-text'); const cursor = line.querySelector('.translation-reveal-cursor');
  const fullText = String(text); const duration = Math.min(700, Math.max(300, 260 + Math.ceil(fullText.length * 4))); const startedAt = performance.now();
  const reveal = { line, textNode, cursor, fullText, frameId: 0 };
  const tick = now => { const ratio = Math.min(1, (now - startedAt) / duration); const end = Math.max(1, Math.floor(fullText.length * ratio)); textNode.textContent = fullText.slice(0, end); if (ratio >= 1) { cursor.remove(); line.classList.remove('revealing'); activeTranslationReveals.delete(captionId); return; } reveal.frameId = requestAnimationFrame(tick); };
  activeTranslationReveals.set(captionId, reveal); reveal.frameId = requestAnimationFrame(tick);
}
function updateCaption(kind, captionId, text) {
  if (kind === 'translation') completeTranslationReveal(captionId);
  const target = document.querySelector(kind === 'original' ? '#original-captions' : '#translated-captions'); const line = target?.querySelector(`[data-caption-id="${CSS.escape(captionId)}"]`);
  if (!line) return appendCaption(kind, text, 'final', captionId);
  const time = line.querySelector('span')?.outerHTML || '';
  line.classList.remove('interim'); line.innerHTML = `${time}${esc(text)}`; target.scrollTop = target.scrollHeight;
}
function recordLatency(name, startedAt) { if (!startedAt) return; sttDebug.latency[name] = performance.now() - startedAt; refreshSttDebug(); }
function enqueueTranslation(segment, language, previousSegments = [], timing = {}) {
  if (!lectureSession || lectureSession.translatedSegmentIds.has(segment.id) || lectureSession.queuedSegmentIds.has(segment.id)) return;
  lectureSession.queuedSegmentIds.add(segment.id);
  appendCaption('translation', ui('Translating', '번역 중'), 'pending', segment.id);
  const queueEnteredAt = performance.now();
  lectureSession.translationQueue.push({ session: lectureSession, segment, language, previousSegments: [...previousSegments], enqueuedAt: queueEnteredAt, batchId: `single-${lectureSession.nextTranslationBatchSequence++}`, metric: { ...timing, translationQueuedAt: queueEnteredAt, queueEnteredAt, segmentCount: 1 } });
  drainTranslationQueue();
}
function enqueueTranslationGroup(segments, language, previousSegments = [], timing = {}) {
  if (!lectureSession || !segments.length) return;
  const untranslated = segments.filter(segment => !lectureSession.translatedSegmentIds.has(segment.id) && !lectureSession.queuedSegmentIds.has(segment.id));
  if (!untranslated.length) return;
  untranslated.forEach(segment => { lectureSession.queuedSegmentIds.add(segment.id); appendCaption('translation', ui('Translating', '번역 중'), 'pending', segment.id); });
  const queueEnteredAt = performance.now();
  lectureSession.translationQueue.push({ session: lectureSession, segments: untranslated, language, previousSegments: [...previousSegments], enqueuedAt: queueEnteredAt, batchId: `batch-${lectureSession.nextTranslationBatchSequence++}`, metric: { ...timing, translationQueuedAt: queueEnteredAt, queueEnteredAt, segmentCount: untranslated.length } });
  drainTranslationQueue();
}
function drainTranslationQueue() {
  if (!lectureSession) return;
  while (lectureSession.translationActive < 2 && lectureSession.translationQueue.length) {
    const job = lectureSession.translationQueue.shift(); lectureSession.translationActive += 1;
    job.metric.workerStartedAt = performance.now(); job.metric.translationStartedAt = job.metric.workerStartedAt; job.metric.activeTranslationCount = lectureSession.translationActive; job.metric.batchId = job.batchId;
    const task = job.segments ? translateFinalGroup(job.session, job.segments, job.language, job.previousSegments, job.metric) : translateFinalSegment(job.session, job.segment, job.language, job.previousSegments, job.metric);
    task.finally(() => { if (lectureSession !== job.session) return; lectureSession.translationActive -= 1; drainTranslationQueue(); });
  }
}
function recordingAudioTimelineMs(session = lectureSession) { return Math.max(0, Number(session?.mediaTimelineMs) || 0, performance.now() - (session?.timelineStartedAt || performance.now()) - (session?.timelinePausedMs || 0)); }
function normalizeGoogleWordTimings(timing = {}, session = lectureSession) {
  const base = Number.isFinite(Number(timing.streamBaseAudioOffsetMs)) ? Number(timing.streamBaseAudioOffsetMs) : Number(session?.sttStreamBaseMs) || 0;
  return (Array.isArray(timing.wordTimings) ? timing.wordTimings : []).map(word => ({ word: String(word?.word || ''), startMs: base + Number(word?.startMs), endMs: base + Number(word?.endMs) })).filter(word => word.word && Number.isFinite(word.startMs) && Number.isFinite(word.endMs) && word.endMs >= word.startMs);
}
function handleFinalTranscript(text, finalAt = performance.now(), timing = {}) {
  if (!lectureSession || !['recording', 'finishing'].includes(lectureSession.status)) return;
  const finalKey = String(text || '').trim().replace(/\s+/g, ' ').toLowerCase();
  if (!finalKey || lectureSession.finalTranscriptKeys.has(finalKey)) { if (finalKey) recordSttDebug('Duplicate final prevented', finalKey.slice(0, 80)); return; }
  lectureSession.finalTranscriptKeys.add(finalKey);
  lectureSession.transcript.push(text);
  const googleWords = normalizeGoogleWordTimings(timing);
  const streamBaseAudioOffsetMs = Number.isFinite(Number(timing.streamBaseAudioOffsetMs)) ? Number(timing.streamBaseAudioOffsetMs) : lectureSession.sttStreamBaseMs || 0;
  const googleEndMs = Number(timing.resultEndMs);
  const hasResultTiming = Number.isFinite(googleEndMs) && googleEndMs >= 0;
  const fallbackEndMs = hasResultTiming ? streamBaseAudioOffsetMs + googleEndMs : recordingAudioTimelineMs();
  const startMs = googleWords[0]?.startMs ?? Math.min(lectureSession.lastTranscriptEndMs || 0, fallbackEndMs);
  const endMs = googleWords.at(-1)?.endMs ?? Math.max(startMs, fallbackEndMs);
  const timestampSource = googleWords.length ? 'google-word-offset' : hasResultTiming ? 'google-result-end-estimated' : 'local-final-receipt';
  const segments = segmenter.segment(text, { startMs, endMs, timestampSource, wordTimings: googleWords, streamSequence: timing.streamSequence ?? null, streamBaseAudioOffsetMs });
  const segmentationCompletedAt = performance.now();
  const finalSegments = (segments.length ? segments : [{ id: `segment-${Date.now()}`, content: text, rawKorean: text, correctedKorean: '', translatedText: '', startMs, endMs, timestampSource, status: 'final' }]).map(segment => ({ ...segment, id: `segment-${lectureSession.nextSegmentSequence++}` })); lectureSession.segments.push(...finalSegments); lectureSession.lastTranscriptEndMs = endMs;
  finalSegments.forEach(segment => recordSttDebug('Segment timing', `id=${segment.id}; raw=${segment.rawKorean.slice(0, 44)}; google=${segment.googleStartMs ?? '—'}-${segment.googleEndMs ?? '—'}ms; base=${streamBaseAudioOffsetMs}ms; lecture=${segment.startMs}-${segment.endMs}ms; seek=${Math.max(0, segment.startMs - 350)}ms`));
  recordLatency('final→segment', finalAt);
  const language = document.querySelector('#translation-language')?.value || 'en';
  const previousSegments = lectureSession.causalSegments.slice(-2).map(item => item.content);
  finalSegments.forEach(segment => { appendCaption('original', segment.content, 'final', segment.id); lectureSession.causalSegments.push(segment); });
  const translationTiming = { sttFinalReceivedAt: finalAt, segmentationCompletedAt };
  if (finalSegments.length > 1) enqueueTranslationGroup(finalSegments, language, previousSegments, translationTiming);
  else enqueueTranslation(finalSegments[0], language, previousSegments, translationTiming);
}
async function translateFinalGroup(session, segments, language, previousSegments, metric) {
  if (!session || lectureSession !== session || !segments.length) return;
  segments.forEach(segment => session.translatedSegmentIds.add(segment.id));
  const cacheKey = `${language}:batch:${segments.map(segment => segment.content.trim().replace(/\s+/g, ' ').toLowerCase()).join('|')}`;
  const cached = session.translationCache.get(cacheKey);
  if (cached) {
    cached.segments.forEach(result => { const stored = session.segments.find(segment => segment.id === result.id); if (!stored) return; stored.correctedKorean = result.correctedKorean; stored.translatedText = result.translatedText; session.translations.push(result.translatedText); updateCaption('original', result.id, result.correctedKorean); updateCaption('translation', result.id, result.translatedText); });
    metric.cacheHit = true; metric.input = measureTranslationInput(segments, previousSegments, [], session.course); recordSubtitleRendered(metric);
    recordTranslationDebug('cache'); return;
  }
  recordLatency('segment→Gemini', metric.translationQueuedAt);
  translationDebug.engine = useMockTranslation ? 'MOCK TRANSLATION' : 'GEMINI'; translationDebug.model = useMockTranslation ? 'mock' : 'gemini-2.5-flash'; translationDebug.targetLanguage = language; recordTranslationDebug('request');
  try {
    const glossary = await glossaryService.findCandidates(segments.map(segment => segment.content).join(' '), session.courseContext);
    metric.input = measureTranslationInput(segments, previousSegments, glossary, session.course);
    recordSttDebug('Translation candidates', `batch=${segments.length}, previous=${previousSegments.length}, candidates=${glossary.length}`);
    const service = getTranslationService();
    const result = typeof service.translateSegments === 'function' ? await service.translateSegments(segments, language, glossary, { course: session.course, previousSegments }) : { segments: await Promise.all(segments.map(segment => service.translate(segment.content, language, glossary, { course: session.course, previousSegments }).then(value => ({ id: segment.id, ...value })))) };
    Object.assign(metric, result.timing || { geminiRequestStartedAt: performance.now(), geminiResponseReceivedAt: performance.now(), responseParsedAt: performance.now() });
    if (lectureSession !== session || session.status === 'stopped') return;
    result.segments.forEach(value => { const stored = session.segments.find(segment => segment.id === value.id); if (!stored) return; stored.correctedKorean = value.correctedKorean; stored.translatedText = value.translatedText; session.translations.push(value.translatedText); updateCaption('original', value.id, value.correctedKorean); });
    completeActiveTranslationReveals(); result.segments.forEach(value => revealTranslation(value.id, value.translatedText, true));
    session.translationCache.set(cacheKey, result); document.querySelector('#translation-mode').textContent = `${useMockTranslation ? 'Mock Translation' : 'Gemini'} · complete`; recordSubtitleRendered(metric); recordTranslationDebug('success', result.latencyMs);
  } catch (error) {
    const message = error.message || 'Translation is temporarily unavailable.'; segments.forEach(segment => updateCaption('translation', segment.id, `Translation unavailable: ${message}`)); document.querySelector('#translation-mode').textContent = `${useMockTranslation ? 'Mock Translation' : 'Gemini'} · unavailable`; recordTranslationDebug('error', message);
  }
}
async function translateFinalSegment(session, segment, language, previousSegments, metric) {
  if (!session || lectureSession !== session) return;
  if (session.translatedSegmentIds.has(segment.id)) return;
  session.translatedSegmentIds.add(segment.id);
  const cacheKey = `${language}:${segment.content.trim().replace(/\s+/g, ' ').toLowerCase()}`;
  const cached = session.translationCache.get(cacheKey);
  if (cached) { session.translations.push(cached.translatedText); updateCaption('original', segment.id, cached.correctedKorean); updateCaption('translation', segment.id, cached.translatedText); metric.cacheHit = true; metric.input = measureTranslationInput([segment], previousSegments, [], session.course); recordSubtitleRendered(metric); recordTranslationDebug('cache'); return; }
  recordLatency('segment→Gemini', metric.translationQueuedAt);
  translationDebug.engine = useMockTranslation ? 'MOCK TRANSLATION' : 'GEMINI'; translationDebug.model = useMockTranslation ? 'mock' : 'gemini-2.5-flash'; translationDebug.targetLanguage = language; recordTranslationDebug('request');
  try {
    const glossary = await glossaryService.findCandidates(segment.content, session.courseContext); metric.input = measureTranslationInput([segment], previousSegments, glossary, session.course); recordSttDebug('Translation candidates', `segment=${segment.id}, previous=${previousSegments.length}, candidates=${glossary.length}`); const result = await getTranslationService().translate(segment.content, language, glossary, { course: session.course, previousSegments }); Object.assign(metric, result.timing || { geminiRequestStartedAt: performance.now(), geminiResponseReceivedAt: performance.now(), responseParsedAt: performance.now() });
    if (lectureSession !== session || session.status === 'stopped') return;
    const storedSegment = session.segments.find(item => item.id === segment.id); if (storedSegment) { storedSegment.correctedKorean = result.correctedKorean; storedSegment.translatedText = result.translatedText; }
    session.translationCache.set(cacheKey, result); session.translations.push(result.translatedText); updateCaption('original', segment.id, result.correctedKorean); revealTranslation(segment.id, result.translatedText);
    document.querySelector('#translation-mode').textContent = `${useMockTranslation ? 'Mock Translation' : 'Gemini'} · complete`; recordSubtitleRendered(metric); recordTranslationDebug('success', result.latencyMs);
  } catch (error) {
    const message = error.message || 'Translation is temporarily unavailable.'; updateCaption('translation', segment.id, `Translation unavailable: ${message}`);
    document.querySelector('#translation-mode').textContent = `${useMockTranslation ? 'Mock Translation' : 'Gemini'} · unavailable`; recordTranslationDebug('error', message);
  }
}
function showSttNotice(message, isError = false) { const notice = document.querySelector('#stt-notice'); if (notice) notice.innerHTML = `${isError ? icon('alert-circle', { size: 'sm' }) : icon('activity', { size: 'sm' })} <span><strong>STT status:</strong> ${message}</span>`; }
async function initStt() {
  if (!lectureSession) return null;
  const engine = useMockStt ? 'MOCK STT' : requestedSttMode === 'browser' ? 'BROWSER STT' : 'GOOGLE STT';
  const track = lectureSession.originalStream.getAudioTracks()[0];
  const settings = track?.getSettings?.() || {};
  const sampleRateHertz = [8000, 12000, 16000, 24000, 48000].includes(settings.sampleRate) ? settings.sampleRate : 48000;
  lectureSession.audioConfig = {
    languageCode: document.querySelector('#stt-input-language')?.value || 'ko-KR',
    encoding: 'WEBM_OPUS',
    sampleRateHertz,
    channelCount: 1,
    phraseHints: lectureSession.phraseHints || []
  };
  recordSttDebug('STT engine', engine);
  recordSttDebug('Audio format', `${lectureSession.audioConfig.encoding}, ${sampleRateHertz}Hz, mono`);
  recordSttDebug('STT glossary', `${lectureSession.course || 'No course'} · ${lectureSession.courseGlossary?.length || 0} term(s)`);
  recordSttDebug('STT phrase hints', `${lectureSession.audioConfig.phraseHints.length} course-relevant hint(s)`);
  if (engine === 'GOOGLE STT' && !/webm/i.test(lectureSession.mimeType || '')) {
    const message = `Google STT requires WebM/Opus input, but this browser recorder selected ${lectureSession.mimeType || 'an unknown format'}. Audio recording continues.`;
    recordSttDebug('Google STT error', message);
    showSttNotice(message, true);
    return null;
  }
  lectureSession.sttStreamBaseMs = recordingAudioTimelineMs();
  lectureSession.sttService = getSttService();
  if (typeof lectureSession.sttService.sendAudioChunk === 'function' && !lectureSession.audioChunkListenerAttached) {
    lectureSession.audioChunkListenerAttached = true;
    lectureSession.recorder.addEventListener('dataavailable', event => {
      if (!lectureSession?.firstAudioAt) lectureSession.firstAudioAt = performance.now();
      lectureSession.lastAudioAt = performance.now();
      const fallbackEndMs = recordingAudioTimelineMs();
      const reportedStartMs = Number(event.timecode);
      const startMs = Number.isFinite(reportedStartMs) && reportedStartMs >= 0 ? reportedStartMs : lectureSession.mediaTimelineMs || 0;
      const endMs = Math.max(startMs, fallbackEndMs);
      lectureSession.mediaTimelineMs = Math.max(lectureSession.mediaTimelineMs || 0, endMs);
      lectureSession.sttService?.sendAudioChunk(event.data, { startMs, endMs });
    });
  }
  return lectureSession.sttService;
}
async function startSttStream(sttService = lectureSession?.sttService) {
  if (!lectureSession || !sttService) return;
  const engine = useMockStt ? 'MOCK STT' : requestedSttMode === 'browser' ? 'BROWSER STT' : 'GOOGLE STT';
  try {
    await sttService.startStream({
      onInterim: text => {
        const now = performance.now();
        if (!lectureSession.firstInterimAt) {
          lectureSession.firstInterimAt = now;
          recordLatency('audio→first interim', lectureSession.firstAudioAt);
        }
        lectureSession.lastInterimAt = now;
        appendCaption('original', text, 'interim');
      },
      onFinal: (text, timing) => {
        const now = performance.now();
        recordLatency('interim→final', lectureSession.lastInterimAt);
        handleFinalTranscript(text, now, timing);
      },
      onStreamAudioBase: info => {
        if (!lectureSession) return;
        lectureSession.sttStreamBaseMs = info.streamBaseAudioOffsetMs;
        recordSttDebug('Google STT stream base', `stream=${info.streamSequence}; audio=${info.streamBaseAudioOffsetMs}ms`);
      },
      onStart: () => {
        document.querySelector('#stt-mode').textContent = `STT Engine: ${engine} · connected`;
        showSttNotice(`${engine} is listening. Recording continues independently.`);
      },
      onEnd: () => {
        if (lectureSession?.status === 'recording') showSttNotice(`${engine} connection ended. Limited reconnect may continue while recording stays active.`, true);
      },
      onError: reason => {
        console.warn('Study Mate STT error:', reason);
        showSttNotice(`Live caption connection error: ${reason}. Audio recording continues.`, true);
      },
      onDebug: recordSttDebug,
      audioConfig: lectureSession.audioConfig
    });
    showSttNotice(useMockStt ? 'Mock development captions are active — not derived from microphone audio.' : `${engine} is ready for live audio chunks.`);
  } catch (err) {
    document.querySelector('#stt-mode').textContent = `STT Engine: ${engine} · unavailable`;
    document.querySelector('#original-mode').textContent = 'STT unavailable';
    showSttNotice(`${err.message} Audio recording continues without captions.`, true);
  }
}
async function startStt() {
  const service = await initStt();
  if (service) await startSttStream(service);
}
async function handleLectureAction(action) {
  if (action === 'start') {
    try {
      resetSttDebug(); recordSttDebug('Recording start requested');
      document.querySelector('#lecture-error').hidden = true; setLectureStatus('Requesting microphone…', 'requesting');
      const capture = await recordingService.start();
      const currentCourse = selectedCourse(); const title = document.querySelector('#lecture-title')?.value.trim() || lectureTitleForCourse(currentCourse?.name);
      const courseGlossary = await glossaryService.findForCourse(currentCourse); lectureSession = { ...capture, id: crypto.randomUUID?.() || String(Date.now()), title, courseId: currentCourse?.id || null, course: currentCourse?.name || '', courseContext: currentCourse, courseGlossary, phraseHints: phraseHintsFromGlossary(currentCourse, courseGlossary), status: 'recording', startedAt: Date.now(), pausedAt: null, pausedMs: 0, timelineStartedAt: performance.now(), timelinePausedAt: null, timelinePausedMs: 0, mediaTimelineMs: 0, sttStreamBaseMs: 0, lastTranscriptEndMs: 0, timingVersion: 2, transcript: [], translations: [], segments: [], causalSegments: [], translatedSegmentIds: new Set(), queuedSegmentIds: new Set(), finalTranscriptKeys: new Set(), translationCache: new Map(), translationQueue: [], translationActive: 0, nextSegmentSequence: 1 };
      lectureSession.nextTranslationBatchSequence = 1;
      const sttService = await initStt();
      const sttPromise = sttService ? startSttStream(sttService) : Promise.resolve();
      capture.recorder.start(250); recordSttDebug('MediaRecorder started', '250 ms chunks'); setLectureStatus('Recording', 'allowed');
      const controls = getLectureControls(); controls.start.disabled = true; controls.pause.disabled = false; controls.stop.disabled = false; controls.course.disabled = controls.title.disabled = true;
      lectureSession.timer = setInterval(updateTimer, 250);
      await sttPromise;
    } catch (err) {
      const denied = err.name === 'NotAllowedError' || err.name === 'SecurityError';
      setLectureStatus('Recording unavailable', denied ? 'denied' : 'unavailable');
      showLectureError(denied ? 'Permission was denied. Allow microphone access in your browser settings, then try again.' : err.message || 'Check that a microphone is connected and try again.');
    }
  }
  if (!lectureSession) return;
   if (action === 'pause' && lectureSession.status === 'recording') { const lastChunk = new Promise(resolve => lectureSession.recorder.addEventListener('dataavailable', resolve, { once: true })); lectureSession.recorder.requestData(); await lastChunk; await lectureSession.sttService?.flushAudio?.(); lectureSession.recorder.pause(); lectureSession.status = 'paused'; lectureSession.pausedAt = Date.now(); lectureSession.timelinePausedAt = performance.now(); clearInterval(lectureSession.timer); lectureSession.sttService?.stopStream(); setLectureStatus('Paused', 'allowed'); const c = getLectureControls(); c.pause.disabled = true; c.resume.disabled = false; }
   if (action === 'resume' && lectureSession.status === 'paused') { lectureSession.recorder.resume(); lectureSession.status = 'recording'; lectureSession.pausedMs += Date.now() - lectureSession.pausedAt; lectureSession.timelinePausedMs += performance.now() - lectureSession.timelinePausedAt; lectureSession.timelinePausedAt = null; lectureSession.timer = setInterval(updateTimer, 250); await startStt(); setLectureStatus('Recording', 'allowed'); const c = getLectureControls(); c.pause.disabled = false; c.resume.disabled = true; }
  if (action === 'stop' && lectureSession.status !== 'stopped') {
    lectureSession.status = 'finishing'; clearInterval(lectureSession.timer);
    await new Promise(resolve => { lectureSession.recorder.addEventListener('stop', resolve, { once: true }); lectureSession.recorder.stop(); });
    await lectureSession.sttService?.flushAudio?.(); lectureSession.sttService?.stopStream(); await new Promise(resolve => setTimeout(resolve, 850)); lectureSession.status = 'stopped';
    lectureSession.originalStream.getTracks().forEach(track => track.stop()); lectureSession.processedStream.getTracks().forEach(track => track.stop()); lectureSession.audioContext?.close();
    const durationMs = recordingAudioTimelineMs(); const audio = new Blob(lectureSession.chunks, { type: lectureSession.mimeType }); let audioStorageStatus = 'saved';
    try { await audioStorage.saveAudio(lectureSession.id, audio); } catch (_) { audioStorageStatus = 'unavailable'; }
    const saved = { id: lectureSession.id, title: lectureSession.title, courseId: lectureSession.courseId, course: lectureSession.course, createdAt: new Date().toISOString(), durationMs, timingVersion: lectureSession.timingVersion, audio, audioUrl: URL.createObjectURL(audio), audioRef: audioStorageStatus === 'saved' ? lectureSession.id : null, audioStorageStatus, originalTranscript: lectureSession.transcript, translatedTranscript: lectureSession.translations, transcriptSegments: lectureSession.segments };
    recordings.unshift(saved); persistAppState(); window.studyMateRecordings = recordings;
    setLectureStatus('Recording saved', 'allowed'); document.querySelector('#recording-time').textContent = formatDuration(durationMs);
    const c = getLectureControls(); c.pause.disabled = c.resume.disabled = c.stop.disabled = true; c.start.disabled = false; c.course.disabled = c.title.disabled = false;
    document.querySelector('#saved-recording').innerHTML = `${icon('check', { size: 'sm' })} <span><strong>${saved.title} saved locally.</strong> ${saved.transcriptSegments.length} transcript segment(s) and an audio file are ready.${audioStorageStatus === 'saved' ? ' Available for Lecture Review after refresh.' : ' Long-term browser audio storage was unavailable; download remains available for this session.'} <button class="download-link" data-download-recording>Download audio</button></span>`;
  }
}
function downloadRecording(recording = recordings.at(-1)) { const audioUrl = recording?.audioUrl || (reviewState.lectureId === recording?.id ? reviewState.audioUrl : ''); if (!audioUrl) return; const link = document.createElement('a'); link.href = audioUrl; link.download = `${recording.title.replace(/[^a-z0-9-_]/gi, '_') || 'lecture'}.webm`; link.click(); }
function reviewEmptyNote(recording) {
  const hasTranscript = Array.isArray(recording.originalTranscript) && recording.originalTranscript.some(item => String(item || '').trim());
  const generating = noteState.generation.status === 'generating' && noteState.generation.lectureId === recording.id;
  if (generating) return smartNoteSkeleton();
  return `<div class="state review-note-empty"><span>▤</span><strong>${ui('No Smart Note yet', 'Smart Note가 없습니다')}</strong><p>${ui('Generate a Smart Note from this lecture when you are ready. Opening this tab alone never starts an AI request.', '필요할 때 이 강의의 Smart Note를 생성하세요. 이 탭을 여는 것만으로는 AI 요청이 시작되지 않습니다.')}</p>${hasTranscript ? `<button class="button" data-review-action="generate-note" ${generating ? 'disabled' : ''}>${generating ? ui('Creating Smart Note…', 'Smart Note 생성 중…') : ui('Generate Smart Note', 'Smart Note 만들기')}</button>` : `<p class="note-error">${ui('A saved final transcript is required before a Smart Note can be generated.', 'Smart Note를 생성하려면 저장된 최종 자막이 필요합니다.')}</p>`}</div>`;
}
function smartNoteSkeleton() {
  const lines = count => Array.from({ length: count }, (_, index) => `<span class="note-skeleton-line line-${(index % 3) + 1}"></span>`).join('');
  return `<div class="review-note smart-note-skeleton" role="status" aria-live="polite"><div class="review-note-head"><div><p class="tag">SMART NOTE</p><h2>${ui('Creating your Smart Note', 'Smart Note를 만들고 있어요')}</h2></div></div><p class="smart-note-loading-copy">${ui('Analyzing your lecture ···', '강의 내용을 분석하고 있어요 ···')}</p><section class="note-section"><h3>${ui('Lecture summary', '강의 요약')}</h3><div class="note-skeleton-lines">${lines(3)}</div></section><section class="note-section"><h3>${ui('Key points', '주요 내용')}</h3><div class="note-skeleton-lines">${lines(2)}</div></section><section class="note-section"><h3>${ui('Study tips', '학습 팁')}</h3><div class="note-skeleton-lines">${lines(2)}</div></section><section class="note-section"><h3>${ui('Review quiz', '복습 퀴즈')}</h3><div class="note-skeleton-lines">${lines(2)}</div></section></div>`;
}

reviewNote = function reviewNoteWithRestoredContent(recording, note) {
  if (!note) return reviewEmptyNote(recording);
  if (note.contentLanguage !== appLanguage) {
    if (applyNoteVersion(note, appLanguage)) {
      persistAppState();
    } else if (noteState.localization.status !== 'localizing') {
      noteState.selectedLectureId = recording.id;
      localizeSelectedNote(appLanguage, note.contentLanguage || 'en');
      return smartNoteSkeleton();
    } else {
      return smartNoteSkeleton();
    }
  }
  const editing = noteState.editing && noteState.selectedLectureId === recording.id;
  const reveal = !editing && noteState.revealLectureId === recording.id;
  const actions = editing
    ? '<button class="button secondary" data-note-action="cancel">Cancel</button><button class="button" data-note-action="save">Save</button>'
    : `<button class="button secondary" data-review-action="edit-note">${ui('Edit', '편집')}</button><button class="button secondary" data-review-action="pdf-note">${ui('Save PDF', 'PDF 저장')}</button><button class="button danger" data-note-action="delete-lecture">${ui('Delete lecture', '강의 삭제')}</button>`;
  const studyTips = (note.studyTips || note.reviewPoints || []).map(point => `<li>${esc(point)}</li>`).join('');
  return `<div class="review-note"><div class="review-note-head"><div><p class="tag">SMART NOTE</p><h2>${esc(note.title || recording.title)}</h2></div><div class="note-actions">${actions}</div></div>${noteContents(note, { reveal })}${editing ? '' : `<section class="note-section${reveal ? ' note-reveal' : ''}" ${reveal ? 'style="--note-reveal-delay:180ms"' : ''}><h3>${ui('Study tips', '학습 팁')}</h3><ul>${studyTips}</ul></section><section class="note-section quiz-section${reveal ? ' note-reveal' : ''}" ${reveal ? 'style="--note-reveal-delay:240ms"' : ''}><div class="section-title"><h3>${ui('Review quiz', '복습 퀴즈')}</h3><span>${ui('Instant feedback', '즉시 채점')}</span></div>${noteQuizzes(note)}</section>`}</div>`;
};

const handleExistingReviewAction = handleReviewAction;
handleReviewAction = async function handleReviewActionWithGeneration(action, element) {
  if (action === 'generate-note') {
    const recording = recordings.find(item => item.id === reviewState.lectureId);
    if (!recording) return;
    reviewState.tab = 'note';
    noteState.selectedLectureId = recording.id;
    await handleNoteAction('generate', element);
    reviewState.tab = 'note';
    render();
    return;
  }
  return handleExistingReviewAction(action, element);
};

function notes() { return renderNotes(); }
function esc(value = '') { return String(value).replace(/[&<>'"]/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' }[char])); }
function noteLectures() {
  const sample = { id: 'mock-linked-list', title: 'Data Structures · Linked Lists', date: 'Sep 16, 2026', course: 'Data Structures', transcript: ['Today we will review the linked list data structure.', 'Each node stores a value and a reference to the next node.', 'This algorithm is useful when the size of our data changes frequently.'], kind: 'Sample transcript' };
  const actual = recordings.map(recording => ({ id: recording.id, title: recording.title, date: new Date(recording.createdAt).toLocaleDateString(), recordedAt: recording.createdAt, courseId: recording.courseId || null, course: courseName(recording.courseId, recording.course), transcript: recording.originalTranscript || [], finalizedTranscript: (recording.transcriptSegments || []).map(segment => ({ id: segment.id, correctedKorean: segment.correctedKorean || segment.content || segment.rawKorean || '', startMs: segment.startMs })).filter(segment => segment.correctedKorean), kind: 'Your recording' }));
  return demoMode ? [...actual, sample] : actual;
}
function highlighted(text, keywords, { firstOnly = false } = {}) {
  const terms = keywords.filter(Boolean); if (!terms.length) return esc(text); const pattern = new RegExp(`(${terms.map(term => term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|')})`, 'gi'); const shown = new Set();
  return esc(text).split(pattern).map(part => { const term = terms.find(value => value.toLowerCase() === part.toLowerCase()); if (!term || (firstOnly && shown.has(term.toLowerCase()))) return part; shown.add(term.toLowerCase()); return `<button class="keyword-mark" data-keyword="${esc(term)}">${part}</button>`; }).join('');
}
function noteContents(note, { reveal = false } = {}) {
  if (noteState.editing) return `<div class="note-editor"><label>Summary<textarea id="note-summary-edit">${esc(noteState.draft.summary)}</textarea></label><label>Review points (one per line)<textarea id="note-review-edit">${esc(noteState.draft.reviewPoints.join('\n'))}</textarea></label></div>`;
  const section = (delay, content) => `<section class="note-section${reveal ? ' note-reveal' : ''}" ${reveal ? `style="--note-reveal-delay:${delay}ms"` : ''}>${content}</section>`;
  return `${section(0, `<h3>Lecture summary</h3><p>${esc(note.summary)}</p>`)}${section(60, `<h3>Key points</h3><ul>${note.keyPoints.map(point => `<li>${highlighted(point, note.keywords, { firstOnly: true })}</li>`).join('')}</ul>`)}${section(120, `<h3>Key sentences</h3>${note.keySentences.map(sentence => `<blockquote>${esc(sentence)}</blockquote>`).join('')}`)}${section(180, `<h3>Review points</h3><ul>${note.reviewPoints.map(point => `<li>${esc(point)}</li>`).join('')}</ul>`)}`;
}
const noteVersionFields = ['title', 'summary', 'keyPoints', 'keySentences', 'keywords', 'keywordDetails', 'studyTips', 'reviewPoints', 'quizzes'];
function cloneNoteContent(note) { return Object.fromEntries(noteVersionFields.map(field => [field, structuredClone(note[field])])) ; }
function saveNoteVersion(note, language) { if (!note || !language) return; note.localizedVersions ||= {}; note.localizedVersions[language] = cloneNoteContent(note); }
function applyNoteVersion(note, language) { const version = note?.localizedVersions?.[language]; if (!version) return false; Object.assign(note, structuredClone(version), { contentLanguage: language }); return true; }
async function translateExistingSmartNote(sourceNote, targetLanguage, lecture) {
  const translationService = getTranslationService();
  const courseContext = { course: lecture?.course || sourceNote.course || '' };
  const glossary = await glossaryService.findRelevant(sourceNote.summary || (sourceNote.keyPoints || []).join(' '));
  
  const textUnits = [];
  const addUnit = (id, text) => {
    const clean = String(text || '').trim();
    textUnits.push({ id, text: clean || ' ' });
  };

  addUnit('title', sourceNote.title || lecture?.title || 'Smart Note');
  addUnit('summary', sourceNote.summary || '');
  
  (sourceNote.keyPoints || []).forEach((point, idx) => addUnit(`kp_${idx}`, point));
  (sourceNote.keySentences || []).forEach((sentence, idx) => addUnit(`ks_${idx}`, sentence));
  (sourceNote.studyTips || sourceNote.reviewPoints || []).forEach((tip, idx) => addUnit(`st_${idx}`, tip));
  (sourceNote.reviewPoints || []).forEach((rp, idx) => addUnit(`rp_${idx}`, rp));
  
  const keywords = Array.isArray(sourceNote.keywords) ? sourceNote.keywords : [];
  keywords.forEach((kw, idx) => {
    addUnit(`kw_${idx}`, kw);
    const detail = sourceNote.keywordDetails?.[kw] || {};
    addUnit(`kwd_meaning_${idx}`, detail.meaning || '');
    addUnit(`kwd_context_${idx}`, detail.context || '');
    addUnit(`kwd_major_${idx}`, detail.major || '');
    addUnit(`kwd_tip_${idx}`, detail.studyTip || '');
  });

  const quizzes = Array.isArray(sourceNote.quizzes) ? sourceNote.quizzes : [];
  quizzes.forEach((quiz, qIdx) => {
    addUnit(`quiz_q_${qIdx}`, quiz.question || '');
    addUnit(`quiz_exp_${qIdx}`, quiz.explanation || '');
    (quiz.options || []).forEach((opt, oIdx) => addUnit(`quiz_opt_${qIdx}_${oIdx}`, opt));
  });

  const translationMap = new Map();
  const chunkSize = 12;
  for (let i = 0; i < textUnits.length; i += chunkSize) {
    const chunk = textUnits.slice(i, i + chunkSize);
    try {
      const res = await translationService.translateSegments(
        chunk.map(u => ({ id: u.id, content: u.text })),
        targetLanguage,
        glossary,
        courseContext
      );
      if (Array.isArray(res?.segments)) {
        res.segments.forEach(seg => {
          const trans = targetLanguage === 'ko' ? (seg.correctedKorean || seg.translatedText) : (seg.translatedText || seg.correctedKorean);
          translationMap.set(seg.id, trans || seg.text);
        });
      }
    } catch (_) {
      for (const item of chunk) {
        try {
          const single = await translationService.translate(item.text, targetLanguage, glossary, courseContext);
          const trans = targetLanguage === 'ko' ? (single.correctedKorean || single.translatedText) : (single.translatedText || single.correctedKorean);
          translationMap.set(item.id, trans || item.text);
        } catch (_) {
          translationMap.set(item.id, item.text);
        }
      }
    }
  }

  const getTrans = (id, fallback = '') => (translationMap.get(id) || fallback).trim();

  const translatedKeyPoints = (sourceNote.keyPoints || []).map((orig, idx) => getTrans(`kp_${idx}`, orig));
  const translatedKeySentences = (sourceNote.keySentences || []).map((orig, idx) => getTrans(`ks_${idx}`, orig));
  const translatedStudyTips = (sourceNote.studyTips || sourceNote.reviewPoints || []).map((orig, idx) => getTrans(`st_${idx}`, orig));
  const translatedReviewPoints = (sourceNote.reviewPoints || []).map((orig, idx) => getTrans(`rp_${idx}`, orig));

  const translatedKeywords = [];
  const translatedKeywordDetails = {};
  keywords.forEach((kw, idx) => {
    const origDetail = sourceNote.keywordDetails?.[kw] || {};
    const transKw = getTrans(`kw_${idx}`, kw);
    translatedKeywords.push(transKw);
    translatedKeywordDetails[transKw] = {
      meaning: getTrans(`kwd_meaning_${idx}`, origDetail.meaning),
      context: getTrans(`kwd_context_${idx}`, origDetail.context),
      major: getTrans(`kwd_major_${idx}`, origDetail.major),
      studyTip: getTrans(`kwd_tip_${idx}`, origDetail.studyTip)
    };
  });

  const translatedQuizzes = quizzes.map((quiz, qIdx) => {
    const transQ = getTrans(`quiz_q_${qIdx}`, quiz.question);
    const transExp = getTrans(`quiz_exp_${qIdx}`, quiz.explanation);
    let transOptions;
    let transAnswer;

    if (quiz.type === 'OX') {
      transOptions = ['O', 'X'];
      transAnswer = quiz.answer === 'O' ? 'O' : 'X';
    } else {
      transOptions = (quiz.options || []).map((opt, oIdx) => getTrans(`quiz_opt_${qIdx}_${oIdx}`, opt));
      const origAnswerIndex = (quiz.options || []).indexOf(quiz.answer);
      transAnswer = (origAnswerIndex >= 0 && transOptions[origAnswerIndex]) ? transOptions[origAnswerIndex] : (transOptions[0] || quiz.answer);
    }

    return {
      id: quiz.id || `quiz-${Date.now()}-${qIdx}`,
      type: quiz.type,
      question: transQ,
      options: transOptions,
      answer: transAnswer,
      explanation: transExp
    };
  });

  return {
    ...sourceNote,
    title: getTrans('title', sourceNote.title),
    summary: getTrans('summary', sourceNote.summary),
    keyPoints: translatedKeyPoints,
    keySentences: translatedKeySentences,
    keywords: translatedKeywords,
    keywordDetails: translatedKeywordDetails,
    studyTips: translatedStudyTips,
    reviewPoints: translatedReviewPoints,
    quizzes: translatedQuizzes,
    contentLanguage: targetLanguage,
    sourceLanguage: sourceNote.sourceLanguage || sourceNote.contentLanguage || targetLanguage
  };
}

let activeLocalizationId = 0;
async function localizeSelectedNote(language, previousLanguage) {
  const lecture = noteLectures().find(item => item.id === noteState.selectedLectureId);
  const note = lecture && noteState.notes[lecture.id];
  if (!note || note.contentLanguage === language || applyNoteVersion(note, language)) {
    persistAppState();
    return;
  }
  if (noteState.localization.status === 'localizing' && noteState.localization.noteId === note.id && noteState.localization.language === language) return;
  
  saveNoteVersion(note, note.contentLanguage || note.sourceLanguage || previousLanguage || appLanguage);
  persistAppState();
  
  const currentRequestId = ++activeLocalizationId;
  noteState.localization = { status: 'localizing', noteId: note.id, language, error: '' };
  render();
  
  try {
    const localized = await translateExistingSmartNote(note, language, lecture);
    if (activeLocalizationId !== currentRequestId || appLanguage !== language) return;
    
    localized.course = lecture.course;
    localized.courseId = lecture.courseId || null;
    localized.reviewPoints = localized.studyTips || localized.reviewPoints || [];
    
    Object.assign(note, cloneNoteContent(localized), {
      contentLanguage: language,
      sourceLanguage: note.sourceLanguage || note.contentLanguage || language
    });
    saveNoteVersion(note, language);
    persistAppState();
    noteState.localization = { status: 'success', noteId: note.id, language, error: '' };
  } catch (error) {
    if (activeLocalizationId !== currentRequestId) return;
    noteState.localization = { status: 'error', noteId: note.id, language, error: error.message || 'Note translation failed.' };
  }
  render();
}
function noteQuizzes(note) { return (note.quizzes || []).map(quiz => { const selected = noteState.quizAnswers[quiz.id]; return `<section class="quiz-card"><span class="pill">${quiz.type === 'OX' ? 'O/X' : 'Multiple choice'}</span><h3>${quiz.question}</h3><div class="quiz-options">${quiz.options.map(option => `<button data-quiz-answer="${esc(option)}" data-quiz-id="${quiz.id}" class="${selected === option ? (selected === quiz.answer ? 'correct' : 'incorrect') : ''}">${option}</button>`).join('')}</div>${selected ? `<div class="quiz-feedback ${selected === quiz.answer ? 'correct' : 'incorrect'}"><strong>${selected === quiz.answer ? 'Correct!' : 'Not quite.'}</strong> Answer: ${quiz.answer}<br/>${quiz.explanation}</div>` : ''}</section>`; }).join(''); }
function renderNotes() {
  const lectures = noteLectures();
  const list = lectures.map(lecture => { const recording = recordings.find(item => item.id === lecture.id); const duration = recording?.durationMs ? formatDuration(recording.durationMs) : ''; const segments = recording?.transcriptSegments?.length ?? lecture.transcript.length; const note = noteState.notes[lecture.id]; return `<a class="review-lecture-card" data-route="/lectures/${encodeURIComponent(lecture.id)}" href="/lectures/${encodeURIComponent(lecture.id)}"><span class="note-icon">${icon('mic', { size: 'sm' })}</span><span><strong>${esc(lecture.title)}</strong><small>${esc(courseName(lecture.courseId, lecture.course))} · ${esc(lecture.date)}</small><small>${duration ? `${duration} · ` : ''}${segments} ${ui('transcript segments', '자막 구간')}${note ? ` · ${ui('Smart Note ready', 'Smart Note 준비됨')}` : ''}</small></span><span class="review-card-cta">${ui('Review', '복습하기')} →</span></a>`; }).join('');
  return `${topbar('Notes')}<main><div class="page-intro"><p class="tag">LECTURE LIBRARY</p><h2>${ui('Review your lectures in context.', '강의와 함께 복습하세요.')}</h2><p>${ui('Choose a saved lecture to listen again, follow timestamped captions, and review its Smart Note.', '저장된 강의를 선택해 다시 듣고, 시간별 자막과 Smart Note를 함께 복습하세요.')}</p></div><section class="lecture-review-library card"><div class="card-heading"><h2>${ui('Saved lectures', '저장된 강의')}</h2><span class="pill">${lectures.length}</span></div>${list || empty(ui('No recorded lectures', '저장된 강의가 없습니다'), ui('Finish a recording to start a review.', '녹음을 완료하면 이곳에서 강의를 복습할 수 있습니다.'))}</section></main>`;
}
async function handleNoteAction(action, element) {
  if (action === 'close-keyword') { document.querySelector('#keyword-popup')?.remove(); return; }
  if (action === 'select') { noteState.selectedLectureId = element.dataset.lectureId; noteState.editing = false; render(); return; }
  const lecture = noteLectures().find(item => item.id === noteState.selectedLectureId); const note = noteState.notes[lecture?.id];
  if (action === 'generate' && lecture) {
    if (!lecture.transcript.length) { noteState.error = appLanguage === 'ko' ? '요약할 강의 내용이 없습니다.' : 'There is no lecture content to summarize.'; render(); return; }
    if (noteState.generation.status === 'generating') return;
    const metric = { generationRequestedAt: performance.now(), geminiRequests: 0, cacheHit: false };
    noteState.generation = { status: 'generating', lectureId: lecture.id, error: '' }; noteState.error = ''; render();
    try {
      const transcriptSource = lecture.transcript.join(' ');
      const cacheKey = smartNoteCacheKey(lecture, appLanguage);
      const cached = smartNoteCache.get(cacheKey);
      const glossary = await glossaryService.findRelevant(transcriptSource);
      metric.transcriptPreparedAt = performance.now(); metric.input = measureSmartNoteInput(lecture, glossary); metric.cacheHit = Boolean(cached);
      let created;
      if (cached) created = structuredClone(cached);
      else {
        const generated = await noteGenerator.generate({ lecture, transcript: lecture.transcript, student, language: appLanguage, glossary });
        const { timing, ...note } = generated; created = note; metric.geminiRequests = 1; Object.assign(metric, timing || {});
        smartNoteCache.set(cacheKey, structuredClone(created));
      }
      created.course = lecture.course; created.courseId = lecture.courseId || null; created.generationVersion = 2; created.reviewPoints = created.studyTips || created.reviewPoints || []; if (!created.quizzes) created.quizzes = await quizGenerator.generate(created); created.contentLanguage = appLanguage; created.sourceLanguage = appLanguage; created.localizedVersions = {}; saveNoteVersion(created, appLanguage); noteState.notes[lecture.id] = created; noteState.quizAnswers = {}; metric.cacheSavedAt = performance.now(); noteState.revealLectureId = lecture.id; noteState.generation = { status: 'success', lectureId: lecture.id, error: '' };
    } catch (generationError) { noteState.generation = { status: 'error', lectureId: lecture.id, error: generationError.message || (appLanguage === 'ko' ? 'Smart Note를 생성할 수 없습니다.' : 'Smart Note could not be generated.') }; }
    render();
    if (noteState.generation.status === 'success') requestAnimationFrame(() => { metric.noteRenderedAt = performance.now(); recordSmartNoteMetric(metric); requestAnimationFrame(() => { noteState.revealLectureId = null; }); });
    return;
  }
  if (action === 'edit' && note) { noteState.editing = true; noteState.draft = { summary: note.summary, reviewPoints: [...note.reviewPoints] }; render(); return; }
  if (action === 'cancel') { noteState.editing = false; noteState.draft = null; render(); return; }
  if (action === 'save' && note) { note.summary = document.querySelector('#note-summary-edit').value.trim() || note.summary; note.reviewPoints = document.querySelector('#note-review-edit').value.split('\n').map(value => value.trim()).filter(Boolean); noteState.editing = false; noteState.draft = null; render(); return; }
  if (action === 'delete-lecture' && lecture && window.confirm(appLanguage === 'ko' ? '이 강의 녹음본을 삭제할까요? 녹음 기록, 자막 및 이 강의에서 생성된 Summary Note가 함께 삭제됩니다.' : 'Delete this lecture? Its recording, captions, and Summary Note will also be deleted.')) { const removed = noteState.notes[lecture.id]; recordings = recordings.filter(recording => recording.id !== lecture.id); delete noteState.notes[lecture.id]; (removed?.quizzes || []).forEach(quiz => delete noteState.quizAnswers[quiz.id]); noteState.selectedLectureId = null; noteState.editing = false; noteState.draft = null; noteState.generation = { status: 'idle', lectureId: null, error: '' }; audioStorage.deleteAudio(lecture.id).catch(() => {}); if (reviewState.lectureId === lecture.id) releaseReviewAudio(); persistAppState(); navigate('/'); return; }
  if (action === 'pdf' && note) downloadNotePdf(note);
}
function openKeywordPopup(keyword, noteOverride = null) { const selected = noteOverride || noteState.notes[noteState.selectedLectureId]; const detail = selected?.keywordDetails?.[keyword]; if (!detail) return; document.querySelector('#keyword-popup')?.remove(); document.body.insertAdjacentHTML('beforeend', localizeUi(`<div id="keyword-popup" class="keyword-modal" role="dialog" aria-modal="true"><div class="keyword-dialog"><button class="modal-close" data-note-action="close-keyword" aria-label="Close">${icon('x', { size: 'md' })}</button><p class="tag">KEYWORD GUIDE</p><h2>${esc(keyword)}</h2><dl><div><dt>Basic meaning</dt><dd>${esc(detail.meaning)}</dd></div><div><dt>In this lecture</dt><dd>${esc(detail.context)}</dd></div><div><dt>For your major</dt><dd>${esc(detail.major)}</dd></div><div><dt>Study tip</dt><dd>${esc(detail.studyTip)}</dd></div></dl></div></div>`)); }
function submitQuizAnswer(quizId, answer) { noteState.quizAnswers[quizId] = answer; render(); }
let pdfExportInProgress = false;
let activePdfObjectUrl = null;
function cleanupPdfObjectUrl() {
  if (activePdfObjectUrl) {
    try { URL.revokeObjectURL(activePdfObjectUrl); } catch (_) {}
    activePdfObjectUrl = null;
  }
}
window.addEventListener('beforeunload', cleanupPdfObjectUrl);

function pdfLines(ctx, value, maxWidth) {
  const text = String(value || '—'); const lines = []; let line = '';
  for (const character of Array.from(text)) { const next = line + character; if (line && ctx.measureText(next).width > maxWidth) { lines.push(line.trimEnd()); line = character === ' ' ? '' : character; } else line = next; }
  if (line || !lines.length) lines.push(line.trimEnd());
  return lines;
}
function smartNotePdfPages(note) {
  const width = 595, height = 842, margin = 42, scale = 2, lineHeight = 17, bottom = height - 42; const pages = [];
  let canvas, ctx, y, pageNumber = 0;
  const newPage = () => { canvas = document.createElement('canvas'); canvas.width = width * scale; canvas.height = height * scale; ctx = canvas.getContext('2d'); ctx.scale(scale, scale); ctx.fillStyle = '#ffffff'; ctx.fillRect(0, 0, width, height); ctx.fillStyle = '#17233e'; y = margin; pageNumber += 1; };
  const finishPage = () => { ctx.font = '9px Arial, "Malgun Gothic", sans-serif'; ctx.fillStyle = '#64748b'; ctx.fillText(`Study Mate · ${pageNumber}`, margin, height - 20); pages.push(canvas); };
  const space = needed => { if (y + needed > bottom) { finishPage(); newPage(); } };
  const text = (value, { font = '12px "Malgun Gothic", "Noto Sans KR", Arial, sans-serif', color = '#17233e', indent = 0, gap = 0 } = {}) => { ctx.font = font; ctx.fillStyle = color; const lines = pdfLines(ctx, value, width - margin * 2 - indent); lines.forEach(line => { space(lineHeight); ctx.fillText(line, margin + indent, y); y += lineHeight; }); y += gap; };
  const heading = value => { space(38); ctx.fillStyle = '#315efb'; ctx.fillRect(margin, y - 12, 4, 22); text(value, { font: '700 15px "Malgun Gothic", "Noto Sans KR", Arial, sans-serif', indent: 12, gap: 8 }); };
  const bullets = values => (values?.length ? values : ['—']).forEach(value => { ctx.font = '12px "Malgun Gothic", "Noto Sans KR", Arial, sans-serif'; const lines = pdfLines(ctx, value, width - margin * 2 - 17); lines.forEach((line, index) => { space(lineHeight); if (index === 0) { ctx.fillStyle = '#315efb'; ctx.fillText('•', margin, y); } ctx.fillStyle = '#17233e'; ctx.fillText(line, margin + 17, y); y += lineHeight; }); y += 3; });
  newPage();
  text('STUDY MATE · SMART NOTE', { font: '700 10px Arial, "Malgun Gothic", sans-serif', color: '#315efb', gap: 9 });
  text(note.title || 'Smart Note', { font: '700 24px "Malgun Gothic", "Noto Sans KR", Arial, sans-serif', gap: 5 });
  text([note.course, note.date].filter(Boolean).join(' · '), { font: '11px "Malgun Gothic", "Noto Sans KR", Arial, sans-serif', color: '#64748b', gap: 10 });
  heading(ui('Lecture summary', '강의 요약')); text(note.summary || '—', { gap: 7 });
  heading(ui('Key points', '주요 내용')); bullets(note.keyPoints);
  heading(ui('Key sentences', '주요 문장')); bullets(note.keySentences);
  heading(ui('Study tips', '학습 팁')); bullets(note.studyTips || note.reviewPoints);
  heading(ui('Review points', '복습 포인트')); bullets(note.reviewPoints);
  heading(ui('Review quiz', '복습 퀴즈'));
  (note.quizzes?.length ? note.quizzes : [{ question: '—', options: [], answer: '', explanation: '' }]).forEach((quiz, index) => { text(`${index + 1}. ${quiz.question || '—'}`, { font: '700 12px "Malgun Gothic", "Noto Sans KR", Arial, sans-serif', gap: 2 }); bullets(quiz.options); text(`${ui('Answer', '정답')}: ${quiz.answer || '—'}`, { font: '11px "Malgun Gothic", "Noto Sans KR", Arial, sans-serif', color: '#315efb', gap: 2 }); text(`${ui('Explanation', '해설')}: ${quiz.explanation || '—'}`, { font: '11px "Malgun Gothic", "Noto Sans KR", Arial, sans-serif', gap: 8 }); });
  heading(ui('Keywords', '핵심 키워드')); text((note.keywords || []).join(', ') || '—'); finishPage();
  return pages;
}
function bytesFromDataUrl(dataUrl) { return Uint8Array.from(atob(dataUrl.split(',')[1]), character => character.charCodeAt(0)); }
function concatPdfBytes(parts) { const length = parts.reduce((total, part) => total + part.length, 0); const result = new Uint8Array(length); let offset = 0; parts.forEach(part => { result.set(part, offset); offset += part.length; }); return result; }
function smartNotePdfBlob(pages) {
  const encoder = new TextEncoder(); const parts = []; const offsets = []; let size = 0; const add = value => { const bytes = typeof value === 'string' ? encoder.encode(value) : value; parts.push(bytes); size += bytes.length; };
  const pageObjects = pages.map((_, index) => 3 + index * 3); const contentObjects = pageObjects.map(value => value + 1); const imageObjects = pageObjects.map(value => value + 2); const objectCount = 2 + pages.length * 3;
  const object = (number, body) => { offsets[number] = size; add(`${number} 0 obj\n${body}\nendobj\n`); };
  add('%PDF-1.4\n'); object(1, '<< /Type /Catalog /Pages 2 0 R >>'); object(2, `<< /Type /Pages /Kids [${pageObjects.map(number => `${number} 0 R`).join(' ')}] /Count ${pages.length} >>`);
  pages.forEach((page, index) => { const imageBytes = bytesFromDataUrl(page.toDataURL('image/jpeg', 0.92)); const content = `q\n595 0 0 842 0 0 cm\n/Im${index + 1} Do\nQ\n`; object(pageObjects[index], `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Resources << /XObject << /Im${index + 1} ${imageObjects[index]} 0 R >> >> /Contents ${contentObjects[index]} 0 R >>`); object(contentObjects[index], `<< /Length ${encoder.encode(content).length} >>\nstream\n${content}endstream`); offsets[imageObjects[index]] = size; add(`${imageObjects[index]} 0 obj\n<< /Type /XObject /Subtype /Image /Width ${page.width} /Height ${page.height} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ${imageBytes.length} >>\nstream\n`); add(imageBytes); add('\nendstream\nendobj\n'); });
  const xrefOffset = size; add(`xref\n0 ${objectCount + 1}\n0000000000 65535 f \n`); for (let index = 1; index <= objectCount; index += 1) add(`${String(offsets[index]).padStart(10, '0')} 00000 n \n`); add(`trailer\n<< /Size ${objectCount + 1} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF`);
  return new Blob([concatPdfBytes(parts)], { type: 'application/pdf' });
}
function setPdfButtonState(button, busy) { if (!button) return; button.dataset.pdfLabel ||= button.textContent; button.disabled = busy; button.textContent = busy ? ui('Generating PDF…', 'PDF 생성 중…') : button.dataset.pdfLabel; }
function isMobileDevice() {
  if (typeof navigator === 'undefined') return false;
  const ua = navigator.userAgent || '';
  const touchPoints = Number(navigator.maxTouchPoints || 0);
  const mobileUa = /Android|webOS|iPhone|iPad|iPod|BlackBerry|IEMobile|Opera Mini|Mobile/i.test(ua);
  const isIpadOs = /Macintosh/i.test(ua) && touchPoints > 1;
  return mobileUa || isIpadOs || (window.matchMedia?.('(pointer: coarse)').matches && window.innerWidth <= 1024);
}
function triggerBlobDownload(blob, filename) {
  cleanupPdfObjectUrl();
  const url = URL.createObjectURL(blob);
  activePdfObjectUrl = url;
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  link.style.display = 'none';
  document.body.append(link);
  link.click();
  link.remove();
}
async function downloadNotePdf(note, button) {
  if (pdfExportInProgress || !note) return;
  button ||= document.activeElement?.matches('button') ? document.activeElement : null;
  const isMobile = isMobileDevice();
  pdfExportInProgress = true; setPdfButtonState(button, true);
  try {
    if (document.fonts?.ready) await document.fonts.ready;
    const blob = smartNotePdfBlob(smartNotePdfPages(note));
    const filename = `${String(note.title || 'smart-note').replace(/[\\/:*?"<>|]/g, '_')}.pdf`;
    if (isMobile && typeof navigator !== 'undefined' && typeof navigator.share === 'function') {
      let file = null;
      try {
        file = new File([blob], filename, { type: 'application/pdf' });
      } catch (_) {}
      const canShareFiles = file && typeof navigator.canShare === 'function' ? navigator.canShare({ files: [file] }) : false;
      if (canShareFiles) {
        try {
          await navigator.share({
            files: [file],
            title: note.title || 'Smart Note'
          });
          return;
        } catch (shareError) {
          if (shareError?.name === 'AbortError') {
            return;
          }
          triggerBlobDownload(blob, filename);
          return;
        }
      }
    }
    triggerBlobDownload(blob, filename);
  } catch (_) {
    window.alert(ui('The PDF could not be created. Please try again.', 'PDF를 만들지 못했습니다. 다시 시도하세요.'));
  } finally {
    pdfExportInProgress = false; setPdfButtonState(button, false);
  }
}
function schedule() { return renderSchedule(); }
function scheduleDateLabel(date) { const value = new Date(`${date}T12:00:00`); return `${value.toLocaleString('en', { month: 'short' })} ${value.getDate()}`; }
function calendarGrid(month, items) { const start = new Date(`${month}-01T12:00:00`); const days = new Date(start.getFullYear(), start.getMonth() + 1, 0).getDate(); const leading = start.getDay(); const marked = new Set(items.filter(item => item.date?.startsWith(month)).map(item => Number(item.date.slice(-2)))); return { title: start.toLocaleString(appLanguage === 'ko' ? 'ko-KR' : 'en', { month: 'long', year: 'numeric' }), cells: `${Array.from({ length: leading }, () => '<span></span>').join('')}${Array.from({ length: days }, (_, index) => { const day = index + 1; return `<span class="${marked.has(day) ? 'has-event' : ''}">${day}${marked.has(day) ? '<i></i>' : ''}</span>`; }).join('')}` }; }
function scheduleForm(event = {}) { return `<section class="card top-space"><h2>${scheduleEditor.mode === 'edit' ? ui('Edit event', '일정 수정') : ui('Add event', '일정 추가')}</h2>${scheduleEditor.error ? `<p class="note-error">${esc(scheduleEditor.error)}</p>` : ''}<div class="grid two"><label>${ui('Title', '제목')}<input id="event-title" value="${esc(event.title || '')}"/></label><label>${ui('Date', '날짜')}<input id="event-date" type="date" value="${esc(event.date || '')}"/></label><label>${ui('Time', '시간')}<input id="event-time" type="time" value="${esc(event.time || '')}"/></label><label>${ui('Type', '일정 종류')}<select id="event-type">${[['exam','Exam'],['assignment','Assignment'],['personal','Personal'],['other','Other']].map(([value,label]) => `<option value="${value}" ${event.eventType === value ? 'selected' : ''}>${appLanguage === 'ko' ? ({exam:'시험',assignment:'과제',personal:'개인 일정',other:'기타'}[value]) : label}</option>`).join('')}</select></label><label>${ui('Related course', '관련 과목')}<select id="event-course"><option value="">${ui('None', '없음')}</option>${courses.map(course => `<option value="${course.id}" ${event.courseId === course.id ? 'selected' : ''}>${esc(course.name)}</option>`).join('')}</select></label></div><div class="candidate-actions"><button class="button" data-schedule-action="save-manual">${ui('Save', '저장')}</button><button class="button secondary" data-schedule-action="cancel-manual">${ui('Cancel', '취소')}</button></div></section>`; }
function renderSchedule() {
  const confirmed = scheduleState.items.filter(item => item.status === 'confirmed'); const candidates = scheduleState.candidates;
  const grid = calendarGrid(scheduleState.calendarMonth || new Date().toISOString().slice(0, 7), confirmed);
  const upcoming = confirmed.map(item => `<div class="event-row"><span class="date-tile blue">${scheduleDateLabel(item.date).split(' ')[0]}<small>${scheduleDateLabel(item.date).split(' ')[1]}</small></span><span><strong>${esc(item.title)}</strong><small>${esc([item.time, courseName(item.courseId, item.relatedLecture), item.reminders?.length ? item.reminders.join(', ') : ui('No reminders', '알림 없음')].filter(Boolean).join(' · '))}</small></span><button data-schedule-action="edit-event" data-schedule-id="${item.id}">${ui('Edit', '수정')}</button><button data-schedule-action="delete-event" data-schedule-id="${item.id}">${ui('Delete', '삭제')}</button><button data-schedule-action="reminder" data-schedule-id="${item.id}">🔔</button></div>`).join('') || empty('No calendar events', 'Confirm a suggestion to add it to your calendar.');
  const candidateHtml = scheduleState.extraction?.status === 'extracting' ? `<div class="note-create" aria-live="polite"><span class="note-icon">${icon('loader', { size: 'md', className: 'icon-spin' })}</span><p>${ui('Extracting schedule candidates…', '일정 후보를 추출하는 중…')}</p></div>` : candidates.length ? candidates.map(item => `<div class="candidate-card" data-candidate-id="${item.id}"><div><span class="pill warm">${item.resolutionStatus === 'AMBIGUOUS' ? ui('Date needs review', '날짜 확인 필요') : ui('Needs your review', '확인 필요')}</span><h3>${esc(item.title)}</h3><p>${ui('From', '출처')} ${esc(item.relatedLecture)}${item.sourceTimestamp !== null && item.sourceTimestamp !== undefined ? ` · ${formatDuration(item.sourceTimestamp)}` : ''}</p>${item.sourceText ? `<p class="candidate-evidence">${esc(item.sourceText)}</p>` : ''}${item.originalDateExpression ? `<p>${ui('Date expression', '날짜 표현')}: ${esc(item.originalDateExpression)}</p>` : ''}</div><label>${ui('Title', '제목')}<input data-candidate-field="title" value="${esc(item.title)}"/></label><label>${ui('Date', '날짜')}<input type="date" data-candidate-field="date" value="${esc(item.date || '')}"/></label><label>${ui('Time', '시간')}<input type="time" data-candidate-field="time" value="${esc(item.time || '')}"/></label>${item.validationError ? `<p class="note-error">${esc(item.validationError)}</p>` : ''}<div class="candidate-actions"><button class="button" data-schedule-action="confirm" data-candidate-id="${item.id}">${ui('Add to calendar', '캘린더에 추가')}</button><button class="button secondary" data-schedule-action="cancel" data-candidate-id="${item.id}">${ui('Cancel', '취소')}</button></div></div>`).join('') : `${scheduleState.extraction?.error ? `<p class="note-error">${esc(scheduleState.extraction.error)}</p>` : ''}${empty(ui('No pending suggestions', '대기 중인 후보가 없습니다'), ui('Extract possible dates from a selected lecture, then review them before adding anything.', '강의를 선택한 뒤 가능한 날짜를 추출하고, 직접 확인한 후 캘린더에 추가하세요.'))}`;
  const form = scheduleEditor.mode ? scheduleForm(scheduleState.items.find(item => item.id === scheduleEditor.id)) : '';
  return `${topbar('Schedule')}<main><div class="page-intro split"><div><p class="tag">YOUR CALENDAR · PHASE 4</p><h2>Plan, confirm, and remember.</h2><p>Schedule suggestions are never added automatically. Review every date first.</p></div><div class="page-actions"><button class="button secondary" data-schedule-action="add-event">+ ${ui('Add event', '일정 추가')}</button><button class="button" data-schedule-action="extract" ${scheduleState.extraction?.status === 'extracting' ? 'disabled' : ''}>Extract schedule suggestions</button></div></div><section class="calendar card"><div class="calendar-head"><button data-schedule-action="month" data-offset="-1" aria-label="${ui('Previous month', '이전 달')}">${icon('chevron-left', { size: 'sm' })}</button><h2>${grid.title}</h2><button data-schedule-action="month" data-offset="1" aria-label="${ui('Next month', '다음 달')}">${icon('chevron-right', { size: 'sm' })}</button></div><div class="weekdays">${['Sun','Mon','Tue','Wed','Thu','Fri','Sat'].map(day => `<span>${weekdayLabel(day)}</span>`).join('')}</div><div class="dates">${grid.cells}</div></section><div class="grid two top-space"><div>${card('Upcoming schedule', upcoming)}</div><div>${card('Schedule candidates', candidateHtml)}</div></div>${form}<section class="reminder-bar"><div><strong>Reminder permission: ${scheduleState.notification}</strong><p>Set reminders at 5 and 3 days before confirmed events.</p></div><button class="button secondary" data-schedule-action="notification">Enable reminders</button></section></main>`;
}
async function handleScheduleAction(action, element) {
  if (action === 'extract') { if (scheduleState.extraction?.status === 'extracting') return; const lectures = noteLectures(); const extractable = lectures.map(lecture => ({ lecture, source: lecture.finalizedTranscript?.length ? lecture.finalizedTranscript : lecture.transcript })).filter(item => item.source?.length); if (!extractable.length) { scheduleState.candidates = []; scheduleState.extraction = { status: 'error', error: appLanguage === 'ko' ? '일정을 추출할 최종 자막이 없습니다.' : 'There is no final transcript to extract.' }; render(); return; } scheduleState.extraction = { status: 'extracting', error: '' }; render(); try { const extracted = (await Promise.all(extractable.map(({ lecture, source }) => scheduleExtractor.extract(source, lecture)))).flat(); scheduleState.candidates = filterPendingScheduleCandidates(extracted, scheduleState.items, scheduleState.dismissedCandidateIds); scheduleState.extraction = { status: 'success', error: '' }; } catch (error) { scheduleState.candidates = []; scheduleState.extraction = { status: 'error', error: error.message || 'Schedule extraction failed.' }; } render(); return; }
  if (action === 'confirm') { const card = document.querySelector(`[data-candidate-id="${element.dataset.candidateId}"]`); const candidate = scheduleState.candidates.find(item => item.id === element.dataset.candidateId); if (!candidate || !card) return; candidate.title = card.querySelector('[data-candidate-field="title"]').value.trim(); candidate.date = card.querySelector('[data-candidate-field="date"]').value; candidate.time = card.querySelector('[data-candidate-field="time"]').value; if (!candidate.title || !/^\d{4}-\d{2}-\d{2}$/.test(candidate.date)) { candidate.validationError = ui('Enter a title and a valid date before adding this candidate.', '제목과 올바른 날짜를 입력한 후 추가하세요.'); render(); return; } const calendarEvent = { ...candidate, id: `event-${crypto.randomUUID?.() || Date.now()}`, sourceCandidateId: candidate.id, candidateFingerprint: candidate.candidateFingerprint || candidate.id, sourceLectureId: candidate.sourceLectureId || null, sourceSegmentId: candidate.sourceSegmentId || null, courseId: noteLectures().find(item => item.id === candidate.sourceLectureId)?.courseId || null, status: 'confirmed', source: 'corrected-transcript', reminders: ['5 days', '3 days'] }; scheduleState.items.push(calendarEvent); scheduleState.calendarMonth = calendarEvent.date.slice(0, 7); scheduleState.candidates = scheduleState.candidates.filter(item => item.id !== candidate.id); render(); return; }
  if (action === 'cancel') { const candidate = scheduleState.candidates.find(item => item.id === element.dataset.candidateId); if (candidate?.candidateFingerprint || candidate?.id) scheduleState.dismissedCandidateIds = [...new Set([...scheduleState.dismissedCandidateIds, candidate.candidateFingerprint || candidate.id])]; scheduleState.candidates = scheduleState.candidates.filter(item => item.id !== element.dataset.candidateId); render(); return; }
  if (action === 'reminder') { const item = scheduleState.items.find(entry => entry.id === element.dataset.scheduleId); if (item) { item.reminders = item.reminders.length ? [] : ['5 days', '3 days']; render(); } return; }
  if (action === 'month') { const month = new Date(`${scheduleState.calendarMonth || new Date().toISOString().slice(0, 7)}-01T12:00:00`); month.setMonth(month.getMonth() + Number(element.dataset.offset || 0)); scheduleState.calendarMonth = month.toISOString().slice(0, 7); render(); return; }
  if (action === 'add-event') { scheduleEditor = { mode: 'add', id: null, error: '' }; render(); return; }
  if (action === 'edit-event') { scheduleEditor = { mode: 'edit', id: element.dataset.scheduleId, error: '' }; render(); return; }
  if (action === 'cancel-manual') { scheduleEditor = { mode: null, id: null, error: '' }; render(); return; }
  if (action === 'delete-event') { const item = scheduleState.items.find(event => event.id === element.dataset.scheduleId); if (!item || !window.confirm(ui(`Delete ${item.title}?`, `${item.title} 일정을 삭제할까요?`))) return; scheduleState.items = scheduleState.items.filter(event => event.id !== item.id); render(); return; }
  if (action === 'save-manual') { const title = document.querySelector('#event-title')?.value.trim(); const date = document.querySelector('#event-date')?.value; const time = document.querySelector('#event-time')?.value || ''; const eventType = document.querySelector('#event-type')?.value || 'other'; const courseId = document.querySelector('#event-course')?.value || null; if (!title || !date) { scheduleEditor.error = ui('Title and date are required.', '제목과 날짜를 입력하세요.'); render(); return; } const event = { id: scheduleEditor.mode === 'edit' ? scheduleEditor.id : `event-${crypto.randomUUID?.() || Date.now()}`, title, date, time, eventType, courseId, relatedLecture: courseName(courseId, ''), status: 'confirmed', source: 'manual', reminders: scheduleEditor.mode === 'edit' ? (scheduleState.items.find(item => item.id === scheduleEditor.id)?.reminders || []) : [] }; scheduleState.items = scheduleEditor.mode === 'edit' ? scheduleState.items.map(item => item.id === event.id ? event : item) : [...scheduleState.items, event]; scheduleState.calendarMonth = date.slice(0, 7); scheduleEditor = { mode: null, id: null, error: '' }; render(); return; }
  if (action === 'notification') { try { scheduleState.notification = await notificationService.requestPermission(); } catch (_) { scheduleState.notification = 'request failed'; } render(); }
}
function board() { return renderBoard(); }
function boardCategories() { return ['All', 'Course question', 'Major question', 'Career / academic advice']; }
function isBoardOwner(author) { return author === student.name; }
function boardMessage() { return boardState.error ? `<p class="board-error" role="alert">${esc(boardState.error)}</p>` : ''; }
function boardPostForm(post = {}, editing = false) {
  const categories = boardCategories().slice(1);
  return `<section class="card board-compose"><label>${ui('Title', '제목')}<input id="post-title" value="${esc(post.title || '')}" placeholder="${ui('What would you like to ask?', '무엇을 질문하고 싶나요?')}"/></label><label>${ui('Category', '카테고리')}<select id="post-category">${categories.map(category => `<option value="${category}" ${category === post.category ? 'selected' : ''}>${ui(category, category === 'Course question' ? '수업 질문' : category === 'Major question' ? '전공 질문' : '진로 / 학업 상담')}</option>`).join('')}</select></label><label>${ui('Content', '내용')}<textarea id="post-body" placeholder="${ui('Add context, what you tried, and your question.', '상황, 시도한 내용, 질문을 적어 주세요.')}">${esc(post.body || '')}</textarea></label>${boardMessage()}<div><button class="button secondary" data-board-action="${editing ? 'cancel-post-edit' : 'cancel-compose'}">${ui('Cancel', '취소')}</button><button class="button" data-board-action="${editing ? 'save-post-edit' : 'publish'}">${ui(editing ? 'Save changes' : 'Publish post', editing ? '수정 저장' : '게시글 등록')}</button></div></section>`;
}
function renderBoard() {
  const categories = boardCategories(); const query = boardState.filter.toLowerCase(); const posts = boardState.posts.filter(post => (boardState.category === 'All' || post.category === boardState.category) && `${post.title} ${post.body}`.toLowerCase().includes(query)); const selected = boardState.posts.find(post => post.id === boardState.selectedId);
  const categoryLabel = category => ui(category, category === 'All' ? '전체' : category === 'Course question' ? '수업 질문' : category === 'Major question' ? '전공 질문' : '진로 / 학업 상담');
  const statusLabel = status => ui(status, status === 'Answered' ? '답변 완료' : '답변 대기');
  const tools = `<div class="board-tools"><input id="board-search" aria-label="${ui('Search board', '게시판 검색')}" placeholder="${ui('Search posts', '게시글 검색')}" value="${esc(boardState.filter)}"/><select id="board-category" aria-label="${ui('Board category', '게시판 카테고리')}">${categories.map(category => `<option value="${category}" ${category === boardState.category ? 'selected' : ''}>${categoryLabel(category)}</option>`).join('')}</select><button class="button secondary" data-board-action="filter">${ui('Search', '검색')}</button></div>`;
  if (boardState.composing) return `${topbar('Board')}<main><div class="page-intro"><p class="tag">STUDENT COMMUNITY</p><h2>${ui('Write a post', '게시글 작성')}</h2><p>${ui('Ask a clear study question so classmates can help.', '명확한 학습 질문을 남겨 동료 학생의 도움을 받아 보세요.')}</p></div>${boardPostForm()}</main>`;
  if (selected) {
    const comments = Array.isArray(selected.comments) ? selected.comments : []; const editingPost = boardState.editingPostId === selected.id && isBoardOwner(selected.author);
    const commentMarkup = comments.map((comment, index) => {
      const editable = boardState.editingCommentIndex === index && isBoardOwner(comment.author);
      const actions = isBoardOwner(comment.author) ? `<div class="comment-actions"><button data-board-action="edit-comment" data-comment-index="${index}">${ui('Edit', '수정')}</button><button class="destructive" data-board-action="delete-comment" data-comment-index="${index}">${ui('Delete', '삭제')}</button></div>` : '';
      return `<div class="comment"><strong>${esc(comment.author)}</strong>${editable ? `<textarea id="comment-edit-${index}" aria-label="${ui('Edit comment', '댓글 수정')}">${esc(comment.body || '')}</textarea><div class="comment-edit-actions"><button class="button secondary" data-board-action="cancel-comment-edit">${ui('Cancel', '취소')}</button><button class="button" data-board-action="save-comment-edit" data-comment-index="${index}">${ui('Save', '저장')}</button></div>${boardMessage()}` : `<p>${esc(comment.body || '')}</p>${actions}`}</div>`;
    }).join('') || empty(ui('No comments yet', '댓글이 없습니다'), ui('Start the conversation with a helpful reply.', '첫 댓글로 대화를 시작해 보세요.'));
    const postActions = isBoardOwner(selected.author) && !editingPost ? `<div class="post-actions"><button class="button secondary" data-board-action="edit-post">${ui('Edit', '수정')}</button><button class="button danger" data-board-action="delete-post">${ui('Delete', '삭제')}</button></div>` : '';
    const postContent = editingPost ? boardPostForm(selected, true) : `<section class="card post-detail"><div class="post-detail-head"><div><span class="pill ${selected.status === 'Answered' ? 'success' : 'warm'}">${statusLabel(selected.status)}</span><h2>${esc(selected.title)}</h2><p class="post-meta">${categoryLabel(selected.category)} · ${esc(selected.author)}</p></div>${postActions}</div><p class="post-body">${esc(selected.body)}</p><section class="comments"><h3>${ui('Comments', '댓글')} (${comments.length})</h3>${commentMarkup}<div class="comment-form"><input id="comment-body" placeholder="${ui('Write a comment', '댓글을 입력하세요')}"/><button class="button" data-board-action="comment">${ui('Comment', '댓글 등록')}</button></div></section></section>`;
    return `${topbar('Board')}<main><button class="back-link" data-board-action="back">${icon('arrow-left', { size: 'sm' })} <span>${ui('All posts', '전체 게시글')}</span></button>${postContent}</main>`;
  }
  const list = posts.map(post => `<button class="board-post" data-board-action="open" data-post-id="${post.id}"><span class="post-icon">${icon('message-square', { size: 'sm' })}</span><div><span class="pill ${post.status === 'Answered' ? 'success' : 'warm'}">${statusLabel(post.status)}</span><h3>${esc(post.title)}</h3><p>${categoryLabel(post.category)} · ${esc(post.author)} · ${(post.comments || []).length} ${ui('replies', '댓글')}</p></div><b class="row-chevron">${icon('chevron-right', { size: 'sm' })}</b></button>`).join('') || empty(ui('No posts found', '게시글이 없습니다'), ui('Try another keyword or category.', '다른 검색어 또는 카테고리를 시도해 보세요.'));
  return `${topbar('Board')}<main><div class="page-intro split"><div><p class="tag">STUDENT COMMUNITY · PHASE 4</p><h2>${ui('Learn better, together.', '함께 더 잘 배워요.')}</h2><p>${ui('Ask questions, share ideas, and find study partners.', '질문하고, 아이디어를 나누고, 함께 공부할 친구를 찾아보세요.')}</p></div><button class="button" data-board-action="compose">+ ${ui('Write a post', '게시글 작성')}</button></div>${tools}<section class="card board-list live">${list}</section></main>`;
}
function handleBoardAction(action, element) {
  const selected = () => boardState.posts.find(item => item.id === boardState.selectedId);
  const resetError = () => { boardState.error = ''; };
  if (action === 'filter') { boardState.filter = document.querySelector('#board-search').value; boardState.category = document.querySelector('#board-category').value; render(); return; }
  if (action === 'compose') { resetError(); boardState.composing = true; render(); return; }
  if (action === 'cancel-compose') { resetError(); boardState.composing = false; render(); return; }
  if (action === 'publish' || action === 'save-post-edit') { const title = document.querySelector('#post-title').value.trim(); const body = document.querySelector('#post-body').value.trim(); if (!title || !body) { boardState.error = ui('Enter both a title and content.', '제목과 내용을 모두 입력해 주세요.'); render(); return; } const category = document.querySelector('#post-category').value; if (action === 'publish') { boardState.posts.unshift({ id: `post-${crypto.randomUUID?.() || Date.now()}`, title, body, category, author: student.name, status: 'Waiting', comments: [], createdAt: new Date().toISOString() }); boardState.composing = false; } else { const post = selected(); if (!post || !isBoardOwner(post.author)) return; Object.assign(post, { title, body, category, updatedAt: new Date().toISOString() }); boardState.editingPostId = null; } resetError(); render(); return; }
  if (action === 'open') { resetError(); boardState.selectedId = element.dataset.postId; render(); return; }
  if (action === 'back') { resetError(); boardState.selectedId = null; boardState.editingPostId = null; boardState.editingCommentIndex = null; render(); return; }
  if (action === 'edit-post') { const post = selected(); if (post && isBoardOwner(post.author)) { resetError(); boardState.editingPostId = post.id; render(); } return; }
  if (action === 'cancel-post-edit') { resetError(); boardState.editingPostId = null; render(); return; }
  if (action === 'delete-post') { const post = selected(); if (!post || !isBoardOwner(post.author) || !confirm(ui('Delete this post and its comments?', '이 게시글과 댓글을 삭제할까요?'))) return; boardState.posts = boardState.posts.filter(item => item.id !== post.id); boardState.selectedId = null; boardState.editingPostId = null; boardState.editingCommentIndex = null; resetError(); render(); return; }
  if (action === 'comment') { const post = selected(); const body = document.querySelector('#comment-body').value.trim(); if (post && body) { post.comments ||= []; post.comments.push({ id: `comment-${crypto.randomUUID?.() || Date.now()}`, author: student.name, body, createdAt: new Date().toISOString() }); post.status = 'Answered'; resetError(); render(); } return; }
  const index = Number(element.dataset.commentIndex); const post = selected(); const comment = post?.comments?.[index];
  if (action === 'edit-comment') { if (comment && isBoardOwner(comment.author)) { resetError(); boardState.editingCommentIndex = index; render(); } return; }
  if (action === 'cancel-comment-edit') { resetError(); boardState.editingCommentIndex = null; render(); return; }
  if (action === 'save-comment-edit') { const body = document.querySelector(`#comment-edit-${index}`)?.value.trim(); if (!comment || !isBoardOwner(comment.author)) return; if (!body) { boardState.error = ui('Enter a comment before saving.', '댓글 내용을 입력해 주세요.'); render(); return; } Object.assign(comment, { body, updatedAt: new Date().toISOString() }); boardState.editingCommentIndex = null; resetError(); render(); return; }
  if (action === 'delete-comment') { if (!comment || !isBoardOwner(comment.author) || !confirm(ui('Delete this comment?', '이 댓글을 삭제할까요?'))) return; post.comments.splice(index, 1); boardState.editingCommentIndex = null; resetError(); render(); }
}
function chat() { return renderChat(); }
function isPublicOpportunityQuestion(prompt) { return /청년.?정책|지원.?사업|공모전|대외활동|봉사|장학금|정책.?추천|youth policy|scholarship|volunteer|contest|public support/i.test(prompt); }
function chatIntent(prompt) { const q=String(prompt).toLowerCase(); if (isPublicOpportunityQuestion(q)) return 'POLICY'; if (/일정|시험|과제|deadline|schedule/.test(q)) return 'SCHEDULE'; if (/과목|수업|강의 시간|course/.test(q)) return 'COURSE'; if (/노트|요약|note|summary/.test(q)) return 'NOTE'; if (/녹음|스마트 노트|일정 추출|record/.test(q)) return 'APP_HELP'; return 'GENERAL'; }
function localChatAnswer(intent) { if (intent==='SCHEDULE') { const items=scheduleState.items.filter(x=>x.status==='confirmed'); return items.length ? ui(`Your next schedule is ${items[0].title} on ${items[0].date}.`, `다음 일정은 ${items[0].date} ${items[0].title}입니다.`) : ui('There are no confirmed schedules yet.', '확정된 일정이 없습니다.'); } if (intent==='COURSE') return ui(`Your current courses are ${courses.map(x=>x.name).join(', ')}.`, `현재 수강 과목은 ${courses.map(x=>x.name).join(', ')}입니다.`); if (intent==='NOTE') { const note=Object.values(noteState.notes)[0]; return note ? ui(`Your latest Smart Note is ${note.title}.`, `최근 Smart Note는 ${note.title}입니다.`) : ui('There is no saved Smart Note yet.', '저장된 Smart Note가 아직 없습니다.'); } if (intent==='APP_HELP') return ui('Open Lecture, choose Start recording, allow the microphone, then finish to save the transcript.', '강의 화면에서 녹음 시작을 누르고 마이크를 허용하세요. 종료하면 자막과 녹음이 저장됩니다.'); return ui('Hello! Ask me about your courses, schedule, notes, recording, or youth-policy recommendations.', '안녕하세요! 수강 과목, 일정, 노트, 녹음 방법 또는 청년정책 추천을 물어보세요.'); }
function policyStrategy(prompt) { const text = String(prompt || '').toLowerCase(); if (/전공|major|학과/.test(text)) return 'MAJOR'; if (/취업|career|진로|일자리/.test(text)) return 'CAREER'; if (/주거|housing/.test(text)) return 'HOUSING'; if (/교육|education|학비|장학/.test(text)) return 'EDUCATION'; return 'GENERAL'; }

const interestKeywordsMap = {
  CAREER: ['취업', '일자리', '채용', '인턴', '직무', 'career', 'job', 'employment'],
  HOUSING: ['주거', '주택', '월세', '전세', '임대', 'housing', 'rent'],
  FINANCIAL_SUPPORT: ['장학', '장학금', '금융', '지원금', '수당', '대출', 'financial', 'scholarship'],
  STARTUP: ['창업', '사업', '스타트업', '기업가', 'venture', 'startup'],
  EDUCATION: ['교육', '훈련', '학습', '강좌', 'education', 'training'],
  CULTURE: ['문화', '예술', '여가', '체육', 'culture', 'arts']
};

const interestLabels = {
  CAREER: { en: 'Career', ko: '취업' },
  HOUSING: { en: 'Housing', ko: '주거' },
  FINANCIAL_SUPPORT: { en: 'Financial support', ko: '금융지원' },
  STARTUP: { en: 'Startup', ko: '창업' },
  EDUCATION: { en: 'Education', ko: '교육' },
  CULTURE: { en: 'Culture', ko: '문화' }
};

function normalizeRegionText(region) {
  const r = String(region || '').trim();
  if (!r) return [];
  const tokens = [r.toLowerCase()];
  if (/전남|전라남도/.test(r)) tokens.push('전남', '전라남도');
  if (/전북|전북특별자치도|전라북도/.test(r)) tokens.push('전북', '전북특별자치도', '전라북도');
  if (/광주|광주광역시/.test(r)) tokens.push('광주', '광주광역시');
  if (/서울|서울특별시/.test(r)) tokens.push('서울', '서울특별시');
  if (/경기|경기도/.test(r)) tokens.push('경기', '경기도');
  if (/인천|인천광역시/.test(r)) tokens.push('인천', '인천광역시');
  if (/부산|부산광역시/.test(r)) tokens.push('부산', '부산광역시');
  if (/대구|대구광역시/.test(r)) tokens.push('대구', '대구광역시');
  if (/대전|대전광역시/.test(r)) tokens.push('대전', '대전광역시');
  return [...new Set(tokens)];
}

function rankOpportunities(items, prompt) {
  const strategy = policyStrategy(prompt);
  const promptText = String(prompt || '').toLowerCase();
  const profileDepartmentTerms = [student.department, ...student.majorKeywords, ...courses.map(x => x.name)]
    .join(' ').toLowerCase().split(/\s+/).filter(x => x.length > 2);
  const intentTerms = {
    MAJOR: ['전공', '공학', '컴퓨터', '소프트웨어', '디지털', '기술'],
    CAREER: ['취업', '일자리', '채용', '직무', '인턴'],
    HOUSING: ['주거', '월세', '전세', '주택'],
    EDUCATION: ['교육', '훈련', '학비', '장학'],
    GENERAL: []
  }[strategy];

  const userInterests = Array.isArray(student.interests) ? student.interests : [];
  const residenceTokens = normalizeRegionText(student.residence);
  const isStudent = ['ENROLLED', 'ON_LEAVE', 'EXPECTED_GRADUATION'].includes(student.enrollmentStatus);
  const isUnemployed = ['UNEMPLOYED', 'JOB_SEEKING', 'PREPARING_STARTUP'].includes(student.employmentStatus);

  return items.filter(x => x.match?.status !== 'NOT_MATCHED').map(x => {
    const text = [x.title, x.description, x.major, x.eligibility, x.region, x.studentStatus].filter(Boolean).join(' ').toLowerCase();
    const matchedReasons = [];
    let score = 0;

    // 1. User Interests matching (Weight: 5 per matched interest)
    for (const interest of userInterests) {
      const keywords = interestKeywordsMap[interest] || [];
      if (keywords.some(kw => text.includes(kw))) {
        score += 5;
        const label = ui(interestLabels[interest]?.en || interest, interestLabels[interest]?.ko || interest);
        if (!matchedReasons.includes(label)) matchedReasons.push(label);
      }
    }

    // 2. Residence matching (Weight: 4)
    if (residenceTokens.length && residenceTokens.some(tok => text.includes(tok) || String(x.region || '').toLowerCase().includes(tok))) {
      score += 4;
      const resLabel = student.residence.trim();
      if (!matchedReasons.includes(resLabel)) matchedReasons.push(resLabel);
    }

    // 3. Employment / Enrollment status matching (Weight: 3)
    if (isStudent && (/대학생|재학생|휴학생|대학/.test(text) || String(x.studentStatus || '').includes('대학'))) {
      score += 3;
      const stLabel = ui('Student', '대학생');
      if (!matchedReasons.includes(stLabel)) matchedReasons.push(stLabel);
    }
    if (isUnemployed && /미취업|구직|취준생|예비|미취업자/.test(text)) {
      score += 3;
      const unLabel = ui('Job seeker', '구직자');
      if (!matchedReasons.includes(unLabel)) matchedReasons.push(unLabel);
    }

    // 4. Department / Major matching (Weight: 2)
    const deptMatches = profileDepartmentTerms.some(t => text.includes(t));
    if (deptMatches) {
      score += 2;
      const deptLabel = ui('Major match', '전공 연계');
      if (!matchedReasons.includes(deptLabel)) matchedReasons.push(deptLabel);
    }

    // 5. Query Intent matching (Weight: 2)
    const intentMatches = intentTerms.some(t => text.includes(t));
    if (intentMatches) {
      score += 2;
    }

    // Unrestricted major bonus (Weight: 1)
    const unrestricted = !x.major || /제한.?없|전체|무관/i.test(String(x.major));
    if (unrestricted) score += 1;

    let reason = '';
    if (matchedReasons.length) {
      reason = `${ui('Why recommended', '추천 이유')} · ${matchedReasons.join(' · ')}`;
    } else if (unrestricted) {
      reason = ui('No major restriction is published; confirm the remaining eligibility.', '전공 제한 정보가 없으며 다른 지원 자격을 확인해야 합니다.');
    } else {
      reason = ui('Matches the purpose of your question; confirm eligibility.', '질문 목적과 관련된 정책입니다. 지원 자격을 확인하세요.');
    }

    return { ...x, relevance: score, matchedReasons, recommendationReason: reason };
  }).sort((a, b) => b.relevance - a.relevance);
}
function opportunityCards(items = []) {
  if (!items.length) return `<p class="empty-copy">${ui('The official source returned no matching items. Try a broader question.', '공식 데이터에서 조건에 맞는 항목을 찾지 못했습니다. 더 넓은 질문으로 다시 시도해 보세요.')}</p>`;
  return `<div class="opportunity-list">${items.slice(0, 6).map(item => { const match = item.match || { status: 'UNKNOWN', reason: ui('Confirm official eligibility details.', '공식 지원 자격을 확인하세요.') }; const reason = match.status === 'UNKNOWN' ? ui('Confirm official eligibility details before applying.', '신청 전 공식 지원 자격을 확인하세요.') : match.reason; const date = item.applicationDeadline ? `${ui('Deadline', '마감')} ${item.applicationDeadline}` : ui('Deadline not provided by source', '출처에 마감일 미제공'); const sourceLink = item.officialUrl && /^https?:\/\//i.test(item.officialUrl) ? `<a href="${esc(item.officialUrl)}" target="_blank" rel="noopener noreferrer">${`${ui('Official details', '공식 상세 보기')} ${icon('external-link', { size: 'sm' })}`}</a>` : ''; return `<article class="opportunity-card"><p class="tag">${esc(item.source || 'official source')}</p><h3>${esc(item.title || ui('Untitled policy', '제목 미제공 정책'))}</h3><p>${esc(item.organization || ui('Organization not provided', '기관 정보 미제공'))}</p><p>${esc(item.description || ui('Description not provided', '설명 미제공'))}</p><small class="pill warm">${esc(match.status)}</small><small>${esc(item.recommendationReason || reason)}</small><small>${esc(date)}</small>${sourceLink}</article>`; }).join('')}</div>`;
}
function renderChat() {
  const messages = chatState.messages.map(message => `<div class="chat-message ${message.role}"><span>${message.role === 'assistant' ? icon('sparkles', { size: 'sm' }) : initials}</span><div><p>${esc(message.text)}</p>${message.opportunities ? opportunityCards(message.opportunities) : ''}</div></div>`).join('');
  const integrationNote = chatState.publicData?.error ? `${ui('Official public-data request:', '공식 공공데이터 요청:')} ${esc(chatState.publicData.error)}` : (useMockChat ? (appLanguage === 'ko' ? '현재 일반 채팅은 개발용 응답을 사용하며 외부 AI 키는 브라우저에 저장하지 않습니다.' : 'Mock Chat Adapter is active. External AI keys are never stored in the browser.') : (appLanguage === 'ko' ? '청년 정책은 공식 공공데이터를 서버에서만 조회합니다. 일반 AI 채팅은 아직 연결되지 않았습니다.' : 'Youth policies are retrieved from an official source through the server only. General AI chat is not connected yet.'));
  return `${topbar('AI Chatbot')}<main class="chat-page"><div class="page-intro center"><p class="tag">STUDY MATE AI · PHASE 5</p><h2>${appLanguage === 'ko' ? '나만의 학습 도우미' : 'Your study companion.'}</h2><p>${appLanguage === 'ko' ? '학습 질문과 청년 지원 정책을 물어보세요.' : 'Ask about study support and youth policies.'}</p></div><section class="chat-window"><div class="chat-messages">${messages}${chatState.loading ? `<div class="chat-message assistant"><span>${icon('sparkles', { size: 'sm' })}</span><div>${esc(chatState.loadingLabel || 'Thinking…')}</div></div>` : ''}</div><div class="suggestions"><button data-chat-action="prompt" data-prompt="How do I record a lecture?">${appLanguage === 'ko' ? '강의 녹음 방법' : 'How do I record a lecture?'}</button><button data-chat-action="prompt" data-prompt="What assignments are due this week?">${appLanguage === 'ko' ? '이번 주 과제' : 'Upcoming assignments'}</button><button data-chat-action="prompt" data-prompt="청년 정책을 추천해줘">${appLanguage === 'ko' ? '청년 정책 추천' : 'Recommend youth policies'}</button></div><div class="chat-input"><input id="chat-message" placeholder="${appLanguage === 'ko' ? 'Study Mate에게 질문하세요…' : 'Ask Study Mate anything…'}" aria-label="Chat message"/><button data-chat-action="send" ${chatState.loading ? 'disabled' : ''} aria-label="${ui('Send message', '메시지 전송')}">${icon('send', { size: 'sm' })}</button></div></section><p class="chat-note">${integrationNote}</p></main>`;
}
async function handleChatAction(action, element) {
  const input = document.querySelector('#chat-message'); const prompt = action === 'prompt' ? element.dataset.prompt : input?.value.trim(); if (!prompt || chatState.loading) return;
  const intent=chatIntent(prompt); chatState.messages.push({ role: 'user', text: prompt }); chatState.loading = true; chatState.loadingLabel = intent==='POLICY' ? ui('Checking the official youth-policy source…', '공식 청년정책 데이터를 조회하고 있습니다…') : ui('Checking your Study Mate data…', 'Study Mate 데이터를 확인하고 있습니다…'); chatState.error = ''; chatState.publicData = null; render();
  try { if (intent==='POLICY') { const result = await youthPolicyService.search(); const opportunities = rankOpportunities((result.opportunities || []).map(item => ({ ...item, match: eligibilityMatcher.match(item, student) })), prompt); chatState.publicData = { source: result.source, cache: result.cache, count: opportunities.length, strategy: policyStrategy(prompt) }; chatState.messages.push({ role: 'assistant', text: opportunities.length ? ui('Here are policy records returned by the official OnTong Youth source. Please verify each program’s full eligibility before applying.', '온통청년 공식 데이터에서 조회한 정책입니다. 신청 전 각 프로그램의 전체 지원 자격을 확인하세요.') : ui('The official source returned no items for this question.', '공식 데이터에서 이 질문에 해당하는 항목을 찾지 못했습니다.'), opportunities }); } else { chatState.messages.push({role:'assistant',text:localChatAnswer(intent)}); } }
  catch (error) { const message = error.code === 'upstream-tls-failure' ? ui('The official source could not establish a secure connection from this server. No sample data was substituted.', '공식 데이터 서버와의 보안 연결을 만들지 못했습니다. 샘플 데이터로 대체하지 않았습니다.') : error.code === 'upstream-connect-timeout' ? ui('The official source did not respond before the server connection timed out. No sample data was substituted.', '공식 데이터 서버 연결 시간이 초과되었습니다. 샘플 데이터로 대체하지 않았습니다.') : error.code === 'insecure-redirect' ? ui('The official API redirected this request to an insecure endpoint, so Study Mate did not send the credential there.', '공식 API가 요청을 안전하지 않은 주소로 리디렉션해 Study Mate가 인증정보를 전송하지 않았습니다.') : /^upstream-http-4\d\d$/.test(error.code || '') ? ui('The official source rejected this request configuration. No policy data was returned.', '공식 데이터 서버가 현재 요청 명세를 거부했습니다. 정책 데이터는 수신되지 않았습니다.') : ui('The study assistant could not respond. Please try again.', '학습 도우미가 응답하지 못했습니다. 다시 시도해 주세요.'); chatState.error = message; chatState.publicData = { error: error.code || 'request-failed' }; chatState.messages.push({ role: 'assistant', text: message }); }
  chatState.loading = false; render(); const area = document.querySelector('.chat-messages'); if (area) area.scrollTop = area.scrollHeight;
}
let courseEditor = { mode: null, id: null, error: '' };
const profileLabel = value => ({ ENROLLED: ui('Enrolled','재학'), ON_LEAVE: ui('On Leave','휴학'), EXPECTED_GRADUATION: ui('Expected Graduation','졸업 예정'), GRADUATED: ui('Graduated','졸업'), EMPLOYED: ui('Employed','재직'), UNEMPLOYED: ui('Unemployed','미취업'), JOB_SEEKING: ui('Job Seeking','구직'), FREELANCER: ui('Freelancer','프리랜서'), PREPARING_STARTUP: ui('Preparing Startup','창업 준비'), CAREER: ui('Career','취업'), HOUSING: ui('Housing','주거'), FINANCIAL_SUPPORT: ui('Financial support','장학금/금융지원'), STARTUP: ui('Startup','창업'), EDUCATION: ui('Education','교육'), CULTURE: ui('Culture','문화') }[value] || value);
const weekdayLabel = value => ({ Sun: ui('Sun', '일'), Mon: ui('Mon', '월'), Tue: ui('Tue', '화'), Wed: ui('Wed', '수'), Thu: ui('Thu', '목'), Fri: ui('Fri', '금'), Sat: ui('Sat', '토') }[value] || value);
function courseForm(course = {}) { return `<section class="card top-space"><h2>${courseEditor.mode === 'edit' ? ui('Edit course', '과목 수정') : ui('Add course', '과목 추가')}</h2>${courseEditor.error ? `<p class="note-error">${esc(courseEditor.error)}</p>` : ''}<div class="grid two"><label>${ui('Course name', '과목명')}<input id="course-name" value="${esc(course.name || '')}"/></label><label>${ui('Professor', '교수명')}<input id="course-professor" value="${esc(course.professor || '')}"/></label><label>${ui('Day', '요일')}<select id="course-day"><option value="">${ui('Not set', '미설정')}</option>${['Mon','Tue','Wed','Thu','Fri','Sat','Sun'].map(day => `<option value="${day}" ${course.dayOfWeek === day ? 'selected' : ''}>${weekdayLabel(day)}</option>`).join('')}</select></label><label>${ui('Start time', '시작 시간')}<input id="course-start" type="time" value="${esc(course.startTime || '')}"/></label><label>${ui('End time', '종료 시간')}<input id="course-end" type="time" value="${esc(course.endTime || '')}"/></label></div><div class="candidate-actions"><button class="button" data-course-action="save">${ui('Save', '저장')}</button><button class="button secondary" data-course-action="cancel">${ui('Cancel', '취소')}</button></div></section>`; }
function profile() {
  const rows = [['Student ID', student.studentId], ['Nationality', student.nationality], ['Department', student.department], ['Year', ui(`Year ${student.grade}`, `${student.grade}학년`)], ['GPA', student.gpa], ['Preferred language', student.preferredLanguage]];
  const interests = ['CAREER','HOUSING','FINANCIAL_SUPPORT','STARTUP','EDUCATION','CULTURE'];
  const saveLabel = profileState.saved ? `${icon('check', { size: 'sm' })} ${ui('Saved!', '저장됨')}` : ui('Save profile', '프로필 저장');
  const fields = `<section class="card top-space profile-form"><h2>${ui('Policy recommendation profile','정책 추천 프로필')}</h2><div class="grid two"><label>${ui('Age','만 나이')}<input id="profile-age" type="number" min="0" max="120" value="${esc(student.age)}"/></label><label>${ui('Residence','거주 지역')}<input id="profile-residence" value="${esc(student.residence || '')}"/></label><label>${ui('Enrollment status','학적 상태')}<select id="profile-enrollment">${['ENROLLED','ON_LEAVE','EXPECTED_GRADUATION','GRADUATED'].map(x=>`<option value="${x}" ${student.enrollmentStatus===x?'selected':''}>${profileLabel(x)}</option>`).join('')}</select></label><label>${ui('Employment status','취업 상태')}<select id="profile-employment">${['EMPLOYED','UNEMPLOYED','JOB_SEEKING','FREELANCER','PREPARING_STARTUP'].map(x=>`<option value="${x}" ${student.employmentStatus===x?'selected':''}>${profileLabel(x)}</option>`).join('')}</select></label></div><div class="profile-interests" role="group" aria-label="${ui('Interests', '관심 분야')}">${interests.map(x=>`<label class="condition-chip"><input type="checkbox" data-profile-interest value="${x}" ${(student.interests||[]).includes(x)?'checked':''}/> <span>${profileLabel(x)}</span></label>`).join('')}</div><button class="button" data-profile-action="save" ${profileState.saved ? 'disabled style="background:#10b981;border-color:#10b981;color:#ffffff;"' : ''}>${saveLabel}</button></section>`;
  return `${topbar('My Page')}<main><div class="page-intro"><p class="tag">MY PROFILE</p><h2>My learning profile.</h2></div><section class="profile-card"><span class="profile-avatar">${initials}</span><div><h2>${student.name}</h2><p>${student.department} · ${ui(`Year ${student.grade}`, `${student.grade}학년`)}</p></div></section><section class="card"><h2>Student information</h2><dl>${rows.map(([key,value])=>`<div><dt>${key}</dt><dd>${value}</dd></div>`).join('')}</dl></section>${fields}</main>`;
}
async function handleCourseAction(action, element) { if (action === 'add') { courseEditor = { mode: 'add', id: null, error: '' }; render(); return; } if (action === 'edit') { courseEditor = { mode: 'edit', id: element.dataset.courseId, error: '' }; render(); return; } if (action === 'cancel') { courseEditor = { mode: null, id: null, error: '' }; render(); return; } if (action === 'delete') { const course = courses.find(item => item.id === element.dataset.courseId); if (!course || !window.confirm(ui(`Remove ${course.name}? Existing recordings and notes will be kept.`, `${course.name}을 삭제할까요? 기존 녹음과 노트는 유지됩니다.`))) return; courses = courses.filter(item => item.id !== course.id); if (selectedCourseId === course.id) selectedCourseId = courses[0]?.id || ''; courseEditor = { mode: null, id: null, error: '' }; persistAppState(); render(); return; } if (action === 'save') { const name = document.querySelector('#course-name')?.value.trim(); const professor = document.querySelector('#course-professor')?.value.trim() || ''; const dayOfWeek = document.querySelector('#course-day')?.value || ''; const startTime = document.querySelector('#course-start')?.value || ''; const endTime = document.querySelector('#course-end')?.value || ''; if (!name) { courseEditor.error = ui('Course name is required.', '과목명을 입력하세요.'); render(); return; } if ((startTime && !endTime) || (!startTime && endTime) || (startTime && endTime && endTime <= startTime)) { courseEditor.error = ui('Enter a valid class time range.', '올바른 수업 시간을 입력하세요.'); render(); return; } const course = { id: courseEditor.mode === 'edit' ? courseEditor.id : `course-${crypto.randomUUID?.() || Date.now()}`, name, professor, dayOfWeek, startTime, endTime }; const previous = courses; courses = courseEditor.mode === 'edit' ? courses.map(item => item.id === course.id ? course : item) : [...courses, course]; if (!selectedCourseId) selectedCourseId = course.id; try { await courseService.save(courses); courseEditor = { mode: null, id: null, error: '' }; persistAppState(); render(); } catch (_) { courses = previous; courseEditor.error = ui('Course could not be saved in this browser.', '이 브라우저에 과목을 저장할 수 없습니다.'); render(); } } }
function mountSttDebug() { const anchor = document.querySelector('#saved-recording'); if (!anchor || !isDevelopment) return; anchor.insertAdjacentHTML('beforebegin', '<details id="stt-debug" class="stt-debug"><summary>STT & Translation Debug (development)</summary><dl><div><dt>STT engine</dt><dd data-debug-engine>—</dd></div><div><dt>STT connection</dt><dd data-debug-connection>idle</dd></div><div><dt>Language</dt><dd data-debug-language>—</dd></div><div><dt>Audio</dt><dd data-debug-audio>—</dd></div><div><dt>Chunks</dt><dd data-debug-chunks>0 / 0 bytes</dd></div><div><dt>STT counts</dt><dd data-debug-counts>interim 0, final 0, reconnect 0</dd></div><div><dt>Pipeline latency</dt><dd data-debug-latency>—</dd></div><div><dt>STT error</dt><dd data-debug-error>—</dd></div><div><dt>Last STT event</dt><dd data-debug-last>Idle</dd></div><div><dt>Interim</dt><dd data-debug-interim>—</dd></div><div><dt>Final</dt><dd data-debug-final>—</dd></div><div><dt>Translation engine</dt><dd data-translation-engine>—</dd></div><div><dt>Model</dt><dd data-translation-model>—</dd></div><div><dt>Translation state</dt><dd data-translation-connection>idle</dd></div><div><dt>Target language</dt><dd data-translation-language>—</dd></div><div><dt>Translation counts</dt><dd data-translation-requests>request 0, success 0, failure 0</dd></div><div><dt>Last latency</dt><dd data-translation-latency>—</dd></div><div><dt>Translation breakdown</dt><dd data-translation-breakdown>—</dd></div><div><dt>Translation input</dt><dd data-translation-input>—</dd></div><div><dt>Translation error</dt><dd data-translation-error>—</dd></div></dl><pre data-debug-log>No STT event yet.</pre></details>'); refreshSttDebug(); }
function reviewTime(ms = 0) { const seconds = Math.max(0, Math.floor(Number(ms) / 1000)); const hours = Math.floor(seconds / 3600); const minutes = Math.floor(seconds / 60) % 60; const base = `${String(minutes).padStart(2, '0')}:${String(seconds % 60).padStart(2, '0')}`; return hours ? `${String(hours).padStart(2, '0')}:${base}` : base; }
function reviewSegments(recording) { const source = Array.isArray(recording?.transcriptSegments) ? recording.transcriptSegments : []; const fallback = recording?.originalTranscript || []; return (source.length ? source : fallback.map((content, index) => ({ id: `legacy-${index}`, rawKorean: content, content, startMs: null, endMs: null }))).map((segment, index, all) => ({ ...segment, id: segment.id || `segment-${index}`, rawKorean: segment.rawKorean || segment.content || fallback[index] || '', correctedKorean: segment.correctedKorean || segment.content || fallback[index] || '', translatedText: segment.translatedText || recording?.translatedTranscript?.[index] || '', startMs: Number.isFinite(Number(segment.startMs)) ? Number(segment.startMs) : null, endMs: Number.isFinite(Number(segment.endMs)) ? Number(segment.endMs) : (Number.isFinite(Number(all[index + 1]?.startMs)) ? Number(all[index + 1].startMs) : null) })); }
function activeReviewSegment(recording, seconds) { const at = Number(seconds) * 1000; return reviewSegments(recording).find((segment, index, all) => { const nextStart = all[index + 1]?.startMs; const end = segment.endMs > segment.startMs ? segment.endMs : (nextStart ?? Number.MAX_SAFE_INTEGER); return segment.startMs !== null && at >= segment.startMs && at < end; })?.id || ''; }
function keywordReviewSegment(recording, keyword) { const key = String(keyword || '').trim().toLocaleLowerCase(); if (!key) return null; return reviewSegments(recording).find(segment => [segment.rawKorean, segment.correctedKorean, segment.translatedText].some(text => String(text || '').toLocaleLowerCase().includes(key))) || null; }
function releaseReviewAudio() { if (reviewState.ownsAudioUrl && reviewState.audioUrl) URL.revokeObjectURL(reviewState.audioUrl); reviewState = { ...reviewState, audioUrl: '', ownsAudioUrl: false, audioStatus: 'idle', audioError: '', currentTime: 0, duration: 0, loading: false }; }
async function loadReviewAudio(recording) { if (!recording || reviewState.loading || reviewState.audioUrl || reviewState.audioStatus === 'unavailable') return; reviewState.loading = true; render(); try { const blob = recording.audio instanceof Blob ? recording.audio : await audioStorage.getAudio(recording.audioRef || recording.id); if (!(blob instanceof Blob)) throw new Error('Recording audio is not available in this browser.'); reviewState.audioUrl = recording.audioUrl || URL.createObjectURL(blob); reviewState.ownsAudioUrl = !recording.audioUrl; reviewState.audioStatus = 'ready'; } catch (error) { reviewState.audioStatus = 'unavailable'; reviewState.audioError = error?.message || 'Recording audio is unavailable.'; } finally { reviewState.loading = false; render(); } }
function updateReviewPlayback(recording) { const audio = document.querySelector('#review-audio'); if (!audio) return; const current = Number(audio.currentTime) || 0; reviewState.currentTime = current; reviewState.duration = Number.isFinite(audio.duration) ? audio.duration : (reviewState.duration || (Number(recording.durationMs) || 0) / 1000); const progress = document.querySelector('#review-progress'); const currentLabel = document.querySelector('[data-review-current]'); const durationLabel = document.querySelector('[data-review-duration]'); const play = document.querySelector('[data-review-action="play"]'); if (progress) { progress.max = String(reviewState.duration || 0); progress.value = String(Math.min(current, reviewState.duration || 0)); } if (currentLabel) currentLabel.textContent = reviewTime(current * 1000); if (durationLabel) durationLabel.textContent = reviewTime((reviewState.duration || 0) * 1000); if (play) { play.innerHTML = icon(audio.paused ? 'play' : 'pause', { size: 'md' }); play.setAttribute('aria-label', audio.paused ? ui('Play recording', '녹음 재생') : ui('Pause recording', '일시정지')); }
  const activeId = activeReviewSegment(recording, current); document.querySelectorAll('[data-review-segment]').forEach(row => row.classList.toggle('active', row.dataset.reviewSegment === activeId)); }
function mountLectureReview(recording) { if (!recording) return; if (reviewState.lectureId && reviewState.lectureId !== recording.id) releaseReviewAudio(); reviewState.lectureId = recording.id; if (!reviewState.duration && recording.durationMs) reviewState.duration = recording.durationMs / 1000; if (!reviewState.audioUrl && !reviewState.loading && reviewState.audioStatus !== 'unavailable') { loadReviewAudio(recording); return; } const audio = document.querySelector('#review-audio'); if (!audio || !reviewState.audioUrl) return; audio.src = reviewState.audioUrl; audio.playbackRate = reviewState.speed; audio.addEventListener('loadedmetadata', () => updateReviewPlayback(recording)); audio.addEventListener('timeupdate', () => updateReviewPlayback(recording)); audio.addEventListener('play', () => updateReviewPlayback(recording)); audio.addEventListener('pause', () => updateReviewPlayback(recording)); audio.addEventListener('ended', () => updateReviewPlayback(recording)); updateReviewPlayback(recording); }
function reviewTranscript(recording) { const segments = reviewSegments(recording); if (!segments.length) return empty(ui('No final transcript', '최종 자막이 없습니다'), ui('This lecture has no saved final captions yet.', '이 강의에는 저장된 최종 자막이 없습니다.')); const hasLegacyTiming = segments.some(segment => segment.startMs !== null && segment.timestampSource !== 'google-word-offset'); const timingNotice = hasLegacyTiming ? `<p class="review-timing-notice">${ui('This older recording has estimated caption timestamps. Exact seeking is available for recordings made after the timestamp update.', '이전 녹음은 자막 결과 도착 시각으로 저장되어 정확한 탐색을 제공할 수 없습니다. 정확한 타임스탬프는 이번 업데이트 후 새로 녹음한 강의부터 적용됩니다.')}</p>` : ''; return `${timingNotice}<div class="review-transcript">${segments.map(segment => { const precise = segment.timestampSource === 'google-word-offset'; const unavailable = segment.startMs === null || !precise; const debug = isDevelopment ? `<details class="review-timing-debug"><summary>Timing debug</summary><code>id=${esc(segment.id)} · raw=${esc(segment.rawKorean)} · google=${segment.googleStartMs ?? '—'}-${segment.googleEndMs ?? '—'}ms · base=${segment.streamBaseAudioOffsetMs ?? '—'}ms · lecture=${segment.startMs ?? '—'}-${segment.endMs ?? '—'}ms · seek=${segment.startMs === null ? '—' : Math.max(0, segment.startMs - 350)}ms</code></details>` : ''; return `<article class="review-segment" data-review-segment="${esc(segment.id)}"><button class="review-seek" data-review-action="seek" data-segment-id="${esc(segment.id)}" ${unavailable ? 'disabled' : ''} aria-label="${ui('Listen from this transcript segment', '이 자막 구간부터 듣기')}">${icon('volume-2', { size: 'sm' })} <span>${segment.startMs === null ? '—' : reviewTime(segment.startMs)}</span></button><div><p class="review-korean">${esc(segment.correctedKorean || segment.rawKorean)}</p>${segment.translatedText ? `<p class="review-translation">${esc(segment.translatedText)}</p>` : ''}${debug}</div></article>`; }).join('')}</div>`; }
function reviewNote(recording, note) { if (!note) return `<div class="state"><span>${icon('file-text', { size: 'lg' })}</span><strong>${ui('No Smart Note yet', 'Smart Note가 없습니다')}</strong><p>${ui('Create a Smart Note from the Notes page when you are ready. Viewing this review never generates one automatically.', '필요할 때 노트 화면에서 Smart Note를 생성하세요. 이 화면을 보는 것만으로는 자동 생성되지 않습니다.')}</p></div>`; const keywords = (note.keywords || []).map(keyword => { const segment = keywordReviewSegment(recording, keyword); const precise = segment?.timestampSource === 'google-word-offset'; return `<div class="review-keyword"><button class="keyword-mark" data-review-action="keyword-info" data-keyword="${esc(keyword)}">${esc(keyword)}</button>${precise ? `<button class="review-listen-link" data-review-action="seek" data-segment-id="${esc(segment.id)}">${icon('volume-2', { size: 'sm' })} <span>${reviewTime(segment.startMs)} ${ui('Listen again', '다시 듣기')}</span></button>` : ''}</div>`; }).join(''); const editing = noteState.editing && noteState.selectedLectureId === recording.id; return `<div class="review-note"><div class="review-note-head"><div><p class="tag">SMART NOTE</p><h2>${esc(note.title || recording.title)}</h2></div><div class="note-actions">${editing ? '<button class="button secondary" data-note-action="cancel">Cancel</button><button class="button" data-note-action="save">Save</button>' : '<button class="button secondary" data-review-action="edit-note">Edit</button><button class="button secondary" data-review-action="pdf-note">Save PDF</button>'}</div></div>${editing ? noteContents(note) : `<section class="note-section"><h3>${ui('Lecture summary', '강의 요약')}</h3><p>${esc(note.summary || '')}</p></section><section class="note-section"><h3>${ui('Related lecture moments', '관련 강의 구간')}</h3><div class="review-keywords">${keywords || `<p class="empty-copy">${ui('No verified timestamp is available for this note yet.', '검증된 타임스탬프가 있는 키워드가 아직 없습니다.')}</p>`}</div></section><section class="note-section"><h3>${ui('Key concepts', '핵심 개념')}</h3><ul>${(note.keyPoints || []).map(point => `<li>${esc(point)}</li>`).join('')}</ul></section><section class="note-section"><h3>${ui('Study tips', '복습 포인트')}</h3><ul>${(note.reviewPoints || note.studyTips || []).map(point => `<li>${esc(point)}</li>`).join('')}</ul></section><section class="note-section quiz-section"><div class="section-title"><h3>${ui('Review quiz', '복습 퀴즈')}</h3><span>${ui('Instant feedback', '즉시 채점')}</span></div>${noteQuizzes(note)}</section>`}</div>`; }
function lectureReview() { const lectureId = decodeURIComponent(location.pathname.split('/').pop() || ''); const recording = recordings.find(item => item.id === lectureId); if (!recording) return `${topbar(ui('Lecture Review', '강의 복습'))}<main>${empty(ui('Lecture not found', '강의를 찾을 수 없습니다'), ui('This lecture may have been deleted from this browser.', '이 강의는 이 브라우저에서 삭제되었을 수 있습니다.'))}</main>`; const note = noteState.notes[recording.id]; if (note) noteState.selectedLectureId = recording.id; const transcriptTab = reviewState.tab !== 'note'; const duration = recording.durationMs || 0; const player = reviewState.loading ? `<div class="review-audio-state"><span class="inline-spinner"></span>${ui('Loading saved audio…', '저장된 오디오를 불러오는 중…')}</div>` : reviewState.audioStatus === 'unavailable' ? `<div class="review-audio-state error"><strong>${ui('Audio unavailable', '오디오를 사용할 수 없습니다')}</strong><p>${ui('This recording file is not stored in the current browser. Its transcript and Smart Note are still available.', '이 녹음 파일은 현재 브라우저에 저장되어 있지 않습니다. 자막과 Smart Note는 계속 볼 수 있습니다.')}</p></div>` : `<audio id="review-audio" preload="metadata"></audio><div class="review-player-controls"><div class="review-transport"><button class="button secondary review-skip" data-review-action="back" aria-label="${ui('Skip back 10 seconds', '10초 뒤로')}">${icon('rotate-ccw', { size: 'sm' })} <span>${ui('Back 10s', '10초 전')}</span></button><button class="review-play" data-review-action="play" aria-label="${ui('Play recording', '녹음 재생')}">${icon('play', { size: 'md' })}</button><button class="button secondary review-skip" data-review-action="forward" aria-label="${ui('Skip forward 10 seconds', '10초 앞으로')}"><span>${ui('Forward 10s', '10초 후')}</span> ${icon('rotate-cw', { size: 'sm' })}</button></div><div class="review-progress-group"><input id="review-progress" aria-label="${ui('Recording progress', '녹음 진행 위치')}" type="range" min="0" max="${Math.ceil(reviewState.duration || duration / 1000)}" value="${Math.min(reviewState.currentTime, reviewState.duration || duration / 1000)}" step="0.1"/><div><span class="review-time"><span data-review-current>${reviewTime(reviewState.currentTime * 1000)}</span> / <span data-review-duration>${reviewTime((reviewState.duration || duration / 1000) * 1000)}</span></span><label class="review-speed">${ui('Playback speed', '재생 속도')}<select id="review-speed">${[.75,1,1.25,1.5,2].map(speed => `<option value="${speed}" ${reviewState.speed === speed ? 'selected' : ''}>${speed}×</option>`).join('')}</select></label><button class="review-download" data-review-action="download" ${reviewState.audioUrl ? '' : 'disabled'}>${ui('Download', '다운로드')}</button></div></div></div>`; return `${topbar(ui('Lecture Review', '강의 복습'))}<main class="review-page"><a class="back-link" data-route="/notes" href="/notes">${icon('arrow-left', { size: 'sm' })} <span>${ui('Saved lectures', '강의 목록')}</span></a><section class="review-header"><div><p class="tag">LECTURE REVIEW</p><h2>${esc(recording.title)}</h2><p>${esc(courseName(recording.courseId, recording.course))} · ${new Date(recording.createdAt).toLocaleDateString(appLanguage === 'ko' ? 'ko-KR' : 'en')} · ${formatDuration(duration)}</p></div></section><section class="review-player card">${player}</section><section class="review-tabs" role="tablist"><button class="${transcriptTab ? 'active' : ''}" data-review-action="tab" data-tab="transcript" role="tab" aria-selected="${transcriptTab}">${ui('Transcript', '자막')}</button><button class="${!transcriptTab ? 'active' : ''}" data-review-action="tab" data-tab="note" role="tab" aria-selected="${!transcriptTab}">${ui('Smart Note', 'Smart Note')}</button></section><section class="review-content card">${transcriptTab ? reviewTranscript(recording) : reviewNote(recording, note)}</section></main>`; }
async function handleReviewAction(action, element) { const recording = recordings.find(item => item.id === reviewState.lectureId); if (!recording) return; const audio = document.querySelector('#review-audio'); if (action === 'tab') { reviewState.tab = element.dataset.tab || 'transcript'; render(); return; } if (action === 'edit-note') { const note = noteState.notes[recording.id]; if (!note) return; noteState.selectedLectureId = recording.id; noteState.editing = true; noteState.draft = { summary: note.summary, reviewPoints: [...note.reviewPoints] }; render(); return; } if (action === 'pdf-note') { const note = noteState.notes[recording.id]; if (note) downloadNotePdf(note); return; } if (action === 'keyword-info') { openKeywordPopup(element.dataset.keyword, noteState.notes[recording.id]); return; } if (action === 'download') { downloadRecording(recording); return; } if (action === 'seek') { const segment = reviewSegments(recording).find(item => item.id === element.dataset.segmentId); if (!audio || segment?.timestampSource !== 'google-word-offset' || segment.startMs === null || segment.startMs === undefined) return; audio.currentTime = Math.max(0, segment.startMs - 350) / 1000; updateReviewPlayback(recording); try { await audio.play(); } catch (_) { updateReviewPlayback(recording); } return; } if (!audio) return; if (action === 'play') { try { if (audio.paused) await audio.play(); else audio.pause(); } catch (_) {} } if (action === 'back') audio.currentTime = Math.max(0, audio.currentTime - 10); if (action === 'forward') audio.currentTime = Math.min(audio.duration || Infinity, audio.currentTime + 10); updateReviewPlayback(recording); }
function render() { persistAppState(); const path = location.pathname; const reviewMatch = path.match(/^\/lectures\/([^/]+)$/); const pages = {'/': home, '/lecture': lecture, '/notes': notes, '/schedule': schedule, '/board': board, '/chat': chat, '/profile': profile}; const page = reviewMatch ? lectureReview : (pages[path] || home); if (!reviewMatch && !pages[path]) history.replaceState({}, '', '/'); if (!reviewMatch && reviewState.audioUrl) releaseReviewAudio(); app.innerHTML = localizeUi(`${nav()}<div class="overlay" data-close-menu></div><div class="shell">${page()}</div><div class="mobile-nav">${routes.slice(0, 5).map(([url, label, iconName]) => `<a data-route="${url}" href="${url}" class="${location.pathname === url ? 'active' : ''}"><span class="nav-icon">${icon(iconName, { size: 'md' })}</span><small>${t(label)}</small></a>`).join('')}</div>`); if (path === '/lecture') mountSttDebug(); if (reviewMatch) mountLectureReview(recordings.find(item => item.id === decodeURIComponent(reviewMatch[1]))); }
function home() {
  const recentLectures = recordings.slice(0, 3);
  const recentNotes = Object.values(noteState.notes).sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt))).slice(0, 3);
  const events = scheduleState.items.filter(item => item.status === 'confirmed').slice(0, 2);
  const recordedMs = recordings.reduce((total, recording) => total + (Number(recording.durationMs) || 0), 0);
  const lectureRows = recentLectures.length ? recentLectures.map(recording => `<a data-route="/lectures/${encodeURIComponent(recording.id)}" href="/lectures/${encodeURIComponent(recording.id)}" class="list-row"><span class="round-icon">${icon('mic', { size: 'sm' })}</span><span><strong>${esc(recording.title)}</strong><small>${esc(courseName(recording.courseId, recording.course))} · ${new Date(recording.createdAt).toLocaleDateString()}</small></span><em>Saved</em><b class="row-chevron">${icon('chevron-right', { size: 'sm' })}</b></a>`).join('') : empty('No recorded lectures', 'Finish a recording to see it here.');
  const noteRows = recentNotes.length ? recentNotes.map(note => `<a data-route="/notes" href="/notes" class="note-line"><span class="note-icon">${icon('file-text', { size: 'sm' })}</span><span><strong>${esc(note.title)}</strong><small>${esc(courseName(note.courseId, note.course))} · ${esc(note.date || '')}</small></span><b class="row-chevron">${icon('chevron-right', { size: 'sm' })}</b></a>`).join('') : empty('No Smart Notes', 'Create a note from a finished lecture transcript.');
  const eventRows = events.length ? events.map(event => `<a data-route="/schedule" href="/schedule" class="list-row"><span class="date-tile ${event.color || 'blue'}">${scheduleDateLabel(event.date).split(' ')[0]}<small>${scheduleDateLabel(event.date).split(' ')[1]}</small></span><span><strong>${esc(event.title)}</strong><small>${esc(event.relatedLecture || 'Personal schedule')}</small></span><b class="row-chevron">${icon('chevron-right', { size: 'sm' })}</b></a>`).join('') : empty('No upcoming schedule', 'Confirmed schedules will appear here.');
  return `${topbar(`Good morning, ${student.name}!`)}<main><section class="hero"><div><p class="tag">YOUR LEARNING SPACE</p><h2>Ready to make today<br />count?</h2><p>Keep your lectures, notes, and deadlines in one clear place.</p><button class="button" data-route="/lecture">Start a lecture <b>→</b></button></div><div class="hero-orb">✦<small>Focus<br/>mode</small></div></section><section class="metrics"><div><span>Recorded learning</span><strong>${formatDuration(recordedMs)}</strong><small>${recentLectures.length} saved lecture(s)</small></div><div><span>Notes to review</span><strong>${recentNotes.length}</strong><small>Transcript-based notes</small></div><div><span>Upcoming tasks</span><strong>${events.length}</strong><small>Confirmed calendar items</small></div></section><div class="grid two"><div>${card('Recent lectures', `${lectureRows}<a data-route="/lecture" href="/lecture" class="text-link">View all lectures →</a>`)}</div><div>${card('Upcoming schedule', `${eventRows}<a data-route="/schedule" href="/schedule" class="text-link">Open calendar →</a>`)}</div></div><div class="grid two bottom-grid"><div>${card('Continue reviewing', noteRows)}</div><div class="chat-promo"><span>${icon('sparkles', { size: 'md' })}</span><div><p class="tag">STUDY ASSISTANT</p><h2>Have a question?</h2><p>Ask about your studies or how to use Study Mate.</p><button data-route="/chat" class="button light">Ask AI Chatbot →</button></div></div></div></main>`;
}
// Clear feedback on direct visits while current mock data (or future API data) is prepared.
app.innerHTML = `<div class="app-loader">${loading()}</div>`;
window.setTimeout(render, 240);
