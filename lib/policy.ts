import type { CartFacts, Decision, FanRead } from "./schema.ts";
import { getOffer, totalCost, upgradeTarget, SECTION_PRICE } from "./catalog.ts";

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
 * Under this, the cart isn't abandoned — it's open. They may be at the checkout
 * right now, and "you left something behind" while someone is typing their card
 * number is the worst message we could send.
 */
export const TOO_FRESH_HOURS = 2;

/**
 * Under this, don't spend money — but do feel free to say something.
 *
 * This started as a rule that held everything under a day, which was wrong in a
 * way worth writing down. The reason not to contact a fan inside 24 hours is
 * that most of them are coming back anyway, so anything we GIVE them is margin
 * spent on a sale we already had. That argument is about cost. A plain reminder
 * costs nothing, and someone who got interrupted three hours ago is exactly who
 * a reminder helps.
 *
 * So the window doesn't block contact. It caps what contact is allowed to cost.
 */
export const COOLING_OFF_HOURS = 24;

/**
 * Inside the cooling-off window the offer is exactly a reminder — no more, and
 * also no less.
 *
 * The ceiling is the incrementality rule: don't spend money on someone who was
 * coming back anyway. The floor is a business decision, and it's the club's to
 * make rather than the model's. Asked to choose, the strategist argued for
 * silence — "a reminder costs nothing, but it's also unnecessary contact to
 * someone who was already coming back" — which is a perfectly reasonable
 * position and not the one the club takes. A fan who walked away from a
 * half-finished purchase three hours ago most likely got interrupted, a nudge
 * is a service to them, and it costs nothing to send.
 *
 * Written as a rule rather than argued into the prompt. Nudging a model until
 * it agrees with you isn't a policy, it's a coincidence you'll have to
 * rediscover every time the prompt changes.
 */
export const COOLING_OFF_MAX_STRENGTH = 1;
export const COOLING_OFF_MIN_STRENGTH = 1;

/** Past this, the fixture is stale and the moment has gone. Nudging reads as noise. */
export const STALE_CEILING_HOURS = 24 * 14;

/** Don't contact the same fan twice in a week, whatever the agent thinks. */
export const SUPPRESSION_DAYS = 7;

/** A fan is "loyal" at this much history — the group a discount insults. */
export const LOYAL_TICKETS = 10;
export const LOYAL_RECENCY_DAYS = 60;

/**
 * Ceilings on what the club gives away.
 *
 * Expressed as a share of what's at stake rather than as flat dollars, because
 * a flat number is a number somebody made up. $60 was mine, and it was wrong in
 * a way worth remembering: `C-1003`'s cart is $58, so a $60 offer would have
 * passed a $60 ceiling while being worth more than the cart it was rescuing.
 *
 * A share can't do that, and it scales without anyone editing a constant — the
 * same rule holds for five carts a day and five hundred.
 *
 * Counts cash AND revenue handed over as seats, because a seat given to someone
 * who would have paid for it is as gone as a dollar discounted.
 */

/** Never give away more than a fifth of the cart you're trying to rescue. */
export const MAX_SHARE_OF_CART = 0.2;

/*
 * There is deliberately no daily spend budget.
 *
 * Every offer in this system is approved one at a time by a person, with its
 * price on the card. A marketer cannot overspend by accident — they would have
 * to click through each one individually — so a daily cap guards against a
 * failure mode the approval gate already prevents. It's a control for an
 * autonomous system, and this isn't one yet.
 *
 * The first thing to add when this starts sending without a human in front of
 * it. Not before.
 */

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
  | {
      pass: true;
      /**
       * A ceiling this cart carries regardless of what the analyst reads, used
       * for the cooling-off window. Undefined means the read alone decides.
       */
      maxStrength?: number;
      /** A floor this cart carries — what the club always sends in this case. */
      minStrength?: number;
      /** Shown on the card so the limit isn't invisible. */
      note?: string;
    }
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

  if (cart.abandoned_hours_ago < TOO_FRESH_HOURS) {
    const hrs = cart.abandoned_hours_ago;
    return {
      pass: false,
      outcome: "hold",
      reason: `Left ${hrs} hour${hrs === 1 ? "" : "s"} ago — that's not an abandoned cart yet, they may still be checking out. Look again later today.`,
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

  if (cart.abandoned_hours_ago < COOLING_OFF_HOURS) {
    return {
      pass: true,
      maxStrength: COOLING_OFF_MAX_STRENGTH,
      minStrength: COOLING_OFF_MIN_STRENGTH,
      note: `Left ${cart.abandoned_hours_ago} hours ago — too fresh to spend money on, most fans this recent come back by themselves. A reminder is free though.`,
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
export function affordable(cost: number, cartValue: number): boolean {
  return cost <= cartValue * MAX_SHARE_OF_CART;
}

/** Does this proposal need the better reviewer model? */
export function needsEscalation(cost: number, strength: number): boolean {
  return cost > ESCALATION_COST_USD || strength >= 4;
}

/**
 * Every 15 tickets earns a free seat upgrade.
 *
 * This is the club's answer to the awkward question the rest of the system
 * can't solve: a loyal fan correctly gets no win-back offer, because they were
 * coming back anyway — and that leaves them with a blank next to a stranger's
 * 15% off. Fans talk. A few thousand of them know each other.
 *
 * A milestone fixes it in a currency that isn't a discount. It is EARNED rather
 * than spent: the fan gets it for buying their 15th, 30th, 45th ticket, whether
 * or not they ever abandoned a cart. So it doesn't break the rule about not
 * paying for sales you already had — nothing here is being paid to change
 * anyone's mind. It's owed.
 *
 * It also gives the one message a loyal fan does get something worth reading.
 * "Your cart is still there" is a nag. "These two seats take you to fifteen
 * tickets, and that earns you an upgrade" is news.
 */
export const TICKETS_PER_UPGRADE = 15;

export interface Milestone {
  /** The number they land on — 15, 30, 45. */
  at: number;
  /** Lifetime tickets once this cart is paid for. */
  ticketsAfter: number;
  /**
   * The section they move to, or null if they're already in the best seats.
   *
   * Not every milestone can be paid out. A fan whose cart is in the Club has
   * nowhere to be upgraded to, and promising them one anyway is worse than
   * saying nothing — that's a message the club can't honour.
   */
  upgradeTo: string | null;
  /**
   * What honouring it costs, across the WHOLE cart.
   *
   * The whole party moves or nobody does. A fan who crosses their fifteenth
   * ticket buying two seats isn't going to sit in the Club while whoever they
   * came with stays in the Upper Deck — they're at the match together. So the
   * milestone is priced for every seat in the cart, not for the one that
   * happened to tip them over.
   */
  costUsd: number;
}

/** Does paying for this cart take the fan past their next milestone? */
export function milestone(cart: CartFacts): Milestone | null {
  const before = cart.lifetime_tickets;
  const after = before + cart.seats;
  if (
    Math.floor(after / TICKETS_PER_UPGRADE) <= Math.floor(before / TICKETS_PER_UPGRADE)
  ) {
    return null;
  }

  const upgradeTo = upgradeTarget(cart.section);
  const paidPerSeat = cart.cart_value_usd / cart.seats;
  const costUsd = upgradeTo
    ? Math.round(Math.max(0, SECTION_PRICE[upgradeTo] - paidPerSeat) * cart.seats * 100) / 100
    : 0;

  return {
    at: Math.floor(after / TICKETS_PER_UPGRADE) * TICKETS_PER_UPGRADE,
    ticketsAfter: after,
    upgradeTo,
    costUsd,
  };
}

/**
 * What the screen should say beyond the decision itself.
 *
 * A loyal fan correctly gets no offer — they were coming back anyway, and
 * discounting them is both wasted margin and a strange message. But "no offer"
 * renders as a blank, and a blank sitting next to a first-timer's 15% is the
 * fairness problem this system is otherwise silent about. The club's core
 * should get looked after in a currency that isn't money, and that decision
 * belongs to a person, not to this pipeline. So: put it in front of them.
 */
export function operatorNote(cart: CartFacts): string | null {
  const notes: string[] = [];

  // The milestone comes first, because it's the actionable one — it's a thing
  // this fan has earned rather than a thing we've decided about them.
  const m = milestone(cart);
  if (m && m.upgradeTo) {
    notes.push(
      `This cart takes them past ${m.at} tickets, which earns a free upgrade — all ${cart.seats} seats to the ${m.upgradeTo}, about $${m.costUsd.toFixed(2)}. The whole party moves or nobody does; they're going together. Say so, it turns a nag into a reason to finish.`,
    );
  } else if (m) {
    notes.push(
      `This cart takes them past ${m.at} tickets, but they're already in the ${cart.section} — there's nothing to upgrade them to. Worth thanking them some other way, and that one's yours to pick.`,
    );
  }

  const loyal =
    cart.lifetime_tickets >= LOYAL_TICKETS &&
    cart.last_purchase_days_ago !== null &&
    cart.last_purchase_days_ago <= LOYAL_RECENCY_DAYS;
  if (!loyal) return notes.length ? notes.join(" ") : null;

  // Worded to hold up whether this fan is being left alone or sent a free
  // reminder. An earlier version said "leaving them alone is right", which
  // started contradicting the card it sat on the moment reminders existed.
  notes.push(
    `${cart.lifetime_tickets} tickets, last bought ${cart.last_purchase_days_ago} days ago — the club's core. Don't discount them: they were coming back anyway.`,
  );
  return notes.join(" ");
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

  if (cart.abandoned_hours_ago < TOO_FRESH_HOURS) {
    problems.push(
      `TOO FRESH: an offer was produced ${cart.abandoned_hours_ago}h after the cart was left, while the fan may still be at the checkout.`,
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
    const gated = gate(cart);
    const ceiling = Math.min(
      MAX_STRENGTH_BY_RETURN_LIKELIHOOD[likelihood],
      gated.pass ? (gated.maxStrength ?? Infinity) : Infinity,
    );
    // Never demand more than the ceiling permits. A lapsed fan who left five
    // hours ago would otherwise trip both rules at once: the read says a nudge
    // alone won't move them, and the cooling-off window says a nudge is all
    // they may have. That isn't a token offer, it's a sequence — a reminder
    // today, and something with weight behind it tomorrow if they still
    // haven't come back.
    const floor = Math.min(MIN_STRENGTH_BY_RETURN_LIKELIHOOD[likelihood], ceiling);

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
  const ceiling = cart.cart_value_usd * MAX_SHARE_OF_CART;
  if (cost > ceiling) {
    const share = Math.round((cost / cart.cart_value_usd) * 100);
    problems.push(
      `CAP: $${cost.toFixed(2)} is ${share}% of a $${cart.cart_value_usd.toFixed(2)} cart. The ceiling is ${Math.round(MAX_SHARE_OF_CART * 100)}% — $${ceiling.toFixed(2)} here.`,
    );
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
