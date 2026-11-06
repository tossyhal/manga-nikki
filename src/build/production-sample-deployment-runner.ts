import { PRODUCTION_SAMPLE_PROFILE } from './sample-deployment.ts';
import {
  prepareSampleReleaseArtifact,
  runWranglerSampleDeploy,
  type WranglerExecutor,
  type WranglerExecutionOptions,
  type WranglerSampleDeploymentDependencies,
} from './sample-deployment-runner.ts';

export type { WranglerExecutor, WranglerExecutionOptions };
export type WranglerProductionSampleDependencies = WranglerSampleDeploymentDependencies;
export { SampleDeploymentFailure as ProductionSampleDeploymentFailure } from './sample-deployment.ts';

export function prepareProductionReleaseArtifact(
  commit: string,
  projectRoot?: string,
): Promise<{ configPath: string }> {
  return prepareSampleReleaseArtifact(PRODUCTION_SAMPLE_PROFILE, commit, projectRoot);
}

export function runWranglerProductionSampleDeploy(
  configPath: string,
  dependencies: WranglerProductionSampleDependencies = {},
): Promise<void> {
  return runWranglerSampleDeploy(PRODUCTION_SAMPLE_PROFILE, configPath, dependencies);
}
