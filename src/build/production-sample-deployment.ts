import {
  PRODUCTION_SAMPLE_PROFILE,
  SAMPLE_DEPLOYMENT_ACCOUNT_ID,
  SAMPLE_DEPLOYMENT_CLOUDFLARE_API,
  SAMPLE_DEPLOYMENT_GITHUB_API,
  SAMPLE_DEPLOYMENT_REPOSITORY,
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

export const PRODUCTION_SAMPLE_REPOSITORY = SAMPLE_DEPLOYMENT_REPOSITORY;
export const PRODUCTION_SAMPLE_REF = PRODUCTION_SAMPLE_PROFILE.ref;
export const PRODUCTION_SAMPLE_WORKER_NAME = PRODUCTION_SAMPLE_PROFILE.workerName;
export const PRODUCTION_SAMPLE_ACCOUNT_ID = SAMPLE_DEPLOYMENT_ACCOUNT_ID;
export const PRODUCTION_SAMPLE_WORKER_URL = PRODUCTION_SAMPLE_PROFILE.workerUrl;
export const PRODUCTION_SAMPLE_CLOUDFLARE_API = SAMPLE_DEPLOYMENT_CLOUDFLARE_API;
export const PRODUCTION_SAMPLE_GITHUB_API = SAMPLE_DEPLOYMENT_GITHUB_API;

export type ProductionSampleDeploymentErrorCode = SampleDeploymentErrorCode;
export type ProductionSampleDeploymentDisplayErrorCode = SampleDeploymentDisplayErrorCode;
export type ProductionSampleDeploymentContext = SampleDeploymentContext;
export type ProductionSampleDeploymentProgress = SampleDeploymentProgress<'production'>;
export type ProductionSampleDeploymentResult = SampleDeploymentResult<'production'>;
export type ProductionSampleDeploymentDependencies = SampleDeploymentDependencies<'production'>;
export { SampleDeploymentFailure as ProductionSampleDeploymentFailure };

export function runProductionSampleDeployment(
  context: ProductionSampleDeploymentContext,
  dependencies: ProductionSampleDeploymentDependencies = {},
): Promise<ProductionSampleDeploymentResult> {
  return runSampleDeployment(PRODUCTION_SAMPLE_PROFILE, context, dependencies);
}

export function renderProductionSampleDeploymentSummary(
  progress: ProductionSampleDeploymentProgress,
  errorCode: ProductionSampleDeploymentDisplayErrorCode | undefined,
): string {
  return renderSampleDeploymentSummary(PRODUCTION_SAMPLE_PROFILE, progress, errorCode);
}
