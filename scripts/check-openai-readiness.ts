import { appendFile } from 'node:fs/promises';
import {
  checkOpenaiModels,
  checkOpenaiReadinessGate,
  OpenaiReadinessFailure,
} from '../src/build/openai-readiness.ts';
import { ProductionSamplePreflightFailure } from '../src/build/production-sample-preflight.ts';
import { PRODUCTION_SAMPLE_PROFILE } from '../src/build/sample-deployment.ts';

try {
  const mode = process.argv[2];
  if (mode !== 'gate' && mode !== 'models') throw new Error();
  await checkOpenaiReadinessGate({
    githubActions: process.env.GITHUB_ACTIONS,
    githubRepository: process.env.GITHUB_REPOSITORY,
    githubRef: process.env.GITHUB_REF,
    githubEventName: process.env.GITHUB_EVENT_NAME,
    githubSha: process.env.GITHUB_SHA,
    githubActorId: process.env.GITHUB_ACTOR_ID,
    githubTriggeringActor: process.env.GITHUB_TRIGGERING_ACTOR,
    githubToken: process.env.GITHUB_TOKEN,
    workerUrl: PRODUCTION_SAMPLE_PROFILE.workerUrl,
    bwsCloudflareSecretId: process.env.BWS_OPENAI_API_KEY_SECRET_ID,
  });
  if (mode === 'models') {
    const results = await checkOpenaiModels(process.env.OPENAI_API_KEY);
    const lines = results.map(({ model, code, status }) => `${model} ${code} ${status ?? 'NONE'}`);
    for (const line of lines) console.log(line);
    if (process.env.GITHUB_STEP_SUMMARY) {
      await appendFile(
        process.env.GITHUB_STEP_SUMMARY,
        [
          ...lines,
          '',
          'MODEL_VISIBILITY_ONLY',
          'モデル参照の成功は、生成権限・組織認証・API残高・実生成成功の確認ではありません。',
          '生成APIは呼び出していません。一般公開生成の承認や有効化は行いません。',
          'https://developers.openai.com/api/reference/resources/models/methods/retrieve',
          '',
        ].join('\n'),
        { encoding: 'utf8', mode: 0o600 },
      );
    }
    if (results.some(({ code }) => code !== 'MODEL_VISIBLE')) process.exitCode = 1;
  } else {
    console.log('OPENAI_READINESS_GATE_READY');
  }
} catch (error) {
  const code =
    error instanceof OpenaiReadinessFailure || error instanceof ProductionSamplePreflightFailure
      ? error.code
      : 'INTERNAL_ERROR';
  console.error(`openai-readiness: ${code}`);
  process.exitCode = 1;
}
