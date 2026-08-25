# Cart Win-Back Agent — Envorso Sports

An agentic system that reads stale ticket carts for the Seattle Seawolves, decides
which are worth acting on, and proposes a specific offer for a marketer to approve,
edit or reject. Nothing reaches a fan without a person saying yes.

**Run it:**

```bash
npm install
cp .env.example .env.local     # add your ANTHROPIC_API_KEY
npm run dev                    # http://localhost:3000
```

Needs Node 22.18+. Two checks from the command line:

```bash
node --env-file=.env.local scripts/run.mts    # the agents, in the terminal
node --env-file=.env.local scripts/eval.mts   # score them against the answer key
```

---

## How it works

Four stages. Three of them are agents, and the first one isn't a model at all.

```
cart ─▶ [0] POLICY ─▶ [1] ANALYST ─▶ [2] STRATEGIST ─▶ [3] REVIEWER ─▶ marketer
        rules, no AI   what kind      what to offer     try to reject   approve
        no cost        of fan is      from a fixed      it, from the    edit or
                       this?          menu             facts alone     reject
```

Each stage is handed the **previous stage's typed output**, not the raw cart, and each
is deliberately kept in the dark about something.

**[0] Policy — `lib/policy.ts`, no model involved.** Consent, timing, suppression, and
the per-cart spend ceiling. You shouldn't need a language model to notice you don't have
permission to email someone. `C-1003` is stopped here and never reaches an agent.

Timing isn't a block, it's a ceiling on what contact may cost: under 2 hours nothing at
all, because they may still be at the checkout; between 2 and 24 hours a free reminder
and nothing dearer; after that, real offers are available.

**[1] Analyst — `lib/analyst.ts`.** Says what kind of fan this is and how likely they
were to come back with no contact from us. It is forbidden from proposing an offer, and
**it is never shown the cart value** — money can't tell you whether someone returns, so
it isn't given any. Separating the read from the decision is what stops the read being
quietly bent to justify a discount.

**[2] Strategist — `lib/strategist.ts`.** Picks from a closed catalog by ID. It works
from the analyst's read, not the raw row, so it can't re-derive a more convenient view
of the fan. It can't invent an offer the club doesn't sell, because there's no field to
write one in.

**[3] Reviewer — `lib/reviewer.ts`.** Tries to find what's wrong with the proposal, and
**never sees the strategist's reasoning** — only the facts and the offer. A fluent
justification is the easiest thing in the world for a model to produce, and a reviewer
shown the argument ends up grading the argument. Blind, the only thing it can do is
work out for itself whether these facts justify this offer.

**[4] The marketer.** Nothing sends itself.

### How this design fails, and what catches it

**The strategist rationalises.** Hand it a read saying "this fan is coming back anyway"
and it will still propose 15% off, with a confident, plausible reason — because it
believes its job is to produce offers. Valid output, good prose, wrong answer. This is
the failure that looks right, and it happened on the first run.

Four things catch it, cheapest first:

1. `no_offer` is a first-class value in the same enum as every other offer, demonstrated
   in the prompt — not an exception path.
2. The reviewer only ever sees the analyst's read, so it can't inherit the strategist's
   reasoning.
3. **A deterministic check**: how strong an offer is may not exceed what the read allows,
   and may not fall below what's worth sending. That's arithmetic, so it holds however
   good the prose was.
4. The hand-written answer key catches drift between runs.

**And when the agent is wrong anyway,** the marketer edits or rejects it on the card,
with the whole chain visible behind *"How it got here."* Every edit and reject is a
label — see Section B.

**It fails closed.** If any stage errors or returns something invalid, the cart holds.
There is no path through this system where something breaking produces an offer.

---

## Section A — Written analysis

### Which carts deserve an offer

"How do we win this cart back?" is a trap, because the easiest carts to win back are
the ones that were coming back anyway — and you can't tell from the outcome. You send a
discount, the fan buys, the dashboard says it worked, and you paid for a sale you
already had.

So the system asks: **would this fan have come back on their own?** How strong an offer
can be tracks how *unlikely* that is. Never the size of the cart, never how loyal they
are.

**How recently they left caps the cost, not the contact.** Under two hours, nothing —
they may still be at the checkout. Two to 24 hours, a free reminder and no money. After
that, real offers.

On the five sample carts:

| cart | | decision |
|---|---|---|
| `C-1004` | $540 Club, 40 tickets, left **1 hour ago** | **hold** |
| `C-1001` | 14 tickets, bought 21 days ago, left 3 hours ago | **reminder, free** |
| `C-1002` | never purchased, 4 seats, 26 hours | **15% off, $21** |
| `C-1005` | one ticket 300 days ago, cold 4 days | **10% off, $7** |
| `C-1003` | no email opt-in | **blocked** |

`C-1004` is the trap: the biggest number on the page, and a fan with forty tickets who
bought nine days ago and walked away an hour ago is the likeliest person here to finish
by himself. `C-1003` never reaches a model at all — no consent, no channel, no decision
to make.

### The offer logic

Offers come from a closed catalog — no offer, reminder, fee waiver, seat upgrade, 10%,
15% — and the agent returns an ID from it. It cannot invent an offer the club doesn't
sell, because there is no field to write one in.

The rule is: take the **weakest** offer that could plausibly work, and where two are
equally plausible, the cheaper one. Strength is what an offer teaches a fan about what
a ticket is worth. Cost is dollars. They do not move together.

Pricing every offer honestly changed the answers. A "free" upgrade is not free — it
hands over a seat someone else would probably have bought and only gives back the
cheaper one it frees. On `C-1005` that is **$36 against $7** for a 10% discount: half
the cart, to save the cart. Nothing may exceed a fifth of the cart it is rescuing.

### What I would not do yet

**No sending.** The agent proposes; the marketer copies ready-made email and SMS text.
There is no CRM, and a sender would be the least valuable thing in the sprint.

**No spend budget.** I built one and cut it. Every offer is approved individually with
its price on the card, so nobody can overspend by accident — the cap guarded a failure
mode the approval gate already prevents. First thing to add if this ever sends without
a person in front of it.

**No personalisation past the segment**, no multi-team abstraction, no self-serve rule
editing. One club, one marketer, one screen.

---

## Section B — Agent quality and failure plan

### How I would know the offers are actually good

**Four checks, and only two of them scale.**

**1. An answer key, written before the model ran.** I decided what each of the five
carts deserved, and why, before an agent saw the data — so my judgement is the
benchmark and the agent is graded against it, rather than me reading its output and
talking myself into agreeing. `scripts/eval.mts` scores decision, offer, and the
read of return-likelihood. It currently scores 100% on all four lines. It needs labels,
so it does not scale past carts I sat down and reasoned about.

**2. Invariants, which need no labels.** Rules checkable with arithmetic on any day's
carts: consent is never violated, nothing at all goes out under two hours and nothing
that costs money under 24, the offer exists in the catalog, no offer exceeds a fifth of
its cart, the cost the model claimed matches what the catalog computes, and offer
strength stays inside both the ceiling and the floor. These are what would actually run every morning. Sixty
generated carts pass them.

**3. A 10% holdout — the only honest measure of whether this works at all.**
Redemption rate is a vanity metric: it counts fans who were coming back anyway. So a
tenth of qualified carts deliberately get nothing, and the difference between the two
groups is what the offers actually rescued. Assignment is a hash of the fan ID, so a
fan is always on the same side — a fan who flips groups is in neither.

**4. The marketer's clicks, which are free labels.** Every approve, edit and reject is
a judgement on the agent. Edit rate per offer type is the daily health metric: if
marketers rewrite 40% of upgrades, the upgrade rule is wrong. No platform required, and
it is the one signal a single engineer can actually maintain.

### What it costs, and where the capability goes

| stage | model | why |
|---|---|---|
| Policy | none | consent and arithmetic don't need a model |
| Analyst, strategist | Haiku 4.5, `temperature: 0` | classification against a tight schema is what a small fast model is for |
| Reviewer | Haiku, **escalating to Sonnet** when the offer is a cash discount or costs over $15 | pay for the better model where money actually leaves the building |

Measured, not estimated: **about 3 cents for the five sample carts, 34 cents for sixty
— roughly half a cent a cart.** At the Seawolves' volume this is not a number anyone
needs to manage, which is itself the point: the expensive decision here is the offer,
not the inference.

The escalation rule is the trade-off. Reviewing a reminder with a frontier model is
paying more to check something that costs nothing. Reviewing a 15% discount is worth it,
because that's the call that ends up on someone's card statement. Same reason the policy
gate isn't an agent — an LLM asked to enforce a consent rule will enforce it *almost*
every time, and "almost" isn't a standard you put in front of a fan.

### What could make it produce a bad offer without me noticing

**An agent inventing its own rule, fluently.** This happened. The reviewer started
arguing, twice, that the club shouldn't spend on fans who "haven't converted once" —
prudent-sounding, confident, and the opposite of the rule the system runs on. Nothing in
the output looked wrong. Under my rule, a fan with no history is precisely the case where
an offer is justified, because there is no evidence they return without one.

**An agent reasoning correctly over numbers I made up.** This is the one that actually
cost money, and it is subtler. My cost model reported a seat upgrade as "$0 cash", so
the agent handed them out — and at 60 carts it was a third over any sensible budget.
The reviewer had been telling me for hours that "a small discount costs less than the
inventory required." It was right. I had overruled it by printing `$0` in the menu it
reads. Every disagreement the agent had with my answer key traced back to a price I
had invented; once the prices were real, agreement went from 0% to 100%.

**The wording of my own prompt changing the decision.** Three times. The reviewer
rejected an upgrade as "invisible — they won't know what one section better means",
which was true of my internal label and false of the email a fan actually gets. It
read "no cash, but…" next to a $38 figure and approved it on the grounds that it cost
no cash. And "cheapest tool" was ambiguous once prices were honest, because waiving
fees on four seats costs more than 15% off the same cart. **The prompt is not
documentation of the system. It is an input to it.**

### How that gets caught before it reaches a fan

**A person approves every single offer**, with the price and the reasoning chain on the
card. That is the hard gate, and it is why there is no spend cap: nothing goes out
unread.

**The reviewer never sees the strategist's reasoning** — only the facts and the offer.
A fluent justification is exactly what a rationalising agent produces, and a reviewer
shown the argument grades the argument. Blind, the only thing it can do is work out for
itself whether these facts justify this offer.

**Every invariant has an enforcement point.** This was a real lesson: the per-cart cap
was *detected* for three runs while the pipeline cheerfully let the offer through,
because nothing upstream removed it from the menu. A check with nothing in front of it
is a report, not a guard rail. The agent is now never shown an option it isn't allowed
to pick.

**It fails closed.** If any stage errors or returns something invalid, the cart holds.
There is no path through this system where something breaking produces an offer.

**Assumptions get a sensitivity check.** Where a number is a guess, I check whether the
answer moves when I'm wrong about it. Lower Bowl is $48 in one cart and $58 in another,
and I use $53 — across that whole range the upgrade stays over the cap, so the decision
never flips and the uncertainty doesn't matter.

Where it does matter, I take the conservative side rather than estimating. An upgrade's
cost depends on whether the better seat would have sold: if it would, the cost is the
full price gap; if the section was going half empty, it's nothing. I had invented fill
rates for that — 70% and 55% — until it became clear they were doing real work in real
arithmetic. The Seawolves report selling out Starfire, so the gap is both the realistic
case and the expensive one, and pricing at it can overstate a cost but never hide one.
Per-fixture fill lives in the ticketing platform Envorso runs; that's a lookup, not
something I should be guessing at.

---

## Section C — AI usage log

I built this with Claude Code. Three points where I didn't take what it gave me.

### 1 · The upgrade it told me was free

**What I asked for:** the agent was recommending a free seat upgrade for a fan who'd
drifted away. I wanted the dollar cost before I accepted the recommendation.

**What it gave me:** free. No cash, just seats.

**What I rejected, and why:** a better seat is worth more than the one they had, and
someone else could have bought it. Nobody handing over money doesn't make it free. I
made it work out the real number.

Take a fan with **2 Upper Deck seats at $35 each — a $70 cart**:

| | what it costs the club | what the club keeps |
|---|---|---|
| Move them up to Lower Bowl ($53 seats) | **$36** — the $18 gap, twice | **$34** |
| Take 10% off instead | **$7** | **$63** |

Upgrading gives away **half the cart to save the cart**. The discount gives away a
tenth. The "free" option was the most expensive thing in the catalog, and it was being
recommended because nothing had priced it.

**Where those numbers come from.** Ticket prices are read off the carts themselves — a
$140 cart with 4 seats means Upper Deck is $35. The $18 gap assumes the better seat
would have sold, which is the realistic case here because the Seawolves report selling
out Starfire's 4,000 seats, and it's the conservative one — if a section doesn't sell
out, the upgrade costs less, down to nothing.

**What changed:** every offer is now priced as cash plus revenue given away, and nothing
may exceed a fifth of the cart it's rescuing. The agent stopped recommending upgrades on
these carts entirely. Its agreement with the answers I'd written by hand went from 0% to
100% — every disagreement we'd had traced back to a price that was wrong.

### 2 · The stranger who was about to get a better deal than a six-year fan

**What I asked for:** whether it makes sense to discount a first-time buyer, hoping it
brings them back for another game.

**What it gave me:** yes, and it showed me the system already does it — 15% off, the
deepest offer in the catalog, because a first-timer is the one fan there's no evidence
about. That reasoning is sound. A first ticket isn't $140, it's the start of a
relationship, and $21 to find out is cheap.

**What I stopped, and why:** here's what that same screen was about to show a marketer.

| cart | fan | offer |
|---|---|---|
| `C-1002` | never bought anything | **15% off, $21** |
| `C-1004` | 40 tickets, bought 9 days ago | **nothing** |

You can't hand a stranger a better deal than a six-year season-ticket holder. This club
has a few thousand supporters and they know each other. The brief warns about tone-deaf
offers to loyal fans — and the system had found a way to be tone-deaf by saying nothing
at all.

**What changed, and what didn't:** the decisions stayed. Leaving the loyal fan alone is
right — he was coming back on his own, and 15% off one cart isn't what starts that
conversation. What changed is that the blank now says something. A hold on one of the
club's core fans carries a note: this is who they are, leaving them alone is correct,
and if you want to do something for them it shouldn't be money.

**What I decided not to build:** loyal fans need value in a currency that isn't
discounts — recognition, first access, an upgrade when there's room in the stadium.
That's a loyalty programme, not a cart tool. So the system doesn't pretend to solve it.
It puts it in front of the person who can.

### 3 · The budget I had it delete

**What I asked for:** nothing. It built a daily spend cap on its own — $250 a day, a
warning when a run went over, a bar filling up as I approved offers.

**What I rejected, and why:** every offer here is approved one at a time, by a person,
with the price on the card. Nobody can overspend by accident; you'd have to click
through each one individually. The cap was guarding against something that can't happen
in this system.

**What changed:** all of it went — the constant nobody could source, the check, the
progress bar, the warning copy, and a concept this README would have had to explain.

The **per-cart limit stayed**, because that one guards something real: it stops the
agent proposing an offer worth more than the cart it's rescuing. There was a live
example — a $60 ceiling sitting against a $58 cart.

**What it cost to find out:** three rounds. A cap, then a bug in the cap, then a
cleverer version of the cap — and the cleverer one didn't work either, because a
percentage can't catch a runaway day. A hundred offers at ten percent is still ten
percent.

**The rule I'd take from it:** a guard rail for a system you haven't built yet isn't
safety, it's complexity. This gets added the day it starts sending without a person in
front of it. Not before.
