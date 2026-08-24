import type { CartFacts, Decision, FanRead } from "./schema.ts";
import { getOffer } from "./catalog.ts";

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

/** Ceilings on cash. The cap is per run, because a bad day should be bounded. */
export const MAX_CASH_PER_CART = 60;
export const DAILY_CASH_CAP = 250;

/**
 * Over this, a second opinion is worth paying for. The reviewer runs on the
 * cheap model by default and escalates past this line — capability where the
 * money is, rather than uniformly.
 */
export const ESCALATION_CASH_USD = 15;

/**
 * The most a concession may be, given how likely the fan was to return anyway.
 *
 * This is the spine of the whole system expressed as arithmetic. Ranks come
 * from the catalog: 0 nothing, 1 reminder, 2 fee waiver, 3 upgrade, 4-5 cash.
 * A fan who is probably coming back gets a reminder at most. Money is reserved
 * for the cases where we have no reason to believe they return without it.
 */
export const MAX_RANK_BY_RETURN_LIKELIHOOD: Record<FanRead["return_likelihood"], number> = {
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
export const MIN_RANK_BY_RETURN_LIKELIHOOD: Record<FanRead["return_likelihood"], number> = {
  high: 0,
  medium: 0,
  low: 2,
  unknown: 2,
};

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
  opts: { lastContactedDaysAgo?: number | null } = {},
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

  return { pass: true };
}

/** Does this proposal need the better reviewer model? */
export function needsEscalation(cashCost: number, concessionRank: number): boolean {
  return cashCost > ESCALATION_CASH_USD || concessionRank >= 4;
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
    const ceiling = MAX_RANK_BY_RETURN_LIKELIHOOD[likelihood];
    const floor = MIN_RANK_BY_RETURN_LIKELIHOOD[likelihood];

    if (offer.concession_rank > ceiling) {
      problems.push(
        `INCREMENTALITY: ${offer.label} was offered to a fan read as "${likelihood}" to return unaided. At that likelihood the ceiling is rank ${ceiling}; this is rank ${offer.concession_rank}. We are paying for a sale we may already have had.`,
      );
    }

    if (offer.concession_rank < floor) {
      problems.push(
        `TOKEN OFFER: ${offer.label} was sent to a fan read as "${likelihood}" to return unaided — someone with no reason to come back by themselves. At that likelihood an offer needs to be at least rank ${floor} to be worth making; this is rank ${offer.concession_rank}. Either make it worth making or hold and send nothing.`,
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

  const cash = offer.cashCost(cart);
  if (cash > MAX_CASH_PER_CART) {
    problems.push(`CAP: $${cash.toFixed(2)} exceeds the $${MAX_CASH_PER_CART} per-cart ceiling.`);
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
      const proposedCash = proposed.cashCost(cart);
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
  return total > DAILY_CASH_CAP
    ? [
        `DAILY CAP: this run proposes $${total.toFixed(2)} in concessions against a $${DAILY_CASH_CAP} cap.`,
      ]
    : [];
}
