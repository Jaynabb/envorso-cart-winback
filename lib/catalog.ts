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

export const OFFER_KINDS = ["none", "reminder", "upgrade", "discount"] as const;
export type OfferKind = (typeof OFFER_KINDS)[number];

const SECTION_LADDER = ["Upper Deck", "Lower Bowl", "Club"] as const;

/**
 * Per-seat price by section, read off the carts rather than invented.
 *
 * Every cart states its own price — value divided by seats:
 *
 *   Upper Deck   $35, $35        consistent
 *   Lower Bowl   $48, $58        NOT one number
 *   Club         $90             one observation
 *
 * Lower Bowl below is the midpoint of two data points, which is a weak thing to
 * call a price. Real venues price by row inside a section, so $48-$58 is
 * probably the actual spread rather than noise, and one of these is a
 * front-row-ish seat and the other isn't.
 *
 * Worth knowing whether that uncertainty changes any answer, and here it
 * doesn't. Running the upgrade cost at $48, $53 and $58 moves it from $28.70 to
 * $42.70 on C-1005 — and all three are over the 20% cap, so the offer is off
 * the menu either way. Same on C-1002. The number is uncertain; the decision
 * isn't sensitive to it.
 *
 * Sanity check against the real club: Seawolves tickets run about $39-$73 and
 * average $50, so a $35-$90 spread across three tiers is the right shape.
 *
 * In production these are price levels in the ticketing platform, per fixture.
 * Envorso runs that platform, so it's a lookup rather than an average of two.
 */
export const SECTION_PRICE: Record<string, number> = {
  "Upper Deck": 35,
  "Lower Bowl": 53,
  Club: 90,
};



/**
 * A note on what an upgrade costs, and why there are no probabilities here.
 *
 * The honest cost of moving a fan up a section is the revenue on the seat you
 * hand over, weighted by the chance it would have sold, minus the cheaper seat
 * you free up, weighted by the same. I had those two chances in here as 70% and
 * 55% — numbers I had made up, doing real work in real arithmetic.
 *
 * I replaced them with a claim that the Seawolves sell out, which was also
 * something I had made up. Starfire holds about 4,000-4,500 and a regular
 * season match draws about 2,000-3,500, so roughly half to four fifths full.
 * They do not sell out.
 *
 * So the cost is priced at the full gap anyway — a $53 seat handed over for a
 * $35 one costs $18 — and the reason is now the honest one rather than a
 * sell-out that isn't happening. Pricing at the gap is the EXPENSIVE end. On
 * those attendance numbers the true cost is nearer two thirds of it, so this
 * overstates what an upgrade costs and can never hide one. Better to be wrong
 * in the direction that spends less of the club's money.
 *
 * Being wrong by a third changes no decision here, which is why it stays a flat
 * gap instead of a probability: on the biggest upgrade in the set it moves $72
 * to about $47, against $21 for the discount that beats it either way. A number
 * that can't change an answer isn't worth the arithmetic.
 *
 * Per-fixture fill lives in the ticketing platform, which Envorso runs. When
 * that's wired in, this becomes a lookup and the number falls for quiet
 * fixtures.
 */


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
   * Whether this offer costs the club anything.
   *
   * Deliberately a yes/no rather than a rank. There was a 0-4 "strength" scale
   * here, and it was the wrong idea twice over: it invented an ordering that
   * nothing in the data supports, and it competed with the one ordering that
   * IS real — what each offer costs in dollars. Rank told me an upgrade was
   * gentler than a discount; the prices told me it was five times dearer. The
   * prices were right.
   *
   * So the only distinction drawn here is the one that matters for the rule
   * this system exists to enforce: don't spend money on a fan who was coming
   * back anyway. Free or not free. Which of the paid ones to use is a cost
   * comparison, and the numbers are right there.
   */
  tier: "none" | "free" | "paid";
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
   *   price of the seat handed over  -  price of the seat freed up
   *
   * We price it as if the better seat would certainly have sold. That's the
   * cautious end — if it wouldn't have sold, the upgrade costs less than this
   * says — and it's the reason upgrades rarely win. On a $70 Upper Deck cart
   * the gap is $36, against $7 for a 10% discount. The reviewer agent had been
   * saying exactly this for hours and being overruled by a menu that printed
   * "$0" next to it.
   */
  opportunityCost(cart: CartFacts): number;
  eligible(cart: CartFacts): Eligibility;
}

const alwaysEligible = (): Eligibility => ({ ok: true });

/** One step DOWN the ladder, or null at the bottom. */
export function tierBelow(section: string): string | null {
  const i = SECTION_LADDER.indexOf(section as (typeof SECTION_LADDER)[number]);
  return i > 0 ? SECTION_LADDER[i - 1] : null;
}

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
      "Send this fan nothing at all.",
    tier: "none",
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
    tier: "free",
    cashCost: () => 0,
    opportunityCost: () => 0,
    eligible: alwaysEligible,
  },
  {
    id: "upgrade_one_tier",
    kind: "upgrade",
    label: "Free seat upgrade",
    description:
      "Move them up a section at the price they already had in the cart — the fan is told exactly which section, by name. Takes no cash at the till, but the price shown is real: it hands over a better seat and takes back a cheaper one. Reads as being looked after rather than marked down, which is worth something — but it is usually the dearest thing on this menu, so it needs to beat the alternatives on the figure, not on the feeling.",
    tier: "paid",
    cashCost: () => 0,
    opportunityCost: (c) => {
      const target = upgradeTarget(c.section);
      if (!target) return 0;
      // The seat handed over is priced from the section; the seat freed up is
      // priced from THIS cart, since value over seats is exactly what this fan
      // was going to pay. The gap between them is the cost, per seat.
      const paidPerSeat = c.cart_value_usd / c.seats;
      return round2(Math.max(0, SECTION_PRICE[target] - paidPerSeat) * c.seats);
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
      "Real money off, for a fan who has bought before and stopped. There is a track record here — they know what a ticket is worth and they chose not to buy this time — so the smaller lever is the right first test of whether price is what's in the way.",
    tier: "paid",
    cashCost: (c) => round2(c.cart_value_usd * 0.1),
    opportunityCost: () => 0,
    eligible: (c) =>
      c.lifetime_tickets > 0
        ? { ok: true }
        : { ok: false, why: "This fan has never bought a ticket — a first purchase is priced as acquisition, not as a discount on this cart." },
  },
  {
    id: "discount_15",
    kind: "discount",
    label: "15% off the cart",
    description:
      "The deepest offer, and it is reserved for a fan who has never bought anything. Nothing here is being spent on this cart: a first purchase is the club buying a supporter it has no evidence about and no cheaper way to price. Never for someone with a history — they have already shown you what they do.",
    tier: "paid",
    cashCost: (c) => round2(c.cart_value_usd * 0.15),
    opportunityCost: () => 0,
    eligible: (c) =>
      c.lifetime_tickets === 0
        ? { ok: true }
        : { ok: false, why: `This fan has bought ${c.lifetime_tickets} time${c.lifetime_tickets === 1 ? "" : "s"} before — there is a history to read, so the smaller discount is the right first test.` },
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
  return offer.label;
}

/**
 * The offers available to this cart in one tier, cheapest first.
 *
 * Sorting is the whole point. "Take the cheapest tool that could plausibly
 * work" used to be a sentence in a prompt that the agents had to be trusted to
 * follow; now the menu they're handed arrives in that order with the price on
 * every line, so choosing the dearest one is a visible act they have to justify
 * rather than an accident.
 */
export function menuFor(cart: CartFacts, tier: "free" | "paid"): CatalogEntry[] {
  return CATALOG.filter((o) => o.tier === tier && o.eligible(cart).ok).sort(
    (a, b) => totalCost(a, cart) - totalCost(b, cart),
  );
}

/** The cheapest offer that costs money — the default any dearer choice is measured against. */
export function cheapestPaid(cart: CartFacts): CatalogEntry | undefined {
  return menuFor(cart, "paid")[0];
}
