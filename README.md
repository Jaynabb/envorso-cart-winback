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

**The rules.** Seven, all fixed in code. An agent can't overrule any of them.

*Before any agent runs — can we contact this person at all?*

1. **No email opt-in, no contact.** `C-1003` stops here and never reaches an agent. You
   shouldn't need a language model to notice you don't have permission to email someone.
2. **Nothing under two hours old.** They may still be at the checkout, and "you left
   something behind" is the worst message to send someone typing in their card number.
   `C-1004` left an hour ago, so he waits.

*What the agents are allowed to choose from:*

3. **Coming back on their own?** Only the free options are on their menu. Spending money
   there buys a sale the club already had.
4. **And silence isn't one of those options.** If we can reach them and the cart is
   genuinely abandoned, they hear something. A reminder is free, so staying quiet saves
   nothing.
5. **Not coming back on their own?** Only the options that cost money. A reminder won't
   move someone who has been gone 300 days.
6. **Which discount is set by history, not by the agent.** Never bought before: 15%.
   Bought before and stopped: 10%.
7. **Nothing above them, nothing to upgrade to.** A fan already in the Club can't be
   moved up.

Plus one thing the club gives back rather than spends: crossing 15, 30 or 45 tickets
earns a voucher, two seats, one step up, on a later order.

The agents decide who the fan is, whether an offer is warranted at all, and which of the
options in front of them to use. A person approves every one before it goes anywhere.

---

## Section A — Written analysis

### The question

Most cart tools ask how to win the cart back. But the easiest carts were coming back
anyway, and the result won't tell you which ones. The fan buys, it looks like the offer
worked, and you paid for a sale you already had.

So this asks a different question. **Would this fan have come back on their own?** The
less likely that is, the more we give. Not the size of the cart. Not how loyal they are.

That answer decides one thing: whether the offer is allowed to cost anything. It does
not decide whether we talk to them at all. Those are two different decisions, and keeping
them apart is why "don't spend money on this fan" doesn't turn into "ignore this fan" —
a reminder is free, and it's roughly four in every ten things this system sends.

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

Which discount is set by history rather than by the agent, for a reason. Someone who
bought and stopped knows what a ticket costs and chose not to buy this time, so 10% is
the right first test of whether price is the problem. Someone who has never bought gets
15%, because that isn't a discount on a $140 cart — it's the club buying a supporter it
has no evidence about, and there's no cheaper way to price one.

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

Two things I can check today. Two I can't check until it's actually sending.

**Today — does it do what I said it should?**

I wrote down what each of the five carts should get, and why, before any agent ran. Then
I scored the agents against that, not the other way round. They match on all five: which
carts get an offer, which offer, and how the fan was read. That only works because I sat
and thought about five carts, so it can't grow past them.

Then six checks that need no answers written in advance, so they work on any day's carts:

- the fan opted in to email
- nothing goes out under two hours
- the offer is real and available for that cart
- nothing that costs money goes to a fan we read as coming back anyway
- nobody gets a bare reminder when a reminder won't move them
- the price the agent claimed matches the price we work out ourselves

Sixty test carts pass all six. **This is the part that would run every morning.**

**What neither of those tells me — whether the offers actually work.**

Both only prove the system does what I told it to. Neither says whether what I told it
was right. Two things would, and both need this to be sending for real.

**A control group.** Say we send a fan 10% off and they buy. Did the offer work? There's
no way to tell — plenty of them were going to buy anyway, and we just paid for it. So
hold back a tenth of the fans who qualified, send them nothing, and compare the two
groups. The difference is what the offers actually rescued. Without that, every campaign
looks like it works, including a bad one.

**The marketer's edits.** Every card has Approve, Edit and Reject on it. When a marketer
edits an offer before sending, they're telling us the agent got it wrong — and by picking
a different one, they're telling us what it should have been. Logging those clicks grades
the tool for free, with nobody doing extra work. If lapsed fans keep getting bumped from
10% to 15%, the rule about purchase history is wrong.

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
Bought and stopped, 10%. Never bought, 15%. On the last sixty-cart run that's 20 tens and
6 fifteens, where before the change it was 29 tens and no fifteens at all.

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

### 5. Why are we sending nothing to a fan who just got interrupted?

Asked what to do with `C-1001` — 14 tickets, walked away from a half-finished cart three
hours ago — it argued for silence. He's coming back on his own, so contacting him is
unnecessary.

That's a fair argument and it's not the call I'd make. He didn't change his mind three
hours ago, he got interrupted. A reminder costs the club nothing, so staying quiet
doesn't save anything — it just loses a sale we could have had.

What I changed wasn't the prompt. Arguing a model into agreeing with you isn't a policy,
it's a coincidence you have to rediscover every time the wording changes. It's a rule in
the code now: if we can reach them and the cart is genuinely abandoned, they hear
something. Whether it costs anything is what the read decides.

On the last sixty-cart run that's 18 reminders out of 44 offers — more than either
discount, and none of it costing a penny.

### What these have in common

None of them showed up in the output. The reasoning was sound every time. They were
caught by asking where a number came from, and then testing it.
