// Behavioral tests for Kanban per-project Visible / Invisible filtering in fm-board.
// Run with: node --test tests/board-project-visibility.test.mjs
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

async function mountBoard({ projects = ["maple-workshop", "orchard-atlas"], store = memoryStore(), snapshot = null, ui = {}, theme: customTheme = null } = {}) {
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
  const theme = customTheme
    ? new Proxy(customTheme, { get: (target, k) => (k in target ? target[k] : "#808080") })
    : new Proxy({}, { get: () => "#808080" });
  const scope = {
    View: class {}, div: element, svg: element, v_flex: element, h_flex: element, Input: { new: element },
    h_resizable: element, resizable_panel: element,
    Popover: { new: (popId) => element().popover_id(popId) },
    InputState: { new: input },
    ScrollHandle: { new: () => ({ scroll_to_item(idx) { scrolled.push(idx); } }) },
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
  const findPopover = (popId) => {
    const walk = (node) => {
      if (!node || typeof node !== "object") return null;
      if (node.node.calls.some((c) => c[0] === "popover_id" && c[1] === popId)) return node.node;
      for (const k of node.node.kids) { const hit = walk(k); if (hit) return hit; }
      return null;
    };
    return walk(tree);
  };
  const reload = async () => {
    view.last = 0;
    view.refresh(cx);
    await Promise.all(pending);
    return redraw();
  };
  return {
    view, store, cx, redraw, click, reload, findPopover, timers, scrolled,
    get items() { return items; },
    get ids() { return items.map((x) => x.id); },
    text: (id) => items.find((x) => x.id === id)?.text,
    drawnCards: () => items.filter((x) => x.id.startsWith("card-")).map((x) => x.id.slice(5)),
  };
}

test("Kanban starts with all projects visible and renders a compact Projects visibility control", async () => {
  const b = await mountBoard();
  assert.ok(b.ids.includes("kanban-projects-toggle"), "Kanban toolbar renders the compact Projects trigger");
  assert.equal(b.text("kanban-projects-toggle").includes("Projects"), true);
  assert.ok(!b.ids.includes("kanban-hidden-bar"), "no hidden-project indicator when all projects are visible");
  assert.ok(!b.ids.includes("kanban-show-all"), "no Show All bar action when all projects are visible");

  // All fixture project cards render by default.
  const cards = b.drawnCards();
  assert.ok(cards.includes("maple-preview-screen"), "maple-workshop card is visible by default");
  assert.ok(cards.includes("orchard-nav-style"), "orchard-atlas card is visible by default");

  // Popover starts closed, opens on left-click trigger change, and lists every canonical project as Visible.
  const pop = b.findPopover("kanban-projects-pop");
  assert.ok(pop, "Projects trigger is wrapped in a controlled Popover");
  assert.ok(pop.calls.some((c) => c[0] === "mouse_button" && c[1] === "left"), "Popover opens on left-click");
  assert.ok(pop.calls.some((c) => c[0] === "open" && c[1] === false), "Popover starts closed");
  assert.ok(!b.ids.includes("kanban-projects-menu"), "menu content is hidden while closed");

  const onOpenChange = pop.calls.find((c) => c[0] === "on_open_change")?.[1];
  assert.equal(typeof onOpenChange, "function", "Popover wires on_open_change");
  onOpenChange(true, b.cx);
  b.redraw();

  assert.ok(b.ids.includes("kanban-projects-menu"), "opening the popover renders the Projects menu");
  assert.equal(b.text("kanban-project-state-maple-workshop"), "Visible");
  assert.equal(b.text("kanban-project-state-orchard-atlas"), "Visible");
  assert.ok(b.ids.includes("kanban-ptag-maple-workshop"), "row shows canonical maple-workshop tag badge");
  assert.ok(b.ids.includes("kanban-ptag-orchard-atlas"), "row shows canonical orchard-atlas tag badge");
});

test("marking a project Invisible hides its Kanban cards, shows a clear indicator, and toggling or Show All restores them", async () => {
  const b = await mountBoard({ ui: { projectMenu: true } });
  const initialMaple = b.view.cards.filter((c) => c.project === "maple-workshop").map((c) => c.id);
  const initialOrchard = b.view.cards.filter((c) => c.project === "orchard-atlas").map((c) => c.id);
  assert.ok(initialMaple.length > 0 && initialOrchard.length > 0, "fixture has cards for both projects");

  // Toggle maple-workshop to Invisible.
  b.click("kanban-project-row-maple-workshop");
  assert.equal(b.text("kanban-project-state-maple-workshop"), "Invisible");
  assert.equal(b.text("kanban-project-state-orchard-atlas"), "Visible");
  assert.ok(b.ids.includes("kanban-projects-menu"), "popover stays open so multiple projects can be toggled");

  const afterHide = b.drawnCards();
  for (const id of initialMaple) assert.ok(!afterHide.includes(id), `hidden maple-workshop card ${id} is removed from Kanban`);
  assert.ok(afterHide.includes("orchard-nav-style"), "visible orchard-atlas cards stay in Kanban");

  // Toolbar hidden-count badge and a single Show all control inside the popover appear (no standalone hidden row).
  assert.equal(b.text("kanban-projects-badge"), "1 hidden");
  assert.ok(!b.ids.includes("kanban-hidden-bar"), "no standalone hidden-projects row");
  assert.equal(b.text("kanban-show-all"), "Show all");

  // Toggle maple-workshop back to Visible from the menu row.
  b.click("kanban-project-row-maple-workshop");
  assert.equal(b.text("kanban-project-state-maple-workshop"), "Visible");
  assert.ok(b.drawnCards().includes("maple-preview-screen"), "maple-workshop cards return when marked Visible");
  assert.ok(!b.ids.includes("kanban-projects-badge"), "toolbar hidden badge clears when all projects are visible");
  assert.ok(!b.ids.includes("kanban-show-all"), "Show all hides when no project is hidden");

  // Hide both projects, then restore all in one step via Show all inside the popover.
  b.click("kanban-project-row-maple-workshop");
  b.click("kanban-project-row-orchard-atlas");
  assert.equal(b.text("kanban-projects-badge"), "2 hidden");
  assert.deepEqual(b.drawnCards(), [], "all tagged project cards are hidden");

  b.click("kanban-show-all");
  assert.ok(!b.ids.includes("kanban-hidden-bar"), "no standalone hidden row");
  assert.ok(!b.ids.includes("kanban-projects-badge"), "Show all clears the toolbar hidden badge");
  assert.ok(!b.ids.includes("kanban-show-all"), "Show all disappears once every project is visible");
  assert.equal(b.text("kanban-project-state-maple-workshop"), "Visible");
  assert.equal(b.text("kanban-project-state-orchard-atlas"), "Visible");
  assert.ok(b.drawnCards().includes("maple-preview-screen"));
  assert.ok(b.drawnCards().includes("orchard-nav-style"));

  // Exactly one Show all control exists when hidden, and card tags are not overloaded.
  b.click("kanban-project-row-maple-workshop");
  assert.equal(b.ids.filter((id) => b.text(id) === "Show all").length, 1, "exactly one Show all control");
  assert.equal(b.items.find((x) => x.id === "tag-maple-preview-screen")?.click ?? null, null, "card tag badge has no overloaded click handler");
});

test("project visibility persists across Board reloads, fresh Board mounts (restarts), and survives malformed storage", async () => {
  const store = memoryStore();
  const first = await mountBoard({ store, ui: { projectMenu: true } });

  first.click("kanban-project-row-maple-workshop");
  assert.deepEqual(JSON.parse(store.getItem("hiddenProjects")), ["maple-workshop"]);

  // Retained across an in-place Board reload (refresh).
  await first.reload();
  assert.ok(!first.drawnCards().includes("maple-preview-screen"), "maple-workshop remains hidden after Board reload");
  assert.ok(first.drawnCards().includes("orchard-nav-style"), "orchard-atlas remains visible after Board reload");
  assert.equal(first.text("kanban-projects-badge"), "1 hidden");
  assert.ok(!first.ids.includes("kanban-hidden-bar"), "no standalone hidden row");

  // Retained across a fresh Board instance sharing storage (Herdr restart).
  const restarted = await mountBoard({ store, ui: { projectMenu: true } });
  assert.ok(!restarted.drawnCards().includes("maple-preview-screen"), "maple-workshop remains hidden after restart");
  assert.ok(restarted.drawnCards().includes("orchard-nav-style"), "orchard-atlas remains visible after restart");
  assert.equal(restarted.text("kanban-projects-badge"), "1 hidden");
  assert.equal(restarted.text("kanban-project-state-maple-workshop"), "Invisible");
  assert.equal(restarted.text("kanban-show-all"), "Show all");

  // Show all inside the popover persists the cleared state so the next restart starts with all projects visible.
  restarted.click("kanban-show-all");
  assert.deepEqual(JSON.parse(store.getItem("hiddenProjects")), []);
  const afterShowAll = await mountBoard({ store });
  assert.ok(afterShowAll.drawnCards().includes("maple-preview-screen"));
  assert.ok(!afterShowAll.ids.includes("kanban-projects-badge"));

  // Corrupted or non-canonical storage entries fail safe without throwing.
  const corrupt = await mountBoard({ store: memoryStore({ hiddenProjects: "{not-json" }) });
  assert.ok(corrupt.drawnCards().includes("maple-preview-screen"));
  assert.ok(!corrupt.ids.includes("kanban-projects-badge"));

  const mixed = await mountBoard({
    store: memoryStore({ hiddenProjects: JSON.stringify(["/path/to/maple-workshop", "-", "", 42, null]) }),
  });
  assert.ok(!mixed.drawnCards().includes("maple-preview-screen"), "canonical repo tag normalized from stored path");
  assert.ok(mixed.drawnCards().includes("orchard-nav-style"));
  assert.equal(mixed.text("kanban-projects-badge"), "1 hidden");
});

test("cards without a project tag stay visible even when every tagged project (including firstmate) is Invisible", async () => {
  const customSnapshot = structuredClone(baseSnapshot);
  customSnapshot.backlog.records.push(
    {
      ...customSnapshot.backlog.records[4],
      id: "untagged-dash-task",
      title: "Untagged backlog maintenance",
      repo: "-",
      order: 98,
    },
    {
      ...customSnapshot.backlog.records[4],
      id: "untagged-null-task",
      title: "Untagged null-repo task",
      repo: null,
      order: 99,
    },
    {
      ...customSnapshot.backlog.records[4],
      id: "firstmate-tagged-task",
      title: "Explicit firstmate repository task",
      repo: "firstmate",
      order: 100,
    },
  );
  const b = await mountBoard({
    projects: ["firstmate", "maple-workshop", "orchard-atlas"],
    snapshot: customSnapshot,
    ui: { projectMenu: true },
  });

  // Hide every tagged project, including an explicit "firstmate" project.
  b.click("kanban-project-row-firstmate");
  b.click("kanban-project-row-maple-workshop");
  b.click("kanban-project-row-orchard-atlas");

  const visible = b.drawnCards();
  assert.ok(visible.includes("untagged-dash-task"), "repo: '-' card stays visible");
  assert.ok(visible.includes("untagged-null-task"), "repo: null card stays visible");
  assert.ok(!visible.includes("firstmate-tagged-task"), "explicitly tagged firstmate project card is hidden");
  assert.ok(!visible.includes("maple-preview-screen"), "maple-workshop cards are hidden");
  assert.ok(!visible.includes("orchard-nav-style"), "orchard-atlas cards are hidden");
});

test("Kanban project visibility does not alter Chains, Today strip, NEXT MOVE, Projects/Commands tabs, or backlog data", async () => {
  const snapshotCopy = structuredClone(baseSnapshot);
  const beforeJson = JSON.stringify(snapshotCopy);
  const store = memoryStore();

  const b = await mountBoard({ store, snapshot: snapshotCopy, ui: { projectMenu: true } });
  const baselineToday = {
    done: b.text("today-done"),
    waiting: b.text("today-waiting"),
    working: b.text("today-working"),
    ready: b.text("today-ready"),
    blocked: b.text("today-blocked"),
  };
  const baselineNextMove = b.text("next-move");

  // Hide maple-workshop in Kanban.
  b.click("kanban-project-row-maple-workshop");
  assert.ok(!b.drawnCards().includes("maple-icon-set"), "maple-icon-set is hidden in Kanban Held column");

  // Today strip and NEXT MOVE rules remain completely unchanged.
  assert.deepEqual({
    done: b.text("today-done"),
    waiting: b.text("today-waiting"),
    working: b.text("today-working"),
    ready: b.text("today-ready"),
    blocked: b.text("today-blocked"),
  }, baselineToday, "Today strip counts do not change when Kanban projects are hidden");
  assert.equal(b.text("next-move"), baselineNextMove, "NEXT MOVE hold selection and copy remain unchanged");

  // Clicking NEXT MOVE temporarily points at the card without mutating persisted hiddenProjects.
  b.click("kanban-project-row-orchard-atlas");
  b.click("next-move-card");
  assert.ok(b.drawnCards().includes("orchard-nav-style"), "NEXT MOVE click still reveals its pointed card");
  assert.deepEqual(JSON.parse(store.getItem("hiddenProjects")), ["maple-workshop", "orchard-atlas"], "persisted hiddenProjects stays unchanged");
  b.view.pointedId = null;
  b.redraw();
  assert.ok(!b.drawnCards().includes("orchard-nav-style"), "card hides again once NEXT MOVE ring clears");
  b.click("kanban-project-row-orchard-atlas");

  // Switching to Chains shows no Kanban visibility controls and leaves Chains + Independent unfiltered.
  b.click("view-mode-chains");
  assert.ok(!b.ids.includes("kanban-projects-toggle"), "Chains view omits Kanban Projects control");
  assert.ok(!b.ids.includes("kanban-projects-menu"), "switching to Chains closes the Projects popover");
  assert.ok(!b.ids.includes("kanban-hidden-bar"), "Chains view omits Kanban hidden-project indicator");
  const chainNodes = b.ids.filter((id) => id.startsWith("chain-node-")).map((id) => id.slice("chain-node-".length));
  assert.ok(chainNodes.some((id) => id.startsWith("maple-")), "Chains view still draws maple-workshop chain nodes");
  b.click("head-independent");
  assert.ok(b.drawnCards().includes("maple-preview-screen"), "Chains Independent drawer still draws maple-workshop cards");

  // Switching back to Kanban restores the hidden filter and toolbar badge.
  b.click("view-mode-kanban");
  assert.ok(!b.drawnCards().includes("maple-preview-screen"));
  assert.equal(b.text("kanban-projects-badge"), "1 hidden");
  assert.ok(!b.ids.includes("kanban-hidden-bar"));

  // Projects and Commands bottom tabs still include maple-workshop untouched.
  b.click("bottom-tab-projects");
  assert.ok(b.ids.includes("project-maple-workshop"), "Projects tab still lists hidden project");
  b.click("bottom-tab-commands");
  assert.ok(b.ids.includes("ask-maple-workshop"), "Commands tab still lists hidden project chip");

  // Backlog snapshot data was never mutated.
  assert.equal(JSON.stringify(snapshotCopy), beforeJson, "backlog snapshot data is untouched");
});

test("many hidden projects report count on the Projects button and Show all + Escape work in the popover", async () => {
  const manyProjects = ["alpha-one", "bravo-two", "charlie-three", "delta-four", "echo-five", "foxtrot-six", "golf-seven"];
  const store = memoryStore({ hiddenProjects: JSON.stringify(manyProjects) });
  const b = await mountBoard({ projects: manyProjects, store, ui: { projectMenu: true } });

  assert.equal(b.text("kanban-projects-badge"), "7 hidden");
  assert.ok(!b.ids.includes("kanban-hidden-bar"), "no standalone hidden-projects row");
  assert.equal(b.text("kanban-show-all"), "Show all");
  assert.equal(b.text("kanban-project-state-alpha-one"), "Invisible");
  assert.equal(b.text("kanban-project-state-golf-seven"), "Invisible");

  // The popover's Show all clears all 7 in one step.
  b.click("kanban-show-all");
  assert.ok(!b.ids.includes("kanban-projects-badge"));
  assert.ok(!b.ids.includes("kanban-show-all"));
  assert.equal(b.text("kanban-project-state-alpha-one"), "Visible");
  assert.deepEqual(JSON.parse(store.getItem("hiddenProjects")), []);

  // Pressing Escape inside the open menu closes it.
  const menu = b.items.find((x) => x.id === "kanban-projects-menu");
  assert.ok(menu?.keyDown, "menu handles Escape key");
  menu.keyDown({ key: "escape", modifiers: {} }, b.cx);
  b.redraw();
  assert.ok(!b.ids.includes("kanban-projects-menu"), "Escape closes the Projects menu");
});



test("an explicit Inspector click shows a card of an Invisible project only while it is pointed at; opening the Inspector shows nothing", async () => {
  // Fixture chain: maple-theme-tokens (maple-workshop) blocks orchard-theme-sync (orchard-atlas).
  const store = memoryStore({ hiddenProjects: JSON.stringify(["maple-workshop"]) });
  const b = await mountBoard({ store });
  const hiddenMaple = b.view.cards.filter((c) => c.project === "maple-workshop").map((c) => c.id);
  assert.ok(!b.drawnCards().some((id) => hiddenMaple.includes(id)), "maple-workshop starts hidden");
  assert.ok(b.drawnCards().includes("orchard-theme-sync"));

  // Opening the Inspector auto-selects a chain root but reveals no hidden card.
  b.click("dep-inspector-toggle");
  assert.ok(b.view.inspectorOpen);
  assert.ok(b.ids.includes("dep-node-maple-theme-tokens"), "Inspector lists the hidden project's node");
  assert.ok(!b.drawnCards().some((id) => hiddenMaple.includes(id)), "opening the Inspector reveals nothing");
  assert.deepEqual(b.scrolled, [], "opening the Inspector scrolls nowhere");

  // An explicit node click draws only that card, rings it, and scrolls to it.
  b.click("dep-node-maple-theme-tokens");
  assert.equal(b.view.selectedCardId, "maple-theme-tokens");
  const shown = b.drawnCards().filter((id) => hiddenMaple.includes(id));
  assert.deepEqual(shown, ["maple-theme-tokens"], "only the clicked card of the Invisible project is drawn");
  assert.equal(b.text("hl-maple-theme-tokens"), "Selected", "the revealed card is highlighted as Selected");
  assert.ok(b.scrolled.length > 0, "the board scrolls to the revealed card");
  assert.deepEqual(JSON.parse(store.getItem("hiddenProjects")), ["maple-workshop"], "saved visibility is unchanged");
  assert.equal(b.text("kanban-projects-badge"), "1 hidden", "the Projects button hidden count stays");
  assert.ok(!b.ids.includes("kanban-hidden-bar"), "no standalone hidden-projects row");

  // The reveal is temporary: once its ring timer fires, the card hides again.
  const ring = b.timers.findLast((x) => x.ms === 4000);
  assert.ok(ring, "the reveal sets the NEXT MOVE ring timer");
  ring.fn(b.cx);
  b.redraw();
  assert.ok(!b.drawnCards().some((id) => hiddenMaple.includes(id)), "the card hides again when the ring clears");
  assert.equal(b.view.selectedCardId, "maple-theme-tokens", "the Inspector selection stays");

  // Clicking a visible node keeps the ordinary path: no ring, card drawn and scrolled to.
  b.scrolled.length = 0;
  b.click("dep-node-orchard-theme-sync");
  assert.equal(b.view.pointedId, null);
  assert.ok(b.drawnCards().includes("orchard-theme-sync"));
  assert.ok(b.scrolled.length > 0);
});
