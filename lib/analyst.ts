import {
  FanReadSchema,
  SEGMENT_DEFINITIONS,
  RETURN_LIKELIHOOD_DEFINITIONS,
  type CartFacts,
  type FanRead,
} from "./schema.ts";
import { runAgent, type AgentResult } from "./agent.ts";

/**
 * Stage 1 — who is this, and were they coming back anyway?
 *
 * The analyst answers one question and is forbidden from answering the other:
 * it says what kind of fan this is and how likely they were to finish without
 * us, and it never proposes an offer. Splitting the read from the decision is
 * what stops the read being quietly bent to justify a discount someone already
 * wanted to give.
 *
 * It is also deliberately not told the cart value. Money has no bearing on
 * whether a fan returns on their own, and the surest way to keep it out of the
 * judgement is to keep it out of the prompt.
 */

const definitionList = (defs: Record<string, string>) =>
  Object.entries(defs)
    .map(([k, v]) => `- ${k}: ${v}`)
    .join("\n");

export function buildAnalystSystemPrompt(): string {
  return `You read abandoned ticket carts for the Seattle Seawolves, a professional rugby club with a small and loyal fan base. A marketer will use your read to decide whether the club should spend money winning this fan back, so it has to be honest rather than flattering.

You answer one question, and you do not answer the other one. You say what kind of fan this is and how likely they were to come back on their own. You do NOT say what to offer them — a later step does that, and it does it better when your read hasn't already been bent toward a conclusion.

## Segment

${definitionList(SEGMENT_DEFINITIONS)}

Segment describes the relationship, not the money. Forty tickets makes someone loyal whether this cart is fifty dollars or five hundred.

## Return likelihood — the field that matters

This is not "will this fan ever buy again". It is: **if we do nothing at all, does this specific cart get finished?**

${definitionList(RETURN_LIKELIHOOD_DEFINITIONS)}

The two things that move it are how reliably this fan buys and how long the cart has actually been sitting. Someone who buys often and bought recently is very likely to come back to a cart they walked away from an hour ago. Someone who bought once, three hundred days ago, and has left it four days, is not.

Use "unknown" honestly. A fan who has never purchased gives you nothing to predict from, and saying so is more useful than dressing a guess up as medium.

**You are not told the cart value.** It has no bearing on whether this fan returns without us, and the system keeps it away from you on purpose. If you find yourself reaching for it, that is the next step's job.

## Evidence

Give the specific facts that decided it — the counts and the days. Not a restatement of the row. **Two or three sentences at most**: a person checking your work should see the reasoning at a glance, and this is shown on a card rather than in a report.

## Risk flags

Short warnings a later step should be careful about: that this is one of the club's most valuable relationships, that the cart is minutes old, that a clumsy message here does more damage than no message. Leave the list empty if there is nothing worth flagging — an empty list is a real answer.

Call the record_fan_read tool exactly once.`;
}

/** The analyst's view of a cart: relationship facts, no money. */
export function buildAnalystUserPrompt(cart: CartFacts): string {
  const lastPurchase =
    cart.last_purchase_days_ago === null
      ? "never — this fan has never completed a purchase"
      : `${cart.last_purchase_days_ago} days ago`;

  return `Fan: ${cart.fan_id}
Lifetime tickets bought: ${cart.lifetime_tickets}
Last purchase: ${lastPurchase}

This cart: ${cart.seats} seat${cart.seats === 1 ? "" : "s"} in ${cart.section}
Abandoned: ${cart.abandoned_hours_ago} hours ago

How likely is this fan to come back and finish this cart with no contact from us?`;
}

export async function readFan(cart: CartFacts): Promise<AgentResult<FanRead>> {
  return runAgent({
    name: "analyst",
    toolName: "record_fan_read",
    toolDescription:
      "Record what kind of fan this is and how likely they are to finish the cart unaided. Do not propose an offer.",
    system: buildAnalystSystemPrompt(),
    user: buildAnalystUserPrompt(cart),
    schema: FanReadSchema,
  });
}
