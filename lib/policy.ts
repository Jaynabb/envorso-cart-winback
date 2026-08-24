import type { CartFacts, Decision, FanRead } from "./schema.ts";
import { getOffer, totalCost } from "./catalog.ts";

/**
 * The parts of this system that are rules, not judgement.
 *
 * Two jobs live here. The GATE runs before any model and stops carts that
 * shouldn't be reasoned about at all — you should not need a language model to
 * notice you don't have permission to email someone. The INVARIANTS run after
 * the models and check their work with arithmetic, because the failure mode
 * that matters is an offer that reads beautifully and is still wrong.
 *
 * Everything here is free, instant, and cannot hallucinate. That's the whole
 * argument for doing it in code: an LLM asked to enforce a consent rule will
 * enforce it almost every time, and "almost" is not a standard you can put in
 * front of a fan.
 */

/* ---------- the numbers, and why they are what they are ------------- */

/**
 * Below this, a cart is not abandoned — it's in progress. Someone got up, took
 * a call, left the tab open. Contacting them inside a day mostly reaches people
 * who were coming back anyway, and the ones it converts would have converted.
 */
export const COOLING_OFF_HOURS = 24;

/** Past this, the fixture is stale and the moment has gone. Nudging reads as noise. */
export const STALE_CEILING_HOURS = 24 * 14;

/** Don't contact the same fan twice in a week, whatever the agent thinks. */
export const SUPPRESSION_DAYS = 7;

/** A fan is "loyal" at this much history — the group a discount insults. */
export const LOYAL_TICKETS = 10;
export const LOYAL_RECENCY_DAYS = 60;

/**
 * Ceilings on what the club gives away, in dollars.
 *
 * Counts cash AND revenue handed over as inventory, because a seat given to
 * someone who would have paid for it is as gone as a dollar discounted. The
 * daily one exists because a bad day should be bounded even when every single
 * decision on it was defensible.
 */
export const MAX_COST_PER_CART = 60;
export const DAILY_COST_CAP = 250;

/**
 * Over this, a second opinion is worth paying for. The reviewer runs on the
 * cheap model by default and escalates past this line — capability where the
 * money is, rather than uniformly.
 */
export const ESCALATION_COST_USD = 15;

/**
 * The strongest offer allowed, given how likely the fan was to return anyway.
 *
 * This is the spine of the whole system expressed as arithmetic. Strength comes
 * from the catalog: 0 nothing, 1 reminder, 2 fee waiver, 3 upgrade, 4-5 cash.
 * A fan who is probably coming back gets a reminder at most. Money is reserved
 * for the cases where we have no reason to believe they return without it.
 */
export const MAX_STRENGTH_BY_RETURN_LIKELIHOOD: Record<FanRead["return_likelihood"], number> = {
  high: 1,
  medium: 3,
  low: 5,
  unknown: 5,
};

/**
 * The floor, and why there has to be one.
 *
 * The ceiling above only bounds over-spending, which quietly assumes the only
 * expensive mistake is generosity. It isn't. If we have decided to contact a fan
 * who has no reason to come back on their own, a nudge that costs nothing is a
 * touch spent for nothing — we used the one message they'll open and gave them
 * no reason to act.
 *
 * This applies only once the system has decided to make an offer at all. Sending
 * nothing is always available and is often right; what isn't available is
 * sending something too thin to work and calling it caution.
 */
export const MIN_STRENGTH_BY_RETURN_LIKELIHOOD: Record<FanRead["return_likelihood"], number> = {
  high: 0,
  medium: 0,
  low: 2,
  unknown: 2,
};

/**
 * The share of qualified carts that deliberately get nothing.
 *
 * This is the only honest way to answer "are these offers any good". Redemption
 * rate on its own is a vanity metric: some of the fans who convert after an
 * offer were going to convert anyway, and counting them makes any campaign look
 * like it works. Holding a slice back and comparing gives you the number that
 * matters — how many extra carts got finished BECAUSE of the offer.
 *
 * Applied after a cart qualifies, never before, so the two groups are alike in
 * every way except whether we contacted them.
 */
export const HOLDOUT_PERCENT = 10;

/**
 * Stable assignment: the same fan is always on the same side.
 *
 * Deterministic on the fan id rather than random per run, because a fan who
 * flips between groups day to day is in neither, and the comparison stops
 * meaning anything. FNV-1a — small, dependency-free, and spreads well enough
 * for a bucket decision.
 */
export function isHoldout(fanId: string, percent: number = HOLDOUT_PERCENT): boolean {
  if (percent <= 0) return false;
  let hash = 0x811c9dc5;
  for (let i = 0; i < fanId.length; i++) {
    hash ^= fanId.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash % 100 < percent;
}

/* ---------- the gate ------------------------------------------------ */

export type GateResult =
  | { pass: true }
  | { pass: false; outcome: "blocked" | "hold"; reason: string };

/**
 * Runs before any model. Order matters: consent first, because it's the one
 * that isn't a business preference.
 */
export function gate(
  cart: CartFacts,
  opts: { lastContactedDaysAgo?: number | null; holdoutPercent?: number } = {},
): GateResult {
  if (!cart.email_opt_in) {
    return {
      pass: false,
      outcome: "blocked",
      reason:
        "This fan has not opted in to email. There is no channel to reach them on, so there is nothing to decide.",
    };
  }

  if (cart.abandoned_hours_ago < COOLING_OFF_HOURS) {
    const hrs = cart.abandoned_hours_ago;
    return {
      pass: false,
      outcome: "hold",
      reason: `Abandoned ${hrs} hour${hrs === 1 ? "" : "s"} ago — inside the ${COOLING_OFF_HOURS}-hour window where most fans come back on their own. Re-check tomorrow.`,
    };
  }

  if (cart.abandoned_hours_ago > STALE_CEILING_HOURS) {
    return {
      pass: false,
      outcome: "hold",
      reason: `Abandoned ${Math.round(cart.abandoned_hours_ago / 24)} days ago. Too cold to read as a follow-up; this belongs in a campaign, not a cart nudge.`,
    };
  }

  const contacted = opts.lastContactedDaysAgo;
  if (contacted !== null && contacted !== undefined && contacted < SUPPRESSION_DAYS) {
    return {
      pass: false,
      outcome: "hold",
      reason: `Already contacted ${contacted} day${contacted === 1 ? "" : "s"} ago. Suppressed for ${SUPPRESSION_DAYS} days so we don't stack messages on one fan.`,
    };
  }

  // Last, so the held-back group is drawn only from carts we would otherwise
  // have contacted. Off by default: the sample run is scoring the agent's
  // judgement, and a cart pulled out for measurement would muddy that.
  if (opts.holdoutPercent && isHoldout(cart.fan_id, opts.holdoutPercent)) {
    return {
      pass: false,
      outcome: "hold",
      reason: `Held back on purpose — this fan is in the ${opts.holdoutPercent}% control group. They get nothing today so we can tell later how many carts the offers actually rescued, rather than counting fans who were coming back anyway.`,
    };
  }

  return { pass: true };
}

/**
 * Offers this cart is actually allowed to receive.
 *
 * Every invariant needs a matching enforcement point or it's a report rather
 * than a guard rail — the per-cart cap was caught by checkInvariants three runs
 * in a row while the pipeline cheerfully let the offer through, because nothing
 * upstream had removed it from the menu. Filtering here means the strategist is
 * never shown an option it isn't permitted to pick, and the invariant goes back
 * to being the backstop it was meant to be.
 */
export function affordable(cost: number): boolean {
  return cost <= MAX_COST_PER_CART;
}

/** Does this proposal need the better reviewer model? */
export function needsEscalation(cost: number, strength: number): boolean {
  return cost > ESCALATION_COST_USD || strength >= 4;
}

/* ---------- the invariants ------------------------------------------ */

/**
 * Checked after the models have run, on every decision, on any dataset.
 *
 * These need no labels and no answer key, which is what makes them the part of
 * the evaluation that keeps working after the five sample carts are gone. A
 * violation is not a style note — it means an offer got through that the rules
 * say shouldn't exist, and the run should be looked at before anything sends.
 */
export function checkInvariants(cart: CartFacts, decision: Decision): string[] {
  const problems: string[] = [];

  if (decision.outcome !== "offer") return problems;

  if (!cart.email_opt_in) {
    problems.push("CONSENT: an offer was produced for a fan who never opted in.");
  }

  if (cart.abandoned_hours_ago < COOLING_OFF_HOURS) {
    problems.push(
      `COOLING-OFF: an offer was produced ${cart.abandoned_hours_ago}h after abandonment, inside the ${COOLING_OFF_HOURS}h window.`,
    );
  }

  const offer = decision.offer_id ? getOffer(decision.offer_id) : undefined;
  if (!offer) {
    problems.push(`CATALOG: "${decision.offer_id}" is not an offer we sell.`);
    return problems;
  }

  const eligibility = offer.eligible(cart);
  if (!eligibility.ok) {
    problems.push(`CATALOG: ${offer.label} isn't available here — ${eligibility.why}`);
  }

  // The spine, as arithmetic — bounded on both sides.
  if (decision.read) {
    const likelihood = decision.read.return_likelihood;
    const ceiling = MAX_STRENGTH_BY_RETURN_LIKELIHOOD[likelihood];
    const floor = MIN_STRENGTH_BY_RETURN_LIKELIHOOD[likelihood];

    if (offer.strength > ceiling) {
      problems.push(
        `INCREMENTALITY: ${offer.label} was offered to a fan read as "${likelihood}" to return unaided. The strongest offer allowed at that likelihood is ${ceiling}; this one is ${offer.strength}. We are paying for a sale we may already have had.`,
      );
    }

    if (offer.strength < floor) {
      problems.push(
        `TOKEN OFFER: ${offer.label} was sent to a fan read as "${likelihood}" to return unaided — someone with no reason to come back by themselves. At that likelihood an offer needs to be at least ${floor} to be worth making; this one is ${offer.strength}. Either make it worth making or hold and send nothing.`,
      );
    }
  }

  // The C-1004 guard, stated as a rule rather than left to taste.
  const isLoyal =
    cart.lifetime_tickets >= LOYAL_TICKETS &&
    cart.last_purchase_days_ago !== null &&
    cart.last_purchase_days_ago <= LOYAL_RECENCY_DAYS;
  if (isLoyal && offer.kind === "discount") {
    problems.push(
      `LOYALTY: cash discount offered to a fan with ${cart.lifetime_tickets} lifetime tickets who bought ${cart.last_purchase_days_ago} days ago. Discounting the core teaches them that walking away pays.`,
    );
  }

  const cost = totalCost(offer, cart);
  if (cost > MAX_COST_PER_CART) {
    problems.push(`CAP: $${cost.toFixed(2)} exceeds the $${MAX_COST_PER_CART} per-cart ceiling.`);
  }

  // The model asserting a number we can compute ourselves.
  //
  // Checked against the offer the strategist actually proposed, not against
  // whatever survived review. The first version compared the claim to the final
  // offer and fired every time the reviewer adjusted to something else — a
  // false alarm on a healthy run, which is the fastest way to teach someone to
  // ignore the alarms.
  if (decision.proposal) {
    const proposed = getOffer(decision.proposal.offer_id);
    if (proposed) {
      const proposedCash = totalCost(proposed, cart);
      if (Math.abs(decision.proposal.claimed_cost_usd - proposedCash) > 0.01) {
        problems.push(
          `COST: the strategist claimed ${decision.proposal.offer_id} costs $${decision.proposal.claimed_cost_usd.toFixed(2)}; it actually costs $${proposedCash.toFixed(2)}.`,
        );
      }
    }
  }

  return problems;
}

/** Run-level check. The per-cart caps can each pass while the day still overspends. */
export function checkRunTotal(decisions: Decision[]): string[] {
  const total = decisions.reduce((sum, d) => sum + (d.cost_usd ?? 0), 0);
  if (total <= DAILY_COST_CAP) return [];

  // Deliberately not auto-trimmed. Every individual offer here passed its own
  // checks; what's over budget is the day, and choosing which fans to drop is a
  // business call rather than an arithmetic one. The console shows the running
  // total as approvals happen so the decision is made with the number visible.
  const offers = decisions.filter((d) => d.outcome === "offer").length;
  return [
    `DAILY CAP: approving all ${offers} offers would spend $${total.toFixed(2)} against a $${DAILY_COST_CAP} daily cap. Each one passed on its own — it's the day that's over budget. Approve selectively, or raise the cap deliberately.`,
  ];
}
