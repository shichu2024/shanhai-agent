export type ModelAttemptSubClass =
  | 'provider_error'
  | 'provider_infra'
  | 'call_timeout'
  | 'unparseable_output'
  | 'schema_violation'
  | 'enum_violation'
  | 'format_violation'
  | 'truncation'
  | 'provider_rejected_schema'
  | 'internal_error';

export interface ModelAttemptFailure {
  subClass: ModelAttemptSubClass;
}

export type CallOutcome<T> = { ok: true; value: T; eventId: string };
