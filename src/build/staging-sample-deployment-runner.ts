import { STAGING_SAMPLE_PROFILE } from './sample-deployment.ts';
import {
  prepareSampleReleaseArtifact,
  runWranglerSampleDeploy,
  type WranglerExecutor,
  type WranglerExecutionOptions,
  type WranglerSampleDeploymentDependencies,
} from './sample-deployment-runner.ts';

export type { WranglerExecutor, WranglerExecutionOptions };
export type WranglerStagingSampleDependencies = WranglerSampleDeploymentDependencies;
export { SampleDeploymentFailure as StagingSampleDeploymentFailure } from './sample-deployment.ts';

export function prepareStagingReleaseArtifact(
  commit: string,
  projectRoot?: string,
): Promise<{ configPath: string }> {
  return prepareSampleReleaseArtifact(STAGING_SAMPLE_PROFILE, commit, projectRoot);
}

export function runWranglerStagingSampleDeploy(
  configPath: string,
  dependencies: WranglerStagingSampleDependencies = {},
): Promise<void> {
  return runWranglerSampleDeploy(STAGING_SAMPLE_PROFILE, configPath, dependencies);
}
