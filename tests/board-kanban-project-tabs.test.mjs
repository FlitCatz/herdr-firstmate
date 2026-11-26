// Behavioral tests for Kanban project focus tab strip in fm-board.
// Run with: node --test tests/board-kanban-project-tabs.test.mjs
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

function memoryStore(initial = {}) {
  const data = new Map(Object.entries(initial));
  return {
    data,
    getItem: (k) => (data.has(k) ? data.get(k) : undefined),
    setItem: (k, v) => { data.set(k, String(v)); },
  };
}

async function mountBoard({ projects = ["maple-workshop", "orchard-atlas"], store = memoryStore(), snapshot = null, ui = {} } = {}) {
  const source = (await readFile(new URL("mods/fm-board/main.js", root), "utf8"))
    .replace(/^import .*;$/gm, "").replace("export default class FmBoard", "class FmBoard");
  const pending = [];
  const focused = [];
  const timers = [];
  const scrolled = [];
  const cx = {
    notify() {},
    stop_propagation() {},
    spawn(fn) { pending.push(fn(cx)); },
    timer: { every() {}, after(ms, fn) { timers.push({ ms, fn }); } },
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
    ScrollHandle: {
      new: () => {
        const handle = { scroll_to_item(idx) { scrolled.push({ handle, idx }); } };
        return handle;
      },
    },
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
    localStorage: store,
    readTextFile: async (file) => {
      if (file === snapshotFile) return JSON.stringify(snapshot ?? baseSnapshot);
      if (file === `${HOME}/data/projects.md`) {
        return projects.map((name) => `- ${name} - Fictional project.\n`).join("");
      }
      throw new Error(`no such file: ${file}`);
    },
    exec: async () => ({ code: 1, stdout: "", stderr: "" }),
    watchFolder: () => new Promise(() => {}),
    pickFolder: async () => null,
  };
  const { FmBoard } = vm.runInNewContext(`${source}\n({ FmBoard })`, scope);
  const view = new FmBoard();
  view.init({}, cx);
  await Promise.all(pending);
  assert.equal(view.error, null);
  let tree = view.render(cx);
  let items = drawn(tree);
  const redraw = () => {
    tree = view.render(cx);
    items = drawn(tree);
    return items;
  };
  const click = (id, event = {}) => {
    const item = items.find((x) => x.id === id);
    assert.ok(item?.click, `nothing to click at ${id}`);
    item.click(event, cx);
    return redraw();
  };
  const reload = async (nextSnapshot = null) => {
    if (nextSnapshot) snapshot = nextSnapshot;
    view.last = 0;
    view.refresh(cx);
    await Promise.all(pending);
    return redraw();
  };
  return {
    view, store, cx, redraw, click, reload, timers, scrolled,
    get items() { return items; },
    get ids() { return items.map((x) => x.id); },
    item: (id) => items.find((x) => x.id === id),
    text: (id) => items.find((x) => x.id === id)?.text,
    drawnCards: () => items.filter((x) => x.id.startsWith("card-")).map((x) => x.id.slice(5)),
    tabIds: () => items.find((x) => x.id === "kanban-project-tabs")?.childIds ?? [],
  };
}

test("Kanban defaults to All and lists All first followed by projects with Kanban cards and counts", async () => {
  const b = await mountBoard({ projects: ["maple-workshop", "orchard-atlas", "cedar-empty"] });
  assert.ok(b.ids.includes("kanban-project-tabs"), "Kanban renders a project tab strip");
  assert.deepEqual(b.tabIds(), [
    "kanban-project-tab-all",
    "kanban-project-tab-maple-workshop",
    "kanban-project-tab-orchard-atlas",
  ], "All comes first, followed by projects with Kanban cards; zero-card unselected/unhidden cedar-empty is omitted");
  assert.equal(b.text("kanban-project-tab-all"), "All 20");
  assert.equal(b.text("kanban-project-tab-maple-workshop"), "MAW 12");
  assert.equal(b.text("kanban-project-tab-orchard-atlas"), "ORA 8");

  // Default All draws cards from both projects and emits no spurious scroll_to_item calls.
  const cards = b.drawnCards();
  assert.ok(cards.includes("maple-preview-screen"));
  assert.ok(cards.includes("orchard-nav-style"));
  assert.deepEqual(b.scrolled, []);
});

test("selecting a project tab shows only that project's cards without zeroing other tab counts, and All returns to multi-project view", async () => {
  const b = await mountBoard();
  const mapleCards = b.view.cards.filter((c) => c.project === "maple-workshop").map((c) => c.id);
  const orchardCards = b.view.cards.filter((c) => c.project === "orchard-atlas").map((c) => c.id);

  b.click("kanban-project-tab-maple-workshop");
  const afterMaple = b.drawnCards();
  assert.equal(afterMaple.length, mapleCards.length);
  for (const id of mapleCards) assert.ok(afterMaple.includes(id), `maple card ${id} is drawn`);
  for (const id of orchardCards) assert.ok(!afterMaple.includes(id), `orchard card ${id} is excluded`);

  // Tab counts stay derived from the pre-filter Kanban card set.
  assert.equal(b.text("kanban-project-tab-all"), "All 20");
  assert.equal(b.text("kanban-project-tab-maple-workshop"), "MAW 12");
  assert.equal(b.text("kanban-project-tab-orchard-atlas"), "ORA 8");

  // Switch to orchard-atlas.
  b.click("kanban-project-tab-orchard-atlas");
  const afterOrchard = b.drawnCards();
  assert.equal(afterOrchard.length, orchardCards.length);
  for (const id of orchardCards) assert.ok(afterOrchard.includes(id), `orchard card ${id} is drawn`);
  for (const id of mapleCards) assert.ok(!afterOrchard.includes(id), `maple card ${id} is excluded`);
  assert.equal(b.text("kanban-project-tab-maple-workshop"), "MAW 12");

  // Return to All.
  b.click("kanban-project-tab-all");
  const backToAll = b.drawnCards();
  assert.equal(backToAll.length, mapleCards.length + orchardCards.length);
  assert.ok(backToAll.includes("maple-preview-screen"));
  assert.ok(backToAll.includes("orchard-nav-style"));
});

test("a selected or hidden project keeps its tab even at zero Kanban cards so the user can change it back", async () => {
  // Selected project with 0 Kanban cards (persisted from earlier session).
  const storeSelected = memoryStore({ kanbanProjectTab: "cedar-empty" });
  const b1 = await mountBoard({
    projects: ["maple-workshop", "orchard-atlas", "cedar-empty"],
    store: storeSelected,
  });
  assert.deepEqual(b1.tabIds(), [
    "kanban-project-tab-all",
    "kanban-project-tab-cedar-empty",
    "kanban-project-tab-maple-workshop",
    "kanban-project-tab-orchard-atlas",
  ]);
  assert.equal(b1.text("kanban-project-tab-cedar-empty"), "CEE 0");
  assert.deepEqual(b1.drawnCards(), [], "selected zero-card project shows empty Kanban columns");

  // Switching back to All drops the zero-card non-hidden project tab cleanly.
  b1.click("kanban-project-tab-all");
  assert.deepEqual(b1.tabIds(), [
    "kanban-project-tab-all",
    "kanban-project-tab-maple-workshop",
    "kanban-project-tab-orchard-atlas",
  ]);
  assert.ok(b1.drawnCards().includes("maple-preview-screen"));

  // A selected project whose cards disappear on reload keeps its tab at count 0.
  b1.click("kanban-project-tab-orchard-atlas");
  assert.equal(b1.text("kanban-project-tab-orchard-atlas"), "ORA 8");
  const mapleOnlySnapshot = structuredClone(baseSnapshot);
  mapleOnlySnapshot.backlog.records = mapleOnlySnapshot.backlog.records.filter((r) => r.repo !== "orchard-atlas");
  mapleOnlySnapshot.tasks = mapleOnlySnapshot.tasks.filter((t) => !String(t.project ?? "").includes("orchard-atlas"));
  await b1.reload(mapleOnlySnapshot);
  assert.ok(b1.tabIds().includes("kanban-project-tab-orchard-atlas"), "selected project tab stays after its cards drop to 0");
  assert.equal(b1.text("kanban-project-tab-orchard-atlas"), "ORA 0");
  assert.deepEqual(b1.drawnCards(), []);

  // A hidden project with 0 Kanban cards (both registered and card-only) stays in the tab strip until unhidden.
  const b2 = await mountBoard({
    projects: ["maple-workshop", "orchard-atlas", "cedar-empty"],
    store: memoryStore({ hiddenProjects: JSON.stringify(["cedar-empty", "ghost-repo"]) }),
    ui: { projectMenu: true },
  });
  assert.deepEqual(b2.tabIds(), [
    "kanban-project-tab-all",
    "kanban-project-tab-cedar-empty",
    "kanban-project-tab-ghost-repo",
    "kanban-project-tab-maple-workshop",
    "kanban-project-tab-orchard-atlas",
  ]);
  assert.equal(b2.text("kanban-project-tab-cedar-empty"), "CEE 0");
  assert.equal(b2.text("kanban-project-tab-ghost-repo"), "GHR 0");
  assert.equal(b2.text("kanban-project-state-ghost-repo"), "Invisible");

  // Show All clears hiddenProjects and removes the zero-card projects from the tab strip.
  b2.click("kanban-show-all");
  assert.deepEqual(b2.tabIds(), [
    "kanban-project-tab-all",
    "kanban-project-tab-maple-workshop",
    "kanban-project-tab-orchard-atlas",
  ]);
});

test("untagged cards remain visible under All, count in All, create no project tab, and do not appear on single-project tabs", async () => {
  const customSnapshot = structuredClone(baseSnapshot);
  customSnapshot.backlog.records.push(
    { ...customSnapshot.backlog.records[4], id: "untagged-dash", title: "Untagged dash task", repo: "-", order: 98 },
    { ...customSnapshot.backlog.records[4], id: "untagged-null", title: "Untagged null task", repo: null, order: 99 },
  );
  const b = await mountBoard({
    snapshot: customSnapshot,
    store: memoryStore({ hiddenProjects: JSON.stringify(["maple-workshop", "orchard-atlas"]) }),
  });

  // Untagged cards create no tab of their own, are counted in All, and stay visible under All even when all projects are hidden.
  assert.deepEqual(b.tabIds(), [
    "kanban-project-tab-all",
    "kanban-project-tab-maple-workshop",
    "kanban-project-tab-orchard-atlas",
  ]);
  assert.equal(b.text("kanban-project-tab-all"), "All 22");
  assert.equal(b.text("kanban-project-tab-maple-workshop"), "MAW 12");
  assert.equal(b.text("kanban-project-tab-orchard-atlas"), "ORA 8");
  assert.deepEqual(b.drawnCards().sort(), ["untagged-dash", "untagged-null"]);

  // Selecting a project tab excludes untagged cards; returning to All shows them again.
  b.click("kanban-project-tab-maple-workshop");
  assert.ok(!b.drawnCards().includes("untagged-dash"));
  assert.ok(!b.drawnCards().includes("untagged-null"));
  assert.ok(b.drawnCards().includes("maple-preview-screen"));

  b.click("kanban-project-tab-all");
  assert.deepEqual(b.drawnCards().sort(), ["untagged-dash", "untagged-null"]);
});

test("per-project Visible/Invisible filtering is secondary and applied only to All without resetting hide preferences", async () => {
  const store = memoryStore();
  const b = await mountBoard({ store, ui: { projectMenu: true } });

  // Hide maple-workshop under All.
  b.click("kanban-project-row-maple-workshop");
  assert.ok(!b.drawnCards().includes("maple-preview-screen"), "maple-workshop is hidden under All");
  assert.ok(b.drawnCards().includes("orchard-nav-style"), "orchard-atlas remains visible under All");
  assert.ok(b.ids.includes("kanban-hidden-bar"), "hidden indicator appears under All");
  assert.equal(b.text("kanban-project-tab-maple-workshop"), "MAW 12", "hiding does not zero the tab count");
  assert.equal(b.text("kanban-project-tab-all"), "All 20", "hiding does not change All count");

  // Focusing the hidden project's tab shows ONLY its cards and hides the All-only hidden bar,
  // while preserving hiddenProjects in storage.
  b.click("kanban-project-tab-maple-workshop");
  assert.ok(b.drawnCards().includes("maple-preview-screen"), "clicking a hidden project's tab shows its cards");
  assert.ok(!b.drawnCards().includes("orchard-nav-style"));
  assert.ok(!b.ids.includes("kanban-hidden-bar"), "hidden-projects bar is limited to All");
  assert.deepEqual(JSON.parse(store.getItem("hiddenProjects")), ["maple-workshop"], "tab selection never resets hiddenProjects");

  // Returning to All restores multi-project view WITH saved hide preferences still applied.
  b.click("kanban-project-tab-all");
  assert.ok(!b.drawnCards().includes("maple-preview-screen"), "maple-workshop stays hidden on return to All");
  assert.ok(b.drawnCards().includes("orchard-nav-style"));
  assert.ok(b.ids.includes("kanban-hidden-bar"), "hidden indicator returns under All");
  assert.equal(b.text("kanban-show-all"), "Show All");

  // Existing Show All action still clears hiddenProjects under All.
  b.click("kanban-show-all");
  assert.ok(b.drawnCards().includes("maple-preview-screen"));
  assert.ok(!b.ids.includes("kanban-hidden-bar"));
  assert.deepEqual(JSON.parse(store.getItem("hiddenProjects")), []);
});

test("selected project tab persists across Board reloads, fresh mounts (restarts), and handles malformed storage safely", async () => {
  const store = memoryStore();
  const first = await mountBoard({ store });

  first.click("kanban-project-tab-orchard-atlas");
  assert.equal(store.getItem("kanbanProjectTab"), "orchard-atlas");
  assert.ok(first.drawnCards().includes("orchard-nav-style"));
  assert.ok(!first.drawnCards().includes("maple-preview-screen"));

  // Retained across in-place Board reload.
  await first.reload();
  assert.equal(first.view.kanbanProjectTab, "orchard-atlas");
  assert.ok(first.drawnCards().includes("orchard-nav-style"));
  assert.ok(!first.drawnCards().includes("maple-preview-screen"));

  // Retained across a fresh Board mount sharing storage (Herdr restart).
  const restarted = await mountBoard({ store });
  assert.equal(restarted.view.kanbanProjectTab, "orchard-atlas");
  assert.ok(restarted.drawnCards().includes("orchard-nav-style"));
  assert.ok(!restarted.drawnCards().includes("maple-preview-screen"));
  assert.deepEqual(
    restarted.scrolled.filter((s) => s.handle === restarted.view.projectTabsScroll).map((s) => s.idx),
    [2],
    "restored selected project tab scrolls into view",
  );

  // Returning to All persists empty value so next restart opens on All.
  restarted.click("kanban-project-tab-all");
  assert.equal(store.getItem("kanbanProjectTab"), "");
  const backOnAll = await mountBoard({ store });
  assert.equal(backOnAll.view.kanbanProjectTab, null);
  assert.ok(backOnAll.drawnCards().includes("maple-preview-screen"));
  assert.ok(backOnAll.drawnCards().includes("orchard-nav-style"));

  // Path-like or invalid stored values normalize or fall back cleanly to All.
  const normalized = await mountBoard({ store: memoryStore({ kanbanProjectTab: " /path/to/maple-workshop " }) });
  assert.equal(normalized.view.kanbanProjectTab, "maple-workshop");
  assert.ok(normalized.drawnCards().includes("maple-preview-screen"));
  assert.ok(!normalized.drawnCards().includes("orchard-nav-style"));

  for (const bad of ["", "   ", "-", "/"]) {
    const safe = await mountBoard({ store: memoryStore({ kanbanProjectTab: bad }) });
    assert.equal(safe.view.kanbanProjectTab, null, `value ${JSON.stringify(bad)} falls back to All`);
  }
});

test("overflowing project tabs stay on a single horizontally scrollable strip and scroll active tabs into view", async () => {
  const manyNames = [
    "alpha-one", "bravo-two", "charlie-three", "delta-four", "echo-five", "foxtrot-six",
    "golf-seven", "hotel-eight", "india-nine", "juliet-ten", "kilo-eleven", "lima-twelve",
  ];
  const customSnapshot = structuredClone(baseSnapshot);
  customSnapshot.backlog.records = manyNames.map((repo, i) => ({
    ...baseSnapshot.backlog.records[4],
    id: `${repo}-task`,
    title: `Task for ${repo}`,
    repo,
    order: i + 1,
  }));
  customSnapshot.tasks = [];

  const b = await mountBoard({ projects: manyNames, snapshot: customSnapshot });
  const strip = b.item("kanban-project-tabs");
  assert.ok(strip, "project tab strip renders");
  assert.ok(strip.calls.some((c) => c[0] === "overflow_x_scroll" || c[0] === "overflow_x_scrollbar"),
    "tab strip scrolls horizontally");
  assert.ok(strip.calls.some((c) => c[0] === "track_scroll" && c[1] === b.view.projectTabsScroll),
    "tab strip tracks its ScrollHandle");
  assert.ok(!strip.calls.some((c) => c[0] === "flex_wrap"), "tab strip does not wrap onto multiple rows");
  assert.equal(b.tabIds().length, manyNames.length + 1, "All plus every project with Kanban cards");

  for (const tabId of b.tabIds()) {
    const tab = b.item(tabId);
    assert.ok(tab.calls.some((c) => c[0] === "flex_none"), `tab ${tabId} stays non-shrinking for horizontal scroll`);
  }

  // Clicking a far-right overflowing tab scrolls it into view on projectTabsScroll.
  b.scrolled.length = 0;
  b.click("kanban-project-tab-lima-twelve");
  assert.deepEqual(
    b.scrolled.filter((s) => s.handle === b.view.projectTabsScroll).map((s) => s.idx),
    [12],
  );
  assert.deepEqual(b.drawnCards(), ["lima-twelve-task"]);

  // Clicking All scrolls back to index 0.
  b.scrolled.length = 0;
  b.click("kanban-project-tab-all");
  assert.deepEqual(
    b.scrolled.filter((s) => s.handle === b.view.projectTabsScroll).map((s) => s.idx),
    [0],
  );
});

test("Dependency Inspector and NEXT MOVE temporarily reveal out-of-tab cards without changing selected project tab", async () => {
  // Fixture chain: maple-theme-tokens (maple-workshop) blocks orchard-theme-sync (orchard-atlas).
  const store = memoryStore({ kanbanProjectTab: "orchard-atlas" });
  const b = await mountBoard({ store });
  assert.ok(!b.drawnCards().includes("maple-theme-tokens"), "maple-theme-tokens is excluded under orchard-atlas tab");
  assert.ok(b.drawnCards().includes("orchard-theme-sync"));

  // Opening the Inspector reveals nothing and emits no card scroll.
  b.scrolled.length = 0;
  b.click("dep-inspector-toggle");
  assert.ok(b.view.inspectorOpen);
  assert.ok(b.ids.includes("dep-node-maple-theme-tokens"));
  assert.ok(!b.drawnCards().includes("maple-theme-tokens"), "opening Inspector does not reveal out-of-tab card");
  assert.deepEqual(b.scrolled, []);

  // Clicking an out-of-tab Inspector node temporarily reveals ONLY that card, rings it, and preserves kanbanProjectTab.
  b.click("dep-node-maple-theme-tokens");
  assert.equal(b.view.selectedCardId, "maple-theme-tokens");
  assert.ok(b.drawnCards().includes("maple-theme-tokens"), "clicked out-of-tab card is temporarily revealed");
  assert.ok(!b.drawnCards().includes("maple-preview-screen"), "other cards of that project stay excluded");
  assert.equal(b.text("hl-maple-theme-tokens"), "Selected");
  assert.equal(b.view.kanbanProjectTab, "orchard-atlas");
  assert.equal(store.getItem("kanbanProjectTab"), "orchard-atlas");

  // Once the ring timer expires, the out-of-tab card hides again.
  const ring = b.timers.findLast((x) => x.ms === 4000);
  assert.ok(ring);
  ring.fn(b.cx);
  b.redraw();
  assert.ok(!b.drawnCards().includes("maple-theme-tokens"), "revealed card hides again when ring expires");
  assert.equal(b.view.kanbanProjectTab, "orchard-atlas");

  // NEXT MOVE card click also temporarily reveals its out-of-tab card without altering kanbanProjectTab.
  b.click("next-move-card");
  assert.ok(b.drawnCards().includes("maple-icon-set"), "NEXT MOVE temporarily reveals maple-icon-set");
  assert.equal(store.getItem("kanbanProjectTab"), "orchard-atlas");
  b.view.pointedId = null;
  b.redraw();
  assert.ok(!b.drawnCards().includes("maple-icon-set"));
});

test("selecting a Kanban project tab leaves Today strip, NEXT MOVE, Chains, bottom tabs, and backlog data untouched", async () => {
  const snapshotCopy = structuredClone(baseSnapshot);
  const beforeJson = JSON.stringify(snapshotCopy);
  const store = memoryStore();
  const b = await mountBoard({ store, snapshot: snapshotCopy });

  const baselineToday = {
    done: b.text("today-done"),
    waiting: b.text("today-waiting"),
    working: b.text("today-working"),
    ready: b.text("today-ready"),
    blocked: b.text("today-blocked"),
  };
  const baselineNextMove = b.text("next-move");

  // Focus orchard-atlas in Kanban.
  b.click("kanban-project-tab-orchard-atlas");
  assert.ok(!b.drawnCards().includes("maple-preview-screen"));

  // Today strip and NEXT MOVE remain identical.
  assert.deepEqual({
    done: b.text("today-done"),
    waiting: b.text("today-waiting"),
    working: b.text("today-working"),
    ready: b.text("today-ready"),
    blocked: b.text("today-blocked"),
  }, baselineToday);
  assert.equal(b.text("next-move"), baselineNextMove);

  // Switching to Chains omits the Kanban project tab strip and keeps all Chains + Independent cards unfiltered.
  b.click("view-mode-chains");
  assert.ok(!b.ids.includes("kanban-project-tabs"), "Chains omits Kanban project tab strip");
  const chainNodes = b.ids.filter((id) => id.startsWith("chain-node-")).map((id) => id.slice("chain-node-".length));
  assert.ok(chainNodes.some((id) => id.startsWith("maple-")), "Chains still draws maple-workshop nodes");
  b.click("head-independent");
  assert.ok(b.drawnCards().includes("maple-preview-screen"), "Chains Independent drawer stays unfiltered");

  // Switching back to Kanban restores the orchard-atlas project tab.
  b.click("view-mode-kanban");
  assert.ok(b.ids.includes("kanban-project-tabs"));
  assert.ok(!b.drawnCards().includes("maple-preview-screen"));
  assert.ok(b.drawnCards().includes("orchard-nav-style"));

  // Bottom tabs (Projects, Commands) stay unaffected.
  b.click("bottom-tab-projects");
  assert.ok(b.ids.includes("project-maple-workshop"));
  assert.ok(b.ids.includes("project-orchard-atlas"));
  b.click("bottom-tab-commands");
  assert.ok(b.ids.includes("ask-maple-workshop"));
  assert.ok(b.ids.includes("ask-orchard-atlas"));

  // Backlog snapshot data was never mutated.
  assert.equal(JSON.stringify(snapshotCopy), beforeJson);
});

test("tab counts and membership follow each tab's own Done cap once Done holds more than 20 cards", async () => {
  // Each tab shows its non-Done cards plus at most 20 Done cards (DONE_LIMIT), capped within
  // that tab: All caps across every project, a project tab caps only its own Done cards.
  const doneTemplate = baseSnapshot.backlog.records.find((r) => r.id === "orchard-seed-data");
  const customSnapshot = structuredClone(baseSnapshot);
  const addDone = (repo, n) => {
    for (let i = 0; i < n; i += 1) {
      const order = 100 + customSnapshot.backlog.records.length;
      customSnapshot.backlog.records.push({ ...doneTemplate, id: `${repo}-done-${i}`, title: `Finished ${repo} ${i}`, repo, order });
    }
  };
  // Oldest first: spruce-ledger's 3 Done cards and the first 10 maple ones fall outside the
  // global last 20 Done cards, which are 15 maple and 5 orchard cards.
  addDone("spruce-ledger", 3);
  addDone("maple-workshop", 25);
  addDone("orchard-atlas", 5);
  const b = await mountBoard({ projects: ["maple-workshop", "orchard-atlas", "spruce-ledger"], snapshot: customSnapshot });

  // Fixture: maple-workshop has 12 open cards, orchard-atlas 7 open and 1 Done (orchard-seed-data).
  assert.deepEqual(b.tabIds(), [
    "kanban-project-tab-all",
    "kanban-project-tab-maple-workshop",
    "kanban-project-tab-orchard-atlas",
    "kanban-project-tab-spruce-ledger",
  ], "a project whose only Done cards fall outside the global cap still gets a tab");
  assert.equal(b.text("kanban-project-tab-all"), "All 39", "19 open + 20 of 34 Done");
  assert.equal(b.text("kanban-project-tab-maple-workshop"), "MAW 32", "12 open + 20 of 25 Done");
  assert.equal(b.text("kanban-project-tab-orchard-atlas"), "ORA 13", "7 open + all 6 Done");
  assert.equal(b.text("kanban-project-tab-spruce-ledger"), "SPL 3", "3 Done");

  // Every count equals what selecting that tab actually draws.
  assert.equal(b.drawnCards().length, 39);
  for (const [name, count] of [["maple-workshop", 32], ["orchard-atlas", 13], ["spruce-ledger", 3]]) {
    b.click(`kanban-project-tab-${name}`);
    assert.equal(b.drawnCards().length, count, `${name} tab draws ${count} cards`);
  }
  b.click("kanban-project-tab-all");
  assert.equal(b.drawnCards().length, 39);
});

test("Show on board in Kanban selects and remembers that project's tab instead of stacking a second filter", async () => {
  const store = memoryStore({ kanbanProjectTab: "maple-workshop", hiddenProjects: JSON.stringify(["orchard-atlas"]) });
  const b = await mountBoard({ projects: ["maple-workshop", "orchard-atlas", "cedar-empty"], store });
  assert.ok(!b.drawnCards().includes("orchard-nav-style"));

  // Show on board for a different project than the selected tab switches the tab to it.
  b.click("bottom-tab-projects");
  b.click("project-orchard-atlas");
  assert.equal(b.text("view-orchard-atlas"), "Show on board");
  b.click("view-orchard-atlas");
  assert.equal(b.view.kanbanProjectTab, "orchard-atlas");
  assert.equal(store.getItem("kanbanProjectTab"), "orchard-atlas");
  assert.ok(b.drawnCards().includes("orchard-nav-style"), "the project's cards are drawn, not an empty board");
  assert.ok(!b.drawnCards().includes("maple-preview-screen"));
  assert.ok(!b.ids.includes("filter-clear"), "no second project filter bar");
  assert.equal(b.text("view-orchard-atlas"), "Show all");

  // The choice survives a Board reload and a restart.
  await b.reload();
  assert.equal(b.view.kanbanProjectTab, "orchard-atlas");
  const restarted = await mountBoard({ projects: ["maple-workshop", "orchard-atlas", "cedar-empty"], store });
  assert.equal(restarted.view.kanbanProjectTab, "orchard-atlas");
  assert.ok(restarted.drawnCards().includes("orchard-nav-style"));

  // Show all returns to All, keeping saved Visible/Invisible choices.
  b.click("view-orchard-atlas");
  assert.equal(b.view.kanbanProjectTab, null);
  assert.equal(store.getItem("kanbanProjectTab"), "");
  assert.deepEqual(JSON.parse(store.getItem("hiddenProjects")), ["orchard-atlas"]);
  assert.ok(b.drawnCards().includes("maple-preview-screen"));
  assert.ok(!b.drawnCards().includes("orchard-nav-style"), "orchard-atlas stays hidden under All");
  assert.equal(b.text("view-orchard-atlas"), "Show on board");

  // A project with no Kanban cards gets a selected zero-count tab.
  b.click("project-cedar-empty");
  b.click("view-cedar-empty");
  assert.equal(b.view.kanbanProjectTab, "cedar-empty");
  assert.ok(b.tabIds().includes("kanban-project-tab-cedar-empty"));
  assert.equal(b.text("kanban-project-tab-cedar-empty"), "CEE 0");
  assert.deepEqual(b.drawnCards(), []);
});

test("Show on board in Chains keeps filtering Chains without changing the Kanban project tab", async () => {
  const store = memoryStore({ kanbanProjectTab: "maple-workshop" });
  const b = await mountBoard({ store });
  b.click("view-mode-chains");
  b.click("bottom-tab-projects");
  b.click("project-orchard-atlas");
  b.click("view-orchard-atlas");
  assert.equal(b.view.filter, "orchard-atlas");
  assert.ok(b.ids.includes("filter-clear"), "Chains shows its project filter bar");
  assert.equal(b.view.kanbanProjectTab, "maple-workshop");
  assert.equal(store.getItem("kanbanProjectTab"), "maple-workshop");
  b.click("head-independent");
  assert.ok(!b.drawnCards().includes("maple-preview-screen"), "Chains Independent drawer follows the Chains filter");
});
