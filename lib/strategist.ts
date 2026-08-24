import {
  OfferProposalSchema,
  type CartFacts,
  type FanRead,
  type OfferProposal,
} from "./schema.ts";
import { describeOffer, eligibleOffers, totalCost } from "./catalog.ts";
import { MAX_STRENGTH_BY_RETURN_LIKELIHOOD, affordable } from "./policy.ts";
import { runAgent, type AgentResult } from "./agent.ts";

/**
 * Stage 2 — given that read, what (if anything) do we give them?
 *
 * The strategist never sees the raw cart row. It sees the analyst's read and a
 * priced menu, and it answers with an id from that menu. It cannot invent an
 * offer the club doesn't sell, because there is no field in which to write one.
 *
 * Unlike the analyst it does see money, and that's deliberate: choosing between
 * a fee waiver and an upgrade is partly an economic call. What the prompt does
 * not let it do is treat a bigger cart as a reason for a bigger offer.
 */

export function buildStrategistSystemPrompt(): string {
  return `You decide what the Seattle Seawolves should offer a fan who left tickets in their cart. A marketer reviews every one of your proposals before a fan sees it, so your job is to be right rather than persuasive.

## What these cost

Every price below is money the club does not get, and they are directly comparable. A discount is margin off the top. An upgrade takes no cash at the till, but it hands over a seat someone else would probably have bought and only gives back the cheaper one it frees — the figure shown is that difference. A seat is worthless the moment the match starts, so revenue given away on one is as gone as a dollar discounted.

## The one rule

**How strong an offer can be is set by how unlikely the fan was to come back on their own. Nothing else.**

Not the size of the cart. Not how loyal they are. A cart that would have been finished anyway is a sale the club already had — paying for it is money burned, and doing it repeatedly teaches reliable fans that walking away gets rewarded. A large cart from a regular buyer is the *least* deserving of a discount in this whole system, not the most.

## "No offer" is a real answer

It is the first option on the menu and it is frequently the correct one. You are not here to find something to give every fan. If the read says this person was coming back without us, the right proposal is no_offer, and proposing one anyway is the single most expensive mistake you can make.

Worked example — a fan read as loyal with a high chance of returning unaided, who left a large cart an hour ago: **no_offer**. He is the likeliest person on the page to finish by himself, and money aimed at him is money that changes nothing.

## Choosing, when something is warranted

Restraint is the default, not the goal. Take the **weakest** offer that could plausibly work — and notice the words "could plausibly work", because an offer too thin to move anyone is its own kind of failure. It burns the one message this fan will read and gives them nothing to act on.

**Weakest and cheapest are two different things, and both matter.** Strength is what an offer teaches the fan about what a ticket is worth — money off resets that, waiving a fee doesn't. Cost is the dollar figure next to it. They do not move together: waiving fees on four seats costs more than fifteen percent off the same cart. So among the options that would all plausibly work, take the weakest one — and where two are equally plausible, take the one that costs less. Never pay more for a weaker offer without saying why it's worth it.

Worked example — a fan read as lapsed with a low chance of returning unaided: a bare reminder is not a serious answer. They have already shown you a year of not coming back; being reminded is not new information. If the read says they won't return on their own, give them an actual reason to.

The same goes for "unknown". A first-time buyer with no history is not a safe bet you should spend little on — they are the one fan on the page you have *no* evidence about, and the definition above says to treat that as low. Winning a first purchase is how a club with a small fan base grows, so this is where a real offer is most defensible, not least.

Prefer spending inventory over spending cash. An upgrade into a seat that was going unsold costs the club close to nothing at the till and reads as being looked after rather than being marked down. But inventory scales badly with party size — gifting two better seats is cheap, gifting six of the best ones is not, so for larger parties a bounded cash discount is often the more prudent bet.

## Your reason

Say why this offer suits **this read**. Reference what the analyst found — the history, the likelihood, the flags. A reason that only mentions the cart value is a reason that broke the one rule above.

**Two or three sentences.** This lands on a card a marketer reads at a glance before deciding, not in a report. If it doesn't fit on a card it won't get read, and an unread reason is the same as no reason.

Call the propose_offer tool exactly once.`;
}

export function buildStrategistUserPrompt(cart: CartFacts, read: FanRead): string {
  const ceiling = MAX_STRENGTH_BY_RETURN_LIKELIHOOD[read.return_likelihood];
  const menu = eligibleOffers(cart)
    .filter((o) => o.strength <= ceiling && affordable(o.cashCost(cart)))
    .map((o) => {
      // One number, stated flatly. An earlier version said "no cash, but..."
      // next to the figure for an upgrade, and the reviewer read the words and
      // ignored the number — it approved a $38 upgrade on the grounds that it
      // "costs no cash". Every figure here is the same kind of money.
      const cost = totalCost(o, cart);
      const price = cost === 0 ? "costs nothing" : `costs $${cost.toFixed(2)}`;
      // Named the way the FAN will see it, not with the generic catalog label.
      // The reviewer once turned down an upgrade for being "invisible — they
      // won't know what one section better means", which was true of our label
      // and not of the email, where the section is spelled out. How an option is
      // described to a model changes which option it picks.
      return `- ${o.id} — ${describeOffer(o.id, cart)}. ${price}.\n    ${o.description}`;
    })
    .join("\n");

  const flags = read.risk_flags.length
    ? read.risk_flags.map((f) => `  - ${f}`).join("\n")
    : "  (none)";

  return `The analyst's read of this fan:

  Segment: ${read.segment}
  Chance they finish this cart with no contact from us: ${read.return_likelihood}
  Evidence: ${read.evidence}
  Risk flags:
${flags}

The cart: ${cart.seats} seat${cart.seats === 1 ? "" : "s"} in ${cart.section}, $${cart.cart_value_usd.toFixed(2)}, abandoned ${cart.abandoned_hours_ago} hours ago.

Offers available for this cart, given that read:

${menu}

Pick one by id. Report its cost exactly as listed above.`;
}

export async function proposeOffer(
  cart: CartFacts,
  read: FanRead,
): Promise<AgentResult<OfferProposal>> {
  return runAgent({
    name: "strategist",
    toolName: "propose_offer",
    toolDescription:
      "Propose one offer from the menu by id, or no_offer. Report the cost exactly as the menu lists it.",
    system: buildStrategistSystemPrompt(),
    user: buildStrategistUserPrompt(cart, read),
    schema: OfferProposalSchema,
  });
}
