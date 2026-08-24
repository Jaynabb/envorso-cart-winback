import Anthropic from "@anthropic-ai/sdk";
import { zodToJsonSchema } from "zod-to-json-schema";
import type { z } from "zod";

/**
 * One way to run an agent, used by all three.
 *
 * Every stage in this system has the same shape — give a model a role, hand it
 * the previous stage's typed output, force it to fill in a schema — so the
 * mechanics live here once and the three agent files stay about their own
 * judgement rather than about the SDK.
 *
 * Three layers of defence, because each catches what the others can't:
 *
 *   1. Forced tool use — the API constrains the SHAPE. No prose, no missing
 *      fields, no enum value we didn't define.
 *   2. zod validation — the shape being right doesn't make the contents right.
 *      A 900-character "one line" reason is valid JSON and still wrong.
 *   3. One corrective retry — the validation error goes back to the model.
 *      One, not a loop: past that we surface an honest failure instead of
 *      spending money discovering the same thing repeatedly.
 *
 * A note on what makes a retry work. Feeding back "String must contain at most
 * 400 characters" got the same overrun twice, because a model cannot count
 * characters — the limit is real but the feedback isn't actionable. The prompts
 * ask for "two or three sentences" instead, which is a budget a writer can
 * actually hold, and the cap became the backstop rather than the instruction.
 */

export const DEFAULT_MODEL = "claude-haiku-4-5-20251001";
export const ESCALATION_MODEL = "claude-sonnet-5";

/**
 * List prices per million tokens, August 2026. Kept here rather than guessed at
 * in a README so the cost line in a run is computed from the same numbers the
 * cost line in the docs quotes.
 */
const PRICING: Record<string, { in: number; out: number }> = {
  "claude-haiku-4-5-20251001": { in: 1, out: 5 },
  "claude-sonnet-5": { in: 3, out: 15 },
};

export interface Usage {
  model: string;
  input_tokens: number;
  output_tokens: number;
  cost_usd: number;
  ms: number;
}

export interface AgentRun<T> {
  ok: true;
  value: T;
  usage: Usage;
  /** Set when the first attempt failed validation and the retry fixed it. */
  repaired_from: string | null;
}

export interface AgentFailure {
  ok: false;
  /** Written for a person, not a log. See explainFailure. */
  note: string;
  usage: Usage | null;
}

export type AgentResult<T> = AgentRun<T> | AgentFailure;

function client(): Anthropic {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    throw new Error(
      "ANTHROPIC_API_KEY is not set. Copy .env.example to .env.local and add your key.",
    );
  }
  return new Anthropic({ apiKey });
}

function priceOf(model: string, input: number, output: number): number {
  const p = PRICING[model] ?? PRICING[DEFAULT_MODEL];
  return (input / 1_000_000) * p.in + (output / 1_000_000) * p.out;
}

/**
 * Why the call failed, said to a person rather than to a log.
 *
 * The only thing anyone reading a failed run needs to know is whether the cart
 * is the problem or we are, and whether trying again helps.
 */
function explainFailure(status: number, message: string): string {
  if (status === 401 || status === 403)
    return "The API key was rejected, so this cart never reached the model. Nothing is wrong with the cart — fix the key and re-run.";
  if (status === 429)
    return "Rate limited by the API, twice. Nothing is wrong with the cart — re-run in a moment.";
  if (status === 529 || status >= 500)
    return `The model was overloaded and didn't answer (${status}), on both attempts. Nothing is wrong with the cart — re-run it.`;
  if (status === 0)
    return "Couldn't reach the API at all — network or DNS. Re-run once you're back online.";
  return `The call failed (${status}) — ${message}`;
}

export interface AgentSpec<S extends z.ZodTypeAny> {
  /** Shown in logs and the UI chain. "analyst", "strategist", "reviewer". */
  name: string;
  /** What the tool is called. The model is forced to call exactly this. */
  toolName: string;
  toolDescription: string;
  system: string;
  user: string;
  schema: S;
  model?: string;
}

export async function runAgent<S extends z.ZodTypeAny>(
  spec: AgentSpec<S>,
): Promise<AgentResult<z.infer<S>>> {
  const model = spec.model ?? process.env.AGENT_MODEL ?? DEFAULT_MODEL;
  const started = Date.now();
  let anthropic: Anthropic;
  try {
    anthropic = client();
  } catch (err) {
    return { ok: false, note: err instanceof Error ? err.message : String(err), usage: null };
  }

  const tool: Anthropic.Tool = {
    name: spec.toolName,
    description: spec.toolDescription,
    input_schema: zodToJsonSchema(spec.schema, {
      target: "openApi3",
      $refStrategy: "none",
    }) as Anthropic.Tool["input_schema"],
  };

  const messages: Anthropic.MessageParam[] = [{ role: "user", content: spec.user }];
  let inputTokens = 0;
  let outputTokens = 0;
  let firstProblem: string | null = null;
  let lastProblem = "unknown";
  /**
   * Newer models reject `temperature` outright — the escalation model 400s with
   * "temperature is deprecated for this model" while the cheap one still wants
   * it. Feature-detected rather than kept as a hardcoded list of model names,
   * because that list is wrong the moment someone changes AGENT_MODEL in .env.
   */
  let sendTemperature = true;

  // Attempt, then one corrective retry. Two total — deliberately not a loop.
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      const response = await anthropic.messages.create({
        model,
        max_tokens: 1024,
        // Deterministic where the model still allows it: these are
        // classification calls against tight schemas, and the same cart on the
        // same day should not produce a different offer.
        ...(sendTemperature ? { temperature: 0 } : {}),
        system: spec.system,
        tools: [tool],
        tool_choice: { type: "tool", name: spec.toolName },
        messages,
      });

      inputTokens += response.usage.input_tokens;
      outputTokens += response.usage.output_tokens;

      const block = response.content.find((c) => c.type === "tool_use");
      if (!block || block.type !== "tool_use") {
        lastProblem = "the model replied without calling the tool";
      } else {
        const parsed = spec.schema.safeParse(block.input);
        if (parsed.success) {
          return {
            ok: true,
            value: parsed.data,
            repaired_from: firstProblem,
            usage: {
              model,
              input_tokens: inputTokens,
              output_tokens: outputTokens,
              cost_usd: priceOf(model, inputTokens, outputTokens),
              ms: Date.now() - started,
            },
          };
        }
        lastProblem = parsed.error.issues
          .map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`)
          .join("; ");

        if (attempt === 1) {
          firstProblem = lastProblem;
          // The correction has to come back as a tool_result after a tool_use
          // turn — plain text is rejected by the API, which would break the
          // retry on exactly the calls that need it.
          messages.push(
            { role: "assistant", content: response.content },
            {
              role: "user",
              content: [
                {
                  type: "tool_result",
                  tool_use_id: block.id,
                  is_error: true,
                  content: `That didn't validate: ${lastProblem}. Call ${spec.toolName} again, corrected.`,
                },
              ],
            },
          );
          continue;
        }
      }
    } catch (err) {
      const status =
        err instanceof Anthropic.APIError ? (err.status ?? 0) : 0;
      lastProblem = err instanceof Error ? err.message : String(err);

      // Not a failure — this model just doesn't take the parameter. Drop it and
      // go again without spending one of the two real attempts.
      if (status === 400 && sendTemperature && /temperature/i.test(lastProblem)) {
        sendTemperature = false;
        attempt--;
        continue;
      }

      const transient = status === 429 || status === 529 || status >= 500 || status === 0;
      if (!transient || attempt === 2) {
        return {
          ok: false,
          note: explainFailure(status, lastProblem),
          usage: {
            model,
            input_tokens: inputTokens,
            output_tokens: outputTokens,
            cost_usd: priceOf(model, inputTokens, outputTokens),
            ms: Date.now() - started,
          },
        };
      }
      await new Promise((r) => setTimeout(r, 400));
    }
  }

  return {
    ok: false,
    note: `The ${spec.name} returned something invalid twice — ${lastProblem}. Flagged rather than guessed at, because what it decides drives real money.`,
    usage: {
      model,
      input_tokens: inputTokens,
      output_tokens: outputTokens,
      cost_usd: priceOf(model, inputTokens, outputTokens),
      ms: Date.now() - started,
    },
  };
}

export function emptyUsage(): Usage {
  return { model: "none", input_tokens: 0, output_tokens: 0, cost_usd: 0, ms: 0 };
}

export function sumUsage(parts: (Usage | null)[]): Usage {
  const real = parts.filter((p): p is Usage => p !== null);
  return {
    model: real.map((r) => r.model).join("+") || "none",
    input_tokens: real.reduce((n, r) => n + r.input_tokens, 0),
    output_tokens: real.reduce((n, r) => n + r.output_tokens, 0),
    cost_usd: real.reduce((n, r) => n + r.cost_usd, 0),
    ms: real.reduce((n, r) => n + r.ms, 0),
  };
}
