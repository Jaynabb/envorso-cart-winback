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

That's the whole rules layer. There used to be six more — a 24-hour cooling-off window, a
20%-of-cart spending cap, a loyalty threshold, a staleness ceiling, a suppression window
and a 0–4 offer ladder. I swept every one of them against the carts and deleted the lot.
[Why](#the-numbers-i-deleted).

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

They aren't the same *kind* of money, and the card says which: an upgrade gives away
seats that might not have sold, a price cut gives away cash.

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

### The numbers I deleted

I had eleven thresholds. A booking-fee rate, a 20%-of-cart spending cap, a 24-hour
cooling-off window, a loyal fan defined as 10 tickets inside 60 days, a staleness
ceiling, a suppression window, an escalation price, a 0–4 strength ladder with a ceiling
and a floor for each read.

None of them came from the data, because the data is five carts with a value, seats, a
section, a ticket history and an opt-in flag. I'd written them, and written reasons
underneath that sounded like sources.

So I swept them — every threshold, over its plausible range, against the five carts:

```
share cap        0.2   →  identical decisions anywhere from 0.10 to 0.50
staleness        14d   →  nearest flip at 3 days
loyal fan     10t/60d  →  changes nothing at any value from 3 tickets to 30
```

The cap I'd have defended hardest turned out not to matter at all, and once upgrades were
priced honestly it was catching something that could no longer happen. The loyalty rule
never fired once — the analyst had already read those fans off their actual history, and
the threshold was re-deriving that conclusion from a number I made up.

**Deleting all eleven changed one decision out of five, and made it cheaper.** Two
survive: don't interrupt someone who may be at the checkout, and every 15 tickets earns a
step. The first is a claim about what a fan is doing rather than arithmetic. The second
is what the club gives back, and it's the reason the loyal fan can be left alone without
being ignored.

What's left doing the work is the thing that was in the data all along — what a seat
costs.

---

## Section A — Written analysis

### Which carts get an offer

"How do we win this cart back?" is the wrong question. The easiest ones were coming back
anyway, and the result can't tell you which: they buy, it looks like it worked, and you
paid for a sale you already had.

Ask instead: **would this fan have come back on their own?** The less likely that is, the
more we'll give. Not the size of the cart, not how loyal they are.

| cart | | what happens |
|---|---|---|
| `C-1004` | $540 Club, 40 tickets, left **1 hour ago** | nothing yet |
| `C-1001` | 14 tickets, bought 21 days ago, left 3 hours ago | **reminder**, free |
| `C-1002` | never bought, 4 seats, $140, 26 hours | **10% off** · 140 × 0.10 = **$14** |
| `C-1005` | one ticket 300 days ago, $70, cold 4 days | **10% off** · 70 × 0.10 = **$7** |
| `C-1003` | no email opt-in | **blocked** |

Contact and cost are separate: if we can reach them and the cart is genuinely abandoned
they hear something, and the read decides whether it costs anything.

`C-1004` is the trap — the biggest number on the page, and the likeliest person on it to
finish by himself.

Leaving your best fans alone is right and looks awful — nothing for the man with forty
tickets, money off for a stranger. So **every 15 tickets earns a step**, up a section or
down a price tier if they're already at the top. It's owed rather than spent, so it never
competes with the win-back logic. Both held fans cross one here.

### What we offer, and what it costs

Five fixed options: nothing, a reminder, a free seat upgrade, 10% off, 15% off — picked
by name, never invented, and built only from what the data contains. No fees or perks,
because there are none in the data.

Take the cheapest one that could plausibly work, in dollars. That test needs stating in
dollars because **a free upgrade isn't free** — it hands over a seat someone else would
have bought and only gives back the cheaper one it frees:

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

### What I didn't build

**No sending.** The agent proposes; the marketer copies ready-made email and SMS text.
There's no CRM, and a sender would be the least useful thing in the sprint.

**No spend budget, and no thresholds.** Every offer is approved one at a time with its
price showing, so nobody can overspend by accident — and every threshold I tried to keep
turned out to be a number I'd invented.

**Nothing personalised past the segment**, no multi-team version, no self-serve rules.

---

## Section B — Agent quality and failure plan

### How I'd know the offers are any good

**Four checks. Only two of them scale.**

**1. An answer key, written before the model ran.** I decided what each of the five carts
deserved, and why, before an agent saw the data. That way my judgement is the benchmark,
instead of me reading its output and talking myself into agreeing.

`scripts/eval.mts` scores it, and the result splits in a way worth reporting honestly.
**Which carts get an offer is identical every run — five out of five, every time.** Which
offer it picks moves around inside the range I said was reasonable, matching my exact
pick between a third and two thirds of the time. That gap isn't the agent being wrong;
it's my key claiming a precision I don't have. Choosing between 10% and 15% on those
carts was a coin-flip.

**And more than once the key has been the thing that was wrong.** It preferred a free
upgrade for `C-1005` until upgrades were priced properly and turned out to cost five
times a discount. Every disagreement it flagged, I'd assumed was the agent's fault — and
reading them properly changed my mind rather than the prompt.

That's the part I didn't expect from an answer key. It isn't only a grade for the agent —
it's the thing that keeps catching me.

It also needs me to have labelled the carts, so it stops working past the five I sat down
and thought about.

**2. Rules that check themselves.** Things you can verify with arithmetic on any day's
carts, with no labels at all: consent is never broken, nothing goes out under two hours,
the offer exists on the list and is available for that cart, nothing that costs money
reaches a fan the analyst read as coming back on their own, nobody gets a bare reminder
when the read says a reminder won't move them, and the price the model claimed matches
the price we calculate. **These are what would actually run every morning.** Sixty
generated carts pass them.

There used to be one more, and cutting it is the sharper lesson. I made "take the
cheapest that works" an invariant — and it fired on both offers in a completely healthy
run, because the strategist is allowed to spend more when it can say why. An alarm that
goes off on permitted behaviour teaches people to ignore the alarms, which is the one
thing this list cannot afford. It's now printed on the card instead: *$7.00 dearer than
the cheapest thing that would work here*, next to the reason it was worth it. A
judgement call belongs in front of a person, not in a threshold.

**3. A holdout — the day this actually sends.** Redemption rate lies: it counts the fans
who were coming back anyway. So a tenth of the fans we'd have contacted should get no
message, and the gap between the two groups is what the messages actually rescued. The
same fan stays on the same side of that line so the comparison holds week to week.

**This is a plan, not a feature, and I took the code out.** I had it running in the
pipeline, and it was measuring an experiment that can't happen: nothing here sends. It
hands a marketer text to paste. A holdout belongs in whatever eventually does the
sending — shipping it now would only have let me claim a rigour the system doesn't have
yet.

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

**What changed:** every offer is now priced properly and the menu arrives cheapest
first. The agents stopped recommending upgrades — not because a rule forbids it, but
because an upgrade is almost never the cheapest thing that would work. Their agreement
with the answers I'd written by hand went from 0% to 100%. Every argument we'd had traced
back to a price that was wrong.

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

**What happened:** the agents stopped turning upgrades down over a word no fan ever
sees. They're still rarely the right answer — redirection 1 priced them and most carts
can't afford one — but now they lose on cost rather than on my phrasing.

**What I'd take from it:** the words in a prompt aren't labels on the system, they're
part of it. Three decisions changed that day because of how I'd worded something. None
of them were the model being wrong. They were the model being right about what I'd
actually said.

### 4 · Where did these numbers come from?

**What I asked:** the model had built me a policy layer — a spending cap, a cooling-off
window, a loyalty threshold, an offer strength ladder. I asked one question about one of
them: *where did the booking fee come from?*

**What I found:** nowhere. The dataset has cart value, seats, section, ticket history and
an opt-in flag. It has no fee. The model had invented a rate, built an offer on top of
it, and that offer had become the *preferred* recommendation — so the headline of the
demo was resting on a number that didn't exist. I asked the same question of the other
ten thresholds and got the same answer ten more times.

**What I did:** made it prove which ones mattered instead of arguing for them. Sweeping
every threshold across its plausible range against the five carts took a few minutes and
settled it: the spending cap changed nothing anywhere between 10% and 50% of cart, the
loyalty rule changed nothing at any value from 3 tickets to 30, and most of the rest were
re-deriving from invented numbers what the analyst had already read off the fan's real
history.

Deleting all eleven changed one decision out of five, and made it cheaper.

**What it exposed on the way out:** with the ladder gone, the reviewer started overruling
correct proposals — it upgraded both offers to the dearer option in the same run. The
reason was mine again. Its list of alternatives excluded the offer being reviewed, so
when the strategist correctly picked the cheapest one, the list it was shown started at
the second-cheapest. In its own words: *"the proposed 10% discount isn't even offered
here."* Sound reasoning, wrong list. Putting the proposal back into the list in its true
place fixed both carts.

**What I'd take from it:** a threshold and a fact aren't the same kind of claim, and I'd
been treating them the same. *The club waits 24 hours before spending money* is a policy
— it can't be false, only badly tuned. *The club charges a 12% booking fee* is a fact
about the world, and mine was simply untrue. What made this fixable wasn't spotting the
difference, it was testing it: I can't source my remaining number either, but I can show
you it's the only one still doing any work.
