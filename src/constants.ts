export const PACKAGE_NAME = 'bailinghub-workbuddy-connector';
export const PACKAGE_VERSION = '0.1.0';
export const STORAGE_NAMESPACE = 'bailinghub-workbuddy';
export const MCP_SERVER_NAME = 'bailinghub-workbuddy';

export const STATIC_TOOL_NAMES = [
  'start_business_turn',
  'search_business_capabilities',
  'invoke_business_capability',
  'resume_governed_tool_invocation',
  'complete_business_run',
] as const;

const RECOVERABLE_INVOCATION_STATES = new Set([
  'dispatching',
  'accepted_unknown',
  'awaiting_approval',
  'reconciliation_required',
  'in_progress',
]);

export function shouldRetainInvocation(result: {
  state: string;
  auto_retry_allowed?: boolean;
}): boolean {
  return RECOVERABLE_INVOCATION_STATES.has(result.state) ||
    (result.state === 'rejected_before_dispatch' && result.auto_retry_allowed === true);
}
