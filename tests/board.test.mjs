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

// A stand-in for a gpui-kit element: it keeps the id, click handler, children, and styling calls it is given.
function element() {
  const node = { id: null, click: null, kids: [], calls: [] };
  const self = new Proxy(node, {
    get(target, name) {
      if (name === "node") return target;
      return (...args) => {
        if (!["child", "children", "when", "id", "on_click"].includes(name)) target.calls.push([name, ...args]);
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
    const { id, click, kids, calls } = kid.node;
    const entry = id === null ? null : { id, click, calls, text: "" };
    if (entry) out.push(entry);
    const text = kids.map(walk).filter(Boolean).join(" ");
    if (entry) entry.text = text;
    return text;
  };
  walk(tree);
  return out;
}

// The Board with the fixture loaded, as Herdr would run it with the preview props.
async function board({ projects, store = { getItem: () => null, setItem() {} }, registryFails = false, exec = async () => ({ code: 1, stdout: "", stderr: "" }), snapshot: customSnapshot = null } = {}) {
  // The registry the Board reads; tests change it, then reload.
  const registry = { projects: projects ?? ["maple-workshop", "orchard-atlas"], fails: registryFails };
  const source = (await readFile(new URL("mods/fm-board/main.js", root), "utf8"))
    .replace(/^import .*;$/gm, "").replace("export default class FmBoard", "class FmBoard");
  const pending = [];
  const cx = { notify() {}, stop_propagation() {}, spawn(fn) { pending.push(fn(cx)); }, timer: { every() {}, after() {} } };
  const input = () => { let text = ""; return { on() {}, value: () => text, set_value(v) { text = v; } }; };
  const theme = new Proxy({}, { get: () => "#808080" });
  const scope = {
    View: class {}, div: element, svg: element, v_flex: element, h_flex: element, Input: { new: element },
    h_resizable: element, resizable_panel: element, InputState: { new: input },
    FolderViewer: class { constructor() { this.root = null; } },
    props: () => ({ home: HOME, snapshot_file: snapshotFile, collapsed: [], ui: {} }),
    theme: () => theme, settings: () => ({ font_size: 14 }), terminals: () => [], focused: () => null, run() {},
    localStorage: store,
    readTextFile: async (file) => {
      if (file === snapshotFile) return customSnapshot ? JSON.stringify(customSnapshot) : readFile(file, "utf8");
      if (file === `${HOME}/data/projects.md`) {
        if (registry.fails) throw new Error("registry unreadable");
        return registry.projects.map((name) => `- ${name} - Fictional project.\n`).join("");
      }
      throw new Error(`no such file: ${file}`);
    },
    // By default no helper program exists here, and the Board treats every one as failed.
    exec,
    watchFolder: async () => {}, pickFolder: async () => null,
  };
  const { FmBoard, cardsFrom } = vm.runInNewContext(`${source}\n({ FmBoard, cardsFrom })`, scope);
  const view = new FmBoard();
  view.init({}, cx);
  await Promise.all(pending);
  if (!registryFails) assert.equal(view.error, null);
  const drafts = [], opened = [];
  view.insertCardText = (text) => drafts.push(text);
  view.openView = (project, source) => opened.push({ project, ...source });
  const items = drawn(view.render(cx));
  const click = (id) => {
    const item = items.find((x) => x.id === id);
    assert.ok(item?.click, `nothing to click at ${id}`);
    item.click({}, cx);
  };
  // Draws again after the test changed the Board, as Herdr does on every notify.
  const redraw = () => drawn(view.render(cx));
  // Reads the snapshot and registry again, as a watched change or the fallback timer does, then draws.
  const reload = async () => {
    view.last = 0; view.refresh(cx);
    await Promise.all(pending);
    return redraw();
  };
  return { view, registry, reload, cardsFrom, items, ids: items.map((x) => x.id), click, drafts, opened, redraw,
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

// Fictional registry names; the first two are the fixture's own projects.
const MANY_PROJECTS = ["maple-workshop", "orchard-atlas", "birch-ledger", "cedar-signal", "dune-harbor", "elm-compass",
  "fjord-notes", "garnet-relay", "heron-studio", "iris-gateway", "juniper-forge", "kelp-metrics", "linden-pages",
  "meadow-queue", "nettle-vault"];

test("the Projects list is a scroll area that holds every project", async () => {
  const b = await board({ projects: MANY_PROJECTS });
  assert.deepEqual(b.ids.filter((id) => id.startsWith("ptag-")), MANY_PROJECTS.map((name) => `ptag-${name}`));
  const list = b.items.find((x) => x.id === "project-list");
  assert.ok(list, "no project-list drawn");
  const used = list.calls.map((c) => c[0]);
  // Lab-proven in Herdr 0.1.15: overflow_y_scrollbar() wraps the element and drops its max_h, so the list
  // grew to its content, was cut off at the cap, and had nothing to scroll. The plain scroll area keeps the cap.
  assert.ok(used.includes("max_h") && used.includes("overflow_y_scroll"), `project-list calls: ${used}`);
  assert.ok(!used.includes("overflow_y_scrollbar"), "overflow_y_scrollbar() would drop the list's max_h");
});

// A localStorage that keeps what is written, shared by Boards that are given the same one.
function memoryStore() {
  const data = new Map();
  return { getItem: (key) => data.get(key) ?? null, setItem: (key, value) => { data.set(key, String(value)); } };
}

// FNV-1a 32-bit over UTF-16 units (offset basis 2166136261, prime 16777619), as published.
function fnv1a(text) {
  let h = 2166136261;
  for (let i = 0; i < text.length; i++) h = Math.imul(h ^ text.charCodeAt(i), 16777619) >>> 0;
  return h;
}

// The palette in the order the color picker lists it, read from an open project row.
function paletteOf(b) {
  const name = b.view.projects[0].name;
  b.view.open.add(name);
  const prefix = `color-${name}-`;
  const palette = b.redraw().filter((x) => x.id.startsWith(prefix) && !x.id.endsWith("-auto")).map((x) => x.id.slice(prefix.length));
  b.view.open.delete(name);
  return palette;
}

// The color of each project's tag, by project name.
const tagColors = (items) => Object.fromEntries(items.filter((x) => x.id.startsWith("ptag-"))
  .map((x) => [x.id.slice(5), x.calls.find((c) => c[0] === "bg")[1]]));

test("a project keeps its tag color when other projects are added or removed", async () => {
  const b = await board({ projects: ["birch-ledger", "cedar-signal", "maple-workshop", "orchard-atlas"] });
  const before = tagColors(b.items);
  // aspen-docs sorts before every project, which used to move each one's place in the color list.
  const same = (colors, names) => names.every((name) => colors[name] === before[name]);
  b.view.projects.unshift({ name: "aspen-docs", mode: "no-mistakes", yolo: false, desc: "Fictional project." });
  assert.ok(same(tagColors(b.redraw()), Object.keys(before)), "adding a project changed another one's color");
  b.view.projects = b.view.projects.filter((p) => p.name !== "cedar-signal");
  assert.ok(same(tagColors(b.redraw()), ["birch-ledger", "maple-workshop", "orchard-atlas"]), "removing a project changed another one's color");
});

test("a fresh Board sharing the store keeps every saved project color", async () => {
  const store = memoryStore();
  const b = await board({ projects: ["birch-ledger", "cedar-signal", "maple-workshop", "orchard-atlas"], store });
  b.view.projects.unshift({ name: "aspen-docs", mode: "no-mistakes", yolo: false, desc: "Fictional project." });
  const before = tagColors(b.redraw());
  const again = tagColors((await board({ projects: ["aspen-docs", "maple-workshop"], store })).items);
  assert.deepEqual(again, { "aspen-docs": before["aspen-docs"], "maple-workshop": before["maple-workshop"] });
});

test("the first 14 projects get distinct palette colors in name order, and the 15th one from its name", async () => {
  const b = await board({ projects: MANY_PROJECTS, store: memoryStore() });
  const palette = paletteOf(b);
  const colors = tagColors(b.items);
  const sorted = [...MANY_PROJECTS].sort();
  assert.deepEqual(sorted.slice(0, 14).map((name) => colors[name]), palette);
  // Every hue is held, so the last name falls back to FNV-1a over its name.
  const last = sorted[14];
  assert.equal(colors[last], palette[fnv1a(last) % palette.length]);
  b.view.projects.push({ name: "osier-trail", mode: "no-mistakes", yolo: false, desc: "Fictional project." });
  const after = tagColors(b.redraw());
  assert.equal(after["osier-trail"], palette[fnv1a("osier-trail") % palette.length]);
  for (const name of MANY_PROJECTS) assert.equal(after[name], colors[name], name);
});

test("a picked color holds its hue against new projects, and Auto returns to the saved color", async () => {
  const b = await board({ store: memoryStore() });
  const palette = paletteOf(b);
  assert.deepEqual(tagColors(b.items), { "maple-workshop": palette[0], "orchard-atlas": palette[1] });
  b.view.pickColor("maple-workshop", palette[2], { notify() {} });
  b.view.projects.push({ name: "aspen-docs", mode: "no-mistakes", yolo: false, desc: "Fictional project." });
  assert.deepEqual(tagColors(b.redraw()), { "aspen-docs": palette[3], "maple-workshop": palette[2], "orchard-atlas": palette[1] });
  b.view.pickColor("maple-workshop", null, { notify() {} });
  assert.equal(tagColors(b.redraw())["maple-workshop"], palette[0]);
});

test("a removed project frees its hue for the next new project, and no other color changes", async () => {
  const store = memoryStore();
  const b = await board({ projects: ["birch-ledger", "cedar-signal", "maple-workshop", "orchard-atlas"], store });
  const palette = paletteOf(b);
  const before = tagColors(b.items);
  assert.deepEqual(before, { "birch-ledger": palette[0], "cedar-signal": palette[1], "maple-workshop": palette[2], "orchard-atlas": palette[3] });
  b.registry.projects = ["birch-ledger", "maple-workshop", "orchard-atlas"];
  await b.reload();
  b.registry.projects = ["birch-ledger", "maple-workshop", "orchard-atlas", "zinnia-board"];
  const after = tagColors(await b.reload());
  // cedar-signal's hue is the lowest free one, so the new project takes it even though it sorts last.
  assert.deepEqual(after, { "birch-ledger": palette[0], "maple-workshop": palette[2], "orchard-atlas": palette[3], "zinnia-board": palette[1] });
  const again = tagColors((await board({ projects: ["birch-ledger", "maple-workshop", "orchard-atlas", "zinnia-board"], store })).items);
  assert.deepEqual(again, after);
});

test("a project removed from the registry keeps its hue while its cards remain", async () => {
  const store = memoryStore();
  const b = await board({ projects: ["maple-workshop", "orchard-atlas", "birch-ledger"], store });
  const palette = paletteOf(b);
  // maple-workshop still has cards in the snapshot.
  b.registry.projects = ["orchard-atlas", "birch-ledger"];
  await b.reload();
  b.registry.projects = ["orchard-atlas", "birch-ledger", "aspen-docs"];
  await b.reload();
  const colors = JSON.parse(store.getItem("autoProjectColors"));
  assert.equal(colors["maple-workshop"], palette[1]);
  assert.equal(colors["aspen-docs"], palette[3]);
});

test("an empty or failed registry read, or no read yet, frees no hue", async () => {
  const store = memoryStore();
  const b = await board({ projects: ["birch-ledger", "maple-workshop", "orchard-atlas"], store });
  const saved = store.getItem("autoProjectColors");
  b.registry.projects = [];
  await b.reload();
  assert.equal(store.getItem("autoProjectColors"), saved);
  b.registry.fails = true;
  await b.reload();
  assert.ok(b.view.error);
  assert.equal(store.getItem("autoProjectColors"), saved);
  // A Board whose first read fails has nothing on screen and must not touch the saved colors.
  const fresh = await board({ projects: ["maple-workshop"], store, registryFails: true });
  assert.ok(fresh.view.error);
  assert.equal(store.getItem("autoProjectColors"), saved);
});

test("two Board copies sharing the store never overwrite each other's colors", async () => {
  const store = memoryStore();
  const a = await board({ store });
  const b = await board({ store });
  const palette = paletteOf(a);
  // Copy A sees zeta-tools first; copy B, which loaded before that, then sees alpha-notes and zeta-tools together.
  a.view.projects.push({ name: "zeta-tools", mode: "no-mistakes", yolo: false, desc: "Fictional project." });
  assert.equal(tagColors(a.redraw())["zeta-tools"], palette[2]);
  b.view.projects.push({ name: "alpha-notes", mode: "no-mistakes", yolo: false, desc: "Fictional project." },
    { name: "zeta-tools", mode: "no-mistakes", yolo: false, desc: "Fictional project." });
  const fromB = tagColors(b.redraw());
  assert.equal(fromB["zeta-tools"], palette[2]);
  assert.equal(fromB["alpha-notes"], palette[3]);
  a.view.projects.push({ name: "alpha-notes", mode: "no-mistakes", yolo: false, desc: "Fictional project." });
  assert.deepEqual(tagColors(a.redraw()), fromB);
  assert.deepEqual(JSON.parse(store.getItem("autoProjectColors")),
    { "maple-workshop": palette[0], "orchard-atlas": palette[1], "zeta-tools": palette[2], "alpha-notes": palette[3] });
});

// Herdr 0.1.15's localStorage.getItem returns undefined, not null, for an unset key (seen in a live Herdr window).
test("on a fresh store whose unset keys read as undefined, the first projects still get distinct saved colors", async () => {
  const data = new Map();
  const store = { getItem: (key) => data.get(key), setItem: (key, value) => { data.set(key, String(value)); } };
  const b = await board({ projects: ["birch-ledger", "cedar-signal", "maple-workshop", "orchard-atlas"], store });
  const palette = paletteOf(b);
  const expected = { "birch-ledger": palette[0], "cedar-signal": palette[1], "maple-workshop": palette[2], "orchard-atlas": palette[3] };
  assert.deepEqual(tagColors(b.items), expected);
  assert.deepEqual(JSON.parse(data.get("autoProjectColors")), expected);
});

test("a store that cannot be read or written still draws, with colors from the names", async () => {
  const broken = { getItem() { throw new Error("denied"); }, setItem() { throw new Error("denied"); } };
  const b = await board({ store: broken });
  const palette = paletteOf(b);
  const expected = Object.fromEntries(["maple-workshop", "orchard-atlas"].map((name) => [name, palette[fnv1a(name) % palette.length]]));
  assert.deepEqual(tagColors(b.items), expected);
  assert.deepEqual(tagColors(b.redraw()), expected);
});

test("a project's tag color is one of the palette colors, the same on its cards, and a picked color wins", async () => {
  const b = await board({ projects: MANY_PROJECTS });
  // The picker lists the palette only for an open project row.
  b.view.open.add("maple-workshop");
  const swatches = b.redraw().filter((x) => x.id.startsWith("color-maple-workshop-") && !x.id.endsWith("-auto"))
    .map((x) => x.id.slice("color-maple-workshop-".length));
  assert.equal(swatches.length, 14);
  const colors = tagColors(b.redraw());
  for (const [name, color] of Object.entries(colors)) assert.ok(swatches.includes(color), `${name}: ${color}`);
  // Cards use the project's color.
  const cardTag = b.items.find((x) => x.id === "tag-maple-icon-set");
  assert.equal(cardTag.calls.find((c) => c[0] === "bg")[1], colors["maple-workshop"]);
  // Picking a color wins over the automatic one, and Auto returns to it.
  b.view.pickColor("maple-workshop", "#123456", { notify() {} });
  assert.equal(tagColors(b.redraw())["maple-workshop"], "#123456");
  b.view.pickColor("maple-workshop", null, { notify() {} });
  assert.equal(tagColors(b.redraw())["maple-workshop"], colors["maple-workshop"]);
});

// The Commands section's Memo button. A call list records every program the Board ran.
// With `terminal`, firstmate is alive in one Herdr terminal the Board can find, as when it is stopped on a limit.
const FIRSTMATE_TERMINAL = "w1:p1", FIRSTMATE_PID = 4242;
function programs({ note = { code: 0, stdout: "", stderr: "" }, terminal = false } = {}) {
  const calls = [];
  const ok = (value) => ({ code: 0, stdout: JSON.stringify(value), stderr: "" });
  const exec = async (file, args = []) => {
    calls.push([file, ...args]);
    if (file === "hc") {
      if (!terminal) return { code: 1, stdout: "", stderr: "" };
      if (args[0] === "ls") return ok({ terminals: [{ address: FIRSTMATE_TERMINAL, state: "live" }] });
      if (args[0] === "get" && args[1] === FIRSTMATE_TERMINAL) {
        return ok({ state: "live", pid: 100, foreground: { pid: FIRSTMATE_PID } });
      }
      if (args[0] === "send" && args[1] === FIRSTMATE_TERMINAL) return ok({});
      return { code: 1, stdout: "", stderr: "" };
    }
    const script = args.find((a) => a.includes("/bin/fm-inbox.sh"));
    const sub = args[args.indexOf(script) + 1];
    if (sub === "note") return note;
    if (sub === "ready" && terminal) return ok({ lock: { state: "held", live_harness: true, pid: FIRSTMATE_PID } });
    return { code: 1, stdout: "", stderr: "" };
  };
  const notes = () => calls.filter((c) => c.some((a) => a.endsWith("/bin/fm-inbox.sh")) && c.includes("note"));
  const hcCalls = () => calls.filter((c) => c[0] === "hc");
  return { calls, exec, notes, hcCalls, sends: () => hcCalls().filter((c) => c[1] === "send") };
}

test("Memo saves an inbox note and never touches the firstmate terminal, even a live one", async () => {
  const p = programs({ terminal: true });
  const b = await board({ exec: p.exec });
  b.view.ask.set_value("check the sync idea later");
  b.view.askProject = "maple-workshop";
  b.click("ask-memo");
  await b.reload();
  assert.equal(p.notes().length, 1);
  assert.deepEqual(p.sends(), []);
  const [note] = p.notes();
  assert.equal(note.at(-1), "[Board memo] project=maple-workshop: check the sync idea later - file this in the backlog only; do not start work");
  assert.equal(note[1], `FM_HOME=${HOME}`);
  assert.ok(note.includes("--json") && note.includes("--request-id"));
  assert.match(note[note.indexOf("--request-id") + 1], /^board-\d+$/);
  // It neither looked for the terminal nor typed into one. The reload's own `hc get` reads only a card's status.
  assert.deepEqual([...new Set(p.hcCalls().map((c) => c[1]))].filter((verb) => verb !== "get"), []);
  assert.ok(!p.calls.some((c) => ["osascript", "pbcopy"].includes(c[0])));
  assert.equal(b.view.notice, "Memo saved");
  assert.equal(b.view.ask.value(), "");
  assert.equal(b.view.askProject, null);
});

test("Memo without a chosen project says firstmate picks, and saved-not-announced still counts as saved", async () => {
  const p = programs({ note: { code: 3, stdout: "", stderr: "" } });
  const b = await board({ exec: p.exec });
  b.view.ask.set_value("a thought");
  b.click("ask-memo");
  await b.reload();
  assert.match(p.notes()[0].at(-1), /^\[Board memo\] project=\(firstmate picks\): a thought - /);
  assert.equal(b.view.notice, "Memo saved");
  assert.equal(b.view.ask.value(), "");
});

test("Memo with an empty field shows a notice and sends nothing", async () => {
  const p = programs();
  const b = await board({ exec: p.exec });
  b.view.ask.set_value("   ");
  b.click("ask-memo");
  await b.reload();
  assert.equal(p.notes().length, 0);
  assert.equal(b.view.notice, "Type the note to save");
});

test("a Memo that fails to save keeps the text and the project, and shows the error", async () => {
  const p = programs({ note: { code: 1, stdout: "", stderr: "inbox unwritable\n" } });
  const b = await board({ exec: p.exec });
  b.view.ask.set_value("keep me");
  b.view.askProject = "orchard-atlas";
  b.click("ask-memo");
  await b.reload();
  assert.equal(b.view.notice, "Request failed: inbox unwritable");
  assert.equal(b.view.ask.value(), "keep me");
  assert.equal(b.view.askProject, "orchard-atlas");
});

test("Scout and Task still go through the firstmate terminal path, not a Memo note", async () => {
  const live = programs({ terminal: true });
  const typed = await board({ exec: live.exec });
  typed.view.ask.set_value("look into it");
  typed.click("ask-task");
  await typed.reload();
  assert.deepEqual(live.sends().map((c) => c.slice(1)),
    [["send", FIRSTMATE_TERMINAL, "[Board task] project=(firstmate picks): look into it", "--json"]]);
  assert.equal(live.notes().length, 0);
  assert.equal(typed.view.notice, "Task request typed into firstmate");

  const p = programs();
  const b = await board({ exec: p.exec });
  b.view.ask.set_value("look into it");
  b.click("ask-task");
  await b.reload();
  // With no terminal to find, Task falls back to a Board request, not a memo.
  assert.match(p.notes()[0].at(-1), /^\[Board request\] New task: project=\(firstmate picks\) - look into it$/);
  assert.ok(!p.notes().some((n) => n.at(-1).includes("[Board memo]")));
});

// Asia/Seoul is UTC+9 all year, so an instant at 03:50Z reads 12:50 there on the same date.
test("paused cards show a cleaned Waiting for row for CI drive, awaiting-other-work, Korean, and nothing when missing", async (t) => {
  const tz = process.env.TZ;
  process.env.TZ = "Asia/Seoul";
  t.after(() => { if (tz === undefined) delete process.env.TZ; else process.env.TZ = tz; });
  const seoulToday = new Date(Date.now() + 9 * 3600e3).toISOString().slice(0, 10);
  const makeTask = (id, state, detail, lastEvent, prUrl = null) => ({
    id, kind: "ship", project: `${HOME}/projects/orchard-atlas`, branch: `fm/${id}`, harness: "codex", backend: "hc",
    mode: "no-mistakes", yolo: false, spawn_gen: "s1", remote: "origin", secondmate_projects: [],
    paths: { home: HOME, meta: "", status_log: "", worktree: { path: "", present: false }, report: { path: "", present: false } },
    current_state: { state, source: "pane", detail, raw: detail, observed_at: "2026-11-13T03:46:13Z", freshness: "fresh" },
    endpoint: { target: null, exists: false, agent_alive: "not_checked", status: "absent", observed_at: "2026-11-13T03:46:13Z", freshness: "fresh" },
    pr: { url: prUrl, source: prUrl ? "status_event" : "absent", head: null },
    hints: { pending_decision: false, blocked_event: false, open_decisions: [], scout_report_present: false, last_event_text: lastEvent },
    actions: { watch: "", steer: "", return_channel_note: null },
    backlog: { id, state: "in_flight", kind: "ship", repo: "orchard-atlas", title: id },
  });
  const makeRecord = (id) => ({ id, state: "in_flight", kind: "ship", repo: "orchard-atlas", title: id, structured: true });
  const tasks = [
    makeTask("ci-wait", "paused", "ci running",
      `paused [at=1794541315]: no-mistakes CI drive until ${seoulToday}T03:50Z for https://github.com/FlitCatz/orchard-atlas/pull/52; resume on gate or CI-ready outcome`),
    makeTask("other-work", "unknown", "harness state unavailable",
      "paused [at=1794539820]: Step 1 committed; awaiting maple-workshop release URL; details=/fictional/firstmate/data/maple-wire-eval/step2-preparation.md"),
    makeTask("korean-wait", "unknown", "harness state unavailable",
      "paused [at=1794541444] [key=final-local-ci]: 커밋 368fb16 기준 로컬 CI 실행; 결과 반환 시 재개, until 2020-01-02T04:40Z"),
    makeTask("missing-wait", "paused", "", "paused [at=1794541444]: "),
    makeTask("run-words", "paused", "", "paused [at=1]: validating run: 01M79GKB5X3AKE32E4AKZB9RKP resume when green; the nightly run: results due at 06:00"),
    makeTask("multi-line", "paused", "", "paused [at=1]: line1\nline2"),
    makeTask("plain-working", "unknown", "harness state unavailable", "working on build"),
  ];
  const b = await board({
    snapshot: { schema: "fm-fleet-snapshot.v1", fm_home: HOME, tasks, backlog: { records: tasks.map((x) => makeRecord(x.id)) } },
  });

  const ciRow = b.items.find((x) => x.id === "waiting-ci-wait");
  const ciExpected = "no-mistakes CI drive until 12:50 for FlitCatz/orchard-atlas#52; resume on gate or CI-ready outcome";
  assert.equal(ciRow?.text, `Waiting for: ${ciExpected}`);
  assert.deepEqual(ciRow?.calls.find((c) => c[0] === "tooltip"), ["tooltip", ciExpected]);
  // A PR named only in the wait reason is what the worker waits on, not the card's own PR.
  assert.equal(b.items.find((x) => x.id === "pr-ci-wait"), undefined);

  const otherExpected = "Step 1 committed; awaiting maple-workshop release URL";
  assert.equal(b.text("waiting-other-work"), `Waiting for: ${otherExpected}`);

  assert.equal(b.text("waiting-korean-wait"), "Waiting for: 커밋 368fb16 기준 로컬 CI 실행; 결과 반환 시 재개, until 01-02 13:40");

  assert.equal(b.items.find((x) => x.id === "waiting-missing-wait"), undefined);

  assert.equal(b.text("waiting-run-words"), "Waiting for: validating resume when green; the nightly run: results due at 06:00");
  assert.equal(b.text("waiting-multi-line"), "Waiting for: line1\nline2");
  assert.ok(b.text("card-plain-working").includes("working on build"));
});
