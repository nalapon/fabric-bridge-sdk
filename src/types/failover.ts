export type FailoverCategory =
  | 'timeout'
  | 'peer-unavailable'
  | 'transport'
  | 'non-retryable'
  | 'unknown';

export interface FailoverDecision {
  eligible: boolean;
  category: FailoverCategory;
  reason: string;
}
