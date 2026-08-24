import type { CartFacts } from "./schema.ts";

/**
 * The closed set of things we are willing to offer.
 *
 * The strategist returns an ID from this list. It never writes an offer in
 * prose, which is what makes "upgrade them to Club" impossible to invent when
 * Club is sold out — an agent can hallucinate a sentence, it cannot hallucinate
 * a primary key that fails a lookup.
 *
 * Adding an offer is one entry here. The prompt renders itself from this file
 * (see lib/prompt.ts), so the model's menu and the validator's menu are the
 * same object and can't drift apart.
 */

export const OFFER_KINDS = ["none", "reminder", "fee_waiver", "upgrade", "discount"] as const;
export type OfferKind = (typeof OFFER_KINDS)[number];

/** Nominal per-seat price by section, and the ladder an upgrade climbs. */
const SECTION_LADDER = ["Upper Deck", "Lower Bowl", "Club"] as const;
const SEAT_PRICE: Record<string, number> = {
  "Upper Deck": 35,
  "Lower Bowl": 55,
  Club: 90,
};

/** Per-seat service fee, the thing a fee waiver waives. */
const SERVICE_FEE_PER_SEAT = 6;

/**
 * How much of each section we expect to sell for a typical fixture.
 *
 * THE assumption in this whole model, and the one to argue with first. In
 * production these come from the ticketing system per fixture — a Saturday
 * against a rival and a wet Wednesday are not the same number. Here they're
 * constants, stated out loud rather than buried, because the entire question of
 * whether an upgrade is cheap or expensive turns on them.
 *
 * Starfire holds roughly 4,000 and MLR crowds usually don't fill it, so the
 * lower bowl fills first and the upper deck carries the empty seats.
 */
const SELL_THROUGH: Record<string, number> = {
  "Upper Deck": 0.55,
  "Lower Bowl": 0.7,
  Club: 0.8,
};

export interface Eligibility {
  ok: boolean;
  /** Why not, when it isn't. Shown to the marketer, not swallowed. */
  why?: string;
}

export interface CatalogEntry {
  id: string;
  kind: OfferKind;
  label: string;
  /** Rendered into the strategist's prompt. Says when this is the right tool. */
  description: string;
  /**
   * How strong an offer this is, 0 = nothing at all.
   *
   * This exists so the monotonicity invariant in policy.ts is checkable
   * arithmetic rather than a judgement call: a fan who is likely to return on
   * their own must not receive a higher rank than one who isn't.
   */
  strength: number;
  /**
   * Cash off the club's top line.
   *
   * A ticket is perishable and the marginal cost of one more person in a seat
   * is about nothing, so a dollar discounted is a dollar of margin. Face value
   * IS the cost here.
   */
  cashCost(cart: CartFacts): number;
  /**
   * Revenue given up by handing over inventory someone else might have bought.
   *
   * This started as "an upgrade costs nothing", which was wrong and expensively
   * so. Moving a fan up a section doesn't cost cash, but it does consume a seat
   * that had a real chance of selling — and it frees the cheaper one, which has
   * a smaller chance of selling. The honest number is the difference:
   *
   *   better price x P(better sells) - cheaper price x P(cheaper sells)
   *
   * On these fill rates that's about $19 a seat, which makes a two-seat upgrade
   * five times more expensive than a 10% discount on a $70 cart. The reviewer
   * agent had been saying exactly this and being overruled by a menu that
   * printed "$0" next to it.
   */
  opportunityCost(cart: CartFacts): number;
  eligible(cart: CartFacts): Eligibility;
}

const alwaysEligible = (): Eligibility => ({ ok: true });

/** One step up the ladder, or null at the top. */
export function upgradeTarget(section: string): string | null {
  const i = SECTION_LADDER.indexOf(section as (typeof SECTION_LADDER)[number]);
  if (i < 0 || i === SECTION_LADDER.length - 1) return null;
  return SECTION_LADDER[i + 1];
}

export const CATALOG: CatalogEntry[] = [
  {
    id: "no_offer",
    kind: "none",
    label: "No offer",
    description:
      "Send this fan nothing. The right answer whenever they were going to come back without us — an offer there is money spent on a sale we already had, and it teaches a reliable buyer that walking away gets rewarded.",
    strength: 0,
    cashCost: () => 0,
    opportunityCost: () => 0,
    eligible: alwaysEligible,
  },
  {
    id: "reminder_only",
    kind: "reminder",
    label: "Reminder, no offer",
    description:
      "A plain nudge that the cart is still there. No money, no perk. For a fan who probably just got interrupted, where the useful thing is the reminder itself rather than a reason to feel clever about waiting.",
    strength: 1,
    cashCost: () => 0,
    opportunityCost: () => 0,
    eligible: alwaysEligible,
  },
  {
    id: "fee_waiver",
    kind: "fee_waiver",
    label: "Service fees waived",
    description:
      "Waive the per-seat service fee. The smallest real offer there is — it reads as removing an annoyance rather than cutting the price of a ticket, so it doesn't reset what a fan thinks a seat costs.",
    strength: 2,
    cashCost: (c) => SERVICE_FEE_PER_SEAT * c.seats,
    opportunityCost: () => 0,
    eligible: alwaysEligible,
  },
  {
    id: "upgrade_one_tier",
    kind: "upgrade",
    label: "Free seat upgrade",
    description:
      "Move them up a section at the price they already had in the cart — the fan is told exactly which section, by name. Costs no cash, because it spends a seat that was likely going unsold, and it reads as being looked after rather than marked down. The right tool for winning back a fan who has drifted away.",
    strength: 3,
    cashCost: () => 0,
    opportunityCost: (c) => {
      const target = upgradeTarget(c.section);
      if (!target) return 0;
      const given = SEAT_PRICE[target] * (SELL_THROUGH[target] ?? 0);
      const freed = SEAT_PRICE[c.section] * (SELL_THROUGH[c.section] ?? 0);
      return round2(Math.max(0, given - freed) * c.seats);
    },
    eligible: (c) =>
      upgradeTarget(c.section)
        ? { ok: true }
        : { ok: false, why: `${c.section} is the top section — there is nothing to upgrade to.` },
  },
  {
    id: "discount_10",
    kind: "discount",
    label: "10% off the cart",
    description:
      "Real money off. Only where there is genuine doubt the fan returns at all, and the cheaper tools above won't move them.",
    strength: 4,
    cashCost: (c) => round2(c.cart_value_usd * 0.1),
    opportunityCost: () => 0,
    eligible: alwaysEligible,
  },
  {
    id: "discount_15",
    kind: "discount",
    label: "15% off the cart",
    description:
      "The deepest offer available. Reserved for a fan we have no evidence will ever come back on their own — a first-timer with no history, or someone long lapsed. Never for a regular buyer.",
    strength: 5,
    cashCost: (c) => round2(c.cart_value_usd * 0.15),
    opportunityCost: () => 0,
    eligible: alwaysEligible,
  },
];

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

/**
 * What this offer really costs the club, in dollars.
 *
 * Cash out the door plus revenue given away. Two numbers that used to be kept
 * apart, because one of them was being reported as free — and an offer you
 * can't put a single number on is an offer nobody can compare.
 */
export function totalCost(offer: CatalogEntry, cart: CartFacts): number {
  return round2(offer.cashCost(cart) + offer.opportunityCost(cart));
}

const BY_ID = new Map(CATALOG.map((o) => [o.id, o]));

export function getOffer(id: string): CatalogEntry | undefined {
  return BY_ID.get(id);
}

/** The offers that could legally be used for this cart, for the prompt and the UI. */
export function eligibleOffers(cart: CartFacts): CatalogEntry[] {
  return CATALOG.filter((o) => o.eligible(cart).ok);
}

/** What this offer actually says to the fan, once a marketer approves it. */
export function describeOffer(id: string, cart: CartFacts): string {
  const offer = getOffer(id);
  if (!offer) return "Unknown offer";
  if (offer.id === "upgrade_one_tier") {
    const target = upgradeTarget(cart.section);
    return target ? `Free upgrade from ${cart.section} to ${target}` : offer.label;
  }
  if (offer.id === "no_offer" || offer.id === "reminder_only") return offer.label;
  if (offer.kind === "discount") {
    return `${offer.label} — saves $${offer.cashCost(cart).toFixed(2)}`;
  }
  if (offer.id === "fee_waiver") {
    return `${offer.label} — saves $${offer.cashCost(cart).toFixed(2)} on ${cart.seats} seat${cart.seats === 1 ? "" : "s"}`;
  }
  return offer.label;
}
