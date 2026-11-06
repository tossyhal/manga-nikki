const openAIQuotaErrorCodes: ReadonlySet<string> = new Set([
  'insufficient_quota',
  'credit_balance_exhausted',
  'billing_hard_limit_reached',
  'organization_usage_limit_exceeded',
  'organization_spend_limit_exceeded',
  'project_spend_limit_exceeded',
  'project_usage_limit_exceeded',
]);

export function isOpenAIQuotaErrorCode(value: unknown): boolean {
  return typeof value === 'string' && openAIQuotaErrorCodes.has(value);
}
