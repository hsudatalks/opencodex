CREATE TABLE IF NOT EXISTS opencodex_usage.dashboard_request_hourly (
  hour timestamptz NOT NULL,
  surface_code smallint NOT NULL,
  oldest_occurred_at timestamptz NOT NULL,
  request_count bigint NOT NULL,
  attempt_count bigint NOT NULL,
  measured_request_count bigint NOT NULL,
  reported_request_count bigint NOT NULL,
  unreported_request_count bigint NOT NULL,
  unsupported_request_count bigint NOT NULL,
  estimated_request_count bigint NOT NULL,
  input_tokens bigint NOT NULL,
  output_tokens bigint NOT NULL,
  cache_read_input_tokens bigint NOT NULL,
  cache_creation_input_tokens bigint NOT NULL,
  reasoning_output_tokens bigint NOT NULL,
  total_tokens bigint NOT NULL,
  estimated_cost_usd double precision NOT NULL,
  priced_request_count bigint NOT NULL,
  unpriced_request_count bigint NOT NULL,
  unmetered_request_count bigint NOT NULL,
  PRIMARY KEY (hour, surface_code)
);

CREATE TABLE IF NOT EXISTS opencodex_usage.dashboard_model_hourly (
  hour timestamptz NOT NULL,
  surface_code smallint NOT NULL,
  provider_id bigint NOT NULL REFERENCES opencodex_usage.dimensions(id),
  model_id bigint NOT NULL REFERENCES opencodex_usage.dimensions(id),
  request_count bigint NOT NULL,
  attempt_count bigint NOT NULL,
  measured_request_count bigint NOT NULL,
  reported_request_count bigint NOT NULL,
  estimated_request_count bigint NOT NULL,
  input_tokens bigint NOT NULL,
  output_tokens bigint NOT NULL,
  total_tokens bigint NOT NULL,
  estimated_cost_usd double precision NOT NULL,
  priced_attribution_count bigint NOT NULL,
  PRIMARY KEY (hour, surface_code, provider_id, model_id)
);

CREATE TABLE IF NOT EXISTS opencodex_usage.dashboard_provider_hourly (
  hour timestamptz NOT NULL,
  surface_code smallint NOT NULL,
  provider_id bigint NOT NULL REFERENCES opencodex_usage.dimensions(id),
  request_count bigint NOT NULL,
  attempt_count bigint NOT NULL,
  measured_request_count bigint NOT NULL,
  reported_request_count bigint NOT NULL,
  estimated_request_count bigint NOT NULL,
  total_tokens bigint NOT NULL,
  estimated_cost_usd double precision NOT NULL,
  priced_attribution_count bigint NOT NULL,
  PRIMARY KEY (hour, surface_code, provider_id)
);

CREATE TABLE IF NOT EXISTS opencodex_usage.dashboard_read_model_state (
  singleton boolean PRIMARY KEY DEFAULT true CHECK (singleton),
  ready boolean NOT NULL DEFAULT false,
  rebuilt_at timestamptz
);

INSERT INTO opencodex_usage.dashboard_read_model_state (singleton, ready)
VALUES (true, false)
ON CONFLICT (singleton) DO NOTHING;

COMMENT ON TABLE opencodex_usage.dashboard_request_hourly IS
  'Exact request-level hourly read model for the Usage dashboard; raw request facts remain authoritative.';
COMMENT ON TABLE opencodex_usage.dashboard_model_hourly IS
  'Exact per-request model attribution read model, including retries folded by the application usage contract.';
COMMENT ON TABLE opencodex_usage.dashboard_provider_hourly IS
  'Exact per-request provider attribution read model; separate from model rows to preserve request de-duplication.';

REVOKE ALL ON opencodex_usage.dashboard_request_hourly FROM PUBLIC;
REVOKE ALL ON opencodex_usage.dashboard_model_hourly FROM PUBLIC;
REVOKE ALL ON opencodex_usage.dashboard_provider_hourly FROM PUBLIC;
REVOKE ALL ON opencodex_usage.dashboard_read_model_state FROM PUBLIC;

-- Projection maintenance follows the existing request-ingestion trust boundary. The
-- role may rebuild derived rows, but receives no DELETE/TRUNCATE privilege on facts.
DO $$
DECLARE
  ingest_role text;
BEGIN
  FOR ingest_role IN
    SELECT DISTINCT grantee
    FROM information_schema.role_table_grants
    WHERE table_schema = 'opencodex_usage'
      AND table_name = 'requests'
      AND privilege_type = 'INSERT'
  LOOP
    EXECUTE format(
      'GRANT SELECT, INSERT, UPDATE, TRUNCATE ON '
      'opencodex_usage.dashboard_request_hourly, '
      'opencodex_usage.dashboard_model_hourly, '
      'opencodex_usage.dashboard_provider_hourly TO %I',
      ingest_role
    );
    EXECUTE format(
      'GRANT SELECT, INSERT, UPDATE ON opencodex_usage.dashboard_read_model_state TO %I',
      ingest_role
    );
  END LOOP;
END;
$$;
