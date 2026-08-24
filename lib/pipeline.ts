import {
  type CartFacts,
  type Decision,
  CartFactsSchema,
} from "./schema.ts";
import { getOffer, describeOffer, totalCost } from "./catalog.ts";
import {
  gate,
  affordable,
  needsEscalation,
  checkInvariants,
  MAX_STRENGTH_BY_RETURN_LIKELIHOOD,
  MIN_STRENGTH_BY_RETURN_LIKELIHOOD,
} from "./policy.ts";
import { readFan } from "./analyst.ts";
import { proposeOffer } from "./strategist.ts";
import { reviewOffer } from "./reviewer.ts";
import { sumUsage, emptyUsage, type Usage } from "./agent.ts";

/**
 * The orchestration.
 *
 *   gate ──▶ analyst ──▶ strategist ──▶ reviewer ──▶ marketer
 *
 * Two properties this file is responsible for, beyond wiring:
 *
 * FAIL CLOSED. If any stage errors or returns something invalid, the cart
 * holds. There is no path through this function where a broken run produces an
 * offer — a system that degrades into sending fans money is worse than one
 * that stops.
 *
 * NEVER TRUST THE STATED COST. What an offer costs is computed from the
 * catalog every time, whatever the strategist claimed. The claim is kept only
 * so the invariant can compare the two and notice a model that has started
 * doing its own arithmetic.
 */

export interface RunResult {
  decisions: Decision[];
  usageByCart: Record<string, Usage>;
  usage: Usage;
  meta: {
    total: number;
    offers: number;
    holds: number;
    blocked: number;
    /** What the club gives up if a marketer approves everything proposed. */
    proposed_cost_usd: number;
    /** How much of that is revenue handed over rather than cash off the top. */
    proposed_given_away_usd: number;
    elapsed_ms: number;
    cost_usd: number;
  };
}

function hold(cart: CartFacts, headline: string, extra: Partial<Decision> = {}): Decision {
  return {
    cart_id: cart.cart_id,
    outcome: "hold",
    headline,
    offer_id: null,
    cost_usd: null,
    read: null,
    proposal: null,
    review: null,
    gate_reason: null,
    violations: [],
    ...extra,
  };
}

export interface RunOptions {
  /** Share of qualified carts held back to measure lift. Off by default. */
  holdoutPercent?: number;
}

async function decideOne(
  cart: CartFacts,
  opts: RunOptions = {},
): Promise<{ decision: Decision; usage: Usage }> {
  // [0] Deterministic gate. Costs nothing, cannot hallucinate, runs first.
  const gated = gate(cart, { holdoutPercent: opts.holdoutPercent });
  if (!gated.pass) {
    return {
      usage: emptyUsage(),
      decision: {
        cart_id: cart.cart_id,
        outcome: gated.outcome,
        headline: gated.reason,
        offer_id: null,
        cost_usd: null,
        read: null,
        proposal: null,
        review: null,
        gate_reason: gated.reason,
        violations: [],
      },
    };
  }

  // [1] Analyst — what kind of fan, and were they coming back anyway?
  const readResult = await readFan(cart);
  if (!readResult.ok) {
    return {
      usage: readResult.usage ?? emptyUsage(),
      decision: hold(cart, `Couldn't read this fan — ${readResult.note}`),
    };
  }
  const read = readResult.value;

  // [2] Strategist — given that read, what (if anything) do we give them?
  const proposalResult = await proposeOffer(cart, read);
  if (!proposalResult.ok) {
    return {
      usage: sumUsage([readResult.usage, proposalResult.usage]),
      decision: hold(cart, `Couldn't propose an offer — ${proposalResult.note}`, { read }),
    };
  }
  const proposal = proposalResult.value;

  // The null decision needs no review — there is nothing to protect against.
  if (proposal.offer_id === "no_offer") {
    return {
      usage: sumUsage([readResult.usage, proposalResult.usage]),
      decision: hold(cart, proposal.reason, { read, proposal }),
    };
  }

  const proposed = getOffer(proposal.offer_id);
  if (!proposed || !proposed.eligible(cart).ok || !affordable(totalCost(proposed, cart), cart.cart_value_usd)) {
    return {
      usage: sumUsage([readResult.usage, proposalResult.usage]),
      decision: hold(
        cart,
        `Proposed "${proposal.offer_id}", which isn't an offer available for this cart. Held rather than guessed at.`,
        { read, proposal },
      ),
    };
  }

  // [3] Reviewer — independent, and paid for properly when cash is at stake.
  const escalate = needsEscalation(totalCost(proposed, cart), proposed.strength);
  const reviewResult = await reviewOffer(cart, read, proposal.offer_id, escalate);
  if (!reviewResult.ok) {
    return {
      usage: sumUsage([readResult.usage, proposalResult.usage, reviewResult.usage]),
      decision: hold(cart, `Couldn't review this offer — ${reviewResult.note}`, {
        read,
        proposal,
      }),
    };
  }
  const review = reviewResult.value;
  const usage = sumUsage([readResult.usage, proposalResult.usage, reviewResult.usage]);

  if (review.verdict === "veto") {
    return {
      usage,
      decision: hold(cart, review.objection, { read, proposal, review }),
    };
  }

  // An adjustment has to name a replacement, and the replacement has to survive
  // the same checks as the original — otherwise "adjust" becomes a way to
  // smuggle in an offer nobody validated. It may go up or down, but never past
  // the ceiling the read allows, so a reviewer cannot talk the system into
  // spending more than the incrementality rule permits.
  let finalId = proposal.offer_id;
  if (review.verdict === "adjust") {
    const replacement = review.replacement_offer_id
      ? getOffer(review.replacement_offer_id)
      : undefined;
    // Bounded on both sides. Validating only the ceiling let a reviewer whittle
    // an offer below the point of sending it — found on a 60-cart run, where a
    // fan with no reason to return got a bare reminder. Sending nothing is
    // always allowed; sending something too thin to work is not.
    const strength = replacement?.strength ?? -1;
    const valid =
      replacement &&
      affordable(totalCost(replacement, cart), cart.cart_value_usd) &&
      strength <= MAX_STRENGTH_BY_RETURN_LIKELIHOOD[read.return_likelihood] &&
      (strength >= MIN_STRENGTH_BY_RETURN_LIKELIHOOD[read.return_likelihood] ||
        replacement.id === "no_offer") &&
      replacement.id !== proposed.id;

    if (!replacement || !replacement.eligible(cart).ok || !valid) {
      return {
        usage,
        decision: hold(
          cart,
          `Adjusted to "${review.replacement_offer_id}", which isn't a valid alternative for this cart. Held rather than sending the original.`,
          { read, proposal, review },
        ),
      };
    }
    finalId = replacement.id;
    if (finalId === "no_offer") {
      return { usage, decision: hold(cart, review.objection, { read, proposal, review }) };
    }
  }

  const finalOffer = getOffer(finalId)!;
  const decision: Decision = {
    cart_id: cart.cart_id,
    outcome: "offer",
    headline: describeOffer(finalId, cart),
    offer_id: finalId,
    // Computed, never taken from the model.
    cost_usd: totalCost(finalOffer, cart),
    read,
    proposal,
    review,
    gate_reason: null,
    violations: [],
  };
  decision.violations = checkInvariants(cart, decision);
  return { usage, decision };
}

/** Small pool: enough to keep wall-clock sane, not enough to rate-limit. */
const CONCURRENCY = 4;

export async function runPipeline(
  rawCarts: unknown[],
  opts: RunOptions = {},
): Promise<RunResult> {
  const carts = rawCarts.map((c) => CartFactsSchema.parse(c));
  const started = Date.now();
  const decisions: Decision[] = new Array(carts.length);
  const usageByCart: Record<string, Usage> = {};

  let cursor = 0;
  async function worker() {
    while (cursor < carts.length) {
      const i = cursor++;
      const { decision, usage } = await decideOne(carts[i], opts);
      decisions[i] = decision;
      usageByCart[carts[i].cart_id] = usage;
    }
  }
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, carts.length) }, worker));

  const usage = sumUsage(Object.values(usageByCart));

  // How much of the day's spend is revenue handed over rather than cash out
  // the door. Same money either way, but a marketer reading the number should
  // know which kind it is.
  const givenAway = decisions.reduce((n, d) => {
    if (d.outcome !== "offer" || !d.offer_id) return n;
    const cart = carts.find((c) => c.cart_id === d.cart_id)!;
    return n + (getOffer(d.offer_id)?.opportunityCost(cart) ?? 0);
  }, 0);

  return {
    decisions,
    usageByCart,
    usage,
    meta: {
      total: decisions.length,
      offers: decisions.filter((d) => d.outcome === "offer").length,
      holds: decisions.filter((d) => d.outcome === "hold").length,
      blocked: decisions.filter((d) => d.outcome === "blocked").length,
      proposed_cost_usd: Math.round(
        decisions.reduce((n, d) => n + (d.cost_usd ?? 0), 0) * 100,
      ) / 100,
      proposed_given_away_usd: Math.round(givenAway * 100) / 100,
      elapsed_ms: Date.now() - started,
      cost_usd: usage.cost_usd,
    },
  };
}
