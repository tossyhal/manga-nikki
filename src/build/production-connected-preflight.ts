import {
  checkProductionSamplePreflight,
  ProductionSamplePreflightFailure,
  type ProductionSamplePreflightDependencies,
  type ProductionSamplePreflightResult,
} from './production-sample-preflight.ts';
import type { ProductionSamplePreflightContext } from './production-sample-preflight.ts';

export type ProductionConnectedPreflightContext = Omit<
  ProductionSamplePreflightContext,
  'productionSampleCdEnabled' | 'bwsCloudflareSecretId'
> & {
  productionConnectedCdEnabled?: string;
  bwsCloudflareSecretId?: string;
  bwsSupabasePublishableKeySecretId?: string;
  bwsSupabaseSecretKeySecretId?: string;
  bwsTurnstileSiteKeySecretId?: string;
  bwsTurnstileSecretKeySecretId?: string;
};

export { ProductionSamplePreflightFailure as ProductionConnectedPreflightFailure };

const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function checkProductionConnectedPreflight(
  context: ProductionConnectedPreflightContext,
  dependencies: ProductionSamplePreflightDependencies = {},
): Promise<ProductionSamplePreflightResult> {
  const enabled = context.productionConnectedCdEnabled === 'true';
  if (enabled) {
    const secretIds = [
      context.bwsCloudflareSecretId,
      context.bwsSupabasePublishableKeySecretId,
      context.bwsSupabaseSecretKeySecretId,
      context.bwsTurnstileSiteKeySecretId,
      context.bwsTurnstileSecretKeySecretId,
    ];
    if (secretIds.some((secretId) => !secretId || !uuidPattern.test(secretId))) {
      throw new ProductionSamplePreflightFailure('INPUT_SECRET_ID_INVALID');
    }
  }

  return checkProductionSamplePreflight(
    {
      ...context,
      productionSampleCdEnabled: enabled ? 'true' : context.productionConnectedCdEnabled,
      bwsCloudflareSecretId: enabled ? context.bwsCloudflareSecretId : undefined,
    },
    dependencies,
  );
}
