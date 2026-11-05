# デプロイ基盤の初期設定

この手順は、Bitwardenから初期作成用Cloudflareトークンを1件だけ取得し、dev用Workerを準備するものです。通常CD、アプリの公開、Cloudflare Access、Supabaseの設定・migration、本番Workerの作成はまだ行いません。

## 対象と権限

| 項目 | 固定対象 |
| --- | --- |
| GitHubリポジトリ | `tossyhal/manga-nikki` |
| 実行ブランチ | `main` |
| 実行者・再実行者 | `tossyhal`（初回実行者のUser IDは`92223710`） |
| GitHub Environment | `staging` |
| Cloudflare Account ID | `c9cee9599752cb191815c0eea6ff457e` |
| Worker | `manga-nikki-staging` |

Worker名や対象アカウントを入力で切り替えることはできません。本番用BitwardenプロジェクトとGitHubの`production`環境は使用しません。

## チーム内の操作分担

| 操作 | 許可する人 |
| --- | --- |
| 開発ブランチへのpush・PR作成 | チームメンバー |
| mainへのPRのmerge | `tossyhal`だけ |
| この初期設定workflowの実行・再実行 | `tossyhal`だけ |
| 通常dev配信 | 後続CDでチーム共有にする |
| 本番配信・本番の運用操作 | 後続workflowでも`tossyhal`だけにする |

手動workflowのボタン自体はWrite権限のメンバーにも表示され得ます。初期設定workflowはSecrets取得前に実行者を検査し、本人以外では初期設定処理へ進みません。初回が本人でも、別メンバーが失敗したjobを再実行した場合には資格情報を渡さないよう、Secretsを使うjobでも再実行者を検査します。

workflow内の判定を書き換えて取り込まれることを防ぐため、GitHubの`main-owner-merge-only`Rulesetでmainの更新を制限し、`tossyhal`だけをPR経由の例外にします。既存の`protect-main`は別Rulesetとして残し、本人も直接push・force pushできない状態を維持します。チームメンバーのWrite権限や開発ブランチへのpush・PR作成権限は取り上げません。

Write権限を残すため、Actions実行のキャンセルまで本人だけに制限するものではありません。中断後は実状態を照合します。また、PRのレビュー後に追加pushされる場合もあるので、本人がmergeする直前に最新HEADとCI結果を確認してください。

これらはGitHub側の制限です。Cloudflare・Supabase・Bitwardenへ直接ログインできる管理者や、別途配布したAPIキーの権限までは制限しません。クラウド側へメンバーを招待する場合は、通常dev用の権限だけに限定し、本番・初期作成用資格情報を共有しません。

初期作成用トークンには、対象アカウントのWorkers作成を許可する管理権限を使います。通常CD用トークンではありません。同アカウントの他Workerにも変更可能な権限なので、初期設定後に対象Workerだけを更新できる資格情報へ移行し、このトークンを失効させます。DNS・R2・KV等の権限は追加しません。

## 事前準備

GitHubの[staging環境](https://github.com/tossyhal/manga-nikki/settings/environments)に次を設定します。

初期作成用トークンを登録している間、**Deployment branches and tags**は**Selected branches and tags**を選び、Branchの`main`だけを許可します。タグや他ブランチは許可しません。workflow内のmain判定だけでは、別ブランチに追加したworkflowからEnvironment Secretを読むことを防げないため、最初の`check`より前にEnvironment側の制限を確認します。developを許可するのは、初期作成用トークンの失効・通常CD用資格情報への移行とdevelop保護を済ませた後です。

最初の`check`より前に[Rulesets](https://github.com/tossyhal/manga-nikki/settings/rules)も確認し、`protect-main`でPR経由の変更を必須にし、直接push・force pushを禁止します。`main-owner-merge-only`がmainに適用され、更新の例外が`tossyhal`のPR経由だけであることも確認します。初期設定用workflowを含む変更は本人がレビューします。

| 種類 | 名前 | 設定内容 |
| --- | --- | --- |
| Environment Secret | `BWS_ACCESS_TOKEN` | `manga-nikki-dev-cd`のBitwardenアクセストークン |
| Environment Variable | `BWS_BOOTSTRAP_SECRET_ID` | `CLOUDFLARE_BOOTSTRAP_API_TOKEN`のSecret ID（UUID） |

Bitwardenは公式USリージョン（`.com`）を使います。`manga-nikki-dev-cd`には`manga-nikki-dev`プロジェクトだけを読み取る権限を与え、同プロジェクトに`CLOUDFLARE_BOOTSTRAP_API_TOKEN`を保存します。UUIDは秘密値ではありません。Organization ID・Project ID・machine account IDではなく、対象SecretのUUIDを指定してください。

アプリ用Supabaseキー・DBパスワード・AIキーは、この処理では取得しません。Bitwardenから取得したCloudflareトークンは配信プロセスだけに渡し、WorkerのSecretsや成果物へ保存しません。

今回の初期作成用Cloudflareトークンは2026年11月13日23:59（日本時間）に失効します。実行前にCloudflareとBitwarden両方のトークンの期限を確認してください。更新したSecretは同じUUIDを維持できる場合は値を更新し、作り直した場合はGitHubのVariableも更新します。

## まず接続だけ確認する

1. このworkflowを含むPRをMerge commitで`main`へ取り込みます。mergeやpushだけでは初期設定は起動しません。
2. [Actionsの初期設定workflow](https://github.com/tossyhal/manga-nikki/actions/workflows/bootstrap-staging.yml)を開き、**Run workflow**を選びます。
3. Branchを`main`、`operation`を`check`にします。`confirmation`は空欄にします。
4. **Run workflow**を押し、実行結果のSummaryを開きます。

標準のlint・型検査・unit test・buildが成功してから、`staging`環境の資格情報を使います。`check`はCloudflareを読み取るだけで、Workerの作成・変更・削除は行いません。対象Workerが未作成なら、その状態が表示されれば接続確認の完了です。既存の場合はworkers.devとpreview URLの設定も確認します。

認証・権限・API障害や、想定外のレスポンスは失敗として停止します。単なるHTTP 404を、作成してよい証拠として扱いません。失敗時は実行URLとSummaryを担当AIへ渡してください。キーや生のAPIレスポンスをチャットへ貼る必要はありません。

標準検査やBitwarden取得のstepで停止し、初期設定スクリプトに到達しなかった場合はSummaryがありません。同じ実行ページの失敗したstepを確認し、その実行URLを担当AIへ渡してください。

## dev用Workerを初期作成する

1. 接続確認の結果と作成対象を確認します。
2. 同じworkflowを開き、Branchを`main`、`operation`を`create`にします。
3. `confirmation`に`manga-nikki-staging`を入力します。
4. 作成完了まで、管理画面・別CI・他の担当者から同名Workerを作成・更新する操作を止め、`exclusive_setup`を有効にします。停止できない場合は実行しません。
5. **Run workflow**を押します。この操作はCloudflare上にWorkerを作成します。無料枠・利用条件は対象アカウントで事前に確認し、有料化は別途承認します。

対象Workerが既にある場合は、コードや設定を上書きせず停止します。作成するのは固定の503応答だけを返す最小Workerで、漫画日記アプリは配信しません。既存のアプリ用`wrangler.jsonc`やVite成果物を使わず、一時ディレクトリの専用設定から作成します。

存在確認とWranglerの配信は別操作で、外部からの同時作成を原子的に拒否するものではありません。GitHubの排他は同じconcurrency groupのjob間だけに効くため、上記の運用上の排他を初期作成の必須条件とします。

作成設定は`workers_dev=false`、`preview_urls=false`、route・custom domain・bindings・assets・Cronなしです。作成後はAPIからworkers.devとpreview URLが両方無効であることを確認します。Summaryの成功表示と、[対象アカウントのWorkers一覧](https://dash.cloudflare.com/c9cee9599752cb191815c0eea6ff457e/workers-and-pages)に`manga-nikki-staging`があることを確認してください。公開アプリURLは発行しません。

この処理では全Zoneの既存route、custom domain、他WorkerのService Bindingは監査しません。公開設定の確認範囲はworkers.devとpreview URLに限ります。後続のAccess設定・アプリ公開前に、別途その接続関係を確認します。

## 失敗・再実行時

- `check`は変更しないので、接続設定を修正して再確認できます。
- `create`途中で失敗した場合、Workerが作成済みかもしれません。先に`check`と管理画面で状態を確認します。
- 再実行時に既存Workerが検出されても削除や上書きはしません。自動的に元へ戻す処理もありません。
- 作成後に公開フラグの検証が失敗した場合は、成功扱いにせず停止します。担当者が実際の状態を照合します。
- 同じ環境の初期設定は直列化し、次の実行によって進行中の処理をキャンセルしません。手動キャンセルやタイムアウト後は、必ず実状態を確認します。

## 初期作成後の作業

1. 対象Workerだけを更新可能な通常CD用トークンへ移行し、初期作成用トークンをCloudflareで失効させ、Bitwardenからも廃止します。develop保護と通常CDの検査を整えてから、staging環境へdevelopからの配信を許可します。
2. devのCloudflare Accessと自動検証用の認証経路を用意します。
3. dev専用Supabase・Auth・Storage・Queue・Cron・Turnstileを接続し、架空データで検証します。
4. GitHub ActionsでCI→migration→配信→動作確認を行う通常CDを別PRで追加します。
5. 本番用資源・本番URL・復旧方針を確認し、別承認後に本番配信を準備します。

## 公式資料

- [BitwardenのGitHub Actions連携](https://bitwarden.com/help/github-actions-integration/)
- [Workersの権限とスコープ](https://developers.cloudflare.com/workers/authorization/workers/)
- [Wranglerのworkers.dev・preview URL設定](https://developers.cloudflare.com/workers/wrangler/configuration/)
