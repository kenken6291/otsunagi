/**
 * おとつなぎ — 設定ファイル
 * GASのURLを差し替えるときは、ここ（または画面右上の歯車）を変更してください。
 * APIキーはここに書かず、GASのスクリプトプロパティに保存します。
 */
const CONFIG = Object.freeze({
  APP_NAME: 'おとつなぎ',
  VERSION: 'v1.1.0',

  // GASウェブアプリのURL（デプロイ後に発行される /exec で終わるURL）
  GAS_URL: 'https://script.google.com/macros/s/AKfycbwfBfHSXA-TaYAoGwf7gQdCj3dfpoxLXdx2_HzvrrGuRjiMOHF5TbQ5InhpqLrthq8G/exec',

  // 書き出し
  MP3_KBPS: 128,
  DEFAULT_FPS: 30,

  // Driveアップロードの分割サイズ（base64文字数。必ず4の倍数）
  UPLOAD_CHUNK_SIZE: 4 * 1024 * 1024,
  // 1ファイルあたりの上限（MB）。GASの制限に合わせて控えめに
  MAX_UPLOAD_MB: 35,
  // AI聞き取りに送る音声の上限（MB、16kHzモノラルWAV換算でおよそ10分）
  MAX_AI_AUDIO_MB: 18,

  // Gemini TTS の声（モデル側の名前）
  TTS_VOICES: [
    { id: 'Kore', label: 'Kore（落ち着いた女性）' },
    { id: 'Aoede', label: 'Aoede（明るい女性）' },
    { id: 'Leda', label: 'Leda（若い女性）' },
    { id: 'Charon', label: 'Charon（低めの男性）' },
    { id: 'Puck', label: 'Puck（快活な男性）' },
    { id: 'Fenrir', label: 'Fenrir（力強い男性）' },
    { id: 'Orus', label: 'Orus（しっかりした男性）' },
    { id: 'Zephyr', label: 'Zephyr（澄んだ声）' }
  ],

  // 端末保存キー
  STORAGE_PREFIX: 'otsunagi_'
});
