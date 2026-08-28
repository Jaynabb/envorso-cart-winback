import { NextResponse } from "next/server";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { runPipeline } from "../../../lib/pipeline.ts";
import {
  CATALOG,
  describeOffer,
  totalCost,
  upgradeTarget,
  SECTION_PRICE,
} from "../../../lib/catalog.ts";
import { buildCopy } from "../../../lib/copy.ts";
import type { CartFacts } from "../../../lib/schema.ts";

/**
 * Server-side run endpoint.
 *
 * This route exists so the API key never reaches the browser — the agents are
 * constructed inside this Node process and the console only ever sees decisions
 * over JSON. It also means the catalog, the policy and the copy templates are
 * evaluated in one place rather than duplicated client-side.
 */

function loadCarts(): CartFacts[] {
  const path = join(process.cwd(), "data", "carts.json");
  return JSON.parse(readFileSync(path, "utf8"));
}

export async function POST(request: Request) {
  try {
    const carts = loadCarts();

    // A re-run from the console can name the carts it wants — re-running one
    // held cart tomorrow shouldn't cost a full pass over the queue.
    const body = await request.json().catch(() => null);
    const ids: unknown = body && typeof body === "object" ? (body as { ids?: unknown }).ids : null;
    const queue =
      Array.isArray(ids) && ids.length > 0
        ? carts.filter((c) => new Set(ids.map(String)).has(c.cart_id))
        : carts;

    const isRetry = Array.isArray(ids) && ids.length > 0;
    const result = await runPipeline(queue, { isRetry });

    // Everything the console needs to render a card without re-deriving policy
    // in the browser: the cart it came from, what each catalog option would cost
    // for that cart, and the copy a marketer would send.
    const enriched = result.decisions.map((d) => {
      const cart = queue.find((c) => c.cart_id === d.cart_id)!;
      return {
        decision: d,
        cart,
        copy: d.offer_id ? buildCopy(cart, d.offer_id) : null,
        options: CATALOG.filter((o) => o.eligible(cart).ok).map((o) => ({
          id: o.id,
          label: o.label,
          kind: o.kind,
          cost: totalCost(o, cart),
          givenAway: o.opportunityCost(cart),
          // The same phrasing the agent's own headline uses, so a card can
          // describe whatever the marketer swapped to instead of stubbornly
          // showing what the agent proposed.
          describe: describeOffer(o.id, cart),
          // An upgrade is the one offer whose price isn't obvious from its
          // name — "free seat upgrade" next to $36 invites the question, so
          // the card can show the two lines that make up the number.
          upgrade:
            o.kind === "upgrade" && upgradeTarget(cart.section)
              ? {
                  to: upgradeTarget(cart.section)!,
                  givenPerSeat: SECTION_PRICE[upgradeTarget(cart.section)!],
                  freedPerSeat: Math.round((cart.cart_value_usd / cart.seats) * 100) / 100,
                }
              : null,
        })),
      };
    });

    return NextResponse.json({
      items: enriched,
      meta: result.meta,
    });
  } catch (err) {
    // Something structural — the cart file is missing or unreadable. Return a
    // real status and a readable message rather than an opaque 500.
    const message = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

/** Re-generate copy after a marketer swaps the offer, without re-running agents. */
export async function PUT(request: Request) {
  try {
    const { cart_id, offer_id, percent } = (await request.json()) as {
      cart_id: string;
      offer_id: string;
      percent?: number;
    };
    const cart = loadCarts().find((c) => c.cart_id === cart_id);
    if (!cart) return NextResponse.json({ error: "Unknown cart" }, { status: 404 });
    return NextResponse.json({ copy: buildCopy(cart, offer_id, percent) });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
