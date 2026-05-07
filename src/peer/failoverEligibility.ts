import type { FailoverDecision } from '../types/failover';

export function classifyFailover(error: unknown): FailoverDecision {
  if (isKnownNonRetryable(error)) {
    return {
      eligible: false,
      category: 'non-retryable',
      reason: error instanceof Error ? error.message : String(error),
    };
  }

  const grpcCode = getGrpcCode(error);
  if (grpcCode === 4) {
    return { eligible: true, category: 'timeout', reason: 'gRPC deadline exceeded' };
  }
  if (grpcCode === 14) {
    return { eligible: true, category: 'peer-unavailable', reason: 'gRPC unavailable' };
  }

  const message = error instanceof Error ? error.message : String(error);
  const lower = message.toLowerCase();

  if (lower.includes('deadline exceeded') || lower.includes('timeout') || lower.includes('timed out')) {
    return { eligible: true, category: 'timeout', reason: message };
  }
  if (
    lower.includes('unavailable') ||
    lower.includes('econnrefused') ||
    lower.includes('econnreset') ||
    lower.includes('enotfound') ||
    lower.includes('no route to host')
  ) {
    return { eligible: true, category: 'peer-unavailable', reason: message };
  }
  if (
    lower.includes('transport') ||
    lower.includes('socket closed') ||
    lower.includes('connection reset') ||
    lower.includes('tls') ||
    lower.includes('http2')
  ) {
    return { eligible: true, category: 'transport', reason: message };
  }

  return {
    eligible: false,
    category: 'unknown',
    reason: message || 'unclassified error',
  };
}

function getGrpcCode(error: unknown): number | undefined {
  if (!error || typeof error !== 'object') {
    return undefined;
  }

  const code = (error as { code?: unknown }).code;
  return typeof code === 'number' ? code : undefined;
}

function isKnownNonRetryable(error: unknown): boolean {
  if (error instanceof Error) {
    return error.name === 'EndorsementError' ||
      error.name === 'SubmitError' ||
      error.name === 'CommitError' ||
      error.name === 'EvaluationError' ||
      error.name === 'PeerNotFoundError' ||
      error.name === 'DiscoveryError' ||
      error.name === 'SinglePeerExecutionError';
  }

  return false;
}
