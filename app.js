/**
 * おとつなぎ — フロントエンド
 * 認証 / 素材管理 / Web Audio 結合 / Gemini TTS・聞き取り / Drive 保存 / Earth Studio 書き出し
 */
'use strict';

/* ========== 基本ユーティリティ ========== */
const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => Array.from(r.querySelectorAll(s));
const KEY = { token: CONFIG.STORAGE_PREFIX + 'token', user: CONFIG.STORAGE_PREFIX + 'user', gas: CONFIG.STORAGE_PREFIX + 'gas_url', helpSeen: CONFIG.STORAGE_PREFIX + 'help_seen' };
const COLORS = ['#3e6b4c', '#a87908', '#2f7480', '#9c4f58', '#5c62a0', '#7a6a3a', '#4f7f6a', '#8a5a2b'];
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const pad = (n, w = 2) => String(n).padStart(w, '0');

function fmtTime(sec) {
  sec = Math.max(0, sec || 0);
  const m = Math.floor(sec / 60), s = sec - m * 60;
  return `${m}:${s.toFixed(1).padStart(4, '0')}`;
}
function timecode(sec, fps) {
  const total = Math.round(sec * fps);
  const f = total % fps, s = Math.floor(total / fps);
  return `${pad(Math.floor(s / 3600))}:${pad(Math.floor(s / 60) % 60)}:${pad(s % 60)}:${pad(f)}`;
}
function srtTime(sec) {
  const ms = Math.round(sec * 1000);
  return `${pad(Math.floor(ms / 3600000))}:${pad(Math.floor(ms / 60000) % 60)}:${pad(Math.floor(ms / 1000) % 60)},${pad(ms % 1000, 3)}`;
}
function fmtBytes(b) {
  b = Number(b) || 0;
  if (b < 1024) return b + ' B';
  if (b < 1048576) return (b / 1024).toFixed(0) + ' KB';
  return (b / 1048576).toFixed(1) + ' MB';
}
function safeName(s) {
  return String(s || '').replace(/[\\/:*?"<>|\s]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 60) || 'otsunagi';
}
function stamp() {
  const d = new Date();
  return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}_${pad(d.getHours())}${pad(d.getMinutes())}`;
}
function blobToBase64(blob) {
  return new Promise((res, rej) => {
    const r = new FileReader();
    r.onload = () => res(String(r.result).split(',')[1] || '');
    r.onerror = () => rej(new Error('ファイルの読み込みに失敗しました'));
    r.readAsDataURL(blob);
  });
}
function base64ToBytes(b64) {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}
function downloadBlob(blob, name) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = name;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 4000);
}

/* ========== 状態 ========== */
const state = {
  token: null,
  user: null,
  clips: [],          // {id,name,source,buffer,blob,gain,color,driveId,ttsText,ttsVoice,transcript,summary,suggest}
  mix: null,          // {buffer, segments:[{clipId,name,color,start,end,text}], params}
  mixBlob: null, mixBlobFmt: null,
  ttsDraft: null,
  clipSeq: 0,
  driveKind: 'clips',
  analyzingClipId: null,
  forcedPw: false,
  videoUrl: null
};

/* ========== トースト・処理中表示 ========== */
function toast(msg, type = 'info') {
  const el = document.createElement('div');
  const tone = type === 'error' ? 'border-danger text-danger' : type === 'ok' ? 'border-moss' : 'border-line';
  el.className = `pointer-events-auto max-w-md rounded-xl border-2 ${tone} bg-panel px-4 py-3 text-sm font-bold shadow-lg`;
  el.textContent = msg;
  $('#toasts').appendChild(el);
  setTimeout(() => { el.style.opacity = '0'; el.style.transition = 'opacity .3s'; }, type === 'error' ? 5200 : 3200);
  setTimeout(() => el.remove(), type === 'error' ? 5600 : 3600);
}
let busyDepth = 0;
function busy(msg) {
  busyDepth++;
  $('#loadingMsg').textContent = msg || '処理しています';
  $('#loadingBarWrap').classList.add('hidden');
  $('#loading').classList.remove('hidden'); $('#loading').classList.add('flex');
}
function progress(p, msg) {
  $('#loadingBarWrap').classList.remove('hidden');
  $('#loadingBar').style.width = Math.round(Math.min(1, Math.max(0, p)) * 100) + '%';
  if (msg) $('#loadingMsg').textContent = msg;
}
function done() {
  busyDepth = Math.max(0, busyDepth - 1);
  if (busyDepth === 0) { $('#loading').classList.add('hidden'); $('#loading').classList.remove('flex'); }
}
async function withBusy(msg, fn) {
  busy(msg);
  try { return await fn(); }
  catch (e) { console.error(e); toast(e.message || String(e), 'error'); }
  finally { done(); }
}

/* ========== モーダル ========== */
function openModal(id) { const m = $(id); m.classList.remove('hidden'); m.classList.add('flex'); }
function closeModal(id) { const m = $(id); m.classList.add('hidden'); m.classList.remove('flex'); }

/* ========== GAS通信 ========== */
function gasUrl() { return (localStorage.getItem(KEY.gas) || '').trim() || CONFIG.GAS_URL; }

async function api(action, payload = {}, { auth = true, url } = {}) {
  const target = url || gasUrl();
  if (!target || /XXXX/.test(target)) {
    openModal('#modalSettings');
    throw new Error('GASのURLが未設定です。接続設定で登録してください');
  }
  const body = Object.assign({ action }, payload);
  if (auth) body.token = state.token;
  let res;
  try {
    res = await fetch(target, {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain;charset=utf-8' }, // プリフライト回避
      body: JSON.stringify(body),
      redirect: 'follow'
    });
  } catch (e) {
    throw new Error('サーバーに接続できません。通信状況とGASのURLを確認してください');
  }
  let data;
  try { data = await res.json(); }
  catch (e) { throw new Error('サーバーの応答を読み取れません。GASのデプロイ設定（アクセス：全員）を確認してください'); }
  if (!data.ok) {
    if (data.code === 'AUTH') { clearSession(); showAuth(); }
    if (data.code === 'MUST_CHANGE') { openPwModal(true); }
    throw new Error(data.error || 'エラーが発生しました');
  }
  return data;
}

/* ========== 認証 ========== */
function saveSession(token, user) {
  state.token = token; state.user = user;
  localStorage.setItem(KEY.token, token);
  localStorage.setItem(KEY.user, JSON.stringify(user));
}
function clearSession() {
  state.token = null; state.user = null;
  localStorage.removeItem(KEY.token); localStorage.removeItem(KEY.user);
  $('#userBox').classList.add('hidden');
}
function showAuth() {
  stopPlayback();
  $('#mainView').classList.add('hidden');
  $('#authView').classList.remove('hidden');
  closeModal('#modalPw');
  setAuthTab('login');
}
function showMain() {
  $('#authView').classList.add('hidden');
  $('#mainView').classList.remove('hidden');
  $('#userBox').classList.remove('hidden');
  $('#userName').textContent = state.user?.nickname || '';
  if (!localStorage.getItem(KEY.helpSeen)) {
    localStorage.setItem(KEY.helpSeen, '1');
    openHelp();
  }
}
function openHelp() {
  openModal('#modalHelp');
  const body = $('#modalHelp .overflow-y-auto');
  if (body) body.scrollTop = 0;
}
function afterLogin() {
  if (state.user?.mustChange) {
    $('#authView').classList.add('hidden');
    $('#mainView').classList.add('hidden');
    openPwModal(true);
  } else {
    showMain();
  }
}
function setAuthTab(tab) {
  $$('.auth-tab').forEach(b => {
    const on = b.dataset.tab === tab;
    b.classList.toggle('bg-panel', on); b.classList.toggle('text-sub', !on);
    b.setAttribute('aria-selected', on);
  });
  $$('.auth-pane').forEach(p => p.classList.toggle('hidden', p.dataset.pane !== tab));
}
function openPwModal(forced) {
  state.forcedPw = !!forced;
  $('#pwForm').reset();
  $$('#pwForm input').forEach(i => { i.type = 'password'; });
  refreshPwToggles();
  $('#pwCloseBtn').classList.toggle('hidden', forced);
  $('#pwForcedNote').classList.toggle('hidden', !forced);
  $('#pwLogoutBtn').classList.toggle('hidden', !forced);
  openModal('#modalPw');
  setTimeout(() => $('#pwCurrent').focus(), 50);
}
const PW_RULE = /^(?=.*[A-Za-z])(?=.*\d).{8,64}$/;

const EYE = '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M2 12s3.6-7 10-7 10 7 10 7-3.6 7-10 7S2 12 2 12z"/><circle cx="12" cy="12" r="3"/></svg>';
const EYE_OFF = '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M3 3l18 18"/><path d="M10.6 5.1A10 10 0 0 1 12 5c6.4 0 10 7 10 7a17 17 0 0 1-3.2 4M6.6 6.6C3.7 8.4 2 12 2 12s3.6 7 10 7a9.6 9.6 0 0 0 5.4-1.6"/><path d="M9.9 9.9a3 3 0 0 0 4.2 4.2"/></svg>';
function refreshPwToggles() {
  $$('.pw-toggle').forEach(btn => {
    const input = document.getElementById(btn.dataset.target);
    const shown = input.type === 'text';
    btn.innerHTML = shown ? EYE_OFF : EYE;
    btn.setAttribute('aria-label', shown ? 'パスワードを隠す' : 'パスワードを表示');
  });
}

async function onLogin(e) {
  e.preventDefault();
  await withBusy('ログインしています', async () => {
    const r = await api('login', { email: $('#loginEmail').value.trim(), password: $('#loginPw').value }, { auth: false });
    saveSession(r.token, r.user);
    $('#loginPw').value = '';
    afterLogin();
    if (!r.user.mustChange) toast(`${r.user.nickname}さん、おかえりなさい`, 'ok');
  });
}
async function onRegister(e) {
  e.preventDefault();
  await withBusy('登録しています', async () => {
    const r = await api('register', { email: $('#regEmail').value.trim(), nickname: $('#regNick').value.trim() }, { auth: false });
    toast(r.message, 'ok');
    $('#loginEmail').value = $('#regEmail').value.trim();
    $('#registerForm').reset();
    setAuthTab('login');
  });
}
async function onReset(e) {
  e.preventDefault();
  await withBusy('再発行しています', async () => {
    const r = await api('resetPassword', { email: $('#resetEmail').value.trim() }, { auth: false });
    toast(r.message, 'ok');
    $('#loginEmail').value = $('#resetEmail').value.trim();
    $('#resetForm').reset();
    setAuthTab('login');
  });
}
async function onChangePw(e) {
  e.preventDefault();
  const cur = $('#pwCurrent').value, nw = $('#pwNew').value, cf = $('#pwConfirm').value;
  if (!PW_RULE.test(nw)) return toast('新しいパスワードは8文字以上で、英字と数字を両方入れてください', 'error');
  if (nw !== cf) return toast('確認用のパスワードが一致しません', 'error');
  if (nw === cur) return toast('いまと違うパスワードにしてください', 'error');
  await withBusy('パスワードを変更しています', async () => {
    const r = await api('changePassword', { currentPassword: cur, newPassword: nw });
    saveSession(state.token, r.user);
    closeModal('#modalPw');
    state.forcedPw = false;
    showMain();
    toast('パスワードを変更しました', 'ok');
  });
}
async function logout() {
  try { await api('logout'); } catch (e) { /* 失敗しても端末側は消す */ }
  clearSession();
  showAuth();
  toast('ログアウトしました');
}
async function restoreSession() {
  const t = localStorage.getItem(KEY.token);
  if (!t) return showAuth();
  state.token = t;
  try { state.user = JSON.parse(localStorage.getItem(KEY.user) || 'null'); } catch (e) { state.user = null; }
  busy('ログイン状態を確認しています');
  try {
    const r = await api('me');
    saveSession(t, r.user);
    afterLogin();
  } catch (e) {
    clearSession(); showAuth();
  } finally { done(); }
}

/* ========== Web Audio ========== */
let _ctx = null;
function audioCtx() {
  if (!_ctx) _ctx = new (window.AudioContext || window.webkitAudioContext)();
  if (_ctx.state === 'suspended') _ctx.resume();
  return _ctx;
}
async function decodeAudio(arrayBuffer) {
  return await new Promise((res, rej) => {
    const p = audioCtx().decodeAudioData(arrayBuffer.slice(0), res, () => rej(new Error('この音声形式は読み込めません')));
    if (p && p.then) p.then(res, () => rej(new Error('この音声形式は読み込めません')));
  });
}
function pcm16ToBuffer(b64, sampleRate) {
  const bytes = base64ToBytes(b64);
  const n = bytes.length >> 1;
  const buf = audioCtx().createBuffer(1, n, sampleRate);
  const d = buf.getChannelData(0);
  const dv = new DataView(bytes.buffer);
  for (let i = 0; i < n; i++) d[i] = dv.getInt16(i * 2, true) / 32768;
  return buf;
}
function encodeWav(buffer) {
  const ch = buffer.numberOfChannels, sr = buffer.sampleRate, len = buffer.length;
  const dataLen = len * ch * 2;
  const ab = new ArrayBuffer(44 + dataLen);
  const v = new DataView(ab);
  const w = (o, s) => { for (let i = 0; i < s.length; i++) v.setUint8(o + i, s.charCodeAt(i)); };
  w(0, 'RIFF'); v.setUint32(4, 36 + dataLen, true); w(8, 'WAVE'); w(12, 'fmt ');
  v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, ch, true);
  v.setUint32(24, sr, true); v.setUint32(28, sr * ch * 2, true); v.setUint16(32, ch * 2, true); v.setUint16(34, 16, true);
  w(36, 'data'); v.setUint32(40, dataLen, true);
  const chans = []; for (let c = 0; c < ch; c++) chans.push(buffer.getChannelData(c));
  let o = 44;
  for (let i = 0; i < len; i++) {
    for (let c = 0; c < ch; c++) {
      const s = Math.max(-1, Math.min(1, chans[c][i]));
      v.setInt16(o, s < 0 ? s * 0x8000 : s * 0x7fff, true); o += 2;
    }
  }
  return new Blob([ab], { type: 'audio/wav' });
}
function floatTo16(f32) {
  const out = new Int16Array(f32.length);
  for (let i = 0; i < f32.length; i++) { const s = Math.max(-1, Math.min(1, f32[i])); out[i] = s < 0 ? s * 0x8000 : s * 0x7fff; }
  return out;
}
async function encodeMp3(buffer, kbps, onProgress) {
  const ch = Math.min(2, buffer.numberOfChannels);
  const enc = new lamejs.Mp3Encoder(ch, buffer.sampleRate, kbps);
  const L = floatTo16(buffer.getChannelData(0));
  const R = ch > 1 ? floatTo16(buffer.getChannelData(1)) : null;
  const block = 1152 * 16, parts = [];
  for (let i = 0, n = 0; i < L.length; i += block, n++) {
    const out = R ? enc.encodeBuffer(L.subarray(i, i + block), R.subarray(i, i + block)) : enc.encodeBuffer(L.subarray(i, i + block));
    if (out.length) parts.push(new Uint8Array(out));
    if (n % 40 === 0) { onProgress && onProgress(i / L.length); await sleep(0); }
  }
  const end = enc.flush();
  if (end.length) parts.push(new Uint8Array(end));
  return new Blob(parts, { type: 'audio/mpeg' });
}
async function toAnalysisWav(buffer) {
  const sr = 16000;
  const off = new OfflineAudioContext(1, Math.max(1, Math.ceil(buffer.duration * sr)), sr);
  const s = off.createBufferSource(); s.buffer = buffer; s.connect(off.destination); s.start();
  return encodeWav(await off.startRendering());
}

/* 再生（1系統だけ） */
const player = { src: null, buffer: null, startedAt: 0, offset: 0, raf: 0, onTick: null, onEnd: null, kind: null, clipId: null };
function playBuffer(buffer, { offset = 0, gain = 1, onTick, onEnd, kind, clipId } = {}) {
  stopPlayback();
  const c = audioCtx();
  const src = c.createBufferSource(); src.buffer = buffer;
  const g = c.createGain(); g.gain.value = gain;
  src.connect(g).connect(c.destination);
  offset = Math.min(Math.max(0, offset), Math.max(0, buffer.duration - 0.01));
  src.start(0, offset);
  Object.assign(player, { src, buffer, startedAt: c.currentTime, offset, onTick, onEnd, kind, clipId });
  src.onended = () => { if (player.src === src) stopPlayback(true); };
  const loop = () => { if (player.src !== src) return; onTick && onTick(playerTime()); player.raf = requestAnimationFrame(loop); };
  player.raf = requestAnimationFrame(loop);
}
function playerTime() { return player.src ? player.offset + (audioCtx().currentTime - player.startedAt) : player.offset; }
function stopPlayback(ended) {
  cancelAnimationFrame(player.raf);
  if (player.src) {
    const s = player.src; player.src = null; s.onended = null;
    try { s.stop(); } catch (e) { /* 既に停止 */ }
  }
  const cb = player.onEnd; player.onEnd = null; player.kind = null; player.clipId = null;
  if (cb) cb(!!ended);
}

/* ========== 素材トラック ========== */
const AUDIO_EXT = /\.(mp3|wav|m4a|aac|ogg|oga|flac|webm|opus)$/i;

function newClip(props) {
  const id = ++state.clipSeq;
  return Object.assign({ id, gain: 1, color: COLORS[(id - 1) % COLORS.length], source: 'file', transcript: '', summary: '', suggest: '' }, props);
}
async function addFiles(fileList) {
  const files = Array.from(fileList || []).filter(f => (f.type || '').startsWith('audio') || AUDIO_EXT.test(f.name));
  if (!files.length) return toast('音声ファイルを選んでください', 'error');
  await withBusy('音声を読み込んでいます', async () => {
    let ok = 0;
    for (let i = 0; i < files.length; i++) {
      const f = files[i];
      progress(i / files.length, `読み込み中（${i + 1}/${files.length}）`);
      try {
        const buffer = await decodeAudio(await f.arrayBuffer());
        state.clips.push(newClip({ name: f.name.replace(/\.[^.]+$/, ''), buffer, blob: f, ext: (f.name.match(/\.[^.]+$/) || ['.wav'])[0].toLowerCase() }));
        ok++;
      } catch (e) { toast(`${f.name}：${e.message}`, 'error'); }
    }
    progress(1);
    if (ok) { invalidateMix(); renderClips(); toast(`${ok}件の素材を追加しました`, 'ok'); }
  });
}

const ICON = {
  play: '<svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor"><path d="M7 4l13 8-13 8z"/></svg>',
  stop: '<svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor"><rect x="6" y="6" width="12" height="12" rx="1"/></svg>',
  up: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M6 15l6-6 6 6"/></svg>',
  down: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M6 9l6 6 6-6"/></svg>',
  ai: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M4 12h2M8 8v8M12 5v14M16 8v8M20 12h-2"/></svg>',
  del: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M6 6l12 12M18 6L6 18"/></svg>',
  grip: '<svg width="14" height="20" viewBox="0 0 14 20" fill="currentColor"><circle cx="4" cy="4" r="1.6"/><circle cx="10" cy="4" r="1.6"/><circle cx="4" cy="10" r="1.6"/><circle cx="10" cy="10" r="1.6"/><circle cx="4" cy="16" r="1.6"/><circle cx="10" cy="16" r="1.6"/></svg>'
};
const SOURCE_LABEL = { file: 'ファイル', tts: '読み上げ', drive: 'Drive' };

function renderClips() {
  const list = $('#clipList');
  const total = state.clips.reduce((a, c) => a + c.buffer.duration, 0);
  $('#trackSummary').textContent = state.clips.length ? `${state.clips.length}件・合計 ${fmtTime(total)}` : 'まだ素材がありません';
  if (!state.clips.length) {
    list.innerHTML = '<li class="rounded-xl bg-paper p-4 text-center text-sm text-sub">上の枠に音声を入れるか、読み上げ音声を作ると、ここに並びます。</li>';
    return;
  }
  list.innerHTML = state.clips.map((c, i) => {
    const playing = player.kind === 'clip' && player.clipId === c.id;
    return `
    <li class="clip rounded-xl border border-line bg-panel p-3" draggable="true" data-id="${c.id}">
      <div class="flex items-center gap-2">
        <span class="cursor-grab text-sub" title="ドラッグで並び替え" aria-hidden="true">${ICON.grip}</span>
        <span class="num w-6 text-center text-sm font-bold text-sub">${i + 1}</span>
        <span class="h-8 w-1.5 shrink-0 rounded-full" style="background:${c.color}"></span>
        <input class="clip-name field min-w-0 flex-1 py-1.5 text-sm font-bold" value="${esc(c.name)}" aria-label="素材の名前">
        <span class="num hidden shrink-0 text-sm text-sub sm:inline">${fmtTime(c.buffer.duration)}</span>
      </div>
      <div class="mt-2 flex flex-wrap items-center gap-2 pl-8">
        <span class="rounded-md bg-paper px-2 py-0.5 text-xs font-bold text-sub">${SOURCE_LABEL[c.source] || ''}${c.driveId ? '・保存済' : ''}</span>
        <span class="num text-xs text-sub sm:hidden">${fmtTime(c.buffer.duration)}</span>
        <label class="flex items-center gap-1 text-xs text-sub">音量
          <input type="range" class="clip-gain w-20" min="0" max="2" step="0.05" value="${c.gain}" aria-label="音量">
          <span class="num w-9">${Math.round(c.gain * 100)}%</span></label>
        <div class="ml-auto flex gap-1">
          <button class="icon-btn" data-act="play" aria-label="${playing ? '停止' : '試聴'}" title="試聴">${playing ? ICON.stop : ICON.play}</button>
          <button class="icon-btn" data-act="up" aria-label="上へ" title="上へ" ${i === 0 ? 'disabled' : ''}>${ICON.up}</button>
          <button class="icon-btn" data-act="down" aria-label="下へ" title="下へ" ${i === state.clips.length - 1 ? 'disabled' : ''}>${ICON.down}</button>
          <button class="icon-btn" data-act="ai" aria-label="AIで聞き取り" title="AIで聞き取り（文字起こし・要約・名前）">${ICON.ai}</button>
          <button class="icon-btn text-danger" data-act="del" aria-label="外す" title="外す">${ICON.del}</button>
        </div>
      </div>
      ${c.summary ? `<button class="mt-2 block w-full truncate pl-8 text-left text-xs text-sub underline decoration-dotted" data-act="info">要約：${esc(c.summary)}</button>` : ''}
    </li>`;
  }).join('');
}
function findClip(id) { return state.clips.find(c => c.id === Number(id)); }
function moveClip(from, to) {
  if (to < 0 || to >= state.clips.length || from === to) return;
  const [c] = state.clips.splice(from, 1);
  state.clips.splice(to, 0, c);
  invalidateMix(); renderClips();
}

function bindClipList() {
  const list = $('#clipList');
  list.addEventListener('click', async (e) => {
    const btn = e.target.closest('[data-act]'); if (!btn) return;
    const li = btn.closest('.clip'); const clip = findClip(li.dataset.id);
    const idx = state.clips.indexOf(clip);
    switch (btn.dataset.act) {
      case 'play':
        if (player.kind === 'clip' && player.clipId === clip.id) { stopPlayback(); }
        else { playBuffer(clip.buffer, { gain: clip.gain, kind: 'clip', clipId: clip.id, onEnd: () => renderClips() }); renderClips(); updateMixPlayBtn(); }
        break;
      case 'up': moveClip(idx, idx - 1); break;
      case 'down': moveClip(idx, idx + 1); break;
      case 'del':
        if (player.clipId === clip.id) stopPlayback();
        state.clips.splice(idx, 1); invalidateMix(); renderClips(); break;
      case 'ai': await analyzeClip(clip); break;
      case 'info': showClipInfo(clip); break;
    }
  });
  list.addEventListener('change', (e) => {
    const li = e.target.closest('.clip'); if (!li) return;
    const clip = findClip(li.dataset.id);
    if (e.target.classList.contains('clip-name')) { clip.name = e.target.value.trim() || clip.name; invalidateMix(); }
  });
  list.addEventListener('input', (e) => {
    if (!e.target.classList.contains('clip-gain')) return;
    const clip = findClip(e.target.closest('.clip').dataset.id);
    clip.gain = Number(e.target.value);
    e.target.nextElementSibling.textContent = Math.round(clip.gain * 100) + '%';
    invalidateMix(true);
  });
  // ドラッグ並び替え（PC）
  let dragId = null;
  list.addEventListener('dragstart', (e) => {
    const li = e.target.closest('.clip'); if (!li || e.target.tagName === 'INPUT') return;
    dragId = Number(li.dataset.id); li.classList.add('dragging');
    e.dataTransfer.effectAllowed = 'move'; e.dataTransfer.setData('text/plain', String(dragId));
  });
  list.addEventListener('dragover', (e) => {
    if (dragId == null) return;
    e.preventDefault();
    $$('.clip', list).forEach(el => el.classList.remove('drag-over'));
    const li = e.target.closest('.clip'); if (li) li.classList.add('drag-over');
  });
  list.addEventListener('drop', (e) => {
    if (dragId == null) return;
    e.preventDefault();
    const li = e.target.closest('.clip');
    if (li) {
      const from = state.clips.findIndex(c => c.id === dragId);
      const to = state.clips.findIndex(c => c.id === Number(li.dataset.id));
      moveClip(from, to);
    }
  });
  list.addEventListener('dragend', () => { dragId = null; $$('.clip', list).forEach(el => el.classList.remove('drag-over', 'dragging')); });
}

/* ========== 結合 ========== */
function mixParams() {
  return {
    gap: Math.max(0, Number($('#optGap').value) || 0),
    fadeMs: Math.max(0, Number($('#optFade').value) || 0),
    sampleRate: Number($('#optRate').value) || 44100,
    channels: Number($('#optCh').value) || 2,
    format: $('#optFormat').value
  };
}
function invalidateMix(keepPlaying) {
  if (!state.mix) return;
  if (!keepPlaying || player.kind === 'mix') { if (player.kind === 'mix') stopPlayback(); }
  state.mix = null; state.mixBlob = null; state.mixBlobFmt = null;
  $('#mixResult').classList.add('hidden');
  $('#savedLink').classList.add('hidden');
  updateEarthInfo();
}
async function renderMix(p) {
  let t = 0;
  const segs = state.clips.map((c, i) => {
    const s = { clipId: c.id, name: c.name, color: c.color, start: t, end: t + c.buffer.duration, text: c.transcript || c.summary || c.name };
    t += c.buffer.duration + (i < state.clips.length - 1 ? p.gap : 0);
    return s;
  });
  const length = Math.max(1, Math.ceil(t * p.sampleRate));
  const off = new OfflineAudioContext(p.channels, length, p.sampleRate);
  state.clips.forEach((c, i) => {
    const s = segs[i];
    const src = off.createBufferSource(); src.buffer = c.buffer;
    const g = off.createGain();
    const f = Math.min(p.fadeMs / 1000, c.buffer.duration / 2);
    if (f > 0) {
      g.gain.setValueAtTime(0, s.start);
      g.gain.linearRampToValueAtTime(c.gain, s.start + f);
      g.gain.setValueAtTime(c.gain, s.end - f);
      g.gain.linearRampToValueAtTime(0, s.end);
    } else {
      g.gain.value = c.gain;
    }
    src.connect(g).connect(off.destination);
    src.start(s.start);
  });
  const buffer = await off.startRendering();
  return { buffer, segments: segs, params: p, duration: t };
}
async function doMix() {
  if (!state.clips.length) return toast('先に素材を追加してください', 'error');
  stopPlayback();
  await withBusy('音声をつないでいます', async () => {
    state.mix = await renderMix(mixParams());
    state.mixBlob = null; state.mixBlobFmt = null;
    if (!$('#mixName').value.trim()) $('#mixName').value = safeName($('#projectName').value.trim() || 'otsunagi_' + stamp());
    $('#mixResult').classList.remove('hidden');
    $('#savedLink').classList.add('hidden');
    renderReel();
    updatePlayhead(0);
    updateEarthInfo();
    updateMixPlayBtn();
    toast(`つなぎました（${fmtTime(state.mix.duration)}）`, 'ok');
  });
}
function renderReel() {
  const reel = $('#reel'); const m = state.mix; if (!m) return;
  const D = m.duration || 1;
  let html = '';
  m.segments.forEach((s, i) => {
    const l = (s.start / D) * 100, w = ((s.end - s.start) / D) * 100;
    html += `<div class="seg" data-i="${i}" style="left:${l}%;width:${w}%;background:${s.color}"><span>${esc(s.name)}</span></div>`;
    if (i > 0) html += `<div class="splice" style="left:${l}%"></div>`;
  });
  html += '<div id="playhead" class="playhead" style="left:0"></div>';
  reel.innerHTML = html;
  reel.setAttribute('aria-valuemax', D.toFixed(1));
  $('#mixTotal').textContent = fmtTime(D);
}
function updatePlayhead(t) {
  const m = state.mix; if (!m) return;
  const D = m.duration || 1;
  const ph = $('#playhead'); if (ph) ph.style.left = Math.min(100, (t / D) * 100) + '%';
  $('#mixNow').textContent = fmtTime(t);
  $('#reel').setAttribute('aria-valuenow', t.toFixed(1));
  const idx = m.segments.findIndex(s => t >= s.start && t < s.end);
  $$('#reel .seg').forEach(el => el.classList.toggle('active', Number(el.dataset.i) === idx));
  $('#mixNowClip').textContent = idx >= 0 ? m.segments[idx].name : '';
  syncVideo(t);
}
function updateMixPlayBtn() {
  const on = player.kind === 'mix';
  $('#playMixBtn').innerHTML = (on ? ICON.stop + '停止' : ICON.play + '再生');
}
function playMix(offset) {
  if (!state.mix) return;
  playBuffer(state.mix.buffer, {
    offset, kind: 'mix',
    onTick: updatePlayhead,
    onEnd: (ended) => {
      player.offset = ended ? 0 : player.offset;
      if (ended) updatePlayhead(state.mix ? state.mix.duration : 0);
      pauseVideo(); updateMixPlayBtn();
    }
  });
  playVideo(offset);
  updateMixPlayBtn(); renderClips();
}
function toggleMix() {
  if (player.kind === 'mix') {
    const t = playerTime(); stopPlayback(); player.offset = t;
  } else {
    let start = player.offset || 0;
    if (state.mix && start >= state.mix.duration - 0.05) start = 0;
    playMix(start);
  }
}
function seekReel(clientX) {
  const m = state.mix; if (!m) return;
  const r = $('#reel').getBoundingClientRect();
  const t = Math.max(0, Math.min(1, (clientX - r.left) / r.width)) * m.duration;
  if (player.kind === 'mix') playMix(t);
  else { player.offset = t; updatePlayhead(t); }
}

async function getMixBlob() {
  const m = state.mix;
  if (!m) throw new Error('先に「つなげて試聴する」を押してください');
  let fmt = m.params.format;
  if (fmt === 'mp3' && typeof lamejs === 'undefined') { fmt = 'wav'; toast('MP3変換ライブラリを読み込めないため、WAVで書き出します'); }
  if (state.mixBlob && state.mixBlobFmt === fmt) return { blob: state.mixBlob, ext: fmt === 'mp3' ? '.mp3' : '.wav' };
  let blob;
  if (fmt === 'mp3') {
    progress(0, 'MP3に変換しています');
    blob = await encodeMp3(m.buffer, CONFIG.MP3_KBPS, p => progress(p, 'MP3に変換しています'));
  } else {
    blob = encodeWav(m.buffer);
  }
  state.mixBlob = blob; state.mixBlobFmt = fmt;
  return { blob, ext: fmt === 'mp3' ? '.mp3' : '.wav' };
}
async function downloadMix() {
  await withBusy('ファイルを用意しています', async () => {
    const { blob, ext } = await getMixBlob();
    downloadBlob(blob, safeName($('#mixName').value) + ext);
  });
}

/* ========== Drive アップロード（分割） ========== */
async function uploadBlob(blob, fileName, kind, label) {
  if (blob.size > CONFIG.MAX_UPLOAD_MB * 1048576) {
    throw new Error(`${fileName} は ${fmtBytes(blob.size)} あり、上限（${CONFIG.MAX_UPLOAD_MB}MB）を超えています。MP3・モノラルにすると小さくなります`);
  }
  const b64 = await blobToBase64(blob);
  const size = CONFIG.UPLOAD_CHUNK_SIZE;
  const total = Math.max(1, Math.ceil(b64.length / size));
  const init = await api('uploadInit', { fileName, mimeType: blob.type || 'application/octet-stream', totalChunks: total, kind });
  for (let i = 0; i < total; i++) {
    progress(i / (total + 1), `${label || 'Driveに保存しています'}（${i + 1}/${total}）`);
    await api('uploadChunk', { uploadId: init.uploadId, index: i, data: b64.slice(i * size, (i + 1) * size) });
  }
  progress(total / (total + 1), label || 'Driveに保存しています');
  const fin = await api('uploadFinish', { uploadId: init.uploadId });
  progress(1);
  return fin;
}
async function saveMixToDrive() {
  if (!state.mix) return toast('先に「つなげて試聴する」を押してください', 'error');
  await withBusy('Driveに保存しています', async () => {
    const { blob, ext } = await getMixBlob();
    const base = safeName($('#mixName').value);
    const fin = await uploadBlob(blob, base + ext, 'output', '完成音声を保存しています');
    await api('saveText', { kind: 'meta', fileName: base + '_earthstudio.json', mimeType: 'application/json', content: JSON.stringify(buildMeta(), null, 2) });
    const a = $('#savedLink'); a.href = fin.url; a.classList.remove('hidden');
    toast('Driveに保存しました（タイムコードも一緒に保存）', 'ok');
  });
}

/* ========== AI（Gemini） ========== */
async function analyzeClip(clip) {
  await withBusy('AIが聞き取っています', async () => {
    const wav = await toAnalysisWav(clip.buffer);
    if (wav.size > CONFIG.MAX_AI_AUDIO_MB * 1048576) throw new Error('長すぎるため聞き取れません（目安：10分以内）');
    const r = await api('analyze', { audio: await blobToBase64(wav), mimeType: 'audio/wav' });
    clip.transcript = r.transcript || ''; clip.summary = r.summary || ''; clip.suggest = r.filename || '';
    invalidateMix(true);
    renderClips();
    showClipInfo(clip);
  });
}
function showClipInfo(clip) {
  state.analyzingClipId = clip.id;
  $('#clipSuggest').textContent = clip.suggest || '（提案なし）';
  $('#applyClipNameBtn').disabled = !clip.suggest;
  $('#clipSummary').textContent = clip.summary || '（要約なし）';
  $('#clipTranscript').textContent = clip.transcript || '（聞き取れる言葉がありませんでした）';
  openModal('#modalClip');
}
async function suggestMixName() {
  if (!state.clips.length) return;
  await withBusy('AIが名前を考えています', async () => {
    const context = state.clips.map((c, i) => `${i + 1}. ${c.name}${c.summary ? '：' + c.summary : (c.ttsText ? '：' + c.ttsText.slice(0, 120) : '')}`).join('\n');
    const r = await api('suggestName', { context, project: $('#projectName').value.trim() });
    $('#mixName').value = safeName(r.filename);
    toast('名前を提案しました', 'ok');
  });
}

/* 読み上げ音声 */
function openTts() {
  state.ttsDraft = null;
  $('#ttsResult').classList.add('hidden'); $('#ttsResult').classList.remove('flex');
  openModal('#modalTts');
  setTimeout(() => $('#ttsText').focus(), 50);
}
async function generateTts() {
  const text = $('#ttsText').value.trim();
  if (!text) return toast('読み上げる文章を入力してください', 'error');
  await withBusy('音声を作っています', async () => {
    const r = await api('tts', { text, voice: $('#ttsVoice').value, style: $('#ttsStyle').value.trim() });
    let buffer;
    if (/wav|mpeg|mp3|ogg/i.test(r.mimeType)) buffer = await decodeAudio(base64ToBytes(r.audio).buffer);
    else buffer = pcm16ToBuffer(r.audio, r.sampleRate || 24000);
    state.ttsDraft = { buffer, text, voice: $('#ttsVoice').value };
    $('#ttsDur').textContent = `長さ ${fmtTime(buffer.duration)}`;
    $('#ttsResult').classList.remove('hidden'); $('#ttsResult').classList.add('flex');
    playBuffer(buffer, { kind: 'tts' });
  });
}
function addTtsClip() {
  const d = state.ttsDraft; if (!d) return;
  stopPlayback();
  state.clips.push(newClip({ name: d.text.replace(/\s+/g, ' ').slice(0, 20), source: 'tts', buffer: d.buffer, blob: null, ext: '.wav', ttsText: d.text, ttsVoice: d.voice, transcript: d.text }));
  state.ttsDraft = null;
  closeModal('#modalTts');
  $('#ttsText').value = ''; $('#ttsCount').textContent = '0';
  invalidateMix(); renderClips();
  toast('読み上げ音声をトラックに追加しました', 'ok');
}

/* ========== Google Earth Studio 連携 ========== */
function esParams() {
  return { fps: Number($('#esFps').value) || CONFIG.DEFAULT_FPS, offset: Math.max(0, Number($('#esOffset').value) || 0) };
}
function buildMeta() {
  const m = state.mix; if (!m) throw new Error('先に「つなげて試聴する」を押してください');
  const { fps, offset } = esParams();
  const end = offset + m.duration;
  return {
    format: 'otsunagi-earthstudio-timeline',
    app: CONFIG.APP_NAME, version: CONFIG.VERSION, createdAt: new Date().toISOString(),
    project: $('#projectName').value.trim(),
    audioFile: safeName($('#mixName').value) + (m.params.format === 'mp3' ? '.mp3' : '.wav'),
    earthStudio: {
      fps, audioOffsetSec: offset,
      totalFrames: Math.ceil(end * fps),
      durationSec: Number(end.toFixed(3)),
      durationTimecode: timecode(end, fps)
    },
    audio: { sampleRate: m.params.sampleRate, channels: m.params.channels, gapSec: m.params.gap, fadeMs: m.params.fadeMs },
    clips: m.segments.map((s, i) => ({
      index: i + 1, name: s.name,
      startSec: Number((s.start + offset).toFixed(3)), endSec: Number((s.end + offset).toFixed(3)),
      durationSec: Number((s.end - s.start).toFixed(3)),
      startTimecode: timecode(s.start + offset, fps), endTimecode: timecode(s.end + offset, fps),
      startFrame: Math.round((s.start + offset) * fps), endFrame: Math.round((s.end + offset) * fps),
      text: s.text
    }))
  };
}
function metaToCsv(meta) {
  const q = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;
  const rows = [['No', '名前', '開始TC', '終了TC', '開始フレーム', '終了フレーム', '開始秒', '終了秒', '長さ秒', 'テキスト']];
  meta.clips.forEach(c => rows.push([c.index, c.name, c.startTimecode, c.endTimecode, c.startFrame, c.endFrame, c.startSec, c.endSec, c.durationSec, c.text]));
  return '\uFEFF' + rows.map(r => r.map(q).join(',')).join('\r\n');
}
function metaToSrt(meta) {
  return meta.clips.map(c => `${c.index}\n${srtTime(c.startSec)} --> ${srtTime(c.endSec)}\n${String(c.text || c.name).replace(/\n{2,}/g, '\n')}\n`).join('\n');
}
function exportMeta(fmt) {
  try {
    const meta = buildMeta();
    const base = safeName($('#mixName').value) + '_earthstudio';
    if (fmt === 'json') downloadBlob(new Blob([JSON.stringify(meta, null, 2)], { type: 'application/json' }), base + '.json');
    if (fmt === 'csv') downloadBlob(new Blob([metaToCsv(meta)], { type: 'text/csv' }), base + '.csv');
    if (fmt === 'srt') downloadBlob(new Blob([metaToSrt(meta)], { type: 'text/plain' }), base + '.srt');
  } catch (e) { toast(e.message, 'error'); }
}
async function saveMetaToDrive() {
  if (!state.mix) return toast('先に「つなげて試聴する」を押してください', 'error');
  await withBusy('書き出しファイルを保存しています', async () => {
    const meta = buildMeta();
    const base = safeName($('#mixName').value) + '_earthstudio';
    await api('saveText', { kind: 'meta', fileName: base + '.json', mimeType: 'application/json', content: JSON.stringify(meta, null, 2) });
    await api('saveText', { kind: 'meta', fileName: base + '.csv', mimeType: 'text/csv', content: metaToCsv(meta) });
    await api('saveText', { kind: 'meta', fileName: base + '.srt', mimeType: 'text/plain', content: metaToSrt(meta) });
    toast('JSON・CSV・SRTをDriveに保存しました', 'ok');
  });
}
function updateEarthInfo() {
  const m = state.mix;
  if (!m) { $('#esFrames').textContent = '—'; $('#esTc').textContent = '（先につないでください）'; return; }
  const { fps, offset } = esParams();
  const end = offset + m.duration;
  $('#esFrames').textContent = Math.ceil(end * fps).toLocaleString();
  $('#esTc').textContent = `（${timecode(end, fps)}）`;
}
function loadVideo(file) {
  const v = $('#esVideo');
  if (state.videoUrl) URL.revokeObjectURL(state.videoUrl);
  if (!file) { v.classList.add('hidden'); v.removeAttribute('src'); state.videoUrl = null; return; }
  state.videoUrl = URL.createObjectURL(file);
  v.src = state.videoUrl; v.classList.remove('hidden');
  toast('「再生」で音声と一緒に動きます');
}
function videoTimeFor(t) { return t + esParams().offset; }
function playVideo(t) {
  const v = $('#esVideo'); if (!state.videoUrl) return;
  try { v.currentTime = videoTimeFor(t); v.play().catch(() => {}); } catch (e) { /* 読み込み前 */ }
}
function pauseVideo() { const v = $('#esVideo'); if (state.videoUrl) v.pause(); }
function syncVideo(t) {
  const v = $('#esVideo'); if (!state.videoUrl || player.kind !== 'mix' || v.paused) return;
  const target = videoTimeFor(t);
  if (Math.abs(v.currentTime - target) > 0.25) v.currentTime = target;
}

/* ========== Drive ブラウザ ========== */
async function openDrive(kind) {
  state.driveKind = kind;
  $$('.drive-tab').forEach(b => { const on = b.dataset.kind === kind; b.classList.toggle('bg-panel', on); b.classList.toggle('text-sub', !on); });
  openModal('#modalDrive');
  const ul = $('#driveList');
  ul.innerHTML = '<li class="p-4 text-center text-sm text-sub">読み込んでいます…</li>';
  try {
    const r = await api('listFiles', { kind });
    if (!r.files.length) {
      const empty = { clips: 'プロジェクトを保存すると、使った素材がここに入ります。', output: '完成音声を「Driveに保存」すると、ここに並びます。', projects: '「プロジェクトを保存」すると、ここから開けます。', meta: 'Earth Studio用の書き出しがここに入ります。' };
      ul.innerHTML = `<li class="rounded-xl bg-paper p-4 text-center text-sm text-sub">${empty[kind]}</li>`;
      return;
    }
    ul.innerHTML = r.files.map(f => {
      const isAudio = /^audio\//.test(f.mimeType) || AUDIO_EXT.test(f.name);
      const isProject = kind === 'projects';
      return `<li class="rounded-xl border border-line p-3" data-id="${esc(f.id)}" data-name="${esc(f.name)}">
        <div class="truncate text-sm font-bold">${esc(f.name)}</div>
        <div class="num mt-0.5 text-xs text-sub">${esc(new Date(f.updated).toLocaleString('ja-JP'))}・${fmtBytes(f.size)}</div>
        <div class="mt-2 flex flex-wrap gap-2">
          ${isAudio ? '<button class="btn py-1.5" data-act="add">トラックに追加</button>' : ''}
          ${isProject ? '<button class="btn btn-primary py-1.5" data-act="open">開く</button>' : ''}
          <a class="btn py-1.5" href="${esc(f.url)}" target="_blank" rel="noopener">Driveで見る</a>
          <button class="btn btn-quiet ml-auto py-1.5 text-danger" data-act="del">削除</button>
        </div></li>`;
    }).join('');
  } catch (e) {
    ul.innerHTML = `<li class="rounded-xl bg-paper p-4 text-center text-sm text-danger">${esc(e.message)}</li>`;
  }
}
async function fetchDriveFile(id) {
  const r = await api('getFile', { fileId: id });
  return { bytes: base64ToBytes(r.data), name: r.name, mimeType: r.mimeType };
}
async function addClipFromDrive(id) {
  await withBusy('Driveから読み込んでいます', async () => {
    const f = await fetchDriveFile(id);
    const buffer = await decodeAudio(f.bytes.buffer);
    state.clips.push(newClip({ name: f.name.replace(/\.[^.]+$/, ''), source: 'drive', driveId: id, buffer, blob: new Blob([f.bytes], { type: f.mimeType }), ext: (f.name.match(/\.[^.]+$/) || ['.wav'])[0].toLowerCase() }));
    invalidateMix(); renderClips();
    toast('トラックに追加しました', 'ok');
  });
}
async function deleteDriveFile(id, name) {
  if (!confirm(`「${name}」をDriveのゴミ箱に移しますか？`)) return;
  await withBusy('削除しています', async () => {
    await api('deleteFile', { fileId: id });
    state.clips.forEach(c => { if (c.driveId === id) c.driveId = null; });
    toast('ゴミ箱に移しました', 'ok');
  });
  openDrive(state.driveKind);
}

/* ========== プロジェクト保存・読込 ========== */
async function saveProject() {
  const name = $('#projectName').value.trim();
  if (!name) { $('#projectName').focus(); return toast('プロジェクト名を入力してください', 'error'); }
  if (!state.clips.length) return toast('素材がありません', 'error');
  await withBusy('プロジェクトを保存しています', async () => {
    const pending = state.clips.filter(c => !c.driveId);
    for (let i = 0; i < pending.length; i++) {
      const c = pending[i];
      const blob = c.blob || encodeWav(c.buffer);
      const ext = c.blob ? (c.ext || '.wav') : '.wav';
      const fin = await uploadBlob(blob, `${safeName(name)}_${safeName(c.name)}${ext}`, 'clips', `素材を保存しています（${i + 1}/${pending.length}）`);
      c.driveId = fin.fileId;
    }
    const project = {
      format: 'otsunagi-project', version: CONFIG.VERSION, name, savedAt: new Date().toISOString(),
      settings: { ...mixParams(), fps: esParams().fps, esOffset: esParams().offset, mixName: $('#mixName').value.trim() },
      clips: state.clips.map(c => ({ name: c.name, driveId: c.driveId, source: c.source, gain: c.gain, color: c.color, ext: c.ext, ttsText: c.ttsText || '', ttsVoice: c.ttsVoice || '', transcript: c.transcript, summary: c.summary, suggest: c.suggest }))
    };
    await api('saveText', { kind: 'projects', fileName: `${safeName(name)}.otsunagi.json`, mimeType: 'application/json', content: JSON.stringify(project, null, 2) });
    renderClips();
    toast(`「${name}」を保存しました`, 'ok');
  });
}
async function openProject(id) {
  if (state.clips.length && !confirm('いまの素材を閉じて、このプロジェクトを開きますか？')) return;
  closeModal('#modalDrive');
  await withBusy('プロジェクトを開いています', async () => {
    const f = await fetchDriveFile(id);
    const p = JSON.parse(new TextDecoder().decode(f.bytes));
    if (p.format !== 'otsunagi-project') throw new Error('おとつなぎのプロジェクトファイルではありません');
    stopPlayback();
    const clips = []; const missing = [];
    for (let i = 0; i < p.clips.length; i++) {
      const c = p.clips[i];
      progress(i / p.clips.length, `素材を読み込んでいます（${i + 1}/${p.clips.length}）`);
      try {
        const af = await fetchDriveFile(c.driveId);
        const buffer = await decodeAudio(af.bytes.buffer);
        clips.push(newClip({ ...c, buffer, blob: new Blob([af.bytes], { type: af.mimeType }) }));
      } catch (e) { missing.push(c.name); }
    }
    state.clips = clips;
    const s = p.settings || {};
    $('#projectName').value = p.name || '';
    if (s.gap != null) $('#optGap').value = s.gap;
    if (s.fadeMs != null) $('#optFade').value = s.fadeMs;
    if (s.sampleRate) $('#optRate').value = String(s.sampleRate);
    if (s.channels) $('#optCh').value = String(s.channels);
    if (s.format) $('#optFormat').value = s.format;
    if (s.fps) $('#esFps').value = String(s.fps);
    if (s.esOffset != null) $('#esOffset').value = s.esOffset;
    $('#mixName').value = s.mixName || '';
    state.mix = { dummy: true }; invalidateMix();
    renderClips();
    if (missing.length) toast(`読み込めなかった素材：${missing.join('、')}`, 'error');
    else toast(`「${p.name}」を開きました`, 'ok');
  });
}

/* ========== 設定 ========== */
function openSettings() {
  $('#setGasUrl').value = localStorage.getItem(KEY.gas) || '';
  $('#setGasUrl').placeholder = CONFIG.GAS_URL;
  openModal('#modalSettings');
}
async function testGas() {
  const url = $('#setGasUrl').value.trim() || CONFIG.GAS_URL;
  await withBusy('接続を確かめています', async () => {
    const r = await api('ping', {}, { auth: false, url });
    toast(`接続できました（サーバー ${r.version}）`, 'ok');
  });
}
function saveGas() {
  const v = $('#setGasUrl').value.trim();
  if (v && !/^https:\/\/script\.google\.com\/.+\/exec$/.test(v)) return toast('/exec で終わるGASのURLを入力してください', 'error');
  if (v) localStorage.setItem(KEY.gas, v); else localStorage.removeItem(KEY.gas);
  closeModal('#modalSettings');
  toast('接続設定を保存しました', 'ok');
}

/* ========== 初期化 ========== */
function bind() {
  // バージョン表示
  $('#versionBadge').textContent = CONFIG.VERSION;
  $('#footerVersion').textContent = CONFIG.VERSION;
  $('#setVersion').textContent = CONFIG.VERSION;
  document.title = `${CONFIG.APP_NAME} ${CONFIG.VERSION}`;

  // 認証
  $$('.auth-tab').forEach(b => b.addEventListener('click', () => setAuthTab(b.dataset.tab)));
  $('#loginForm').addEventListener('submit', onLogin);
  $('#registerForm').addEventListener('submit', onRegister);
  $('#resetForm').addEventListener('submit', onReset);
  $('#pwForm').addEventListener('submit', onChangePw);
  $('#pwLogoutBtn').addEventListener('click', logout);
  document.addEventListener('click', (e) => {
    const t = e.target.closest('.pw-toggle'); if (!t) return;
    const input = document.getElementById(t.dataset.target);
    input.type = input.type === 'password' ? 'text' : 'password';
    refreshPwToggles();
  });
  refreshPwToggles();

  // ユーザーメニュー
  $('#userBtn').addEventListener('click', (e) => {
    e.stopPropagation();
    const open = $('#userMenu').classList.toggle('hidden') === false;
    $('#userBtn').setAttribute('aria-expanded', open);
  });
  document.addEventListener('click', () => $('#userMenu').classList.add('hidden'));
  $('#userMenu').addEventListener('click', (e) => {
    const b = e.target.closest('[data-act]'); if (!b) return;
    if (b.dataset.act === 'changePw') openPwModal(false);
    if (b.dataset.act === 'logout') logout();
  });

  // モーダル共通
  $$('.modal').forEach(m => {
    m.addEventListener('click', (e) => {
      if (e.target === m && !(m.id === 'modalPw' && state.forcedPw)) closeModal('#' + m.id);
    });
    $$('.modal-close', m).forEach(b => b.addEventListener('click', () => { if (!(m.id === 'modalPw' && state.forcedPw)) closeModal('#' + m.id); }));
  });
  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return;
    $$('.modal').forEach(m => { if (!m.classList.contains('hidden') && !(m.id === 'modalPw' && state.forcedPw)) closeModal('#' + m.id); });
  });

  // 使い方
  $$('.help-open').forEach(b => b.addEventListener('click', openHelp));
  $$('#modalHelp nav a').forEach(a => a.addEventListener('click', (e) => {
    e.preventDefault();
    const t = document.querySelector(a.getAttribute('href'));
    if (t) t.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }));

  // 設定
  $('#settingsBtn').addEventListener('click', openSettings);
  $('#testGasBtn').addEventListener('click', testGas);
  $('#saveGasBtn').addEventListener('click', saveGas);

  // 素材
  $('#fileInput').addEventListener('change', (e) => { addFiles(e.target.files); e.target.value = ''; });
  const dz = $('#dropzone');
  ['dragenter', 'dragover'].forEach(ev => dz.addEventListener(ev, (e) => { e.preventDefault(); dz.classList.add('hover'); }));
  ['dragleave', 'drop'].forEach(ev => dz.addEventListener(ev, (e) => { e.preventDefault(); dz.classList.remove('hover'); }));
  dz.addEventListener('drop', (e) => addFiles(e.dataTransfer.files));
  $('#clearClipsBtn').addEventListener('click', () => {
    if (!state.clips.length || !confirm('トラックの素材をすべて外しますか？（Driveのファイルは消えません）')) return;
    stopPlayback(); state.clips = []; invalidateMix(); renderClips();
  });
  bindClipList();
  renderClips();

  // 読み上げ
  $('#ttsVoice').innerHTML = CONFIG.TTS_VOICES.map(v => `<option value="${esc(v.id)}">${esc(v.label)}</option>`).join('');
  $('#openTtsBtn').addEventListener('click', openTts);
  $('#ttsText').addEventListener('input', (e) => { $('#ttsCount').textContent = e.target.value.length; });
  $('#ttsGenBtn').addEventListener('click', generateTts);
  $('#ttsPlayBtn').addEventListener('click', () => { if (state.ttsDraft) playBuffer(state.ttsDraft.buffer, { kind: 'tts' }); });
  $('#ttsAddBtn').addEventListener('click', addTtsClip);

  // AI結果
  $('#applyClipNameBtn').addEventListener('click', () => {
    const c = findClip(state.analyzingClipId); if (!c || !c.suggest) return;
    c.name = c.suggest; invalidateMix(true); renderClips(); closeModal('#modalClip');
    toast('名前を変えました', 'ok');
  });

  // 結合
  $('#mixBtn').addEventListener('click', doMix);
  ['#optGap', '#optFade', '#optRate', '#optCh'].forEach(s => $(s).addEventListener('change', () => invalidateMix()));
  $('#optFormat').addEventListener('change', () => { if (state.mix) { state.mix.params.format = $('#optFormat').value; state.mixBlob = null; } });
  $('#playMixBtn').addEventListener('click', toggleMix);
  $('#reel').addEventListener('click', (e) => seekReel(e.clientX));
  $('#reel').addEventListener('keydown', (e) => {
    if (!state.mix) return;
    const step = e.shiftKey ? 5 : 1;
    if (e.key === ' ') { e.preventDefault(); toggleMix(); }
    if (e.key === 'ArrowRight' || e.key === 'ArrowLeft') {
      e.preventDefault();
      const t = Math.max(0, Math.min(state.mix.duration, playerTime() + (e.key === 'ArrowRight' ? step : -step)));
      if (player.kind === 'mix') playMix(t); else { player.offset = t; updatePlayhead(t); }
    }
  });
  $('#suggestNameBtn').addEventListener('click', suggestMixName);
  $('#downloadMixBtn').addEventListener('click', downloadMix);
  $('#saveMixDriveBtn').addEventListener('click', saveMixToDrive);

  // Earth Studio
  ['#esFps', '#esOffset'].forEach(s => $(s).addEventListener('input', updateEarthInfo));
  $$('.es-export').forEach(b => b.addEventListener('click', () => exportMeta(b.dataset.fmt)));
  $('#esDriveBtn').addEventListener('click', saveMetaToDrive);
  $('#videoInput').addEventListener('change', (e) => loadVideo(e.target.files[0]));
  updateEarthInfo();

  // Drive
  $('#openDriveClipsBtn').addEventListener('click', () => openDrive('clips'));
  $('#openProjectsBtn').addEventListener('click', () => openDrive('projects'));
  $$('.drive-tab').forEach(b => b.addEventListener('click', () => openDrive(b.dataset.kind)));
  $('#driveList').addEventListener('click', (e) => {
    const b = e.target.closest('button[data-act]'); if (!b) return;
    const li = b.closest('li'); const id = li.dataset.id, name = li.dataset.name;
    if (b.dataset.act === 'add') addClipFromDrive(id);
    if (b.dataset.act === 'open') openProject(id);
    if (b.dataset.act === 'del') deleteDriveFile(id, name);
  });
  $('#saveProjectBtn').addEventListener('click', saveProject);

  // 離脱時の確認
  window.addEventListener('beforeunload', (e) => {
    if (state.clips.some(c => !c.driveId)) { e.preventDefault(); e.returnValue = ''; }
  });
}

document.addEventListener('DOMContentLoaded', () => {
  bind();
  restoreSession();
});
