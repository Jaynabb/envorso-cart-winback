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
 */

const args = process.argv.slice(2);
const flag = (name: string) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : undefined;
};

const cartsPath = flag("carts") ?? "data/carts.json";
const savePath = flag("save");

const carts = JSON.parse(readFileSync(cartsPath, "utf8"));
console.log(`\nrunning ${carts.length} carts from ${cartsPath}...\n`);

const result = await runPipeline(carts);

const ICON = { offer: "OFFER  ", hold: "HOLD   ", blocked: "BLOCKED" } as const;

for (const d of result.decisions) {
  const cart = carts.find((c: { cart_id: string }) => c.cart_id === d.cart_id);
  console.log(`${ICON[d.outcome]}  ${d.cart_id}`);
  if (d.read) {
    console.log(
      `           read: ${d.read.segment}, returns unaided: ${d.read.return_likelihood}`,
    );
  }
  if (d.outcome === "offer" && d.offer_id) {
    const offer = getOffer(d.offer_id)!;
    const seats = offer.inventoryCost(cart);
    const price =
      (d.cost_usd ?? 0) > 0
        ? `$${d.cost_usd!.toFixed(2)} cash`
        : seats > 0
          ? `${seats} seats of inventory`
          : "free";
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
  `  would spend $${m.proposed_cash_usd.toFixed(2)} cash + ${m.proposed_inventory_seats} seats of inventory`,
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
