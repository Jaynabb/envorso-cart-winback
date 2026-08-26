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

### What a seat costs

Every price in this README comes from these three numbers, and every one of those is read
off the sample carts rather than invented:

| section | per seat | where it comes from |
|---|---|---|
| Upper Deck | **$35** | `C-1002` is $140 for 4 seats. 140 ÷ 4 = 35 |
| Lower Bowl | **$53** | `C-1001` is $96 for 2 → $48. `C-1003` is $58 for 1 → $58. Midpoint 53 |
| Club | **$90** | `C-1004` is $540 for 6 seats. 540 ÷ 6 = 90 |

Sanity check: Seawolves tickets run about $39–$73 and average $50, so a $35–$90 spread
across three tiers is the right shape. In production these are price levels in the
ticketing platform, per fixture — Envorso runs it, so it's a lookup.

### Loyalty: every 15 tickets earns a step

Paying for a cart that takes a fan past 15, 30 or 45 earns them a reward. `C-1004` has 40
tickets and 6 seats waiting (40 + 6 = 46, past 45). `C-1001` has 14 and 2 (14 + 2 = 16,
past 15). Both cross.

**It's always one step, never a jump to the top.** That's what makes it work for both
sides: the fan gets something real, and the club's cost is bounded by a single tier gap
rather than by how far the fan happens to sit from the best seats in the ground. A step
up from the Upper Deck costs $53 − $35 = **$18 a seat**. A step down in price from the
Club costs $90 − $53 = **$37 a seat**. Neither is open-ended.

**The whole cart moves, not the seat that tipped them over.** A fan crossing their
fifteenth ticket buying two seats isn't going to sit in the Club while whoever they came
with stays in the Lower Bowl. So it's priced across every seat:

```
C-1001 pays $96 for 2 Lower Bowl seats     →  $48 a seat
one step up is the Club                    →  $90 a seat
                                              ───────────
the club gives up                             $42 a seat  x 2  =  $84
```

**If they're already in the best seats, the reward moves to their next order.**
`C-1004` is in the Club — nowhere to move him — so nothing comes off the cart in front of
him. Next time he buys, those Club seats are his at Lower Bowl prices:

```
Club seats                                    $90 a seat
charged at one step down, the Lower Bowl      $53 a seat
                                              ───────────
the club gives up                             $37 a seat  x 6  =  $222
```

Deliberately not applied to the cart he's mid-way through. Re-pricing an order someone is
already paying for is a different and messier thing than moving where they sit, and it
hands cash back on a sale the club was making anyway.

The two come to roughly the same share of what each fan spent to earn them:

```
C-1001   15 tickets at $48  =  $720 spent   →   $84 back   =  12%
C-1004   15 tickets at $90  = $1,350 spent  →  $222 back   =  16%
```

They aren't the same *kind* of money, though, and the card says which: an upgrade gives
away seats that might not have sold, a price cut gives away cash.

That matters because it's the only thing the club gives its best fans. They're the ones
who correctly get no win-back offer — they were coming back anyway — which leaves them
staring at nothing while a stranger gets 15% off. A milestone is owed rather than spent,
so it doesn't pay for a sale we already had, and it turns the one message they do get
from a nag into news:

> **Your next seats earn you an upgrade.** These take you to 16 tickets with us. Every 15
> earns a free upgrade, so we'll move both of you to the Club for this match — same price,
> and you'll be sitting together.

It's a rule and not an agent, because an entitlement isn't a judgement call.

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

"How do we win this cart back?" is the wrong question. The easiest ones were coming back
anyway, and you can't tell from the result — they buy, it looks like it worked, and you
paid for a sale you already had.

Ask instead: **would this fan have come back on their own?** The less likely that is, the
more we'll give. Not the size of the cart, not how loyal they are.

How recently they left caps what we can *spend*, not whether we talk to them. Under two
hours, nothing. Two to 24 hours, a free reminder. After that, real offers.

| cart | | what happens |
|---|---|---|
| `C-1004` | $540 Club, 40 tickets, left **1 hour ago** | nothing yet |
| `C-1001` | 14 tickets, bought 21 days ago, left 3 hours ago | **reminder**, free |
| `C-1002` | never bought, 4 seats, $140, 26 hours | **15% off** · 140 × 0.15 = **$21** |
| `C-1005` | one ticket 300 days ago, $70, cold 4 days | **10% off** · 70 × 0.10 = **$7** |
| `C-1003` | no email opt-in | **blocked** |

`C-1004` is the trap — the biggest number on the page, and the likeliest person on it to
finish by himself. Discounting him buys a sale the club already had.

Leaving your best fans alone is right and looks awful — nothing for the man with forty
tickets, 15% off for a stranger. So **every 15 tickets earns a step**: up a section, or
down a price tier if they're already at the top. It's owed rather than spent, so it never
competes with the win-back logic. Both held fans cross one here.

### What we offer, and what it costs

Six fixed options: nothing, a reminder, waive the booking fee, a free seat upgrade, 10%
off, 15% off — picked by name, never invented.

Take the smallest thing that could work; if two would, the cheaper one. Those differ —
waiving the 12% booking fee feels smaller than a discount and costs more:

```
C-1002's cart, $140:   waive the fee   140 x 0.12  =  $16.80
                       10% off         140 x 0.10  =  $14.00
```

**And a free upgrade isn't free.** It hands over a seat someone else would have bought,
and only gives back the cheaper one it frees:

```
C-1005 — 2 Upper Deck seats, $70 cart
  give away 2 Lower Bowl    $53 x 2 = $106
  free up   2 Upper Deck    $35 x 2 =  $70
  upgrade costs                        $36   club keeps $34
  10% off        $70 x 0.10 =           $7   club keeps $63
```

Half the cart, to save the cart. Nothing may cost more than a fifth of what it saves:
70 × 0.2 = $14 here, so the upgrade is off the menu.

### What I didn't build

**No sending.** The agent proposes; the marketer copies ready-made email and SMS text.
There's no CRM, and a sender would be the least useful thing in the sprint.

**No spend budget.** Every offer is approved one at a time with its price showing, so
nobody overspends by accident. First thing to add the day this sends unwatched.

**Nothing personalised past the segment**, no multi-team version, no self-serve rules.

---

## Section B — Agent quality and failure plan

### How I'd know the offers are any good

**Four checks. Only two of them scale.**

**1. An answer key, written before the model ran.** I decided what each of the five carts
deserved, and why, before an agent saw the data. That way my judgement is the benchmark,
instead of me reading its output and talking myself into agreeing.

`scripts/eval.mts` scores it, and the result splits in a way worth reporting honestly.
**Which carts get an offer is identical every run — five out of five, repeatedly.** Which
offer it picks moves around: always inside the range I said was reasonable, but matching
my exact pick maybe a third of the time. That gap is the answer key being over-confident,
not the agent being wrong. Choosing between 10% and 15% on those carts was a coin-flip I
didn't have grounds for, and the eval shows me that rather than letting me believe the
question was settled.

It also needs me to have labelled the carts, so it stops working past the five I sat down
and thought about.

**2. Rules that check themselves.** Things you can verify with arithmetic on any day's
carts: consent is never broken, nothing goes out under two hours and nothing costing
money under 24, the offer exists on the list, no offer costs more than a fifth of its
cart, and the price the model claimed matches the price we calculate. **These are what
would actually run every morning.** Sixty generated carts pass them.

**3. Ten percent hear nothing, deliberately — but they still get what they've earned.**
Redemption rate lies: it counts the fans who were coming back anyway. So a tenth of the
fans we'd have contacted get no message, and the gap between the two groups is what the
messages actually rescued. The same fan is always on the same side of that line, so the
comparison holds week to week.

**The line is drawn around contact, never around entitlement.** A fan in the control
group who crosses 15 tickets still gets their upgrade when they check out — we just don't
tell them it's coming. Withholding something a fan has earned to make an experiment
tidier isn't a trade worth making, and it would be the one thing here most likely to
actually lose someone's trust.

That does mean the two kinds of message have to be measured apart. "Here's 15% off" and
"you've earned an upgrade" are different things being tested on different people for
different reasons. Pool them and you get a number that describes neither.

**4. What the marketer clicks.** Every approve, edit and reject is a verdict on the
agent. If four out of ten reminders come back rewritten, the reminder rule is wrong. It's
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

So I made it work the number out, for a fan with **2 Upper Deck seats at $35 — a $70
cart**:

```
give away 2 Lower Bowl seats   $53 x 2  =  $106   revenue we can't collect
free up   2 Upper Deck seats   $35 x 2  =   $70   revenue we can
                                           ─────
the upgrade costs                            $36   →  club keeps $34
10% off instead    $70 x 0.10  =              $7   →  club keeps $63
```

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

**What came out of it:** the fix isn't to shrink the offer to the stranger, it's to pay
the loyal fan in a currency that isn't discounts. So every 15 tickets now earns a free
seat upgrade. Both held fans cross one on the cart they abandoned — 45 for `C-1004`, 15
for `C-1001` — and it's owed regardless, so it never competes with the win-back logic.

A full loyalty programme is still out of scope for a cart tool. One rule that costs
nothing extra is not.

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
