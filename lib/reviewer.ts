import {
  ReviewSchema,
  VERDICT_DEFINITIONS,
  type CartFacts,
  type FanRead,
  type Review,
} from "./schema.ts";
import { describeOffer, eligibleOffers, getOffer, totalCost } from "./catalog.ts";
import {
  LOYAL_RECENCY_DAYS,
  LOYAL_TICKETS,
  MAX_STRENGTH_BY_RETURN_LIKELIHOOD,
  affordable,
} from "./policy.ts";
import { runAgent, ESCALATION_MODEL, type AgentResult } from "./agent.ts";

/**
 * Stage 3 — an independent second opinion, deliberately kept in the dark.
 *
 * The reviewer sees the analyst's read, the offer that was picked, and what it
 * costs. It does NOT see the strategist's reason for picking it. That's the
 * whole point: a fluent justification is exactly what a rationalising agent
 * produces, and a reviewer shown the argument tends to grade the argument.
 * Withholding it means the only thing it can do is work out for itself whether
 * these facts justify an offer this strong.
 *
 * It runs on the cheap model by default and escalates when real cash is at
 * stake — capability where the money is, rather than uniformly.
 */

export function buildReviewerSystemPrompt(): string {
  return `You are the last check before a marketer at the Seattle Seawolves sees a proposed win-back offer. The club is small, its fan base is small, and a tone-deaf offer to a loyal supporter costs more than sending nothing at all. Your job is to find what is wrong with what you are given, and to say which of the three things is wrong: the amount, the direction, or the whole idea of making contact.

You are shown what the analyst found about the fan, and the offer someone proposed. **You are not shown why they proposed it.** That is on purpose — a confident explanation is the easiest thing in the world to produce, and you are here to decide from the facts, not to grade an argument.

An offer can be wrong in two directions and you are responsible for both. Too generous spends money on a fan who was coming back anyway. Too thin burns the one message this fan will read and gives them no reason to act — a bare reminder to someone who has been gone a year is not caution, it is a wasted touch.

## What these cost

Every figure you are shown is money the club does not get, and they compare directly. A discount is margin off the top. An upgrade costs nothing at the till but hands over a seat someone else would probably have bought, and the figure shown is that expected revenue net of the cheaper seat it frees. "No cash" is not the same as "no cost" — a seat is worthless the moment the match starts, so giving one away is as real as discounting.

## The rule you are enforcing

How strong an offer can be tracks one thing: how unlikely the fan was to come back on their own. Not the size of the cart, not how loyal they are.

So the questions are:
- If we sent this fan nothing at all, would they have finished the cart anyway? If probably yes, then anything with a cost attached is money burned, and the verdict is veto.
- Is this the weakest tool that plausibly works? If something smaller would do, adjust to it and name it. Weak and cheap are different axes — strength is what it teaches the fan, cost is the dollars — so check you aren't recommending something weaker that costs more. Waiving fees on a large party costs more than a deep discount on the same cart.
- Is it enough to work at all? If the fan has no reason to return and the proposal is a nudge with nothing behind it, adjust upward and name what should go instead.
- Does this insult anyone? A fan with ${LOYAL_TICKETS}+ tickets who bought inside ${LOYAL_RECENCY_DAYS} days is the club's core. Marking their tickets down is both wasted margin and a strange message to send someone who already shows up.

## Two mistakes to avoid making yourself

**"Unproven" is not a reason to spend less.** A fan with no purchase history is not a bad bet — they are the one fan on the page you have *no evidence about*, and no evidence they return without us is exactly the condition that justifies a real offer. A club this size grows by winning first purchases. If your objection amounts to "they haven't earned it yet", you are applying a different rule than the one above.

**Read the price line before you talk about margin.** An upgrade costs the club no cash at all — it spends a seat that was probably going unsold. Objecting to an upgrade on the grounds that it burns margin is a factual error, not a judgement. Cash is cash; seats are not.

Two different things are being measured and they do not move together. "Smaller" and "larger" below describe how generous an offer *reads to the fan* — how likely it is to teach them that walking away pays. The cash figure is what it *costs the club*. A smaller-reading offer can easily cost more money: waiving fees on four seats costs real dollars, and moving two fans into empty better seats costs none. Each alternative below shows both, so check the cash line before you economise, or you will trade down into something more expensive.

## Verdicts

${Object.entries(VERDICT_DEFINITIONS)
  .map(([k, v]) => `- ${k}: ${v}`)
  .join("\n")}

**Veto means silence.** Use it only when the right answer is that this fan hears nothing from us today — because they were coming back anyway, or because any contact would be wrong. If your objection is that *this particular offer* is wrong and a different one would be right, that is an adjust, and you must name the replacement. Vetoing something that merely needed changing throws away a fan we should have reached.

Approving is a real verdict, not a failure of nerve. If the read genuinely says this fan was not coming back and the offer is proportionate, say so plainly and let it through.

## Your objection

The marketer reads this, not a log. Say what you saw in the facts. If you're vetoing, say what the proposal appears to have mistaken. **Two or three sentences** — it sits on a card next to the offer, and a paragraph there goes unread.

Call the review_offer tool exactly once.`;
}

export function buildReviewerUserPrompt(
  cart: CartFacts,
  read: FanRead,
  offerId: string,
): string {
  const offer = getOffer(offerId);
  const ceiling = MAX_STRENGTH_BY_RETURN_LIKELIHOOD[read.return_likelihood];
  // The whole menu they could have picked, not just the cheaper half — the
  // reviewer has to be able to say "this is too thin" as well as "too much".
  const alternatives = eligibleOffers(cart)
    .filter(
      (o) =>
        o.strength <= ceiling && o.id !== offerId && affordable(o.cashCost(cart)),
    )
    .map((o) => {
      const price = `$${totalCost(o, cart).toFixed(2)}`;
      const dir = o.strength < (offer?.strength ?? 99) ? "reads smaller" : "reads larger";
      const delta = totalCost(o, cart) - (offer ? totalCost(offer, cart) : 0);
      const cashNote =
        Math.abs(delta) < 0.005
          ? "same cost"
          : delta > 0
            ? `costs $${delta.toFixed(2)} MORE`
            : `costs $${Math.abs(delta).toFixed(2)} less`;
      return `  - ${o.id} — ${describeOffer(o.id, cart)} (${price}; ${dir}, ${cashNote})`;
    })
    .join("\n");

  const cost = offer ? totalCost(offer, cart) : 0;
  const price = cost === 0 ? "nothing" : `$${cost.toFixed(2)}`;

  const flags = read.risk_flags.length
    ? read.risk_flags.map((f) => `  - ${f}`).join("\n")
    : "  (none)";

  const described = describeOffer(offerId, cart);

  return `What the analyst found:

  Segment: ${read.segment}
  Chance they finish this cart with no contact from us: ${read.return_likelihood}
  Evidence: ${read.evidence}
  Risk flags:
${flags}

The fan's history: ${cart.lifetime_tickets} lifetime tickets, last purchase ${
    cart.last_purchase_days_ago === null ? "never" : `${cart.last_purchase_days_ago} days ago`
  }.
The cart: ${cart.seats} seat${cart.seats === 1 ? "" : "s"} in ${cart.section}, $${cart.cart_value_usd.toFixed(2)}, abandoned ${cart.abandoned_hours_ago} hours ago.

Proposed: **${described}**
Costs the club: ${price}

${alternatives ? `Everything else available for this cart, at this read:\n${alternatives}` : "There is nothing else available for this cart."}

Should this reach the fan?`;
}

export async function reviewOffer(
  cart: CartFacts,
  read: FanRead,
  offerId: string,
  escalate: boolean,
): Promise<AgentResult<Review>> {
  return runAgent({
    name: "reviewer",
    toolName: "review_offer",
    toolDescription:
      "Decide whether this offer should reach the fan. Veto if the fan was returning anyway; adjust to a named replacement if the proposal is either too generous or too thin to work.",
    system: buildReviewerSystemPrompt(),
    user: buildReviewerUserPrompt(cart, read, offerId),
    schema: ReviewSchema,
    model: escalate ? (process.env.REVIEWER_ESCALATION_MODEL ?? ESCALATION_MODEL) : undefined,
  });
}
