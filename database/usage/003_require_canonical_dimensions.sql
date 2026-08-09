ALTER TABLE opencodex_usage.requests
  ALTER COLUMN canonical_provider_id SET NOT NULL,
  ALTER COLUMN usage_model_id SET NOT NULL;

ALTER TABLE opencodex_usage.attempts
  ALTER COLUMN canonical_provider_id SET NOT NULL,
  ALTER COLUMN usage_model_id SET NOT NULL;

DO $$
DECLARE
  partition_name regclass;
  suffix text;
BEGIN
  FOR partition_name IN
    SELECT inhrelid::regclass
    FROM pg_inherits
    WHERE inhparent = 'opencodex_usage.requests'::regclass
  LOOP
    suffix := substring(partition_name::text FROM 'requests_([0-9]{6})$');
    IF suffix IS NULL THEN CONTINUE; END IF;
    EXECUTE format(
      'CREATE INDEX IF NOT EXISTS %I ON %s (canonical_provider_id, usage_model_id, occurred_at DESC)',
      'requests_' || suffix || '_canonical_model_time_idx',
      partition_name
    );
  END LOOP;
END;
$$;
