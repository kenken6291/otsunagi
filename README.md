# おとつなぎ v1.0.0

複数の音声をブラウザ上でつなぎ、Google Drive に保存し、Google Earth Studio 用のタイムコードを書き出す Web アプリです。

```
otsunagi/
├── index.html     画面
├── config.js      設定（GAS_URL・バージョン）
├── app.js         画面ロジック・音声結合・通信
└── gas/Code.gs    GAS（会員DB・Drive・Gemini）
```

## 1. スプレッドシートの列定義

### Users シート（会員）

| 列 | 項目 | 内容 |
|---|---|---|
| A | userId | UUID（Driveのユーザーフォルダ名にも使用） |
| B | email | 小文字で保存 |
| C | nickname | 30文字まで |
| D | passwordHash | `sha256$` + 16進（書式：書式なしテキスト） |
| E | salt | UUID（書式：書式なしテキスト） |
| F | mustChange | TRUE＝仮パスワード状態。ログイン後に変更必須 |
| G | status | `active` 以外にすると利用停止 |
| H | failCount | 連続失敗回数。5回で30分ロック |
| I | lockedUntil | ロック解除日時 |
| J | createdAt | 登録日時 |
| K | updatedAt | 更新日時 |
| L | lastLoginAt | 最終ログイン日時 |

### Logs シート（任意の記録）

| 列 | 項目 |
|---|---|
| A | timestamp |
| B | action |
| C | email |
| D | message |

どちらも `setup()` を実行すると自動で作られます。セッションは CacheService（6時間・操作ごとに延長）で管理するため、シートはありません。

### Drive のフォルダ構成（自動作成）

```
おとつなぎ_data/
├── _tmp/                 分割アップロードの一時置き場
└── {userId}/
    ├── clips/            プロジェクト保存時の素材
    ├── output/           完成音声
    ├── projects/         *.otsunagi.json
    └── meta/             Earth Studio 用 JSON / CSV / SRT
```

## 2. GAS のセットアップ

1. 新しいスプレッドシートを作り、「拡張機能」→「Apps Script」を開く
2. `Code.gs` の中身をすべて貼り付けて保存
3. 関数 `setup` を選んで実行し、権限を承認する（シート・保存先フォルダ・PEPPER などが作られます）
4. 「プロジェクトの設定」→「スクリプト プロパティ」に追加

| プロパティ | 値 |
|---|---|
| GEMINI_API_KEY | Google AI Studio の API キー（必須） |
| APP_URL | 公開URL（例 `https://kenken6291.github.io/otsunagi/`）。仮パスワードメールに載ります |
| GEMINI_MODEL | 文字起こし・要約用。初期値 `gemini-2.5-flash` |
| GEMINI_TTS_MODEL | 読み上げ用。初期値 `gemini-2.5-flash-preview-tts`。他のアプリで使っている TTS モデル名に変えて構いません |

5. 「デプロイ」→「新しいデプロイ」→ 種類「ウェブアプリ」
   - 次のユーザーとして実行：**自分**
   - アクセスできるユーザー：**全員**
6. 発行された `/exec` で終わる URL を控える
7. （任意）トリガーで `cleanupTmp` を「時間主導・1日1回」に設定

> コードを直したら「デプロイを管理」→ 鉛筆 → バージョン「新バージョン」で更新してください。URL はそのままです。「新しいデプロイ」を作ると URL が変わります。

### CORS について

フロントは `Content-Type: text/plain` で POST しているため、プリフライトが起きず GAS でそのまま受けられます。ヘッダーを `application/json` に変えると動かなくなるので注意してください。

## 3. フロントエンドの公開（GitHub Pages）

1. リポジトリ `otsunagi` を作り、`index.html` `config.js` `app.js` を直下に置く（`gas/` は記録用に置いても公開されて問題ありません。APIキーは含まれていません）
2. `config.js` の `GAS_URL` を手順2-6の URL に書き換える
3. Settings → Pages → Branch を `main` / `root` にして保存
4. `https://kenken6291.github.io/otsunagi/` で開く

URL は画面右上の歯車からも端末ごとに上書きできます（試験用 GAS に切り替えるとき便利です）。

## 4. 使い方の流れ

1. 新規登録 → メールの仮パスワードでログイン → 新しいパスワードを設定
2. 音声をドロップ、または「読み上げ音声を作る」で Gemini TTS の音声を追加
3. 並び替え・音量・間隔・フェードを調整して「つなげて試聴する」
4. 「Driveに保存」で完成音声とタイムコード JSON を保存
5. Earth Studio 欄の「フレーム数」をプロジェクトの長さに設定し、JSON/CSV/SRT を編集時の目印に使う
6. 書き出した動画を読み込むと、音声と並べて確認できます

## 5. 制限

- Drive への保存は1ファイル約35MBまで（MP3 128kbps なら約35分）
- Drive からの読み込みは25MBまで
- AI 聞き取りは1素材あたり約10分まで
- 仮パスワードメールは Gmail の1日の送信上限に従います
