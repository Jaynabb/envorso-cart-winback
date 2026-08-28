import { z } from "zod";

/**
 * The contracts between stages.
 *
 * Each stage consumes the PREVIOUS stage's typed output, never the raw cart.
 * That's what makes the handoffs real rather than three prompts sharing a
 * variable: the strategist cannot see the raw row, so it cannot re-derive its
 * own view of the fan, and the reviewer cannot see the strategist's reasoning,
 * so it cannot inherit it.
 *
 *   CartFacts ─▶ FanRead ─▶ OfferProposal ─▶ ReviewedOffer
 */

/* ---------- the input ---------------------------------------------- */

export const CartFactsSchema = z.object({
  cart_id: z.string(),
  fan_id: z.string(),
  seats: z.number().int().positive(),
  section: z.string(),
  cart_value_usd: z.number().nonnegative(),
  abandoned_hours_ago: z.number().nonnegative(),
  lifetime_tickets: z.number().int().nonnegative(),
  /** Null means never purchased — a real absence, not a zero. */
  last_purchase_days_ago: z.number().int().nonnegative().nullable(),
  email_opt_in: z.boolean(),
});
export type CartFacts = z.infer<typeof CartFactsSchema>;

/* ---------- stage 1: the analyst's read ----------------------------- */

/**
 * Segments describe the RELATIONSHIP, not the money. A fan who has bought forty
 * tickets is loyal whether this cart is $50 or $500, and the cart value has no
 * business in this field.
 */
export const SEGMENTS = ["first_timer", "past_buyer", "loyal"] as const;
export type Segment = (typeof SEGMENTS)[number];

/**
 * Three, and the split is the one that matters to the club's money.
 *
 * There used to be four — "occasional" and "lapsed" as well — and neither
 * changed a single decision. What sets the discount is whether this fan has
 * ever bought a ticket, so that is the line the labels are drawn on. A badge
 * that sorts fans into buckets nothing acts on is a badge that teaches a
 * marketer to read meaning into a colour.
 *
 * "loyal" survives despite not changing the offer either, because it is the
 * one the milestone speaks to and the one a marketer needs to see before they
 * approve anything: this is a fan the club cannot afford to be clumsy with.
 */
export const SEGMENT_DEFINITIONS: Record<Segment, string> = {
  first_timer: "Has never completed a purchase. No history to predict anything from, and the club is buying a supporter rather than discounting a cart.",
  past_buyer: "Has bought at least one ticket before, whenever that was. They know what a seat costs and chose not to buy this time.",
  loyal: "A past buyer who buys regularly — ten or more tickets — and bought recently. The club's core, and the one relationship a clumsy message actually costs something.",
};

/**
 * The single most important field in the system.
 *
 * Not "how likely is this fan to buy" — how likely they are to come back and
 * finish this cart WITH NO CONTACT FROM US. Every downstream decision keys off
 * it, because an offer to someone who was returning anyway is money spent on a
 * sale we already had.
 */
export const RETURN_LIKELIHOODS = ["high", "medium", "low", "unknown"] as const;
export type ReturnLikelihood = (typeof RETURN_LIKELIHOODS)[number];

export const RETURN_LIKELIHOOD_DEFINITIONS: Record<ReturnLikelihood, string> = {
  high: "Would very likely finish this on their own. A regular buyer who just walked away from the screen.",
  medium: "Might come back, might not. Some history, but nothing that says they reliably return.",
  low: "Unlikely to come back unprompted. The relationship has gone quiet or the cart is long cold.",
  unknown: "No history to judge from at all. Treat as low, but say so honestly rather than guessing.",
};

export const FanReadSchema = z.object({
  segment: z.enum(SEGMENTS),
  return_likelihood: z.enum(RETURN_LIKELIHOODS),
  /** The specific facts that decided it. Not a restatement of the row. */
  evidence: z.string().min(1).max(400),
  /**
   * Things that should make anyone downstream careful — "highest-value fan in
   * the set", "abandoned minutes ago", "one bad experience from churning".
   */
  risk_flags: z.array(z.string().max(120)).max(4),
});
export type FanRead = z.infer<typeof FanReadSchema>;

/* ---------- stage 2: the strategist's proposal ---------------------- */

/**
 * `no_offer` is a first-class outcome, listed first on purpose. An agent asked
 * to propose offers will propose offers; making the null decision a normal
 * value in the same enum — rather than an exception path — is the cheapest
 * structural defence against that.
 */
export const OfferProposalSchema = z.object({
  offer_id: z.string().min(1),
  /** Why THIS offer for THIS read. Must reference the read, not the cart value. */
  reason: z.string().min(1).max(400),
  /** What the strategist believes it costs. Recomputed from the catalog, never trusted. */
  claimed_cost_usd: z.number().nonnegative(),
});
export type OfferProposal = z.infer<typeof OfferProposalSchema>;

/* ---------- stage 3: the reviewer's verdict ------------------------- */

export const VERDICTS = ["approve", "adjust", "veto"] as const;
export type Verdict = (typeof VERDICTS)[number];

/**
 * `adjust` goes both ways on purpose.
 *
 * The first version of this had "downgrade", which quietly assumed the only way
 * an offer can be wrong is being too generous. The reviewer found the other
 * kind on its first run — a reminder sent to a fan who has been gone 300 days,
 * which it called "splitting the difference and creating contact noise" — and
 * had nowhere to put that judgement, so a correct read came out as a hold.
 * Under-spending is quieter than over-spending and it is still a failure: it
 * uses up the one message this fan will read and gives them no reason to act.
 */
export const VERDICT_DEFINITIONS: Record<Verdict, string> = {
  approve: "The offer fits the read. Send it to the marketer as proposed.",
  adjust:
    "The right move is a different offer — smaller if this spends money on someone who was coming back anyway, larger if it's too thin to move a fan who has no reason to return. Name the replacement.",
  veto:
    "Silence is the right answer — this fan should get no message at all today. Not for use when a DIFFERENT offer would be right; that is an adjust.",
};

export const ReviewSchema = z.object({
  verdict: z.enum(VERDICTS),
  /** Written for the marketer, not for a log. Says what the reviewer saw. */
  objection: z.string().min(1).max(400),
  /** Required when adjusting — the catalog id to use instead. */
  replacement_offer_id: z.string().nullable(),
});
export type Review = z.infer<typeof ReviewSchema>;

/* ---------- the settled outcome for one cart ------------------------ */

/**
 * What the marketer sees. `blocked` never reached a model at all; `hold` was
 * stopped by the gate or vetoed by the reviewer; `offer` survived every stage.
 */
export const OUTCOMES = ["offer", "hold", "blocked"] as const;
export type Outcome = (typeof OUTCOMES)[number];

export const DecisionSchema = z.object({
  cart_id: z.string(),
  outcome: z.enum(OUTCOMES),
  /** One line, for the row. The chain below carries the detail. */
  headline: z.string(),
  /** Present only when the outcome is an offer. */
  offer_id: z.string().nullable(),
  cost_usd: z.number().nonnegative().nullable(),
  /** The audit trail. Null at any stage the cart never reached. */
  read: FanReadSchema.nullable(),
  proposal: OfferProposalSchema.nullable(),
  review: ReviewSchema.nullable(),
  /** Set when the deterministic gate stopped it, before any model ran. */
  gate_reason: z.string().nullable(),
  /**
   * Something the marketer might want to do that this system can't do for them.
   *
   * The headline says what was decided. This says what's worth knowing anyway —
   * chiefly that holding a loyal fan leaves a blank, and a blank next to a
   * first-timer's 15% is how a six-year season-ticket holder ends up hearing
   * that a stranger got a better deal than them.
   */
  operator_note: z.string().nullable(),
  /** Invariant violations found after the fact. Empty is the healthy case. */
  violations: z.array(z.string()),
});
export type Decision = z.infer<typeof DecisionSchema>;
