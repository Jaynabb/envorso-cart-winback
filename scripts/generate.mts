import { writeFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import type { CartFacts } from "../lib/schema.ts";

/**
 * Make more carts, so the checks aren't standing on five rows.
 *
 *   node scripts/generate.mts --n 60 --out data/generated.json
 *
 * These have no answer key and never will — nobody sat down and reasoned about
 * them, so scoring them against our judgement would be scoring them against
 * nothing. What they're for is the OTHER half of the evaluation: the invariants,
 * which need no labels and are the part that would actually run every morning.
 * Sixty carts through the rules is a much better test of the rules than five.
 *
 * Seeded, so the same command produces the same carts. A corpus that changes
 * under you can't tell you whether a prompt change helped.
 */

const args = process.argv.slice(2);
const flag = (name: string) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : undefined;
};

const n = Number(flag("n") ?? 60);
const out = flag("out") ?? "data/generated.json";
const seed = Number(flag("seed") ?? 20260824);

/** Mulberry32 — tiny, seeded, good enough for shaping test data. */
function rng(s: number) {
  return () => {
    s |= 0;
    s = (s + 0x6d2b79f5) | 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const rand = rng(seed);
const pick = <T,>(xs: T[]): T => xs[Math.floor(rand() * xs.length)];
const between = (lo: number, hi: number) => lo + Math.floor(rand() * (hi - lo + 1));

const SECTIONS = ["Upper Deck", "Lower Bowl", "Club"] as const;
/** Same prices the real carts imply — see SECTION_PRICE in lib/catalog.ts. */
const SEAT_PRICE: Record<string, number> = { "Upper Deck": 35, "Lower Bowl": 53, Club: 90 };

/**
 * Shaped rather than uniform, because uniform data doesn't look like a real
 * queue. Most carts are ordinary; the interesting rows — the brand new fan, the
 * long-lapsed one, the loyalist who wandered off mid-checkout — are the minority,
 * which is exactly the ratio that makes a rule hard to get right.
 */
type Shape = "first_timer" | "occasional" | "loyal" | "lapsed";
const SHAPES: { shape: Shape; weight: number }[] = [
  { shape: "occasional", weight: 40 },
  { shape: "loyal", weight: 25 },
  { shape: "lapsed", weight: 20 },
  { shape: "first_timer", weight: 15 },
];

function pickShape(): Shape {
  const total = SHAPES.reduce((n, s) => n + s.weight, 0);
  let roll = rand() * total;
  for (const s of SHAPES) {
    roll -= s.weight;
    if (roll <= 0) return s.shape;
  }
  return "occasional";
}

function history(shape: Shape): { lifetime: number; lastPurchase: number | null } {
  switch (shape) {
    case "first_timer":
      return { lifetime: 0, lastPurchase: null };
    case "occasional":
      return { lifetime: between(1, 8), lastPurchase: between(10, 170) };
    case "loyal":
      return { lifetime: between(10, 60), lastPurchase: between(2, 55) };
    case "lapsed":
      return { lifetime: between(1, 9), lastPurchase: between(200, 700) };
  }
}

const carts: CartFacts[] = [];
for (let i = 0; i < n; i++) {
  const shape = pickShape();
  const { lifetime, lastPurchase } = history(shape);
  const section = pick([...SECTIONS]);
  const seats = pick([1, 2, 2, 2, 3, 4, 4, 6]);

  // Spread across the whole window, weighted toward fresh — most carts a queue
  // sees on any morning were abandoned recently.
  const staleness = rand();
  const hours =
    staleness < 0.35
      ? between(1, 23) // inside the cooling-off window
      : staleness < 0.85
        ? between(24, 120)
        : between(121, 400);

  // Real prices wobble by row within a section rather than being one number.
  const perSeat = Math.round(SEAT_PRICE[section] * (0.85 + rand() * 0.4));

  carts.push({
    cart_id: `G-${String(2000 + i)}`,
    fan_id: `F-${String(between(100, 999))}`,
    seats,
    section,
    cart_value_usd: perSeat * seats,
    abandoned_hours_ago: hours,
    lifetime_tickets: lifetime,
    last_purchase_days_ago: lastPurchase,
    // A real list is mostly opted in, with a meaningful minority that isn't.
    email_opt_in: rand() > 0.18,
  });
}

mkdirSync(dirname(out), { recursive: true });
writeFileSync(out, JSON.stringify(carts, null, 2));

const counts = carts.reduce<Record<string, number>>((acc, c) => {
  const key =
    c.lifetime_tickets === 0
      ? "first-timer"
      : c.last_purchase_days_ago !== null && c.last_purchase_days_ago > 180
        ? "lapsed"
        : c.lifetime_tickets >= 10
          ? "loyal"
          : "occasional";
  acc[key] = (acc[key] ?? 0) + 1;
  return acc;
}, {});

console.log(`\nwrote ${n} carts -> ${out}  (seed ${seed})\n`);
for (const [k, v] of Object.entries(counts)) console.log(`  ${k.padEnd(12)} ${v}`);
console.log(`  ${"no opt-in".padEnd(12)} ${carts.filter((c) => !c.email_opt_in).length}`);
console.log(`  ${"under 24h".padEnd(12)} ${carts.filter((c) => c.abandoned_hours_ago < 24).length}`);
console.log();
