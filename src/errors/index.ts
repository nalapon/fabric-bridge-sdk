import { TaggedError } from 'better-result';

export class EndorsementError extends TaggedError('EndorsementError')<{
  message: string;
  details?: Array<{ message: string; endpoint: string }>;
}>() {}

export class DiscoveryError extends TaggedError('DiscoveryError')<{
  message: string;
  cause?: Error;
}>() {}

export class PeerNotFoundError extends TaggedError('PeerNotFoundError')<{
  peerName: string;
  availablePeers: string[];
}>() {}

export class SubmitError extends TaggedError('SubmitError')<{
  message: string;
  transactionId?: string;
}>() {}

export class CommitError extends TaggedError('CommitError')<{
  message: string;
  transactionId: string;
  status?: string;
}>() {}

export class EvaluationError extends TaggedError('EvaluationError')<{
  message: string;
  details?: string;
}>() {}

export class ConfigurationError extends TaggedError('ConfigurationError')<{
  message: string;
  field?: string;
}>() {}

export class TimeoutError extends TaggedError('TimeoutError')<{
  message: string;
  operation: string;
  timeout: number;
}>() {}

export class NotConnectedError extends TaggedError('NotConnectedError')<{
  component: string;
  action: string;
}>() {}
