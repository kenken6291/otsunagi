/**
 * おとつなぎ — GAS バックエンド
 * スプレッドシートを会員DBに、Google Drive を保存先に、Gemini API を AI/TTS に使います。
 *
 * 初回：setup() を一度実行 → スクリプトプロパティに GEMINI_API_KEY を設定 → ウェブアプリとしてデプロイ
 * ※コードを変えたら「デプロイを管理」→ 編集 →「新バージョン」で再デプロイしてください（URLは変わりません）
 */

const APP_NAME = 'おとつなぎ';
const APP_VERSION = 'v1.0.0';
const PROPS = PropertiesService.getScriptProperties();

const SESSION_TTL_SEC = 21600;      // 6時間（CacheService の上限）。操作のたびに延長
const UPLOAD_TTL_SEC = 21600;
const MAX_FAIL = 5;                 // 連続失敗でロック
const LOCK_MIN = 30;                // ロック時間（分）
const HASH_ROUNDS = 300;
const MAX_CHUNKS = 12;              // 4MB × 12 ≒ 48MB(base64) ≒ 36MB
const MAX_CHUNK_LEN = 4 * 1024 * 1024 + 16;
const MAX_GETFILE_BYTES = 25 * 1024 * 1024;
const MAX_AI_AUDIO_BYTES = 20 * 1024 * 1024;
const KINDS = ['clips', 'output', 'projects', 'meta'];
const PW_RULE = /^(?=.*[A-Za-z])(?=.*\d).{8,64}$/;

const USER_HEADERS = ['userId', 'email', 'nickname', 'passwordHash', 'salt', 'mustChange', 'status',
  'failCount', 'lockedUntil', 'createdAt', 'updatedAt', 'lastLoginAt'];
const LOG_HEADERS = ['timestamp', 'action', 'email', 'message'];

const ROUTES = {
  ping: ping_, register: register_, login: login_, logout: logout_, me: me_,
  changePassword: changePassword_, resetPassword: resetPassword_,
  tts: tts_, analyze: analyze_, suggestName: suggestName_,
  uploadInit: uploadInit_, uploadChunk: uploadChunk_, uploadFinish: uploadFinish_,
  saveText: saveText_, listFiles: listFiles_, getFile: getFile_, deleteFile: deleteFile_
};

/* ===================== 入口 ===================== */
function doGet() {
  return out_({ ok: true, app: APP_NAME, version: APP_VERSION });
}

function doPost(e) {
  let req = {};
  try {
    req = JSON.parse((e && e.postData && e.postData.contents) || '{}');
  } catch (err) {
    return out_({ ok: false, error: 'リクエストの形式が正しくありません' });
  }
  const fn = Object.prototype.hasOwnProperty.call(ROUTES, req.action) ? ROUTES[req.action] : null;
  if (!fn) return out_({ ok: false, error: '不明な操作です：' + req.action });
  try {
    return out_(Object.assign({ ok: true }, fn(req) || {}));
  } catch (err) {
    if (err && err.appError) return out_({ ok: false, error: err.message, code: err.code || '' });
    console.error(err);
    log_(req.action, req.email || '', String((err && err.stack) || err));
    return out_({ ok: false, error: 'サーバーでエラーが起きました：' + (err && err.message) });
  }
}

function out_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}
function fail_(message, code) {
  const e = new Error(message);
  e.appError = true; e.code = code || '';
  throw e;
}

/* ===================== 初期設定 ===================== */
function setup() {
  const users = sheet_('Users', USER_HEADERS);
  users.getRange('D:E').setNumberFormat('@'); // ハッシュとソルトは文字列のまま
  sheet_('Logs', LOG_HEADERS);

  if (!PROPS.getProperty('PEPPER')) PROPS.setProperty('PEPPER', Utilities.getUuid() + Utilities.getUuid());
  if (!PROPS.getProperty('ROOT_FOLDER_ID')) {
    const folder = DriveApp.createFolder(APP_NAME + '_data');
    PROPS.setProperty('ROOT_FOLDER_ID', folder.getId());
  }
  if (!PROPS.getProperty('GEMINI_MODEL')) PROPS.setProperty('GEMINI_MODEL', 'gemini-2.5-flash');
  if (!PROPS.getProperty('GEMINI_TTS_MODEL')) PROPS.setProperty('GEMINI_TTS_MODEL', 'gemini-2.5-flash-preview-tts');
  if (!PROPS.getProperty('SPREADSHEET_ID')) {
    const ss = SpreadsheetApp.getActiveSpreadsheet();
    if (ss) PROPS.setProperty('SPREADSHEET_ID', ss.getId());
  }
  Logger.log('ROOT_FOLDER_ID: ' + PROPS.getProperty('ROOT_FOLDER_ID'));
  Logger.log('GEMINI_API_KEY: ' + (PROPS.getProperty('GEMINI_API_KEY') ? '設定済み' : '未設定（スクリプトプロパティに追加してください）'));
  // 権限承認を通すための呼び出し
  MailApp.getRemainingDailyQuota();
  UrlFetchApp.getRequest('https://generativelanguage.googleapis.com/');
}

/* ===================== スプレッドシート ===================== */
function ss_() {
  const id = PROPS.getProperty('SPREADSHEET_ID');
  return id ? SpreadsheetApp.openById(id) : SpreadsheetApp.getActiveSpreadsheet();
}
function sheet_(name, headers) {
  const ss = ss_();
  let sh = ss.getSheetByName(name);
  if (!sh) {
    sh = ss.insertSheet(name);
    sh.getRange(1, 1, 1, headers.length).setValues([headers]).setFontWeight('bold');
    sh.setFrozenRows(1);
  }
  return sh;
}
function findUser_(key, value) {
  const sh = sheet_('Users', USER_HEADERS);
  const vals = sh.getDataRange().getValues();
  const col = USER_HEADERS.indexOf(key);
  const target = String(value).trim().toLowerCase();
  for (let i = 1; i < vals.length; i++) {
    if (String(vals[i][col]).trim().toLowerCase() === target) {
      const u = {};
      USER_HEADERS.forEach((h, j) => { u[h] = vals[i][j]; });
      u._row = i + 1;
      return u;
    }
  }
  return null;
}
function saveUser_(u) {
  const sh = sheet_('Users', USER_HEADERS);
  u.updatedAt = new Date();
  const row = USER_HEADERS.map(h => (u[h] === undefined || u[h] === null ? '' : u[h]));
  if (u._row) {
    sh.getRange(u._row, 1, 1, row.length).setValues([row]);
  } else {
    sh.appendRow(row);
    u._row = sh.getLastRow();
  }
}
function log_(action, email, message) {
  try {
    sheet_('Logs', LOG_HEADERS).appendRow([new Date(), action || '', email || '', String(message).slice(0, 500)]);
  } catch (e) { console.error(e); }
}
function withLock_(fn) {
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(15000)) fail_('混み合っています。少し待ってからもう一度お試しください');
  try { return fn(); } finally { lock.releaseLock(); }
}

/* ===================== パスワード・セッション ===================== */
function toHex_(bytes) {
  return bytes.map(b => ('0' + (b & 0xff).toString(16)).slice(-2)).join('');
}
function hash_(password, salt) {
  const pepper = PROPS.getProperty('PEPPER') || '';
  let h = salt + ':' + password + ':' + pepper;
  for (let i = 0; i < HASH_ROUNDS; i++) {
    h = toHex_(Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, h + salt, Utilities.Charset.UTF_8));
  }
  return 'sha256$' + h;
}
function tempPassword_() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789';
  for (;;) {
    const bytes = Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, Utilities.getUuid() + Date.now());
    let s = '';
    for (let i = 0; i < 10; i++) s += chars[(bytes[i] + 256) % chars.length];
    if (PW_RULE.test(s)) return s;
  }
}
function isTrue_(v) { return v === true || String(v).toUpperCase() === 'TRUE'; }
function normEmail_(email) {
  const e = String(email || '').trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e)) fail_('メールアドレスの形式が正しくありません');
  return e;
}
function publicUser_(u) {
  return { userId: u.userId, email: u.email, nickname: u.nickname, mustChange: isTrue_(u.mustChange) };
}
function newSession_(u) {
  const token = (Utilities.getUuid() + Utilities.getUuid()).replace(/-/g, '');
  CacheService.getScriptCache().put('s_' + token, JSON.stringify({ userId: u.userId }), SESSION_TTL_SEC);
  return token;
}
/** トークンを検証して会員を返す。allowMustChange=false なら仮パスワードのままの操作を拒否 */
function auth_(req, allowMustChange) {
  const token = String(req.token || '');
  if (!token) fail_('ログインしてください', 'AUTH');
  const cache = CacheService.getScriptCache();
  const raw = cache.get('s_' + token);
  if (!raw) fail_('ログインの有効期限が切れました。もう一度ログインしてください', 'AUTH');
  const s = JSON.parse(raw);
  const u = findUser_('userId', s.userId);
  if (!u || u.status !== 'active') fail_('このアカウントは利用できません', 'AUTH');
  cache.put('s_' + token, raw, SESSION_TTL_SEC); // 延長
  if (!allowMustChange && isTrue_(u.mustChange)) fail_('先にパスワードを変更してください', 'MUST_CHANGE');
  return u;
}
function sendMail_(to, subject, body) {
  if (MailApp.getRemainingDailyQuota() < 1) fail_('本日のメール送信上限に達しました。明日もう一度お試しください');
  MailApp.sendEmail({ to: to, subject: subject, body: body, name: APP_NAME });
}
function tempMailBody_(nickname, temp) {
  const url = PROPS.getProperty('APP_URL') || '';
  return [
    nickname + ' さん',
    '',
    APP_NAME + ' の仮パスワードをお知らせします。',
    '',
    '仮パスワード：' + temp,
    '',
    'ログインすると、新しいパスワードの設定画面が開きます。',
    url ? 'ログインはこちら：' + url : '',
    '',
    'このメールに心当たりがない場合は、破棄してください。',
    '— ' + APP_NAME
  ].join('\n');
}

/* ===================== 認証API ===================== */
function ping_() {
  return { app: APP_NAME, version: APP_VERSION };
}

function register_(req) {
  const email = normEmail_(req.email);
  const nickname = String(req.nickname || '').trim().slice(0, 30);
  if (!nickname) fail_('ニックネームを入力してください');
  return withLock_(() => {
    if (findUser_('email', email)) fail_('このメールアドレスは登録済みです。ログインするか、仮パスワードを再発行してください');
    const temp = tempPassword_();
    const salt = Utilities.getUuid();
    const u = {
      userId: Utilities.getUuid(), email: email, nickname: nickname,
      passwordHash: hash_(temp, salt), salt: salt, mustChange: true, status: 'active',
      failCount: 0, lockedUntil: '', createdAt: new Date(), lastLoginAt: ''
    };
    sendMail_(email, '【' + APP_NAME + '】仮パスワードのお知らせ', tempMailBody_(nickname, temp)); // 送れたら登録
    saveUser_(u);
    log_('register', email, 'ok');
    return { message: '仮パスワードをメールで送りました。メールを確認してログインしてください' };
  });
}

function login_(req) {
  const email = normEmail_(req.email);
  const password = String(req.password || '');
  return withLock_(() => {
    const u = findUser_('email', email);
    if (!u) fail_('メールアドレスまたはパスワードが違います');
    if (u.status !== 'active') fail_('このアカウントは利用停止中です');
    if (u.lockedUntil && new Date(u.lockedUntil) > new Date()) {
      fail_('ログインに続けて失敗したため、' + Utilities.formatDate(new Date(u.lockedUntil), 'Asia/Tokyo', 'HH:mm') + ' までロックしています');
    }
    if (hash_(password, u.salt) !== u.passwordHash) {
      u.failCount = Number(u.failCount || 0) + 1;
      let msg = 'メールアドレスまたはパスワードが違います（' + u.failCount + '/' + MAX_FAIL + '）';
      if (u.failCount >= MAX_FAIL) {
        u.lockedUntil = new Date(Date.now() + LOCK_MIN * 60000);
        u.failCount = 0;
        msg = 'ログインに' + MAX_FAIL + '回失敗したため、' + LOCK_MIN + '分間ロックしました';
      }
      saveUser_(u);
      log_('login-fail', email, msg);
      fail_(msg);
    }
    u.failCount = 0; u.lockedUntil = ''; u.lastLoginAt = new Date();
    saveUser_(u);
    return { token: newSession_(u), user: publicUser_(u) };
  });
}

function logout_(req) {
  if (req.token) CacheService.getScriptCache().remove('s_' + String(req.token));
  return {};
}

function me_(req) {
  return { user: publicUser_(auth_(req, true)) };
}

function changePassword_(req) {
  const u = auth_(req, true);
  const current = String(req.currentPassword || '');
  const next = String(req.newPassword || '');
  if (hash_(current, u.salt) !== u.passwordHash) fail_('いまのパスワードが違います');
  if (!PW_RULE.test(next)) fail_('新しいパスワードは8文字以上で、英字と数字を両方入れてください');
  if (current === next) fail_('いまと違うパスワードにしてください');
  return withLock_(() => {
    const fresh = findUser_('userId', u.userId);
    fresh.salt = Utilities.getUuid();
    fresh.passwordHash = hash_(next, fresh.salt);
    fresh.mustChange = false;
    fresh.failCount = 0; fresh.lockedUntil = '';
    saveUser_(fresh);
    log_('changePassword', fresh.email, 'ok');
    return { user: publicUser_(fresh) };
  });
}

function resetPassword_(req) {
  const email = normEmail_(req.email);
  const generic = { message: '登録があるメールアドレスなら、新しい仮パスワードを送りました' };
  return withLock_(() => {
    const u = findUser_('email', email);
    if (!u || u.status !== 'active') { log_('reset-miss', email, ''); return generic; }
    const temp = tempPassword_();
    sendMail_(email, '【' + APP_NAME + '】仮パスワードの再発行', tempMailBody_(u.nickname, temp));
    u.salt = Utilities.getUuid();
    u.passwordHash = hash_(temp, u.salt);
    u.mustChange = true; u.failCount = 0; u.lockedUntil = '';
    saveUser_(u);
    log_('resetPassword', email, 'ok');
    return generic;
  });
}

/* ===================== Gemini ===================== */
function gemini_(model, body) {
  const key = PROPS.getProperty('GEMINI_API_KEY');
  if (!key) fail_('GEMINI_API_KEY が未設定です（GASのスクリプトプロパティに追加してください）');
  const url = 'https://generativelanguage.googleapis.com/v1beta/models/' + encodeURIComponent(model) + ':generateContent';
  const res = UrlFetchApp.fetch(url, {
    method: 'post', contentType: 'application/json',
    headers: { 'x-goog-api-key': key },
    payload: JSON.stringify(body), muteHttpExceptions: true
  });
  const code = res.getResponseCode();
  let data;
  try { data = JSON.parse(res.getContentText()); } catch (e) { fail_('Geminiの応答を読み取れませんでした（' + code + '）'); }
  if (code !== 200) fail_('Gemini APIエラー（' + code + '）：' + ((data.error && data.error.message) || '不明'));
  return data;
}
function geminiText_(data) {
  const parts = (((data.candidates || [])[0] || {}).content || {}).parts || [];
  return parts.map(p => p.text || '').join('');
}
function parseJson_(text) {
  const t = String(text || '').replace(/```json|```/g, '').trim();
  try { return JSON.parse(t); } catch (e) {
    const m = t.match(/\{[\s\S]*\}/);
    if (m) { try { return JSON.parse(m[0]); } catch (e2) { /* 下へ */ } }
  }
  fail_('AIの応答を読み取れませんでした。もう一度お試しください');
}
function cleanName_(s) {
  return String(s || '').replace(/[\\/:*?"<>|\s]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 40);
}

function tts_(req) {
  auth_(req);
  const text = String(req.text || '').trim();
  if (!text) fail_('読み上げる文章を入力してください');
  if (text.length > 3000) fail_('文章は3000文字以内にしてください');
  const voice = /^[A-Za-z]{2,20}$/.test(String(req.voice || '')) ? String(req.voice) : 'Kore';
  const style = String(req.style || '').trim().slice(0, 200);
  const prompt = style ? (style + '：\n' + text) : text;
  const model = PROPS.getProperty('GEMINI_TTS_MODEL') || 'gemini-2.5-flash-preview-tts';
  const data = gemini_(model, {
    contents: [{ parts: [{ text: prompt }] }],
    generationConfig: {
      responseModalities: ['AUDIO'],
      speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: voice } } }
    }
  });
  const parts = (((data.candidates || [])[0] || {}).content || {}).parts || [];
  const part = parts.filter(p => p.inlineData && p.inlineData.data)[0];
  if (!part) fail_('音声を作れませんでした。文章を変えてもう一度お試しください');
  const mime = part.inlineData.mimeType || 'audio/L16;rate=24000';
  const m = /rate=(\d+)/.exec(mime);
  return { audio: part.inlineData.data, mimeType: mime, sampleRate: m ? Number(m[1]) : 24000 };
}

function analyze_(req) {
  auth_(req);
  const audio = String(req.audio || '');
  if (!audio) fail_('音声がありません');
  if (audio.length * 0.75 > MAX_AI_AUDIO_BYTES) fail_('音声が長すぎます（目安：10分以内）');
  const mime = String(req.mimeType || 'audio/wav');
  const prompt = [
    'この音声を聞き取り、次のJSONだけを返してください。',
    '{"transcript":"日本語の文字起こし（話し言葉のまま、適宜句読点）",',
    ' "summary":"内容の要約（3文以内）",',
    ' "filename":"内容を表す短いファイル名（30文字以内、拡張子なし、空白や記号は使わず _ と - のみ可）"}',
    '話し声がない場合は transcript を空にし、summary に音の様子（BGM、環境音など）を書いてください。'
  ].join('\n');
  const data = gemini_(PROPS.getProperty('GEMINI_MODEL') || 'gemini-2.5-flash', {
    contents: [{ role: 'user', parts: [{ inlineData: { mimeType: mime, data: audio } }, { text: prompt }] }],
    generationConfig: { responseMimeType: 'application/json', temperature: 0.2 }
  });
  const j = parseJson_(geminiText_(data));
  return { transcript: String(j.transcript || ''), summary: String(j.summary || ''), filename: cleanName_(j.filename) };
}

function suggestName_(req) {
  auth_(req);
  const context = String(req.context || '').slice(0, 4000);
  const project = String(req.project || '').slice(0, 60);
  const prompt = [
    '複数の音声をつないだ完成ファイルの名前を1つ考えてください。',
    project ? 'プロジェクト名：' + project : '',
    '素材の一覧：', context,
    '条件：日本語可、30文字以内、拡張子なし、空白や記号は使わず _ と - のみ可。',
    'JSONだけを返してください：{"filename":"..."}'
  ].join('\n');
  const data = gemini_(PROPS.getProperty('GEMINI_MODEL') || 'gemini-2.5-flash', {
    contents: [{ role: 'user', parts: [{ text: prompt }] }],
    generationConfig: { responseMimeType: 'application/json', temperature: 0.7 }
  });
  const j = parseJson_(geminiText_(data));
  return { filename: cleanName_(j.filename) || 'otsunagi' };
}

/* ===================== Google Drive ===================== */
function rootFolder_() {
  const id = PROPS.getProperty('ROOT_FOLDER_ID');
  if (!id) fail_('保存先フォルダが未設定です（setup を実行してください）');
  return DriveApp.getFolderById(id);
}
function childFolder_(parent, name) {
  const it = parent.getFoldersByName(name);
  return it.hasNext() ? it.next() : parent.createFolder(name);
}
function userFolder_(u, kind) {
  if (KINDS.indexOf(kind) < 0) fail_('保存先の種類が正しくありません');
  return childFolder_(childFolder_(rootFolder_(), u.userId), kind);
}
function tmpFolder_() { return childFolder_(rootFolder_(), '_tmp'); }
function cleanFileName_(s) {
  const n = String(s || '').replace(/[\\/:*?"<>|]+/g, '_').trim().slice(0, 120);
  return n || 'file';
}
function ownedFile_(u, fileId) {
  let file;
  try { file = DriveApp.getFileById(String(fileId)); } catch (e) { fail_('ファイルが見つかりません'); }
  const own = {};
  KINDS.forEach(k => { own[userFolder_(u, k).getId()] = true; });
  const parents = file.getParents();
  while (parents.hasNext()) { if (own[parents.next().getId()]) return file; }
  fail_('このファイルにはアクセスできません');
}

function uploadInit_(req) {
  const u = auth_(req);
  const kind = String(req.kind || 'output');
  userFolder_(u, kind); // 種類の検証
  const total = Number(req.totalChunks);
  if (!(total >= 1 && total <= MAX_CHUNKS)) fail_('ファイルが大きすぎます');
  const uploadId = Utilities.getUuid().replace(/-/g, '');
  CacheService.getScriptCache().put('u_' + uploadId, JSON.stringify({
    userId: u.userId, kind: kind, total: total,
    fileName: cleanFileName_(req.fileName), mimeType: String(req.mimeType || 'application/octet-stream')
  }), UPLOAD_TTL_SEC);
  return { uploadId: uploadId };
}
function uploadMeta_(u, uploadId) {
  const raw = CacheService.getScriptCache().get('u_' + String(uploadId || ''));
  if (!raw) fail_('アップロードの受付が見つかりません。最初からやり直してください');
  const meta = JSON.parse(raw);
  if (meta.userId !== u.userId) fail_('このアップロードにはアクセスできません');
  return meta;
}
function uploadChunk_(req) {
  const u = auth_(req);
  const meta = uploadMeta_(u, req.uploadId);
  const index = Number(req.index);
  if (!(index >= 0 && index < meta.total)) fail_('分割番号が正しくありません');
  const data = String(req.data || '');
  if (!data || data.length > MAX_CHUNK_LEN) fail_('分割データが正しくありません');
  const tmp = tmpFolder_();
  const name = req.uploadId + '_' + index;
  const old = tmp.getFilesByName(name);
  while (old.hasNext()) old.next().setTrashed(true); // 再送時の重複を除去
  tmp.createFile(name, data, MimeType.PLAIN_TEXT);
  return { received: index };
}
function uploadFinish_(req) {
  const u = auth_(req);
  const meta = uploadMeta_(u, req.uploadId);
  const tmp = tmpFolder_();
  const pieces = [];
  const temps = [];
  for (let i = 0; i < meta.total; i++) {
    const it = tmp.getFilesByName(req.uploadId + '_' + i);
    if (!it.hasNext()) fail_('データの一部が届いていません（' + (i + 1) + '/' + meta.total + '）。もう一度保存してください');
    const f = it.next();
    temps.push(f);
    pieces.push(f.getBlob().getDataAsString());
  }
  const bytes = Utilities.base64Decode(pieces.join(''));
  const blob = Utilities.newBlob(bytes, meta.mimeType, meta.fileName);
  const file = userFolder_(u, meta.kind).createFile(blob);
  temps.forEach(f => f.setTrashed(true));
  CacheService.getScriptCache().remove('u_' + req.uploadId);
  return { fileId: file.getId(), name: file.getName(), url: file.getUrl(), size: file.getSize() };
}

function saveText_(req) {
  const u = auth_(req);
  const content = String(req.content || '');
  if (content.length > 5 * 1024 * 1024) fail_('内容が大きすぎます');
  const allowed = ['application/json', 'text/csv', 'text/plain'];
  const mime = allowed.indexOf(req.mimeType) >= 0 ? req.mimeType : 'text/plain';
  const file = userFolder_(u, String(req.kind || 'meta')).createFile(cleanFileName_(req.fileName), content, mime);
  return { fileId: file.getId(), url: file.getUrl() };
}

function listFiles_(req) {
  const u = auth_(req);
  const it = userFolder_(u, String(req.kind || 'output')).getFiles();
  const files = [];
  while (it.hasNext()) {
    const f = it.next();
    if (f.isTrashed()) continue;
    files.push({ id: f.getId(), name: f.getName(), mimeType: f.getMimeType(), size: f.getSize(), updated: f.getLastUpdated().toISOString(), url: f.getUrl() });
  }
  files.sort((a, b) => (a.updated < b.updated ? 1 : -1));
  return { files: files.slice(0, 200) };
}

function getFile_(req) {
  const u = auth_(req);
  const file = ownedFile_(u, req.fileId);
  if (file.getSize() > MAX_GETFILE_BYTES) fail_('ファイルが大きすぎて読み込めません（25MBまで）');
  return { name: file.getName(), mimeType: file.getMimeType(), data: Utilities.base64Encode(file.getBlob().getBytes()) };
}

function deleteFile_(req) {
  const u = auth_(req);
  ownedFile_(u, req.fileId).setTrashed(true);
  return {};
}

/* ===================== 定期掃除（任意：時間主導トリガーで1日1回） ===================== */
function cleanupTmp() {
  const limit = Date.now() - 24 * 3600 * 1000;
  const it = tmpFolder_().getFiles();
  while (it.hasNext()) {
    const f = it.next();
    if (f.getDateCreated().getTime() < limit) f.setTrashed(true);
  }
}
