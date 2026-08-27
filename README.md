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
Each one only sees what the step before it produced, which stops a single model deciding
both who the fan is and what they deserve.

**There are two rules, and that's all of them.**

1. **No email opt-in, no contact.** `C-1003` stops here and never reaches an agent. You
   shouldn't need a language model to notice you don't have permission to email someone.
2. **Nothing under two hours old.** They may still be at the checkout, and "you left
   something behind" is the worst message to send someone typing in their card number.
   `C-1004` left an hour ago, so he waits.

Everything after that is the agents, and a person approves whatever they come up with.

---

## Section A — Written analysis

### The question

Most cart tools ask how to win the cart back. But the easiest carts were coming back
anyway, and the result won't tell you which ones. The fan buys, it looks like the offer
worked, and you paid for a sale you already had.

So this asks a different question. **Would this fan have come back on their own?** The
less likely that is, the more we give. Not the size of the cart. Not how loyal they are.

That answer decides one thing: whether the offer is allowed to cost anything. A fan who
was coming back anyway gets something free — a reminder costs the club nothing, so
staying quiet saves nothing either. A fan who wasn't gets something that costs money,
because a reminder won't move someone who has been gone 300 days.

| cart | | what happens |
|---|---|---|
| `C-1004` | $540 Club, 40 tickets, left 1 hour ago | nothing yet |
| `C-1001` | 14 tickets, bought 21 days ago, left 3 hours ago | reminder, free |
| `C-1002` | never bought, 4 seats, $140, 26 hours | 15% off · 140 × 0.15 = **$21** |
| `C-1005` | one ticket 300 days ago, $70, cold 4 days | 10% off · 70 × 0.10 = **$7** |
| `C-1003` | no email opt-in | blocked |

`C-1004` is the trap. Biggest cart on the page, and the most likely person on it to
finish by himself.

### What the offers cost

Seat prices come from the carts:

```
Upper Deck   C-1002    $140 / 4 seats  =  $35
Club         C-1004    $540 / 6 seats  =  $90
Lower Bowl   C-1001     $96 / 2 seats  =  $48   midpoint
             C-1003     $58 / 1 seat   =  $58     $53
```

There are five options: nothing, a reminder, a free seat upgrade, 10% off, 15% off. The
agent picks one by name and can't invent others.

The rule is take the cheapest one that would work. It has to be in dollars, because a
free upgrade is not free — it hands over a better seat and takes back a cheaper one:

```
C-1005 — 2 Upper Deck seats, $70 cart
  give away 2 Lower Bowl    $53 x 2 = $106
  free up   2 Upper Deck    $35 x 2 =  $70
                                      ─────
  upgrade costs                         $36
  10% off       $70 x 0.10  =            $7
```

The upgrade costs five times the discount, so it rarely wins.

Which discount depends on whether the fan has bought before. Someone who bought and
stopped gets 10%: they know what a ticket costs and chose not to buy, so the smaller one
tests whether price is the problem. Someone who has never bought gets 15%, because that
is the club buying a supporter rather than discounting a cart.

### Loyalty

A loyal fan correctly gets no offer, because they were coming back anyway. That leaves
them with nothing while a stranger gets 15% off. This club has a few thousand supporters
and they know each other.

So crossing 15, 30 or 45 tickets earns a voucher: two seats, one step up, on a later
order. One step up from the Lower Bowl is the Club:

```
Club seat            $90
Lower Bowl seat      $53
                     ────
one step             $37   x 2 seats  =  $74
```

It's owed rather than spent, so it never competes with the win-back decision, and nothing
comes off the cart they're holding. The rule isn't published.

### What I didn't build

No sending. There's no CRM, so approving hands the marketer email and SMS text to paste.
No spend cap, because a person approves every offer with the price showing. Nothing
personalised past the segment, no multi-team version, no self-serve rules.

---

## Section B — Agent quality and failure plan

### How I'd know the offers are any good

Four ways, and they answer different questions. Only two of them keep working once this
is real.

**Today — grade it against answers I wrote first.** Before any agent ran, I wrote down
what each of the five carts should get and why. Then I scored the agents against that,
not the other way round. `scripts/eval.mts` does it and they match on all five: which
carts get an offer, which offer, and how the fan was read.

That only works because I sat and thought about five carts. It can't grow.

**Every morning — six checks that need nobody.** These are arithmetic, so they run on any
day's carts with no answers written in advance:

- the fan opted in to email
- nothing goes out under two hours
- the offer is real and available for that cart
- nothing that costs money goes to a fan we read as coming back anyway
- nobody gets a bare reminder when a reminder won't move them
- the price the agent claimed matches the price we work out ourselves

Sixty test carts pass all six. **This is the part that would actually run in
production.** The answer key is for building it; these are for operating it.

**Once it's sending — hold ten percent back.** If we send an offer and the fan buys, that
looks like a win, but some of those fans were buying anyway. The only honest number is
the difference between the fans we contacted and a group we deliberately didn't. There's
no code for this yet, because nothing sends yet — approving hands the marketer text to
paste.

**Always — watch what the marketer does.** Every approve, edit and reject is a verdict on
the agent. If four in ten reminders come back rewritten, the reminder rule is wrong. It
costs nothing to collect and one engineer can keep it running.

### What it costs to run

| step | model | why |
|---|---|---|
| Rules | none | consent and arithmetic don't need a model |
| Agents 1 and 2 | Haiku 4.5 | sorting into categories is what a small fast model is for |
| Agent 3 | Haiku, Sonnet when the offer costs money | pay more only where money leaves |

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

Five things stop a bad offer reaching a fan:

1. A person approves every one, with the price and the reasoning on the card.
2. Agent 3 never sees why the offer was chosen, so a good-sounding reason can't talk it
   round.
3. Every check has something enforcing it. An old price cap was reported for three runs
   while the offers went out anyway, because nothing removed them from the offer list.
4. Numbers get tested rather than defended. Sweeping one across its range shows whether
   it changes any answer at all.
5. It fails closed. Anything breaks, the cart holds and sends nothing.

---

## Section C — AI usage log

Claude Code wrote most of this and the first version of the pricing. My job was deciding
what was true. Four questions changed the system.

### 1. What does that actually cost us in dollars?

It kept recommending a free seat upgrade and calling it free. I asked what it cost the
club.

It said free. No cash, just seats.

That's wrong. A better seat is worth more than the one they had, and someone else could
have bought it. So I had it work out the number.

Seat prices come from the carts themselves. `C-1002` is a $140 cart with 4 Upper Deck
seats, so Upper Deck is 140 ÷ 4 = $35. `C-1004` is $540 for 6 Club seats, so Club is
540 ÷ 6 = $90. Two carts have Lower Bowl seats — $96 for 2 and $58 for 1, so $48 and $58
— and I take the midpoint, $53.

`C-1005` is 2 Upper Deck seats, a $70 cart. Upgrading them to the Lower Bowl:

```
give away 2 Lower Bowl seats   $53 x 2  =  $106
free up   2 Upper Deck seats   $35 x 2  =   $70
                                           ─────
the upgrade costs                            $36

10% off instead                $70 x 0.10  =  $7
```

$36 to rescue a $70 cart, against $7 for a discount — five times the price. The free
option was the most expensive thing on the list. It was being recommended because nothing
had priced it.

Agent 3 had been arguing against upgrades for hours and losing, because the offer list
said $0. Once the prices were real it agreed with my answers every time.

I caught the same thing again later. The offer list was still telling the agents the seat
was *"likely going unsold"*, while the price underneath assumed it sold. Fixing a number
doesn't fix the sentence next to it.

### 2. Where did these numbers come from?

It had built a spending cap, a cooling-off window, a loyalty threshold and an offer
ladder. I asked where one of them came from.

A 12% booking fee. There is no fee in this data — there's cart value, seats, section,
ticket history and an opt-in flag. It had invented the rate, built an offer on top of it,
and that offer had become the recommended one. It had done the same earlier with
sell-through rates for each section.

Instead of arguing about which numbers felt reasonable, I had it test them. It re-ran
the five carts at every value in each threshold's plausible range, and reported which
decisions changed:

```
spending cap    set to 20% of cart   same 5 decisions anywhere from 10% to 50%
staleness       set to 14 days       nothing changes until 3 days
loyal fan       10 tickets / 60 days no change at any value from 3 tickets to 30
```

The cap changed nothing. The loyalty rule never fired at all, because Agent 1 had already
read those fans off their real purchase history. Deleting all eleven changed one decision
out of five, and made that one cheaper.

Three chosen numbers are left: two hours, 15 tickets, two seats. Everything else is a
seat price read off the carts.

### 3. What decides whether a fan gets 10% or 15%?

Nothing did.

The offer list said 15% was for a fan with no history. The selection rule says take the
cheapest that works. Every fan who fit the first also qualified for the cheaper one, so
10% won every time. **Across sixty carts, 15% was never chosen once.** I'd have shown it
as a live option.

Now it depends on whether the fan has bought before, which is a field in the data.
Bought and stopped, 10%. Never bought, 15%. Across sixty carts that's 21 tens and 6
fifteens, where before it was 29 tens and no fifteens at all.

### 4. The club can't bleed money on these upgrades

The loyalty milestone was my idea. What came back upgraded the fan's whole party, on the
cart they were already holding. I asked what it cost.

It was pricing every seat in the cart. `C-1004` has 6 Club seats and is already in the
top section, so his reward is a price drop instead of a move:

```
Club seat            $90
Lower Bowl seat      $53
                     ────
one step             $37   x 6 seats  =  $222
```

$222 on one order. Three changes:

- **It's redeemed on a later order.** Nothing comes off the cart in hand. That mattered
  more than the money — he already had six seats in the basket and was going to pay for
  them, so upgrading those buys a sale the club already had.
- **It's capped at two seats**, so the cost doesn't depend on how big a group they booked.
- **The rule isn't announced.** Publish "every 15 tickets earns an upgrade" and it becomes
  a contract you have to honour forever, and someone works out that one cheap extra seat
  is worth $74.

Capped at two seats, that same $37 step is $37 × 2 = **$74**. `C-1001`'s upgrade came
down the same way: it was being priced off what he'd paid per seat, 96 ÷ 2 = $48, so
($90 − $48) × 2 = $84. Priced off the section instead, it's $74 as well. One step is one
step, whoever is buying.

### What these have in common

None of them showed up in the output. The reasoning was sound every time. They were
caught by asking where a number came from, and then testing it.
