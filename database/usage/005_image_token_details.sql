-- Preserve the image-input subset reported by OpenAI image models so the
-- dashboard can apply modality-specific rates without storing prompts or image
-- payloads. Parent-table columns propagate to existing/future partitions.
ALTER TABLE opencodex_usage.requests
  ADD COLUMN IF NOT EXISTS image_input_tokens bigint;

ALTER TABLE opencodex_usage.attempts
  ADD COLUMN IF NOT EXISTS image_input_tokens bigint;

COMMENT ON COLUMN opencodex_usage.requests.image_input_tokens IS
  'Image-token subset of input_tokens for modality-specific pricing.';

COMMENT ON COLUMN opencodex_usage.attempts.image_input_tokens IS
  'Image-token subset of input_tokens for modality-specific pricing.';
