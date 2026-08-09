ALTER TABLE opencodex_usage.requests
  ADD COLUMN IF NOT EXISTS canonical_provider_id bigint REFERENCES opencodex_usage.dimensions(id),
  ADD COLUMN IF NOT EXISTS usage_model_id bigint REFERENCES opencodex_usage.dimensions(id);

ALTER TABLE opencodex_usage.attempts
  ADD COLUMN IF NOT EXISTS canonical_provider_id bigint REFERENCES opencodex_usage.dimensions(id),
  ADD COLUMN IF NOT EXISTS usage_model_id bigint REFERENCES opencodex_usage.dimensions(id);

COMMENT ON COLUMN opencodex_usage.requests.canonical_provider_id IS
  'Application-canonical provider dimension used for exact aggregate grouping.';
COMMENT ON COLUMN opencodex_usage.requests.usage_model_id IS
  'Application-canonical usage model dimension, including Antigravity alias collapse.';

