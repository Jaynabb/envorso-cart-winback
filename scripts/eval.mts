import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { runPipeline, type RunResult } from "../lib/pipeline.ts";
import { getOffer } from "../lib/catalog.ts";

/**
 * Score the agents against the hand-written answer key.
 *
 *   node --env-file=.env.local scripts/eval.mts
 *   node --env-file=.env.local scripts/eval.mts --runs 5      (stability)
 *   node --env-file=.env.local scripts/eval.mts --from outputs/run.json
 *
 * Two kinds of check, and the second is the one that survives this dataset:
 *
 *   AGAINST THE KEY — did it reach the decision we reached, before it existed?
 *     Needs labels, so it only works on the five carts we sat down and reasoned
 *     about. Precise, and it does not scale.
 *
 *   INVARIANTS — does this run break a rule we can check with arithmetic?
 *     Needs no labels at all, works on any cart from any day, and is what would
 *     actually run in production every morning.
 */

const args = process.argv.slice(2);
const flag = (n: string) => {
  const i = args.indexOf(`--${n}`);
  return i >= 0 ? args[i + 1] : undefined;
};

const key = JSON.parse(readFileSync("eval/answer-key.json", "utf8"));
const carts = JSON.parse(readFileSync(flag("carts") ?? "data/carts.json", "utf8"));
const runs = Number(flag("runs") ?? 1);
const from = flag("from");

interface Score {
  outcome: { got: number; of: number };
  band: { got: number; of: number };
  preferred: { got: number; of: number };
  likelihood: { got: number; of: number };
  violations: string[];
  disagreements: string[];
  cost: number;
}

function score(result: RunResult): Score {
  const s: Score = {
    outcome: { got: 0, of: 0 },
    band: { got: 0, of: 0 },
    preferred: { got: 0, of: 0 },
    likelihood: { got: 0, of: 0 },
    violations: [],
    disagreements: [],
    cost: result.meta.cost_usd,
  };

  for (const d of result.decisions) {
    const expected = key.carts[d.cart_id];
    if (!expected) continue;

    s.outcome.of++;
    if (d.outcome === expected.expected_outcome) {
      s.outcome.got++;
    } else {
      s.disagreements.push(
        `${d.cart_id}: expected ${expected.expected_outcome}, got ${d.outcome} — ${d.headline}`,
      );
    }

    // Only meaningful where we said an offer was warranted.
    if (expected.expected_outcome === "offer") {
      s.band.of++;
      s.preferred.of++;
      if (d.offer_id && expected.acceptable_offer_ids.includes(d.offer_id)) {
        s.band.got++;
      } else if (d.offer_id) {
        s.disagreements.push(
          `${d.cart_id}: "${d.offer_id}" is outside the acceptable band [${expected.acceptable_offer_ids.join(", ")}]`,
        );
      }
      if (d.offer_id === expected.preferred_offer_id) s.preferred.got++;
    }

    if (expected.expected_return_likelihood.length && d.read) {
      s.likelihood.of++;
      if (expected.expected_return_likelihood.includes(d.read.return_likelihood)) {
        s.likelihood.got++;
      } else {
        s.disagreements.push(
          `${d.cart_id}: read as "${d.read.return_likelihood}" to return unaided, expected one of [${expected.expected_return_likelihood.join(", ")}]`,
        );
      }
    }

    s.violations.push(...d.violations.map((v) => `${d.cart_id}: ${v}`));
  }
  return s;
}

const pct = (g: number, o: number) => (o === 0 ? "  n/a" : `${Math.round((g / o) * 100)}%`.padStart(4));
const line = (label: string, p: { got: number; of: number }) =>
  `  ${label.padEnd(26)} ${String(p.got).padStart(2)}/${p.of}   ${pct(p.got, p.of)}`;

const results: Score[] = [];
for (let i = 0; i < runs; i++) {
  const result: RunResult = from
    ? JSON.parse(readFileSync(from, "utf8"))
    : await runPipeline(carts);
  results.push(score(result));
  if (runs > 1) process.stdout.write(`  run ${i + 1}/${runs} done\n`);
}

const last = results[results.length - 1];

console.log("\n" + "=".repeat(72));
console.log("  EVAL — against the hand-written answer key");
console.log("=".repeat(72));
console.log(line("outcome (offer/hold/block)", last.outcome));
console.log(line("offer within band", last.band));
console.log(line("matched our preferred", last.preferred));
console.log(line("return-likelihood read", last.likelihood));
console.log("=".repeat(72));

if (last.disagreements.length) {
  console.log("\nwhere it disagreed with us:\n");
  for (const d of last.disagreements) console.log(`  - ${d}`);
  console.log(
    "\n  Worth reading before assuming the agent is wrong — twice so far the key\n  was the thing that needed changing.",
  );
} else {
  console.log("\n  no disagreements.");
}

console.log("\n" + "-".repeat(72));
console.log("  INVARIANTS — no labels needed, these run on any day's carts");
console.log("-".repeat(72));
if (last.violations.length) {
  console.log("\n  VIOLATIONS — do not send this run:\n");
  for (const v of last.violations) console.log(`  !! ${v}`);
} else {
  console.log("\n  all invariants passed");
}

console.log(`\n  agent cost this run: $${last.cost.toFixed(4)}`);

if (runs > 1) {
  const outcomes = results.map((r) => `${r.outcome.got}/${r.outcome.of}`);
  const unique = [...new Set(outcomes)];
  console.log("\n" + "-".repeat(72));
  console.log(`  STABILITY across ${runs} runs`);
  console.log("-".repeat(72));
  console.log(`  outcome scores: ${outcomes.join(", ")}`);
  console.log(
    unique.length === 1
      ? "  Same every time on this dataset — but that's five carts, not a guarantee."
      : "  NOT identical between runs. Temperature 0 makes a model consistent, not\n  deterministic, so a single score is itself a sample.",
  );
  const costs = results.map((r) => r.cost);
  console.log(
    `  cost per run: $${Math.min(...costs).toFixed(4)}–$${Math.max(...costs).toFixed(4)}`,
  );
}

const savePath = flag("save");
if (savePath) {
  mkdirSync(dirname(savePath), { recursive: true });
  writeFileSync(savePath, JSON.stringify({ runs: results }, null, 2));
  console.log(`\nsaved -> ${savePath}`);
}
console.log();
