CREATE SCHEMA IF NOT EXISTS opencodex_usage;

REVOKE ALL ON SCHEMA opencodex_usage FROM PUBLIC;

CREATE TABLE IF NOT EXISTS opencodex_usage.dimensions (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  kind smallint NOT NULL,
  value text NOT NULL,
  CONSTRAINT dimensions_kind_value_unique UNIQUE (kind, value)
);

CREATE TABLE IF NOT EXISTS opencodex_usage.requests (
  occurred_at timestamptz NOT NULL,
  request_id text NOT NULL,
  provider_id bigint NOT NULL REFERENCES opencodex_usage.dimensions(id),
  model_id bigint NOT NULL REFERENCES opencodex_usage.dimensions(id),
  canonical_provider_id bigint NOT NULL REFERENCES opencodex_usage.dimensions(id),
  usage_model_id bigint NOT NULL REFERENCES opencodex_usage.dimensions(id),
  surface_code smallint NOT NULL,
  api_key_id bigint REFERENCES opencodex_usage.dimensions(id),
  admission_code smallint NOT NULL,
  protocol_code smallint NOT NULL,
  conversation_id text,
  resolved_model_id bigint REFERENCES opencodex_usage.dimensions(id),
  requested_model_id bigint REFERENCES opencodex_usage.dimensions(id),
  requested_effort_id bigint REFERENCES opencodex_usage.dimensions(id),
  effective_effort_id bigint REFERENCES opencodex_usage.dimensions(id),
  reasoning_wire_field_id bigint REFERENCES opencodex_usage.dimensions(id),
  reasoning_wire_value_id bigint REFERENCES opencodex_usage.dimensions(id),
  reasoning_wire_number double precision,
  reasoning_wire_boolean boolean,
  requested_service_tier_id bigint REFERENCES opencodex_usage.dimensions(id),
  requested_speed_label_id bigint REFERENCES opencodex_usage.dimensions(id),
  configured_service_tier_id bigint REFERENCES opencodex_usage.dimensions(id),
  configured_speed_label_id bigint REFERENCES opencodex_usage.dimensions(id),
  model_supports_service_tier boolean,
  response_service_tier_id bigint REFERENCES opencodex_usage.dimensions(id),
  http_status smallint NOT NULL,
  duration_ms bigint NOT NULL,
  first_output_ms bigint,
  usage_status_code smallint NOT NULL,
  input_tokens bigint,
  output_tokens bigint,
  context_total_tokens bigint,
  cached_input_tokens bigint,
  cache_read_input_tokens bigint,
  cache_creation_input_tokens bigint,
  reasoning_output_tokens bigint,
  total_tokens bigint,
  attempt_count smallint NOT NULL,
  error_code_id bigint REFERENCES opencodex_usage.dimensions(id),
  terminal_status_id bigint REFERENCES opencodex_usage.dimensions(id),
  close_reason_code smallint NOT NULL,
  ingested_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (occurred_at, request_id)
) PARTITION BY RANGE (occurred_at);

CREATE TABLE IF NOT EXISTS opencodex_usage.attempts (
  occurred_at timestamptz NOT NULL,
  request_id text NOT NULL,
  ordinal smallint NOT NULL,
  provider_id bigint NOT NULL REFERENCES opencodex_usage.dimensions(id),
  model_id bigint NOT NULL REFERENCES opencodex_usage.dimensions(id),
  canonical_provider_id bigint NOT NULL REFERENCES opencodex_usage.dimensions(id),
  usage_model_id bigint NOT NULL REFERENCES opencodex_usage.dimensions(id),
  adapter_id bigint NOT NULL REFERENCES opencodex_usage.dimensions(id),
  http_status smallint NOT NULL,
  duration_ms bigint NOT NULL,
  first_output_ms bigint,
  send_count integer NOT NULL,
  usage_status_code smallint NOT NULL,
  input_token_estimate bigint,
  input_tokens bigint,
  output_tokens bigint,
  context_total_tokens bigint,
  cached_input_tokens bigint,
  cache_read_input_tokens bigint,
  cache_creation_input_tokens bigint,
  reasoning_output_tokens bigint,
  total_tokens bigint,
  error_code_id bigint REFERENCES opencodex_usage.dimensions(id),
  requested_effort_id bigint REFERENCES opencodex_usage.dimensions(id),
  effective_effort_id bigint REFERENCES opencodex_usage.dimensions(id),
  reasoning_wire_field_id bigint REFERENCES opencodex_usage.dimensions(id),
  reasoning_wire_value_id bigint REFERENCES opencodex_usage.dimensions(id),
  reasoning_wire_number double precision,
  reasoning_wire_boolean boolean,
  PRIMARY KEY (occurred_at, request_id, ordinal),
  FOREIGN KEY (occurred_at, request_id)
    REFERENCES opencodex_usage.requests(occurred_at, request_id)
    ON DELETE CASCADE
) PARTITION BY RANGE (occurred_at);

CREATE TABLE IF NOT EXISTS opencodex_usage.attempt_recoveries (
  occurred_at timestamptz NOT NULL,
  request_id text NOT NULL,
  ordinal smallint NOT NULL,
  recovery_code smallint NOT NULL,
  PRIMARY KEY (occurred_at, request_id, ordinal, recovery_code),
  FOREIGN KEY (occurred_at, request_id, ordinal)
    REFERENCES opencodex_usage.attempts(occurred_at, request_id, ordinal)
    ON DELETE CASCADE
) PARTITION BY RANGE (occurred_at);

CREATE TABLE IF NOT EXISTS opencodex_usage.request_errors (
  occurred_at timestamptz NOT NULL,
  request_id text NOT NULL,
  upstream_error text NOT NULL,
  PRIMARY KEY (occurred_at, request_id),
  FOREIGN KEY (occurred_at, request_id)
    REFERENCES opencodex_usage.requests(occurred_at, request_id)
    ON DELETE CASCADE
) PARTITION BY RANGE (occurred_at);

CREATE TABLE IF NOT EXISTS opencodex_usage.route_decisions (
  occurred_at timestamptz NOT NULL,
  request_id text NOT NULL,
  decision_id text NOT NULL,
  route_kind_code smallint NOT NULL,
  profile_id bigint REFERENCES opencodex_usage.dimensions(id),
  profile_revision_id bigint REFERENCES opencodex_usage.dimensions(id),
  selected_provider_id bigint NOT NULL REFERENCES opencodex_usage.dimensions(id),
  selected_model_id bigint NOT NULL REFERENCES opencodex_usage.dimensions(id),
  selected_account_id bigint REFERENCES opencodex_usage.dimensions(id),
  selected_reason_id bigint REFERENCES opencodex_usage.dimensions(id),
  selected_tie_break_id bigint REFERENCES opencodex_usage.dimensions(id),
  candidate_count smallint NOT NULL,
  trace jsonb NOT NULL,
  PRIMARY KEY (occurred_at, request_id),
  FOREIGN KEY (occurred_at, request_id)
    REFERENCES opencodex_usage.requests(occurred_at, request_id)
    ON DELETE CASCADE
) PARTITION BY RANGE (occurred_at);

CREATE TABLE IF NOT EXISTS opencodex_usage.ingestion_cursors (
  source_id text PRIMARY KEY,
  source_path text NOT NULL,
  source_device bigint NOT NULL,
  source_inode bigint NOT NULL,
  byte_offset bigint NOT NULL CHECK (byte_offset >= 0),
  invalid_lines bigint NOT NULL DEFAULT 0 CHECK (invalid_lines >= 0),
  last_occurred_at timestamptz,
  initialized_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS opencodex_usage.usage_hourly_rollups (
  hour timestamptz NOT NULL,
  surface_code smallint NOT NULL,
  provider_id bigint NOT NULL REFERENCES opencodex_usage.dimensions(id),
  model_id bigint NOT NULL REFERENCES opencodex_usage.dimensions(id),
  account_id bigint NOT NULL,
  request_count bigint NOT NULL,
  success_count bigint NOT NULL,
  error_count bigint NOT NULL,
  duration_ms_sum numeric(24, 0) NOT NULL,
  first_output_ms_sum numeric(24, 0) NOT NULL,
  first_output_count bigint NOT NULL,
  input_tokens bigint NOT NULL,
  output_tokens bigint NOT NULL,
  cached_input_tokens bigint NOT NULL,
  reasoning_output_tokens bigint NOT NULL,
  total_tokens bigint NOT NULL,
  PRIMARY KEY (hour, surface_code, provider_id, model_id, account_id)
);

CREATE OR REPLACE FUNCTION opencodex_usage.ensure_month_partitions(p_occurred_at timestamptz)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, opencodex_usage
AS $$
DECLARE
  month_start timestamptz := date_trunc('month', p_occurred_at AT TIME ZONE 'UTC') AT TIME ZONE 'UTC';
  month_end timestamptz := month_start + interval '1 month';
  suffix text := to_char(month_start, 'YYYYMM');
  table_name text;
  parent_name text;
BEGIN
  FOREACH parent_name IN ARRAY ARRAY['requests', 'attempts', 'attempt_recoveries', 'request_errors', 'route_decisions']
  LOOP
    table_name := parent_name || '_' || suffix;
    EXECUTE format(
      'CREATE TABLE IF NOT EXISTS opencodex_usage.%I PARTITION OF opencodex_usage.%I FOR VALUES FROM (%L) TO (%L)',
      table_name,
      parent_name,
      month_start,
      month_end
    );
  END LOOP;

  EXECUTE format(
    'CREATE INDEX IF NOT EXISTS %I ON opencodex_usage.%I (occurred_at DESC, request_id DESC)',
    'requests_' || suffix || '_time_request_idx',
    'requests_' || suffix
  );
  EXECUTE format(
    'CREATE INDEX IF NOT EXISTS %I ON opencodex_usage.%I (api_key_id, occurred_at DESC)',
    'requests_' || suffix || '_account_time_idx',
    'requests_' || suffix
  );
  EXECUTE format(
    'CREATE INDEX IF NOT EXISTS %I ON opencodex_usage.%I (provider_id, model_id, occurred_at DESC)',
    'requests_' || suffix || '_provider_model_time_idx',
    'requests_' || suffix
  );
  EXECUTE format(
    'CREATE INDEX IF NOT EXISTS %I ON opencodex_usage.%I (canonical_provider_id, usage_model_id, occurred_at DESC)',
    'requests_' || suffix || '_canonical_model_time_idx',
    'requests_' || suffix
  );
  EXECUTE format(
    'CREATE INDEX IF NOT EXISTS %I ON opencodex_usage.%I (conversation_id, occurred_at DESC) WHERE conversation_id IS NOT NULL',
    'requests_' || suffix || '_conversation_time_idx',
    'requests_' || suffix
  );
END;
$$;

COMMENT ON TABLE opencodex_usage.requests IS
  'Normalized request facts. Repeated labels are dimension ids; raw JSONL is never stored here.';
COMMENT ON TABLE opencodex_usage.route_decisions IS
  'Cold, bounded route evidence. trace is the only intentionally retained JSONB payload.';
COMMENT ON TABLE opencodex_usage.ingestion_cursors IS
  'Transactional JSONL WAL offsets. Advancing a cursor and inserting its batch are one commit.';
