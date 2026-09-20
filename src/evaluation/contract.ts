import { z } from "zod/v4";

const id = z.string().min(1).max(128).refine(value => !["constructor", "prototype", "__proto__"].includes(value));
const content = z.union([z.string().min(1), z.record(z.string(), z.json()), z.array(z.json())]);
export const evaluationRequestSchema = z.object({
  model: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._/-]{0,255}$/),
  state: content,
  questions: z.record(id, z.discriminatedUnion("type", [
    z.object({ type: z.literal("noul"), instructions: content,
      criteria: z.object({ true: content, false: content }).strict().optional() }).strict(),
    z.object({ type: z.literal("choice"), instructions: content,
      criteria: z.record(id, content.nullable()).refine(options => Object.keys(options).length >= 2 && Object.keys(options).length <= 255) }).strict(),
    z.object({ type: z.literal("score"), instructions: content, criteria: z.array(content).min(2).max(10) }).strict(),
  ])).refine(questions => Object.keys(questions).length >= 1 && Object.keys(questions).length <= 100),
}).strict();

export type EvaluationRequest = z.infer<typeof evaluationRequestSchema>;
const probability = z.number().finite().min(0).max(1);
const answer = z.discriminatedUnion("type", [
  z.object({ type: z.literal("noul"), noul: probability }),
  z.object({ type: z.literal("choice"), choice: z.string(), probabilities: z.record(z.string(), probability), confidence: probability.optional() }),
  z.object({ type: z.literal("score"), score: z.number().finite(), probabilities: z.record(z.string(), probability),
    confidence: probability.optional(), legend: z.record(z.string(), content).optional() }),
]);
const responseSchema = z.object({
  model: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/),
  answers: z.record(z.string(), answer),
  usage: z.object({ input_tokens: z.number().int().nonnegative(), output_tokens: z.number().int().nonnegative() }),
});

/** Project known fields only; error bodies and arbitrary metadata never cross the gateway. */
export function validateEvaluationResponse(raw: unknown, request: EvaluationRequest, allowedModels: string[]) {
  const result = responseSchema.parse(raw);
  const same = (left: string[], right: string[]) => left.sort().join("\0") === right.sort().join("\0");
  if (!allowedModels.includes(result.model) || !same(Object.keys(result.answers), Object.keys(request.questions))) throw new Error("Invalid evaluation response");
  for (const [key, question] of Object.entries(request.questions)) {
    const value = result.answers[key];
    if (value.type !== question.type) throw new Error("Mismatched answer type");
    if (value.type === "noul") continue;
    const keys = question.type === "choice" ? Object.keys(question.criteria) : question.type === "score" ? question.criteria.map((_, i) => String(i)) : [];
    if (!same(Object.keys(value.probabilities), keys)) throw new Error("Mismatched options");
    const sum = Object.values(value.probabilities).reduce((a, b) => a + b, 0);
    if (Math.abs(sum - 1) > 0.03) throw new Error("Invalid probability distribution");
    if (value.type === "choice" && (!keys.includes(value.choice) || value.probabilities[value.choice] + 0.03 < Math.max(...Object.values(value.probabilities)))) throw new Error("Invalid choice");
    if (value.type === "score" && (value.score < 0 || value.score > keys.length - 1 || (value.legend && !same(Object.keys(value.legend), keys)))) throw new Error("Invalid score");
  }
  return result;
}
