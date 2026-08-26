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

**Rules first, and there are only two.** No email consent, no contact — `C-1003` stops
here and never reaches an agent. Left the cart under two hours ago? Nothing yet, they
might still be paying.

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

### Loyalty: a voucher, not an announcement

Paying for a cart that takes a fan past 15, 30 or 45 tickets earns them a reward.
`C-1004` has 40 tickets and 6 seats waiting (40 + 6 = 46, past 45). `C-1001` has 14 and 2
(14 + 2 = 16, past 15). Both cross.

**It's always one step, never a jump to the top.** That's what makes it work for both
sides: the fan gets something real, and the club's cost is bounded by a single tier gap
rather than by how far the fan happens to sit from the best seats in the ground. A step
up from the Upper Deck costs $53 − $35 = **$18 a seat**. A step down in price from the
Club costs $90 − $53 = **$37 a seat**. Neither is open-ended.

**It's two seats, and it's redeemed on a later order.** Both of those bound what the
club is exposed to. `C-1001` earns a step up:

```
one step up from the Lower Bowl is the Club   $90 − $53  =  $37 a seat
                                                     x 2  =  $74
```

`C-1004` is already in the Club, so there's nowhere to move him and the step is a price
instead — two Club seats at Lower Bowl prices, same $37 gap, same $74.

**Nothing comes off the cart they're holding.** That's the whole system's rule applied to
its own reward: they already have the tickets in the basket and they were going to pay.
Handing value back there buys a sale the club already had, which is the exact mistake
this thing exists to stop. As a voucher it costs nothing on the order that earned it,
costs nothing at all if it's never claimed, and gives the fan a reason to come back
rather than a reason to feel clever about the order they're already finishing.

**And the club doesn't publish the rule.** The fan is told what they've earned, never
that there's a threshold or where the next one is. "Every 15 tickets earns an upgrade" is
a contract: it has to be honoured forever, it makes the reward feel owed rather than
given, and it invites someone to notice that one cheap extra seat is worth a $74 voucher.
Unannounced, it still does the job it was built for.

They aren't the same *kind* of money, and the card says which: an upgrade gives away
seats, a price cut gives away cash. Both are priced as money, because both are.

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
anyway, and the result can't tell you which: they buy, it looks like it worked, and you
paid for a sale you already had.

Ask instead: **would this fan have come back on their own?** The less likely, the more
we'll give. Not the size of the cart, not how loyal they are.

| cart | | what happens |
|---|---|---|
| `C-1004` | $540 Club, 40 tickets, left **1 hour ago** | nothing yet |
| `C-1001` | 14 tickets, bought 21 days ago, left 3 hours ago | **reminder**, free |
| `C-1002` | never bought, 4 seats, $140, 26 hours | **15% off** · 140 × 0.15 = **$21** |
| `C-1005` | one ticket 300 days ago, $70, cold 4 days | **10% off** · 70 × 0.10 = **$7** |
| `C-1003` | no email opt-in | **blocked** |

Contact and cost are separate: if we can reach them and the cart is genuinely abandoned
they hear something, and the read decides whether it costs anything.

`C-1004` is the trap — the biggest number on the page, and the likeliest person on it to
finish by himself.

Leaving your best fans alone is right and looks awful — nothing for the man with forty
tickets, money off for a stranger. So crossing 15, 30 or 45 tickets **earns a voucher**:
two seats, one step up, redeemed on a later order. It's owed rather than spent, so it
never competes with the win-back logic, and nothing comes off the cart they're holding.

### What we offer, and what it costs

Five fixed options: nothing, a reminder, a free seat upgrade, 10% off, 15% off — picked
by name, never invented, built only from what the data contains. No fees or perks,
because there are none in the data.

Take the cheapest one that could plausibly work, in dollars — and it has to be dollars,
because **a free upgrade isn't free.** It hands over a seat someone else would have
bought and only gives back the cheaper one it frees:

```
C-1005 — 2 Upper Deck seats, $70 cart
  give away 2 Lower Bowl    $53 x 2 = $106
  free up   2 Upper Deck    $35 x 2 =  $70
                                      ─────
  upgrade costs                         $36   club keeps $34
  10% off       $70 x 0.10  =            $7   club keeps $63
```

The gentler-sounding offer costs five times the blunt one. The agents get this menu
sorted cheapest first with the real figure on every line; going dearer is allowed, and
has to be argued for on the card where a marketer can see the gap.

**What separates the two discounts is whether there's a history to read.** A fan who
bought before and stopped gets 10%: they know what a ticket costs and chose not to buy,
so the smaller lever tests whether price is what's in the way. Someone who has never
bought gets 15% — a first purchase is the club buying a supporter, not discounting a
cart, and there's no cheaper way to price a fan you have no evidence about.

### What I didn't build

**No sending.** The agent proposes; the marketer copies ready-made email and SMS text.
There's no CRM, and a sender would be the least useful thing in the sprint.

**No spend budget.** Every offer is approved one at a time with its price showing, so
nobody can overspend by accident.

**Nothing personalised past the segment**, no multi-team version, no self-serve rules.

---

## Section B — Agent quality and failure plan

### How I'd know the offers are any good

Four checks. Only two of them scale.

**1. An answer key, written before the model ran.** I wrote down what each of the five
carts deserved, and why, before any agent saw the data — so my judgement is the benchmark
rather than something I talk myself into after reading the output. `scripts/eval.mts`
scores against it: five out of five on outcome, on offer, and on how the fan was read,
stable across runs.

More than once the key was the thing that was wrong, and I only found that by reading a
disagreement I'd assumed was the agent's fault. It also needs me to have labelled the
carts, so it stops working past the five I sat and thought about.

**2. Invariants.** Checkable with arithmetic, on any day's carts, with no labels at all:
consent is never broken, nothing goes out under two hours, the offer exists and is
available for that cart, nothing that costs money reaches a fan read as coming back
anyway, nobody gets a bare reminder when the read says a reminder won't move them, and
the price the model claimed matches the price we calculate. **This is the half that would
run every morning.** Sixty generated carts pass.

Only things that are *always* wrong belong on that list. "Take the cheapest thing that
works" isn't one — the strategist may spend more when it can say why, so an invariant
would fire on a healthy run, and an alarm that goes off on permitted behaviour teaches
people to ignore the alarms. That one prints on the card instead: *$7.00 dearer than the
cheapest thing that would work here*, next to the reason.

**3. A holdout — the day this actually sends.** Redemption rate counts the fans who were
coming back anyway. A tenth of qualified fans should get no message, and the gap between
the two groups is what the offers actually rescued. I took the code back out: nothing
here sends, so it was measuring an experiment that can't happen. The line goes around the
*message*, never the entitlement — a fan in the control group still gets their voucher,
we just don't send the note telling them.

**4. What the marketer clicks.** Every approve, edit and reject is a label. If four in
ten reminders come back rewritten, the reminder rule is wrong. Free, needs no tooling,
and it's the one signal one engineer can keep running.

### What it costs to run

| step | model | why |
|---|---|---|
| Rules | none | consent and arithmetic don't need a model |
| Agents 1 and 2 | Haiku 4.5 | sorting things into categories is what a small fast model is for |
| Agent 3 | Haiku, **Sonnet** when the offer costs money | pay more only where money actually leaves |

Measured, not guessed: **3 cents for the five carts, 34 cents for sixty — about half a
cent each.** Checking a free reminder with the expensive model is paying to check
something that costs nothing. Checking a discount that lands on someone's card statement
is worth it.

### How it could be wrong without me seeing

**It reasons perfectly from something it was handed.** That's the whole failure mode,
and it isn't hallucination — it's the opposite. Every step is sound and the input is bad,
so nothing in the output looks wrong, because nothing *is* wrong except the thing nobody
checked.

Two examples from this build, both caught by looking at the input rather than the answer.
The catalog priced a seat upgrade at `$0`, so the agents handed them out — while the
reviewer agent argued against them for hours and lost, to a menu that said they were
free. Later, the reviewer's list of alternatives excluded the offer it was reviewing, so
when the strategist correctly picked the cheapest option the list started one rung above
it. The reviewer said *"the proposed 10% discount isn't even offered here"* and traded
two carts up to the dearer offer. Faultless reasoning, wrong list.

The output is never the thing that looks wrong. So what catches it is upstream of the
output:

- **A person approves every offer** with the real price and the full reasoning on the
  card. That's the actual gate, and it's why there's no spend cap — nothing goes out
  unread.
- **Agent 3 never sees why the offer was chosen**, so it can't be talked round by a
  well-written reason.
- **Every check has something enforcing it.** The price cap was *reported* for three runs
  while the pipeline let the offers through, because nothing removed them from the menu.
  A check with nothing in front of it is a report, not a guard rail.
- **Guesses get tested rather than defended.** Sweeping a number across its plausible
  range takes minutes and answers whether it matters at all. Lower Bowl seats are $48 in
  one cart and $58 in another; anywhere in that range the upgrade is still too expensive,
  so the guess doesn't matter. Where one does matter I take the expensive assumption
  rather than the convenient one.
- **It fails closed.** Anything breaks, the cart holds. There is no path through this
  where a failure produces an offer.

---

## Section C — AI usage log

I built this with Claude Code. It wrote most of the code and all of the first draft of
the pricing. My job was deciding what was true, and four of those decisions changed the
system. Each one started as a question, not a correction.

### 1 · "What does that actually cost us in dollars?"

The model was recommending a free seat upgrade and calling it free. I asked what it cost
the club in dollars. It said free — no cash, just seats.

I didn't accept that. A better seat is worth more than the one they had, and someone else
could have bought it. Nobody handing over money doesn't make it free. So I had it work
the number out, for a fan with **2 Upper Deck seats at $35 — a $70 cart**:

```
give away 2 Lower Bowl seats   $53 x 2  =  $106   revenue we can't collect
free up   2 Upper Deck seats   $35 x 2  =   $70   revenue we can
                                           ─────
the upgrade costs                            $36   →  club keeps $34
10% off instead    $70 x 0.10  =              $7   →  club keeps $63
```

Half the cart, to save the cart. The "free" option was the most expensive thing on the
list, and it was being recommended because nothing had priced it.

**Where those numbers come from:** ticket prices are read off the carts — a $140 cart
with 4 seats means Upper Deck is $35. The $18 gap assumes the better seat would have
sold, which is both the realistic case, since the Seawolves report selling out, and the
cautious one: if it wouldn't have sold, the upgrade costs less than this says.

**One of its own agents had been saying this for hours.** The reviewer kept objecting
that a discount costs less than giving away inventory, and it kept getting overruled — by
a menu that printed `$0` next to the upgrade. It was right and the menu was wrong. Once
the prices were real, its agreement with my hand-written answers went from 0% to 100%.

**And it wasn't finished after the fix.** Days later I caught the catalog still telling
the agents an upgrade *"spends a seat that was likely going unsold"* — while the price
underneath assumed that same seat would definitely have sold. The number was right and
the sentence beside it argued the opposite. That's the version of this that survives a
fix: the price gets corrected, the wording that caused it doesn't.

### 2 · "Where did these numbers come from?"

It had built a policy layer — a spending cap, a cooling-off window, a loyalty threshold,
an offer strength ladder. I picked one number and asked where it came from.

A booking fee. 12%. It came from nowhere: this dataset has cart value, seats, section,
ticket history and an opt-in flag, and no fee. A rate had been invented, an offer built
on top of it, and that offer had become the *recommended* one — so the headline of this
demo was resting on a number that doesn't exist. Earlier the same thing had produced
sell-through rates for each section, cited as if they were the club's. I asked the same
question of the remaining thresholds and got the same answer ten more times.

**What I did about it was the part that mattered.** I didn't argue over which ones felt
reasonable — I had it sweep every threshold across its plausible range against the five
carts, and let the sweep decide:

```
share cap        0.2   →  identical decisions anywhere from 0.10 to 0.50
staleness        14d   →  nearest flip at 3 days
loyal fan     10t/60d  →  changes nothing at any value from 3 tickets to 30
```

The cap that would have been easiest to defend changed nothing. The loyalty rule never
fired once — the analyst had already read those fans off their real purchase history, and
the threshold was re-deriving that conclusion from an invented number. **Deleting all
eleven changed one decision out of five, and made it cheaper.**

Three chosen numbers are left: don't contact anyone inside two hours, a milestone every
15 tickets, and a milestone is worth two seats. Everything else is a ticket price read
off the carts.

### 3 · "What decides whether a fan gets 10% or 15%?"

One question, and the answer was: nothing does.

The catalog reserved 15% for *"a fan we have no evidence will ever come back — a
first-timer with no history, or someone long lapsed."* But the selection rule takes the
cheapest offer that plausibly works, and every fan matching that description qualified
for 10% too. The cheaper one won every time. **Across sixty carts, 15% off was chosen
zero times.** It was decoration, and I'd have presented it as a live option.

So I gave it a determining factor that comes from the data rather than from a threshold:
whether there's a purchase history to read. A fan who bought before and stopped gets 10%
— they know what a ticket costs and chose not to buy, so the smaller lever tests whether
price is what's in the way. Someone who has never bought gets 15%, because a first
purchase is the club buying a supporter rather than discounting a cart.

Across sixty carts now: 21 tens, 6 fifteens. Acquisition and reactivation, priced apart
on purpose.

### 4 · "The club can't bleed money on these upgrades"

The loyalty milestone was mine — every 15 tickets earns a step up, so the fans who
correctly get no discount still get something. What came back upgraded a fan's whole
party, on the cart they were already holding. I asked what it was costing.

`C-1004`'s six Club seats came to **$222 on a single order**. A reward the club can't
predict the size of is a reward it eventually stops honouring. Three changes, and each
one bounds it:

- **Redeemable on a later order.** Nothing comes off the cart in hand, and it costs
  nothing at all if it's never claimed. This turned out to matter more than the money: he
  already had six seats in the basket and was going to pay for them, so upgrading *those*
  buys a sale the club already had — the exact mistake the rest of the system exists to
  prevent. The reward had been breaking the rule it was built to protect.
- **Capped at two seats**, so the figure doesn't depend on how large a group the fan
  happened to book with.
- **Not announced.** The fan is told what they've earned, never that there's a threshold
  or where the next one is. Publish "every 15 tickets earns an upgrade" and it stops being
  a thank-you and becomes a contract — honoured forever, felt as owed rather than given,
  and eventually someone works out that one cheap extra seat is worth a $74 voucher.

$222 and $84 both became **$74**.

### What these have in common

None of them were the model being wrong in a way that showed. It reasoned correctly from
a price of zero, from thresholds with no source, and from a catalog entry that
contradicted its own arithmetic — and every output looked fine, because given what it had
been told, every output *was* fine.

That's why none of these were caught by reading the answers. They were caught by asking
where a number came from, and then testing it rather than accepting the explanation.
