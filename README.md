# Cart Win-Back Agent — Envorso Sports

Fans leave tickets in their cart. This reads the stale ones, works out which are worth
chasing, and puts a specific offer in front of a marketer to approve, edit or reject.
Nothing reaches a fan without a person saying yes.

**Run it.** Needs Node 22.18+.

```bash
npm install
cp .env.example .env.local     # add your ANTHROPIC_API_KEY
npm run dev                    # http://localhost:3000
```

```bash
node --env-file=.env.local scripts/run.mts    # the agents, no UI
node --env-file=.env.local scripts/eval.mts   # score them against the answer key
```

**How it works.** Four steps. The first is rules, not AI.

```
cart ─▶ RULES ─▶ AGENT 1 ─▶ AGENT 2 ─▶ AGENT 3 ─▶ marketer
        can we    who is    what do    should we   approves
        contact   this      we give    send this?  edits or
        them?     fan?      them?                  rejects
```

Agent 1 works out who the fan is. Agent 2 picks the offer. Agent 3 argues against it.
Each one is handed the previous step's answer rather than the raw row, and two of them
are deliberately kept in the dark:

- **Agent 1 is never told the cart value.** It gets the fan's history and the cart's age
  and nothing else. Money has no bearing on whether someone returns unaided, and if it's
  on the page the read bends toward it.
- **Agent 3 is never told why Agent 2 chose the offer.** It gets the fan, the offer and
  the priced list. A confident-sounding reason is the easiest thing for a model to write,
  and if you show it one, it grades the reason instead of the offer.

That's what stops a single model deciding both who this fan is and what they deserve, and
then bending the first to justify the second.

**The rules.** All fixed in code. An agent can't overrule any of them.

*First, can we contact this person at all?*

1. **No email opt-in, no contact.** `C-1003` stops here and never reaches an agent. You
   shouldn't need a language model to notice you don't have permission to email someone.

*Then the clock. How long the cart has been sitting decides what they can get:*

```
under 2 hours     nothing yet. They may still be at the checkout, and "you left
                  something behind" is the worst message to send someone typing
                  in their card number.        C-1004 left an hour ago.

2 to 24 hours     a reminder, and nothing that costs money. Most carts this new
                  get finished anyway, so a discount this soon just sells the
                  same tickets for less.       C-1001 left 3 hours ago.

after 24 hours    a discount. 15% off if they have never bought a ticket,
                  10% off if they have.        C-1002 at 26h, C-1005 at 96h.
```

2. **Between the two discounts, purchase history decides — not the agent.** Never bought
   before: 15%. Bought before and stopped: 10%.
3. **A seat upgrade is only on the list if there's a section above them**, and it costs
   more than the discount every time, so an agent picking one has to say why on the card.

There's also a voucher, which isn't a win-back offer at all: crossing 15, 30 or 45
tickets earns two seats one section up, on a later order.

The rules decide what's on the list. The agents work out who the fan is, choose from
what's left, argue against each other, and write the reasoning a marketer reads. A person
approves every one before it goes anywhere.

**The screen.** One card per cart, in three groups: the ones needing a decision, the ones
too new to act on, and the ones with no email consent. Nothing disappears — a cart the
system decided against is still on the page with the reason it was skipped.

Each card leads with the offer and what it costs the club, then the agent's reason in a
sentence or two. The reasoning chain behind it — who Agent 1 thought this fan was, what
Agent 2 proposed, what Agent 3 said back — is folded away until someone doesn't believe
the answer.

**And the agent will be wrong sometimes, so the screen assumes it.** Every card has
Approve, Edit and Reject. Edit swaps the offer for another one on the list, and the
headline, the price, the day's total and the email all follow the new choice — no version
where a marketer approves one offer and sends another. Approving doesn't write to a
database, because there's no CRM to write to: it produces the email and SMS text, ready
to paste. Nothing reaches a fan without someone clicking.

---

## Section A — Written analysis

### The question

Most cart tools ask how to win the cart back. The trouble is that the easiest carts to
win back are the ones that were coming back anyway, and the result can't tell them apart.
You send 10% off, the fan buys, and it looks like it worked. But they were going to buy
regardless. **The club just sold the same tickets for less money.**

So this asks a different question. **Would this fan have come back on their own?** The
less likely, the more we give. Not the size of the cart. Not how loyal they are.

It's why the schedule sends a reminder before it sends money, and why "don't spend on
this fan" never becomes "ignore this fan".

| cart | | what happens |
|---|---|---|
| `C-1004` | $540 Club, 40 tickets, left 1 hour ago | nothing yet |
| `C-1001` | 14 tickets, bought 21 days ago, left 3 hours ago | reminder, free |
| `C-1002` | never bought, 4 seats, $140, 26 hours | 15% off · 140 × 0.15 = **$21** |
| `C-1005` | one ticket 300 days ago, $70, cold 4 days | 10% off · 70 × 0.10 = **$7** |
| `C-1003` | no email opt-in | blocked |

`C-1004` is the trap: the biggest cart on the page, and the most likely person on it to
finish by himself.

### What the offers cost

Seat prices come from the carts:

```
Upper Deck   C-1002    $140 / 4 seats  =  $35
Club         C-1004    $540 / 6 seats  =  $90
Lower Bowl   C-1001     $96 / 2 seats  =  $48   midpoint
             C-1003     $58 / 1 seat   =  $58     $53
```

Five options: nothing, a reminder, a free seat upgrade, 10% off, 15% off. The agent picks
one by name and can't invent others.

The seat upgrade is the one that needs watching. It takes no cash at the till, so it
looks like it costs nothing. It doesn't — the club hands over a better seat and gets back
a cheaper one, and the gap is money it won't collect:

```
C-1005 — 2 Upper Deck seats, $70 cart
  give away 2 Lower Bowl    $53 x 2 = $106
  free up   2 Upper Deck    $35 x 2 =  $70
                                      ─────
  upgrade costs                         $36
  10% off       $70 x 0.10  =            $7
```

$36 to rescue a $70 cart, against $7 for the discount. The gentler-sounding offer costs
five times as much, which is why the discount is the default and an upgrade has to be
argued for.

Which discount depends on whether they've bought before. Someone who bought and stopped
already knows what a ticket costs and chose not to buy this time, so 10% is the smallest
sensible test of whether price is the problem. Someone who has never bought gets 15%,
because that money isn't buying a $140 cart — it's buying a first-time supporter the club
knows nothing about.

### Loyalty

Nothing in the win-back rules rewards a fan for being a regular, so someone with 40
tickets can get a reminder while a stranger gets 15% off. A club this size has a few
thousand supporters and they know each other.

The voucher is the answer, earned by buying 15 tickets rather than by abandoning a cart.
Crossing 15, 30 or 45 earns two seats one step better, on a later order:

```
from the Lower Bowl    two seats move up to the Club       $90 - $53  =  $37 a seat
already in the Club    two Club seats at Lower Bowl price  $90 - $53  =  $37 a seat
                                                             x 2 seats  =  $74
```

**A fan already buying Club seats is in the best seats in the ground**, so there's
nowhere to move them. Their step is the price instead — same one-tier gap, same $74.
Nothing comes off the cart they're holding, and the rule isn't published.

### What I didn't build

No sending — there's no CRM, so approving hands the marketer email and SMS text to
paste. No spend cap, because a person approves every offer with the price showing.
Nothing personalised past the segment, no multi-team version, no self-serve rules.

---

## Section B — Agent quality and failure plan

### How I'd know the offers are any good

Two things I can check today. Two I can't check until it's actually sending.

**Today — does it do what I said it should?**

I wrote down what each of the five carts should get, and why, before any agent ran. Then
I scored the agents against that, not the other way round. They match on all five: which
carts get an offer, which offer, and how the fan was read. That only works because I sat
and thought about five carts, so it can't grow past them.

Then the rules above, restated as arithmetic so they run on any day's carts with no
answers written in advance:

- the fan opted in to email
- nothing at all goes out under two hours
- a cart under 24 hours old gets a reminder, and nothing that costs money
- a cart over 24 hours old never gets just a reminder

Sixty test carts pass all four. **This is the part that would run every morning.**

**What neither of those tells me — whether the offers actually work.**

Both only prove the system does what I told it to. Neither says whether what I told it
was right. Two things would, and both need this to be sending for real.

**A control group.** Say we send a fan 10% off and they buy. Did the 10% do it? There's
no way to tell — plenty of them were going to buy anyway, and we handed them $14 for
nothing. So hold back a tenth of the fans who qualified, send them nothing, and compare
the two groups. The difference is what the discounts actually rescued. Without that,
every campaign looks like it works, including a bad one.

**The marketer's edits.** Every card has Approve, Edit and Reject on it. When a marketer
edits an offer before sending, they're telling us the agent got it wrong — and by picking
a different one, they're telling us what it should have been. Logging those clicks grades
the tool for free, with nobody doing extra work. If past buyers keep getting bumped from
10% to 15%, the rule about purchase history is wrong.

### What it costs to run

| step | model | why |
|---|---|---|
| Rules | none | consent and arithmetic don't need a model |
| Agents 1 and 2 | Haiku 4.5 | sorting into categories is what a small fast model is for |
| Agent 3 | Haiku, Sonnet for discounts and upgrades | pay more only where money leaves |

Measured, not estimated:

```
5 carts    3 cents
60 carts   34 cents   ->  34 / 60  =  0.57 cents a cart
```

### How it goes wrong

**The agents reason correctly from bad input.** Every step is sound and the answer looks
fine, because the mistake is in something nobody checked. That's the whole failure mode,
and it doesn't look like a failure.

Two from this build. The offer list priced a seat upgrade at `$0`, so the agents gave
them away. And the list of alternatives shown to Agent 3 left out the offer it was
reviewing, so it said *"the proposed 10% discount isn't even offered here"* and moved two
carts to the more expensive option.

Three things stop a bad offer reaching a fan:

1. A person approves every one, with the price and the reasoning on the card.
2. Agent 3 checks it without being told why Agent 2 picked it, so it judges the offer
   and not the argument for it.
3. If anything breaks, the cart holds and sends nothing.

---

## Section C — AI usage log

I built this with Claude Code. It wrote most of the code and the first draft of
the pricing; I decided what was true. Four interactions that changed the system.

### 1 · The seat upgrade priced at zero

**Asked for:** a price on every offer, so the agents could compare them.

**Got:** a catalog with the free seat upgrade at `$0` — "no cash, just seats."

**Rejected it.** A better seat is worth more than the one it replaces, and
someone else could have bought it. I had it work the number out:

```
give away 2 Lower Bowl seats   $53 x 2  =  $106
free up   2 Upper Deck seats   $35 x 2  =   $70
                                           ─────
the upgrade costs                            $36     10% off costs $7
```

$36 to rescue a $70 cart, against $7 for a discount. The "free" option was the
most expensive thing on the list, and it was being recommended because nothing
had priced it. Its own reviewer agent had been arguing this for hours and losing
to a menu that said `$0`. Once the prices were real, its agreement with my
hand-written answers went from 0% to 100%.

### 2 · Eleven thresholds with no source

**Asked:** where did this number come from? — about one item in a policy layer
it had built: a spending cap, a cooling-off window, a loyalty threshold, an
offer ladder.

**Got:** a 12% booking fee. This dataset has cart value, seats, section, ticket
history and an opt-in flag, and no fee. It had invented the rate, built an offer
on it, and that offer had become the recommended one.

**Rejected all eleven** — but tested first rather than arguing about which felt
reasonable. I had it sweep each threshold across its range against the five
carts and report what changed:

```
spending cap  20% of cart    same 5 decisions anywhere from 10% to 50%
staleness     14 days        nothing changes until 3 days
loyal fan     10 tickets     no change at any value from 3 to 30
```

Deleting all eleven changed one decision out of five, and made it cheaper. Three
chosen numbers are left: two hours, 15 tickets, two seats.

### 3 · An offer nothing could ever pick

**Asked:** what decides whether a fan gets 10% off or 15%?

**Got:** no answer, because nothing did. The offer list reserved 15% for a fan
"we have no evidence will ever come back", and the selection rule takes the
cheapest that works — but every fan matching that description qualified for 10%
too, so the cheaper one won every time. **Across sixty carts, 15% was never
chosen once.** I would have demoed it as a live option.

**Changed it** to something in the data rather than a threshold: never bought,
15%; bought before and stopped, 10%. Acquisition and reactivation are different
purchases. Sixty carts now: 21 tens, 6 fifteens.

### 4 · The four-stage architecture — kept

**Asked for:** a multi-agent design, and pushed back on the parts that looked
like decoration.

**Got:** deterministic rules, then three agents with typed handoffs — and two of
them deliberately blind. The one reading the fan is never told the cart value.
The one arguing against the offer is never told why it was chosen.

**Kept it, and it's the only thing that survived unchanged.** I deleted eleven
thresholds, an offer, a spend budget and a whole loyalty rule out of this build.
The blindness stayed because it kept paying: the reviewer caught a bad offer it
could not have caught if it had been shown a well-written reason for it, and the
analyst never had a cart value to bend its read toward.

### What these have in common

Three of the four were caught by asking where a number came from, not by reading
the output — the reasoning was sound every time, and it was reasoning from
something I hadn't checked. The fourth is the one I left alone, which is the
same judgement pointed the other way.
