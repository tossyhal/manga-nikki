# コードベースツアー（manga-nikki）

> 2026-11-02 時点の途中成果物。実装済みの初期基盤を歩き、最初の変更場所まで案内する。
> 完成像の正本は [SPEC.md](SPEC.md) / [ARCHITECTURE.md](ARCHITECTURE.md)。この文書は「今動いているコード」を優先する。

## これは何か

技育CAMP2026 ハッカソン向けのスマートフォン PWA。日記を書いて 4 コマ漫画として読み返す。

現状は **段階 1（初期基盤）まで実装済み**。localhost の `local-mock` だけで、日記入力 → 固定サンプル漫画 → Worker メモリへの仮保存 → 再読込が通る。実 AI・Supabase・Queue・PWA は未実装。

| 層 | 技術 | いまの実装 |
|---|---|---|
| 画面 | React 19 + React Router 7 + Tailwind 4 | 4 ルートの SPA |
| 配信 | Vite 7 + Cloudflare Vite plugin | 画面と API を同一オリジン |
| API | Hono on Cloudflare Workers | モック CRUD / 即時成功の生成 API |
| 契約 | Zod 4（`src/shared`） | 画面・サーバー・テストが同じ schema |
| 保存 | `Map` in Worker メモリ | 再起動・HMR で消える |

## ディレクトリの地図

```text
src/
  client/                 フロントエンド
    main.tsx              React 起動
    app/App.tsx           ルート・config 判定・ヘッダー
    features/diary        入力画面
    features/library      一覧・詳細
    features/comic        4コマ表示
    lib/api.ts            fetch ラッパ・モックセッション
  server/
    index.ts              Worker 入口（fetch）
    app.ts                全 HTTP ルート（ここがサーバーの本体）
    mode.ts               APP_ENV / DATA_MODE / AI_MODE の組合せ検証
    repositories/mock.ts  メモリ上の entries / generations / counts
  shared/
    schemas.ts            Zod 契約と TypeScript 型
    fixtures.ts           固定漫画・架空日記
docs/                     仕様・設計・API・運用
tests/                    Playwright E2E
public/                   sample-comic.svg など静的ファイル
wrangler.jsonc            Worker の入口と本番向け vars（preview-sample）
```

公式の完成時レイアウトは [ARCHITECTURE.md](ARCHITECTURE.md) の `src/client|server|shared` と同じだが、`middleware` / `services` / `ai` / `jobs` / `supabase/` はまだ空（未作成）。

## 起動の流れ（プロセス）

1. Vite が `127.0.0.1:5173` で SPA を出す（`vite.config.ts`、`pnpm dev`）。
2. `@cloudflare/vite-plugin` が Worker を同じプロセスに載せる。
3. Worker 入口は `src/server/index.ts`。`import.meta.env.DEV` のときだけ `localDevelopment: true`。
4. `wrangler.jsonc` の `run_worker_first: ["/api/*"]` で API は Worker、それ以外は SPA fallback。
5. 開発時の環境変数は `.dev.vars`（見本は `.dev.vars.example`）。`APP_ENV=development` + `DATA_MODE=mock` + `AI_MODE=mock` + `GENERATION_ENABLED=false` が `local-mock`。

ビルド成果物は `preview-sample` 向け。`pnpm preview` ではモック認証が拒否されるので、日記保存の確認には使わない（[CONTRIBUTING.md](../CONTRIBUTING.md)）。

## 画面フロー

ルート定義は `src/client/app/App.tsx`。起動時に `GET /api/v1/config` を叩き、`dataMode === 'mock'` かつ `generationAvailable === true` のときだけ `/new`・`/library`・`/entries/:id` を有効化する。それ以外はサンプル閲覧専用。

```text
/            Home。固定サンプル（pageComic + /sample-comic.svg）
/new         NewEntry。同意チェック → POST /entries → 任意で生成 → 詳細へ
/library     Library。GET /entries、cursor で追加読み込み
/entries/:id Detail。GET /entries/:id、画像 URL、削除、下書きからの生成
```

### 日記を書いて漫画を見る（メインパス）

1. `NewEntry`（`src/client/features/diary/NewEntry.tsx`）が `createEntrySchema` で日付・本文を検証する。
2. 同意が無いと保存しない。`createRequestId` は `useRef` の UUID で、再送時の冪等キーになる。
3. `api('/entries')` → Worker がメモリに Entry を作る。
4. 「保存してモック漫画を見る」なら `generate(entry)`（`src/client/lib/api.ts`）。`sessionStorage` に `Idempotency-Key` を残し、`POST /entries/:id/generations` を送る。
5. サーバーは入力と無関係の `pageComic` をコピーし、`status: 'succeeded'` で即返す（Queue はまだ無い）。
6. 画面は `/entries/:id` へ。`Detail` が日記本文と固定 SVG を出す。`Comic` は `page` / `panels` 両対応。

認証は JWT ではなく、`localStorage` の UUID を `Authorization: Bearer mock:<uuid>` として付ける。localhost / 127.0.0.1 / ::1 以外、または Origin 不一致なら 401。

## API の骨格

本体はほぼ全部 `src/server/app.ts`。

| メソッド | パス | 役割 |
|---|---|---|
| GET | `/api/v1/health` | 生存確認。mode が壊れていれば 503 |
| GET | `/api/v1/config` | 画面の利用可否。認証不要 |
| GET | `/api/v1/me/quota` | モック上限（1 日 2 回） |
| POST/GET/PATCH/DELETE | `/api/v1/entries` | 日記 CRUD。下書き 20 件上限、revision 衝突 |
| POST | `/api/v1/entries/:id/generations` | 固定漫画を即成功扱い |
| GET | `/api/v1/generations/:id` | 生成ジョブ |
| GET | `/api/v1/assets/:id/url` | 常に `/sample-comic.svg` |

`/api/v1/health` と `/api/v1/config` 以外は `local-mock` 以外 503。JSON ボディは 16KB 上限。エラー形は `{ error: { code, message, requestId, retryable } }`。

モード判定は `src/server/mode.ts`。許可される 4 組合せ以外は起動時（初回リクエスト）に拒否する。`local-connected` / `live-demo` の実接続は未実装。

## 共通契約

`src/shared/schemas.ts` が画面・サーバー・Vitest の正本。JSON Schema 見本は `docs/contracts/`。

- 日記: 1〜1000 文字、日付は JST 当日以前、`consentVersion: 'v1'`
- 漫画: `schemaVersion: 1`、4 コマ固定、`visual.kind` は `page`（1 枚）または `panels`（4 枚）
- 生成状態: `queued` / `running` / `succeeded` / `failed` / `unknown` / `cancelled`

モック実装は `queued` を返すが、保存済みオブジェクトはすぐ `succeeded` なのでポーリングはほぼ通らない。Detail 側の 5 秒ポーリングは将来の非同期生成用。

## どう動かすか

Node 24.22.1 と pnpm 12.11.2 は mise で固定（`mise.toml` / `mise.lock`）。詳細は [CONTRIBUTING.md](../CONTRIBUTING.md)。

```powershell
mise trust
mise install --locked
pnpm install --frozen-lockfile
Copy-Item .env.example .env.local
Copy-Item .dev.vars.example .dev.vars
pnpm dev
```

確認コマンド:

| コマンド | 用途 |
|---|---|
| `pnpm dev` | http://127.0.0.1:5173 |
| `pnpm lint` | oxlint + oxfmt check |
| `pnpm typecheck` | `tsc --noEmit` |
| `pnpm test` | Vitest（schema / API / Worker） |
| `pnpm test:e2e` | Playwright。初回は `pnpm exec playwright install chromium` |
| `pnpm build` | ビルド検証。公開しない |

E2E のゴールデンパスは `tests/diary.spec.ts`（入力 → 固定漫画 → reload → 一覧 → 削除）。CI は `.github/workflows/ci.yml` で同じ列を Ubuntu 上で回す。

## 日記保存担当のいまの要件

保存担当の画面要件（モックの範囲、契約v1は壊さない）:

- 過去の日記を `/` の「過去の記録」と `/library` から読み返す
- 各記録のヘッダーは本文から作った要約（`src/shared/summary.ts`）。専用 `summary` カラムはまだ持たない
- 入力画面でも同じ要約を見出しプレビューとして出す

触るファイル:

1. `src/shared/summary.ts` — 要約の切り方
2. `src/client/features/library/EntryHistory.tsx` — 履歴リスト
3. `src/client/features/library/Library.tsx` / `Detail.tsx`
4. `src/client/app/App.tsx` の Home
5. `src/client/features/diary/NewEntry.tsx`

本物の永続化（Supabase）は段階2。いまの保存先は Worker メモリのまま。

触る前に読む:

- 画面仕様: [SPEC.md](SPEC.md) のルート表
- 型を変えるなら `src/shared/schemas.ts` と [API.md](API.md) とテストを同時に更新
- サーバー挙動: `src/server/app.ts` と `src/server/app.test.ts`

避けた方がよい最初の PR:

- `schemas.ts` の破壊的変更（client / server / E2E が全部壊れる）
- `mode.ts` や `.dev.vars` の組合せ改変（起動不能）
- 実 Supabase / 実 AI / Queue（段階 2〜4。Issue #3〜#5）
- `GENERATION_ENABLED=true` や秘密情報のブラウザ露出

次の本実装の入口（チーム合意後）:

| 目的 | ファイル | 備考 |
|---|---|---|
| 本物の保存 | 新規 `src/server/repositories/` + `supabase/migrations` | いまの `mock.ts` を差し替える |
| 本物の生成 | 新規 `src/server/ai/` + Queue consumer | `app.ts` の即時 `succeeded` をやめる |
| 認証 | `src/client/lib/api.ts` の `session()` と `app.ts` の Bearer mock | JWT + RLS |

## ドキュメントの読み順

1. [README.md](../README.md) — 現状と用語
2. [SPEC.md](SPEC.md) — 作るもの
3. [CONTRIBUTING.md](../CONTRIBUTING.md) — 起動と PR
4. [ARCHITECTURE.md](ARCHITECTURE.md) — 完成時の構成
5. [API.md](API.md) — HTTP 契約
6. [OPERATIONS.md](OPERATIONS.md) — 認証・予算・公開前（まだコードが追いついていない）
7. [AGENTS.md](../AGENTS.md) — エージェント向け制約
8. [PLAN.md](PLAN.md) — 段階 1 完了、2 と 3 が次
