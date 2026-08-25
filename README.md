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

## Section A — Written analysis

### Which carts deserve an offer

Most cart tools ask "how do we win this cart back?" That question is a trap, because
the easiest carts to win back are the ones that were coming back anyway — and you
cannot tell the difference from the outcome. You send a discount, the fan buys, the
dashboard says it worked. You paid for a sale you already had.

So the system asks a different question: **would this fan have come back on their
own?** How strong an offer can be tracks how *unlikely* that is. Never the size of
the cart, never how loyal they are.

On the five sample carts that means **two offers, two holds, one block**:

| cart | | decision |
|---|---|---|
| `C-1004` | $540 Club, 40 lifetime tickets, abandoned **1 hour ago** | **hold** |
| `C-1001` | 14 tickets, bought 21 days ago, abandoned 3 hours ago | **hold** |
| `C-1002` | never purchased, 4 seats, 26 hours | **offer — 15% off, $21** |
| `C-1005` | one ticket 300 days ago, cart cold 4 days | **offer — 10% off, $7** |
| `C-1003` | no email opt-in | **blocked** |

`C-1004` is the trap: the biggest number on the page, and a fan with forty tickets who
bought nine days ago and walked away an hour ago is the likeliest person here to finish
by himself. Discounting him is wasted margin and a strange message to send someone who
already shows up. `C-1003` never reaches a model at all — no consent, no channel, no
decision to make.

### The offer logic

Offers come from a closed catalog — no offer, reminder, fee waiver, seat upgrade, 10%,
15% — and the agent returns an ID from it. It cannot invent an offer the club doesn't
sell, because there is no field to write one in.

The rule is: take the **weakest** offer that could plausibly work, and where two are
equally plausible, the cheaper one. Strength is what an offer teaches a fan about what
a ticket is worth. Cost is dollars. They do not move together.

Pricing every offer honestly changed the answers. A "free" upgrade is not free — it
hands over a seat someone else would probably have bought and only gives back the
cheaper one it frees. On `C-1005` that is **$35.70 to rescue a $70 cart**, against $7
for a 10% discount. Nothing may exceed a fifth of the cart it is rescuing.

### What I would not do yet

**No sending.** The agent proposes; the marketer copies ready-made email and SMS text.
There is no CRM, and a sender would be the least valuable thing in the sprint.

**No spend budget.** I built one and cut it. Every offer is approved individually with
its price on the card, so nobody can overspend by accident — the cap guarded a failure
mode the approval gate already prevents. First thing to add if this ever sends without
a person in front of it.

**No personalisation past the segment**, no multi-team abstraction, and no self-serve
rule editing. One club, one marketer, one screen.

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
carts: consent is never violated, nothing goes out inside the 24-hour cooling-off
window, the offer exists in the catalog, no offer exceeds a fifth of its cart, the cost
the model claimed matches what the catalog computes, and offer strength stays inside the ceiling
*and* floor the read allows. These are what would actually run every morning. Sixty
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
answer moves when I'm wrong about it. Lower Bowl is $48 in one cart and $58 in another;
across that whole range the upgrade stays over the cap, so the decision never flips and
the uncertainty is fine. Sell-through is the opposite — at 20% fill an upgrade is free
and at 70% it costs $35.70 — which is exactly why that one has to come from Envorso's
ticketing platform rather than from me.

---

## Section C — AI usage log

*(to come)*
