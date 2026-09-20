import { z } from "zod/v4";

const identifier = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/)
  .refine(value => !["constructor", "prototype", "__proto__"].includes(value));
export const evaluationConfigSchema = z.object({
  providers: z.record(identifier, z.object({
    protocol: z.literal("typesafe"),
    endpoint: z.url().refine(value => {
      const url = new URL(value);
      return !url.username && !url.password && !url.search && !url.hash &&
        (url.protocol === "https:" || (url.protocol === "http:" && ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname)));
    }),
    apiKeyEnv: z.string().regex(/^[A-Z][A-Z0-9_]*$/),
    models: z.array(identifier).min(1).max(100).refine(values => new Set(values).size === values.length),
    disabled: z.boolean().optional(),
  }).strict()).refine(providers => Object.keys(providers).length <= 32),
  timeoutMs: z.number().int().min(100).max(60_000).optional(),
  maxConcurrent: z.number().int().min(1).max(64).optional(),
}).strict();

export type EvaluationConfig = z.infer<typeof evaluationConfigSchema>;

/** Reject live writes, but a malformed hand edit must not reset unrelated gateway credentials. */
export function evaluationConfigError(value: unknown): string | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const evaluations = (value as Record<string, unknown>).evaluations;
  return evaluations === undefined || evaluationConfigSchema.safeParse(evaluations).success
    ? null : "schema_invalid: evaluations: invalid typed evaluation configuration";
}
