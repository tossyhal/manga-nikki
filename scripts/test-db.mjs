import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
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

async function runBehindLock({ holderName, lockSql, waiterPrefix, queries }) {
  const marker = `${holderName}:lock-acquired`;
  const holder = startSqlSession(holderName);
  let requestsPromise = Promise.resolve([]);
  let synchronizationError;

  try {
    holder.write(`begin;\nset local role service_role;\n${lockSql};\n\\echo ${marker}\n`);
    await holder.waitForOutput(marker);
    requestsPromise = Promise.all(
      queries.map((query, index) => sql(query, `${waiterPrefix}${index}`)),
    );
    await waitForLockWaiters(waiterPrefix, queries.length);
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
  for (const file of (await readdir(join(root, 'supabase/migrations')))
    .filter((name) => name.endsWith('.sql'))
    .sort()) {
    succeeded(await sql(await readFile(join(root, 'supabase/migrations', file), 'utf8')));
  }
  succeeded(await sql(await readFile(join(root, 'supabase/tests/diary.sql'), 'utf8')));
  succeeded(await sql(await readFile(join(root, 'supabase/tests/reservations.sql'), 'utf8')));
  console.log('成功: RLS・RPC権限・入力・冪等性・編集競合・削除・期限・下書き上限');
  console.log('成功: 生成枠policy・原子的予約・snapshot・停止後再送・予算profile');

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
        `set role service_role; select public.reserve_generation('${reservationActors[0]}','${duplicateEntry}',1,'${reservationKey}',true);`,
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
  console.log('成功: 同一キー6並列予約はjob・reservation・予算計上が各1件');

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
    updateDeadlineSql: `update public.entries set expires_at = pg_catalog.clock_timestamp() + interval '2 seconds' where id = '${timeCheckEntries[0]}'`,
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
    updateDeadlineSql: `update public.generations set deadline_at = pg_catalog.clock_timestamp() + interval '2 seconds' where id = '${expiryBeginGeneration}'`,
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
    updateDeadlineSql: `update public.generations set deadline_at = pg_catalog.clock_timestamp() + interval '2 seconds' where id = '${expirySettleGeneration}'`,
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
