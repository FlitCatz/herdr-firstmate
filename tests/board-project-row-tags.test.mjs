// Behavioral tests for the delivery-mode and Auto-merge tags on collapsed Projects rows in fm-board.
// Run with: node --test tests/board-project-row-tags.test.mjs
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import vm from "node:vm";

const root = new URL("..", import.meta.url);
const snapshotFile = new URL("tests/fixtures/snapshot.json", root).pathname;
const snapshot = JSON.parse(await readFile(snapshotFile, "utf8"));
const HOME = snapshot.fm_home;

function element() {
  const node = { id: null, click: null, kids: [], calls: [] };
  const self = new Proxy(node, {
    get(target, name) {
      if (name === "node") return target;
      return (...args) => {
        if (!["child", "children", "trigger", "content", "when", "id", "on_click"].includes(name)) target.calls.push([name, ...args]);
        if (name === "id") target.id = args[0];
        else if (name === "on_click") target.click = args[0];
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

const REGISTRY = [
  "- maple-workshop [no-mistakes-prod-only +yolo] - Fictional workshop.",
  "- orchard-atlas [no-mistakes] - Fictional atlas.",
  "- birch-ledger [direct-PR +yolo] - Fictional ledger.",
  "- cedar-notes [local-only] - Fictional notes.",
  "- pine-bare - No tokens at all.",
].join("\n");

async function mountProjects() {
  const source = (await readFile(new URL("mods/fm-board/main.js", root), "utf8"))
    .replace(/^import .*;$/gm, "").replace("export default class FmBoard", "class FmBoard");
  const pending = [];
  const cx = {
    notify() {}, stop_propagation() {},
    spawn(fn) { pending.push(fn(cx)); },
    timer: { every() {}, after() {} },
    focus_handle() { return { focus() {}, is_focused: () => false, release: () => true }; },
  };
  const input = () => { let text = ""; return { on() {}, value: () => text, set_value(v) { text = v; } }; };
  const theme = new Proxy({}, { get: () => "#808080" });
  const scope = {
    View: class {}, div: element, svg: element, v_flex: element, h_flex: element, Input: { new: element },
    h_resizable: element, resizable_panel: element,
    Popover: { new: (popId) => element().popover_id(popId) },
    InputState: { new: input },
    ScrollHandle: { new: () => ({ scroll_to_item() {} }) },
    FolderViewer: class { constructor() { this.root = null; } close() { this.root = null; } },
    props: () => ({ home: HOME, snapshot_file: snapshotFile, collapsed: [], ui: { bottomTab: "projects" } }),
    checking: () => false, theme: () => theme, settings: () => ({ font_size: 14 }),
    terminals: () => [], focused: () => null, nextCommand: () => Promise.resolve(null),
    run: () => {}, layout: () => null, setShared: () => {}, appHome: () => "/fictional/herdr-home",
    localStorage: { getItem: () => undefined, setItem() {} },
    readTextFile: async (file) => {
      if (file === snapshotFile) return JSON.stringify(snapshot);
      if (file === `${HOME}/data/projects.md`) return `${REGISTRY}\n`;
      throw new Error(`no such file: ${file}`);
    },
    exec: async () => ({ code: 1, stdout: "", stderr: "" }),
    watchFolder: () => new Promise(() => {}), pickFolder: async () => null,
  };
  const { FmBoard } = vm.runInNewContext(`${source}\n({ FmBoard })`, scope);
  const view = new FmBoard();
  view.init({}, cx);
  await Promise.all(pending);
  assert.equal(view.error, null);
  const redraw = () => drawn(view.render(cx));
  let items = redraw();
  if (!items.some((x) => x.id === "project-list")) {
    items.find((x) => x.id === "bottom-tab-projects").click({}, cx);
    items = redraw();
  }
  return {
    get items() { return items; },
    ids: () => items.map((x) => x.id),
    text: (id) => items.find((x) => x.id === id)?.text,
    click(id) { items.find((x) => x.id === id).click({}, cx); items = redraw(); },
  };
}

const CASES = [
  ["maple-workshop", "Validate product changes", true],
  ["orchard-atlas", "Always validate", false],
  ["birch-ledger", "Direct PR", true],
  ["cedar-notes", "Local only", false],
  ["pine-bare", "Always validate", false],
];

test("a collapsed project row shows its delivery mode beside the name", async () => {
  const b = await mountProjects();
  for (const [name, label] of CASES) {
    assert.equal(b.text(`project-mode-${name}`), label, `${name} mode tag`);
    assert.ok(b.text(`project-${name}`).includes(label), `${name} row carries the label`);
  }
});

test("the Auto-merge tag appears only for projects with auto-merge on", async () => {
  const b = await mountProjects();
  for (const [name, , yolo] of CASES) {
    assert.equal(b.ids().includes(`project-automerge-${name}`), yolo, `${name} auto-merge tag`);
    if (yolo) assert.equal(b.text(`project-automerge-${name}`), "Auto-merge");
    else assert.ok(!b.text(`project-${name}`).includes("Auto-merge"), `${name} row mentions no auto-merge`);
  }
});

test("the tags are small and the Auto-merge tag never shrinks away", async () => {
  const b = await mountProjects();
  const calls = (id, fn) => b.items.find((x) => x.id === id).calls.filter((c) => c[0] === fn);
  assert.ok(calls("project-mode-maple-workshop", "truncate").length, "mode tag truncates on narrow panels");
  assert.ok(calls("project-automerge-maple-workshop", "flex_none").length, "auto-merge tag keeps its width");
  const size = (id) => calls(id, "text_size")[0][1];
  assert.equal(size("project-mode-maple-workshop"), size("project-automerge-maple-workshop"), "both tags share one small size");
});

test("the expanded detail and the row controls are unchanged", async () => {
  const b = await mountProjects();
  for (const [name, label, yolo] of CASES) {
    assert.ok(b.ids().includes(`files-${name}`) && b.ids().includes(`terminal-${name}`), `${name} keeps Files and terminal buttons`);
    assert.ok(!b.text("project-list").includes(`${label} · Auto-merge`), `${name} detail hidden while collapsed`);
    b.click(`project-${name}`);
    const detail = `${label} · Auto-merge ${yolo ? "on" : "off"}`;
    assert.ok(b.text("project-list").includes(detail), `${name} expanded detail shows "${detail}"`);
    assert.ok(b.ids().includes(`rm-${name}`), `${name} expanded row keeps its actions`);
    b.click(`project-${name}`);
    assert.ok(!b.ids().includes(`rm-${name}`), `${name} folds again`);
  }
});
