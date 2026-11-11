// Draws the Board from tests/fixtures/snapshot.json outside Herdr and checks what it draws.
// Run with: node --test tests/
// The fixture is fictional but has the shape fm-fleet-snapshot.sh really prints, and the first
// test holds it to that shape: a fixture field the real snapshot does not have once hid a bug.
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import vm from "node:vm";

const root = new URL("..", import.meta.url);
const snapshotFile = new URL("tests/fixtures/snapshot.json", root).pathname;
const snapshot = JSON.parse(await readFile(snapshotFile, "utf8"));
const HOME = snapshot.fm_home;

// Field names of the real snapshot (fm-fleet-snapshot.v1, read 2026-11-11).
const TASK_KEYS = ["actions", "backend", "backlog", "branch", "current_state", "endpoint", "harness", "hints", "id", "kind",
  "mode", "paths", "pr", "project", "remote", "secondmate_projects", "spawn_gen", "yolo"];
const PATH_KEYS = ["home", "meta", "report", "status_log", "worktree"];
const HINT_KEYS = ["blocked_event", "last_event_text", "open_decisions", "pending_decision", "scout_report_present"];
const RECORD_KEYS = ["blocked_by", "blocked_by_ids", "blocked_reason", "body_excerpt", "body_lines", "captain_actionable",
  "checked", "completion", "current_role", "done", "hold_age_days", "hold_bucket", "hold_kind", "hold_reason", "hold_set",
  "hold_until", "id", "kind", "links", "local_note", "merged", "order", "pr_url", "priority", "raw", "repo", "report_path",
  "reported", "requires_child_metadata", "since", "state", "structured", "title", "unresolved_blocker_ids"];

// A stand-in for a gpui-kit element: it keeps the id, click handler, and children it is given.
function element() {
  const node = { id: null, click: null, kids: [] };
  const self = new Proxy(node, {
    get(target, name) {
      if (name === "node") return target;
      return (...args) => {
        if (name === "id") target.id = args[0];
        else if (name === "on_click") target.click = args[0];
        else if (name === "child") target.kids.push(args[0]);
        else if (name === "children") target.kids.push(...args[0]);
        else if (name === "when" && args[0]) args[1](self);
        return self;
      };
    },
  });
  return self;
}

// Every drawn element that has an id, in drawing order, with the text drawn inside it.
function drawn(tree) {
  const out = [];
  const walk = (kid) => {
    if (kid === null || kid === undefined) return "";
    if (typeof kid !== "object") return String(kid);
    const { id, click, kids } = kid.node;
    const entry = id === null ? null : { id, click, text: "" };
    if (entry) out.push(entry);
    const text = kids.map(walk).filter(Boolean).join(" ");
    if (entry) entry.text = text;
    return text;
  };
  walk(tree);
  return out;
}

// The Board with the fixture loaded, as Herdr would run it with the preview props.
async function board() {
  const source = (await readFile(new URL("mods/fm-board/main.js", root), "utf8"))
    .replace(/^import .*;$/gm, "").replace("export default class FmBoard", "class FmBoard");
  const pending = [];
  const cx = { notify() {}, stop_propagation() {}, spawn(fn) { pending.push(fn(cx)); }, timer: { every() {}, after() {} } };
  const input = () => ({ on() {}, value: () => "", set_value() {} });
  const theme = new Proxy({}, { get: () => "#808080" });
  const scope = {
    View: class {}, div: element, svg: element, v_flex: element, h_flex: element, Input: { new: element },
    h_resizable: element, resizable_panel: element, InputState: { new: input },
    FolderViewer: class { constructor() { this.root = null; } },
    props: () => ({ home: HOME, snapshot_file: snapshotFile, collapsed: [], ui: {} }),
    theme: () => theme, settings: () => ({ font_size: 14 }), terminals: () => [], focused: () => null, run() {},
    localStorage: { getItem: () => null, setItem() {} },
    readTextFile: async (file) => {
      if (file === snapshotFile) return readFile(file, "utf8");
      if (file === `${HOME}/data/projects.md`) return "- maple-workshop - Fictional project.\n- orchard-atlas - Fictional project.\n";
      throw new Error(`no such file: ${file}`);
    },
    // No helper program exists here; the Board treats every one as failed.
    exec: async () => ({ code: 1, stdout: "", stderr: "" }),
    watchFolder: async () => {}, pickFolder: async () => null,
  };
  const { FmBoard, cardsFrom } = vm.runInNewContext(`${source}\n({ FmBoard, cardsFrom })`, scope);
  const view = new FmBoard();
  view.init({}, cx);
  await Promise.all(pending);
  assert.equal(view.error, null);
  const drafts = [], opened = [];
  view.insertCardText = (text) => drafts.push(text);
  view.openView = (project, source) => opened.push({ project, ...source });
  const items = drawn(view.render(cx));
  const click = (id) => {
    const item = items.find((x) => x.id === id);
    assert.ok(item?.click, `nothing to click at ${id}`);
    item.click({}, cx);
  };
  return { view, cardsFrom, items, ids: items.map((x) => x.id), click, drafts, opened,
    text: (id) => items.find((x) => x.id === id)?.text };
}

// Arrays the Board builds belong to its own context; these copy them so they compare as plain arrays.
const matches = (view) => Array.from(view.matchIds());
const labels = (sources) => Array.from(sources, (s) => s.label);

test("the fixture has the real snapshot's shape", () => {
  assert.equal(snapshot.schema, "fm-fleet-snapshot.v1");
  for (const task of snapshot.tasks) {
    assert.deepEqual(Object.keys(task).sort(), TASK_KEYS, `task ${task.id}`);
    assert.deepEqual(Object.keys(task.paths).sort(), PATH_KEYS, `task ${task.id} paths`);
    for (const key of Object.keys(task.hints)) assert.ok(HINT_KEYS.includes(key), `task ${task.id} hint ${key}`);
    for (const d of task.hints.open_decisions) assert.deepEqual(Object.keys(d).sort(), ["key", "summary", "verb"]);
  }
  for (const record of snapshot.backlog.records) {
    for (const key of Object.keys(record)) assert.ok(RECORD_KEYS.includes(key), `record ${record.id} field ${key}`);
  }
});

test("a live card opens Files · Changes on the worker copy from paths.worktree", async () => {
  const b = await board();
  b.click("files-maple-preview-screen");
  assert.deepEqual(b.opened, [{ project: "maple-workshop", path: `${HOME}/worktrees/maple-preview-screen`,
    label: "maple-preview-screen", title: "maple-workshop · maple-preview-screen" }]);
  // A copy the snapshot reports as missing gets no button.
  assert.ok(!b.ids.includes("files-orchard-export-check"));
  // The project viewer's source list offers each live worker copy of that project.
  assert.deepEqual(labels(b.view.viewSources("orchard-atlas")), ["local copy", "orchard-nav-style"]);
});

test("the Held column draws three labelled groups, answer now first", async () => {
  const b = await board();
  const groups = b.ids.filter((id) => id.startsWith("hold-"));
  assert.deepEqual(groups, ["hold-now", "hold-deferred", "hold-waiting"]);
  const cardsIn = (group) => {
    const from = b.ids.indexOf(group), next = groups[groups.indexOf(group) + 1];
    const to = next ? b.ids.indexOf(next) : b.ids.indexOf("col-working");
    return b.ids.slice(from, to).filter((id) => id.startsWith("card-")).map((id) => id.slice(5));
  };
  // Only live holds are answered now; the topic box stays whole. Dated and aged holds are deferred.
  assert.deepEqual(cardsIn("hold-now"), ["maple-icon-set", "maple-tour-sketch", "maple-empty-state"]);
  assert.deepEqual(cardsIn("hold-deferred"), ["orchard-license-renewal", "orchard-tile-refresh", "maple-old-palette"]);
  // An external hold has no bucket and waits on something outside.
  assert.deepEqual(cardsIn("hold-waiting"), ["orchard-label-polish", "maple-release-notes"]);
  assert.match(b.text("hold-now"), /^Answer now 3 /);
  assert.match(b.text("hold-deferred"), /^Deferred 3 /);
  assert.match(b.text("hold-waiting"), /^Waiting on other work 2 /);
  assert.ok(b.ids.indexOf("group-preview-style") > b.ids.indexOf("hold-now"));
  assert.ok(b.ids.indexOf("group-preview-style") < b.ids.indexOf("hold-deferred"));
  // Deferred cards show their date when they have one.
  assert.equal(b.text("until-orchard-tile-refresh"), "until 12-01");
  assert.equal(b.text("until-orchard-license-renewal"), "until 11-20");
  assert.ok(!b.ids.includes("until-maple-old-palette"));
  assert.ok(!b.ids.includes("until-maple-icon-set"));
  // The search steps through cards in the same order.
  b.view.query = "orchard";
  assert.deepEqual(matches(b.view).filter((id) => b.view.cards.find((c) => c.id === id).column === "held"),
    ["orchard-license-renewal", "orchard-tile-refresh", "orchard-label-polish"]);
});

test("hold_bucket places a hold, and hold_kind places one with no bucket", async () => {
  const { cardsFrom } = await board();
  const group = (hold) => cardsFrom({ backlog: { records: [{ id: "x", title: "Fictional task", structured: true,
    state: "queued", hold_reason: "Fictional hold", ...hold }] } })[0].holdGroup;
  assert.equal(group({ hold_kind: "captain", hold_bucket: "live" }), "now");
  assert.equal(group({ hold_kind: "captain", hold_bucket: null }), "now");
  assert.equal(group({ hold_kind: null, hold_bucket: null }), "now");
  assert.equal(group({ hold_kind: "captain", hold_bucket: "dated", hold_until: "2026-12-01" }), "deferred");
  assert.equal(group({ hold_kind: "captain", hold_bucket: "aged" }), "deferred");
  assert.equal(group({ hold_kind: "captain", hold_bucket: "blocked", unresolved_blocker_ids: ["y"] }), "waiting");
  assert.equal(group({ hold_kind: "external", hold_bucket: null }), "waiting");
});

test("held decision options keep their answer draft", async () => {
  const b = await board();
  b.click("opt-card:maple-icon-set-A");
  b.click("opt-group:preview-style-B");
  b.click("opt-card:orchard-license-renewal-B");
  assert.deepEqual(b.drafts, [
    "[Board answer] maple-icon-set: A (Rounded)",
    "[Board answer] maple-tour-sketch, maple-empty-state: B (Bright)",
    "[Board answer] orchard-license-renewal: B (Switch)",
  ]);
});

test("a card lists every open decision and its answer drafts name the decision's key", async () => {
  const b = await board();
  const rows = b.items.filter((x) => x.id.startsWith("open-orchard-nav-style-")).map((x) => x.text);
  assert.deepEqual(rows, [
    "needs-decision nav-style Pick the navigation style",
    "blocked sample-data The sample coordinates file is missing from the data folder",
    "needs-decision label-language Should map labels follow the device language or stay in English?",
  ]);
  b.click("open-orchard-nav-style-1");
  b.click("opt-open-orchard-nav-style-0-B");
  b.click("open-orchard-nav-style-2");
  b.click("opt-open-maple-button-labels-0-A");
  assert.deepEqual(b.drafts, [
    "[Board answer] orchard-nav-style [key=sample-data]:",
    "[Board answer] orchard-nav-style [key=nav-style]: B (Top bar)",
    "[Board answer] orchard-nav-style [key=label-language]:",
    "[Board answer] maple-button-labels [key=default]: A (Verbs)",
  ]);
  // The list replaces a detail line that would only repeat one of the decisions.
  const card = (id) => b.view.cards.find((c) => c.id === id);
  assert.equal(card("orchard-nav-style").detail, "");
  assert.equal(card("maple-button-labels").detail, "");
  // The search finds a decision that is not the first one.
  b.view.query = "coordinates file";
  assert.deepEqual(matches(b.view), ["orchard-nav-style"]);
});

test("an open decision with a topic is drawn once, in its card, with keyed drafts", async () => {
  // The parked card's only open decision is "[topic=sample-labels] ... | A: Verbs | B: Nouns".
  const b = await board();
  assert.equal(b.view.cards.find((c) => c.id === "maple-button-labels").column, "parked");
  assert.ok(!b.ids.includes("group-sample-labels"));
  assert.deepEqual(b.items.filter((x) => x.id.startsWith("opt-") && x.text === "A Verbs").map((x) => x.id),
    ["opt-open-maple-button-labels-0-A"]);
  assert.equal(b.text("open-maple-button-labels-0"), "needs-decision default Choose clear sample labels");
  b.click("opt-open-maple-button-labels-0-B");
  assert.deepEqual(b.drafts, ["[Board answer] maple-button-labels [key=default]: B (Nouns)"]);
});
