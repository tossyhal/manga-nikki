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
  ];
  const reservationEntries = succeeded(
    await sql(`
      insert into auth.users(id) values ${reservationActors.map((id) => `('${id}')`).join(',')};
      update private.generation_policy set enabled = true, user_daily_limit = 10,
        global_daily_limit = 10, global_total_limit = 10, budget_micro_usd = 1000,
        model_profile_json = '{"profile_id":"fictional-concurrency-v1","is_mock":true,"max_cost_micro_usd":7}'::jsonb;
      set role service_role;
      insert into private.quota_counters(scope, subject, day_key)
        values ('global_total', null, null),
          ('global_day', null, (statement_timestamp() at time zone 'Asia/Tokyo')::date),
          ('user_day', '${reservationActors[0]}', (statement_timestamp() at time zone 'Asia/Tokyo')::date),
          ('user_day', '${reservationActors[1]}', (statement_timestamp() at time zone 'Asia/Tokyo')::date),
          ('user_day', '${reservationActors[2]}', (statement_timestamp() at time zone 'Asia/Tokyo')::date),
          ('user_day', '${reservationActors[3]}', (statement_timestamp() at time zone 'Asia/Tokyo')::date)
        on conflict do nothing;
      select (public.create_entry('${reservationActors[0]}',gen_random_uuid(),(statement_timestamp() at time zone 'Asia/Tokyo')::date,'同一キー競合用の架空日記','v1')).id;
      select (public.create_entry('${reservationActors[1]}',gen_random_uuid(),(statement_timestamp() at time zone 'Asia/Tokyo')::date,'同時実行A用の架空日記','v1')).id;
      select (public.create_entry('${reservationActors[1]}',gen_random_uuid(),(statement_timestamp() at time zone 'Asia/Tokyo')::date,'同時実行B用の架空日記','v1')).id;
      select (public.create_entry('${reservationActors[2]}',gen_random_uuid(),(statement_timestamp() at time zone 'Asia/Tokyo')::date,'全体枠競合A用の架空日記','v1')).id;
      select (public.create_entry('${reservationActors[3]}',gen_random_uuid(),(statement_timestamp() at time zone 'Asia/Tokyo')::date,'全体枠競合B用の架空日記','v1')).id;
    `),
  )
    .split('\n')
    .filter(Boolean);
  assert.equal(reservationEntries.length, 5);
  const [duplicateEntry, sameActorEntryA, sameActorEntryB, globalEntryA, globalEntryB] =
    reservationEntries;
  const reservationKey = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
  const duplicateReservations = await runBehindLock({
    holderName: 'mn-db-reserve-duplicate-holder',
    lockSql: "select 1 from private.quota_counters where scope = 'global_total' for update",
    waiterPrefix: 'mn-db-reserve-duplicate-',
    queries: Array.from(
      { length: 6 },
      () =>
        `set role service_role; select public.reserve_generation('${reservationActors[0]}','${duplicateEntry}',1,'${reservationKey}',true);`,
    ),
  });
  const duplicateReceipts = duplicateReservations.map((result) =>
    JSON.parse(succeeded(result)),
  );
  assert.equal(new Set(duplicateReceipts.map((receipt) => receipt.generationId)).size, 1);
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
    await sql('update private.generation_policy set global_daily_limit = 3, global_total_limit = 3;'),
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
