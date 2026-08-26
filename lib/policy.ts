import type { CartFacts, Decision, FanRead } from "./schema.ts";
import {
  getOffer,
  totalCost,
  upgradeTarget,
  tierBelow,
  cheapestPaid,
  describeOffer,
  SECTION_PRICE,
} from "./catalog.ts";

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

/* ---------- the numbers, and why there are so few ------------------- */

/**
 * There are two chosen numbers in this entire system, and this is one of them.
 *
 * Everything else is either read off the data (what a seat in each section
 * costs, which is cart value over seats) or decided by an agent and shown to a
 * person for approval.
 *
 * That wasn't true a few days ago. There was a 24-hour cooling-off window, a
 * 20%-of-cart spending cap, a "loyal fan" defined as 10 tickets inside 60 days,
 * a 14-day staleness ceiling, a 7-day suppression window and a 0-4 strength
 * ladder. I swept all of them against the five carts. The cap changed no
 * decision anywhere between 10% and 50%. The loyalty rule changed nothing at
 * any value from 3 tickets to 30. Most of them were re-deriving, from numbers I
 * had invented, conclusions the analyst had already reached from the fan's
 * actual history — and the rest were patches for a bug that no longer existed,
 * back when an upgrade was priced at zero.
 *
 * Removing all of them changed one decision out of five, and made it cheaper.
 *
 * This one survives because it isn't arithmetic, it's a claim about what the
 * fan is doing right now: someone who wandered off forty minutes ago may be
 * typing their card number, and "you left something behind" is the worst
 * message they could receive. Two hours is a judgement, and three would be
 * defensible too. That the rule exists is the part that matters.
 */
export const TOO_FRESH_HOURS = 2;

/**
 * The other one, and it isn't a guard rail — it's what the club gives back.
 *
 * Every 15 tickets earns a free seat upgrade. See milestone() below for why a
 * separate reward track exists at all; the short version is that a loyal fan
 * correctly gets no win-back offer, and "correctly gets nothing" is a hard
 * thing to explain to someone sitting next to a stranger with 15% off.
 */
export const TICKETS_PER_UPGRADE = 15;

/**
 * Which tier of offer a fan qualifies for, given how likely they were to come
 * back without us.
 *
 * This is the spine of the whole system, and it used to be a 0-4 ladder with
 * ceilings and floors per likelihood. It reduces to this: if they were coming
 * back anyway, don't spend money. That is the entire idea, and expressing it as
 * a rank invited a rank-vs-price confusion that cost real money — the reviewer
 * once traded a $0 offer for a $12 one to "economise", because the ladder said
 * the second was smaller.
 *
 * `null` means the agent decides. A medium read is genuine uncertainty, and
 * resolving it with a threshold would be inventing precision I don't have; the
 * strategist makes the call and writes down why, the reviewer argues, and a
 * marketer sees both.
 */
export function allowedTier(
  likelihood: FanRead["return_likelihood"],
): "free" | "paid" | null {
  if (likelihood === "high") return "free";
  if (likelihood === "medium") return null;
  return "paid";
}

/**
 * Does this proposal deserve the better reviewer model?
 *
 * This was a $15 threshold. It's now the question the tier already answers:
 * spend more on checking when there is money on the line, and don't when the
 * offer is free. Cheaper to run and one less number to defend.
 */
export function needsEscalation(cost: number): boolean {
  return cost > 0;
}

/* ---------- the gate ------------------------------------------------ */

export type GateResult =
  | {
      pass: true;
      /** Shown on the card when there's something the marketer should know. */
      note?: string;
    }
  | { pass: false; outcome: "blocked" | "hold"; reason: string };

/**
 * Runs before any model. Order matters: consent first, because it's the one
 * that isn't a business preference.
 */
export function gate(cart: CartFacts): GateResult {
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

  return { pass: true };
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

/**
 * How the milestone gets paid, and — just as important — when.
 *
 * If there's a section above them, the seats they are buying RIGHT NOW get
 * moved up. That's the good version: they cross the threshold, and the tickets
 * already in their cart are upgraded. Nothing to claim, nothing to remember.
 *
 * If they're already in the best seats in the ground there's nowhere to move
 * them, so the reward lands on their NEXT purchase instead — those seats at the
 * tier below's price. Deliberately not applied to the cart in front of them:
 * re-pricing an order someone is halfway through paying for is a different and
 * messier thing than moving where they sit, and it means the club is handing
 * back cash on a sale it was already making.
 *
 * Both are bounded the same way: one tier gap, never a jump to the top. That's
 * what makes it work for both sides — the fan gets something real, and the
 * club's cost can't run away with how far a fan happens to sit from the best
 * seats in the ground.
 */
export type MilestoneReward =
  | { kind: "upgrade"; section: string; appliesTo: "this_cart" }
  | { kind: "priced_down"; section: string; appliesTo: "next_purchase" };

export interface Milestone {
  /** The number they land on — 15, 30, 45. */
  at: number;
  /** Lifetime tickets once this cart is paid for. */
  ticketsAfter: number;
  reward: MilestoneReward;
  /**
   * What honouring it costs, across the WHOLE cart.
   *
   * The whole party moves or nobody does. A fan who crosses their fifteenth
   * ticket buying two seats isn't going to sit in the Club while whoever they
   * came with stays in the Upper Deck — they're at the match together. So it's
   * priced for every seat in the cart, not the one that happened to tip them
   * over.
   */
  costUsd: number;
  /**
   * Whether it comes out of the till or out of inventory.
   *
   * An upgrade hands over seats that might not have sold. Pricing Club seats as
   * Lower Bowl ones hands over real money. Same gesture, different cheque, and
   * the marketer should be told which.
   */
  isCash: boolean;
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

  const paidPerSeat = cart.cart_value_usd / cart.seats;
  const up = upgradeTarget(cart.section);
  const down = tierBelow(cart.section);

  // Move them up if there's anywhere to go. If they're already at the top,
  // they keep their seats and pay the tier below's price.
  const reward: MilestoneReward | null = up
    ? { kind: "upgrade", section: up, appliesTo: "this_cart" }
    : down
      ? { kind: "priced_down", section: down, appliesTo: "next_purchase" }
      : null;
  if (!reward) return null;

  const costUsd =
    reward.kind === "upgrade"
      ? Math.round(Math.max(0, SECTION_PRICE[reward.section] - paidPerSeat) * cart.seats * 100) / 100
      : Math.round(Math.max(0, paidPerSeat - SECTION_PRICE[reward.section]) * cart.seats * 100) / 100;

  return {
    at: Math.floor(after / TICKETS_PER_UPGRADE) * TICKETS_PER_UPGRADE,
    ticketsAfter: after,
    reward,
    costUsd,
    isCash: reward.kind === "priced_down",
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
/**
 * Not the cheapest option — said to the marketer, not raised as a violation.
 *
 * This started life as an invariant and fired on both offers in a healthy run,
 * because the strategist is explicitly allowed to spend more when it can say
 * why. An alarm that goes off on permitted behaviour trains people to ignore
 * the alarms, which is the one thing the invariant list cannot afford.
 *
 * So it isn't a rule, it's a disclosure: the person approving sees the gap in
 * dollars next to the reason it was worth it, and decides. That's the honest
 * home for a judgement call — a human, not a threshold.
 */
export function premiumOverCheapest(
  cart: CartFacts,
  offerId: string,
): string | null {
  const offer = getOffer(offerId);
  if (!offer || offer.tier !== "paid") return null;
  const cheapest = cheapestPaid(cart);
  if (!cheapest || cheapest.id === offer.id) return null;
  const gap = totalCost(offer, cart) - totalCost(cheapest, cart);
  if (gap <= 0) return null;
  return `$${gap.toFixed(2)} dearer than the cheapest thing that would work here (${describeOffer(cheapest.id, cart)}, $${totalCost(cheapest, cart).toFixed(2)}). Their reason for the difference is above.`;
}

export function operatorNote(cart: CartFacts): string | null {
  const notes: string[] = [];

  // The milestone comes first, because it's the actionable one — it's a thing
  // this fan has earned rather than a thing we've decided about them.
  const m = milestone(cart);
  if (m?.reward.kind === "upgrade") {
    notes.push(
      `This cart takes them past ${m.at} tickets, so the seats they're buying get upgraded — all ${cart.seats} of them to the ${m.reward.section}, on this order. No cash, but $${m.costUsd.toFixed(2)} of better seats handed over. The whole party moves or nobody does; they're going together.`,
    );
  } else if (m) {
    notes.push(
      `This cart takes them past ${m.at} tickets, but they're already in the ${cart.section} — nowhere to move them. So the reward lands on their NEXT purchase: ${cart.section} seats at ${m.reward.section} prices. Nothing comes off this cart, and on an order this size it'd be worth about $${m.costUsd.toFixed(2)} when they claim it — real cash, not spare seats.`,
    );
  }

  return notes.length ? notes.join(" ") : null;
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

  // The spine, stated the only way it can be checked without inventing a scale:
  // did we spend money on someone who was coming back without us?
  if (decision.read) {
    const likelihood = decision.read.return_likelihood;
    const tier = allowedTier(likelihood);
    const cost = totalCost(offer, cart);

    if (tier === "free" && offer.tier === "paid") {
      problems.push(
        `INCREMENTALITY: ${offer.label} costs $${cost.toFixed(2)} and went to a fan read as likely to return without us. That is money spent on a sale we already had.`,
      );
    }

    // The other direction, which the old ladder needed a made-up floor to
    // catch: we decided this fan won't come back on their own, then sent them
    // the one message they'll open with nothing in it.
    if (tier === "paid" && offer.id === "reminder_only") {
      problems.push(
        `TOKEN OFFER: a bare reminder went to a fan read as "${likelihood}" to return unaided. Either give them a reason to come back or hold and send nothing.`,
      );
    }

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
