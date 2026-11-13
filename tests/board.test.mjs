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
  const node = { id: null, click: null, hover: null, keyDown: null, kids: [], calls: [] };
  const self = new Proxy(node, {
    get(target, name) {
      if (name === "node") return target;
      return (...args) => {
        if (!["child", "children", "when", "id", "on_click"].includes(name)) target.calls.push([name, ...args]);
        if (name === "id") target.id = args[0];
        else if (name === "on_click") target.click = args[0];
        else if (name === "on_hover") target.hover = args[0];
        else if (name === "on_key_down") target.keyDown = args[0];
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
    const { id, click, hover, keyDown, kids, calls } = kid.node;
    const entry = id === null ? null : { id, click, hover, keyDown, calls, text: "" };
    if (entry) out.push(entry);
    const text = kids.map(walk).filter(Boolean).join(" ");
    if (entry) entry.text = text;
    return text;
  };
  walk(tree);
  return out;
}

// The Board with the fixture loaded, as Herdr would run it with the preview props.
async function board({ projects, store = { getItem: () => null, setItem() {} }, registryFails = false, exec = async () => ({ code: 1, stdout: "", stderr: "" }), snapshot: customSnapshot = null, ui = {} } = {}) {
  // The registry the Board reads; tests change it, then reload.
  const registry = { projects: projects ?? ["maple-workshop", "orchard-atlas"], fails: registryFails };
  const source = (await readFile(new URL("mods/fm-board/main.js", root), "utf8"))
    .replace(/^import .*;$/gm, "").replace("export default class FmBoard", "class FmBoard");
  const pending = [];
  const scrolled = [];
  const cx = { notify() {}, stop_propagation() {}, spawn(fn) { pending.push(fn(cx)); }, timer: { every() {}, after() {} } };
  const input = () => { let text = ""; return { on() {}, value: () => text, set_value(v) { text = v; } }; };
  const theme = new Proxy({}, { get: () => "#808080" });
  const scope = {
    View: class {}, div: element, svg: element, v_flex: element, h_flex: element, Input: { new: element },
    h_resizable: element, resizable_panel: element, InputState: { new: input },
    ScrollHandle: { new: () => ({ scroll_to_item(idx) { scrolled.push(idx); } }) },
    FolderViewer: class { constructor() { this.root = null; } close() { this.root = null; } },
    props: () => ({ home: HOME, snapshot_file: snapshotFile, collapsed: [], ui }),
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
  const { FmBoard, cardsFrom, dependencyGraph, chainHighlight, waitingLabel, blocksLabel } = vm.runInNewContext(
    `${source}\n({ FmBoard, cardsFrom, dependencyGraph, chainHighlight, waitingLabel, blocksLabel })`,
    scope,
  );
  const view = new FmBoard();
  view.init({}, cx);
  await Promise.all(pending);
  if (!registryFails) assert.equal(view.error, null);
  const drafts = [], opened = [];
  view.insertCardText = (text) => drafts.push(text);
  view.openView = (project, source) => { view.inspectorOpen = false; opened.push({ project, ...source }); };
  let items = drawn(view.render(cx));
  const click = (id) => {
    const item = items.find((x) => x.id === id);
    assert.ok(item?.click, `nothing to click at ${id}`);
    item.click({}, cx);
    items = drawn(view.render(cx));
    return items;
  };
  const hover = (id, hovered = true) => {
    const item = items.find((x) => x.id === id);
    assert.ok(item?.hover, `nothing to hover at ${id}`);
    item.hover(hovered, cx);
    items = drawn(view.render(cx));
    return items;
  };
  const keyDown = (id, key) => {
    const item = items.find((x) => x.id === id);
    assert.ok(item?.keyDown, `no keyDown at ${id}`);
    item.keyDown({ key }, cx);
    items = drawn(view.render(cx));
    return items;
  };
  // Draws again after the test changed the Board, as Herdr does on every notify.
  const redraw = () => {
    items = drawn(view.render(cx));
    return items;
  };
  // Reads the snapshot and registry again, as a watched change or the fallback timer does, then draws.
  const reload = async () => {
    view.last = 0; view.refresh(cx);
    await Promise.all(pending);
    return redraw();
  };
  return {
    view, registry, reload, cardsFrom, dependencyGraph, chainHighlight, waitingLabel, blocksLabel,
    get items() { return items; },
    get ids() { return items.map((x) => x.id); },
    click, hover, keyDown, scrolled, drafts, opened, redraw,
    text: (id) => items.find((x) => x.id === id)?.text,
  };
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
    makeTask("korean-wait-word", "paused", "", "paused [at=1]: 빌드 완료; 릴리스 태그 대기 중"),
    makeTask("missing-wait", "paused", "", "paused [at=1794541444]: "),
    makeTask("run-words", "paused", "", "paused [at=1]: validating run: 01M79GKB5X3AKE32E4AKZB9RKP resume when green; the nightly run: results due at 06:00"),
    makeTask("multi-line", "paused", "", "paused [at=1]: line1\nline2"),
    makeTask("comma-list", "paused", "", "paused [at=1]: Step 1 committed, awaiting release URL, source revision, platform SHA"),
    makeTask("nested-clause", "paused", "", "paused [at=1]: processed 1,234 rows; tests green, awaiting review"),
    makeTask("retry-until", "paused", "", "paused [at=1]: build ok; retry once CI passes, until 13:40"),
    makeTask("unlisted-until", "paused", "", "paused [at=1]: build ok; CI passes, until 13:40"),
    makeTask("comma-then-until", "paused", "", "paused [at=1]: Step 1 committed, CI drive until 13:40 for FlitCatz/x#52"),
    makeTask("plain-working", "unknown", "harness state unavailable", "working on build"),
    makeTask("done-no-pr", "unknown", "harness state unavailable", "done [at=1]: report written to data/x.md"),
    makeTask("harness-idle", "paused", "idle", "working [at=1]: building"),
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

  const otherRow = b.items.find((x) => x.id === "waiting-other-work");
  const otherFull = "Step 1 committed; awaiting maple-workshop release URL";
  assert.equal(otherRow?.text, "Waiting for: awaiting maple-workshop release URL; Step 1 committed");
  assert.deepEqual(otherRow?.calls.find((c) => c[0] === "tooltip"), ["tooltip", otherFull]);

  const koRow = b.items.find((x) => x.id === "waiting-korean-wait");
  const koFull = "커밋 368fb16 기준 로컬 CI 실행; 결과 반환 시 재개, until 01-02 13:40";
  assert.equal(koRow?.text, "Waiting for: 결과 반환 시 재개, until 01-02 13:40; 커밋 368fb16 기준 로컬 CI 실행");
  assert.deepEqual(koRow?.calls.find((c) => c[0] === "tooltip"), ["tooltip", koFull]);

  const koWordRow = b.items.find((x) => x.id === "waiting-korean-wait-word");
  assert.equal(koWordRow?.text, "Waiting for: 릴리스 태그 대기 중; 빌드 완료");
  assert.deepEqual(koWordRow?.calls.find((c) => c[0] === "tooltip"), ["tooltip", "빌드 완료; 릴리스 태그 대기 중"]);

  assert.equal(b.items.find((x) => x.id === "waiting-missing-wait"), undefined);

  assert.equal(b.text("waiting-run-words"), "Waiting for: validating resume when green; the nightly run: results due at 06:00");
  assert.equal(b.text("waiting-multi-line"), "Waiting for: line1\nline2");
  // The items being waited on stay with their clause, and a clause after a comma inside a ";" part still leads.
  assert.equal(b.text("waiting-comma-list"), "Waiting for: awaiting release URL, source revision, platform SHA; Step 1 committed");
  assert.equal(b.text("waiting-nested-clause"), "Waiting for: awaiting review; processed 1,234 rows; tests green");
  // A deadline after a comma stays with the condition it bounds.
  assert.equal(b.text("waiting-retry-until"), "Waiting for: retry once CI passes, until 13:40; build ok");
  assert.equal(b.text("waiting-unlisted-until"), "Waiting for: CI passes, until 13:40; build ok");
  assert.equal(b.text("waiting-comma-then-until"), "Waiting for: CI drive until 13:40 for FlitCatz/x#52; Step 1 committed");
  assert.ok(b.text("card-plain-working").includes("working on build"));

  // Paused-column cards without a worker "paused" line are not waiting on anything they declared.
  assert.equal(b.items.find((x) => x.id === "waiting-done-no-pr"), undefined);
  assert.ok(b.text("card-done-no-pr").includes("report written to data/x.md"));
  assert.ok(!b.text("card-done-no-pr").includes("Waiting for:"));
  assert.equal(b.items.find((x) => x.id === "waiting-harness-idle"), undefined);
  assert.ok(b.text("card-harness-idle").includes("idle"));
});

test("dependencyGraph derives reverse dependencies, transitive downstream counts, levels, and components", async () => {
  const { cardsFrom, dependencyGraph, waitingLabel, blocksLabel } = await board();
  const records = [
    { id: "K2", state: "in_flight", repo: "maple-workshop", title: "maple-workshop K2 Step 1 core", structured: true, unresolved_blocker_ids: [] },
    { id: "K3", state: "queued", hold_kind: "external", repo: "maple-workshop", title: "maple-workshop K3 Step 2 wire", structured: true, unresolved_blocker_ids: ["K2"] },
    { id: "K4", state: "queued", repo: "maple-workshop", title: "maple-workshop K4 Step 3 verifier", structured: true, unresolved_blocker_ids: ["K3"] },
    { id: "K6", state: "queued", repo: "maple-workshop", title: "maple-workshop K6 Step 4 audit", structured: true, unresolved_blocker_ids: ["K4"] },
    { id: "K7", state: "queued", repo: "maple-workshop", title: "maple-workshop K7 Step 5 rollout", structured: true, unresolved_blocker_ids: ["K6"] },
    { id: "solo", state: "queued", repo: "orchard-atlas", title: "orchard-atlas standalone task", structured: true, unresolved_blocker_ids: [] },
  ];
  const cards = cardsFrom({ backlog: { records } });
  const graph = dependencyGraph(cards);
  const byId = new Map(cards.map((c) => [c.id, c]));

  assert.deepEqual(Array.from(byId.get("K2").blockingIds), ["K3"]);
  assert.deepEqual(Array.from(byId.get("K2").blocks), ["K3", "K4", "K6", "K7"]);
  assert.equal(byId.get("K2").blocksCount, 4);
  assert.equal(blocksLabel(byId.get("K2")), "★ Blocks 4 →");

  assert.deepEqual(Array.from(byId.get("K4").upstreamIds), ["K3", "K2"]);
  assert.deepEqual(Array.from(byId.get("K4").blocks), ["K6", "K7"]);
  assert.equal(byId.get("K4").blocksCount, 2);
  assert.equal(waitingLabel(byId.get("K4")), "Waiting on K3 Step 2 wire");
  assert.equal(waitingLabel(byId.get("K4"), "← Waits on"), "← Waits on K3 Step 2 wire");
  assert.equal(blocksLabel(byId.get("K4")), "★ Blocks 2 →");

  assert.equal(byId.get("K7").blocksCount, 0);
  assert.deepEqual(Array.from(byId.get("K7").upstreamIds), ["K6", "K4", "K3", "K2"]);

  // Topological levels L0..L4 for K2..K7, and 1 connected component (solo is not in any component).
  assert.equal(graph.components.length, 1);
  assert.deepEqual(Array.from(graph.components[0].levels, (lg) => Array.from(lg.ids)), [["K2"], ["K3"], ["K4"], ["K6"], ["K7"]]);
  assert.equal(graph.components[0].depth, 5);
  assert.equal(graph.components[0].summaryLabel, "K2 → K7");
  assert.equal(graph.componentById.has("solo"), false);
});

test("dependencyGraph handles parallel branches, cross-project joins, and cycles safely", async () => {
  const { dependencyGraph } = await board();
  const cards = [
    { id: "M1", title: "M1 API", project: "maple-workshop", column: "working", waitingIds: [] },
    { id: "O1", title: "O1 Schema", project: "orchard-atlas", column: "paused", waitingIds: [] },
    { id: "O2", title: "O2 Sync Join", project: "orchard-atlas", column: "held", waitingIds: ["M1", "O1"] },
    { id: "O3A", title: "O3A Desktop", project: "orchard-atlas", column: "queued", waitingIds: ["O2"] },
    { id: "O3B", title: "O3B Mobile", project: "maple-workshop", column: "queued", waitingIds: ["O2"] },
    // Cycle: C1 -> C2 -> C3 -> C1
    { id: "C1", title: "Cycle 1", project: "maple-workshop", column: "queued", waitingIds: ["C3"] },
    { id: "C2", title: "Cycle 2", project: "maple-workshop", column: "queued", waitingIds: ["C1"] },
    { id: "C3", title: "Cycle 3", project: "maple-workshop", column: "queued", waitingIds: ["C2"] },
  ];
  const graph = dependencyGraph(cards);
  const o2 = graph.nodes.get("O2");
  assert.deepEqual(Array.from(o2.crossProjectBlockers), ["M1"]);
  assert.deepEqual(Array.from(graph.nodes.get("M1").blockingIds), ["O2"]);

  // M1 and O1 join at O2, which fans out to O3A and O3B.
  const joinComp = graph.componentById.get("O2");
  assert.deepEqual(Array.from(joinComp.levels, (lg) => Array.from(lg.ids)), [["M1", "O1"], ["O2"], ["O3A", "O3B"]]);
  assert.equal(joinComp.hasCycle, false);
  assert.equal(joinComp.joins.length, 1);
  assert.equal(joinComp.joins[0].id, "O2");
  assert.deepEqual(Array.from(joinComp.joins[0].blockers), ["M1", "O1"]);
  assert.equal(joinComp.levels[1].hasCrossProject, true);
  assert.deepEqual(Array.from(joinComp.levels[1].crossProjectEdges, (e) => `${e.fromProject} → ${e.toProject}`), ["maple-workshop → orchard-atlas"]);
  // O3B (maple-workshop) waits on O2 (orchard-atlas): a second cross-project edge one level down.
  assert.equal(joinComp.crossProjectEdges.length, 2);
  assert.equal(joinComp.levels[2].hasBranch, true);

  // The cycle C1 -> C2 -> C3 -> C1 ends in finite levels, each task drawn exactly once.
  const cycleComp = graph.componentById.get("C1");
  assert.equal(cycleComp.hasCycle, true);
  assert.deepEqual(Array.from(cycleComp.levels).flatMap((lg) => Array.from(lg.ids)).sort(), ["C1", "C2", "C3"]);
});

test("card dependency badges render in every column, not only Queued", async () => {
  const b = await board();
  // In the default fixture, orchard-label-polish (in Held) waits on orchard-map-labels (in Queued).
  assert.equal(b.view.cards.find((c) => c.id === "orchard-map-labels").column, "queued");
  assert.equal(b.text("blocks-orchard-map-labels"), "★ Blocks 1 →");
  assert.equal(b.view.cards.find((c) => c.id === "orchard-label-polish").column, "held");
  assert.equal(b.text("waits-orchard-label-polish"), "← Waits on Add map labels");

  // Across Working, Held, Paused, Review, and Queued columns:
  const makeTask = (id, state, detail = "", prUrl = null, lastEvent = "") => ({
    id, kind: "ship", project: `${HOME}/projects/maple-workshop`, branch: `fm/${id}`, harness: "codex", backend: "hc",
    mode: "no-mistakes", yolo: false, spawn_gen: "s1", remote: "origin", secondmate_projects: [],
    paths: { home: HOME, meta: "", status_log: "", worktree: { path: "", present: false }, report: { path: "", present: false } },
    current_state: { state, source: "pane", detail, raw: detail, observed_at: "2026-11-13T03:46:13Z", freshness: "fresh" },
    endpoint: { target: null, exists: false, agent_alive: "not_checked", status: "absent", observed_at: "2026-11-13T03:46:13Z", freshness: "fresh" },
    pr: { url: prUrl, source: prUrl ? "status_event" : "absent", head: null },
    hints: { pending_decision: false, blocked_event: false, open_decisions: [], scout_report_present: false, last_event_text: lastEvent },
    actions: { watch: "", steer: "", return_channel_note: null },
    backlog: { id, state: "in_flight", kind: "ship", repo: "maple-workshop", title: id },
  });
  const records = [
    { id: "W1", state: "in_flight", repo: "maple-workshop", title: "Working Blocker", structured: true, unresolved_blocker_ids: [] },
    { id: "P1", state: "in_flight", repo: "maple-workshop", title: "Paused Step", structured: true, unresolved_blocker_ids: ["W1"] },
    { id: "R1", state: "in_flight", repo: "maple-workshop", title: "Review Step", structured: true, pr_url: "https://github.com/FlitCatz/maple-workshop/pull/10", unresolved_blocker_ids: ["P1"] },
    { id: "H1", state: "queued", hold_kind: "captain", hold_bucket: "live", hold_reason: "Confirm rollout | A: Yes | B: No", repo: "maple-workshop", title: "Held Step", structured: true, unresolved_blocker_ids: ["R1"] },
    { id: "Q1", state: "queued", repo: "maple-workshop", title: "Queued Leaf", structured: true, unresolved_blocker_ids: ["H1"] },
  ];
  const tasks = [
    makeTask("W1", "working", "building"),
    makeTask("P1", "paused", "ci running"),
    makeTask("R1", "unknown", "checks green: PR ready", "https://github.com/FlitCatz/maple-workshop/pull/10", "done [at=1]: PR ready"),
  ];
  const multi = await board({
    snapshot: { schema: "fm-fleet-snapshot.v1", fm_home: HOME, tasks, backlog: { records } },
  });
  assert.equal(multi.view.cards.find((c) => c.id === "W1").column, "working");
  assert.equal(multi.text("blocks-W1"), "★ Blocks 4 →");

  assert.equal(multi.view.cards.find((c) => c.id === "P1").column, "paused");
  assert.equal(multi.text("waits-P1"), "← Waits on Working Blocker");
  assert.equal(multi.text("blocks-P1"), "★ Blocks 3 →");

  assert.equal(multi.view.cards.find((c) => c.id === "R1").column, "review");
  assert.equal(multi.text("waits-R1"), "← Waits on Paused Step");
  assert.equal(multi.text("blocks-R1"), "★ Blocks 2 →");

  assert.equal(multi.view.cards.find((c) => c.id === "H1").column, "held");
  assert.equal(multi.text("waits-H1"), "← Waits on Review Step");
  assert.equal(multi.text("blocks-H1"), "★ Blocks 1 →");

  assert.equal(multi.view.cards.find((c) => c.id === "Q1").column, "queued");
  assert.equal(multi.text("waits-Q1"), "← Waits on Held Step");

  // A queued card's waiting row still expands and hides the order it waits on, without opening the inspector.
  assert.equal(multi.text("wait-Q1"), "▸ Waiting on Held Step");
  assert.ok(!multi.text("card-Q1").includes("this task"));
  multi.click("wait-Q1");
  assert.equal(multi.text("wait-Q1"), "▾ Waiting on Held Step");
  assert.ok(multi.text("card-Q1").includes("this task"));
  assert.equal(multi.view.inspectorOpen, false);
  multi.click("wait-Q1");
  assert.ok(!multi.text("card-Q1").includes("this task"));
  // Only queued cards have the waiting row.
  assert.ok(!multi.ids.includes("wait-H1"));
});

test("clicking a badge or toolbar toggle opens the Dependency Inspector, highlights upstream/selected/downstream, dims unrelated cards only while selected, and clears on Escape or Close", async () => {
  const records = [
    { id: "K2", state: "in_flight", repo: "maple-workshop", title: "K2 Root Blocker", structured: true, unresolved_blocker_ids: [] },
    { id: "K3", state: "queued", hold_kind: "captain", hold_bucket: "blocked", hold_reason: "Wait for K2 | A: Proceed | B: Hold", repo: "maple-workshop", title: "K3 Held Step", structured: true, unresolved_blocker_ids: ["K2"] },
    { id: "K4", state: "queued", repo: "orchard-atlas", title: "K4 Cross-Project Join", structured: true, unresolved_blocker_ids: ["K3"] },
    { id: "K6", state: "queued", repo: "orchard-atlas", title: "K6 Downstream Leaf", structured: true, unresolved_blocker_ids: ["K4"] },
    { id: "U1", state: "queued", repo: "maple-workshop", title: "U1 Unrelated Task", structured: true, unresolved_blocker_ids: [] },
  ];
  const tasks = [
    {
      id: "K2", kind: "ship", project: `${HOME}/projects/maple-workshop`, branch: "fm/K2", harness: "codex", backend: "hc",
      mode: "no-mistakes", yolo: false, spawn_gen: "s1", remote: "origin", secondmate_projects: [],
      paths: { home: HOME, meta: "", status_log: "", worktree: { path: "", present: false }, report: { path: "", present: false } },
      current_state: { state: "working", source: "pane", detail: "building", raw: "building", observed_at: "2026-11-13T03:46:13Z", freshness: "fresh" },
      endpoint: { target: null, exists: false, agent_alive: "not_checked", status: "absent", observed_at: "2026-11-13T03:46:13Z", freshness: "fresh" },
      pr: { url: null, source: "absent", head: null },
      hints: { pending_decision: false, blocked_event: false, open_decisions: [], scout_report_present: false, last_event_text: "working [at=1]: building" },
      actions: { watch: "", steer: "", return_channel_note: null },
      backlog: { id: "K2", state: "in_flight", kind: "ship", repo: "maple-workshop", title: "K2 Root Blocker" },
    },
  ];
  const b = await board({
    snapshot: { schema: "fm-fleet-snapshot.v1", fm_home: HOME, tasks, backlog: { records } },
  });
  b.view.size = { width: 1280, height: 800 };
  b.redraw();

  // Hovering a chain card highlights upstream, selected, and downstream without dimming unrelated cards.
  b.hover("card-K3", true);
  assert.equal(b.text("hl-K2"), "Upstream");
  assert.equal(b.text("hl-K3"), "Selected");
  assert.equal(b.text("hl-K4"), "Downstream");
  assert.equal(b.text("hl-K6"), "Downstream");
  assert.equal(b.view.highlight.dimmedIds.size, 0);
  const u1HoverCalls = b.items.find((x) => x.id === "card-U1").calls;
  assert.ok(!u1HoverCalls.some((c) => c[0] === "opacity" && c[1] === 0.35), "hover alone must not dim unrelated cards");
  b.hover("card-K3", false);
  assert.ok(!b.ids.includes("hl-K3"));

  // Clicking a badge opens the Dependency Inspector in the wide split and dims unrelated cards.
  b.click("blocks-K3");
  assert.ok(b.ids.includes("inspector-wrap"));
  assert.ok(b.ids.includes("dep-inspector"));
  assert.ok(!b.ids.includes("dep-inspector-compact"));
  assert.equal(b.text("hl-K2"), "Upstream");
  assert.equal(b.text("hl-K3"), "Selected");
  assert.equal(b.text("hl-K4"), "Downstream");
  assert.ok(b.view.highlight.dimmedIds.has("U1"));
  const u1SelectedCalls = b.items.find((x) => x.id === "card-U1").calls;
  assert.ok(u1SelectedCalls.some((c) => c[0] === "opacity" && c[1] === 0.35), "selected chain must dim unrelated cards");

  // Clicking a node in the Dependency Inspector focuses and scrolls to that card, showing its
  // folded card and collapsed column open without changing the saved folds.
  b.view.folded.add("card:K4");
  b.view.collapsed.add("queued");
  b.redraw();
  assert.ok(!b.ids.includes("tag-K4"));
  assert.ok(!b.ids.includes("list-queued"));
  b.click("dep-node-K4");
  assert.equal(b.view.selectedCardId, "K4");
  assert.ok(b.ids.includes("tag-K4"));
  assert.ok(b.ids.includes("list-queued"));
  assert.ok(b.view.folded.has("card:K4"));
  assert.ok(b.view.collapsed.has("queued"));
  // Queued draws K4, K6, U1 in backlog order, so K4 is the column list's first item.
  assert.deepEqual(Array.from(b.scrolled), [0]);
  assert.equal(b.text("hl-K2"), "Upstream");
  assert.equal(b.text("hl-K3"), "Upstream");
  assert.equal(b.text("hl-K4"), "Selected");
  assert.equal(b.text("hl-K6"), "Downstream");

  // A later, unrelated fold click saves only that fold; folding K4 again drops the temporary reveal.
  b.click("fold-card:K6");
  assert.ok(b.view.folded.has("card:K6"));
  assert.ok(b.view.folded.has("card:K4"));
  assert.ok(b.ids.includes("tag-K4"));
  b.click("fold-card:K4");
  assert.ok(!b.ids.includes("tag-K4"));
  assert.ok(b.view.folded.has("card:K4"));
  b.click("fold-card:K6");

  // On a narrow board (< STACK_BELOW_PX = 720), the compact chain card is pinned at the top of board instead of the split.
  b.view.size = { width: 520, height: 800 };
  b.view.splitWasOpen = false;
  b.view.rightSplitWidth = 0;
  b.redraw();
  assert.ok(b.ids.includes("dep-inspector-compact"));
  assert.ok(!b.ids.includes("inspector-wrap"));
  assert.ok(b.ids.indexOf("dep-inspector-compact") < b.ids.indexOf("col-held"));
  // The compact card sits above the scrolling board, not inside it, so it stays pinned and a
  // node click scrolls the board to the position of the card's column among the drawn columns.
  assert.ok(b.ids.indexOf("dep-inspector-compact") < b.ids.indexOf("board"));
  b.scrolled.length = 0;
  b.click("dep-node-K6");
  const drawnColumns = b.ids.filter((id) => id.startsWith("col-"));
  assert.deepEqual(Array.from(b.scrolled), [drawnColumns.indexOf("col-queued")]);
  assert.equal(drawnColumns.indexOf("col-queued"), 1);

  // Escape clears the selection and closes the inspector.
  b.keyDown("root", "escape");
  assert.equal(b.view.selectedCardId, null);
  assert.equal(b.view.inspectorOpen, false);
  assert.ok(!b.ids.includes("dep-inspector-compact"));
  assert.equal(b.view.highlight.dimmedIds.size, 0);

  // Toolbar toggle opens and Close button closes it.
  b.view.size = { width: 1280, height: 800 };
  b.redraw();
  b.click("dep-inspector-toggle");
  assert.equal(b.view.inspectorOpen, true);
  assert.ok(b.ids.includes("dep-inspector"));
  b.click("dep-inspector-close");
  assert.equal(b.view.inspectorOpen, false);
  assert.equal(b.view.selectedCardId, null);
  assert.ok(!b.ids.includes("dep-inspector"));

  // A node whose card the active search hides clears the search, so the card is drawn and scrolled to.
  b.view.query = "K3 Held";
  b.redraw();
  assert.ok(!b.ids.includes("card-K6"));
  b.click("blocks-K3");
  b.scrolled.length = 0;
  b.click("dep-node-K6");
  assert.equal(b.view.query, "");
  assert.ok(b.ids.includes("card-K6"));
  assert.deepEqual(Array.from(b.scrolled), [1]);
});

test("an inspector node for a blocker that is not on the board gets a neutral tag", async () => {
  const records = [
    { id: "X1", state: "queued", repo: "maple-workshop", title: "X1 Waits on ghost", structured: true, unresolved_blocker_ids: ["ghost-task"] },
  ];
  const b = await board({ snapshot: { schema: "fm-fleet-snapshot.v1", fm_home: HOME, tasks: [], backlog: { records } } });
  b.view.size = { width: 1280, height: 800 };
  b.redraw();
  b.click("waits-X1");
  assert.equal(b.text("dep-tag-ghost-task"), "unknown");
  assert.equal(b.text("dep-tag-X1"), b.text("tag-X1"));
  assert.notEqual(b.text("dep-tag-ghost-task"), b.text("tag-X1"));
});

