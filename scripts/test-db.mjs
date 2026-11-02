import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const temporary = await mkdtemp(join(tmpdir(), 'manga-nikki-db-'));
let running = false;
let bin;
let databaseEnv;

function run(command, args, input = '', env = process.env) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { env, stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8').on('data', (chunk) => (stdout += chunk));
    child.stderr.setEncoding('utf8').on('data', (chunk) => (stderr += chunk));
    child.on('error', reject);
    child.on('close', (code) => resolve({ code, stdout, stderr }));
    child.stdin.on('error', (error) => {
      if (error.code !== 'EPIPE') reject(error);
    });
    child.stdin.end(input);
  });
}

function succeeded(result) {
  assert.equal(result.code, 0, result.stderr);
  return result.stdout.trim();
}

const binary = (name) => join(bin, `${name}${process.platform === 'win32' ? '.exe' : ''}`);
const sql = (source) =>
  run(binary('psql'), ['-X', '-qAt', '-v', 'ON_ERROR_STOP=1', '-f', '-'], source, databaseEnv);
const create = (actor, key, body = '同時要求の架空日記') =>
  `select (public.create_entry('${actor}', '${key}', current_date, '${body}', 'v1')).id;`;

try {
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
  databaseEnv = {
    ...Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('PG'))),
    PATH: `${bin}${delimiter}${process.env.PATH ?? ''}`,
    PGHOST: '127.0.0.1',
    PGPORT: String(port),
    PGDATABASE: 'postgres',
    PGUSER: 'test_admin',
    PGPASSWORD: '',
    PGOPTIONS: '',
    PGCLIENTENCODING: 'UTF8',
    PGTZ: 'UTC',
    PGSSLMODE: 'disable',
    PGCONNECT_TIMEOUT: '5',
  };
  succeeded(
    await run(binary('initdb'), [
      '-D',
      join(temporary, 'data'),
      '--username=test_admin',
      '--auth=trust',
      '--encoding=UTF8',
      '--no-locale',
      '--no-instructions',
    ]),
  );
  succeeded(
    await run(binary('pg_ctl'), [
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
    ]),
  );
  running = true;
  succeeded(await sql(await readFile(join(root, 'supabase/tests/bootstrap.sql'), 'utf8')));
  for (const file of (await readdir(join(root, 'supabase/migrations')))
    .filter((name) => name.endsWith('.sql'))
    .sort()) {
    succeeded(await sql(await readFile(join(root, 'supabase/migrations', file), 'utf8')));
  }
  succeeded(await sql(await readFile(join(root, 'supabase/tests/diary.sql'), 'utf8')));
  console.log('成功: RLS・RPC権限・入力・冪等性・編集競合・削除・期限・下書き上限');

  const actor = '33333333-3333-4333-8333-333333333333';
  succeeded(await sql(`insert into auth.users(id) values ('${actor}');`));
  const key = '44444444-4444-4444-8444-444444444444';
  const duplicate = await Promise.all(
    Array.from({ length: 6 }, () =>
      sql(
        `begin; set local role service_role; ${create(actor, key)} select pg_sleep(0.05); commit;`,
      ),
    ),
  );
  const ids = duplicate.map((result) => succeeded(result));
  assert.equal(new Set(ids).size, 1);
  assert.equal(
    succeeded(await sql(`select count(*) from public.entries where owner_id = '${actor}';`)),
    '1',
  );
  const conflict = await Promise.all(
    ['競合A', '競合B'].map((body) =>
      sql(`set role service_role; ${create(actor, '55555555-5555-4555-8555-555555555555', body)}`),
    ),
  );
  assert.equal(conflict.filter((result) => result.code === 0).length, 1);
  assert.equal(
    conflict.filter((result) => result.code !== 0 && result.stderr.includes('IDEMPOTENCY_CONFLICT'))
      .length,
    1,
  );

  const entryId = ids[0].trim();
  const edits = await Promise.all(
    ['編集A', '編集B'].map((body) =>
      sql(
        `set role service_role; select (public.update_entry('${actor}','${entryId}',1,current_date,'${body}')).revision;`,
      ),
    ),
  );
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
  console.log('成功: 同一キーの同時作成・異なる内容の競合・同一revisionの同時編集');

  const limitedActor = '66666666-6666-4666-8666-666666666666';
  succeeded(
    await sql(`insert into auth.users(id) values ('${limitedActor}'); set role service_role;
    do $$ begin for i in 1..19 loop perform public.create_entry('${limitedActor}',gen_random_uuid(),current_date,'枠確認の架空日記','v1'); end loop; end $$;`),
  );
  const finalSlot = await Promise.all(
    Array.from({ length: 6 }, () =>
      sql(`begin; set local role service_role;
      select (public.create_entry('${limitedActor}',gen_random_uuid(),current_date,'最後の枠','v1')).id;
      select pg_sleep(0.05); commit;`),
    ),
  );
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
  console.log('成功: 最後の下書き1枠への6並列要求で上限20件を維持');
} catch (error) {
  console.error('DB検証失敗。PostgreSQLのサーバーバイナリと起動権限を確認してください。');
  console.error(error.message);
  process.exitCode = 1;
} finally {
  // 起動失敗時にもpg_ctlで停止を試み、一時クラスタだけを片付ける。
  if (bin) {
    const stopped = await run(binary('pg_ctl'), [
      '-D',
      join(temporary, 'data'),
      '-m',
      'immediate',
      '-w',
      'stop',
    ]);
    if (running && stopped.code !== 0) {
      console.error('一時DBの停止に失敗しました。作業ディレクトリ:', temporary);
      process.exitCode = 1;
    } else {
      await rm(temporary, { recursive: true, force: true });
    }
  } else {
    await rm(temporary, { recursive: true, force: true });
  }
}
