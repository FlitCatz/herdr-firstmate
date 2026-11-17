// Draws the Board from tests/fixtures/snapshot.json outside Herdr and checks what it draws.
// Run with: node --test tests/
// The fixture is fictional but has the shape fm-fleet-snapshot.sh really prints, and the first
// test holds it to that shape: a fixture field the real snapshot does not have once hid a bug.
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { promisify } from "node:util";
import vm from "node:vm";

const runFile = promisify(execFile);

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

const LAYOUT_CALLS = new Set([
  "border", "border_t", "border_r", "border_b", "border_l",
  "p", "px", "py", "pt", "pr", "pb", "pl",
  "gap", "gap_x", "gap_y",
  "w", "h", "size", "size_full", "min_w", "min_h", "max_w", "max_h",
  "top", "left", "right", "bottom", "absolute", "relative",
  "flex_1", "flex_none", "flex_shrink", "flex_wrap",
  "items_center", "items_start", "items_stretch", "justify_between", "justify_center",
]);

function geometry(items) {
  const map = {};
  for (const item of items) {
    map[item.id] = {
      calls: item.calls.filter(([name]) => LAYOUT_CALLS.has(name)),
      childIds: item.childIds,
      text: item.text,
    };
  }
  return map;
}

// The Board with the fixture loaded, as Herdr would run it with the preview props.
async function board({ projects, store = { getItem: () => null, setItem() {} }, registryFails = false, exec = async () => ({ code: 1, stdout: "", stderr: "" }), snapshot: customSnapshot = null, ui = {}, checkMode = false, preview = true, theme: customTheme = null, prViewer = false, rootLayout = null, terminals = [] } = {}) {
  // The registry the Board reads; tests change it, then reload.
  const registry = { projects: projects ?? ["maple-workshop", "orchard-atlas"], fails: registryFails };
  const source = (await readFile(new URL("mods/fm-board/main.js", root), "utf8"))
    .replace(/^import .*;$/gm, "").replace("export default class FmBoard", "class FmBoard");
  const pending = [];
  const initEffects = [];
  // Overlays the Board opened and Herdr commands it ran, in order.
  const overlays = [];
  const commands = [];
  const sharedSet = [];
  // One-shot timers the Board set after init, in order, so a test can let time pass.
  const timers = [];
  const scrolled = [];
  const focused = [];
  const cx = {
    notify() {}, stop_propagation() {}, spawn(fn) { initEffects.push("spawn"); pending.push(fn(cx)); },
    timer: { every() { initEffects.push("timer"); }, after(ms, fn) { initEffects.push("timer"); timers.push({ ms, fn }); } },
    focus_handle() { const handle = { focus() { focused.push(handle); }, is_focused: () => focused.at(-1) === handle, release: () => true }; return handle; },
  };
  const input = () => { let text = ""; return { on() {}, value: () => text, set_value(v) { text = v; } }; };
  const theme = customTheme
    ? new Proxy(customTheme, { get: (target, k) => (k in target ? target[k] : "#808080") })
    : new Proxy({}, { get: () => "#808080" });
  const scope = {
    View: class {}, div: element, svg: element, v_flex: element, h_flex: element, Input: { new: element },
    h_resizable: element, resizable_panel: element, InputState: { new: input },
    ScrollHandle: { new: () => { const handle = { scroll_to_item(idx) { scrolled.push({ handle, idx }); } }; return handle; } },
    FolderViewer: class { constructor() { this.root = null; } close() { this.root = null; } },
    props: () => ({ home: HOME, ...(preview ? { snapshot_file: snapshotFile } : {}), collapsed: [], ui }),
    checking: () => checkMode,
    theme: () => theme, settings: () => ({ font_size: 14 }), terminals: () => terminals, focused: () => null,
    run: (name, args) => { commands.push({ name, args }); },
    openOverlay: (spec) => { overlays.push(spec); return `overlay-${overlays.length}`; },
    layout: () => rootLayout, setShared: (key, value) => { sharedSet.push({ key, value }); },
    appHome: () => "/fictional/herdr-home",
    localStorage: store,
    readTextFile: async (file) => {
      initEffects.push("read");
      if (file === "/fictional/herdr-home/mods/herdr-pr-viewer/mod.json") {
        return prViewer ? "{}" : null;
      }
      if (file === snapshotFile) return customSnapshot ? JSON.stringify(customSnapshot) : readFile(file, "utf8");
      if (file === `${HOME}/data/projects.md`) {
        if (registry.fails) throw new Error("registry unreadable");
        return registry.projects.map((name) => `- ${name} - Fictional project.\n`).join("");
      }
      throw new Error(`no such file: ${file}`);
    },
    // By default no helper program exists here, and the Board treats every one as failed.
    exec: (...args) => { initEffects.push("exec"); return exec(...args); },
    watchFolder: () => { initEffects.push("watch"); return new Promise(() => {}); }, pickFolder: async () => null,
  };
  const {
    FmBoard, cardsFrom, dependencyGraph, chainHighlight, chainSpineLayout,
    chainJoint, placeChainLane, chainGutterSpecs, chainCellSpecs, chainEdgeColor,
    CHAIN_CARD_W, CHAIN_GUT, CHAIN_PORT_TOP, CHAIN_PORT_STEP, CHAIN_R, CHAIN_HEAD_W, CHAIN_HEAD_H,
    waitingLabel, blocksLabel,
  } = vm.runInNewContext(
    `${source}\n({ FmBoard, cardsFrom, dependencyGraph, chainHighlight, chainSpineLayout, chainJoint, placeChainLane, chainGutterSpecs, chainCellSpecs, chainEdgeColor, CHAIN_CARD_W, CHAIN_GUT, CHAIN_PORT_TOP, CHAIN_PORT_STEP, CHAIN_R, CHAIN_HEAD_W, CHAIN_HEAD_H, waitingLabel, blocksLabel })`,
    scope,
  );
  const view = new FmBoard();
  view.init({}, cx);
  await Promise.all(preview ? pending : pending.slice(0, 1));
  if (!registryFails) assert.equal(view.error, null);
  const drafts = [], opened = [];
  view.insertCardText = (text) => drafts.push(text);
  view.openView = (project, source, cx) => { view.clearChainSelection(cx); opened.push({ project, ...source }); };
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
    view, registry, reload, cardsFrom, dependencyGraph, chainHighlight, chainSpineLayout,
    chainJoint, placeChainLane, chainGutterSpecs, chainCellSpecs, chainEdgeColor,
    CHAIN_CARD_W, CHAIN_GUT, CHAIN_PORT_TOP, CHAIN_PORT_STEP, CHAIN_R, CHAIN_HEAD_W, CHAIN_HEAD_H,
    waitingLabel, blocksLabel, initEffects,
    get items() { return items; },
    get ids() { return items.map((x) => x.id); },
    click, hover, keyDown, scrolled, focused, drafts, opened, redraw, overlays, commands, sharedSet, timers,
    // Waits for the tasks the Board started, such as a PR link's install check.
    settle: () => Promise.all(pending),
    text: (id) => items.find((x) => x.id === id)?.text,
    // Every scroll so far, as its index when it went through the handle the drawn element with
    // this id tracks, so a scroll on any other handle (which moves nothing there) shows up.
    scrollsOn: (id) => {
      const handle = items.find((x) => x.id === id)?.calls.find((c) => c[0] === "track_scroll")?.[1];
      assert.ok(handle, `${id} tracks no scroll handle`);
      return scrolled.map((s) => (s.handle === handle ? s.idx : `other handle at ${s.idx}`));
    },
    // Whether the keyboard was last moved onto the focus handle the drawn element with this id tracks.
    focusedOn: (id) => {
      const handle = items.find((x) => x.id === id)?.calls.find((c) => c[0] === "track_focus")?.[1];
      assert.ok(handle, `${id} tracks no focus handle`);
      return focused.at(-1) === handle;
    },
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
  const b = await board({ ui: { bottomTab: "projects" }, projects: MANY_PROJECTS });
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
  const b = await board({ ui: { bottomTab: "projects" }, projects: ["birch-ledger", "cedar-signal", "maple-workshop", "orchard-atlas"] });
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
  const b = await board({ ui: { bottomTab: "projects" }, projects: ["birch-ledger", "cedar-signal", "maple-workshop", "orchard-atlas"], store });
  b.view.projects.unshift({ name: "aspen-docs", mode: "no-mistakes", yolo: false, desc: "Fictional project." });
  const before = tagColors(b.redraw());
  const again = tagColors((await board({ ui: { bottomTab: "projects" }, projects: ["aspen-docs", "maple-workshop"], store })).items);
  assert.deepEqual(again, { "aspen-docs": before["aspen-docs"], "maple-workshop": before["maple-workshop"] });
});

test("the first 14 projects get distinct palette colors in name order, and the 15th one from its name", async () => {
  const b = await board({ ui: { bottomTab: "projects" }, projects: MANY_PROJECTS, store: memoryStore() });
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
  const b = await board({ ui: { bottomTab: "projects" }, store: memoryStore() });
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
  const b = await board({ ui: { bottomTab: "projects" }, projects: ["birch-ledger", "cedar-signal", "maple-workshop", "orchard-atlas"], store });
  const palette = paletteOf(b);
  const before = tagColors(b.items);
  assert.deepEqual(before, { "birch-ledger": palette[0], "cedar-signal": palette[1], "maple-workshop": palette[2], "orchard-atlas": palette[3] });
  b.registry.projects = ["birch-ledger", "maple-workshop", "orchard-atlas"];
  await b.reload();
  b.registry.projects = ["birch-ledger", "maple-workshop", "orchard-atlas", "zinnia-board"];
  const after = tagColors(await b.reload());
  // cedar-signal's hue is the lowest free one, so the new project takes it even though it sorts last.
  assert.deepEqual(after, { "birch-ledger": palette[0], "maple-workshop": palette[2], "orchard-atlas": palette[3], "zinnia-board": palette[1] });
  const again = tagColors((await board({ ui: { bottomTab: "projects" }, projects: ["birch-ledger", "maple-workshop", "orchard-atlas", "zinnia-board"], store })).items);
  assert.deepEqual(again, after);
});

test("a project removed from the registry keeps its hue while its cards remain", async () => {
  const store = memoryStore();
  const b = await board({ ui: { bottomTab: "projects" }, projects: ["maple-workshop", "orchard-atlas", "birch-ledger"], store });
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
  const b = await board({ ui: { bottomTab: "projects" }, projects: ["birch-ledger", "maple-workshop", "orchard-atlas"], store });
  const saved = store.getItem("autoProjectColors");
  b.registry.projects = [];
  await b.reload();
  assert.equal(store.getItem("autoProjectColors"), saved);
  b.registry.fails = true;
  await b.reload();
  assert.ok(b.view.error);
  assert.equal(store.getItem("autoProjectColors"), saved);
  // A Board whose first read fails has nothing on screen and must not touch the saved colors.
  const fresh = await board({ ui: { bottomTab: "projects" }, projects: ["maple-workshop"], store, registryFails: true });
  assert.ok(fresh.view.error);
  assert.equal(store.getItem("autoProjectColors"), saved);
});

test("two Board copies sharing the store never overwrite each other's colors", async () => {
  const store = memoryStore();
  const a = await board({ ui: { bottomTab: "projects" }, store });
  const b = await board({ ui: { bottomTab: "projects" }, store });
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
  const b = await board({ ui: { bottomTab: "projects" }, projects: ["birch-ledger", "cedar-signal", "maple-workshop", "orchard-atlas"], store });
  const palette = paletteOf(b);
  const expected = { "birch-ledger": palette[0], "cedar-signal": palette[1], "maple-workshop": palette[2], "orchard-atlas": palette[3] };
  assert.deepEqual(tagColors(b.items), expected);
  assert.deepEqual(JSON.parse(data.get("autoProjectColors")), expected);
});

test("a store that cannot be read or written still draws, with colors from the names", async () => {
  const broken = { getItem() { throw new Error("denied"); }, setItem() { throw new Error("denied"); } };
  const b = await board({ ui: { bottomTab: "projects" }, store: broken });
  const palette = paletteOf(b);
  const expected = Object.fromEntries(["maple-workshop", "orchard-atlas"].map((name) => [name, palette[fnv1a(name) % palette.length]]));
  assert.deepEqual(tagColors(b.items), expected);
  assert.deepEqual(tagColors(b.redraw()), expected);
});

test("a project's tag color is one of the palette colors, the same on its cards, and a picked color wins", async () => {
  const b = await board({ ui: { bottomTab: "projects" }, projects: MANY_PROJECTS });
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

test("a failed task is drawn in Blocked with a red Failed label, an ordinary blocked task has none, and no Failed column exists", async () => {
  const makeTask = (id, state, blockedEvent, lastEvent) => ({
    id, kind: "ship", project: `${HOME}/projects/orchard-atlas`, branch: `fm/${id}`, harness: "claude", backend: "hc",
    mode: "no-mistakes", yolo: false, spawn_gen: "s1", remote: "origin", secondmate_projects: [],
    paths: { home: HOME, meta: "", status_log: "", worktree: { path: "", present: false }, report: { path: "", present: false } },
    current_state: { state, source: "status_log", detail: "tests did not pass", raw: "", observed_at: "2026-11-13T03:46:13Z", freshness: "fresh" },
    endpoint: { target: null, exists: false, agent_alive: "not_checked", status: "absent", observed_at: "2026-11-13T03:46:13Z", freshness: "fresh" },
    pr: { url: null, source: "absent", head: null },
    hints: { pending_decision: false, blocked_event: blockedEvent, open_decisions: [], scout_report_present: false, last_event_text: lastEvent },
    actions: { watch: "", steer: "", return_channel_note: null },
    backlog: { id, state: "in_flight", kind: "ship", repo: "orchard-atlas", title: id },
  });
  const tasks = [
    makeTask("broke-build", "failed", false, "failed [at=1]: tests did not pass"),
    makeTask("needs-file", "blocked", true, "blocked [at=1]: waiting for a file"),
  ];
  const records = [
    ...tasks.map((x) => ({ id: x.id, state: "in_flight", kind: "ship", repo: "orchard-atlas", title: x.id, structured: true })),
    { id: "after-build", state: "queued", repo: "orchard-atlas", title: "after-build", structured: true, unresolved_blocker_ids: ["broke-build", "needs-file"] },
  ];
  const b = await board({
    theme: { ansi1: "#cc0000", blocked: "#0000cc" },
    snapshot: { schema: "fm-fleet-snapshot.v1", fm_home: HOME, tasks, backlog: { records } },
  });
  const card = (id) => b.view.cards.find((c) => c.id === id);
  assert.equal(card("broke-build").column, "blocked");
  assert.equal(card("needs-file").column, "blocked");
  // The card keeps its detail text, and the label is the theme's red.
  assert.equal(card("broke-build").detail, "tests did not pass");
  const label = b.items.find((x) => x.id === "failed-broke-build");
  assert.equal(label?.text, "Failed");
  assert.ok(label.calls.some((c) => c[0] === "text_color" && c[1] === "#cc0000"));
  assert.equal(b.items.find((x) => x.id === "failed-needs-file"), undefined);
  // A failed card also has a red border; an ordinary blocked card keeps the plain one.
  const border = (id) => b.items.find((x) => x.id === `card-${id}`).calls.find((c) => c[0] === "border_color")?.[1];
  assert.equal(border("broke-build"), "#cc0000");
  assert.equal(border("needs-file"), "#808080");
  assert.ok(b.ids.includes("col-blocked"));
  assert.ok(!b.ids.includes("col-failed"));
  // In the chain a waiting card shows, the failed step's dot and label are red, the blocked step's are not.
  const theme = new Proxy({ ansi1: "#cc0000", blocked: "#0000cc" }, { get: (o, k) => (k in o ? o[k] : "#808080") });
  const steps = [];
  const walk = (el) => {
    if (!el || typeof el !== "object") return;
    const { kids } = el.node;
    const label = kids.at(-1)?.node, dot = kids[0]?.node;
    if (kids.length === 3 && typeof label?.kids[0] === "string" && typeof kids[1]?.node?.kids[0] === "string") {
      steps.push({ title: kids[1].node.kids[0], label: label.kids[0],
        dot: dot.calls.find((c) => c[0] === "bg")?.[1], color: label.calls.find((c) => c[0] === "text_color")?.[1] });
    }
    kids.forEach(walk);
  };
  walk(b.view.chain(card("after-build"), theme));
  const stepOf = (title) => steps.find((s) => s.title === title);
  assert.deepEqual({ ...stepOf("broke-build") }, { title: "broke-build", label: "failed", dot: "#cc0000", color: "#cc0000" });
  assert.deepEqual({ ...stepOf("needs-file") }, { title: "needs-file", label: "blocked", dot: "#0000cc", color: "#0000cc" });
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

  // Hovering a chain card highlights upstream, selected, and downstream by role/color without adding pills or dimming unrelated cards.
  b.hover("card-K3", true);
  assert.equal(b.view.highlight.roles.get("K2"), "upstream");
  assert.equal(b.view.highlight.roles.get("K3"), "selected");
  assert.equal(b.view.highlight.roles.get("K4"), "downstream");
  assert.equal(b.view.highlight.roles.get("K6"), "downstream");
  assert.ok(!b.ids.includes("hl-K3"), "hover must not insert role pills");
  assert.equal(b.view.highlight.dimmedIds.size, 0);
  const u1HoverCalls = b.items.find((x) => x.id === "card-U1").calls;
  assert.ok(!u1HoverCalls.some((c) => c[0] === "opacity" && c[1] === 0.35), "hover alone must not dim unrelated cards");
  b.hover("card-K3", false);
  assert.equal(b.view.highlight.roles.size, 0);

  // Clicking a badge opens the Dependency Inspector in the wide split and dims unrelated cards.
  // Escape travels the keyboard's focus path, so picking a chain moves the keyboard onto the Board.
  assert.ok(!b.focusedOn("root"));
  b.click("blocks-K3");
  assert.ok(b.focusedOn("root"), "a badge click moves the keyboard onto the Board");
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
  b.focused.length = 0;
  b.click("dep-node-K4");
  assert.ok(b.focusedOn("root"), "an inspector node click moves the keyboard onto the Board");
  assert.equal(b.view.selectedCardId, "K4");
  assert.ok(b.ids.includes("tag-K4"));
  assert.ok(b.ids.includes("list-queued"));
  assert.ok(b.view.folded.has("card:K4"));
  assert.ok(b.view.collapsed.has("queued"));
  // Queued draws K4, K6, U1 in backlog order, so K4 is the column list's first item.
  assert.deepEqual(b.scrollsOn("list-queued"), [0]);
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
  // A long chain scrolls inside the compact card instead of pushing the board out of a short pane.
  const levelCalls = b.items.find((x) => x.id === "dep-inspector-levels").calls;
  const cap = levelCalls.find((c) => c[0] === "max_h")?.[1];
  assert.ok(cap > 0 && cap < b.view.size.height, `compact chain height cap ${cap}`);
  assert.ok(levelCalls.some((c) => c[0] === "overflow_y_scroll"));
  b.scrolled.length = 0;
  b.click("dep-node-K6");
  assert.equal(b.text("hl-K6"), "Selected");
  assert.ok(b.ids.includes("dep-inspector-compact"));
  const drawnColumns = b.ids.filter((id) => id.startsWith("col-"));
  assert.equal(drawnColumns.indexOf("col-queued"), 1);
  assert.deepEqual(b.scrollsOn("board"), [drawnColumns.indexOf("col-queued")]);

  // Escape clears the selection and closes the inspector; the keyboard is on root, where its handler sits.
  assert.ok(b.focusedOn("root"));
  b.keyDown("root", "escape");
  assert.equal(b.view.selectedCardId, null);
  assert.equal(b.view.inspectorOpen, false);
  assert.ok(!b.ids.includes("dep-inspector-compact"));
  assert.equal(b.view.highlight.dimmedIds.size, 0);

  // Toolbar toggle opens and Close button closes it.
  b.view.size = { width: 1280, height: 800 };
  b.redraw();
  b.focused.length = 0;
  b.click("dep-inspector-toggle");
  assert.ok(b.focusedOn("root"), "the toolbar toggle moves the keyboard onto the Board");
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
  assert.equal(b.text("hl-K6"), "Selected");
  // K6 is the second card drawn in Queued (K4, K6, U1).
  assert.deepEqual(b.scrollsOn("list-queued"), [1]);

  // Opening a Files · Changes viewer takes the inspector's split slot, so it ends the chain
  // selection: nothing stays dimmed, the toolbar offers to open the inspector, and closing the
  // viewer does not bring the inspector back.
  assert.ok(b.view.highlight.dimmedIds.has("U1"));
  const viewer = b.view.viewer;
  viewer.target = (path) => { viewer.root = path; };
  viewer.render = () => null;
  Object.getPrototypeOf(b.view).openView.call(b.view, "maple-workshop", { path: `${HOME}/projects/maple-workshop`, title: "local copy" }, { notify() {} });
  b.redraw();
  assert.equal(b.view.selectedCardId, null);
  assert.equal(b.view.highlight.dimmedIds.size, 0);
  assert.ok(!b.ids.includes("hl-K6"));
  assert.ok(b.items.find((x) => x.id === "dep-inspector-toggle").calls.some((c) => c[0] === "tooltip" && c[1] === "Open Dependency Inspector"));
  viewer.root = null;
  b.redraw();
  assert.ok(!b.ids.includes("dep-inspector"));
  assert.ok(!b.ids.includes("inspector-wrap"));
});

test("the Inspector toggle shows the no-chains message on wide and narrow boards alike", async () => {
  const records = [
    { id: "S1", state: "queued", repo: "maple-workshop", title: "S1 Standalone", structured: true, unresolved_blocker_ids: [] },
  ];
  const b = await board({ snapshot: { schema: "fm-fleet-snapshot.v1", fm_home: HOME, tasks: [], backlog: { records } } });
  const message = "No active task dependencies in the current backlog snapshot.";
  for (const width of [1280, 520]) {
    b.view.size = { width, height: 800 };
    b.view.splitWasOpen = false;
    b.view.rightSplitWidth = 0;
    b.redraw();
    b.click("dep-inspector-toggle");
    const panel = width < 720 ? "dep-inspector-compact" : "dep-inspector";
    assert.ok(b.text(panel)?.includes(message), `${panel} at ${width}px`);
    b.click("dep-inspector-close");
    assert.ok(!b.ids.includes(panel));
  }
});

test("the inspector opens in the split only when the Board half beside it stays unstacked", async () => {
  const records = [
    { id: "A1", state: "queued", repo: "maple-workshop", title: "A1 Root", structured: true, unresolved_blocker_ids: [] },
    { id: "A2", state: "queued", repo: "maple-workshop", title: "A2 Waits", structured: true, unresolved_blocker_ids: ["A1"] },
  ];
  const b = await board({ snapshot: { schema: "fm-fleet-snapshot.v1", fm_home: HOME, tasks: [], backlog: { records } } });
  const STACK_BELOW = 720; // the README's narrow-board threshold
  // The width the split's right panel opens at, read from the drawn panel that holds the inspector
  // in the opening frame (this stand-in never measures the two halves, as Herdr would next).
  const panelWidth = () => {
    b.view.splitWasOpen = false;
    const find = (kid) => {
      if (!kid || typeof kid !== "object") return null;
      if (kid.node.kids.some((k) => k?.node?.id === "inspector-wrap")) return kid.node;
      for (const k of kid.node.kids) { const hit = find(k); if (hit) return hit; }
      return null;
    };
    return find(b.view.render({ notify() {} }))?.calls.find((c) => c[0] === "size")?.[1];
  };
  // 767px is where the split once drew ~40px-wide unstacked columns beside the inspector.
  for (const width of [767, 900, 1000, 1080, 1100, 1280, 1600]) {
    b.view.size = { width, height: 800 };
    b.view.splitWasOpen = false;
    b.view.rightSplitWidth = 0;
    b.redraw();
    b.click("dep-inspector-toggle");
    if (b.ids.includes("inspector-wrap")) {
      assert.ok(!b.ids.includes("dep-inspector-compact"));
      assert.ok(width - panelWidth() >= STACK_BELOW, `split at ${width}px leaves the Board ${width - panelWidth()}px`);
    } else {
      assert.ok(b.ids.includes("dep-inspector-compact"), `no inspector drawn at ${width}px`);
      assert.ok(!b.items.find((x) => x.id === "board").calls.some((c) => c[0] === "track_scroll"), `compact board at ${width}px keeps its columns side by side`);
    }
    if (width === 767) assert.ok(b.ids.includes("dep-inspector-compact"), "767px uses the compact card");
    if (width >= 1280) assert.ok(b.ids.includes("inspector-wrap"), `${width}px uses the split`);
    b.click("dep-inspector-close");
  }

  // Dragging the divider keeps the split; the Board half stacks once it measures below the threshold.
  b.view.size = { width: 1280, height: 800 };
  b.view.splitWasOpen = false;
  b.view.rightSplitWidth = 0;
  b.redraw();
  b.click("dep-inspector-toggle");
  b.view.size = { width: 600, height: 800 };
  b.view.rightSplitWidth = 680;
  b.redraw();
  assert.ok(b.ids.includes("inspector-wrap"));
  assert.ok(!b.ids.includes("dep-inspector-compact"));
  assert.ok(b.items.find((x) => x.id === "board").calls.some((c) => c[0] === "track_scroll"), "the dragged-narrow Board half stacks");
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

test("Chains view toggle persists across reloads while Kanban stays the default", async () => {
  const store = memoryStore();
  const b1 = await board({ store });
  assert.equal(b1.view.viewMode, "kanban");
  assert.ok(b1.ids.includes("view-mode-toggle"));
  assert.equal(b1.text("view-mode-kanban"), "Kanban");
  assert.equal(b1.text("view-mode-chains"), "Chains (2)");
  assert.ok(b1.ids.includes("board"));
  assert.ok(!b1.ids.includes("chains-board"));

  // Switching to Chains remembers the choice in localStorage and hides Kanban columns.
  b1.click("view-mode-chains");
  assert.equal(b1.view.viewMode, "chains");
  assert.ok(b1.ids.includes("chains-board"));
  assert.ok(!b1.ids.includes("board"));
  assert.ok(!b1.ids.includes("dep-inspector-toggle"));

  const b2 = await board({ store });
  assert.equal(b2.view.viewMode, "chains");
  assert.ok(b2.ids.includes("chains-board"));

  // Switching back to Kanban persists too.
  b2.click("view-mode-kanban");
  assert.equal(b2.view.viewMode, "kanban");
  const b3 = await board({ store });
  assert.equal(b3.view.viewMode, "kanban");
  assert.ok(b3.ids.includes("board"));
});

test("Chains view groups components, orders lanes by most blocking / deepest first, and lays out spine and branch tracks", async () => {
  const store = memoryStore();
  const b = await board({ store });
  b.view.size = { width: 1280, height: 800 };
  b.click("view-mode-chains");

  // Always-visible static legend renders at the top of Chains view.
  assert.ok(b.ids.includes("chain-legend"));
  assert.ok(b.text("chain-legend").includes("upstream"));
  assert.ok(b.text("chain-legend").includes("selected"));
  assert.ok(b.text("chain-legend").includes("downstream"));
  assert.ok(b.text("chain-legend").includes("cross-project"));

  // Two connected components from the extended fixture:
  // chain-1: maple-theme-tokens (blocks 4, depth 4) with branch orchard-theme-sync
  // chain-2: orchard-map-labels (blocks 1, depth 2)
  const lanes = b.ids.filter((id) => id.startsWith("chain-lane-"));
  assert.deepEqual(lanes, ["chain-lane-chain-1", "chain-lane-chain-2"]);
  assert.ok(b.text("head-chain-chain-1").includes("CHAIN 1"));
  assert.ok(b.text("head-chain-chain-1").includes("CRITICAL PATH"));
  assert.ok(b.text("head-chain-chain-1").includes("CROSS-PROJECT"));
  assert.ok(b.text("head-chain-chain-1").includes("maple-theme-tokens → maple-release-bundle"));
  assert.ok(b.text("head-chain-chain-2").includes("CHAIN 2"));
  assert.ok(b.text("head-chain-chain-2").includes("orchard-map-labels → orchard-label-polish"));

  // Longest path spine runs left-to-right with positioned line + SVG arrowhead connectors; side branch sits on row 1.
  const spineItems = b.items.find((x) => x.id === "chain-spine-chain-1");
  assert.ok(spineItems, "main spine track drawn");
  assert.ok(b.ids.includes("chain-edge-maple-theme-tokens-maple-card-layout-line"));
  assert.ok(b.ids.includes("chain-edge-maple-theme-tokens-maple-card-layout-head"));
  assert.ok(b.ids.includes("chain-edge-maple-theme-tokens-orchard-theme-sync-corner-tr"));
  assert.ok(b.ids.includes("chain-edge-maple-theme-tokens-orchard-theme-sync-corner-bl"));
  const spineOrder = ["chain-node-maple-theme-tokens", "chain-node-maple-card-layout", "chain-node-maple-panel-polish", "chain-node-maple-release-bundle"]
    .map((id) => b.ids.indexOf(id));
  assert.ok(spineOrder.every((idx, i) => idx >= 0 && (i === 0 || idx > spineOrder[i - 1])), `spine order: ${spineOrder}`);

  assert.ok(b.ids.includes("chain-branches-chain-1"), "side branch rendered on second track");
  const branchText = b.text("chain-branches-chain-1");
  assert.ok(branchText.includes("SIDE BRANCH"));
  assert.ok(branchText.includes("forks from theme-tokens"));
  assert.ok(branchText.includes("Sync map colors with tokens"));
  assert.ok(b.ids.indexOf("chain-branches-chain-1") > b.ids.indexOf("chain-spine-chain-1"));

  // Each node shows project, priority, status, and PR link when present.
  assert.equal(b.text("cnode-tag-maple-theme-tokens"), b.view.tags.get("maple-workshop"));
  assert.equal(b.text("cnode-prio-maple-theme-tokens"), "P0");
  assert.equal(b.text("cnode-status-maple-theme-tokens"), "working");
  assert.equal(b.text("cnode-pr-maple-theme-tokens"), "maple-workshop#42");
  assert.equal(b.text("cnode-status-maple-card-layout"), "waiting");

  // chainSpineLayout unit check: longest path beats shorter branch, and ties break cleanly.
  const { cardsFrom, dependencyGraph, chainSpineLayout } = b;
  const customCards = cardsFrom({
    backlog: {
      records: [
        { id: "R0", state: "in_flight", repo: "maple-workshop", title: "Root", structured: true, unresolved_blocker_ids: [] },
        { id: "B1", state: "queued", repo: "maple-workshop", title: "Short branch", structured: true, unresolved_blocker_ids: ["R0"] },
        { id: "L1", state: "queued", repo: "maple-workshop", title: "Long 1", structured: true, unresolved_blocker_ids: ["R0"] },
        { id: "L2", state: "queued", repo: "maple-workshop", title: "Long 2", structured: true, unresolved_blocker_ids: ["L1"] },
        { id: "L3", state: "queued", repo: "maple-workshop", title: "Long 3", structured: true, unresolved_blocker_ids: ["L2"] },
      ],
    },
  });
  const g = dependencyGraph(customCards);
  const layout = chainSpineLayout(g.components[0], g.nodes);
  assert.deepEqual(Array.from(layout.spine, (n) => n.id), ["R0", "L1", "L2", "L3"]);
  // Each level lists its spine node first, then the side branches at that level.
  assert.deepEqual(Array.from(layout.steps, (st) => Array.from(st.nodes, (n) => n.id)), [["R0"], ["L1", "B1"], ["L2"], ["L3"]]);
});

test("Chains view puts the most-blocking chain first while the Kanban Inspector keeps largest-chain-first order", async () => {
  // Join chain: four roots each block J (5 tasks, each root blocks 1).
  // Line chain: X0 -> X1 -> X2 (3 tasks, X0 blocks 2, deeper).
  const records = [
    { id: "R1", state: "queued", repo: "orchard-atlas", title: "Join root 1", structured: true, unresolved_blocker_ids: [] },
    { id: "R2", state: "queued", repo: "orchard-atlas", title: "Join root 2", structured: true, unresolved_blocker_ids: [] },
    { id: "R3", state: "queued", repo: "orchard-atlas", title: "Join root 3", structured: true, unresolved_blocker_ids: [] },
    { id: "R4", state: "queued", repo: "orchard-atlas", title: "Join root 4", structured: true, unresolved_blocker_ids: [] },
    { id: "J", state: "queued", repo: "orchard-atlas", title: "Join", structured: true, unresolved_blocker_ids: ["R1", "R2", "R3", "R4"] },
    { id: "X0", state: "queued", repo: "maple-workshop", title: "Line 0", structured: true, unresolved_blocker_ids: [] },
    { id: "X1", state: "queued", repo: "maple-workshop", title: "Line 1", structured: true, unresolved_blocker_ids: ["X0"] },
    { id: "X2", state: "queued", repo: "maple-workshop", title: "Line 2", structured: true, unresolved_blocker_ids: ["X1"] },
  ];
  const snapshot = { schema: "fm-fleet-snapshot.v1", fm_home: HOME, tasks: [], backlog: { records } };

  const chains = await board({ ui: { viewMode: "chains" }, snapshot });
  chains.view.size = { width: 1280, height: 800 };
  chains.redraw();
  const heads = chains.ids.filter((id) => id.startsWith("head-chain-"));
  assert.equal(heads.length, 2);
  assert.ok(chains.text(heads[0]).includes("CHAIN 1") && chains.text(heads[0]).includes("X0"), chains.text(heads[0]));
  assert.ok(chains.text(heads[1]).includes("CHAIN 2") && chains.text(heads[1]).includes("R1"), chains.text(heads[1]));

  const kanban = await board({ snapshot });
  kanban.view.size = { width: 1280, height: 800 };
  kanban.redraw();
  kanban.click("dep-inspector-toggle");
  assert.equal(kanban.view.inspectorOpen, true);
  assert.ok(kanban.view.highlight.selectedComponent.nodeIds.includes("J"), "Inspector opens the largest chain by default");
});

test("Chains spine edges light up only along the focused task's upstream and downstream path", async () => {
  // Spine A -> B -> C -> D; side task X waits on A only.
  const records = [
    { id: "A", state: "queued", repo: "maple-workshop", title: "Step A", structured: true, unresolved_blocker_ids: [] },
    { id: "B", state: "queued", repo: "maple-workshop", title: "Step B", structured: true, unresolved_blocker_ids: ["A"] },
    { id: "C", state: "queued", repo: "maple-workshop", title: "Step C", structured: true, unresolved_blocker_ids: ["B"] },
    { id: "D", state: "queued", repo: "maple-workshop", title: "Step D", structured: true, unresolved_blocker_ids: ["C"] },
    { id: "X", state: "queued", repo: "maple-workshop", title: "Side X", structured: true, unresolved_blocker_ids: ["A"] },
  ];
  const theme = {
    dim: "#777777",
    working: "#e5c07b",
    accent: "#61afef",
    ansi6: "#56b6c2",
    border: "#3a404b",
    muted: "#9aa1ad",
  };
  const b = await board({ theme, ui: { viewMode: "chains" }, snapshot: { schema: "fm-fleet-snapshot.v1", fm_home: HOME, tasks: [], backlog: { records } } });
  b.view.size = { width: 1280, height: 800 };
  const lineStyle = (edge) => {
    const el = b.items.find((x) => x.id === `chain-edge-${edge}-line`);
    return {
      color: el.calls.findLast((c) => c[0] === "border_color")?.[1],
      opacity: el.calls.findLast((c) => c[0] === "opacity")?.[1] ?? 1,
    };
  };

  b.redraw();
  assert.deepEqual(["A-B", "B-C", "C-D"].map(lineStyle), [
    { color: theme.dim, opacity: 1 },
    { color: theme.dim, opacity: 1 },
    { color: theme.dim, opacity: 1 },
  ]);

  b.click("chain-node-X");
  assert.equal(b.view.selectedCardId, "X");
  assert.deepEqual(lineStyle("A-X"), { color: theme.working, opacity: 1 }, "A -> X is on X's upstream path");
  assert.deepEqual(["A-B", "B-C", "C-D"].map(lineStyle), [
    { color: theme.dim, opacity: 0.4 },
    { color: theme.dim, opacity: 0.4 },
    { color: theme.dim, opacity: 0.4 },
  ], "off-path spine edges dim when X is selected");

  b.click("chain-node-X");
  b.click("chain-node-C");
  assert.deepEqual(lineStyle("A-B"), { color: theme.working, opacity: 1 });
  assert.deepEqual(lineStyle("B-C"), { color: theme.working, opacity: 1 });
  assert.deepEqual(lineStyle("C-D"), { color: theme.ansi6, opacity: 1 });
  assert.deepEqual(lineStyle("A-X"), { color: theme.dim, opacity: 0.4 });
});

test("Chains search steps through matches in the order each layout draws them", async () => {
  // Spine R0 -> L1 -> L2; side task B1 waits on R0.
  const records = [
    { id: "R0", state: "queued", repo: "maple-workshop", title: "Pathfind root", structured: true, unresolved_blocker_ids: [] },
    { id: "L1", state: "queued", repo: "maple-workshop", title: "Pathfind long 1", structured: true, unresolved_blocker_ids: ["R0"] },
    { id: "L2", state: "queued", repo: "maple-workshop", title: "Pathfind long 2", structured: true, unresolved_blocker_ids: ["L1"] },
    { id: "B1", state: "queued", repo: "maple-workshop", title: "Pathfind branch", structured: true, unresolved_blocker_ids: ["R0"] },
  ];
  const b = await board({ ui: { viewMode: "chains" }, snapshot: { schema: "fm-fleet-snapshot.v1", fm_home: HOME, tasks: [], backlog: { records } } });
  const drawnNodes = () => b.ids.filter((id) => id.startsWith("chain-node-")).map((id) => id.slice("chain-node-".length));
  b.view.search.set_value("pathfind");
  b.click("search-find");

  b.view.size = { width: 1280, height: 800 };
  b.redraw();
  assert.deepEqual(Array.from(b.view.matchIds()), ["R0", "L1", "L2", "B1"], "wide: spine track, then the side-branch track");
  assert.deepEqual(Array.from(b.view.matchIds()), drawnNodes());

  b.view.size = { width: 520, height: 800 };
  b.redraw();
  assert.ok(b.ids.includes("chain-stepper-chain-1"));
  assert.deepEqual(Array.from(b.view.matchIds()), ["R0", "L1", "B1", "L2"], "narrow: step by step, top to bottom");
  assert.deepEqual(Array.from(b.view.matchIds()), drawnNodes());
});

test("Chains view supports folding lanes, highlighting & opening card detail, vertical stepper <720px, Independent drawer, and search", async () => {
  const store = memoryStore();
  const theme = {
    accent: "#61afef",
    working: "#e5c07b",
    ansi6: "#56b6c2",
    border: "#3a404b",
    dim: "#6b7280",
    selected: "#323844",
    background: "#1e2127",
  };
  const b = await board({ store, theme });
  const borderColorOf = (id) => b.items.find((x) => x.id === id)?.calls.findLast((c) => c[0] === "border_color")?.[1];
  b.view.size = { width: 1280, height: 800 };
  b.click("view-mode-chains");

  // Independent drawer is collapsed by default and excludes done tasks (orchard-seed-data) and chain tasks.
  assert.ok(b.ids.includes("independent-drawer"));
  assert.ok(!b.ids.includes("independent-list"));
  assert.ok(!b.ids.includes("card-orchard-seed-data"));

  // Expanding Independent drawer shows unfinished independent cards using full Kanban card detail (including Held decisions).
  b.click("head-independent");
  assert.ok(b.ids.includes("independent-list"));
  assert.ok(b.ids.includes("card-maple-icon-set"));
  assert.ok(b.ids.includes("card-maple-preview-screen"));
  assert.ok(!b.ids.includes("card-orchard-seed-data"));
  assert.ok(!b.ids.includes("card-maple-theme-tokens"), "chain tasks stay out of Independent drawer");
  b.click("opt-card:maple-icon-set-A");
  assert.deepEqual(b.drafts, ["[Board answer] maple-icon-set: A (Rounded)"]);
  b.click("head-independent");
  assert.ok(!b.ids.includes("independent-list"));

  // Clicking a node highlights upstream & downstream by color only and opens the same Kanban card detail.
  b.click("chain-node-maple-card-layout");
  assert.equal(b.view.selectedCardId, "maple-card-layout");
  assert.equal(borderColorOf("chain-node-maple-theme-tokens"), theme.working);
  assert.equal(borderColorOf("chain-node-maple-card-layout"), theme.accent);
  assert.equal(borderColorOf("chain-node-maple-panel-polish"), theme.ansi6);
  assert.equal(borderColorOf("chain-node-maple-release-bundle"), theme.ansi6);
  assert.ok(b.ids.includes("chain-detail"));
  assert.ok(b.ids.includes("card-maple-card-layout"));
  assert.ok(b.ids.includes("blocks-maple-card-layout"));

  // Hovering a node in another lane keeps the selected chain bright and dims the other lane.
  const nodeDimmed = (id) => b.items.find((x) => x.id === id).calls.some((c) => c[0] === "opacity" && c[1] === 0.45);
  b.hover("chain-node-orchard-map-labels", true);
  assert.ok(!nodeDimmed("chain-node-maple-card-layout"), "selected node stays bright while hovering another lane");
  assert.ok(!nodeDimmed("chain-node-maple-theme-tokens"));
  assert.ok(nodeDimmed("chain-node-orchard-map-labels"), "nodes outside the selected chain stay dimmed");
  b.hover("chain-node-orchard-map-labels", false);

  b.keyDown("root", "escape");
  assert.equal(b.view.selectedCardId, null);
  assert.ok(!b.ids.includes("chain-detail"));

  // Clicking a lane header folds it and persists the fold.
  b.click("head-chain-chain-1");
  assert.ok(!b.ids.includes("chain-spine-chain-1"));
  assert.ok(b.ids.includes("chain-spine-chain-2"));

  // Search filtering applies in Chains view: hides non-matching lanes, opens matching folded lanes, and steps matches.
  b.view.search.set_value("maple-panel-polish");
  b.click("search-find");
  assert.ok(b.ids.includes("chain-lane-chain-1"));
  assert.ok(b.ids.includes("chain-spine-chain-1"), "search reveals matching folded lane");
  assert.ok(!b.ids.includes("chain-lane-chain-2"), "non-matching lane is hidden during search");
  assert.ok(!b.ids.includes("independent-drawer"), "empty independent matches stay hidden during search");
  assert.equal(b.view.currentMatch, "maple-panel-polish");

  // Search matching an independent task hides chain lanes and auto-opens Independent drawer with only matching cards.
  b.view.search.set_value("Choose button labels");
  b.click("search-find");
  assert.ok(!b.ids.includes("chain-lane-chain-1"));
  assert.ok(b.ids.includes("independent-list"));
  assert.ok(b.ids.includes("card-maple-button-labels"));
  assert.ok(!b.ids.includes("card-maple-icon-set"));
  b.keyDown("kanban-search", "escape");
  assert.equal(b.view.query, "");

  // Unfold chain-1 again and verify narrow width (< 720px) switches lanes to a vertical stepper.
  b.click("head-chain-chain-1");
  b.view.size = { width: 520, height: 800 };
  b.redraw();
  assert.ok(b.ids.includes("chain-stepper-chain-1"));
  assert.ok(!b.ids.includes("chain-spine-chain-1"));
  assert.ok(b.ids.includes("chain-step-chain-1-0"));
  assert.ok(b.ids.includes("chain-step-chain-1-1"));
});

test("refresh bounds exec timeouts, clears loading after deadline, ignores stale results, and refreshes on click", async () => {
  const source = (await readFile(new URL("mods/fm-board/main.js", root), "utf8"))
    .replace(/^import .*;$/gm, "").replace("export default class FmBoard", "class FmBoard");
  const execCalls = [];
  const timers = [];
  const spawned = [];
  let snapshotImpl;
  let enrichmentTimesOut = false;
  let receiptsImpl = async () => ({ code: 0, stdout: JSON.stringify({ pending: [] }), stderr: "" });
  const cx = {
    notify() {},
    stop_propagation() {},
    spawn(fn) {
      const p = fn(cx);
      spawned.push(p);
      return p;
    },
    timer: {
      every() {},
      after(ms, fn) {
        const entry = { ms, fn, cancelled: false };
        timers.push(entry);
        return { cancel() { entry.cancelled = true; }, is_done: () => entry.cancelled };
      },
    },
    focus_handle() { return { focus() {}, is_focused: () => false, release: () => true }; },
  };
  const input = () => ({ on() {}, value: () => "", set_value() {} });
  const theme = new Proxy({}, { get: () => "#808080" });
  const scope = {
    View: class {}, div: element, svg: element, v_flex: element, h_flex: element, Input: { new: element },
    h_resizable: element, resizable_panel: element, InputState: { new: input },
    ScrollHandle: { new: () => ({ scroll_to_item() {} }) },
    FolderViewer: class { constructor() { this.root = null; } close() { this.root = null; } },
    props: () => ({ home: HOME, collapsed: [] }), checking: () => false,
    theme: () => theme, settings: () => ({ font_size: 14 }), terminals: () => [], focused: () => null, run() {},
    localStorage: { getItem: () => null, setItem() {} },
    readTextFile: async (file) => {
      if (file === `${HOME}/data/projects.md`) return "- maple-workshop - Fictional project.\n";
      if (file === `${HOME}/state/.watch.lock/pid`) return "12345\n";
      throw new Error(`no such file: ${file}`);
    },
    exec: async (cmd, args, opts) => {
      execCalls.push({ cmd, args, opts });
      if (cmd === "/usr/bin/env" && args[1]?.endsWith("fm-fleet-snapshot.sh")) return snapshotImpl();
      if (cmd === "/usr/bin/env" && args[1]?.endsWith("fm-inbox.sh")) {
        if (args[2] === "ready") return { code: 0, stdout: JSON.stringify({ can_receive: true }), stderr: "" };
        if (args[2] === "receipts") return receiptsImpl();
        return { code: 0, stdout: "{}", stderr: "" };
      }
      if (cmd === "hc" && args[0] === "get" && enrichmentTimesOut) throw new Error("timed out");
      if (cmd === "ps" && enrichmentTimesOut) throw new Error("timed out");
      if (cmd === "hc" && args[0] === "get") return { code: 0, stdout: JSON.stringify({ labels: {}, status: { state: "idle" } }), stderr: "" };
      if (cmd === "ps") return { code: 0, stdout: "12345 00:10\n", stderr: "" };
      return { code: 1, stdout: "", stderr: "" };
    },
    watchFolder: () => new Promise(() => {}),
    pickFolder: async () => null,
  };
  const { FmBoard } = vm.runInNewContext(`${source}\n({ FmBoard })`, scope);
  const makeSnap = (id, generated) => ({
    schema: "fm-fleet-snapshot.v1",
    fm_home: HOME,
    generated,
    tasks: [{ id, backend: "hc", endpoint: { target: "default:t1" }, current_state: { state: "unknown" }, backlog: { state: "in_flight", repo: "maple-workshop", title: `Task ${id}` } }],
    backlog: { records: [] },
  });

  // 1. Initial refresh succeeds and passes timeout options on all exec calls.
  snapshotImpl = async () => ({ code: 0, stdout: JSON.stringify(makeSnap("T1", "2026-11-13T03:00:00Z")), stderr: "" });
  const view = new FmBoard();
  view.init({}, cx);
  await spawned.shift();
  assert.equal(view.loading, false);
  assert.equal(view.error, null);
  assert.deepEqual([...view.cards.map((c) => c.id)], ["T1"]);
  assert.ok(timers[0].cancelled, "deadline timer cancelled on normal completion");
  for (const call of execCalls) {
    assert.ok(typeof call.opts?.timeout === "number" && call.opts.timeout > 0, `missing timeout for ${call.cmd} ${call.args.join(" ")}`);
  }

  let items = drawn(view.render(cx));
  const refreshEl = items.find((x) => x.id === "refresh");
  assert.ok(refreshEl?.click, "Updated footer text is clickable");
  assert.ok(refreshEl.calls.some((c) => c[0] === "tooltip" && /refresh/i.test(c[1])), "Updated has a refresh tooltip");
  assert.ok(items.some((x) => x.text.includes("Receiving")), "Receiving badge remains");

  // 2. Clicking Updated bypasses MIN_GAP_MS immediately, shows in-progress state, and hangs on exec.
  let resolveHung;
  snapshotImpl = () => new Promise((resolve) => { resolveHung = resolve; });
  refreshEl.click({}, cx);
  const hungSpawn = spawned.at(-1);
  assert.equal(view.loading, true);
  items = drawn(view.render(cx));
  assert.ok(items.some((x) => x.id === "refresh" && x.text === "Refreshing…"), "shows in-progress state while refreshing");

  // 3. Deadline fires: clears loading, sets error + Update failed badge, keeps last good board (T1).
  const hungTimer = timers.at(-1);
  assert.equal(hungTimer.cancelled, false);
  hungTimer.fn(cx);
  assert.equal(view.loading, false);
  assert.equal(view.error, "refresh timed out");
  assert.deepEqual([...view.cards.map((c) => c.id)], ["T1"]);
  const failedItems = drawn(view.render(cx));
  const failedText = failedItems.map((x) => x.text).join(" ");
  assert.ok(failedText.includes("refresh timed out"));
  assert.ok(failedText.includes("Update failed"));
  const failedEl = failedItems.find((x) => x.id === "refresh");
  assert.ok(failedEl?.text.includes("Update failed") && failedEl.click, "failed state is clickable");
  assert.ok(failedEl.calls.some((c) => c[0] === "tooltip" && /refresh/i.test(c[1])), "failed state has a refresh tooltip");

  // 4. Clicking the failed state refreshes at once; it succeeds, and late settlement of the abandoned refresh is ignored.
  snapshotImpl = async () => ({ code: 0, stdout: JSON.stringify(makeSnap("T3", "2026-11-13T03:05:00Z")), stderr: "" });
  failedEl.click({}, cx);
  assert.equal(view.loading, true);
  await spawned.at(-1);
  assert.equal(view.loading, false);
  assert.equal(view.error, null);
  assert.deepEqual([...view.cards.map((c) => c.id)], ["T3"]);
  assert.equal(view.generated, "2026-11-13T03:05:00Z");

  // Resolve the abandoned refresh with stale T2 data and flush microtasks.
  resolveHung({ code: 0, stdout: JSON.stringify(makeSnap("T2", "2026-11-13T03:01:00Z")), stderr: "" });
  await hungSpawn;
  await new Promise((r) => setTimeout(r, 0));
  assert.deepEqual([...view.cards.map((c) => c.id)], ["T3"], "late result must not overwrite newer refresh");
  assert.equal(view.generated, "2026-11-13T03:05:00Z");
  assert.equal(view.error, null);
  assert.equal(view.loading, false);

  // 5. A good snapshot shows even when the inbox stage then hangs past the deadline.
  let resolveReceipts;
  receiptsImpl = () => new Promise((resolve) => { resolveReceipts = resolve; });
  snapshotImpl = async () => ({ code: 0, stdout: JSON.stringify(makeSnap("T4", "2026-11-13T03:10:00Z")), stderr: "" });
  view.refresh(cx, { force: true });
  const inboxSpawn = spawned.at(-1);
  await new Promise((r) => setTimeout(r, 0));
  assert.deepEqual([...view.cards.map((c) => c.id)], ["T4"], "cards update before the inbox stage finishes");
  timers.at(-1).fn(cx);
  assert.equal(view.error, "refresh timed out");
  assert.equal(view.loading, false);
  assert.deepEqual([...view.cards.map((c) => c.id)], ["T4"]);
  resolveReceipts({ code: 0, stdout: JSON.stringify({ pending: [] }), stderr: "" });
  await inboxSpawn;

  // 6. Board requests are not bound by the refresh timeouts.
  receiptsImpl = async () => ({ code: 0, stdout: JSON.stringify({ pending: [] }), stderr: "" });
  view.send("Hello", cx);
  await spawned.at(-1);
  await spawned.at(-1);
  const note = execCalls.find((c) => c.args[2] === "note");
  assert.ok(note, "send runs fm-inbox.sh note");
  assert.equal(note.opts?.timeout, undefined, "note runs without a timeout");
  assert.equal(view.notice, "Request sent");

  // 7. A timed-out hc get or ps leaves out only its own detail; the refresh still succeeds.
  enrichmentTimesOut = true;
  snapshotImpl = async () => ({ code: 0, stdout: JSON.stringify(makeSnap("T5", "2026-11-13T03:15:00Z")), stderr: "" });
  view.refresh(cx, { force: true });
  await spawned.at(-1);
  assert.equal(view.error, null);
  assert.deepEqual([...view.cards.map((c) => c.id)], ["T5"]);
  assert.equal(view.ready, true);
  assert.equal(JSON.stringify(view.watchers), JSON.stringify([{ role: "Watcher", pid: "12345", up: null }]));
});


test("Herdr check initializes a renderable Board without commands, reads, watches, or timers", async () => {
  const b = await board({ checkMode: true, preview: false,
    exec: async () => ({ code: 0, stdout: JSON.stringify(snapshot), stderr: "" }) });
  assert.deepEqual(b.initEffects, []);
  assert.equal(b.view.cards, null);
  assert.ok(b.ids.includes("root"));
});

test("Registered checks section lists state/*.check.sh names and home-wide state/.last-check sweep time in viewer local time", async (t) => {
  const tempHome = await mkdtemp(join(tmpdir(), "fm-board-checks-"));
  const stateDir = join(tempHome, "state");
  await mkdir(stateDir, { recursive: true });
  t.after(() => rm(tempHome, { recursive: true, force: true }));

  // Fictional checks only; include a non-check file, a directory ending in .check.sh, and private check output
  // that must be ignored and never read.
  await writeFile(join(stateDir, "gamma-digest.check.sh"), "#!/bin/sh\necho SECRET_CHECK_OUTPUT\n");
  await writeFile(join(stateDir, "alpha-audit.check.sh"), "#!/bin/sh\necho SECRET_CHECK_OUTPUT\n");
  await writeFile(join(stateDir, "beta-sync.check.sh"), "#!/bin/sh\nexit 0\n");
  await writeFile(join(stateDir, ".alpha-audit-output"), "SECRET_PRIVATE_STATE\n");
  await writeFile(join(stateDir, "notes.txt"), "not a check\n");
  await mkdir(join(stateDir, "ignored-dir.check.sh"));

  const sweepDate = new Date("2026-11-10T03:05:09Z");
  await writeFile(join(stateDir, ".last-check"), "");
  await utimes(join(stateDir, ".last-check"), sweepDate, sweepDate);

  const tz = process.env.TZ;
  t.after(() => { if (tz === undefined) delete process.env.TZ; else process.env.TZ = tz; });

  const realChecksExec = async (cmd, args) => {
    if (cmd === "sh" && args[0] === "-c" && args[2] === "checks") {
      // Substitute tempHome/state for the fictional HOME/state path.
      const res = await runFile("sh", ["-c", args[1], "checks", stateDir], { encoding: "utf8" });
      return { code: 0, stdout: res.stdout, stderr: res.stderr };
    }
    return { code: 1, stdout: "", stderr: "" };
  };

  // Viewer in Asia/Seoul (UTC+9): 2026-11-10T03:05:09Z -> 11-10 12:05:09.
  process.env.TZ = "Asia/Seoul";
  const store = memoryStore();
  const b = await board({ ui: { bottomTab: "checks" }, exec: realChecksExec, store });
  assert.ok(b.ids.includes("checks-section"));
  assert.ok(b.ids.indexOf("checks-section") > b.ids.indexOf("board"), "registered checks belong in the monitoring area, not cards");
  assert.deepEqual(
    b.ids.filter((id) => id.startsWith("check-")),
    ["check-alpha-audit", "check-beta-sync", "check-gamma-digest"],
  );
  assert.equal(b.text("check-alpha-audit"), "alpha-audit");
  assert.equal(b.text("check-beta-sync"), "beta-sync");
  assert.equal(b.text("check-gamma-digest"), "gamma-digest");
  assert.equal(b.text("bottom-tab-checks"), "Checks 3");
  assert.equal(b.text("checks-last-sweep"), "Last sweep (all checks): 11-10 12:05:09");
  // Ensure no check script contents or private state file contents leaked into the rendered tree.
  const allText = b.items.map((x) => x.text).join(" ");
  assert.ok(!allText.includes("SECRET_CHECK_OUTPUT"));
  assert.ok(!allText.includes("SECRET_PRIVATE_STATE"));
  assert.ok(!allText.includes("ignored-dir"));
  // No per-check running, last-run, or result fields are rendered on check rows or cards.
  assert.ok(!b.text("card-maple-preview-screen").includes("alpha-audit"));

  // Viewer in UTC sees the same instant formatted in UTC local time (03:05:09), and today omits MM-DD.
  process.env.TZ = "UTC";
  assert.equal(b.redraw().find((x) => x.id === "checks-last-sweep")?.text, "Last sweep (all checks): 11-10 03:05:09");
  const now = new Date();
  const todaySweep = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), 7, 8, 9));
  await utimes(join(stateDir, ".last-check"), todaySweep, todaySweep);
  await b.reload();
  assert.equal(b.text("checks-last-sweep"), "Last sweep (all checks): 07:08:09");

  // Clicking the open Checks tab folds the tab group away, keeps the count on the tab, and saves state.
  b.click("bottom-tab-checks");
  assert.ok(!b.ids.includes("checks-list"));
  assert.ok(!b.ids.includes("check-alpha-audit"));
  assert.equal(b.text("bottom-tab-checks"), "Checks 3");
  assert.deepEqual(JSON.parse(store.getItem("collapsed")), ["bottom"]);
  b.click("bottom-tab-checks");
  assert.ok(b.ids.includes("check-alpha-audit"));

  // Missing state/.last-check shows Not recorded; empty checks shows No registered checks.
  await rm(join(stateDir, ".last-check"));
  await rm(join(stateDir, "alpha-audit.check.sh"));
  await rm(join(stateDir, "beta-sync.check.sh"));
  await rm(join(stateDir, "gamma-digest.check.sh"));
  await b.reload();
  assert.equal(b.text("checks-last-sweep"), "Last sweep (all checks): Not recorded");
  assert.equal(b.text("checks-list"), "No registered checks");
  assert.equal(b.text("bottom-tab-checks"), "Checks 0");
});

test("Registered checks section reports a failed read instead of claiming no checks or no sweep", async () => {
  const failed = await board({ ui: { bottomTab: "checks" },
    exec: async () => ({ code: 1, stdout: "", stderr: "permission denied" }),
  });
  assert.equal(failed.view.error, null);
  assert.equal(failed.text("checks-list"), "Could not read registered checks");
  assert.equal(failed.text("checks-last-sweep"), "Last sweep (all checks): Could not read");
  // A failed read claims no count on the tab.
  assert.equal(failed.text("bottom-tab-checks"), "Checks");

  const rejected = await board({ ui: { bottomTab: "checks" },
    exec: async (cmd, args) => {
      if (cmd === "sh" && args[0] === "-c" && args[2] === "checks") throw new Error("timed out");
      return { code: 1, stdout: "", stderr: "" };
    },
  });
  assert.equal(rejected.text("checks-list"), "Could not read registered checks");
  assert.equal(rejected.text("checks-last-sweep"), "Last sweep (all checks): Could not read");
});

test("Registered checks section reports an unlistable state folder as a failed read", { skip: process.getuid?.() === 0 && "root can list any folder" }, async (t) => {
  const tempHome = await mkdtemp(join(tmpdir(), "fm-board-checks-"));
  const stateDir = join(tempHome, "state");
  await mkdir(stateDir, { recursive: true });
  await writeFile(join(stateDir, "fictional-probe.check.sh"), "#!/bin/sh\nexit 0\n");
  await writeFile(join(stateDir, ".last-check"), "");
  await chmod(stateDir, 0o000);
  t.after(async () => { await chmod(stateDir, 0o755); await rm(tempHome, { recursive: true, force: true }); });
  const b = await board({ ui: { bottomTab: "checks" },
    exec: async (cmd, args) => {
      if (cmd === "sh" && args[0] === "-c" && args[2] === "checks") {
        try {
          const res = await runFile("sh", ["-c", args[1], "checks", stateDir], { encoding: "utf8" });
          return { code: 0, stdout: res.stdout, stderr: res.stderr };
        } catch (e) {
          return { code: e.code ?? 1, stdout: e.stdout ?? "", stderr: e.stderr ?? "" };
        }
      }
      return { code: 1, stdout: "", stderr: "" };
    },
  });
  // The folder holds a registered check and a sweep record, so "none" or "not recorded" would be false.
  assert.equal(b.text("checks-list"), "Could not read registered checks");
  assert.equal(b.text("checks-last-sweep"), "Last sweep (all checks): Could not read");
});

test("Registered checks section is read even when the first refresh fails before the inbox", async () => {
  const b = await board({ ui: { bottomTab: "checks" },
    registryFails: true,
    exec: async (cmd, args) => {
      if (cmd === "sh" && args[0] === "-c" && args[2] === "checks") {
        return { code: 0, stdout: "last\x00\x00check\x00fictional-sweep\x00", stderr: "" };
      }
      return { code: 1, stdout: "", stderr: "" };
    },
  });
  assert.equal(b.view.error, "registry unreadable");
  assert.deepEqual(b.ids.filter((id) => id.startsWith("check-")), ["check-fictional-sweep"]);
  assert.equal(b.text("checks-last-sweep"), "Last sweep (all checks): Not recorded");
});

// Exercise the tab bar through the same element boundary as the Board, with only
// Herdr's native APIs replaced. Time is explicit so wheel gestures are deterministic.
async function tabs({ saved = null, checkMode = false, spaceList = [], paneList = [], rootLayout = null } = {}) {
  const source = (await readFile(new URL("mods/fm-tabs/main.js", root), "utf8"))
    .replace(/^import .*;$/gm, "").replace("export default class Tabs", "class Tabs");
  const actions = [], scrolls = [], storage = [];
  let now = 1000;
  const scope = {
    View: class {}, div: element, svg: element, image: element, h_flex: element,
    ScrollHandle: { new: () => { const handle = { scroll_to_item(idx) { scrolls.push({ handle, idx }); } }; return handle; } },
    spaces: () => spaceList, panes: () => paneList, layout: () => rootLayout,
    run: (action, args) => actions.push({ action, args }), openOverlay() {},
    theme: () => new Proxy({}, { get: () => "#808080" }), window: () => ({}),
    shared: () => ["files", "changes"], settings: () => ({ zoom: 1 }),
    checking: () => checkMode, Date: { now: () => now },
    localStorage: { getItem(key) { storage.push(["get", key]); return saved; }, setItem(...args) { storage.push(["set", ...args]); } },
  };
  const Tabs = vm.runInNewContext(`${source}\nTabs`, scope);
  const view = new Tabs();
  view.init();
  let tree, items;
  const redraw = () => { tree = view.render(); items = drawn(tree); return items; };
  redraw();
  const handler = (id, name) => {
    const node = id ? items.find((x) => x.id === id) : tree.node;
    const callback = node?.calls.find((c) => c[0] === name)?.[1];
    assert.equal(typeof callback, "function", `${id ?? "tab bar"} has no ${name}`);
    return callback;
  };
  return {
    view, actions, storage, redraw,
    get scrolls() {
      const handle = items.find((x) => x.id === "tab-scroll")?.calls.find((c) => c[0] === "track_scroll")?.[1];
      return scrolls.map((s) => s.handle === handle ? s.idx : `other handle at ${s.idx}`);
    },
    text: (id) => items.find((x) => x.id === id)?.text,
    get ids() { return items.map((x) => x.id); },
    click(id) { items.find((x) => x.id === id).click(); },
    wheel(delta, at, extra = {}) { now = at; handler(null, "on_scroll_wheel")({ delta: { x: 0, y: delta }, touch_phase: "moved", ...extra }); },
    resize(id) { handler(id, "on_size_change")({}, { notify() {} }); },
    scrollHandle: () => items.find((x) => x.id === "tab-scroll")?.calls.find((c) => c[0] === "track_scroll")?.[1],
  };
}

for (const saved of ["{broken", "null", "[]", "42", '"text"']) {
  test(`tabs recover from invalid saved panels: ${saved}`, async () => {
    const spaceList = [{ id: "s1", active: true, tabs: [] }];
    const rootLayout = { children: [{ id: "panel", hidden: false }, { id: "panel-body", active: "board" }] };
    const t = await tabs({ saved, spaceList, rootLayout });
    assert.equal(t.text("panel-board"), "Board");
    assert.deepEqual(t.storage.filter(([op]) => op === "set"), [["set", "panels", '{"s1":"board"}']]);
  });
}

test("tabs keep the Board control and restore Board as a saved panel", async () => {
  const t = await tabs({ saved: '{"s1":"board"}', spaceList: [{ id: "s1", active: true, tabs: [] }],
    rootLayout: { children: [{ id: "panel", hidden: true }, { id: "panel-body", active: "files" }] } });
  assert.deepEqual(t.actions.map((x) => x.action), ["layout.select", "layout.show"]);
  assert.equal(t.actions[0].args.child, "board");
  assert.equal(t.text("panel-files"), "Files");
  assert.equal(t.text("panel-changes"), "Changes");
  t.click("panel-board");
  assert.equal(t.actions.at(-2).args.child, "board");
  assert.equal(t.actions.at(-1).action, "layout.show");
});

test("tabs show a PR button beside Board only when the layout gives the PR viewer a panel slot", async () => {
  const spaceList = [{ id: "s1", active: true, tabs: [] }];
  const without = await tabs({ spaceList, rootLayout: { children: [{ id: "panel", hidden: true }, { id: "panel-body", active: "files" }] } });
  assert.ok(!without.ids.includes("panel-pr"));
  const withPr = await tabs({ spaceList, rootLayout: { children: [{ id: "panel", hidden: true },
    { id: "panel-body", active: "files", children: [{ id: "files" }, { id: "changes" }, { id: "board" }, { id: "pr" }] }] } });
  assert.equal(withPr.text("panel-pr"), "PR");
  assert.equal(withPr.ids.indexOf("panel-pr") + 1, withPr.ids.indexOf("panel-board"), "PR sits right before Board");
  withPr.click("panel-pr");
  assert.deepEqual(JSON.parse(JSON.stringify(withPr.actions.slice(-2).map((x) => [x.action, x.args]))),
    [["layout.select", { stack: "panel-body", child: "pr" }], ["layout.show", { id: "panel" }]]);
  // A space that last showed the PR panel gets it back.
  const restored = await tabs({ saved: '{"s1":"pr"}', spaceList, rootLayout: { children: [{ id: "panel", hidden: true },
    { id: "panel-body", active: "files", children: [{ id: "board" }, { id: "pr" }] }] } });
  assert.equal(restored.actions[0].args.child, "pr");
});

test("Herdr check renders tabs without reading or saving panels or changing the layout", async () => {
  const t = await tabs({ checkMode: true, saved: '{"s1":"board"}', spaceList: [{ id: "s1", active: true, tabs: [] }],
    rootLayout: { children: [{ id: "panel", hidden: false }, { id: "panel-body", active: "files" }] } });
  assert.deepEqual(t.storage, []);
  assert.deepEqual(t.actions, []);
  assert.equal(t.text("panel-board"), "Board");
});

test("tabs accumulate small wheel events and limit a continuous gesture to one step per 100ms", async () => {
  const t = await tabs();
  for (let i = 0; i < 10; i++) t.wheel(2, 1000 + i * 2);
  assert.deepEqual(t.actions.map((x) => x.action), ["tab.prev"]);
  t.wheel(60, 1040);
  assert.equal(t.actions.length, 1);
  t.wheel(1, 1120);
  assert.equal(t.actions.length, 2);
  t.wheel(-20, 1240);
  assert.equal(t.actions.at(-1).action, "tab.next", "turning starts a new gesture");
  t.wheel(19, 1600);
  assert.equal(t.actions.length, 3, "a pause discards the old gesture's remainder");
  t.wheel(1, 1610);
  assert.equal(t.actions.length, 4);
  t.wheel(19, 1700, { touch_phase: "started" });
  assert.equal(t.actions.length, 4);
  t.wheel(1, 1720);
  assert.equal(t.actions.length, 5);
});

test("tabs switch once per wheel notch and ignore horizontal-only line scrolling", async () => {
  const t = await tabs();
  t.wheel(0, 1000, { delta_lines: { x: 0, y: 1 } });
  t.wheel(0, 1001, { delta_lines: { x: 0, y: -1 } });
  t.wheel(60, 1002, { delta_lines: { x: 1, y: 0 } });
  assert.deepEqual(t.actions.map((x) => x.action), ["tab.prev", "tab.next"]);
});

test("tabs follow useful live agent titles, preserving explicit names and filtering terminal noise", async () => {
  const tab = { id: "t1", name: "tb1", named: false, active: true };
  const lead = { tab: "t1", terminal: "term1", title: "✳ Fix parser", program: { name: "Claude", key: "claude", agent: true } };
  const t = await tabs({ spaceList: [{ id: "s1", active: true, tabs: [tab] }], paneList: [lead] });
  const cases = [
    [false, "tb1", "✳ Fix parser", "Fix parser"],
    [false, "tb1", "[ ! ] Fix parser", "Fix parser"],
    [true, "Claude", "✳ New session title", "New session title"],
    [true, "My task", "✳ New session title", "My task"],
    [false, "tb1", "/repo/project", "Claude"],
    [false, "tb1", "~/project", "Claude"],
    [false, "tb1", "C:\\project", "Claude"],
    [false, "tb1", "✳ /repo/project", "Claude"],
    [false, "tb1", "user@host", "Claude"],
    [false, "tb1", "term1", "Claude"],
    [false, "tb1", "CLAUDE", "Claude"],
    [false, "tb1", "", "Claude"],
  ];
  for (const [named, name, title, want] of cases) {
    Object.assign(tab, { named, name }); lead.title = title; t.redraw();
    assert.equal(t.text("tab-t1"), want, title);
  }
  lead.program.agent = false; lead.title = "shell prompt"; t.redraw();
  assert.equal(t.text("tab-t1"), "Claude");
  lead.program = null; t.redraw();
  assert.equal(t.text("tab-t1"), "Terminal");
});

test("tabs scroll the active item into view on selection, reorder, and size changes", async () => {
  const list = [{ id: "t1", named: false, active: false }, { id: "t2", named: false, active: true }];
  const t = await tabs({ spaceList: [{ id: "s1", active: true, tabs: list }] });
  assert.ok(t.scrollHandle(), "the tab strip must track the handle that receives the scroll");
  assert.deepEqual(t.scrolls, [1]);
  t.redraw();
  assert.deepEqual(t.scrolls, [1], "unchanged selection does not trigger another render-time scroll");
  t.resize("tab-t1"); t.resize("tab-t2"); t.resize("tab-scroll");
  assert.deepEqual(t.scrolls, [1, 1, 1, 1]);
  list[0].active = true; list[1].active = false; t.redraw();
  assert.equal(t.scrolls.at(-1), 0);
  list.reverse(); t.redraw();
  assert.equal(t.scrolls.at(-1), 1, "moving the same active tab updates its scroll index");
  list.length = 0; t.redraw();
  assert.equal(t.scrolls.at(-1), 1, "an empty strip never scrolls to -1");
});

test("hovering never changes layout geometry in Kanban, Inspector, or Chains view while still changing colors, and clicking still changes geometry", async () => {
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
  const theme = {
    accent: "#112233",
    working: "#223344",
    ansi6: "#334455",
    border: "#445566",
    muted: "#556677",
    selected: "#667788",
  };
  const borderColorOf = (b, id) => b.items.find((x) => x.id === id)?.calls.findLast((c) => c[0] === "border_color")?.[1];
  const textColorOf = (b, id) => b.items.find((x) => x.id === id)?.calls.findLast((c) => c[0] === "text_color")?.[1];

  // (a) Kanban: hover a card below an upstream card in the same column (K4 sits above K6 in Queued).
  const b = await board({
    theme,
    snapshot: { schema: "fm-fleet-snapshot.v1", fm_home: HOME, tasks, backlog: { records } },
  });
  b.view.size = { width: 1280, height: 800 };
  b.redraw();
  const queuedCards = b.items.find((x) => x.id === "col-queued").childIds;
  assert.ok(b.ids.indexOf("card-K4") < b.ids.indexOf("card-K6"), "K4 sits above K6 in Queued");
  assert.ok(queuedCards.length > 0);
  const beforeKanban = geometry(b.items);
  assert.equal(borderColorOf(b, "card-K6"), theme.border);
  b.hover("card-K6", true);
  assert.deepEqual(geometry(b.items), beforeKanban, "Kanban hover must not change layout geometry");
  assert.equal(borderColorOf(b, "card-K6"), theme.accent, "Kanban hover still changes hovered border color");
  assert.equal(borderColorOf(b, "card-K4"), theme.working, "Kanban hover still changes upstream border color");
  b.hover("card-K6", false);
  assert.equal(borderColorOf(b, "card-K6"), theme.border);

  // Clicking still changes geometry (border width 1 -> 2 and role pills appear).
  b.click("blocks-K3");
  assert.notDeepEqual(geometry(b.items), beforeKanban, "clicking a badge must still change geometry");
  assert.equal(b.text("hl-K3"), "Selected");
  assert.equal(b.text("hl-K4"), "Downstream");

  // (b) Inspector: self-shrink case after a badge click — hovering an upstream or downstream node keeps geometry equal.
  const beforeInspector = geometry(b.items);
  assert.equal(borderColorOf(b, "dep-node-K4"), theme.ansi6);
  assert.equal(textColorOf(b, "dep-role-K4"), theme.ansi6);
  b.hover("dep-node-K4", true);
  assert.deepEqual(geometry(b.items), beforeInspector, "Inspector hover on downstream node must not shrink border or alter role pill");
  assert.equal(borderColorOf(b, "dep-node-K4"), theme.accent, "Inspector hover still changes border color");
  assert.equal(textColorOf(b, "dep-role-K4"), theme.ansi6, "a role pill keeps the legend color of its Downstream label while hovered");
  b.hover("dep-node-K2", true);
  assert.deepEqual(geometry(b.items), beforeInspector, "Inspector hover on upstream node must not shrink border or alter role pill");
  assert.equal(borderColorOf(b, "dep-node-K2"), theme.accent);
  b.hover("dep-node-K2", false);

  // (c) Chains view: hover a spine node before and after clicking another spine node.
  const chains = await board({
    theme,
    ui: { viewMode: "chains" },
    snapshot: { schema: "fm-fleet-snapshot.v1", fm_home: HOME, tasks, backlog: { records } },
  });
  chains.view.size = { width: 1280, height: 800 };
  chains.redraw();
  const beforeChains = geometry(chains.items);
  assert.equal(borderColorOf(chains, "chain-node-K4"), theme.border);
  chains.hover("chain-node-K4", true);
  assert.deepEqual(geometry(chains.items), beforeChains, "Chains hover must not change layout geometry");
  assert.equal(borderColorOf(chains, "chain-node-K4"), theme.accent, "Chains hover still changes hovered node border color");
  assert.equal(borderColorOf(chains, "chain-node-K3"), theme.working, "Chains hover still changes upstream node border color");
  assert.equal(borderColorOf(chains, "chain-node-K6"), theme.ansi6, "Chains hover still changes downstream node border color");
  chains.hover("chain-node-K4", false);

  // Clicking a spine node opens the detail panel (changing geometry), while border width stays 1px and hovering afterwards never shifts geometry.
  const borderWidthOf = (b, id) => b.items.find((x) => x.id === id)?.calls.findLast((c) => c[0] === "border")?.[1];
  assert.equal(borderWidthOf(chains, "chain-node-K4"), 1);
  chains.click("chain-node-K3");
  assert.notDeepEqual(geometry(chains.items), beforeChains, "clicking a Chains node must still change geometry");
  assert.equal(borderWidthOf(chains, "chain-node-K3"), 1, "selected Chains card keeps 1px hairline border");
  assert.equal(borderColorOf(chains, "chain-node-K4"), theme.ansi6);
  assert.ok(chains.ids.includes("chain-legend"));
  const afterClickChains = geometry(chains.items);
  chains.hover("chain-node-K4", true);
  assert.deepEqual(geometry(chains.items), afterClickChains, "Chains hover after selection must not change layout geometry");
  assert.equal(borderColorOf(chains, "chain-node-K4"), theme.accent);
  assert.equal(borderWidthOf(chains, "chain-node-K4"), 1);
  chains.hover("chain-node-K4", false);
});

test("hovering a card from another chain never swaps the chain an open inspector shows after its selection leaves every chain", async () => {
  const records = [
    { id: "A1", state: "in_flight", repo: "maple-workshop", title: "A1 Root", structured: true, unresolved_blocker_ids: [] },
    { id: "A2", state: "queued", repo: "maple-workshop", title: "A2 Leaf", structured: true, unresolved_blocker_ids: ["A1"] },
    { id: "B1", state: "in_flight", repo: "orchard-atlas", title: "B1 Root", structured: true, unresolved_blocker_ids: [] },
    { id: "B2", state: "queued", repo: "orchard-atlas", title: "B2 Middle", structured: true, unresolved_blocker_ids: ["B1"] },
    { id: "B3", state: "queued", repo: "orchard-atlas", title: "B3 Leaf", structured: true, unresolved_blocker_ids: ["B2"] },
    { id: "X", state: "queued", repo: "maple-workshop", title: "X Waiter", structured: true, unresolved_blocker_ids: ["Y"] },
    { id: "Y", state: "in_flight", repo: "maple-workshop", title: "Y Blocker", structured: true, unresolved_blocker_ids: [] },
  ];
  const snapshot = { schema: "fm-fleet-snapshot.v1", fm_home: HOME, tasks: [], backlog: { records } };
  const b = await board({ snapshot });
  // Wide enough for unstacked columns, too narrow to split: the inspector is the compact card above them.
  b.view.size = { width: 1000, height: 800 };
  b.view.splitWasOpen = false;
  b.view.rightSplitWidth = 0;
  b.redraw();
  b.click("waits-X");
  assert.equal(b.view.selectedCardId, "X");
  assert.ok(b.ids.includes("dep-inspector-compact"));

  // Y finishes: X no longer waits on anything and leaves every chain, while the inspector stays open.
  records.find((r) => r.id === "X").unresolved_blocker_ids = [];
  records.find((r) => r.id === "Y").state = "done";
  await b.reload();
  assert.equal(b.view.inspectorOpen, true);
  assert.equal(b.view.graph.componentById.has("X"), false);
  const shownChain = b.view.graph.components[0];
  const otherChain = b.view.graph.components.find((comp) => comp.id !== shownChain.id);
  const hoverId = otherChain.nodeIds.find((id) => b.ids.includes(`card-${id}`));
  const before = geometry(b.items);
  b.hover(`card-${hoverId}`, true);
  assert.deepEqual(geometry(b.items), before, "hovering a card from another chain must not re-lay out the compact inspector");
  b.hover(`card-${hoverId}`, false);
});

async function folderViewer() {
  const source = (await readFile(new URL("mods/fm-board/viewer.js", root), "utf8"))
    .replace(/^import .*;$/gm, "").replace("export class FolderViewer", "class FolderViewer");
  const watches = [], commands = [], pending = [];
  const cx = { notify() {}, spawn(fn) { const task = fn(cx); pending.push(task); return task; } };
  const scope = {
    watchFolder(root) {
      let resolve;
      const promise = new Promise((r) => { resolve = r; });
      const watch = { root, active: true, cancelled: false, finish() { watch.active = false; resolve([]); } };
      promise.cancel = () => { watch.cancelled = true; watch.finish(); };
      watches.push(watch);
      return promise;
    },
    exec: async (cmd, args, opts) => { commands.push({ cmd, args, opts }); return { code: cmd === "sh" ? 0 : 1, stdout: "", stderr: "" }; },
  };
  const FolderViewer = vm.runInNewContext(`${source}\nFolderViewer`, scope);
  const view = new FolderViewer();
  const flush = async () => { for (let i = 0; i < 20; i++) await Promise.resolve(); };
  return { view, cx, watches, commands, flush, pending };
}

test("switching viewer roots cancels the old watch without cancelling or refreshing the new root", async () => {
  const v = await folderViewer();
  v.view.target("/first", "First", v.cx);
  await v.flush();
  v.view.target("/second", "Second", v.cx);
  assert.equal(v.watches[0].cancelled, true);
  await v.flush();
  assert.deepEqual(v.watches.filter((w) => w.active).map((w) => w.root), ["/second"]);
  const before = v.commands.length;
  v.watches.at(-1).finish();
  await v.flush();
  assert.ok(v.commands.length > before, "changes in the new root still refresh the viewer");
  assert.ok(v.commands.slice(before).every((c) => c.cmd === "sh" ? c.args.at(-1) === "/second" : c.opts.cwd === "/second"));
  assert.deepEqual(v.watches.filter((w) => w.active).map((w) => w.root), ["/second"]);
  v.view.close(v.cx);
  await Promise.all(v.pending);
});

test("closing a viewer cancels its watch and prevents a resumed loop from rearming it", async () => {
  const v = await folderViewer();
  v.view.target("/first", "First", v.cx);
  await v.flush();
  v.view.target("/first", "Renamed", v.cx);
  assert.equal(v.watches.length, 1, "the same root keeps its existing watch");
  v.view.close(v.cx);
  assert.equal(v.watches[0].cancelled, true);
  await v.flush();
  assert.equal(v.watches.filter((w) => w.active).length, 0);
  assert.equal(v.watches.length, 1);
  assert.equal(v.view.root, null);
  await Promise.all(v.pending);
});

// Rasterizes every connector piece the wide Chains grid draws into 1px cells per edge, with every
// card a fixed height, so routing checks see what a reader sees: the pixels each line covers.
function rasterChainLane(b, layout, cardH = 90) {
  const { chainGutterSpecs, chainCellSpecs, CHAIN_CARD_W: W, CHAIN_GUT: G, CHAIN_R: R } = b;
  const gutAt = (c) => layout.gutterW?.[c] ?? G;
  const cardHAt = (r) => Math.max(cardH, layout.rowMinH?.[r] ?? 0);
  const rowTop = [], rowH = [];
  let y = 0;
  layout.grid.forEach((_, r) => { rowTop.push(y); rowH.push(cardHAt(r) + layout.rowPad[r]); y += rowH[r]; });
  const colX = (c) => {
    let x = 0;
    for (let i = 0; i < c; i++) x += W + gutAt(i);
    return x;
  };
  const pixels = new Map(), heads = new Map();
  const mark = (e, px, py) => {
    const k = `${e.u}->${e.v}`;
    if (!pixels.has(k)) pixels.set(k, new Set());
    pixels.get(k).add(`${px},${py}`);
  };
  const draw = (spec, r, x0, w) => {
    const top = rowTop[r], h = rowH[r];
    const yOf = (size) => (spec.top != null ? top + spec.top : top + h - spec.bottom - size);
    if (spec.kind === "head") {
      heads.set(`${spec.edge.u}->${spec.edge.v}`, { right: x0 + w - spec.right, mid: top + spec.top + (spec.h - 1) / 2 });
    } else if (spec.kind === "hbar") {
      for (let px = x0 + spec.left; px < x0 + w - spec.right; px++) mark(spec.edge, px, yOf(1));
    } else if (spec.kind === "vbar") {
      const y1 = spec.top != null ? top + spec.top : top + h - spec.bottom - spec.h;
      const y2 = spec.h != null ? y1 + spec.h : top + h - spec.bottom;
      for (let py = y1; py < y2; py++) mark(spec.edge, x0 + spec.left, py);
    } else {
      const L = x0 + spec.left, T = yOf(R + 1);
      for (let i = 0; i <= R; i++) {
        mark(spec.edge, L + i, spec.cornerKind[0] === "t" ? T : T + R);
        mark(spec.edge, L + (spec.cornerKind[1] === "l" ? 0 : R), T + i);
      }
    }
  };
  layout.grid.forEach((row, r) => {
    for (let c = 0; c < layout.cols; c++) {
      for (const spec of chainCellSpecs(layout, r, c)) draw(spec, r, colX(c), W);
      if (c < layout.cols - 1) for (const spec of chainGutterSpecs(layout, r, c)) draw(spec, r, colX(c) + W, gutAt(c));
    }
  });
  const cards = [];
  layout.grid.forEach((row, r) => row.forEach((id, c) => {
    if (id) cards.push({ id, x0: colX(c), x1: colX(c) + W, y0: rowTop[r], y1: rowTop[r] + cardHAt(r) });
  }));
  return { pixels, heads, cards, rowTop, colX };
}

// The routing contract of the wide Chains grid: every edge is one unbroken line from its source
// card's right edge at its own port to an arrowhead touching the target card at its own port, no
// two edges share a stretch of line (which would read as one line joining unrelated cards), and
// no line runs inside a card. Two lines may still cross at a single pixel; returns how many do.
function assertCleanRouting(b, layout, label) {
  const { pixels, heads, cards, rowTop, colX } = rasterChainLane(b, layout);
  for (const e of layout.edges) {
    const k = `${e.u}->${e.v}`;
    const U = layout.pos.get(e.u), V = layout.pos.get(e.v);
    const set = pixels.get(k) ?? new Set();
    const start = `${colX(U.c) + b.CHAIN_CARD_W},${rowTop[U.r] + e.p1}`;
    const end = `${colX(V.c) - b.CHAIN_HEAD_W - 1},${rowTop[V.r] + e.p2}`;
    assert.ok(set.has(start), `${label}: ${k} leaves its source at port ${e.p1}`);
    assert.ok(set.has(end), `${label}: ${k} reaches its head at port ${e.p2}`);
    const seen = new Set([start]);
    const queue = [start];
    while (queue.length) {
      const [px, py] = queue.pop().split(",").map(Number);
      for (const n of [`${px + 1},${py}`, `${px - 1},${py}`, `${px},${py + 1}`, `${px},${py - 1}`]) {
        if (set.has(n) && !seen.has(n)) { seen.add(n); queue.push(n); }
      }
    }
    assert.ok(seen.has(end), `${label}: ${k} is one unbroken line`);
    assert.equal(seen.size, set.size, `${label}: ${k} draws no stray pieces`);
    assert.deepEqual(heads.get(k), { right: colX(V.c), mid: rowTop[V.r] + e.p2 }, `${label}: ${k} head touches the target at its port`);
  }
  const owner = new Map();
  let crossings = 0;
  for (const [k, set] of pixels) {
    for (const p of set) {
      const [px, py] = p.split(",").map(Number);
      const inside = cards.find((c) => px >= c.x0 && px < c.x1 && py >= c.y0 && py < c.y1);
      assert.ok(!inside, `${label}: ${k} runs through card ${inside?.id} at ${p}`);
      const other = owner.get(p);
      if (!other) { owner.set(p, k); continue; }
      crossings++;
      const both = (n) => set.has(n) && pixels.get(other).has(n);
      const run = [`${px + 1},${py}`, `${px - 1},${py}`, `${px},${py + 1}`, `${px},${py - 1}`].find(both);
      assert.ok(!run, `${label}: ${k} and ${other} share a stretch of line at ${p} and ${run}`);
    }
  }
  return crossings;
}

test("chainJoint, placeChainLane, chainGutterSpecs, and chainCellSpecs produce aligned grid and connector descriptors", async () => {
  const b = await board();
  const {
    cardsFrom, dependencyGraph,
    chainJoint, placeChainLane, chainGutterSpecs, chainCellSpecs,
    CHAIN_PORT_TOP, CHAIN_PORT_STEP, CHAIN_R, CHAIN_HEAD_W, CHAIN_HEAD_H,
  } = b;

  // chainJoint keeps an odd head height centered on the 1px line slot [y, y+1] across every port height.
  assert.equal(CHAIN_HEAD_H % 2, 1);
  for (const y of [CHAIN_PORT_TOP, CHAIN_PORT_TOP + CHAIN_PORT_STEP, CHAIN_PORT_TOP + 2 * CHAIN_PORT_STEP, CHAIN_PORT_TOP + 4 * CHAIN_PORT_STEP]) {
    const j = chainJoint(y);
    assert.equal(j.lineTop, y);
    assert.equal(j.lineH, 1);
    assert.equal(j.headW, CHAIN_HEAD_W);
    assert.equal(j.headH, CHAIN_HEAD_H);
    assert.equal(j.headTop + j.headH / 2, j.lineTop + 0.5, `joint centered at port ${y}`);
  }

  // Fork + cross-project side branch + join + skip-level pass-through.
  const fixtureRecords = [
        { id: "maple-token", state: "in_flight", repo: "maple-workshop", title: "Token", priority: "0", structured: true, unresolved_blocker_ids: [] },
        { id: "maple-card", state: "queued", repo: "maple-workshop", title: "Card", priority: "1", structured: true, unresolved_blocker_ids: ["maple-token"] },
        { id: "maple-panel", state: "queued", repo: "maple-workshop", title: "Panel", priority: "1", structured: true, unresolved_blocker_ids: ["maple-card"] },
        { id: "maple-release", state: "queued", repo: "maple-workshop", title: "Release", priority: "0", structured: true, unresolved_blocker_ids: ["maple-panel", "orchard-icons", "maple-skip"] },
        { id: "maple-docs", state: "queued", repo: "maple-workshop", title: "Docs", priority: "2", structured: true, unresolved_blocker_ids: ["maple-release"] },
        { id: "orchard-theme", state: "queued", repo: "orchard-atlas", title: "Theme", priority: "2", structured: true, unresolved_blocker_ids: ["maple-token"] },
        { id: "orchard-icons", state: "queued", repo: "orchard-atlas", title: "Icons", priority: "2", structured: true, unresolved_blocker_ids: ["orchard-theme"] },
        { id: "maple-skip", state: "queued", repo: "maple-workshop", title: "Skip", priority: "3", structured: true, unresolved_blocker_ids: ["maple-token"] },
  ];
  const g = dependencyGraph(cardsFrom({ backlog: { records: fixtureRecords } }));
  const layout = placeChainLane(g.components[0], g.nodes);
  assert.equal(layout.cols, 5);
  assert.deepEqual(Array.from(layout.grid[0]), ["maple-token", "maple-card", "maple-panel", "maple-release", "maple-docs"]);
  assert.deepEqual(Array.from(layout.grid[1]), [null, "orchard-theme", "orchard-icons", null, null]);
  assert.deepEqual(Array.from(layout.grid[2]), [null, "maple-skip", null, null, null]);

  // Ports run top to bottom in the order the lines head: straight across first, then rows below,
  // nearest first. A line straight across its row keeps one height at both ends.
  const edge = (u, v) => layout.edges.find((e) => e.u === u && e.v === v);
  assert.ok(edge("maple-token", "maple-card").p1 < edge("maple-token", "orchard-theme").p1);
  assert.ok(edge("maple-token", "orchard-theme").p1 < edge("maple-token", "maple-skip").p1);
  assert.ok(edge("maple-panel", "maple-release").p2 < edge("orchard-icons", "maple-release").p2);
  assert.ok(edge("orchard-icons", "maple-release").p2 < edge("maple-skip", "maple-release").p2);
  for (const [u, v] of [["maple-token", "maple-card"], ["maple-card", "maple-panel"], ["orchard-theme", "orchard-icons"], ["maple-release", "maple-docs"]]) {
    assert.equal(edge(u, v).p1, edge(u, v).p2, `${u} -> ${v} runs straight`);
  }

  assert.equal(edge("maple-token", "orchard-theme").cross, true);
  assert.equal(edge("orchard-icons", "maple-release").cross, true);
  assert.equal(edge("maple-token", "maple-card").cross, false);

  // Every vertical turn sharing a gutter gets its own x spaced at CHAIN_PORT_STEP, with room
  // for an (R + 1) elbow on its left and an elbow plus visible line before the arrowhead on its right.
  const turnsByGutter = new Map();
  for (const e of layout.edges) {
    const U = layout.pos.get(e.u), V = layout.pos.get(e.v);
    if (U.r === V.r && e.p1 === e.p2) continue;
    if (!turnsByGutter.has(V.c - 1)) turnsByGutter.set(V.c - 1, []);
    turnsByGutter.get(V.c - 1).push(e.x);
  }
  for (const [gIdx, xs] of turnsByGutter) {
    const sorted = [...xs].sort((a, b) => a - b);
    assert.equal(new Set(sorted).size, sorted.length, `distinct turn x in gutter ${gIdx}: ${sorted}`);
    for (let i = 1; i < sorted.length; i++) {
      assert.equal(sorted[i] - sorted[i - 1], CHAIN_PORT_STEP, `parallel vertical runs in gutter ${gIdx} keep port step`);
    }
    const gutW = layout.gutterW[gIdx];
    for (const x of sorted) {
      assert.ok(x - CHAIN_R >= 1, `elbow at ${x} stays inside gutter ${gIdx}`);
      assert.ok(x + CHAIN_R + 1 < gutW - CHAIN_HEAD_W, `line after the elbow at ${x} is visible before the head`);
    }
  }
  assert.equal(turnsByGutter.get(2).length, 2);
  // Every gutter is wider than the 44px the Chains view used before it was spread out.
  for (const [gIdx, w] of layout.gutterW.entries()) assert.ok(w > 44, `gutter ${gIdx} is ${w}px`);
  assert.equal(assertCleanRouting(b, layout, "fixture"), 0);

  // The same graph with maple-release's blockers listed in another order still draws without crossings.
  const rg = dependencyGraph(cardsFrom({
    backlog: {
      records: fixtureRecords.map((r) => (r.id === "maple-release"
        ? { ...r, unresolved_blocker_ids: ["maple-skip", "orchard-icons", "maple-panel"] } : r)),
    },
  }));
  assert.equal(assertCleanRouting(b, placeChainLane(rg.components[0], rg.nodes), "reordered blockers"), 0);

  // Three-way join spreads its arrowheads across the card edge with >=20px step.
  const releasePorts = [edge("maple-panel", "maple-release").p2, edge("orchard-icons", "maple-release").p2, edge("maple-skip", "maple-release").p2];
  assert.ok(releasePorts[1] - releasePorts[0] >= 20, `3-way fan-in top gap: ${releasePorts}`);
  assert.ok(releasePorts[2] - releasePorts[1] >= 20, `3-way fan-in bottom gap: ${releasePorts}`);
  // Rows sit further apart than the 12px padding the Chains view used before.
  assert.ok(layout.rowPad[0] > 12, `row padding ${layout.rowPad[0]}`);

  // Skip-level pass-through across empty cell (r=2, c=2) draws a horizontal bar at maple-skip's outgoing port.
  const pass = chainCellSpecs(layout, 2, 2);
  assert.equal(pass.length, 1);
  assert.equal(pass[0].top, edge("maple-skip", "maple-release").p1);

  // Intermediate vertical pass-through in gutter (r=1, g=2) for maple-skip (row 2 -> row 0).
  const midVbars = chainGutterSpecs(layout, 1, 2).filter((s) => s.kind === "vbar" && s.edge.u === "maple-skip");
  assert.equal(midVbars.length, 1);
  assert.equal(midVbars[0].top, 0);
  assert.equal(midVbars[0].bottom, 0);
  assert.equal(midVbars[0].left, edge("maple-skip", "maple-release").x);
});

test("Chains routes a skip-level edge around the cards it passes instead of through them", async () => {
  const b = await board();
  const { cardsFrom, dependencyGraph, placeChainLane, chainGutterSpecs, chainCellSpecs } = b;
  const lane = (records) => {
    const g = dependencyGraph(cardsFrom({ backlog: { records: records.map((r) => ({ state: "queued", repo: "maple-workshop", structured: true, ...r })) } }));
    return placeChainLane(g.components[0], g.nodes);
  };

  // Diamond on one row: A -> B -> C, and C also waits on A.
  const diamond = lane([
    { id: "A", title: "A", unresolved_blocker_ids: [] },
    { id: "B", title: "B", unresolved_blocker_ids: ["A"] },
    { id: "C", title: "C", unresolved_blocker_ids: ["B", "A"] },
  ]);
  assert.deepEqual(Array.from(diamond.grid[0]), ["A", "B", "C"]);
  assert.equal(diamond.grid.length, 1);
  assert.equal(assertCleanRouting(b, diamond, "diamond"), 0);
  // A -> C has its own port on both cards, apart from B's line.
  const ac = diamond.edges.find((e) => e.u === "A" && e.v === "C");
  const bc = diamond.edges.find((e) => e.u === "B" && e.v === "C");
  assert.notEqual(ac.p2, bc.p2);
  // Within B's column A -> C only runs through the padding below B's card, never at a port height.
  const underB = chainCellSpecs(diamond, 0, 1).filter((s) => s.edge === ac);
  assert.equal(underB.length, 1);
  assert.equal(underB[0].top, null);
  assert.ok(underB[0].bottom >= 0 && underB[0].bottom < diamond.rowPad[0], "lane sits in the row padding");
  // The only row is the last one, yet it keeps padding for the lane.
  assert.ok(diamond.rowPad[0] > 0);

  // Overlapping skip-level detours keep wider separation than before and >= CHAIN_R clearance from cards.
  const dualDetour = lane([
    { id: "D0", title: "D0", unresolved_blocker_ids: [] },
    { id: "D1", title: "D1", unresolved_blocker_ids: ["D0"] },
    { id: "D2", title: "D2", unresolved_blocker_ids: ["D1", "D0"] },
    { id: "D3", title: "D3", unresolved_blocker_ids: ["D2", "D1"] },
  ]);
  assertCleanRouting(b, dualDetour, "dual detour");
  const detourChans = dualDetour.edges.filter((e) => e.chan != null).map((e) => e.chan).sort((x, y) => x - y);
  assert.equal(detourChans.length, 2);
  assert.ok(detourChans[1] - detourChans[0] > 4, `detour lanes ${detourChans} sit further apart than the old 4px`);
  assert.ok(detourChans[0] >= b.CHAIN_R && dualDetour.rowPad[0] - detourChans[1] >= b.CHAIN_R);

  // Side branch X -> Y -> Z on row 1, plus X -> Z (same row, past Y) and X -> S3 (up to the spine, past Y).
  const branch = lane([
    { id: "S0", title: "S0", unresolved_blocker_ids: [] },
    { id: "S1", title: "S1", unresolved_blocker_ids: ["S0"] },
    { id: "S2", title: "S2", unresolved_blocker_ids: ["S1"] },
    { id: "S3", title: "S3", unresolved_blocker_ids: ["S2", "X"] },
    { id: "S4", title: "S4", unresolved_blocker_ids: ["S3"] },
    { id: "X", title: "X", unresolved_blocker_ids: ["S0"] },
    { id: "Y", title: "Y", unresolved_blocker_ids: ["X"] },
    { id: "Z", title: "Z", unresolved_blocker_ids: ["Y", "X"] },
  ]);
  assert.deepEqual(Array.from(branch.grid[0]), ["S0", "S1", "S2", "S3", "S4"]);
  assert.deepEqual(Array.from(branch.grid[1]), [null, "X", "Y", "Z", null]);
  assert.equal(assertCleanRouting(b, branch, "branch row"), 0);

  // An edge with nothing in its way keeps the plain path: one line straight across at its port.
  const s01 = branch.edges.find((e) => e.u === "S0" && e.v === "S1");
  assert.equal(s01.p1, s01.p2);
  const s01Pieces = chainGutterSpecs(branch, 0, 0).filter((s) => s.edge === s01);
  assert.deepEqual(Array.from(s01Pieces, (s) => s.kind), ["hbar", "head"]);
  assert.equal(s01Pieces[0].top, s01.p1);
  assert.equal(s01Pieces[0].left, 0);
});

test("Chains never lets a line leaving one card run on into a line entering the card beside it", async () => {
  const b = await board();
  const { cardsFrom, dependencyGraph, placeChainLane } = b;
  const lane = (deps) => {
    const ids = [...new Set(deps.flat())];
    const g = dependencyGraph(cardsFrom({
      backlog: {
        records: ids.map((id) => ({
          id, state: "queued", repo: "maple-workshop", title: id, structured: true,
          unresolved_blocker_ids: deps.filter(([, v]) => v === id).map(([u]) => u),
        })),
      },
    }));
    return placeChainLane(g.components[0], g.nodes);
  };

  // B -> Z turns down into Z on row 1 while X -> C turns up out of X on the same row: their
  // horizontal pieces once shared one track and read as a nonexistent X -> Z line.
  const turns = lane([["A", "B"], ["B", "C"], ["A", "X"], ["X", "C"], ["B", "Z"]]);
  assert.deepEqual(Array.from(turns.grid, (row) => Array.from(row)), [["A", "B", "C"], [null, "X", "Z"]]);
  assertCleanRouting(b, turns, "opposite turns");

  // The same with detour lanes: N2 -> N5 leaves N2 up toward its lane while N0 -> N3 comes down from its lane into N3.
  const lanes = lane([["N0", "N1"], ["N0", "N2"], ["N2", "N3"], ["N0", "N3"], ["N0", "N4"], ["N1", "N4"], ["N2", "N5"], ["N0", "N5"], ["N4", "N5"]]);
  assert.deepEqual(Array.from(lanes.grid, (row) => Array.from(row)), [["N0", "N1", "N4", "N5"], [null, "N2", "N3", null]]);
  assertCleanRouting(b, lanes, "opposite detours");

  // Every small dependency graph keeps the contract, not just the shapes above. A fixed seed
  // keeps the run deterministic.
  let seed = 20261116;
  const rand = () => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648);
  for (let run = 0; run < 400; run++) {
    const n = 3 + Math.floor(rand() * 6);
    const ids = Array.from({ length: n }, (_, i) => `N${i}`);
    const deps = [];
    for (let v = 1; v < n; v++) {
      deps.push([ids[Math.floor(rand() * v)], ids[v]]);
      for (let u = 0; u < v; u++) if (rand() < 0.25 && !deps.some(([a, c]) => a === ids[u] && c === ids[v])) deps.push([ids[u], ids[v]]);
    }
    assertCleanRouting(b, lane(deps), `graph ${JSON.stringify(deps)}`);
  }
});

test("Chains grows fan-in cards so every port keeps the full step and every arrowhead stays on the card edge", async () => {
  const b = await board();
  const { cardsFrom, dependencyGraph, placeChainLane, CHAIN_PORT_STEP, CHAIN_R, CHAIN_HEAD_H } = b;
  const roots = ["B0", "B1", "B2", "B3", "B4", "B5"];
  const g = dependencyGraph(cardsFrom({
    backlog: {
      records: [
        ...roots.map((id) => ({ id, state: "queued", repo: "maple-workshop", title: id, structured: true, unresolved_blocker_ids: [] })),
        { id: "T", state: "queued", repo: "maple-workshop", title: "T", structured: true, unresolved_blocker_ids: roots },
      ],
    },
  }));
  const layout = placeChainLane(g.components[0], g.nodes);
  const ports = layout.edges.map((e) => e.p2).sort((x, y) => x - y);
  assert.equal(ports.length, 6);
  // Every consecutive pair keeps the full CHAIN_PORT_STEP without clamping.
  for (let i = 1; i < ports.length; i++) assert.equal(ports[i] - ports[i - 1], CHAIN_PORT_STEP, `ports ${ports}`);
  // Row 0 min height grows above the lowest arrowhead + bottom corner radius so every port stays on the flat edge.
  const minH = layout.rowMinH[0];
  assert.ok(minH > 78, `row grows to ${minH}px for 6 incoming ports`);
  for (const p of ports) assert.ok(p + (CHAIN_HEAD_H - 1) / 2 <= minH - CHAIN_R, `port ${p} stays on the grown card edge`);
  // Gutter grows so the 5 parallel turns keep CHAIN_PORT_STEP horizontal spacing too.
  const xs = layout.edges.filter((e) => e.x != null).map((e) => e.x).sort((a, b) => a - b);
  assert.equal(xs.length, 5);
  for (let i = 1; i < xs.length; i++) assert.equal(xs[i] - xs[i - 1], CHAIN_PORT_STEP, `turns ${xs}`);
  assert.equal(assertCleanRouting(b, layout, "six blockers"), 0);
});

test("Chains keeps a join's arrowheads apart even when a card elsewhere in the lane unblocks many", async () => {
  const b = await board();
  const { cardsFrom, dependencyGraph, placeChainLane, CHAIN_HEAD_H } = b;
  const fan = ["D1", "D2", "D3", "D4", "D5", "D6", "D7"];
  const g = dependencyGraph(cardsFrom({
    backlog: {
      records: [
        { id: "H", state: "queued", repo: "maple-workshop", title: "H", structured: true, unresolved_blocker_ids: [] },
        ...fan.map((id) => ({ id, state: "queued", repo: "maple-workshop", title: id, structured: true, unresolved_blocker_ids: ["H"] })),
        { id: "J", state: "queued", repo: "maple-workshop", title: "J", structured: true, unresolved_blocker_ids: ["D1", "D2"] },
      ],
    },
  }));
  const layout = placeChainLane(g.components[0], g.nodes);
  assert.equal(layout.grid[0][2], "J");
  // Two 9px arrowheads into J must not share a pixel row, however many lines leave H.
  const joinPorts = layout.edges.filter((e) => e.v === "J").map((e) => e.p2).sort((x, y) => x - y);
  assert.equal(joinPorts.length, 2);
  assert.ok(joinPorts[1] - joinPorts[0] >= CHAIN_HEAD_H, `J's ports ${joinPorts}`);
  assertCleanRouting(b, layout, "hub and join");
});

test("Chains keeps a join's arrowheads apart when the card beside it unblocks many", async () => {
  const b = await board();
  const { cardsFrom, dependencyGraph, placeChainLane, CHAIN_HEAD_H } = b;
  const fan = ["D1", "D2", "D3", "D4", "D5", "D6", "D7"];
  const g = dependencyGraph(cardsFrom({
    backlog: {
      records: [
        { id: "H", state: "queued", repo: "maple-workshop", title: "H", structured: true, unresolved_blocker_ids: [] },
        { id: "X", state: "queued", repo: "maple-workshop", title: "X", structured: true, unresolved_blocker_ids: [] },
        ...fan.map((id) => ({
          id, state: "queued", repo: "maple-workshop", title: id, structured: true,
          priority: id === "D1" ? "0" : "2", unresolved_blocker_ids: id === "D1" ? ["H", "X"] : ["H"],
        })),
      ],
    },
  }));
  const layout = placeChainLane(g.components[0], g.nodes);
  // H sits directly left of D1 on the spine and sends six more lines out past it.
  assert.deepEqual(Array.from(layout.grid[0]), ["H", "D1"]);
  const joinPorts = layout.edges.filter((e) => e.v === "D1").map((e) => e.p2).sort((x, y) => x - y);
  assert.equal(joinPorts.length, 2);
  assert.ok(joinPorts[1] - joinPorts[0] >= CHAIN_HEAD_H, `D1's ports ${joinPorts}`);
  // Every line still leaves H on the grown card's flat edge, above the bottom corner radius.
  for (const e of layout.edges.filter((x) => x.u === "H")) assert.ok(e.p1 + 2 <= layout.rowMinH[0] - b.CHAIN_R, `H -> ${e.v} leaves at ${e.p1}`);
  assertCleanRouting(b, layout, "hub beside join");
});

test("Chains connector lines, arrowheads, and elbows obey all alignment rules in wide and narrow views across selection states", async () => {
  // Exercises all 4 elbow directions (tr, bl, br, tl), multi-port joins,
  // cross-project dashed links, pass-through cells, and narrow stepper branch heads.
  const records = [
    { id: "maple-token", state: "in_flight", repo: "maple-workshop", title: "Token", priority: "0", structured: true, unresolved_blocker_ids: [] },
    { id: "maple-card", state: "queued", repo: "maple-workshop", title: "Card", priority: "1", structured: true, unresolved_blocker_ids: ["maple-token"] },
    { id: "maple-panel", state: "queued", repo: "maple-workshop", title: "Panel", priority: "1", structured: true, unresolved_blocker_ids: ["maple-card"] },
    { id: "maple-release", state: "queued", repo: "maple-workshop", title: "Release", priority: "0", structured: true, unresolved_blocker_ids: ["maple-panel", "orchard-icons", "maple-skip"] },
    { id: "orchard-theme", state: "queued", repo: "orchard-atlas", title: "Theme", priority: "2", structured: true, unresolved_blocker_ids: ["maple-token"] },
    { id: "orchard-icons", state: "queued", repo: "orchard-atlas", title: "Icons", priority: "2", structured: true, unresolved_blocker_ids: ["orchard-theme"] },
    { id: "maple-skip", state: "queued", repo: "maple-workshop", title: "Skip", priority: "3", structured: true, unresolved_blocker_ids: ["maple-token"] },
  ];
  const theme = {
    accent: "#61afef",
    working: "#e5c07b",
    ansi6: "#56b6c2",
    border: "#3a404b",
    dim: "#6b7280",
    muted: "#9aa1ad",
    selected: "#323844",
    background: "#1e2127",
    surface: "#252931",
  };
  const b = await board({
    theme,
    ui: { viewMode: "chains" },
    snapshot: { schema: "fm-fleet-snapshot.v1", fm_home: HOME, tasks: [], backlog: { records } },
  });
  const call = (el, name) => el?.calls?.findLast((c) => c[0] === name)?.[1];
  const hasCall = (el, name) => Boolean(el?.calls?.some((c) => c[0] === name));
  const parentOf = (id) => b.items.find((p) => p.childIds.includes(id));

  const comp = b.view.visibleChains()[0];
  const layout = b.placeChainLane(comp, b.view.graph.nodes);
  const R = b.CHAIN_R;

  const assertWideAlignment = () => {
    for (const e of layout.edges) {
      const key = `${e.u}-${e.v}`;
      const line = b.items.find((x) => x.id === `chain-edge-${key}-line`);
      const head = b.items.find((x) => x.id === `chain-edge-${key}-head`);
      assert.ok(line, `missing line for ${key}`);
      assert.ok(head, `missing head for ${key}`);

      const lineTop = call(line, "top");
      const headTop = call(head, "top");
      const headH = call(head, "h");
      const headW = call(head, "w");
      assert.equal(headH % 2, 1, `${key} head height must be odd`);
      assert.equal(headTop + headH / 2, lineTop + 0.5, `${key} head tip centered on line`);
      assert.equal(call(head, "right"), 0, `${key} head touches card left edge`);
      assert.equal(call(line, "right"), headW, `${key} line stops at head left edge`);
      assert.ok(hasCall(head, "absolute"), `${key} head must be absolute`);
      assert.ok(hasCall(line, "absolute"), `${key} line must be absolute`);

      const pLine = parentOf(line.id);
      const pHead = parentOf(head.id);
      assert.ok(pLine && pHead && pLine.id === pHead.id, `${key} line and head share parent`);
      assert.ok(hasCall(pLine, "relative"), `${key} parent is relative`);

      const U = layout.pos.get(e.u), V = layout.pos.get(e.v);
      if (U.r !== V.r) {
        const down = V.r > U.r;
        const outKind = down ? "tr" : "br";
        const inKind = down ? "bl" : "tl";
        const cOut = b.items.find((x) => x.id === `chain-edge-${key}-corner-${outKind}`);
        const cIn = b.items.find((x) => x.id === `chain-edge-${key}-corner-${inKind}`);
        const outHbar = b.items.find((x) => x.id === `chain-edge-${key}-hbar-${U.r}-${V.c - 1}`);
        const outVbar = b.items.find((x) => x.id === `chain-edge-${key}-vbar-${U.r}`);
        const inVbar = b.items.find((x) => x.id === `chain-edge-${key}-vbar-${V.r}`);
        assert.ok(cOut && cIn && outHbar && outVbar && inVbar, `${key} cross-row segments present`);

        for (const [kind, corner, hbar, vbar] of [[outKind, cOut, outHbar, outVbar], [inKind, cIn, line, inVbar]]) {
          assert.equal(call(corner, "w"), R + 1, `${key} ${kind} width is R+1`);
          assert.equal(call(corner, "h"), R + 1, `${key} ${kind} height is R+1`);
          assert.equal(call(corner, "top") + (kind[0] === "t" ? 0 : R), call(hbar, "top"), `${key} ${kind} horizontal slot matches bar`);
          assert.equal(call(corner, "left") + (kind[1] === "l" ? 0 : R), call(vbar, "left"), `${key} ${kind} vertical slot matches bar`);
        }
      }
      if (e.cross) assert.ok(hasCall(line, "border_dashed"), `${key} cross-project line is dashed`);
    }
  };

  const assertNarrowAlignment = () => {
    const spineSet = new Set(layout.spineIds);
    for (const id of comp.nodeIds) {
      if (spineSet.has(id)) continue;
      const line = b.items.find((x) => x.id === `chain-stepper-edge-${id}-line`);
      const head = b.items.find((x) => x.id === `chain-stepper-edge-${id}-head`);
      assert.ok(line && head, `stepper connector for branch ${id}`);
      const lineTop = call(line, "top");
      const headTop = call(head, "top");
      const headH = call(head, "h");
      assert.equal(headH % 2, 1);
      assert.equal(headTop + headH / 2, lineTop + 0.5);
      assert.equal(call(head, "right"), 0);
      assert.equal(call(line, "right"), call(head, "w"));
      assert.ok(hasCall(head, "absolute"));
      const pLine = parentOf(line.id);
      const pHead = parentOf(head.id);
      assert.ok(pLine && pHead && pLine.id === pHead.id);
      assert.ok(hasCall(pLine, "relative"));
    }
  };

  // Wide view: unselected, hovered, and selected states all keep exact connector geometry.
  b.view.size = { width: 1280, height: 800 };
  b.redraw();
  assertWideAlignment();
  const wideGeomBefore = geometry(b.items.filter((x) => x.id.startsWith("chain-edge-") || x.id.startsWith("chain-node-")));

  b.hover("chain-node-orchard-icons", true);
  assert.deepEqual(geometry(b.items.filter((x) => x.id.startsWith("chain-edge-") || x.id.startsWith("chain-node-"))), wideGeomBefore);
  assertWideAlignment();
  b.hover("chain-node-orchard-icons", false);

  b.click("chain-node-orchard-icons");
  assert.deepEqual(geometry(b.items.filter((x) => x.id.startsWith("chain-edge-") || x.id.startsWith("chain-node-"))), wideGeomBefore);
  assertWideAlignment();

  // Narrow view (<720px): selected and unselected both align cleanly.
  b.view.size = { width: 520, height: 800 };
  b.redraw();
  assertNarrowAlignment();
  b.click("chain-node-orchard-icons"); // deselect
  assertNarrowAlignment();
});

test("Chains dims every connector piece of an unselected chain, including lines across empty cells", async () => {
  const records = [
    { id: "maple-token", state: "queued", repo: "maple-workshop", title: "Token", structured: true, unresolved_blocker_ids: [] },
    { id: "maple-card", state: "queued", repo: "maple-workshop", title: "Card", structured: true, unresolved_blocker_ids: ["maple-token"] },
    { id: "maple-panel", state: "queued", repo: "maple-workshop", title: "Panel", structured: true, unresolved_blocker_ids: ["maple-card"] },
    { id: "maple-skip", state: "queued", repo: "maple-workshop", title: "Skip", structured: true, unresolved_blocker_ids: ["maple-token"] },
    { id: "maple-release", state: "queued", repo: "maple-workshop", title: "Release", structured: true, unresolved_blocker_ids: ["maple-panel", "maple-skip"] },
    { id: "pine-a", state: "queued", repo: "maple-workshop", title: "Pine A", structured: true, unresolved_blocker_ids: [] },
    { id: "pine-b", state: "queued", repo: "maple-workshop", title: "Pine B", structured: true, unresolved_blocker_ids: ["pine-a"] },
  ];
  const b = await board({
    ui: { viewMode: "chains" },
    snapshot: { schema: "fm-fleet-snapshot.v1", fm_home: HOME, tasks: [], backlog: { records } },
  });
  b.view.size = { width: 1280, height: 800 };
  b.redraw();
  const parentOf = (id) => b.items.find((p) => p.childIds.includes(id));
  // Opacity multiplies down the tree, so what a piece shows is the product along its ancestors.
  const shown = (item) => {
    let o = 1;
    for (let el = item; el; el = parentOf(el.id)) o *= el.calls.findLast((c) => c[0] === "opacity")?.[1] ?? 1;
    return o;
  };
  const maplePieces = () => b.items.filter((x) => x.id.startsWith("chain-edge-maple-"));
  assert.ok(b.ids.includes("chain-edge-maple-skip-maple-release-pass-1-2"), "maple-skip's line crosses an empty cell");
  for (const piece of maplePieces()) assert.equal(shown(piece), 1, `${piece.id} at full strength before any selection`);

  b.click("chain-node-pine-a");
  const pieces = maplePieces();
  assert.ok(pieces.length > 0);
  for (const piece of pieces) assert.ok(shown(piece) <= 0.45, `${piece.id} is dimmed with its chain (${shown(piece)})`);
});

// The fixture with changes, without touching the shared copy.
/** @param {(s: any) => void} change */
function changedSnapshot(change) {
  const copy = JSON.parse(JSON.stringify(snapshot));
  change(copy);
  return copy;
}
const record = (s, id) => s.backlog.records.find((r) => r.id === id);
const opacityOf = (b, id) => b.items.find((x) => x.id === id)?.calls.findLast((c) => c[0] === "opacity")?.[1] ?? 1;
const koreaToday = () => new Date(Date.now() + 9 * 3600 * 1000).toISOString().slice(0, 10);

test("the Today strip counts what landed today, what waits on the captain, what runs, what is ready, and what is blocked", async () => {
  const task = (s, id) => s.tasks.find((t) => t.id === id);
  // The fixture's five workers, placed by hand: maple-preview-screen works, idle in its terminal
  // while a test run continues; maple-theme-tokens finished with an open PR and maple-button-labels
  // reported done with a PR, both ready to land; orchard-nav-style reported blocked and
  // orchard-export-check failed, both blocked.
  const changed = changedSnapshot((s) => {
    record(s, "orchard-seed-data").completion = { verb: "merged", date: koreaToday() };
    Object.assign(task(s, "maple-theme-tokens").current_state, { state: "done", detail: "finished" });
    const labels = task(s, "maple-button-labels");
    Object.assign(labels.hints, { pending_decision: false, open_decisions: [], last_event_text: "done: labels shipped" });
    labels.pr.url = "https://github.com/FlitCatz/maple-workshop/pull/43";
    task(s, "orchard-nav-style").hints.pending_decision = false;
    Object.assign(task(s, "orchard-export-check").current_state, { state: "failed", detail: "mirror check failed" });
  });
  const exec = async (cmd) => (cmd === "/bin/ps"
    ? { code: 0, stdout: "500 1 claude\n501 500 node --test tests/\n", stderr: "" }
    : { code: 1, stdout: "", stderr: "" });
  const b = await board({ snapshot: changed, exec,
    terminals: [{ address: "t1", state: "live", status: "idle", pid: 500, labels: { "firstmate.task": "fm-maple-preview-screen" } }] });
  const listings = [];
  b.view.readBackground({ notify() {}, spawn: (fn) => listings.push(fn({ notify() {} })) });
  await Promise.all(listings);
  b.redraw();
  const cell = (id) => b.text(`today-${id}`);
  assert.match(cell("done"), /^Done today 1/);
  // The three holds to answer now; held-since falls back to the filing date, days ago.
  assert.match(cell("waiting"), /^Waiting on you 3 oldest \d+d$/);
  assert.equal(cell("working"), "Working 1 1 background job");
  assert.match(cell("ready"), /^Ready to land 2\s*$/);
  assert.equal(cell("blocked"), "Blocked 2 1 failed");
  // A finished item from another day is not today's.
  const old = await board();
  assert.match(old.text("today-done"), /^Done today 0/);
});

test("NEXT MOVE shows the longest-waiting hold to answer now, and its options make the Held card's drafts", async () => {
  // With equal filing dates the backlog order decides: the icon set comes first.
  const b = await board();
  assert.match(b.text("next-move"), /maple-icon-set .*Next move, 1 of 3 Choose an icon style/);
  // The first line names the card the decision comes from: its tag, id, and title.
  const title = b.view.cards.find((c) => c.id === "maple-icon-set").title;
  assert.equal(b.text("next-move-card"), `${b.view.tags.get("maple-workshop")} maple-icon-set ${title}`);
  b.click("next-opt-A");
  b.click("next-write");
  assert.deepEqual(b.drafts, ["[Board answer] maple-icon-set: A (Rounded)", "[Board answer] maple-icon-set:"]);
  // A stamped hold that has waited longest wins, and a topic's answer covers every hold sharing it.
  const stamped = await board({ snapshot: changedSnapshot((s) => { record(s, "maple-empty-state").hold_set = "2026-11-01T08:00:00Z"; }) });
  assert.match(stamped.text("next-move"), /maple-empty-state .*Choose the preview style/);
  stamped.click("next-opt-B");
  assert.deepEqual(stamped.drafts, ["[Board answer] maple-tour-sketch, maple-empty-state: B (Bright)"]);
  // A plain Ledger frame, not an inverted band: the background, a bar in the held color, and the
  // recommended option as the one primary (solid) button among raised ones.
  const theme = { background: "#fefefe", solid: "#000000", raised: "#eeeeee", blocked: "#c93c2c", accent: "#1f62d0" };
  const styled = await board({ theme });
  const fill = (id) => styled.items.find((x) => x.id === id).calls.find((c) => c[0] === "bg")[1];
  assert.equal(fill("next-move"), theme.background);
  assert.equal(fill("next-move-bar"), theme.blocked);
  assert.equal(fill("next-opt-A"), theme.solid);
  assert.equal(fill("next-opt-B"), theme.raised);
  assert.equal(fill("next-write"), theme.raised);
  // No hold to answer now, no banner.
  const none = await board({ snapshot: changedSnapshot((s) => {
    for (const id of ["maple-icon-set", "maple-tour-sketch", "maple-empty-state"]) record(s, id).hold_bucket = "aged";
  }) });
  assert.ok(!none.ids.includes("next-move"));
  assert.match(none.text("today-waiting"), /^Waiting on you 0/);
});

test("for a topic whose oldest hold lists no options, NEXT MOVE and Focus Enter answer with the topic's options", async () => {
  // The oldest preview-style hold only points at its sibling, which carries the question and options.
  const snapshot = changedSnapshot((s) => {
    record(s, "maple-tour-sketch").hold_reason = "[topic=preview-style] Same call as the empty state";
    record(s, "maple-tour-sketch").hold_set = "2026-11-01T08:00:00Z";
  });
  const b = await board({ snapshot });
  assert.match(b.text("next-move-card"), /maple-tour-sketch/);
  assert.equal(b.text("next-move-question"), "Choose the preview style");
  assert.ok(b.ids.includes("next-opt-A") && b.ids.includes("next-opt-B"));
  assert.match(b.text("group-preview-style"), /Choose the preview style/);
  b.click("next-opt-A");
  assert.deepEqual(b.drafts, ["[Board answer] maple-tour-sketch, maple-empty-state: A (Soft)"]);
  const f = await board({ snapshot });
  f.click("focus-toggle");
  assert.equal(f.view.focusId, "maple-tour-sketch");
  f.keyDown("root", "enter");
  assert.deepEqual(f.drafts, ["[Board answer] maple-tour-sketch, maple-empty-state: A (Soft)"]);
});

test("every card carries a left bar in its column's status color, and a hold to answer now shows its wait", async () => {
  const theme = { idle: "#111111", working: "#222222", blocked: "#333333", done: "#444444", ansi1: "#555555", unknown: "#666666" };
  const b = await board({ theme,
    snapshot: changedSnapshot((s) => { record(s, "maple-icon-set").hold_set = new Date(Date.now() - 135 * 60000).toISOString().slice(0, 19) + "Z"; }) });
  const barColor = (id) => b.items.find((x) => x.id === `bar-${id}`)?.calls.find((c) => c[0] === "bg")?.[1];
  assert.equal(barColor("maple-preview-screen"), theme.working);
  assert.equal(barColor("maple-icon-set"), theme.blocked);
  assert.equal(barColor("orchard-seed-data"), theme.done);
  assert.equal(barColor("maple-card-layout"), theme.idle);
  assert.equal(b.text("age-maple-icon-set"), "2h 15m");
  // Deferred holds keep their date and show no wait.
  assert.ok(!b.ids.includes("age-orchard-tile-refresh"));
});

test("Focus dims everything but the captain's calls, j/k move between them, and Enter drafts the recommended answer", async () => {
  const b = await board();
  // Keys reach Focus only while the Board itself holds the keyboard.
  b.keyDown("root", "f");
  assert.equal(b.view.focusMode, false);
  b.click("focus-toggle");
  assert.equal(b.view.focusMode, true);
  assert.ok(b.focusedOn("root"));
  assert.ok(b.ids.includes("focus-hint"));
  assert.equal(b.view.focusId, "maple-icon-set");
  assert.equal(opacityOf(b, "card-maple-preview-screen"), 0.22);
  assert.equal(opacityOf(b, "card-maple-icon-set"), 1);
  assert.equal(opacityOf(b, "card-orchard-tile-refresh"), 0.22, "a deferred hold steps back too");
  b.keyDown("root", "j");
  assert.equal(b.view.focusId, "maple-tour-sketch");
  b.keyDown("root", "j"); b.keyDown("root", "j");
  assert.equal(b.view.focusId, "maple-empty-state", "j stops at the last call");
  b.keyDown("root", "k"); b.keyDown("root", "k");
  assert.equal(b.view.focusId, "maple-icon-set");
  b.keyDown("root", "enter");
  assert.deepEqual(b.drafts, ["[Board answer] maple-icon-set: A (Rounded)"]);
  b.keyDown("root", "escape");
  assert.equal(b.view.focusMode, false);
  assert.equal(opacityOf(b, "card-maple-preview-screen"), 1);
  // Chains has no Focus.
  b.keyDown("root", "f");
  assert.equal(b.view.focusMode, true);
  b.view.setViewMode("chains", { notify() {} });
  assert.equal(b.view.focusMode, false);
});

test("in Focus a card inside a topic box with no captain's call is dimmed once, like any other card", async () => {
  // Both preview-style holds deferred: their topic box holds no captain's call.
  const b = await board({ snapshot: changedSnapshot((s) => {
    for (const id of ["maple-tour-sketch", "maple-empty-state"]) record(s, id).hold_bucket = "aged";
  }) });
  b.click("focus-toggle");
  assert.equal(b.view.focusMode, true);
  assert.ok(b.items.find((x) => x.id === "group-preview-style").childIds.includes("card-maple-tour-sketch"));
  // gpui-kit's opacity applies to the element and everything in it, so what shows is the product along the path.
  const parentOf = (id) => b.items.find((x) => x.childIds.includes(id))?.id;
  const shown = (id) => { let o = 1; for (let at = id; at; at = parentOf(at)) o *= opacityOf(b, at); return o; };
  assert.equal(opacityOf(b, "group-preview-style"), 0.22, "the box itself steps back with its cards");
  assert.equal(shown("card-maple-tour-sketch"), 0.22);
  assert.equal(shown("card-maple-empty-state"), 0.22);
  assert.equal(shown("card-maple-preview-screen"), 0.22);
});

test("a PR link shows the PR in the layout's PR panel, and in the browser without that panel or without the mod", async () => {
  const opened = [];
  const exec = async (cmd, args) => { if (cmd === "open") opened.push(args[0]); return { code: 1, stdout: "", stderr: "" }; };
  const url = "https://github.com/FlitCatz/maple-workshop/pull/42";
  const plain = (x) => JSON.parse(JSON.stringify(x));
  const panelLayout = { id: "root", children: [{ id: "panel", hidden: true, children: [{ id: "panel-body", active: "board",
    children: [{ id: "board" }, { id: "pr", content: { mod: "herdr-pr-viewer" } }] }] }] };
  // The herdr-pr-viewer panel contract: one shared request with a fresh `at`, then the panel is selected and shown.
  const before = Date.now();
  const inPanel = await board({ prViewer: true, exec, rootLayout: panelLayout });
  inPanel.click("pr-maple-theme-tokens");
  await inPanel.settle();
  const color = inPanel.view.colorOf("maple-workshop", {});
  assert.equal(inPanel.sharedSet.length, 1);
  const { key, value } = plain(inPanel.sharedSet[0]);
  assert.equal(key, "herdr-pr-viewer.show");
  assert.ok(value.at >= before && value.at <= Date.now(), "at is the click time");
  assert.deepEqual({ ...value, at: 0 }, { url, task: "maple-theme-tokens · maple-workshop", badge: { text: "MAW", color }, at: 0 });
  assert.deepEqual(plain(inPanel.commands), [
    { name: "layout.select", args: { stack: "panel-body", child: "pr" } },
    { name: "layout.show", args: { id: "panel" } },
  ]);
  assert.deepEqual(opened, []);
  // Clicking again is a new request.
  inPanel.click("pr-maple-theme-tokens");
  await inPanel.settle();
  assert.equal(inPanel.sharedSet.length, 2);
  // A layout without the PR panel opens the link in the browser and changes nothing in Herdr.
  const noPanel = await board({ prViewer: true, exec, rootLayout: { id: "root", children: [] } });
  noPanel.click("pr-maple-theme-tokens");
  await noPanel.settle();
  assert.deepEqual(opened, [url]);
  assert.deepEqual(noPanel.commands, []);
  assert.equal(noPanel.sharedSet.length, 0);
  // Without the mod (Herdr reads its missing mod.json as null), the panel stays untouched too.
  const without = await board({ exec, rootLayout: panelLayout });
  without.click("pr-maple-theme-tokens");
  await without.settle();
  assert.deepEqual(opened, [url, url]);
  assert.deepEqual(without.commands, []);
  assert.equal(without.sharedSet.length, 0);
});

test("below the board one tab strip holds Commands, Projects with its unhandled request count, and Checks", async () => {
  const store = memoryStore();
  const b = await board({ store });
  // The group sits below the task board, Commands open by default, the status on the strip's right.
  assert.ok(b.ids.indexOf("bottom-group") > b.ids.indexOf("board"));
  assert.deepEqual(b.ids.filter((id) => id.startsWith("bottom-tab-")), ["bottom-tab-commands", "bottom-tab-projects", "bottom-tab-checks"]);
  assert.ok(b.ids.includes("ask-memo") && !b.ids.includes("project-list") && !b.ids.includes("checks-list"));
  assert.ok(b.ids.includes("refresh"), "the update time rides on the strip");
  // Unhandled Board requests, such as Memos, stay counted on the Projects tab whichever tab is open.
  assert.ok(!b.ids.includes("projects-pending"));
  b.view.requests = [{ body: "[Board memo] project=maple-workshop: fictional note" }, { body: "[Board memo] project=(firstmate picks): another" }];
  b.redraw();
  assert.equal(b.text("projects-pending"), "2 pending");
  // Picking a tab shows it and is remembered; clicking it again folds the group, keeping the count.
  b.click("bottom-tab-projects");
  assert.ok(b.ids.includes("project-list") && !b.ids.includes("ask-memo"));
  assert.equal(store.getItem("bottomTab"), "projects");
  b.click("bottom-tab-projects");
  assert.ok(!b.ids.includes("project-list"));
  assert.equal(b.text("projects-pending"), "2 pending");
  b.click("bottom-tab-checks");
  assert.ok(b.ids.includes("checks-section"), "picking another tab unfolds the group");
  const again = await board({ store });
  assert.ok(again.ids.includes("checks-section"), "a new Board copy opens the remembered tab");
});

test("the NEXT MOVE card line brings its card into view and rings it in the held color, apart from the hover accent", async () => {
  const theme = { accent: "#1f62d0", blocked: "#c93c2c", border: "#dddddd" };
  const b = await board({ theme, store: memoryStore(), ui: { viewMode: "chains" } });
  b.view.folded.add("card:maple-icon-set");
  b.view.collapsed.add("held");
  b.redraw();
  b.click("next-move-card");
  assert.equal(b.view.viewMode, "kanban", "the Held card lives on Kanban");
  const ring = (id) => {
    const calls = b.items.find((x) => x.id === id).calls;
    return { color: calls.findLast((c) => c[0] === "border_color")[1], width: calls.findLast((c) => c[0] === "border")[1] };
  };
  // The pointed card wears the NEXT MOVE band's held color, not the accent hover and selection use.
  assert.deepEqual(ring("card-maple-icon-set"), { color: theme.blocked, width: 2 });
  b.hover("card-maple-theme-tokens");
  assert.deepEqual(ring("card-maple-theme-tokens"), { color: theme.accent, width: 1 }, "hovering a chain card keeps the accent");
  assert.equal(ring("card-maple-icon-set").color, theme.blocked);
  b.hover("card-maple-theme-tokens", false);
  assert.ok(b.ids.includes("age-maple-icon-set") || b.ids.includes("tag-maple-icon-set"), "the folded card and column show open");
  assert.ok(b.scrollsOn("list-held").length > 0, "the Held list scrolls to it");
  assert.ok(b.focusedOn("root"));
  // The ring clears by itself after a few seconds; an older timer leaves a newer point alone.
  const first = b.timers.at(-1);
  assert.equal(first.ms, 4000);
  b.click("next-move-card");
  first.fn({ notify() {} });
  assert.equal(b.redraw() && ring("card-maple-icon-set").color, theme.blocked);
  b.timers.at(-1).fn({ notify() {} });
  b.redraw();
  assert.deepEqual(ring("card-maple-icon-set"), { color: theme.border, width: 1 });
  // Escape clears it sooner.
  b.click("next-move-card");
  b.keyDown("root", "escape");
  assert.deepEqual(ring("card-maple-icon-set"), { color: theme.border, width: 1 });
});

test("Parked has its own status color, apart from Held, Blocked, Working, and Review", async () => {
  const theme = { idle: "#111111", working: "#222222", blocked: "#333333", done: "#444444", ansi1: "#555555", ansi5: "#7a45c8", unknown: "#666666" };
  const b = await board({ theme });
  const headRule = (col) => b.items.find((x) => x.id === `head-${col}`).calls.findLast((c) => c[0] === "border_color")[1];
  const bar = (id) => b.items.find((x) => x.id === `bar-${id}`).calls.find((c) => c[0] === "bg")[1];
  assert.equal(b.view.cards.find((c) => c.id === "orchard-nav-style").column, "parked");
  assert.equal(headRule("parked"), theme.ansi5);
  assert.equal(bar("orchard-nav-style"), theme.ansi5);
  // Held keeps the "needs the captain" color.
  assert.equal(headRule("held"), theme.blocked);
  assert.equal(bar("maple-icon-set"), theme.blocked);
  for (const col of ["held", "working", "review"].filter((c) => b.ids.includes(`head-${c}`))) {
    assert.notEqual(headRule(col), theme.ansi5, `${col} differs from Parked`);
  }
});

test("a Held topic box wears a hairline, not the accent that marks hover, selection, and the search match", async () => {
  const theme = { accent: "#1f62d0", border: "#dddddd" };
  const b = await board({ theme });
  const outline = b.items.find((x) => x.id === "group-preview-style").calls.findLast((c) => c[0] === "border_color")[1];
  assert.equal(outline, theme.border);
});

test("the strip's status group sits at its right end, and a card's state row wraps instead of cutting a date off", async () => {
  const b = await board();
  // The update time's row is pushed to the end of the strip, away from the tabs.
  const status = b.items.find((x) => x.id === "board-status");
  assert.ok(status.childIds.includes("refresh"));
  assert.ok(status.calls.some((c) => c[0] === "justify_end"), "status group is right-aligned");
  assert.ok(!status.calls.some((c) => c[0] === "justify_between"));
  const stateRow = b.items.find((x) => x.id === "state-orchard-tile-refresh");
  assert.ok(stateRow.childIds.includes("until-orchard-tile-refresh"));
  assert.ok(stateRow.calls.some((c) => c[0] === "flex_wrap"), "the deferral date wraps to its own line in a narrow column");
});

test("preview props open Focus on a card or point at one, for screenshots without key presses", async () => {
  const theme = { accent: "#1f62d0", blocked: "#c93c2c" };
  const focus = await board({ theme, ui: { focus: "maple-tour-sketch" } });
  assert.equal(focus.view.focusMode, true);
  assert.ok(focus.ids.includes("focus-hint"));
  const point = await board({ theme, ui: { point: "maple-tour-sketch" } });
  assert.equal(point.view.pointedId, "maple-tour-sketch");
  const ring = point.items.find((x) => x.id === "card-maple-tour-sketch").calls.findLast((c) => c[0] === "border_color")[1];
  assert.equal(ring, theme.blocked);
});
