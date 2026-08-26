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

Each step only sees what the step before it produced. That stops one model deciding both
who the fan is and what they deserve.

---

## Section A — Written analysis

### The question

Most cart tools ask how to win the cart back. But the easiest carts were coming back
anyway, and the result won't tell you which ones. The fan buys, it looks like the offer
worked, and you paid for a sale you already had.

So this asks a different question. **Would this fan have come back on their own?** The
less likely that is, the more we give. Not the size of the cart. Not how loyal they are.

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

Seat prices come from the carts. `C-1002` is $140 for 4 Upper Deck seats, so Upper Deck
is $35. `C-1004` is $540 for 6 Club seats, so Club is $90. Lower Bowl works out at $53.

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
order. That's $74. It's owed rather than spent, so it never competes with the win-back
decision, and nothing comes off the cart they're holding. The rule isn't published.

### What I didn't build

No sending. There's no CRM, so approving hands the marketer email and SMS text to paste.
No spend cap, because a person approves every offer with the price showing. Nothing
personalised past the segment, no multi-team version, no self-serve rules.

---

## Section B — Agent quality and failure plan

### How I'd know the offers are any good

Four checks. Two of them scale.

**1. An answer key.** I wrote down what each of the five carts deserved, and why, before
any agent ran. `scripts/eval.mts` scores against it, and it gets 5 out of 5 on which
carts get an offer, which offer they get, and how the fan was read. The limit is that it
needs me to have labelled the carts, so it stops working past those five.

**2. Invariants.** Arithmetic checks that need no labels and run on any day's carts:

- consent is never broken
- nothing goes out under two hours
- the offer exists and is available for that cart
- nothing that costs money goes to a fan we read as coming back anyway
- nobody gets a bare reminder when a reminder won't move them
- the price the agent claimed matches the price we calculate

**This is the half that would run every morning.** Sixty generated carts pass.

Only things that are always wrong belong on that list. "Take the cheapest that works"
doesn't, because the agent is allowed to spend more if it says why. An alarm that goes
off on allowed behaviour teaches people to ignore alarms. That one prints on the card
instead — *$7.00 dearer than the cheapest thing that would work here* — next to the
reason.

**3. A holdout, once this actually sends.** Redemption rate counts the fans who were
coming back anyway. Hold a tenth back and the gap between the two groups is what the
offers really rescued. I took the code out, because nothing here sends yet.

**4. What the marketer clicks.** Every approve, edit and reject is a label. If four in
ten reminders come back rewritten, the reminder rule is wrong. It costs nothing and one
engineer can keep it running.

### What it costs to run

| step | model | why |
|---|---|---|
| Rules | none | consent and arithmetic don't need a model |
| Agents 1 and 2 | Haiku 4.5 | sorting into categories is what a small fast model is for |
| Agent 3 | Haiku, Sonnet when the offer costs money | pay more only where money leaves |

Measured: **3 cents for the five carts, 34 cents for sixty.** About half a cent each.

### How it could be wrong without showing

The agents reason correctly from bad input. Every step is sound and the answer looks
fine, because the mistake is in something nobody checked.

Two examples from this build. The catalog priced a seat upgrade at `$0`, so the agents
gave them away. And the reviewer's list of alternatives left out the offer it was
reviewing, so it said *"the proposed 10% discount isn't even offered here"* and moved two
carts to the dearer option.

What catches it:

- A person approves every offer, with the price and the reasoning on the card.
- Agent 3 never sees why the offer was chosen, so a good-sounding reason can't talk it
  round.
- Every check has something enforcing it. The old price cap was reported for three runs
  while the offers went through anyway, because nothing removed them from the menu.
- Numbers get tested. Sweeping one across its range shows whether it matters at all.
- It fails closed. Anything breaks, the cart holds.

---

## Section C — AI usage log

Claude Code wrote most of this and the first version of the pricing. My job was deciding
what was true. Four questions changed the system.

### 1. What does that actually cost us in dollars?

It kept recommending a free seat upgrade and calling it free. I asked what it cost the
club.

It said free. No cash, just seats.

That's wrong. A better seat is worth more than the one they had, and someone else could
have bought it. So I had it work out the number on a $70 cart:

```
give away 2 Lower Bowl seats   $53 x 2  =  $106
free up   2 Upper Deck seats   $35 x 2  =   $70
                                           ─────
the upgrade costs                            $36
10% off instead    $70 x 0.10  =              $7
```

The free option was the most expensive thing on the list. It was being recommended
because nothing had priced it.

The reviewer agent had been arguing against upgrades for hours and losing, because the
menu said $0. Once the prices were real it agreed with my answers every time.

I caught the same thing again later. The catalog was still telling the agents the seat
was *"likely going unsold"*, while the price underneath assumed it sold. Fixing a number
doesn't fix the sentence next to it.

### 2. Where did these numbers come from?

It had built a spending cap, a cooling-off window, a loyalty threshold and an offer
ladder. I asked where one of them came from.

A 12% booking fee. There is no fee in this data — there's cart value, seats, section,
ticket history and an opt-in flag. It had invented the rate, built an offer on top of it,
and that offer had become the recommended one. It had done the same earlier with
sell-through rates for each section.

Instead of arguing about which numbers felt reasonable, I had it test them. Every
threshold, swept across its range against the five carts:

```
share cap        0.2   →  same decisions anywhere from 0.10 to 0.50
staleness        14d   →  nearest change at 3 days
loyal fan     10t/60d  →  no change at any value from 3 tickets to 30
```

The cap changed nothing. The loyalty rule never fired at all. Deleting all eleven changed
one decision out of five, and made it cheaper.

Three numbers are left: two hours, 15 tickets, two seats.

### 3. What decides whether a fan gets 10% or 15%?

Nothing did.

The catalog said 15% was for a fan with no history. The selection rule says take the
cheapest that works. Every fan who fit the first also qualified for the cheaper one, so
10% won every time. **Across sixty carts, 15% was never chosen once.** I'd have shown it
as a live option.

Now it depends on whether the fan has bought before, which is a field in the data.
Bought and stopped, 10%. Never bought, 15%. Across sixty carts that's 21 and 6.

### 4. The club can't bleed money on these upgrades

The loyalty milestone was my idea. What came back upgraded the fan's whole party, on the
cart they were already holding. I asked what it cost.

$222 on one order. Three changes:

- **It's redeemed on a later order.** Nothing comes off the cart in hand. That mattered
  more than the money — he already had six seats in the basket and was going to pay for
  them, so upgrading those buys a sale the club already had.
- **It's capped at two seats**, so the cost doesn't depend on how big a group they booked.
- **The rule isn't announced.** Publish "every 15 tickets earns an upgrade" and it becomes
  a contract you have to honour forever, and someone works out that one cheap extra seat
  is worth $74.

$222 and $84 both became $74.

### What these have in common

None of them showed up in the output. The reasoning was sound every time. They were
caught by asking where a number came from, and then testing it.
