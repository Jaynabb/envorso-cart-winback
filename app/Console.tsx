"use client";

import { useMemo, useState } from "react";
import type { CartFacts, Decision } from "../lib/schema.ts";
import type { SendCopy } from "../lib/copy.ts";

/**
 * The marketer's surface.
 *
 * The job of this screen is to turn three agents' output into one decision a
 * person can make in a few seconds: send this, change this, or don't send it.
 * Everything on a card is in service of that — the offer and its price first,
 * the reason under it, and the reasoning chain folded away until someone
 * doesn't believe the answer.
 *
 * Nothing sends itself. Approving produces text a marketer pastes into their
 * own email client, because there is no CRM here and pretending otherwise would
 * make the tool useless on the Monday it's supposed to be used.
 */

interface Option {
  id: string;
  label: string;
  kind: string;
  cost: number;
  givenAway: number;
  describe: string;
}

interface Item {
  decision: Decision;
  cart: CartFacts;
  copy: SendCopy | null;
  options: Option[];
}

interface Meta {
  total: number;
  offers: number;
  holds: number;
  blocked: number;
  proposed_cost_usd: number;
  proposed_given_away_usd: number;
  elapsed_ms: number;
  cost_usd: number;
}

type Filter = "offer" | "hold" | "blocked" | null;
type Standing = { status: "approved" | "rejected" | null; offerId: string | null; copy: SendCopy | null };

export default function Console() {
  const [items, setItems] = useState<Item[] | null>(null);
  const [meta, setMeta] = useState<Meta | null>(null);
  const [running, setRunning] = useState(false);
  const [fatal, setFatal] = useState<string | null>(null);
  const [ranAt, setRanAt] = useState<string | null>(null);
  const [filter, setFilter] = useState<Filter>(null);
  const [standing, setStanding] = useState<Record<string, Standing>>({});
  const [editing, setEditing] = useState<string | null>(null);
  const [copied, setCopied] = useState<string | null>(null);

  async function run() {
    setRunning(true);
    setFatal(null);
    try {
      const res = await fetch("/api/run", { method: "POST" });
      const body = await res.json();
      if (!res.ok) {
        setFatal(body.error ?? `The run failed (${res.status}).`);
        return;
      }
      setItems(body.items);
      setMeta(body.meta);
      setStanding({});
      setRanAt(
        new Date().toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" }),
      );
    } catch (err) {
      setFatal(err instanceof Error ? err.message : String(err));
    } finally {
      setRunning(false);
    }
  }

  function decide(id: string, status: "approved" | "rejected" | null) {
    setStanding((s) => ({
      ...s,
      [id]: { ...(s[id] ?? { offerId: null, copy: null }), status },
    }));
    setEditing(null);
  }

  /** Swap the offer, then re-render the copy for it. Agents don't re-run. */
  async function pickOffer(item: Item, offerId: string) {
    const res = await fetch("/api/run", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ cart_id: item.cart.cart_id, offer_id: offerId }),
    });
    const body = await res.json();
    setStanding((s) => ({
      ...s,
      [item.cart.cart_id]: {
        status: s[item.cart.cart_id]?.status ?? null,
        offerId,
        copy: body.copy ?? null,
      },
    }));
  }

  async function copyText(key: string, text: string) {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(key);
      setTimeout(() => setCopied((c) => (c === key ? null : c)), 1600);
    } catch {
      // Clipboard blocked. The text is on screen and selectable, so this is a
      // convenience failing rather than the feature failing.
    }
  }

  const groups = useMemo(() => {
    if (!items) return null;
    return {
      offer: items.filter((i) => i.decision.outcome === "offer"),
      hold: items.filter((i) => i.decision.outcome === "hold"),
      blocked: items.filter((i) => i.decision.outcome === "blocked"),
    };
  }, [items]);

  /**
   * What the marketer has committed so far. Information, not a control —
   * counted from approvals rather than proposals, and from whatever offer is
   * currently selected, so swapping to a cheaper one moves it immediately.
   */
  const approvedCost = useMemo(() => {
    if (!items) return 0;
    return items.reduce((sum, i) => {
      const st = standing[i.cart.cart_id];
      if (st?.status !== "approved") return sum;
      const id = st.offerId ?? i.decision.offer_id;
      const opt = i.options.find((o) => o.id === id);
      return sum + (opt?.cost ?? 0);
    }, 0);
  }, [items, standing]);

  const approvedCount = Object.values(standing).filter((s) => s.status === "approved").length;

  const cardViolations = items?.flatMap((i) =>
    i.decision.violations.map((v) => `${i.cart.cart_id}: ${v}`),
  ) ?? [];
  const allViolations = cardViolations;

  return (
    <>
      <header className="masthead">
        <h1 className="wordmark">
          Envorso <span>·</span> Win-back
        </h1>
        <span className="masthead-sub">Seattle Seawolves · stale carts, last 7 days</span>
      </header>

      <div className="runbar">
        <button className="run" onClick={run} disabled={running}>
          {running ? "Reading carts…" : items ? "Run again" : "Review today's carts"}
        </button>
        {/* What the API call cost is an engineer's number, and this screen
            belongs to a marketer. The cost/model trade-off is argued in the
            README, where it's actually assessed, rather than parked on an
            operator's dashboard where nobody owns it. */}
        {ranAt && meta && (
          <span className="stamp">
            {ranAt} · {(meta.elapsed_ms / 1000).toFixed(1)}s
          </span>
        )}
        {meta && (
          <span className="spend">
            {approvedCount === 0 ? (
              <>
                if you approve everything: <b>${meta.proposed_cost_usd.toFixed(2)}</b>
                {meta.proposed_given_away_usd > 0 && (
                  <>
                    {" "}
                    (<b>${meta.proposed_given_away_usd.toFixed(2)}</b> of it seats, not cash)
                  </>
                )}
              </>
            ) : (
              <>
                approved <b>{approvedCount}</b> · <b>${approvedCost.toFixed(2)}</b> committed
              </>
            )}
          </span>
        )}
      </div>

      {fatal && <div className="fatal">{fatal}</div>}

      {allViolations.length > 0 && (
        <div className="violations">
          <span className="violations-title">
            Rules broken — do not send this run
          </span>
          <ul>
            {allViolations.map((v, i) => (
              <li key={i}>{v}</li>
            ))}
          </ul>
        </div>
      )}

      {!items && !fatal && (
        <p className="standin">
          In production this runs on a schedule and the queue is waiting when you sit
          down. Here it&apos;s a button. Nothing is sent to anyone without you
          approving it first.
        </p>
      )}

      {groups && meta && (
        <div className={`counters${filter ? " is-filtered" : ""}`}>
          <Counter
            n={meta.total}
            label="Carts"
            tone=""
            active={filter === null}
            onClick={() => setFilter(null)}
          />
          <span className="split" aria-hidden="true" />
          <Counter
            n={groups.offer.length}
            label="Offers"
            tone="offer"
            active={filter === "offer"}
            onClick={() => setFilter(filter === "offer" ? null : "offer")}
          />
          <Counter
            n={groups.hold.length}
            label="Held"
            tone="hold"
            active={filter === "hold"}
            onClick={() => setFilter(filter === "hold" ? null : "hold")}
          />
          <Counter
            n={groups.blocked.length}
            label="Blocked"
            tone="blocked"
            active={filter === "blocked"}
            onClick={() => setFilter(filter === "blocked" ? null : "blocked")}
          />
        </div>
      )}

      {groups && (
        <>
          <Section
            title="Needs your decision"
            items={groups.offer}
            show={!filter || filter === "offer"}
            render={(item) => (
              <Card
                key={item.cart.cart_id}
                item={item}
                standing={standing[item.cart.cart_id]}
                editing={editing === item.cart.cart_id}
                copied={copied}
                onEdit={() => setEditing(editing === item.cart.cart_id ? null : item.cart.cart_id)}
                onPick={(id) => pickOffer(item, id)}
                onDecide={(s) => decide(item.cart.cart_id, s)}
                onCopy={copyText}
              />
            )}
          />
          <Section
            title="Held — nothing goes out today"
            items={groups.hold}
            show={!filter || filter === "hold"}
            render={(item) => (
              <Card
                key={item.cart.cart_id}
                item={item}
                standing={standing[item.cart.cart_id]}
                editing={false}
                copied={copied}
                onEdit={() => {}}
                onPick={() => {}}
                onDecide={() => {}}
                onCopy={copyText}
              />
            )}
          />
          <Section
            title="Blocked — never reached the agents"
            items={groups.blocked}
            show={!filter || filter === "blocked"}
            render={(item) => (
              <Card
                key={item.cart.cart_id}
                item={item}
                standing={standing[item.cart.cart_id]}
                editing={false}
                copied={copied}
                onEdit={() => {}}
                onPick={() => {}}
                onDecide={() => {}}
                onCopy={copyText}
              />
            )}
          />
        </>
      )}
    </>
  );
}

function Counter({
  n,
  label,
  tone,
  active,
  onClick,
}: {
  n: number;
  label: string;
  tone: string;
  active: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      className={`counter${tone ? ` counter-${tone}` : ""}${active ? " is-active" : ""}${n === 0 ? " is-empty" : ""}`}
      onClick={onClick}
      aria-pressed={active}
      disabled={n === 0}
    >
      <span className="counter-n">{n}</span>
      <span className="counter-label">{label}</span>
    </button>
  );
}

function Section({
  title,
  items,
  show,
  render,
}: {
  title: string;
  items: Item[];
  show: boolean;
  render: (item: Item) => React.ReactNode;
}) {
  if (!show || items.length === 0) return null;
  return (
    <section>
      <div className="band">
        <span className="band-title">{title}</span>
        <span className="band-rule" />
        <span className="band-n">{items.length}</span>
      </div>
      {items.map(render)}
    </section>
  );
}

function Card({
  item,
  standing,
  editing,
  copied,
  onEdit,
  onPick,
  onDecide,
  onCopy,
}: {
  item: Item;
  standing?: Standing;
  editing: boolean;
  copied: string | null;
  onEdit: () => void;
  onPick: (offerId: string) => void;
  onDecide: (status: "approved" | "rejected" | null) => void;
  onCopy: (key: string, text: string) => void;
}) {
  const { decision: d, cart } = item;
  const isOffer = d.outcome === "offer";
  const status = standing?.status ?? null;

  const offerId = standing?.offerId ?? d.offer_id;
  const copy = standing?.copy ?? item.copy;
  const chosen = item.options.find((o) => o.id === offerId);

  const laneClass =
    d.outcome === "offer" ? "lane" : d.outcome === "hold" ? "lane lane-hold" : "lane lane-blocked";

  // One number, whichever kind of giving-away it is. The split is named in
  // the tooltip rather than shown as two figures the reader has to add up.
  const price = chosen
    ? chosen.cost === 0
      ? "costs nothing"
      : chosen.givenAway > 0 && chosen.cost === chosen.givenAway
        ? `$${chosen.cost.toFixed(2)} in seats`
        : `$${chosen.cost.toFixed(2)}`
    : null;

  return (
    <article className={`card is-${d.outcome}${status ? " is-decided" : ""}`}>
      <div className="card-head">
        <span className="cid">{cart.cart_id}</span>
        {d.read && (
          <span className={`seg seg-${d.read.segment}`}>
            {d.read.segment.replace("_", " ")}
          </span>
        )}
        <span className="facts">
          <b>{cart.seats}</b> in {cart.section} · <b>${cart.cart_value_usd.toFixed(0)}</b> ·{" "}
          {cart.lifetime_tickets} lifetime ·{" "}
          {cart.last_purchase_days_ago === null
            ? "never bought"
            : `bought ${cart.last_purchase_days_ago}d ago`}
        </span>
        <span className="head-spacer" />
        <span className="stale">{cart.abandoned_hours_ago}h stale</span>
      </div>

      <div className={laneClass}>
        <div className="lane-head">
          {/* Whatever is CURRENTLY selected, not what the agent first proposed.
              Showing the original after a marketer swapped it would have them
              approving one offer and sending another. */}
          <span className="offer-label">
            {isOffer ? (chosen?.describe ?? d.headline) : "No offer today"}
          </span>
          {isOffer && price && (
            <span className={`price${chosen && chosen.cost === 0 ? " price-free" : ""}`}>
              {price}
            </span>
          )}
        </div>
        <p className="lane-reason">
          {isOffer
            ? standing?.offerId && standing.offerId !== d.offer_id
              ? "Changed by you — the agents proposed something else. Their reasoning is under \u201cHow it got here\u201d."
              : (d.review?.objection ?? d.proposal?.reason ?? "")
            : d.headline}
        </p>
      </div>

      {/* Not a decision — a prompt. Holding a loyal fan is correct and leaves a
          blank, and a blank next to a first-timer's 15% is how a season-ticket
          holder hears that a stranger got a better deal. */}
      {d.operator_note && <p className="op-note">{d.operator_note}</p>}

      {d.violations.length > 0 && (
        <div className="card-violation">
          {d.violations.map((v, i) => (
            <div key={i}>{v}</div>
          ))}
        </div>
      )}

      {(d.read || d.proposal || d.review) && (
        <details className="chain">
          <summary>How it got here</summary>
          {d.read && (
            <div className="stage">
              <span className="stage-name">1 · Analyst — who is this?</span>
              <p className="stage-body">
                <b>{d.read.segment.replace("_", " ")}</b>, chance they finish on their own:{" "}
                <b>{d.read.return_likelihood}</b>. {d.read.evidence}
                {d.read.risk_flags.length > 0 && <> Flags: {d.read.risk_flags.join("; ")}.</>}
              </p>
            </div>
          )}
          {d.proposal && (
            <div className="stage">
              <span className="stage-name">2 · Strategist — what should we give them?</span>
              <p className="stage-body">
                Proposed <b>{d.proposal.offer_id}</b>. {d.proposal.reason}
              </p>
            </div>
          )}
          {d.review && (
            <div className="stage">
              <span className="stage-name">3 · Reviewer — should this really go out?</span>
              <p className="stage-body">
                <b className={`verdict-${d.review.verdict}`}>{d.review.verdict}</b>
                {d.review.replacement_offer_id && <> → {d.review.replacement_offer_id}</>}.{" "}
                {d.review.objection}
              </p>
            </div>
          )}
          {d.gate_reason && (
            <div className="stage">
              <span className="stage-name">0 · Policy — checked before any agent ran</span>
              <p className="stage-body">{d.gate_reason}</p>
            </div>
          )}
        </details>
      )}

      {isOffer && editing && (
        <div className="editor">
          <span className="editor-label">Send something else instead</span>
          <div className="options">
            {item.options
              .filter((o) => o.id !== "no_offer")
              .map((o) => (
                <button
                  key={o.id}
                  className={`opt${o.id === offerId ? " is-picked" : ""}`}
                  onClick={() => onPick(o.id)}
                >
                  {o.label} ·{" "}
                  {o.cost === 0 ? "free" : `$${o.cost.toFixed(2)}`}
                </button>
              ))}
          </div>
        </div>
      )}

      {isOffer && status === "approved" && copy && (
        <div className="send">
          <div className="send-head">
            <span className="send-title">Ready to send — email</span>
            <button
              className="copybtn"
              onClick={() => onCopy(`${cart.cart_id}-email`, `${copy.subject}\n\n${copy.email}`)}
            >
              {copied === `${cart.cart_id}-email` ? "Copied" : "Copy"}
            </button>
          </div>
          <div className="send-subject">
            <span>Subject:</span> {copy.subject}
          </div>
          <pre className="send-body">{copy.email}</pre>
          <div className="send-head" style={{ borderTop: "1px solid var(--rule)", borderBottom: "none" }}>
            <span className="send-title">SMS</span>
            <button className="copybtn" onClick={() => onCopy(`${cart.cart_id}-sms`, copy.sms)}>
              {copied === `${cart.cart_id}-sms` ? "Copied" : "Copy"}
            </button>
          </div>
          <pre className="send-body">{copy.sms}</pre>
        </div>
      )}

      {isOffer && (
        <div className="actions">
          {status === null ? (
            <>
              <button className="btn btn-approve" onClick={() => onDecide("approved")}>
                Approve
              </button>
              <button className="btn" onClick={onEdit}>
                {editing ? "Done editing" : "Edit offer"}
              </button>
              <button className="btn btn-reject" onClick={() => onDecide("rejected")}>
                Reject
              </button>
            </>
          ) : (
            <>
              <span className={`decided decided-${status}`}>
                {status === "approved" ? "Approved — copy is above" : "Rejected — nothing sent"}
              </span>
              <button className="undo" onClick={() => onDecide(null)}>
                undo
              </button>
            </>
          )}
        </div>
      )}
    </article>
  );
}
