import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { runPipeline } from "../lib/pipeline.ts";
import { getOffer } from "../lib/catalog.ts";

/**
 * Run the agents over a cart file and print what they decided.
 *
 *   node --env-file=.env.local scripts/run.mts
 *   node --env-file=.env.local scripts/run.mts --carts data/generated.json
 *   node --env-file=.env.local scripts/run.mts --save outputs/run.json
 *   node --env-file=.env.local scripts/run.mts --holdout 10
 */

const args = process.argv.slice(2);
const flag = (name: string) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : undefined;
};

const cartsPath = flag("carts") ?? "data/carts.json";
const savePath = flag("save");
const holdoutPercent = Number(flag("holdout") ?? 0);

const carts = JSON.parse(readFileSync(cartsPath, "utf8"));
console.log(
  `\nrunning ${carts.length} carts from ${cartsPath}${holdoutPercent ? ` (${holdoutPercent}% held back as a control group)` : ""}...\n`,
);

const result = await runPipeline(carts, { holdoutPercent });

const ICON = { offer: "OFFER  ", hold: "HOLD   ", blocked: "BLOCKED" } as const;

const verbose = carts.length <= 12 || args.includes("--verbose");

for (const d of verbose ? result.decisions : []) {
  const cart = carts.find((c: { cart_id: string }) => c.cart_id === d.cart_id);
  console.log(`${ICON[d.outcome]}  ${d.cart_id}`);
  if (d.read) {
    console.log(
      `           read: ${d.read.segment}, returns unaided: ${d.read.return_likelihood}`,
    );
  }
  if (d.outcome === "offer" && d.offer_id) {
    const offer = getOffer(d.offer_id)!;
    const given = offer.opportunityCost(cart);
    const price =
      (d.cost_usd ?? 0) === 0
        ? "free"
        : given > 0 && offer.cashCost(cart) === 0
          ? `$${d.cost_usd!.toFixed(2)} in seats given up`
          : `$${d.cost_usd!.toFixed(2)}`;
    console.log(`           ${d.headline}  (${price})`);
    if (d.review) console.log(`           reviewer: ${d.review.verdict}`);
  } else {
    console.log(`           ${d.headline}`);
  }
  for (const v of d.violations) console.log(`           !! ${v}`);
  console.log();
}

const m = result.meta;
console.log("─".repeat(72));
console.log(
  `  ${m.total} carts   ${m.offers} offers   ${m.holds} holds   ${m.blocked} blocked`,
);
console.log(
  `  would give up $${m.proposed_cost_usd.toFixed(2)} total ($${m.proposed_given_away_usd.toFixed(2)} of it seats rather than cash)`,
);
console.log(
  `  agents cost $${m.cost_usd.toFixed(4)} (${result.usage.input_tokens} in / ${result.usage.output_tokens} out) in ${(m.elapsed_ms / 1000).toFixed(1)}s`,
);
console.log("─".repeat(72));

const allViolations = [
  ...result.runViolations,
  ...result.decisions.flatMap((d) => d.violations),
];
if (allViolations.length) {
  console.log("\nINVARIANT VIOLATIONS — do not send this run:\n");
  for (const v of allViolations) console.log(`  !! ${v}`);
} else {
  console.log("\n  all invariants passed\n");
}

if (savePath) {
  mkdirSync(dirname(savePath), { recursive: true });
  writeFileSync(savePath, JSON.stringify(result, null, 2));
  console.log(`saved -> ${savePath}\n`);
}
