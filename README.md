# Cart Win-Back Agent — Envorso Sports

Fans leave tickets in their cart. This reads the stale ones every day, works out which
are worth chasing, and puts a specific offer in front of a marketer to approve, edit or
reject. Nothing reaches a fan without a person saying yes.

**Run it:**

```bash
npm install
cp .env.example .env.local     # add your ANTHROPIC_API_KEY
npm run dev                    # http://localhost:3000
```

Needs Node 22.18+. Two things you can run from the terminal:

```bash
node --env-file=.env.local scripts/run.mts    # the agents, no UI
node --env-file=.env.local scripts/eval.mts   # score them against the answer key
```

---

## How it works

Four steps. The first one is just rules — no AI at all.

```
cart ─▶ RULES ─▶ AGENT 1 ─▶ AGENT 2 ─▶ AGENT 3 ─▶ marketer
        can we    who is    what do    should we   approves
        contact   this      we give    send this?  edits or
        them?     fan?      them?                  rejects
```

Each step only sees what the step before it produced. That's on purpose. It stops one
model deciding both *who this fan is* and *what they deserve*, then bending the first to
justify the second.

**Rules first.** No email consent, no contact — `C-1003` stops here and never reaches an
agent. Left the cart under two hours ago? Nothing, they might still be paying. Under 24
hours? A free reminder, but no money.

**Agent 1 works out who the fan is.** Regular, first-timer, gone a year. And the
question everything hangs on: would they have come back without us? **It never sees the
cart value.** Money can't tell you whether someone returns.

**Agent 2 picks the offer** from a fixed list. It gets Agent 1's answer, not the raw
cart. It can only pick from the list, so it can't invent an upgrade to a section that's
sold out.

**Agent 3 argues against it.** It sees the fan and the offer, but **not why Agent 2
chose it.** A confident-sounding reason is the easiest thing for a model to produce, and
if you show it one, it grades the reason instead of the offer.

**Then a person decides.** Nothing sends itself.

### How this breaks

**Agent 2 talks itself into an offer.** Tell it a fan was coming back anyway and it will
still find a reason to give them 15% off, because it thinks its job is to produce
offers. The output looks fine. The reasoning reads well. It's wrong.

That happened on the first run. Four things stop it now:

1. "No offer" is a normal choice on the list, not a special case.
2. Agent 3 never sees Agent 2's reasoning, so it can't be talked round.
3. A plain arithmetic check: an offer can't be bigger than the fan justifies, or so
   small it isn't worth sending. Good prose doesn't get past arithmetic.
4. The answer key catches it drifting between runs.

**If a bad one gets through anyway**, the marketer edits or rejects it on the card. Every
edit and reject is a signal — see Section B.

**If anything breaks, the cart holds.** There's no path through this where a failure
produces an offer.

---

## Section A — Written analysis

### Which carts get an offer

Don't ask "how do we win this cart back?" The easiest carts to win back are the ones
coming back anyway, and you can't tell from the result. Send a discount, they buy, it
looks like it worked. You paid for a sale you already had.

Ask instead: **would this fan have come back on their own?** The less likely that is,
the more we're willing to give. Not the size of the cart. Not how loyal they are.

How recently they left decides what we can *spend*, not whether we talk to them. Under
two hours, nothing. Two to 24 hours, a free reminder. After that, real offers.

| cart | | what happens |
|---|---|---|
| `C-1004` | $540 Club, 40 tickets, left **1 hour ago** | nothing yet |
| `C-1001` | 14 tickets, bought 21 days ago, left 3 hours ago | **reminder, free** |
| `C-1002` | never bought anything, 4 seats, 26 hours | **15% off, $21** |
| `C-1005` | one ticket 300 days ago, cold 4 days | **10% off, $7** |
| `C-1003` | no email opt-in | **blocked** |

`C-1004` is the trap. Biggest number on the page. He's also a fan with forty tickets who
bought nine days ago and walked away an hour ago — the most likely person here to finish
on his own. Discounting him wastes money and insults him.

### What we offer, and what it costs

Six options, fixed: nothing, a reminder, waive the fees, a free seat upgrade, 10% off,
15% off. The agent picks one by name and can't make one up.

The rule is to pick the smallest thing that could work, and if two would work, the
cheaper one. Those aren't the same thing — waiving fees on four seats costs $24, while
15% off that same cart costs $21.

Then price everything honestly, which changed the answers. **A free upgrade isn't free.**
Move a fan from a $35 seat to a $53 one and the club gives up the $18 difference on a
seat someone else would have bought:

| for a $70 cart | costs the club | club keeps |
|---|---|---|
| free upgrade | **$36** | $34 |
| 10% off | **$7** | $63 |

Upgrading gives away half the cart to save the cart. Nothing may cost more than a fifth
of the cart it's rescuing.

### What I didn't build

**No sending.** The agent proposes, the marketer copies ready-made email and SMS text.
There's no CRM, and building a sender would be the least useful thing in the sprint.

**No spend budget.** Every offer is approved one at a time with its price on the card, so
nobody can overspend by accident. A cap would guard something the approval step already
prevents. First thing to add the day this sends without a person in front of it.

**Nothing personalised past the segment**, no multi-team version, no self-serve rule
editing. One club, one marketer, one screen.

---

## Section B — Agent quality and failure plan

### How I'd know the offers are any good

**Four checks. Only two of them scale.**

**1. An answer key, written before the model ran.** I decided what each of the five carts
deserved, and why, before an agent saw the data. That way my judgement is the benchmark,
instead of me reading its output and talking myself into agreeing. `scripts/eval.mts`
scores it. It's at 100% right now. It needs me to have labelled the carts, so it stops
working past the five I sat down and thought about.

**2. Rules that check themselves.** Things you can verify with arithmetic on any day's
carts: consent is never broken, nothing goes out under two hours and nothing costing
money under 24, the offer exists on the list, no offer costs more than a fifth of its
cart, and the price the model claimed matches the price we calculate. **These are what
would actually run every morning.** Sixty generated carts pass them.

**3. Ten percent of fans get nothing, deliberately.** Redemption rate lies — it counts
the fans who were coming back anyway. So a tenth of the ones we'd have contacted are
left alone, and the gap between the two groups is what the offers actually rescued. The
same fan is always on the same side of that line, so the comparison holds.

**4. What the marketer clicks.** Every approve, edit and reject is a verdict on the
agent. If they're rewriting four out of ten upgrades, the upgrade rule is wrong. It's
free, it needs no extra tooling, and it's the one signal one engineer can keep running.

### What it costs to run

| step | model | why |
|---|---|---|
| Rules | none | consent and arithmetic don't need a model |
| Agents 1 and 2 | Haiku 4.5 | sorting things into categories is what a small fast model is for |
| Agent 3 | Haiku, **Sonnet** when the offer is cash or over $15 | pay more only where money actually leaves |

Measured, not guessed: **3 cents for the five carts, 34 cents for sixty. About half a
cent each.**

The escalation is the trade-off. Checking a free reminder with an expensive model is
paying more to check something that costs nothing. Checking a 15% discount is worth it —
that one ends up on someone's card statement.

### How it could be wrong without me seeing

**It reasons correctly from numbers I made up.** This is the one that cost money. My
price list said a seat upgrade cost nothing, so the agents handed them out. At sixty
carts they were giving away a third more than they should have. Nothing in the output
looked wrong, because nothing *was* wrong — except my numbers.

Agent 3 had been telling me for hours: *"a small discount costs less than the inventory
required."* It was right. I'd overruled it by writing `$0` on the menu it reads. Once
the prices were real, its agreement with my answer key went from 0% to 100%.

**It invents a rule and states it confidently.** Agent 3 twice argued the club shouldn't
spend on fans who "haven't converted once." Sensible-sounding. Nobody gave it that rule,
and it's the opposite of the one this system runs on — a fan with no history is exactly
who an offer is for, because there's no evidence they come back without one.

**My wording changes the decision.** Three times. It rejected an upgrade as "invisible"
because of what I'd called it internally. It read "no cash, but…" next to a $38 figure
and treated it as free. "Cheapest tool" turned out to be ambiguous once prices were
honest. **A prompt isn't a description of the system. It's part of it.**

### What stops a bad offer reaching a fan

**A person approves every single one**, with the price and the full reasoning on the
card. That's the real gate, and it's why there's no spend cap — nothing goes out unread.

**Agent 3 is kept in the dark** about why the offer was chosen, so it can't be persuaded
by a well-written reason.

**Every check has something enforcing it.** A lesson from this build: the per-cart price
cap was *reported* for three runs while the pipeline let the offer through anyway,
because nothing removed it from the menu. A check with nothing in front of it is a
report, not a guard rail.

**It fails closed.** Anything breaks, the cart holds.

**Guesses get tested.** Where a number is a guess, I check whether the answer changes if
I'm wrong about it. Lower Bowl seats are $48 in one cart and $58 in another — anywhere in
that range the upgrade is still too expensive, so it doesn't matter. Where it does
matter I take the expensive assumption rather than estimating. An upgrade only costs the
full price gap if that better seat would have sold, and the Seawolves report selling out,
so that's both the realistic case and the cautious one. The real per-match numbers are in
Envorso's own ticketing platform. That should be a lookup, not something I guess at.

---

## Section C — AI usage log

I built this with Claude Code. Three points where I didn't take what it gave me.

### 1 · The upgrade it told me was free

**What I asked:** what does a free seat upgrade actually cost us, in dollars?

**What it said:** free. No cash, just seats.

**What I did:** didn't accept it. A better seat is worth more, and someone else could
have bought it. Nobody handing over money doesn't make it free.

So I made it work the number out. A fan with **2 Upper Deck seats at $35 — a $70 cart**:

| | costs the club | club keeps |
|---|---|---|
| move them to Lower Bowl ($53 seats) | **$36** | **$34** |
| take 10% off instead | **$7** | **$63** |

Giving away half the cart to save it. The "free" option was the most expensive thing on
the list, and it was being recommended because nobody had priced it.

**Where those numbers come from:** ticket prices are read off the carts — a $140 cart
with 4 seats means Upper Deck is $35. The $18 gap assumes the better seat would have
sold, which is the realistic case since the Seawolves report selling out, and the
cautious one, because if it wouldn't have sold the upgrade costs less.

**What changed:** every offer is now priced properly, and nothing can cost more than a
fifth of its cart. The agents stopped recommending upgrades. Their agreement with the
answers I'd written by hand went from 0% to 100% — every argument we'd had traced back
to a price that was wrong.

### 2 · The stranger about to get a better deal than a six-year fan

**What I asked:** does it make sense to discount a first-time buyer, hoping they come
back for another game?

**What it said:** yes — and it showed me the system already does it. 15% off, the biggest
offer available, because a first-timer is the one fan there's no evidence about. That
reasoning is right. A first ticket isn't $140, it's the start of a relationship, and $21
to find out is cheap.

**What I stopped:** here's what that same screen was about to show a marketer.

| cart | fan | offer |
|---|---|---|
| `C-1002` | never bought anything | **15% off, $21** |
| `C-1004` | 40 tickets, bought 9 days ago | **nothing** |

You can't hand a stranger a better deal than a six-year season-ticket holder. This club
has a few thousand supporters and they know each other. The brief warns about tone-deaf
offers to loyal fans — and the system had found a way to be tone-deaf by staying silent.

**What changed, and what didn't:** the decisions stayed. Leaving the loyal fan alone is
right, and 15% off one cart isn't what starts that conversation. What changed is that
the blank now says something. A hold on one of the club's core fans carries a note: this
is who they are, leaving them alone is correct, and if you want to do something for them
it shouldn't be money.

**What I didn't build:** loyal fans need looking after in a currency that isn't
discounts — recognition, first access, better seats when there's room. That's a loyalty
programme, not a cart tool. The system doesn't pretend to solve it. It puts it in front
of the person who can.

### 3 · Four words that cut the day's spend by two thirds

**What I asked:** Agent 3 had refused a free seat upgrade, calling it *"invisible — they
won't know what 'one section better' means."* I asked why we didn't just call it a seat
upgrade, so the customer would understand it.

**What I found:** the objection was true — about the wrong thing. My internal list called
it *"free upgrade, one section better."* The email a fan actually gets says *"we'd like
to move you up to the Lower Bowl."* The agent was judging my label, not anything a fan
would ever read, and turning down a free offer because of it.

**What I changed:** the list the agents see now uses the same words the fan gets.

**What happened:** the first-time buyer's offer moved from 10% off to the free upgrade,
and the day's cash spend went from $21 to $7. Four words in my own prompt had been
costing the club money.

**What I'd take from it:** the words in a prompt aren't labels on the system, they're
part of it. Three decisions changed that day because of how I'd worded something. None
of them were the model being wrong. They were the model being right about what I'd
actually said.
