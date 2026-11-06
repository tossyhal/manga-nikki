import {
  SAMPLE_DEPLOYMENT_ACCOUNT_ID,
  SAMPLE_DEPLOYMENT_CLOUDFLARE_API,
  SAMPLE_DEPLOYMENT_GITHUB_API,
  SAMPLE_DEPLOYMENT_REPOSITORY,
  STAGING_SAMPLE_PROFILE,
  SampleDeploymentFailure,
  type SampleDeploymentContext,
  type SampleDeploymentDependencies,
  type SampleDeploymentDisplayErrorCode,
  type SampleDeploymentErrorCode,
  type SampleDeploymentProgress,
  type SampleDeploymentResult,
  runSampleDeployment,
  renderSampleDeploymentSummary,
} from './sample-deployment.ts';

export const STAGING_SAMPLE_REPOSITORY = SAMPLE_DEPLOYMENT_REPOSITORY;
export const STAGING_SAMPLE_REF = STAGING_SAMPLE_PROFILE.ref;
export const STAGING_SAMPLE_WORKER_NAME = STAGING_SAMPLE_PROFILE.workerName;
export const STAGING_SAMPLE_ACCOUNT_ID = SAMPLE_DEPLOYMENT_ACCOUNT_ID;
export const STAGING_SAMPLE_WORKER_URL = STAGING_SAMPLE_PROFILE.workerUrl;
export const STAGING_SAMPLE_CLOUDFLARE_API = SAMPLE_DEPLOYMENT_CLOUDFLARE_API;
export const STAGING_SAMPLE_GITHUB_API = SAMPLE_DEPLOYMENT_GITHUB_API;

export type StagingSampleDeploymentErrorCode = SampleDeploymentErrorCode;
export type StagingSampleDeploymentDisplayErrorCode = SampleDeploymentDisplayErrorCode;
export type StagingSampleDeploymentContext = Omit<
  SampleDeploymentContext,
  'githubActorId' | 'githubTriggeringActor'
>;
export type StagingSampleDeploymentProgress = SampleDeploymentProgress<'staging'>;
export type StagingSampleDeploymentResult = SampleDeploymentResult<'staging'>;
export type StagingSampleDeploymentDependencies = SampleDeploymentDependencies<'staging'>;
export { SampleDeploymentFailure as StagingSampleDeploymentFailure };

export function runStagingSampleDeployment(
  context: StagingSampleDeploymentContext,
  dependencies: StagingSampleDeploymentDependencies = {},
): Promise<StagingSampleDeploymentResult> {
  return runSampleDeployment(STAGING_SAMPLE_PROFILE, context, dependencies);
}

export function renderStagingSampleDeploymentSummary(
  progress: StagingSampleDeploymentProgress,
  errorCode: StagingSampleDeploymentDisplayErrorCode | undefined,
): string {
  return renderSampleDeploymentSummary(STAGING_SAMPLE_PROFILE, progress, errorCode);
}
