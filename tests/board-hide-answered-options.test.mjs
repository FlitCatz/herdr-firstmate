// Regression tests ensuring Kanban hides decision choices and answer buttons on done cards even when
// historical hold_reason / hold_kind metadata remains intact in the backlog record.
// Run with: node --test tests/board-hide-answered-options.test.mjs
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import vm from "node:vm";

const root = new URL("..", import.meta.url);
const snapshotFile = new URL("tests/fixtures/snapshot.json", root).pathname;
const baseSnapshot = JSON.parse(await readFile(snapshotFile, "utf8"));
const HOME = baseSnapshot.fm_home;

function element() {
  const node = { id: null, click: null, hover: null, keyDown: null, kids: [], calls: [] };
  const self = new Proxy(node, {
    get(target, name) {
      if (name === "node") return target;
      return (...args) => {
        if (!["child", "children", "trigger", "content", "when", "id", "on_click"].includes(name)) target.calls.push([name, ...args]);
        if (name === "id") target.id = args[0];
        else if (name === "on_click") target.click = args[0];
        else if (name === "on_hover") target.hover = args[0];
        else if (name === "on_key_down") target.keyDown = args[0];
        else if (name === "child" || name === "trigger" || name === "content") target.kids.push(args[0]);
        else if (name === "children") target.kids.push(...args[0]);
        else if (name === "when" && args[0]) args[1](self);
        return self;
      };
    },
  });
  return self;
}

function drawn(tree) {
  const out = [];
  const walk = (kid, collectIds) => {
    if (kid === null || kid === undefined) return "";
    if (typeof kid !== "object") return String(kid);
    const { id, click, hover, keyDown, kids, calls } = kid.node;
    const childIds = [];
    if (id !== null && collectIds) collectIds.push(id);
    const entry = id === null ? null : { id, click, hover, keyDown, calls, childIds, text: "" };
    if (entry) out.push(entry);
    const text = kids.map((k) => walk(k, entry ? childIds : collectIds)).filter(Boolean).join(" ");
    if (entry) entry.text = text;
    return text;
  };
  walk(tree, null);
  return out;
}

function cloneSnapshot() {
  return structuredClone(baseSnapshot);
}

async function mountBoard({ snapshot = cloneSnapshot(), ui = {} } = {}) {
  const source = (await readFile(new URL("mods/fm-board/main.js", root), "utf8"))
    .replace(/^import .*;$/gm, "").replace("export default class FmBoard", "class FmBoard");
  const pending = [];
  const focused = [];
  const drafts = [];
  const cx = {
    notify() {},
    stop_propagation() {},
    spawn(fn) { pending.push(fn(cx)); },
    timer: { every() {}, after() {} },
    focus_handle() {
      const handle = { focus() { focused.push(handle); }, is_focused: () => focused.at(-1) === handle, release: () => true };
      return handle;
    },
  };
  const input = (opts = {}) => {
    let text = opts.value ?? "";
    const listeners = {};
    return {
      on(ev, fn) { (listeners[ev] ??= []).push(fn); },
      emit(ev) { for (const fn of listeners[ev] ?? []) fn({}, cx); },
      value: () => text,
      set_value(v) { text = v; },
    };
  };
  const theme = new Proxy({}, { get: () => "#808080" });
  const scope = {
    View: class {}, div: element, svg: element, v_flex: element, h_flex: element, Input: { new: element },
    h_resizable: element, resizable_panel: element,
    Popover: { new: (popId) => element().popover_id(popId) },
    InputState: { new: input },
    ScrollHandle: { new: () => ({ scroll_to_item() {} }) },
    FolderViewer: class { constructor() { this.root = null; } close() { this.root = null; } },
    props: () => ({ home: HOME, snapshot_file: snapshotFile, collapsed: [], ui }),
    checking: () => false,
    theme: () => theme,
    settings: () => ({ font_size: 14 }),
    terminals: () => [],
    focused: () => null,
    nextCommand: () => Promise.resolve(null),
    run: () => {},
    layout: () => null,
    setShared: () => {},
    appHome: () => "/fictional/herdr-home",
    localStorage: { getItem: () => null, setItem() {} },
    readTextFile: async (file) => {
      if (file === snapshotFile) return JSON.stringify(snapshot);
      if (file === `${HOME}/data/projects.md`) {
        return "- maple-workshop - Fictional project.\n- orchard-atlas - Fictional project.\n";
      }
      throw new Error(`no such file: ${file}`);
    },
    exec: async () => ({ code: 1, stdout: "", stderr: "" }),
    watchFolder: () => new Promise(() => {}),
    pickFolder: async () => null,
  };
  const { FmBoard, cardsFrom } = vm.runInNewContext(`${source}\n({ FmBoard, cardsFrom })`, scope);
  const view = new FmBoard();
  view.init({}, cx);
  await Promise.all(pending);
  assert.equal(view.error, null);
  view.insertCardText = (text) => drafts.push(text);
  let items = drawn(view.render(cx));
  const click = (id) => {
    const item = items.find((x) => x.id === id);
    assert.ok(item?.click, `nothing to click at ${id}`);
    item.click({}, cx);
    items = drawn(view.render(cx));
    return items;
  };
  return {
    view,
    cardsFrom,
    drafts,
    get items() { return items; },
    get ids() { return items.map((x) => x.id); },
    text: (id) => items.find((x) => x.id === id)?.text ?? "",
    click,
  };
}

function makeDoneTemplate(snap) {
  return structuredClone(snap.backlog.records.find((r) => r.id === "orchard-seed-data"));
}

test("pending held decisions and open worker decisions keep their choices and answer drafts", async () => {
  const b = await mountBoard();
  // Active standalone hold in Held column
  assert.ok(b.ids.includes("card-maple-icon-set"));
  assert.ok(b.ids.includes("opt-card:maple-icon-set-A"));
  assert.ok(b.ids.includes("opt-card:maple-icon-set-B"));
  assert.match(b.text("card-maple-icon-set"), /Recommended: A/);
  // Active topic-grouped hold in Held column
  assert.ok(b.ids.includes("group-preview-style"));
  assert.ok(b.ids.includes("opt-group:preview-style-A"));
  assert.ok(b.ids.includes("opt-group:preview-style-B"));
  // Active worker open decision in Parked column
  assert.ok(b.ids.includes("open-maple-button-labels-0"));
  assert.ok(b.ids.includes("opt-open-maple-button-labels-0-A"));

  b.click("opt-card:maple-icon-set-A");
  b.click("opt-group:preview-style-B");
  b.click("opt-open-maple-button-labels-0-A");
  assert.deepEqual(b.drafts, [
    "[Board answer] maple-icon-set: A (Rounded)",
    "[Board answer] maple-tour-sketch, maple-empty-state: B (Bright)",
    "[Board answer] maple-button-labels [key=default]: A (Verbs)",
  ]);
});

test("done cards with retained hold_reason options stay visible without choices, answer buttons, or topic boxes", async () => {
  const snap = cloneSnapshot();
  const baseDone = makeDoneTemplate(snap);
  const doneStandalone = {
    ...baseDone,
    id: "maple-ideas-adopt",
    title: "Adopt whiteboard design notes",
    repo: "maple-workshop",
    kind: "captain",
    state: "done",
    checked: true,
    done: "2026-11-11",
    completion: { date: "2026-11-11", verb: "done" },
    hold_kind: "captain",
    hold_reason: "Which notes enter backlog? | A: Adopt top three | B: Keep scratchpad | Recommended: A",
    hold_bucket: null,
    captain_actionable: false,
    order: 90,
  };
  const doneTopic = {
    ...baseDone,
    id: "orchard-scope-allow",
    title: "Allow promo review scope",
    repo: "orchard-atlas",
    kind: "captain",
    state: "done",
    checked: true,
    done: "2026-11-11",
    completion: { date: "2026-11-11", verb: "done" },
    hold_kind: "captain",
    hold_reason: "[topic=promo-scope] Allow automated promo scope? | A: Allow narrow | B: Manual only | Recommended: A",
    hold_bucket: null,
    captain_actionable: false,
    order: 91,
  };
  // Counterexample: done card with retained options even when hold_kind is null
  const doneNoKind = {
    ...baseDone,
    id: "maple-done-nokind",
    title: "Done record with hold_reason only",
    repo: "maple-workshop",
    kind: "ship",
    state: "done",
    checked: true,
    done: "2026-11-11",
    completion: { date: "2026-11-11", verb: "done" },
    hold_kind: null,
    hold_reason: "Pick format | A: Compact | B: Full | Recommended: A",
    hold_bucket: null,
    captain_actionable: false,
    order: 92,
  };
  snap.backlog.records.push(doneStandalone, doneTopic, doneNoKind);
  const beforeHistory = JSON.stringify([doneStandalone, doneTopic, doneNoKind]);

  const b = await mountBoard({ snapshot: snap });

  for (const id of ["maple-ideas-adopt", "orchard-scope-allow", "maple-done-nokind"]) {
    const card = b.view.cards.find((c) => c.id === id);
    assert.equal(card.column, "done");
    assert.equal(card.decision, null, `${id} should not keep an active decision`);
    assert.ok(b.ids.includes(`card-${id}`), `${id} card itself stays visible in Done`);
    assert.deepEqual(
      b.ids.filter((x) => x.startsWith(`opt-card:${id}-`)),
      [],
      `${id} must not render option rows`,
    );
    const txt = b.text(`card-${id}`);
    assert.doesNotMatch(txt, /Adopt top three|Keep scratchpad|Allow narrow|Manual only|Compact|Full/);
    assert.doesNotMatch(txt, /Recommended:/);
    assert.doesNotMatch(txt, /\| A:/);
  }
  // Done card with [topic=...] must not create a topic box in Done.
  assert.ok(!b.ids.includes("group-promo-scope"));
  assert.deepEqual(b.ids.filter((x) => x.startsWith("opt-group:promo-scope-")), []);

  // Pending held cards and NEXT MOVE remain unaffected.
  assert.ok(b.ids.includes("opt-card:maple-icon-set-A"));
  assert.ok(b.ids.includes("next-opt-A"));

  // Underlying backlog history in the snapshot is untouched.
  assert.equal(JSON.stringify([doneStandalone, doneTopic, doneNoKind]), beforeHistory);
});

test("released holds stay unanswerable while pending holds keep their choices in and out of Held", async () => {
  const snap = cloneSnapshot();
  const baseDone = makeDoneTemplate(snap);
  const workerTemplate = structuredClone(snap.tasks.find((t) => t.id === "maple-preview-screen"));
  const working = (id, detail) => ({
    ...workerTemplate,
    id,
    current_state: { state: "working", source: "pane", detail, raw: "state: working", observed_at: "2026-11-11T05:00:00Z", freshness: "fresh" },
    hints: { pending_decision: false, blocked_event: false, open_decisions: [], scout_report_present: false, last_event_text: `working: ${detail}` },
  });
  const pending = { checked: false, done: null, completion: { date: null, verb: null } };

  // `tasks-axi unhold` removes the hold text, so a released record carries no hold_reason or hold_kind.
  snap.backlog.records.push(
    {
      ...baseDone, ...pending,
      id: "maple-released-queued",
      title: "Ship palette release",
      repo: "maple-workshop",
      kind: "ship",
      state: "queued",
      current_role: "queued",
      hold_kind: null,
      hold_reason: null,
      hold_bucket: null,
      captain_actionable: false,
      order: 93,
    },
    {
      ...baseDone, ...pending,
      id: "maple-released-working",
      title: "Roll out preview banner",
      repo: "maple-workshop",
      kind: "ship",
      state: "in_flight",
      current_role: "worker",
      hold_kind: null,
      hold_reason: null,
      hold_bucket: null,
      captain_actionable: false,
      order: 94,
    },
  );
  snap.tasks.push(working("maple-released-working", "implementing rollout"));

  // A deferral whose date has passed keeps its hold text and remains answerable.
  snap.backlog.records.push({
    ...baseDone, ...pending,
    id: "orchard-expired-deferral",
    title: "Pick the tile cache size",
    repo: "orchard-atlas",
    kind: "captain",
    state: "queued",
    current_role: "queued",
    hold_kind: "captain",
    hold_reason: "Pick the tile cache size | A: Small | B: Large | Recommended: B",
    hold_bucket: "live",
    hold_until: "2026-11-01",
    captain_actionable: true,
    order: 95,
  });

  // The captain can hold a task already in flight: it keeps its hold text in In flight.
  snap.backlog.records.push({
    ...baseDone, ...pending,
    id: "maple-held-in-flight",
    title: "Tune preview spacing",
    repo: "maple-workshop",
    kind: "ship",
    state: "in_flight",
    current_role: "held",
    hold_kind: "captain",
    hold_reason: "Which spacing scale? | A: Four point | B: Eight point | Recommended: B",
    hold_bucket: "live",
    captain_actionable: true,
    order: 96,
  });
  snap.tasks.push(working("maple-held-in-flight", "adjusting spacing"));

  // Set-aside Todo work keeps its options as plain text until it is brought back.
  snap.backlog.records.push({
    ...baseDone, ...pending,
    id: "maple-future-options",
    title: "Revisit onboarding copy",
    repo: "maple-workshop",
    kind: "ship",
    state: "queued",
    current_role: "queued",
    hold_kind: "future",
    hold_reason: "Revisit tone later | A: Brief | B: Detailed | Recommended: A",
    hold_bucket: null,
    captain_actionable: false,
    order: 97,
  });

  const b = await mountBoard({ snapshot: snap });
  const option = (id) => b.items.find((x) => x.id === id);

  assert.equal(b.view.cards.find((c) => c.id === "maple-released-queued").column, "queued");
  assert.equal(b.view.cards.find((c) => c.id === "maple-released-working").column, "working");
  for (const id of ["maple-released-queued", "maple-released-working"]) {
    assert.ok(b.ids.includes(`card-${id}`));
    assert.deepEqual(b.ids.filter((x) => x.startsWith(`opt-card:${id}-`)), []);
  }
  assert.match(b.text("card-maple-released-working"), /implementing rollout/);
  assert.equal(b.view.waitingHolds().some((c) => c.id.startsWith("maple-released-")), false);

  assert.equal(b.view.cards.find((c) => c.id === "orchard-expired-deferral").column, "held");
  b.click("opt-card:orchard-expired-deferral-B");
  assert.deepEqual(b.drafts, ["[Board answer] orchard-expired-deferral: B (Large)"]);

  assert.equal(b.view.cards.find((c) => c.id === "maple-held-in-flight").column, "working");
  assert.match(b.text("card-maple-held-in-flight"), /Which spacing scale\?/);
  assert.match(b.text("card-maple-held-in-flight"), /Four point.*Eight point.*Recommended: B/);
  assert.equal(option("opt-card:maple-held-in-flight-A")?.click, null);

  assert.equal(b.view.cards.find((c) => c.id === "maple-future-options").column, "todo");
  assert.match(b.text("card-maple-future-options"), /Revisit tone later/);
  assert.match(b.text("card-maple-future-options"), /Brief.*Detailed.*Recommended: A/);
  assert.equal(option("opt-card:maple-future-options-A")?.click, null);
});

test("a finished task (current_state done) hides both retained hold options and stale open_decisions", async () => {
  const snap = cloneSnapshot();
  const baseDone = makeDoneTemplate(snap);
  const workerTemplate = structuredClone(snap.tasks.find((t) => t.id === "maple-preview-screen"));
  snap.backlog.records.push({
    ...baseDone,
    id: "maple-finished-worker",
    title: "Finished PR awaiting merge",
    repo: "maple-workshop",
    kind: "ship",
    state: "in_flight",
    checked: false,
    done: null,
    current_role: "worker",
    completion: { date: null, verb: null },
    hold_kind: "captain",
    hold_reason: "Pick API shape | A: Flat | B: Nested | Recommended: A",
    hold_bucket: null,
    captain_actionable: false,
    order: 98,
  });
  snap.tasks.push({
    ...workerTemplate,
    id: "maple-finished-worker",
    pr: { url: "https://github.com/FlitCatz/maple-workshop/pull/99", source: "status_event", head: null },
    current_state: { state: "done", source: "status-log", detail: "Checks passed", raw: "state: done", observed_at: "2026-11-11T05:00:00Z", freshness: "fresh" },
    hints: {
      pending_decision: false,
      blocked_event: false,
      open_decisions: [{ key: "stale-key", verb: "needs-decision", summary: "Stale question | A: Old1 | B: Old2" }],
      scout_report_present: false,
      last_event_text: "done: PR ready",
    },
  });

  const b = await mountBoard({ snapshot: snap });
  assert.equal(b.view.cards.find((c) => c.id === "maple-finished-worker").column, "done");
  assert.ok(b.ids.includes("card-maple-finished-worker"));
  assert.deepEqual(b.ids.filter((x) => x.includes("maple-finished-worker") && x.startsWith("opt-")), []);
  assert.ok(!b.ids.includes("open-maple-finished-worker-0"));
  assert.doesNotMatch(b.text("card-maple-finished-worker"), /Flat|Nested|Old1|Old2|Recommended:/);
});
