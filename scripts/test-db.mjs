import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { delimiter, join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const activeChildren = new Set();
let temporary;
let bin;
let utilityEnv;
let databaseEnv;
let initialized = false;
let serverStartAttempted = false;
let receivedSignal;
let cleaningUp = false;

function terminateChildren(signal) {
  if (receivedSignal) return;
  receivedSignal = signal;
  process.exitCode = signal === 'SIGINT' ? 130 : 143;
  if (cleaningUp) return;
  for (const child of activeChildren) child.kill('SIGTERM');
}

const handleSigint = () => terminateChildren('SIGINT');
const handleSigterm = () => terminateChildren('SIGTERM');
process.once('SIGINT', handleSigint);
process.once('SIGTERM', handleSigterm);

function run(command, args, input = '', env = process.env) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { env, stdio: ['pipe', 'pipe', 'pipe'] });
    activeChildren.add(child);
    let stdout = '';
    let stderr = '';
    let settled = false;
    child.stdout.setEncoding('utf8').on('data', (chunk) => (stdout += chunk));
    child.stderr.setEncoding('utf8').on('data', (chunk) => (stderr += chunk));
    child.once('error', (error) => {
      activeChildren.delete(child);
      if (settled) return;
      settled = true;
      reject(error);
    });
    child.once('close', (code) => {
      activeChildren.delete(child);
      if (settled) return;
      settled = true;
      resolve({ code, stdout, stderr });
    });
    child.stdin.on('error', (error) => {
      if (error.code === 'EPIPE' || settled) return;
      settled = true;
      reject(error);
    });
    child.stdin.end(input);
  });
}

function startSqlSession(applicationName) {
  const child = spawn(binary('psql'), ['-X', '-qAt', '-v', 'ON_ERROR_STOP=1', '-f', '-'], {
    env: { ...databaseEnv, PGAPPNAME: applicationName },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  activeChildren.add(child);
  let stdout = '';
  let stderr = '';
  let closed = false;
  let closeResult;
  let markerWaiter;
  const closePromise = new Promise((resolve) => {
    child.stdout.setEncoding('utf8').on('data', (chunk) => {
      stdout += chunk;
      if (markerWaiter && stdout.includes(markerWaiter.marker)) {
        clearTimeout(markerWaiter.timeout);
        markerWaiter.resolve();
        markerWaiter = undefined;
      }
    });
    child.stderr.setEncoding('utf8').on('data', (chunk) => (stderr += chunk));
    child.once('error', (error) => {
      activeChildren.delete(child);
      closed = true;
      if (markerWaiter) markerWaiter.reject(error);
    });
    child.once('close', (code, signal) => {
      activeChildren.delete(child);
      closed = true;
      closeResult = { code, signal, stdout, stderr };
      if (markerWaiter) {
        clearTimeout(markerWaiter.timeout);
        markerWaiter.reject(new Error(`PostgreSQL同期接続が終了しました: ${stderr}`));
      }
      resolve(closeResult);
    });
  });

  return {
    write(source) {
      if (closed) throw new Error('PostgreSQL同期接続が終了しています');
      child.stdin.write(source);
    },
    waitForOutput(marker) {
      if (stdout.includes(marker)) return Promise.resolve();
      if (closed) return Promise.reject(new Error(`同期マーカーがありません: ${stderr}`));
      return new Promise((resolve, reject) => {
        markerWaiter = {
          marker,
          resolve,
          reject,
          timeout: setTimeout(() => {
            markerWaiter = undefined;
            reject(new Error(`同期マーカーの待機がタイムアウトしました: ${marker}`));
          }, 15_000),
        };
      });
    },
    async finish(command) {
      if (!closed) child.stdin.end(`${command};\n`);
      const result = closeResult ?? (await closePromise);
      if (result.code !== 0 && !receivedSignal) {
        throw new Error(`PostgreSQL同期接続に失敗しました: ${result.stderr}`);
      }
      return result;
    },
  };
}

function succeeded(result) {
  assert.equal(result.code, 0, result.stderr);
  return result.stdout.trim();
}

const binary = (name) => join(bin, `${name}${process.platform === 'win32' ? '.exe' : ''}`);
const sql = (source, applicationName = 'manga-nikki-db-query') =>
  run(binary('psql'), ['-X', '-qAt', '-v', 'ON_ERROR_STOP=1', '-f', '-'], source, {
    ...databaseEnv,
    PGAPPNAME: applicationName,
  });
const create = (actor, key, body = '同時要求の架空日記') =>
  `select (public.create_entry('${actor}', '${key}', current_date, '${body}', 'v1')).id;`;

async function waitForLockWaiters(applicationPrefix, expectedCount) {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    const count = Number(
      succeeded(
        await sql(
          `select count(*) from pg_stat_activity
           where application_name like '${applicationPrefix}%'
             and wait_event_type = 'Lock';`,
          'manga-nikki-db-lock-observer',
        ),
      ),
    );
    if (count === expectedCount) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`実際のDBロック待ちを確認できませんでした: ${applicationPrefix}`);
}

async function runBehindLock({
  holderName,
  lockSql,
  waiterPrefix,
  queries,
  expectedWaiters = queries.length,
  beforeRequests,
}) {
  const marker = `${holderName}:lock-acquired`;
  const holder = startSqlSession(holderName);
  let requestsPromise = Promise.resolve([]);
  let synchronizationError;

  try {
    holder.write(`begin;\nset local role service_role;\n${lockSql};\n\\echo ${marker}\n`);
    await holder.waitForOutput(marker);
    await beforeRequests?.(holder);
    requestsPromise = Promise.all(
      queries.map((query, index) => sql(query, `${waiterPrefix}${index}`)),
    );
    await waitForLockWaiters(waiterPrefix, expectedWaiters);
  } catch (error) {
    synchronizationError = error;
  } finally {
    await holder.finish(synchronizationError ? 'rollback' : 'commit').catch((error) => {
      synchronizationError ??= error;
    });
  }

  const results = await requestsPromise;
  if (synchronizationError) throw synchronizationError;
  return results;
}

async function runBehindEntryUntilDeadline({
  entryId,
  waiterName,
  query,
  updateDeadlineSql,
  deadlineExpression,
}) {
  const holderName = `${waiterName}-holder`;
  const lockMarker = `${holderName}:lock-acquired`;
  const deadlineMarker = `${holderName}:deadline-passed`;
  const holder = startSqlSession(holderName);
  let queryPromise;
  let synchronizationError;

  try {
    holder.write(
      `begin;\nset local role service_role;\nselect id from public.entries where id = '${entryId}' for update;\n\\echo ${lockMarker}\n`,
    );
    await holder.waitForOutput(lockMarker);

    // ロック前の時刻を使う誤実装も検出するため、待機開始後に期限を設定する。
    queryPromise = sql(query, waiterName);
    await waitForLockWaiters(waiterName, 1);

    holder.write(
      `${updateDeadlineSql};\nselect pg_catalog.pg_sleep(greatest(0, extract(epoch from ((${deadlineExpression}) - pg_catalog.clock_timestamp())) + 0.1));\n\\echo ${deadlineMarker}\n`,
    );
    await holder.waitForOutput(deadlineMarker);
  } catch (error) {
    synchronizationError = error;
  } finally {
    await holder.finish(synchronizationError ? 'rollback' : 'commit').catch((error) => {
      synchronizationError ??= error;
    });
  }

  const result = queryPromise ? await queryPromise : undefined;
  if (synchronizationError) throw synchronizationError;
  return result;
}

async function cleanup() {
  cleaningUp = true;
  try {
    if (bin && initialized && serverStartAttempted) {
      const status = await run(
        binary('pg_ctl'),
        ['-D', join(temporary, 'data'), 'status'],
        '',
        utilityEnv,
      );
      if (status.code === 0) {
        const stopped = await run(
          binary('pg_ctl'),
          ['-D', join(temporary, 'data'), '-m', 'immediate', '-w', '-t', '15', 'stop'],
          '',
          utilityEnv,
        );
        if (stopped.code !== 0) {
          throw new Error(`一時DBの停止に失敗しました: ${stopped.stderr}`);
        }
      } else if (status.code !== 3) {
        throw new Error(`一時DBの状態を確認できませんでした: ${status.stderr}`);
      }
    }
    if (temporary) await rm(temporary, { recursive: true, force: true });
  } catch (error) {
    console.error('一時DBのcleanupに失敗しました。作業ディレクトリ:', temporary);
    console.error(error.message);
    process.exitCode = 1;
  }
}

try {
  temporary = await mkdtemp(join(tmpdir(), 'manga-nikki-db-'));
  if (receivedSignal) throw new Error(`中断シグナルを受信しました: ${receivedSignal}`);
  bin = process.env.PG_BIN || succeeded(await run('pg_config', ['--bindir']));
  const server = createServer();
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const { port } = server.address();
  await new Promise((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );

  const password = randomBytes(32).toString('base64url');
  const passwordFile = join(temporary, 'initdb-password');
  await writeFile(passwordFile, `${password}\n`, {
    encoding: 'utf8',
    flag: 'wx',
    mode: 0o600,
  });
  utilityEnv = {
    ...Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('PG'))),
    PATH: `${bin}${delimiter}${process.env.PATH ?? ''}`,
  };
  databaseEnv = {
    ...utilityEnv,
    PGHOST: '127.0.0.1',
    PGPORT: String(port),
    PGDATABASE: 'postgres',
    PGUSER: 'test_admin',
    PGPASSWORD: password,
    PGOPTIONS: '',
    PGCLIENTENCODING: 'UTF8',
    PGTZ: 'UTC',
    PGSSLMODE: 'disable',
    PGCONNECT_TIMEOUT: '5',
  };
  succeeded(
    await run(
      binary('initdb'),
      [
        '-D',
        join(temporary, 'data'),
        '--username=test_admin',
        '--pwfile',
        passwordFile,
        '--auth-host=scram-sha-256',
        '--auth-local=trust',
        '--encoding=UTF8',
        '--no-locale',
        '--no-instructions',
      ],
      '',
      utilityEnv,
    ),
  );
  initialized = true;
  await rm(passwordFile, { force: true });

  serverStartAttempted = true;
  succeeded(
    await run(
      binary('pg_ctl'),
      [
        '-D',
        join(temporary, 'data'),
        '-l',
        join(temporary, 'server.log'),
        '-o',
        `-h 127.0.0.1 -p ${port} -c unix_socket_directories=''`,
        '-w',
        '-t',
        '15',
        'start',
      ],
      '',
      utilityEnv,
    ),
  );

  const hostAuth = await readFile(join(temporary, 'data', 'pg_hba.conf'), 'utf8');
  assert.match(hostAuth, /^host\s+all\s+all\s+127\.0\.0\.1\/32\s+scram-sha-256\s*$/m);
  assert.equal(
    succeeded(
      await sql(
        "select rolpassword like 'SCRAM-SHA-256$%' from pg_authid where rolname = 'test_admin';",
      ),
    ),
    't',
  );

  succeeded(await sql(await readFile(join(root, 'supabase/tests/bootstrap.sql'), 'utf8')));
  async function checkProductionPolicySchema(expectedReady) {
    succeeded(await sql('CREATE ROLE postgres NOLOGIN SUPERUSER;'));
    try {
      const checkSource = await readFile(
        join(root, 'supabase/operations/production-trial-policy-check.sql'),
        'utf8',
      );
      const metadata = JSON.parse(succeeded(await sql(`SET ROLE postgres;\n${checkSource}`)));
      assert.equal(metadata.identityOk, true);
      assert.equal(metadata.readOnly, true);
      assert.equal(metadata.public80SchemaReady, expectedReady);
      assert.equal(metadata.public80Ready, false);
      assert.equal(metadata.public80Prepared, false);
      assert.equal(typeof metadata.initialPolicy, 'boolean');
      assert.equal(typeof metadata.trialPrepared, 'boolean');
      const stopSource = (
        await readFile(join(root, 'supabase/operations/production-trial-policy-write.sql'), 'utf8')
      ).replace('-- TRIAL_POLICY_SETTINGS', "SET LOCAL manga_nikki.trial_policy_operation='stop';");
      assert.equal(
        succeeded(await sql(`SET ROLE postgres;\n${stopSource}`)),
        'TRIAL_POLICY_TRANSACTION_COMMITTED',
      );
    } finally {
      succeeded(await sql('DROP ROLE postgres;'));
    }
  }
  for (const file of (await readdir(join(root, 'supabase/migrations')))
    .filter((name) => name.endsWith('.sql'))
    .sort()) {
    if (file === '20261107010000_public_generation_budget_policy.sql')
      await checkProductionPolicySchema(false);
    succeeded(await sql(await readFile(join(root, 'supabase/migrations', file), 'utf8')));
    if (file === '20261107010000_public_generation_budget_policy.sql')
      await checkProductionPolicySchema(true);
  }
  succeeded(await sql(await readFile(join(root, 'supabase/tests/diary.sql'), 'utf8')));
  succeeded(await sql(await readFile(join(root, 'supabase/tests/reservations.sql'), 'utf8')));
  succeeded(await sql(await readFile(join(root, 'supabase/tests/generation_queue.sql'), 'utf8')));
  succeeded(await sql(await readFile(join(root, 'supabase/tests/openai_generation.sql'), 'utf8')));
  succeeded(await sql(await readFile(join(root, 'supabase/tests/comic_storage.sql'), 'utf8')));
  succeeded(await sql(await readFile(join(root, 'supabase/tests/comic_shares.sql'), 'utf8')));
  console.log('成功: 漫画共有の所有者確認・本文非公開・再送・期限/削除失効・RPC権限');
  succeeded(await sql(await readFile(join(root, 'supabase/tests/entry_write_limits.sql'), 'utf8')));
  succeeded(
    await sql(
      await readFile(join(root, 'supabase/tests/public_generation_budget_policy.sql'), 'utf8'),
    ),
  );
  console.log('成功: 任意全体件数cap・JST通常3枠・private日次例外・例外込み累積予算・権限');
  const public80Activation = await readFile(
    join(root, 'supabase/operations/production-public80-policy-write.sql'),
    'utf8',
  );
  const public80ActivationBody = public80Activation.match(/^DO \$\$\n([\s\S]*?)\n\$\$;/m)?.[1];
  assert.ok(public80ActivationBody, '80USD有効化の固定DO本文が存在する');
  const public80OperationTest = await readFile(
    join(root, 'supabase/tests/production_public80_policy.sql'),
    'utf8',
  );
  assert.equal(public80OperationTest.split('-- PUBLIC80_ACTIVATION_FUNCTION').length, 2);
  succeeded(
    await sql(
      public80OperationTest.replace(
        '-- PUBLIC80_ACTIVATION_FUNCTION',
        () =>
          `CREATE FUNCTION pg_temp.activate_public80() RETURNS void LANGUAGE plpgsql AS $activation$\n${public80ActivationBody}\n$activation$;`,
      ),
    ),
  );
  console.log('成功: 初回成功履歴を保持した80USD policy有効化・owner自動選定・不確定状態拒否');

  console.log('成功: RLS・RPC権限・入力・冪等性・編集競合・削除・期限・下書き上限');
  console.log('成功: 生成枠policy・原子的予約・snapshot・停止後再送・予算profile');
  console.log('成功: mock専用受付・Queue完了・quota・再送照合・期限/削除精算');
  console.log(
    '成功: OpenAI profile allowlist・予算quota・saving開始・候補fairness/3件上限/5分backoff/24時間期限',
  );
  console.log(
    '成功: comic save task・lease・厳密asset/comic確定・consumed精算・retention path union',
  );
  console.log('成功: JST日次entry制限・保持容量上限・物理回収・counter ACL');

  const comicRaceActor = 'fa000000-0000-4000-8000-000000000001';
  const comicRaceRequest = 'fa000000-0000-4000-8000-000000000002';
  const comicRaceIdempotency = 'fa000000-0000-4000-8000-000000000003';
  const comicRaceProfile = JSON.stringify({
    profile_id: 'openai-script-gpt-4.1-mini-2025-04-14+image-gpt-image-2.5-flare-bw-v1',
    is_mock: false,
    max_cost_micro_usd: 17,
    max_image_calls: 4,
    provider: 'openai',
    script_model: 'gpt-4.1-mini-2025-04-14',
    image_model: 'gpt-image-2.5-flare',
    color_mode: 'monochrome',
  });
  const comicRaceScript = JSON.stringify({
    title: '隔離競合用の架空漫画',
    panels: [1, 2, 3, 4].map((index) => ({
      index,
      scene: `競合確認の架空scene ${index}`,
      caption: `架空caption ${index}`,
      dialogue: '',
    })),
  });
  const comicRaceAssets = JSON.stringify(
    [1, 2, 3, 4].map((index) => ({
      index,
      media_type: 'image/png',
      byte_size: 1200,
      width: 1024,
      height: 1024,
      sha256: String.fromCharCode(96 + index).repeat(64),
    })),
  );
  const comicRaceAttemptSteps = [
    { stage: 'script', index: 1 },
    ...Array.from({ length: 4 }, (_, index) => ({ stage: 'images', index: index + 1 })),
  ]
    .map(
      ({ stage, index }) => `
select (public.begin_provider_attempt(:'race_generation'::uuid, :'race_claim'::uuid, '${stage}', ${index}, true) ->> 'attempt_id') as race_attempt \\gset
select public.finish_provider_attempt(:'race_generation'::uuid, :'race_claim'::uuid,
  :'race_attempt'::uuid, 'succeeded', 'fictional-save-lease-race-${stage}-${index}') as race_finished \\gset`,
    )
    .join('\n');
  const comicRaceSetup = `
begin;
insert into auth.users(id) values ('${comicRaceActor}');
update private.generation_policy set enabled = true, user_daily_limit = 10,
  global_daily_limit = 10, global_total_limit = 10, budget_micro_usd = 1000,
  model_profile_json = '${comicRaceProfile.replaceAll("'", "''")}'::jsonb where id = 1;
set local role service_role;
select (public.create_entry('${comicRaceActor}', '${comicRaceRequest}',
  (pg_catalog.statement_timestamp() at time zone 'Asia/Tokyo')::date,
  '保存lease競合確認用の架空日記', 'v1')).id as race_entry \\gset
select (public.reserve_openai_generation('${comicRaceActor}', :'race_entry'::uuid, 1,
  '${comicRaceIdempotency}', true) ->> 'generation_id') as race_generation \\gset
select (public.claim_generation(:'race_generation'::uuid) ->> 'claim_token') as race_claim \\gset
${comicRaceAttemptSteps}
select public.mark_generation_saving(:'race_generation'::uuid, :'race_claim'::uuid) as race_saving \\gset
select public.begin_comic_save_task(:'race_generation'::uuid, '${comicRaceActor}', 1,
  (pg_catalog.statement_timestamp() at time zone 'Asia/Tokyo')::date, :'race_claim'::uuid,
  'openai-script-gpt-4.1-mini-2025-04-14+image-gpt-image-2.5-flare-bw-v1',
  '${comicRaceScript.replaceAll("'", "''")}'::jsonb,
  '${comicRaceAssets.replaceAll("'", "''")}'::jsonb) as race_task \\gset
reset role;
update public.generations set deadline_at = pg_catalog.clock_timestamp() - interval '1 minute'
where id = :'race_generation'::uuid;
update private.comic_save_tasks set lease_expires_at = pg_catalog.clock_timestamp() - interval '1 second'
where generation_id = :'race_generation'::uuid;
commit;
select :'race_generation' || '|' || :'race_claim';`;
  const comicRaceIds = succeeded(await sql(comicRaceSetup)).split('|');
  assert.equal(comicRaceIds.length, 2);
  const [comicRaceGeneration, comicRaceClaim] = comicRaceIds;
  const concurrentComicRecoveryClaims = await Promise.all(
    Array.from({ length: 6 }, (_, index) =>
      sql(
        `set role service_role; select public.claim_comic_save_recovery('${comicRaceGeneration}');`,
        `mn-db-comic-recovery-claim-${index}`,
      ),
    ),
  );
  const comicRecoveryClaims = concurrentComicRecoveryClaims.map((result) =>
    JSON.parse(succeeded(result)),
  );
  const acquiredComicRecoveryClaims = comicRecoveryClaims.filter(
    (result) => result.status === 'claimed',
  );
  assert.equal(acquiredComicRecoveryClaims.length, 1);
  assert.equal(comicRecoveryClaims.filter((result) => result.status === 'pending').length, 5);
  const comicRecoverySaveClaim = acquiredComicRecoveryClaims[0].save_claim_token;
  const failedComicRecovery = JSON.parse(
    succeeded(
      await sql(
        `set role service_role; select public.fail_comic_save('${comicRaceGeneration}', '${comicRaceClaim}', '${comicRecoverySaveClaim}');`,
      ),
    ),
  );
  assert.equal(failedComicRecovery.status, 'failed');
  const deletionFixtureOwner = 'fa100000-0000-4000-8000-000000000001';
  succeeded(
    await sql(`insert into private.storage_deletion_outbox(object_path,next_check_at)
      select '${deletionFixtureOwner}/fa200000-0000-4000-8000-000000000001/' ||
        'fa300000-0000-4000-8000-' || lpad(index::text,12,'0') || '.png',
        '2026-11-05 00:00:00+00'::timestamptz
      from generate_series(1,45) as fixture(index);`),
  );
  const deletionHolderName = 'mn-db-storage-gc-lock-holder';
  const deletionLockMarker = `${deletionHolderName}:lock-acquired`;
  const deletionHolder = startSqlSession(deletionHolderName);
  let deletionClaimant;
  let deletionClaimReachedMarker;
  let deletionMarkerWait;
  try {
    deletionHolder.write(`begin;
      select object_path from private.storage_deletion_outbox
      where object_path like '${deletionFixtureOwner}/%'
      order by next_check_at,object_path limit 40 for update;
      \\echo ${deletionLockMarker}\n`);
    await deletionHolder.waitForOutput(deletionLockMarker);
    deletionClaimant = startSqlSession('mn-db-storage-gc-skip-locked-claim');
    const deletionClaimMarker = 'mn-db-storage-gc-skip-locked-claim:returned';
    deletionClaimant.write(`set role service_role;
      select public.claim_storage_deletion_cleanup(40);
      \\echo ${deletionClaimMarker}\n`);
    deletionMarkerWait = deletionClaimant.waitForOutput(deletionClaimMarker);
    let timeout;
    deletionClaimReachedMarker = await Promise.race([
      deletionMarkerWait.then(() => true),
      new Promise((resolve) => {
        timeout = setTimeout(() => resolve(false), 1_000);
      }),
    ]);
    clearTimeout(timeout);
  } finally {
    await deletionHolder.finish('commit');
  }
  assert.ok(deletionClaimant);
  await deletionMarkerWait;
  const deletionClaimResult = await deletionClaimant.finish('select 1');
  const firstDeletionBatch = JSON.parse(
    deletionClaimResult.stdout.split('\n').find((line) => line.startsWith('[')),
  );
  assert.equal(
    deletionClaimReachedMarker,
    true,
    'Storage GCはロック済みrowで待たずにSKIP LOCKEDする',
  );
  assert.equal(firstDeletionBatch.length, 5);
  assert.deepEqual(
    firstDeletionBatch.map((item) => item.object_path),
    Array.from(
      { length: 5 },
      (_, index) =>
        `${deletionFixtureOwner}/fa200000-0000-4000-8000-000000000001/` +
        `fa300000-0000-4000-8000-${String(index + 41).padStart(12, '0')}.png`,
    ),
  );
  const secondDeletionBatch = JSON.parse(
    succeeded(
      await sql(
        'set role service_role; select public.claim_storage_deletion_cleanup(40);',
        'mn-db-storage-gc-next-batch',
      ),
    ),
  );
  assert.equal(secondDeletionBatch.length, 40);
  assert.deepEqual(
    secondDeletionBatch.map((item) => item.object_path),
    Array.from(
      { length: 40 },
      (_, index) =>
        `${deletionFixtureOwner}/fa200000-0000-4000-8000-000000000001/` +
        `fa300000-0000-4000-8000-${String(index + 1).padStart(12, '0')}.png`,
    ),
  );
  assert.equal(
    new Set([...firstDeletionBatch, ...secondDeletionBatch].map((item) => item.object_path)).size,
    45,
  );
  const oversizedDeletionBatch = await sql(
    'set role service_role; select public.claim_storage_deletion_cleanup(41);',
    'mn-db-storage-gc-max-limit',
  );
  assert.notEqual(oversizedDeletionBatch.code, 0);
  assert.match(oversizedDeletionBatch.stderr, /INVALID_LIMIT/);
  console.log('成功: Storage GCは40件上限・公平順・SKIP LOCKEDで残pathを拾う');
  succeeded(
    await sql(`begin;
      update private.quota_counters set count = count - 1,
        committed_micro_usd = committed_micro_usd - 17
        where scope = 'global_total' and subject is null and day_key is null;
      update private.quota_counters set count = count - 1,
        committed_micro_usd = committed_micro_usd - 17
        where scope = 'global_day' and subject is null
          and day_key = (select reserved_day from private.reservations where generation_id = '${comicRaceGeneration}');
      update private.quota_counters set count = count - 1,
        committed_micro_usd = committed_micro_usd - 17
        where scope = 'user_day' and subject = '${comicRaceActor}'
          and day_key = (select reserved_day from private.reservations where generation_id = '${comicRaceGeneration}');
      delete from private.comic_save_tasks where generation_id = '${comicRaceGeneration}';
      delete from private.provider_attempts where generation_id = '${comicRaceGeneration}';
      delete from private.reservations where generation_id = '${comicRaceGeneration}';
      update public.entries set latest_generation_id = null where id = (
        select entry_id from public.generations where id = '${comicRaceGeneration}');
      delete from public.generations where id = '${comicRaceGeneration}';
      delete from public.entries where owner_id = '${comicRaceActor}';
      delete from auth.users where id = '${comicRaceActor}';
      update private.generation_policy set enabled = false, user_daily_limit = 2,
        global_daily_limit = 0, global_total_limit = 0, budget_micro_usd = 0,
        model_profile_json = '{}'::jsonb where id = 1;
      commit;`),
  );
  console.log('成功: 6並列保存復旧claimは1 leaseだけ取得し、他5件はpending');

  const actor = '33333333-3333-4333-8333-333333333333';
  succeeded(await sql(`insert into auth.users(id) values ('${actor}');`));
  const key = '44444444-4444-4444-8444-444444444444';
  const duplicate = await runBehindLock({
    holderName: 'mn-db-create-duplicate-holder',
    lockSql: `select pg_advisory_xact_lock(hashtextextended('${actor}'::text, 0))`,
    waiterPrefix: 'mn-db-create-duplicate-',
    queries: Array.from({ length: 6 }, () => `set role service_role; ${create(actor, key)}`),
  });
  const ids = duplicate.map((result) => succeeded(result));
  assert.equal(new Set(ids).size, 1);
  assert.equal(
    succeeded(await sql(`select count(*) from public.entries where owner_id = '${actor}';`)),
    '1',
  );

  const conflict = await runBehindLock({
    holderName: 'mn-db-create-conflict-holder',
    lockSql: `select pg_advisory_xact_lock(hashtextextended('${actor}'::text, 0))`,
    waiterPrefix: 'mn-db-create-conflict-',
    queries: ['競合A', '競合B'].map(
      (body) =>
        `set role service_role; ${create(actor, '55555555-5555-4555-8555-555555555555', body)}`,
    ),
  });
  assert.equal(conflict.filter((result) => result.code === 0).length, 1);
  assert.equal(
    conflict.filter((result) => result.code !== 0 && result.stderr.includes('IDEMPOTENCY_CONFLICT'))
      .length,
    1,
  );

  const entryId = ids[0].trim();
  const edits = await runBehindLock({
    holderName: 'mn-db-edit-revision-holder',
    lockSql: `select id from public.entries where id = '${entryId}' for update`,
    waiterPrefix: 'mn-db-edit-revision-',
    queries: ['編集A', '編集B'].map(
      (body) =>
        `set role service_role; select (public.update_entry('${actor}','${entryId}',1,current_date,'${body}')).revision;`,
    ),
  });
  assert.equal(edits.filter((result) => result.code === 0).length, 1);
  assert.equal(
    edits.filter((result) => result.code !== 0 && result.stderr.includes('REVISION_CONFLICT'))
      .length,
    1,
  );
  assert.equal(
    succeeded(await sql(`select revision from public.entries where id = '${entryId}';`)),
    '2',
  );
  console.log('成功: DBロック待ちを同期した同一キー作成・内容競合・同一revision編集');

  const limitedActor = '66666666-6666-4666-8666-666666666666';
  succeeded(
    await sql(`insert into auth.users(id) values ('${limitedActor}'); set role service_role;
    do $$ begin for i in 1..19 loop perform public.create_entry('${limitedActor}',gen_random_uuid(),current_date,'枠確認の架空日記','v1'); end loop; end $$;`),
  );
  const finalSlot = await runBehindLock({
    holderName: 'mn-db-create-final-slot-holder',
    lockSql: `select pg_advisory_xact_lock(hashtextextended('${limitedActor}'::text, 0))`,
    waiterPrefix: 'mn-db-create-final-slot-',
    queries: Array.from(
      { length: 6 },
      () =>
        `set role service_role; select (public.create_entry('${limitedActor}',gen_random_uuid(),current_date,'最後の枠','v1')).id;`,
    ),
  });
  assert.equal(finalSlot.filter((result) => result.code === 0).length, 1);
  assert.equal(
    finalSlot.filter((result) => result.code !== 0 && result.stderr.includes('DRAFT_LIMIT_REACHED'))
      .length,
    5,
  );
  assert.equal(
    succeeded(await sql(`select count(*) from public.entries where owner_id = '${limitedActor}';`)),
    '20',
  );
  console.log('成功: DBロック待ちを同期した最後の下書き1枠への6並列要求');

  const reservationActors = [
    '77777777-7777-4777-8777-777777777777',
    '88888888-8888-4888-8888-888888888888',
    '99999999-9999-4999-8999-999999999999',
    'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    'abababab-abab-4bab-8bab-abababababab',
  ];
  const reservationEntries = succeeded(
    await sql(`
      insert into auth.users(id) values ${reservationActors.map((id) => `('${id}')`).join(',')};
      update private.generation_policy set enabled = true, user_daily_limit = 10,
        global_daily_limit = 10, global_total_limit = 10, budget_micro_usd = 1000,
        model_profile_json = '{"profile_id":"fictional-concurrency-v1","is_mock":true,"max_cost_micro_usd":7}'::jsonb;
      set role service_role;
      select (public.create_entry('${reservationActors[0]}',gen_random_uuid(),(statement_timestamp() at time zone 'Asia/Tokyo')::date,'同一キー競合用の架空日記','v1')).id;
      select (public.create_entry('${reservationActors[1]}',gen_random_uuid(),(statement_timestamp() at time zone 'Asia/Tokyo')::date,'同時実行A用の架空日記','v1')).id;
      select (public.create_entry('${reservationActors[1]}',gen_random_uuid(),(statement_timestamp() at time zone 'Asia/Tokyo')::date,'同時実行B用の架空日記','v1')).id;
      select (public.create_entry('${reservationActors[2]}',gen_random_uuid(),(statement_timestamp() at time zone 'Asia/Tokyo')::date,'全体枠競合A用の架空日記','v1')).id;
      select (public.create_entry('${reservationActors[3]}',gen_random_uuid(),(statement_timestamp() at time zone 'Asia/Tokyo')::date,'全体枠競合B用の架空日記','v1')).id;
      select (public.create_entry('${reservationActors[4]}',gen_random_uuid(),(statement_timestamp() at time zone 'Asia/Tokyo')::date,'policy更新競合用の架空日記','v1')).id;
    `),
  )
    .split('\n')
    .filter(Boolean);
  assert.equal(reservationEntries.length, 6);
  const [
    duplicateEntry,
    sameActorEntryA,
    sameActorEntryB,
    globalEntryA,
    globalEntryB,
    policyUpdateEntry,
  ] = reservationEntries;
  const reservationKey = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
  const duplicateReservations = await runBehindLock({
    holderName: 'mn-db-reserve-duplicate-holder',
    lockSql: 'select pg_catalog.pg_advisory_xact_lock(20261103, 10001)',
    waiterPrefix: 'mn-db-reserve-duplicate-',
    queries: Array.from(
      { length: 6 },
      () =>
        `set role service_role; select public.reserve_mock_generation('${reservationActors[0]}','${duplicateEntry}',1,'${reservationKey}');`,
    ),
  });
  const duplicateReceipts = duplicateReservations.map((result) => JSON.parse(succeeded(result)));
  assert.equal(new Set(duplicateReceipts.map((receipt) => receipt.generation_id)).size, 1);
  assert.equal(
    succeeded(
      await sql(`select (select count(*) from public.generations where owner_id = '${reservationActors[0]}') || ':' ||
        (select count(*) from private.reservations where owner_id = '${reservationActors[0]}') || ':' ||
        (select count || ':' || committed_micro_usd from private.quota_counters where scope = 'global_total');`),
    ),
    '1:1:1:7',
  );
  console.log('成功: 同一キー6並列mock予約はjob・reservation・予算計上が各1件');

  const duplicateGeneration = duplicateReceipts[0].generation_id;
  const duplicateClaim = JSON.parse(
    succeeded(
      await sql(`set role service_role; select public.claim_generation('${duplicateGeneration}');`),
    ),
  ).claim_token;
  const duplicateScriptAttempt = succeeded(
    await sql(`set role service_role; select public.begin_provider_attempt(
      '${duplicateGeneration}', '${duplicateClaim}', 'script', 1, false) ->> 'attempt_id';`),
  );
  succeeded(
    await sql(`set role service_role; select public.finish_provider_attempt(
      '${duplicateGeneration}', '${duplicateClaim}', '${duplicateScriptAttempt}', 'succeeded', null);`),
  );
  const duplicateImageAttempt = succeeded(
    await sql(`set role service_role; select public.begin_provider_attempt(
      '${duplicateGeneration}', '${duplicateClaim}', 'images', 1, false) ->> 'attempt_id';`),
  );
  succeeded(
    await sql(`set role service_role; select public.finish_provider_attempt(
      '${duplicateGeneration}', '${duplicateClaim}', '${duplicateImageAttempt}', 'succeeded', null);`),
  );
  const completedRevisionWait = await runBehindLock({
    holderName: 'mn-db-revision-completion-holder',
    lockSql: "select 1 from private.quota_counters where scope = 'global_total' for update",
    waiterPrefix: 'mn-db-revision-completion-',
    queries: [
      `set role service_role; select public.reserve_mock_generation('${reservationActors[0]}','${duplicateEntry}',1,'bcbcbcbc-bcbc-4bcb-8bcb-bcbcbcbcbcbc');`,
    ],
    beforeRequests: async (holder) => {
      const completedMarker = 'mn-db-revision-completion-holder:completed';
      holder.write(`select public.complete_mock_generation('${duplicateGeneration}', '${duplicateClaim}',
        pg_catalog.jsonb_build_object(
          'schemaVersion', 1, 'title', '同期競合用の架空サンプル',
          'panels', pg_catalog.jsonb_build_array(
            pg_catalog.jsonb_build_object('index', 1, 'scene', '場面1', 'caption', '', 'dialogue', ''),
            pg_catalog.jsonb_build_object('index', 2, 'scene', '場面2', 'caption', '', 'dialogue', ''),
            pg_catalog.jsonb_build_object('index', 3, 'scene', '場面3', 'caption', '', 'dialogue', ''),
            pg_catalog.jsonb_build_object('index', 4, 'scene', '場面4', 'caption', '', 'dialogue', '')
          ),
          'visual', pg_catalog.jsonb_build_object(
            'kind', 'page', 'assetId', '${duplicateGeneration}', 'textMode', 'external'
          )
        ));
        \\echo ${completedMarker}\n`);
      await holder.waitForOutput(completedMarker);
    },
  });
  assert.notEqual(completedRevisionWait[0].code, 0, completedRevisionWait[0].stdout);
  assert.match(completedRevisionWait[0].stderr, /REVISION_ALREADY_GENERATED/);
  assert.equal(
    succeeded(
      await sql(
        `select count(*) from public.generations where owner_id = '${reservationActors[0]}';`,
      ),
    ),
    '1',
  );
  console.log('成功: 旧mock生成の完了commitを待つ同revision予約はREVISION_ALREADY_GENERATEDで拒否');

  const differentEntriesSameActor = await runBehindLock({
    holderName: 'mn-db-reserve-user-active-holder',
    lockSql: "select 1 from private.quota_counters where scope = 'global_total' for update",
    waiterPrefix: 'mn-db-reserve-user-active-',
    queries: [sameActorEntryA, sameActorEntryB].map(
      (entryId, index) =>
        `set role service_role; select public.reserve_generation('${reservationActors[1]}','${entryId}',1,'cccccccc-cccc-4ccc-8ccc-cccccccc000${index + 1}',true);`,
    ),
  });
  assert.equal(differentEntriesSameActor.filter((result) => result.code === 0).length, 1);
  assert.equal(
    differentEntriesSameActor.filter(
      (result) => result.code !== 0 && result.stderr.includes('TOO_MANY_ACTIVE'),
    ).length,
    1,
  );
  assert.equal(
    succeeded(
      await sql(`select (select count(*) from public.generations where owner_id = '${reservationActors[1]}') || ':' ||
        (select count(*) from private.reservations where owner_id = '${reservationActors[1]}') || ':' ||
        (select count || ':' || committed_micro_usd from private.quota_counters where scope = 'user_day' and subject = '${reservationActors[1]}');`),
    ),
    '1:1:1:7',
  );
  console.log('成功: 別日記の同時要求でも同一ユーザーのactive jobを1件に制限');

  succeeded(
    await sql(
      'update private.generation_policy set global_daily_limit = 3, global_total_limit = 3;',
    ),
  );
  const globalFinalSlot = await runBehindLock({
    holderName: 'mn-db-reserve-global-final-holder',
    lockSql: "select 1 from private.quota_counters where scope = 'global_total' for update",
    waiterPrefix: 'mn-db-reserve-global-final-',
    queries: [
      [reservationActors[2], globalEntryA, 'dddddddd-dddd-4ddd-8ddd-dddddddd0001'],
      [reservationActors[3], globalEntryB, 'eeeeeeee-eeee-4eee-8eee-eeeeeeee0002'],
    ].map(
      ([actor, entryId, key]) =>
        `set role service_role; select public.reserve_generation('${actor}','${entryId}',1,'${key}',true);`,
    ),
  });
  assert.equal(globalFinalSlot.filter((result) => result.code === 0).length, 1);
  assert.equal(
    globalFinalSlot.filter(
      (result) => result.code !== 0 && result.stderr.includes('GLOBAL_LIMIT_REACHED'),
    ).length,
    1,
  );
  assert.equal(
    succeeded(
      await sql(`select (select count(*) from public.generations) || ':' ||
        (select count(*) from private.reservations) || ':' ||
        (select count || ':' || committed_micro_usd from private.quota_counters where scope = 'global_total') || ':' ||
        (select count || ':' || committed_micro_usd from private.quota_counters where scope = 'global_day');`),
    ),
    '3:3:3:21:3:21',
  );
  console.log('成功: 全体の最後の1枠への別ユーザー同時要求は1件だけ予約');

  succeeded(
    await sql(
      'update private.generation_policy set enabled = true, global_daily_limit = 10, global_total_limit = 10;',
    ),
  );
  const retryKey = 'ffffffff-ffff-4fff-8fff-ffffffff0006';
  const retryHolderName = 'mn-db-policy-retry-holder';
  const retryHolder = startSqlSession(retryHolderName);
  let retryReservation;
  let retryStop;
  let retryReplay;
  let retrySynchronizationError;
  try {
    retryHolder.write(
      `begin;\nset local role service_role;\nselect pg_catalog.pg_advisory_xact_lock(20261103, 10001);\n\\echo ${retryHolderName}:lock-acquired\n`,
    );
    await retryHolder.waitForOutput(`${retryHolderName}:lock-acquired`);

    retryReservation = sql(
      `set role service_role; select public.reserve_generation('${reservationActors[4]}','${policyUpdateEntry}',1,'${retryKey}',true);`,
      'mn-db-policy-retry-a',
    );
    await waitForLockWaiters('mn-db-policy-retry-a', 1);

    retryStop = sql(
      'update private.generation_policy set enabled = false;',
      'mn-db-policy-retry-stop',
    );
    await waitForLockWaiters('mn-db-policy-retry-stop', 1);

    retryReplay = sql(
      `set role service_role; select public.reserve_generation('${reservationActors[4]}','${policyUpdateEntry}',1,'${retryKey}',true);`,
      'mn-db-policy-retry-b',
    );
    await waitForLockWaiters('mn-db-policy-retry-b', 1);
  } catch (error) {
    retrySynchronizationError = error;
  } finally {
    await retryHolder.finish(retrySynchronizationError ? 'rollback' : 'commit').catch((error) => {
      retrySynchronizationError ??= error;
    });
  }

  const retryResults = await Promise.all(
    [retryReservation, retryStop, retryReplay].filter(Boolean),
  );
  if (retrySynchronizationError) throw retrySynchronizationError;
  const [reservationResult, stopResult, replayResult] = retryResults;
  assert.equal(reservationResult.code, 0, reservationResult.stderr);
  assert.equal(stopResult.code, 0, stopResult.stderr);
  assert.equal(replayResult.code, 0, replayResult.stderr);
  const reservationReceipt = JSON.parse(succeeded(reservationResult));
  const replayReceipt = JSON.parse(succeeded(replayResult));
  assert.deepEqual(replayReceipt, reservationReceipt);
  assert.equal(
    succeeded(
      await sql(`select (select enabled::text from private.generation_policy where id = 1) || ':' ||
        (select count || ':' || committed_micro_usd from private.quota_counters where scope = 'global_total') || ':' ||
        (select count || ':' || committed_micro_usd from private.quota_counters where scope = 'global_day') || ':' ||
        (select count(*) from public.generations where owner_id = '${reservationActors[4]}') || ':' ||
        (select count(*) from private.reservations where owner_id = '${reservationActors[4]}') || ':' ||
        (select count || ':' || committed_micro_usd from private.quota_counters where scope = 'user_day' and subject = '${reservationActors[4]}');`),
    ),
    'false:4:28:4:28:1:1:1:7',
  );
  console.log('成功: 予約・policy停止・同一キー再送の待機順でもreceiptとquotaを一件だけ維持');

  const executionActors = [
    'bcbcbcbc-bcbc-4bcb-8bcb-bcbcbcbcbcbc',
    'cdcdcdcd-cdcd-4dcd-8dcd-cdcdcdcdcdcd',
  ];
  const executionEntries = succeeded(
    await sql(`
      insert into auth.users(id) values ${executionActors.map((id) => `('${id}')`).join(',')};
      update private.generation_policy set enabled = true, user_daily_limit = 10,
        global_daily_limit = 10, global_total_limit = 10, budget_micro_usd = 1000,
        model_profile_json = '{"profile_id":"fictional-execution-v1","is_mock":false,"max_cost_micro_usd":1}'::jsonb;
      set role service_role;
      select (public.create_entry('${executionActors[0]}',gen_random_uuid(),current_date,'claim競合の架空日記','v1')).id;
      select (public.create_entry('${executionActors[1]}',gen_random_uuid(),current_date,'cancel競合の架空日記','v1')).id;
    `),
  )
    .split('\n')
    .filter(Boolean);
  assert.equal(executionEntries.length, 2);
  const [claimEntry, cancelEntry] = executionEntries;
  const executionGenerationIds = [];
  for (const [index, entryId] of [claimEntry, cancelEntry].entries()) {
    const actor = executionActors[index];
    const key =
      index === 0 ? 'dededede-dede-4ded-8ded-dededededede' : 'efefefef-efef-4fef-8fef-efefefefefef';
    const receipt = JSON.parse(
      succeeded(
        await sql(
          `set role service_role; select public.reserve_generation('${actor}','${entryId}',1,'${key}',true);`,
        ),
      ),
    );
    executionGenerationIds.push(receipt.generation_id);
  }
  const [claimGeneration, cancelGeneration] = executionGenerationIds;

  const duplicateClaims = await runBehindLock({
    holderName: 'mn-db-claim-duplicate-holder',
    lockSql: 'select pg_catalog.pg_advisory_xact_lock(20261103, 10001)',
    waiterPrefix: 'mn-db-claim-duplicate-',
    queries: Array.from(
      { length: 6 },
      () => `set role service_role; select public.claim_generation('${claimGeneration}');`,
    ),
  });
  const acquiredClaims = duplicateClaims.map((result) => succeeded(result)).filter(Boolean);
  assert.equal(acquiredClaims.length, 1);
  const acquiredClaim = JSON.parse(acquiredClaims[0]);
  assert.equal(acquiredClaim.generation_id, claimGeneration);
  assert.ok(acquiredClaim.claim_token);
  const duplicateBegins = await runBehindLock({
    holderName: 'mn-db-attempt-duplicate-holder',
    lockSql: 'select pg_catalog.pg_advisory_xact_lock(20261103, 10001)',
    waiterPrefix: 'mn-db-attempt-duplicate-',
    queries: Array.from(
      { length: 6 },
      () =>
        `set role service_role; select public.begin_provider_attempt('${claimGeneration}','${acquiredClaim.claim_token}','script',1,true);`,
    ),
  });
  assert.equal(duplicateBegins.filter((result) => result.code === 0).length, 1);
  assert.equal(
    duplicateBegins.filter(
      (result) => result.code !== 0 && result.stderr.includes('ATTEMPT_UNRESOLVED'),
    ).length,
    5,
  );
  const heldClaimResult = JSON.parse(
    succeeded(
      await sql(
        `set role service_role; select public.fail_or_hold_generation('${claimGeneration}','${acquiredClaim.claim_token}','failed');`,
      ),
    ),
  );
  assert.equal(heldClaimResult.status, 'unknown');
  assert.equal(heldClaimResult.reservation_state, 'held');
  assert.equal(
    succeeded(
      await sql(
        `select count(*) from private.provider_attempts where generation_id = '${claimGeneration}';`,
      ),
    ),
    '1',
  );
  console.log('成功: 6並列claimは1 Consumerだけが取得し、同一provider attemptは1回だけ開始');

  const cancelClaim = JSON.parse(
    succeeded(
      await sql(`set role service_role; select public.claim_generation('${cancelGeneration}');`),
    ),
  );
  const counterBeforeCancelRace = succeeded(
    await sql(
      "select count || ':' || committed_micro_usd from private.quota_counters where scope = 'global_total';",
    ),
  );
  const cancelDispatchRace = await runBehindLock({
    holderName: 'mn-db-cancel-dispatch-holder',
    lockSql: `select id from public.entries where id = '${cancelEntry}' for update`,
    waiterPrefix: 'mn-db-cancel-dispatch-',
    queries: [
      `set role service_role; select public.begin_provider_attempt('${cancelGeneration}','${cancelClaim.claim_token}','script',1,true);`,
      `set role service_role; select public.request_entry_deletion('${executionActors[1]}','${cancelEntry}');`,
    ],
  });
  const [dispatchResult, deleteResult] = cancelDispatchRace;
  assert.equal(deleteResult.code, 0, deleteResult.stderr);
  const cancelResult = JSON.parse(
    succeeded(
      await sql(
        `set role service_role; select public.fail_or_hold_generation('${cancelGeneration}','${cancelClaim.claim_token}','cancelled');`,
      ),
    ),
  );
  const cancelRaceAttemptCount = Number(
    succeeded(
      await sql(
        `select count(*) from private.provider_attempts where generation_id = '${cancelGeneration}';`,
      ),
    ),
  );
  const counterAfterCancelRace = succeeded(
    await sql(
      "select count || ':' || committed_micro_usd from private.quota_counters where scope = 'global_total';",
    ),
  );
  if (dispatchResult.code === 0) {
    assert.equal(JSON.parse(succeeded(dispatchResult)).mode, 'provider');
    assert.equal(cancelRaceAttemptCount, 1);
    assert.equal(cancelResult.status, 'unknown');
    assert.equal(cancelResult.reservation_state, 'held');
    assert.equal(counterAfterCancelRace, counterBeforeCancelRace);
  } else {
    assert.match(dispatchResult.stderr, /GENERATION_CANCELLED/);
    assert.equal(cancelRaceAttemptCount, 0);
    assert.equal(cancelResult.status, 'cancelled');
    assert.equal(cancelResult.reservation_state, 'released');
    const [beforeCount, beforeCost] = counterBeforeCancelRace.split(':').map(Number);
    const [afterCount, afterCost] = counterAfterCancelRace.split(':').map(Number);
    assert.equal(afterCount, beforeCount - 1);
    assert.equal(afterCost, beforeCost - 1);
  }
  console.log('成功: cancelとprovider dispatchの競合で、外部送信済み枠を誤返却しない');

  const timeCheckActors = [
    '12345678-1234-4234-8234-123456789012',
    '23456789-2345-4345-8345-234567890123',
    '34567890-3456-4456-8456-345678901234',
  ];
  const timeCheckEntries = succeeded(
    await sql(`
      insert into auth.users(id) values ${timeCheckActors.map((id) => `('${id}')`).join(',')};
      update private.generation_policy set enabled = true, user_daily_limit = 10,
        global_daily_limit = 100, global_total_limit = 100, budget_micro_usd = 100000,
        model_profile_json = '{"profile_id":"fictional-time-check-v1","is_mock":false,"max_cost_micro_usd":1}'::jsonb;
      set role service_role;
      ${timeCheckActors
        .map(
          (actor, index) =>
            `select (public.create_entry('${actor}',gen_random_uuid(),current_date,'期限判定用の架空日記${index + 1}','v1')).id;`,
        )
        .join('\n')}
    `),
  )
    .split('\n')
    .filter(Boolean);
  assert.equal(timeCheckEntries.length, 3);

  const timeCheckGenerationIds = [];
  for (const [index, entryId] of timeCheckEntries.entries()) {
    const receipt = JSON.parse(
      succeeded(
        await sql(
          `set role service_role; select public.reserve_generation('${timeCheckActors[index]}','${entryId}',1,'${`4567890${index}-4567-4567-8567-45678901234${index}`}',true);`,
        ),
      ),
    );
    timeCheckGenerationIds.push(receipt.generation_id);
  }
  const [expiryClaimGeneration, expiryBeginGeneration, expirySettleGeneration] =
    timeCheckGenerationIds;

  const expiryClaimResult = await runBehindEntryUntilDeadline({
    entryId: timeCheckEntries[0],
    waiterName: 'mn-db-claim-entry-expiry',
    query: `set role service_role; select public.claim_generation('${expiryClaimGeneration}');`,
    updateDeadlineSql: `update public.entries set expires_at = pg_catalog.clock_timestamp() + interval '250 milliseconds' where id = '${timeCheckEntries[0]}'`,
    deadlineExpression: `(select expires_at from public.entries where id = '${timeCheckEntries[0]}')`,
  });
  assert.equal(expiryClaimResult.code, 0, expiryClaimResult.stderr);
  assert.equal(succeeded(expiryClaimResult), '');
  assert.equal(
    succeeded(
      await sql(
        `select status || ':' || (select state from private.reservations where generation_id = '${expiryClaimGeneration}') from public.generations where id = '${expiryClaimGeneration}';`,
      ),
    ),
    'queued:reserved',
  );

  const expiryBeginClaim = JSON.parse(
    succeeded(
      await sql(
        `set role service_role; select public.claim_generation('${expiryBeginGeneration}');`,
      ),
    ),
  );
  const expiryBeginResult = await runBehindEntryUntilDeadline({
    entryId: timeCheckEntries[1],
    waiterName: 'mn-db-begin-claim-expiry',
    query: `set role service_role; select public.begin_provider_attempt('${expiryBeginGeneration}','${expiryBeginClaim.claim_token}','script',1,true);`,
    updateDeadlineSql: `update public.generations set deadline_at = pg_catalog.clock_timestamp() + interval '250 milliseconds' where id = '${expiryBeginGeneration}'`,
    deadlineExpression: `(select deadline_at from public.generations where id = '${expiryBeginGeneration}')`,
  });
  assert.notEqual(expiryBeginResult.code, 0, expiryBeginResult.stdout);
  assert.match(expiryBeginResult.stderr, /CLAIM_EXPIRED/);
  assert.equal(
    succeeded(
      await sql(
        `select count(*) from private.provider_attempts where generation_id = '${expiryBeginGeneration}';`,
      ),
    ),
    '0',
  );

  const expirySettleClaim = JSON.parse(
    succeeded(
      await sql(
        `set role service_role; select public.claim_generation('${expirySettleGeneration}');`,
      ),
    ),
  );
  const expirySettleResult = await runBehindEntryUntilDeadline({
    entryId: timeCheckEntries[2],
    waiterName: 'mn-db-settle-claim-expiry',
    query: `set role service_role; select public.fail_or_hold_generation('${expirySettleGeneration}',null,'failed');`,
    updateDeadlineSql: `update public.generations set deadline_at = pg_catalog.clock_timestamp() + interval '250 milliseconds' where id = '${expirySettleGeneration}'`,
    deadlineExpression: `(select deadline_at from public.generations where id = '${expirySettleGeneration}')`,
  });
  assert.equal(expirySettleResult.code, 0, expirySettleResult.stderr);
  const settledExpiredGeneration = JSON.parse(succeeded(expirySettleResult));
  assert.equal(settledExpiredGeneration.status, 'failed');
  assert.equal(settledExpiredGeneration.reservation_state, 'released');
  assert.equal(
    succeeded(
      await sql(
        `select status || ':' || (select state from private.reservations where generation_id = '${expirySettleGeneration}') from public.generations where id = '${expirySettleGeneration}';`,
      ),
    ),
    'failed:released',
  );
  assert.ok(expiryBeginClaim.claim_token);
  assert.ok(expirySettleClaim.claim_token);
  console.log('成功: entry/claim期限を待つRPCはロック取得後の時刻で判定');

  succeeded(await sql(await readFile(join(root, 'supabase/tests/retention.sql'), 'utf8')));
  console.log('成功: Storage-first purge・lease・台帳保持・RLS・tombstone・active job保護');

  const retentionRaceActor = '90909090-9090-4090-8090-909090909090';
  const retentionRaceRequest = '91919191-9191-4191-8191-919191919191';
  const retentionRaceEntry = succeeded(
    await sql(`
      insert into auth.users(id) values ('${retentionRaceActor}');
      set role service_role;
      select (public.create_entry('${retentionRaceActor}','${retentionRaceRequest}',current_date,'purge競合の架空日記','v1')).id;
    `),
  );
  succeeded(
    await sql(
      `update public.entries set expires_at = pg_catalog.clock_timestamp() - interval '1 second' where id = '${retentionRaceEntry}';`,
    ),
  );
  const retentionRaceClaims = JSON.parse(
    succeeded(await sql('set role service_role; select public.claim_retention_cleanup(10);')),
  );
  const retentionRaceTask = retentionRaceClaims.find(
    (task) => task.entry_id === retentionRaceEntry,
  );
  assert.ok(retentionRaceTask?.claim_token);
  const retentionCreateRace = await runBehindLock({
    holderName: 'mn-db-retention-create-purge-holder',
    lockSql: `select pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('${retentionRaceActor}'::text, 0))`,
    waiterPrefix: 'mn-db-retention-create-purge-',
    queries: [
      `set role service_role; select public.finalize_retention_cleanup('${retentionRaceEntry}','${retentionRaceTask.claim_token}',true);`,
      `set role service_role; select (public.create_entry('${retentionRaceActor}','${retentionRaceRequest}',current_date,'再送された架空日記','v1')).id;`,
    ],
  });
  assert.equal(retentionCreateRace.filter((result) => result.code === 0).length, 1);
  assert.equal(
    retentionCreateRace.filter((result) => result.code !== 0 && result.stderr.includes('NOT_FOUND'))
      .length,
    1,
  );
  assert.equal(
    succeeded(
      await sql(`select (select count(*) from public.entries where id = '${retentionRaceEntry}') || ':' ||
        (select count(*) from private.entry_tombstones where owner_id = '${retentionRaceActor}'
          and create_request_id = '${retentionRaceRequest}');`),
    ),
    '0:1',
  );
  console.log('成功: owner advisory lockでpurgeとcreate replayを直列化し日記を復活させない');

  const generationRaceActor = '92929292-9292-4929-8292-929292929292';
  const generationRaceKey = '93939393-9393-4939-8393-939393939393';
  const generationRaceEntryIds = succeeded(
    await sql(`
      insert into auth.users(id) values ('${generationRaceActor}');
      update private.generation_policy set enabled = true, user_daily_limit = 20,
        global_daily_limit = 1000, global_total_limit = 1000, budget_micro_usd = 1000000,
        model_profile_json = '{"profile_id":"fictional-retention-race-v1","is_mock":true,"max_cost_micro_usd":7}'::jsonb;
      set role service_role;
      select (public.create_entry('${generationRaceActor}',gen_random_uuid(),
        (statement_timestamp() at time zone 'Asia/Tokyo')::date,'purgeと生成予約競合の架空日記A','v1')).id;
      select (public.create_entry('${generationRaceActor}',gen_random_uuid(),
        (statement_timestamp() at time zone 'Asia/Tokyo')::date,'purgeと生成予約競合の架空日記B','v1')).id;
    `),
  )
    .split('\n')
    .filter(Boolean);
  assert.equal(generationRaceEntryIds.length, 2);
  const [generationRaceEntry, generationRaceReplayEntry] = generationRaceEntryIds;
  const generationRaceReceipt = JSON.parse(
    succeeded(
      await sql(
        `set role service_role; select public.reserve_mock_generation('${generationRaceActor}','${generationRaceEntry}',1,'${generationRaceKey}');`,
      ),
    ),
  );
  succeeded(
    await sql(
      `set role service_role; select public.fail_or_hold_generation('${generationRaceReceipt.generation_id}',null,'cancelled');`,
    ),
  );
  succeeded(
    await sql(
      `update public.entries set expires_at = pg_catalog.clock_timestamp() - interval '1 second' where id = '${generationRaceEntry}';`,
    ),
  );
  const generationRaceClaims = JSON.parse(
    succeeded(await sql('set role service_role; select public.claim_retention_cleanup(10);')),
  );
  const generationRaceTask = generationRaceClaims.find(
    (task) => task.entry_id === generationRaceEntry,
  );
  assert.ok(generationRaceTask?.claim_token);
  const generationRaceCountersBefore = succeeded(
    await sql(`select count || ':' || committed_micro_usd from private.quota_counters
      where scope = 'global_total';`),
  );
  const purgeReserveRace = await runBehindLock({
    holderName: 'mn-db-retention-generation-race-holder',
    lockSql: 'select pg_catalog.pg_advisory_xact_lock(20261103, 10001)',
    waiterPrefix: 'mn-db-retention-generation-race-',
    expectedWaiters: 1,
    queries: [
      `set role service_role; select public.finalize_retention_cleanup('${generationRaceEntry}','${generationRaceTask.claim_token}',true);`,
      `set role service_role; select public.reserve_generation('${generationRaceActor}','${generationRaceReplayEntry}',1,'${generationRaceKey}',true);`,
    ],
  });
  assert.equal(purgeReserveRace[0].code, 0, purgeReserveRace[0].stderr);
  assert.equal(succeeded(purgeReserveRace[0]), 't');
  assert.notEqual(purgeReserveRace[1].code, 0, purgeReserveRace[1].stdout);
  assert.match(purgeReserveRace[1].stderr, /IDEMPOTENCY_CONFLICT/);
  const archivedReserve = await sql(
    `set role service_role; select public.reserve_generation('${generationRaceActor}','${generationRaceReplayEntry}',1,'${generationRaceKey}',true);`,
  );
  assert.notEqual(archivedReserve.code, 0, archivedReserve.stdout);
  assert.match(archivedReserve.stderr, /IDEMPOTENCY_CONFLICT/);
  assert.equal(
    succeeded(
      await sql(`select (select count(*) from public.generations where owner_id = '${generationRaceActor}') || ':' ||
        (select count || ':' || committed_micro_usd from private.quota_counters where scope = 'global_total');`),
    ),
    `0:${generationRaceCountersBefore}`,
  );
  console.log('成功: policy lock下のpurge/生成予約競合と退避済みkey再利用を拒否');

  const openAiRaceActor = '94949494-9494-4949-8494-949494949494';
  const openAiRaceKey = '95959595-9595-4959-8595-959595959595';
  const openAiRaceEntry = succeeded(
    await sql(`
      insert into auth.users(id) values ('${openAiRaceActor}');
      update private.generation_policy set enabled = true, user_daily_limit = 20,
        global_daily_limit = 1000, global_total_limit = 1000, budget_micro_usd = 1000000,
        model_profile_json = '{"profile_id":"openai-script-gpt-4.1-mini-2025-04-14+image-gpt-image-2.5-flare-bw-v1","is_mock":false,"max_cost_micro_usd":19,"max_image_calls":4,"provider":"openai","script_model":"gpt-4.1-mini-2025-04-14","image_model":"gpt-image-2.5-flare","color_mode":"monochrome"}'::jsonb;
      set role service_role;
      select (public.create_entry('${openAiRaceActor}',gen_random_uuid(),
        (statement_timestamp() at time zone 'Asia/Tokyo')::date,'OpenAI予約競合の架空日記','v1')).id;
    `),
  );
  const openAiQuotaBefore = succeeded(
    await sql(`select count || ':' || committed_micro_usd from private.quota_counters
      where scope = 'global_total';`),
  )
    .split(':')
    .map(Number);
  const openAiDuplicateReservations = await runBehindLock({
    holderName: 'mn-db-openai-reserve-duplicate-holder',
    lockSql: 'select pg_catalog.pg_advisory_xact_lock(20261103, 10001)',
    waiterPrefix: 'mn-db-openai-reserve-duplicate-',
    queries: Array.from(
      { length: 6 },
      () =>
        `set role service_role; select public.reserve_openai_generation('${openAiRaceActor}','${openAiRaceEntry}',1,'${openAiRaceKey}',true);`,
    ),
  });
  const openAiReceipts = openAiDuplicateReservations.map((result) => JSON.parse(succeeded(result)));
  assert.equal(new Set(openAiReceipts.map((receipt) => receipt.generation_id)).size, 1);
  assert.equal(
    succeeded(
      await sql(`select (select count(*) from public.generations where owner_id = '${openAiRaceActor}') || ':' ||
        (select count(*) from private.reservations where owner_id = '${openAiRaceActor}');`),
    ),
    '1:1',
  );
  assert.deepEqual(
    succeeded(
      await sql(`select count || ':' || committed_micro_usd from private.quota_counters
        where scope = 'global_total';`),
    )
      .split(':')
      .map(Number),
    [openAiQuotaBefore[0] + 1, openAiQuotaBefore[1] + 19],
  );
  console.log('成功: OpenAI wrapperの同一キー6並列予約はjob・reservation・予算計上が各1件');

  const budgetRaceActors = Array.from({ length: 6 }, () => randomUUID());
  const budgetRacePolicy = succeeded(
    await sql('select to_jsonb(p) from private.generation_policy p where id = 1;'),
  );
  const budgetRaceBefore = succeeded(
    await sql(`select count || ':' || committed_micro_usd
      from private.quota_counters where scope = 'global_total';`),
  )
    .split(':')
    .map(Number);
  succeeded(
    await sql(`insert into auth.users(id) values ${budgetRaceActors.map((id) => `('${id}')`).join(',')};
      update private.generation_policy set enabled = true, user_daily_limit = 0,
        global_daily_limit = null, global_total_limit = null,
        daily_limit_exempt_owners = array[${budgetRaceActors.map((id) => `'${id}'`).join(',')}]::uuid[],
        budget_micro_usd = ${budgetRaceBefore[1] + 7},
        model_profile_json = '{"profile_id":"budget-race-fictional-v1","is_mock":true,"max_cost_micro_usd":7}'::jsonb
      where id = 1;`),
  );
  const budgetRaceEntries = [];
  for (const actorId of budgetRaceActors) {
    budgetRaceEntries.push(
      succeeded(
        await sql(`set role service_role;
      select (public.create_entry('${actorId}',gen_random_uuid(),
        (statement_timestamp() at time zone 'Asia/Tokyo')::date,'予算最終枠の架空日記','v1')).id;`),
      ),
    );
  }
  const budgetFinalSlot = await runBehindLock({
    holderName: 'mn-db-budget-null-caps-holder',
    lockSql: 'select pg_catalog.pg_advisory_xact_lock(20261103, 10001)',
    waiterPrefix: 'mn-db-budget-null-caps-',
    queries: budgetRaceActors.map(
      (actorId, index) =>
        `set role service_role; select public.reserve_mock_generation(
        '${actorId}','${budgetRaceEntries[index]}',1,'${randomUUID()}');`,
    ),
  });
  assert.equal(budgetFinalSlot.filter((result) => result.code === 0).length, 1);
  assert.equal(
    budgetFinalSlot.filter(
      (result) => result.code !== 0 && result.stderr.includes('GLOBAL_LIMIT_REACHED'),
    ).length,
    5,
  );
  assert.deepEqual(
    succeeded(
      await sql(`select count || ':' || committed_micro_usd
    from private.quota_counters where scope = 'global_total';`),
    )
      .split(':')
      .map(Number),
    [budgetRaceBefore[0] + 1, budgetRaceBefore[1] + 7],
  );
  assert.equal(
    succeeded(
      await sql(`select
    (select count(*) from public.generations where owner_id = any(array[${budgetRaceActors.map((id) => `'${id}'`).join(',')}]::uuid[])) || ':' ||
    (select count(*) from private.reservations where owner_id = any(array[${budgetRaceActors.map((id) => `'${id}'`).join(',')}]::uuid[]));`),
    ),
    '1:1',
  );
  const budgetPolicyColumns = [
    'enabled',
    'user_daily_limit',
    'global_daily_limit',
    'global_total_limit',
    'daily_limit_exempt_owners',
    'budget_micro_usd',
    'model_profile_json',
  ];
  succeeded(
    await sql(`update private.generation_policy set
    (${budgetPolicyColumns.join(',')}) = (select ${budgetPolicyColumns.map((column) => `saved.${column}`).join(',')}
      from jsonb_populate_record(null::private.generation_policy,
        '${budgetRacePolicy.replaceAll("'", "''")}'::jsonb) saved) where id = 1;`),
  );
  console.log('成功: 全体件数capなし・全員日次例外でも予算最終枠の6並列受付は1件だけ');

  const writeLimitOwner = 'e1010101-0101-4101-8101-010101010101';
  const ownerDailyKeys = Array.from({ length: 6 }, () => randomUUID());
  succeeded(
    await sql(`
      insert into auth.users(id) values ('${writeLimitOwner}');
      delete from private.entry_creation_owner_daily where owner_id = '${writeLimitOwner}';
      insert into private.entry_creation_owner_daily (owner_id, day_key, creation_count)
      values ('${writeLimitOwner}', (statement_timestamp() at time zone 'Asia/Tokyo')::date, 49);
    `),
  );
  const ownerDailyRace = await runBehindLock({
    holderName: 'mn-db-entry-owner-daily-holder',
    lockSql: 'select pg_catalog.pg_advisory_xact_lock(20261103, 10001)',
    waiterPrefix: 'mn-db-entry-owner-daily-',
    queries: ownerDailyKeys.map(
      (key, index) =>
        `set role service_role; ${create(writeLimitOwner, key, `owner daily parallel ${index}`)}`,
    ),
  });
  const ownerDailySuccess = ownerDailyRace.findIndex((result) => result.code === 0);
  assert.notEqual(ownerDailySuccess, -1);
  assert.equal(ownerDailyRace.filter((result) => result.code === 0).length, 1);
  assert.equal(
    ownerDailyRace.filter(
      (result) => result.code !== 0 && result.stderr.includes('ENTRY_OWNER_CREATE_LIMIT_REACHED'),
    ).length,
    5,
  );
  const ownerDailyWinnerId = succeeded(ownerDailyRace[ownerDailySuccess]);
  assert.equal(
    succeeded(
      await sql(
        `set role service_role; ${create(
          writeLimitOwner,
          ownerDailyKeys[ownerDailySuccess],
          `owner daily parallel ${ownerDailySuccess}`,
        )}`,
      ),
    ),
    ownerDailyWinnerId,
  );
  assert.equal(
    succeeded(
      await sql(`select creation_count from private.entry_creation_owner_daily
        where owner_id = '${writeLimitOwner}'
          and day_key = (statement_timestamp() at time zone 'Asia/Tokyo')::date;`),
    ),
    '50',
  );
  const ownerDailyWinnerEntry = succeeded(
    await sql(`select id from public.entries where owner_id = '${writeLimitOwner}'
      and create_request_id = '${ownerDailyKeys[ownerDailySuccess]}';`),
  );
  const ownerCountersBeforeDelete = succeeded(
    await sql(`select creation_count from private.entry_creation_owner_daily
      where owner_id = '${writeLimitOwner}'
        and day_key = (statement_timestamp() at time zone 'Asia/Tokyo')::date;`),
  );
  const globalCountersBeforeDelete = succeeded(
    await sql(`select creation_count from private.entry_creation_global_daily
      where day_key = (statement_timestamp() at time zone 'Asia/Tokyo')::date;`),
  );
  succeeded(
    await sql(
      `set role service_role; select public.request_entry_deletion('${writeLimitOwner}','${ownerDailyWinnerEntry}');`,
    ),
  );
  assert.equal(
    succeeded(
      await sql(`select creation_count from private.entry_creation_owner_daily
        where owner_id = '${writeLimitOwner}'
          and day_key = (statement_timestamp() at time zone 'Asia/Tokyo')::date;`),
    ),
    ownerCountersBeforeDelete,
  );
  assert.equal(
    succeeded(
      await sql(`select creation_count from private.entry_creation_global_daily
        where day_key = (statement_timestamp() at time zone 'Asia/Tokyo')::date;`),
    ),
    globalCountersBeforeDelete,
  );
  console.log('成功: ownerの日次作成最終枠は6並列でも1件だけ、冪等再送とDELETEは再計上しない');

  const globalDailyActors = Array.from({ length: 6 }, () => randomUUID());
  const globalDailyKeys = Array.from({ length: 6 }, () => randomUUID());
  succeeded(
    await sql(`
      insert into auth.users(id) values ${globalDailyActors.map((id) => `('${id}')`).join(',')};
      delete from private.entry_creation_global_daily;
      insert into private.entry_creation_global_daily (day_key, creation_count)
      values ((statement_timestamp() at time zone 'Asia/Tokyo')::date, 999);
    `),
  );
  const globalDailyRace = await runBehindLock({
    holderName: 'mn-db-entry-global-daily-holder',
    lockSql: 'select pg_catalog.pg_advisory_xact_lock(20261103, 10001)',
    waiterPrefix: 'mn-db-entry-global-daily-',
    queries: globalDailyActors.map(
      (actor, index) =>
        `set role service_role; ${create(actor, globalDailyKeys[index], `global daily parallel ${index}`)}`,
    ),
  });
  const globalDailySuccess = globalDailyRace.findIndex((result) => result.code === 0);
  assert.notEqual(globalDailySuccess, -1);
  assert.equal(globalDailyRace.filter((result) => result.code === 0).length, 1);
  assert.equal(
    globalDailyRace.filter(
      (result) => result.code !== 0 && result.stderr.includes('ENTRY_GLOBAL_CREATE_LIMIT_REACHED'),
    ).length,
    5,
  );
  const globalDailyWinnerId = succeeded(globalDailyRace[globalDailySuccess]);
  assert.equal(
    succeeded(
      await sql(
        `set role service_role; ${create(
          globalDailyActors[globalDailySuccess],
          globalDailyKeys[globalDailySuccess],
          `global daily parallel ${globalDailySuccess}`,
        )}`,
      ),
    ),
    globalDailyWinnerId,
  );
  assert.equal(
    succeeded(
      await sql(`select creation_count from private.entry_creation_global_daily
        where day_key = (statement_timestamp() at time zone 'Asia/Tokyo')::date;`),
    ),
    '1000',
  );
  console.log('成功: global JST日次作成最終枠もownerの異なる6並列要求で1件だけ');

  const retainedOwner = randomUUID();
  const retainedRequestKeys = Array.from({ length: 6 }, () => randomUUID());
  const retainedSeedOwners = Array.from({ length: 51 }, () => randomUUID());
  const retainedSeedArray = `array[${retainedSeedOwners.map((id) => `'${id}'`).join(',')}]::uuid[]`;
  const existingEntryCount = Number(succeeded(await sql('select count(*) from public.entries;')));
  assert.ok(existingEntryCount < 4999, 'retained capacity fixture has room to seed');
  const retainedRowsToSeed = 4999 - existingEntryCount;
  succeeded(
    await sql(`
      insert into auth.users(id) values ('${retainedOwner}'),
        ${retainedSeedOwners.map((id) => `('${id}')`).join(',')};
      delete from private.entry_creation_global_daily;
      insert into private.entry_creation_global_daily (day_key, creation_count)
      values ((statement_timestamp() at time zone 'Asia/Tokyo')::date, 0);
      do $$
      declare owners uuid[] := ${retainedSeedArray};
      begin
        insert into public.entries (
          owner_id, create_request_id, create_request_hash, diary_date, body, consent_version,
          deleted_at, expires_at
        )
        select owners[((series.n - 1) % pg_catalog.cardinality(owners)) + 1],
          pg_catalog.gen_random_uuid(), pg_catalog.decode(pg_catalog.repeat('ab', 32), 'hex'),
          (statement_timestamp() at time zone 'Asia/Tokyo')::date,
          '未回収の架空global fixture', 'v1',
          pg_catalog.clock_timestamp() - interval '100 years',
          pg_catalog.clock_timestamp() - interval '1 day'
        from pg_catalog.generate_series(1, ${retainedRowsToSeed}) as series(n);
      end $$;
    `),
  );
  assert.equal(succeeded(await sql('select count(*) from public.entries;')), '4999');
  const retainedRace = await runBehindLock({
    holderName: 'mn-db-entry-global-retained-holder',
    lockSql: 'select pg_catalog.pg_advisory_xact_lock(20261103, 10001)',
    waiterPrefix: 'mn-db-entry-global-retained-',
    queries: retainedRequestKeys.map(
      (key, index) =>
        `set role service_role; ${create(retainedOwner, key, `global retained parallel ${index}`)}`,
    ),
  });
  const retainedSuccess = retainedRace.findIndex((result) => result.code === 0);
  assert.notEqual(retainedSuccess, -1);
  assert.equal(retainedRace.filter((result) => result.code === 0).length, 1);
  assert.equal(
    retainedRace.filter(
      (result) =>
        result.code !== 0 && result.stderr.includes('ENTRY_GLOBAL_RETAINED_LIMIT_REACHED'),
    ).length,
    5,
  );
  const retainedWinnerId = succeeded(retainedRace[retainedSuccess]);
  assert.equal(succeeded(await sql('select count(*) from public.entries;')), '5000');
  assert.equal(
    succeeded(
      await sql(
        `set role service_role; ${create(
          retainedOwner,
          retainedRequestKeys[retainedSuccess],
          `global retained parallel ${retainedSuccess}`,
        )}`,
      ),
    ),
    retainedWinnerId,
  );
  const retainedWinnerEntry = succeeded(
    await sql(`select id from public.entries where owner_id = '${retainedOwner}'
      and create_request_id = '${retainedRequestKeys[retainedSuccess]}';`),
  );
  const retainedGlobalCountBeforeDelete = succeeded(
    await sql(`select creation_count from private.entry_creation_global_daily
      where day_key = (statement_timestamp() at time zone 'Asia/Tokyo')::date;`),
  );
  succeeded(
    await sql(
      `set role service_role; select public.request_entry_deletion('${retainedOwner}','${retainedWinnerEntry}');`,
    ),
  );
  assert.equal(
    succeeded(
      await sql(`select creation_count from private.entry_creation_global_daily
        where day_key = (statement_timestamp() at time zone 'Asia/Tokyo')::date;`),
    ),
    retainedGlobalCountBeforeDelete,
  );
  const retentionClaims = JSON.parse(
    succeeded(await sql('set role service_role; select public.claim_retention_cleanup(10);')),
  );
  const seedOwnerSet = new Set(retainedSeedOwners);
  const seedClaim = retentionClaims.find((claim) => seedOwnerSet.has(claim.owner_id));
  assert.ok(seedClaim?.claim_token);
  assert.equal(
    succeeded(
      await sql(`set role service_role; select public.finalize_retention_cleanup(
        '${seedClaim.entry_id}', '${seedClaim.claim_token}', true);`),
    ),
    't',
  );
  const afterPurgeRequest = randomUUID();
  assert.ok(
    succeeded(
      await sql(
        `set role service_role; ${create(retainedOwner, afterPurgeRequest, '回収後の作成')}`,
      ),
    ),
  );
  assert.equal(succeeded(await sql('select count(*) from public.entries;')), '5000');
  console.log('成功: global retained最終枠は6並列でも1件だけ、purgeが1行回収すると再作成可能');
} catch (error) {
  if (receivedSignal) {
    console.error(`DB検証を${receivedSignal}で中断しました。`);
  } else {
    console.error('DB検証失敗。PostgreSQLのサーバーバイナリと起動権限を確認してください。');
    console.error(error.message);
    process.exitCode = 1;
  }
} finally {
  await cleanup();
  process.off('SIGINT', handleSigint);
  process.off('SIGTERM', handleSigterm);
}
