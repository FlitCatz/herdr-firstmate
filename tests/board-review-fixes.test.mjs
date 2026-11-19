import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { promisify } from "node:util";
import vm from "node:vm";

const runFile = promisify(execFile);
const rootUrl = new URL("..", import.meta.url);

function element() {
  const node = { id: null, click: null, hover: null, keyDown: null, kids: [], calls: [] };
  const self = new Proxy(node, {
    get(target, name) {
      if (name === "node") return target;
      return (...args) => {
        if (!["child", "children", "when", "id", "on_click", "on_item_click"].includes(name)) target.calls.push([name, ...args]);
        if (name === "id") target.id = args[0];
        else if (name === "on_click") target.click = args[0];
        else if (name === "on_item_click") target.itemClick = args[0];
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

async function createViewer({ exec, readTextFile, virtualRanges } = {}) {
  const source = (await readFile(new URL("mods/fm-board/viewer.js", rootUrl), "utf8"))
    .replace(/^import .*;$/gm, "")
    .replace("export class FolderViewer", "class FolderViewer");
  const vlists = [];
  let inFlight = 0;
  const track = (fn) => async (...args) => {
    inFlight++;
    try { return await fn(...args); }
    finally { inFlight--; }
  };
  const cx = {
    notify() {},
    spawn(fn) { return Promise.resolve().then(() => fn(cx)); },
  };
  const theme = new Proxy({}, { get: () => "#808080" });
  const rawExec = exec ?? (async (cmd, args = [], opts = {}) => {
    try {
      const res = await runFile(cmd, args, { cwd: opts.cwd, timeout: opts.timeout ?? 5000, encoding: "utf8" });
      return { code: 0, stdout: res.stdout, stderr: res.stderr };
    } catch (e) {
      return { code: typeof e.code === "number" ? e.code : 1, stdout: e.stdout ?? "", stderr: e.stderr ?? String(e.message ?? e) };
    }
  });
  const rawReadTextFile = readTextFile ?? (async (path) => {
    try { return await readFile(path, "utf8"); }
    catch { return null; }
  });
  const scope = {
    div: element,
    svg: element,
    v_flex: element,
    h_flex: element,
    Editor: { new: () => element() },
    EditorState: { new: (opts) => ({ ...opts, release() {} }) },
    Scrollbar: { vertical: () => element() },
    v_virtual_list: (id, count, size, getKey, renderRange) => {
      const range = virtualRanges?.[id] ?? { start: 0, end: Math.min(count, 5) };
      const rendered = count > 0 ? renderRange({ start: range.start, end: Math.min(count, range.end) }, cx) : [];
      for (const row of rendered) {
        if (row?.node?.click) throw new Error(`on_click is forbidden inside v_virtual_list (${id})`);
      }
      const el = element();
      el.id(`vlist-${id}`);
      el.children(rendered);
      vlists.push({ id, count, size, getKey, rendered, el });
      return el;
    },
    settings: () => ({ font_family: "JetBrains Mono", font_size: 13 }),
    watchFolder: () => {
      let resolve;
      const p = new Promise((r) => { resolve = r; });
      p.cancel = () => resolve([]);
      return p;
    },
    exec: track(rawExec),
    readTextFile: track(rawReadTextFile),
  };
  const FolderViewer = vm.runInNewContext(`${source}\nFolderViewer`, scope);
  const view = new FolderViewer();
  const flush = async () => { for (let i = 0; i < 20; i++) await Promise.resolve(); };
  const settle = async () => {
    await flush();
    while (inFlight > 0) {
      await new Promise((r) => setTimeout(r, 5));
      await flush();
    }
  };
  return { view, cx, theme, vlists, flush, settle, render: () => drawn(view.render(theme, (px) => px, [])) };
}

test("Finding 1: FolderViewer marks symlinks as non-clickable links, blocks directory/file symlink traversal, and scopes Changes to selected git subpath", async () => {
  const dir = await mkdtemp(join(tmpdir(), "fm-viewer-f1-"));
  try {
    const outsideDir = join(dir, "outside");
    const repoDir = join(dir, "repo");
    const subDir = join(repoDir, "packages", "app");
    const siblingDir = join(repoDir, "packages", "other");
    await mkdir(outsideDir, { recursive: true });
    await mkdir(subDir, { recursive: true });
    await mkdir(siblingDir, { recursive: true });
    await writeFile(join(outsideDir, "secret.txt"), "OUTSIDE_SECRET_CONTENT\n");
    await writeFile(join(subDir, "inside.js"), "export const x = 1;\n");
    await writeFile(join(siblingDir, "sibling.js"), "export const s = 2;\n");

    await runFile("git", ["init"], { cwd: repoDir });
    await runFile("git", ["-c", "user.name=Test", "-c", "user.email=test@example.com", "add", "packages/app/inside.js", "packages/other/sibling.js"], { cwd: repoDir });
    await runFile("git", ["-c", "user.name=Test", "-c", "user.email=test@example.com", "commit", "-m", "init"], { cwd: repoDir });

    // Modify both inside and sibling tracked files, plus add symlinks inside selected subpath.
    await writeFile(join(subDir, "inside.js"), "export const x = 2;\n");
    await writeFile(join(siblingDir, "sibling.js"), "export const s = 99;\n");
    await symlink(join(outsideDir, "secret.txt"), join(subDir, "link-file.txt"));
    await symlink(outsideDir, join(subDir, "link-dir"));

    const v = await createViewer();
    v.view.target(subDir, "app", v.cx);
    await v.settle();

    // 1) Files tab lists symlinks as links, not clickable files or folders.
    const filesItems = v.render();
    const linkFileRow = filesItems.find((x) => x.id === "vf-link-file.txt");
    const linkDirRow = filesItems.find((x) => x.id === "vf-link-dir");
    assert.ok(linkFileRow, "file symlink is shown");
    assert.ok(linkDirRow, "dir symlink is shown");
    assert.equal(linkFileRow.click, null, "file symlink must not be clickable");
    assert.equal(linkDirRow.click, null, "dir symlink must not be clickable");
    assert.match(linkFileRow.text, /\blink\b/);
    assert.match(linkDirRow.text, /\blink\b/);
    const vfList = v.vlists.find((x) => x.id === "vf-list");
    assert.ok(vfList?.el?.node?.itemClick, "Files v_virtual_list wires on_item_click");
    vfList.el.node.itemClick("link-file.txt", v.cx);
    await v.settle();
    assert.equal(v.view.file, null, "clicking symlink row via on_item_click must not open it");
    vfList.el.node.itemClick("link-dir", v.cx);
    await v.settle();
    assert.equal(v.view.folders.has("link-dir"), false, "clicking dir symlink via on_item_click must not expand it");

    // 2) Direct calls to showFile / toggleFolder / traversal paths must never read outside files.
    v.view.showFile("link-file.txt", v.cx, v.theme);
    await v.settle();
    assert.equal(v.view.code, null, "symlink file must not be previewed");
    assert.ok(v.view.fileError, "symlink file preview shows error");

    v.view.showFile("link-dir/secret.txt", v.cx, v.theme);
    await v.settle();
    assert.equal(v.view.code, null, "file inside symlink dir must not be previewed");

    v.view.showFile("../../outside/secret.txt", v.cx, v.theme);
    await v.settle();
    assert.equal(v.view.code, null, "dot-dot path must not be previewed");

    v.view.toggleFolder("link-dir", v.cx);
    await v.settle();
    assert.equal(v.view.entries.has("link-dir"), false, "symlink dir must not be listed");

    // 3) Changes tab scopes to selected subpath (excludes packages/other/sibling.js) and blocks untracked symlink diff read.
    const changedPaths = v.view.changed.map((c) => c.path);
    assert.ok(changedPaths.includes("inside.js"), "selected subpath change is included");
    assert.ok(!changedPaths.some((p) => p.includes("sibling.js")), "parent/sibling repo changes must be excluded");

    if (changedPaths.includes("link-file.txt")) {
      v.view.pickChange("link-file.txt", v.cx);
      await v.settle();
      const diffText = v.view.rows.map((r) => r.text).join("\n");
      assert.equal(diffText.includes("OUTSIDE_SECRET_CONTENT"), false, "untracked symlink diff must not leak outside file");
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("Finding 4: FolderViewer shares one git status per refresh and uses v_virtual_list for Files and Changes", async () => {
  let gitStatusCalls = 0;
  const changedFiles = Array.from({ length: 40 }, (_, i) => `src/file-${i}.js`);
  const exec = async (cmd, args = []) => {
    if (cmd === "sh") {
      if (args[2] === "safe-path") return { code: 0, stdout: "", stderr: "" };
      const out = Array.from({ length: 40 }, (_, i) => `f\0item-${i}.js\0`).join("");
      return { code: 0, stdout: out, stderr: "" };
    }
    if (cmd === "git") {
      if (args.includes("--show-toplevel")) return { code: 0, stdout: "/repo\n\n", stderr: "" };
      if (args.includes("status")) {
        gitStatusCalls++;
        return { code: 0, stdout: changedFiles.map((p) => ` M ${p}\0`).join(""), stderr: "" };
      }
      if (args.includes("--verify")) return { code: 0, stdout: "deadbeef\n", stderr: "" };
      if (args.includes("--numstat")) return { code: 0, stdout: "", stderr: "" };
      if (args.includes("diff")) return { code: 0, stdout: "@@ -1,1 +1,1 @@\n+x\n", stderr: "" };
    }
    return { code: 1, stdout: "", stderr: "" };
  };
  const v = await createViewer({
    exec,
    virtualRanges: {
      "vf-list": { start: 0, end: 4 },
      "vc-items": { start: 0, end: 3 },
      "vc-diff": { start: 0, end: 5 },
    },
  });
  v.view.target("/repo", "repo", v.cx);
  await v.settle();
  assert.equal(gitStatusCalls, 1, "one refresh runs git status once across Files and Changes");

  v.view.tab = "files";
  v.vlists.length = 0;
  const filesTree = v.render();
  const vfList = v.vlists.find((x) => x.id === "vf-list");
  assert.ok(vfList, "Files uses v_virtual_list");
  assert.equal(vfList.count, 40);
  assert.equal(filesTree.filter((x) => x.id?.startsWith("vf-item-")).length, 4, "Files only builds visible virtual rows");

  v.view.tab = "changes";
  v.vlists.length = 0;
  const changesTree = v.render();
  const vcItems = v.vlists.find((x) => x.id === "vc-items");
  assert.ok(vcItems, "Changes uses v_virtual_list");
  assert.equal(vcItems.count, 40);
  assert.equal(changesTree.filter((x) => x.id?.startsWith("vc-src/")).length, 3, "Changes only builds visible virtual rows");
});

test("Finding 6: slow file/diff reads never overwrite newer previews and changesError remains visible with cached changes", async () => {
  const fileResolvers = new Map();
  const diffResolvers = new Map();
  let failGitStatus = false;

  const exec = async (cmd, args = []) => {
    if (cmd === "sh") {
      if (args[2] === "safe-path") return { code: 0, stdout: "", stderr: "" };
      return { code: 0, stdout: "f\0A.txt\0f\0B.txt\0", stderr: "" };
    }
    if (cmd === "git") {
      if (args.includes("--show-toplevel")) return { code: 0, stdout: "/repo\n\n", stderr: "" };
      if (args.includes("status")) {
        if (failGitStatus) return { code: 1, stdout: "", stderr: "status failed" };
        return { code: 0, stdout: " M A.txt\0 M B.txt\0", stderr: "" };
      }
      if (args.includes("--verify")) return { code: 0, stdout: "deadbeef\n", stderr: "" };
      if (args.includes("--numstat")) return { code: 0, stdout: "", stderr: "" };
      if (args.includes("diff")) {
        const target = args.at(-1);
        return await new Promise((resolve) => {
          (diffResolvers.get(target) ?? diffResolvers.set(target, []).get(target)).push(resolve);
        });
      }
    }
    return { code: 1, stdout: "", stderr: "" };
  };

  const readTextFile = (path) => new Promise((resolve) => {
    (fileResolvers.get(path) ?? fileResolvers.set(path, []).get(path)).push(resolve);
  });

  const v = await createViewer({ exec, readTextFile });
  v.view.target("/repo", "repo", v.cx);
  await v.flush();
  // Resolve initial auto-opened A.txt diff
  const initDiff = diffResolvers.get("A.txt")?.shift();
  if (initDiff) initDiff({ code: 0, stdout: "@@ -1 +1 @@\n+init\n", stderr: "" });
  await v.settle();

  // File read race: A -> B -> A; newest A returns first ("new content"), oldest A returns last ("old content").
  v.view.showFile("A.txt", v.cx, v.theme);
  await v.flush();
  v.view.showFile("B.txt", v.cx, v.theme);
  await v.flush();
  v.view.showFile("A.txt", v.cx, v.theme);
  await v.flush();
  const aReads = fileResolvers.get("/repo/A.txt");
  const bReads = fileResolvers.get("/repo/B.txt");
  assert.equal(aReads?.length, 2);
  aReads[1]("new content");
  await v.flush();
  assert.equal(v.view.code?.value, "new content");
  bReads?.[0]?.("b content");
  aReads[0]("old content");
  await v.settle();
  assert.equal(v.view.code?.value, "new content", "stale A read must not overwrite newer A preview");

  // Diff read race: pick B -> A -> B; newest B returns first, oldest B returns last.
  v.view.pickChange("B.txt", v.cx);
  await v.flush();
  v.view.pickChange("A.txt", v.cx);
  await v.flush();
  v.view.pickChange("B.txt", v.cx);
  await v.flush();
  const bDiffs = diffResolvers.get("B.txt");
  const aDiffs = diffResolvers.get("A.txt");
  assert.equal(bDiffs?.length, 2);
  bDiffs[1]({ code: 0, stdout: "@@ -1 +1 @@\n+new diff\n", stderr: "" });
  await v.flush();
  assert.match(v.view.rows.map((r) => r.text).join("\n"), /new diff/);
  aDiffs?.shift()?.({ code: 0, stdout: "@@ -1 +1 @@\n+a diff\n", stderr: "" });
  bDiffs[0]({ code: 0, stdout: "@@ -1 +1 @@\n+old diff\n", stderr: "" });
  await v.settle();
  assert.match(v.view.rows.map((r) => r.text).join("\n"), /new diff/, "stale diff must not overwrite newer diff");

  // Failed changes refresh still surfaces error even when cached changes remain.
  failGitStatus = true;
  v.view.tab = "changes";
  v.view.refresh(v.cx);
  await v.settle();
  const items = v.render();
  assert.ok(v.view.changed.length > 0, "cached changes remain visible");
  assert.ok(items.some((x) => x.text.includes("status failed")), "changesError must be visible when cached list is non-empty");
});

const snapshotFile = new URL("tests/fixtures/snapshot.json", rootUrl).pathname;
const baseSnapshot = JSON.parse(await readFile(snapshotFile, "utf8"));
const HOME = baseSnapshot.fm_home;

async function createBoard({ exec = async () => ({ code: 1, stdout: "", stderr: "" }), snapshot = null, ui = {}, focusedTarget = null, prViewer = false, rootLayout = null } = {}) {
  const source = (await readFile(new URL("mods/fm-board/main.js", rootUrl), "utf8"))
    .replace(/^import .*;$/gm, "")
    .replace("export default class FmBoard", "class FmBoard");
  const pending = [];
  const commands = [];
  const sharedSet = [];
  const timers = [];
  const focused = [];
  const cx = {
    notify() {},
    stop_propagation() {},
    spawn(fn) {
      const task = Promise.resolve().then(() => fn(cx));
      pending.push(task);
      return task;
    },
    timer: {
      every() {},
      after(ms, fn) { timers.push({ ms, fn }); },
    },
    focus_handle() {
      const handle = { focus() { focused.push(handle); }, is_focused: () => focused.at(-1) === handle, release: () => true };
      return handle;
    },
  };
  const input = () => {
    let text = "";
    const listeners = {};
    return {
      on(ev, fn) { (listeners[ev] ??= []).push(fn); },
      emit(ev) { for (const fn of listeners[ev] ?? []) fn({}, cx); },
      value: () => text,
      set_value(v) { text = v; },
    };
  };
  const theme = new Proxy({}, { get: () => "#808080" });
  const store = { getItem: () => null, setItem() {} };
  const scope = {
    View: class {},
    div: element,
    svg: element,
    v_flex: element,
    h_flex: element,
    Input: { new: element },
    h_resizable: element,
    resizable_panel: element,
    InputState: { new: input },
    ScrollHandle: { new: () => ({ scroll_to_item() {} }) },
    FolderViewer: class { constructor() { this.root = null; } close() { this.root = null; } },
    props: () => ({ home: HOME, snapshot_file: snapshotFile, collapsed: [], ui }),
    checking: () => false,
    theme: () => theme,
    settings: () => ({ font_size: 14 }),
    terminals: () => [],
    focused: () => focusedTarget,
    nextCommand: () => Promise.resolve(null),
    run: (name, args) => { commands.push({ name, args }); },
    openOverlay: () => "overlay-1",
    layout: () => rootLayout,
    setShared: (key, value) => { sharedSet.push({ key, value }); },
    appHome: () => "/fictional/herdr-home",
    localStorage: store,
    readTextFile: async (file) => {
      if (file === "/fictional/herdr-home/mods/herdr-pr-viewer/mod.json") return prViewer ? "{}" : null;
      if (file === snapshotFile) return snapshot ? JSON.stringify(snapshot) : readFile(file, "utf8");
      if (file === `${HOME}/data/projects.md`) return "- maple-workshop - Fictional.\n- orchard-atlas - Fictional.\n";
      throw new Error(`no such file: ${file}`);
    },
    exec,
    watchFolder: () => new Promise(() => {}),
    pickFolder: async () => null,
  };
  const { FmBoard, cardsFrom, dependencyGraph, chainHighlight } = vm.runInNewContext(
    `${source}\n({ FmBoard, cardsFrom, dependencyGraph, chainHighlight })`,
    scope,
  );
  const view = new FmBoard();
  view.init({}, cx);
  const settle = async () => {
    while (pending.length) {
      const batch = pending.splice(0, pending.length);
      await Promise.all(batch);
    }
  };
  await settle();
  let items = drawn(view.render(cx));
  const redraw = () => { items = drawn(view.render(cx)); return items; };
  const click = (id, event = {}) => {
    const item = items.find((x) => x.id === id);
    assert.ok(item?.click, `nothing to click at ${id}`);
    item.click(event, cx);
    return redraw();
  };
  const hover = (id, hovered = true) => {
    const item = items.find((x) => x.id === id);
    assert.ok(item?.hover, `nothing to hover at ${id}`);
    item.hover(hovered, cx);
    return redraw();
  };
  return { view, cx, redraw, click, hover, settle, timers, commands, sharedSet, cardsFrom, dependencyGraph, chainHighlight, get items() { return items; }, get ids() { return items.map((x) => x.id); } };
}

test("Finding 2: dependency graph and chain layouts are reused across non-snapshot renders and avoid eager O(N^2) traversal", async () => {
  const b = await createBoard({ ui: { viewMode: "chains" } });
  const initialGraph = b.view.graph;
  assert.ok(initialGraph.components.length > 0);
  const firstComp = initialGraph.components[0];
  const initialLane = b.view.chainLayouts?.get(firstComp.id);
  assert.ok(initialLane, "chainLayouts caches placed lane");

  // Hovering and re-rendering without snapshot changes must reuse the same graph & lane layout instances.
  b.hover(`chain-node-${firstComp.nodeIds[0]}`, true);
  assert.equal(b.view.graph, initialGraph, "graph must not recompute on hover");
  assert.equal(b.view.chainLayouts?.get(firstComp.id), initialLane, "lane layout must not recompute on hover");

  // Searching in Chains reuses cached lane layouts between matchIds() and renderChainLane().
  b.view.query = "map";
  b.redraw();
  assert.equal(b.view.graph, initialGraph, "graph must not recompute on search");
  assert.equal(b.view.chainLayouts?.get(firstComp.id), initialLane, "lane layout must be shared with search");

  // Synthetic 1,500-node serial chain: dependencyGraph completes fast and does not eagerly compute ancestor/descendant arrays.
  const chainCards = Array.from({ length: 1500 }, (_, i) => ({
    id: `c${i}`,
    title: `Task ${i}`,
    project: "maple-workshop",
    column: "queued",
    waitingIds: i === 0 ? [] : [`c${i - 1}`],
  }));
  const g = b.dependencyGraph(chainCards);
  assert.equal(g.nodes.get("c0").blocksCount, 1499);
  assert.equal(g.nodes.get("c750").blocksCount, 749);
  assert.equal(g.nodes.get("c1499").blocksCount, 0);
  // Upstream/downstream lists should not be eagerly materialized on non-selected nodes.
  const desc = Object.getOwnPropertyDescriptor(g.nodes.get("c10"), "blocks");
  assert.equal(typeof desc?.get, "function", "blocks should be lazy rather than eagerly built for all N nodes");
  const hl = b.chainHighlight(g, "c750", null);
  assert.equal(hl.roles.get("c749"), "upstream");
  assert.equal(hl.roles.get("c750"), "selected");
  assert.equal(hl.roles.get("c751"), "downstream");
});

test("Finding 3: pasteToFirstmate checks macOS pasteboard changeCount and skips restore when clipboard changed", async () => {
  const pb = { count: 42, text: "original text", types: "«class utf8», 13" };
  const tempFiles = new Map();
  let nextTmp = 0;
  let pasteboardReads = 0;
  let bRef;

  const exec = async (cmd, args = []) => {
    if (cmd === "/usr/bin/env" && args.includes("osascript")) {
      const expr = args.at(-1);
      if (expr.includes("changeCount")) {
        pasteboardReads++;
        return { code: 0, stdout: `${pb.count}\n`, stderr: "" };
      }
      if (expr.includes("clipboard info")) {
        return { code: 0, stdout: `${pb.types}\n`, stderr: "" };
      }
    }
    if (cmd === "/usr/bin/env" && args.includes("sh")) {
      const script = args[args.indexOf("-c") + 1];
      const arg1 = args.at(-1);
      if (script.includes("pbpaste >")) {
        const path = `/tmp/mock-clip-${++nextTmp}`;
        tempFiles.set(path, pb.text);
        return { code: 0, stdout: path, stderr: "" };
      }
      if (script.includes("| pbcopy")) {
        pb.text = arg1;
        pb.count++;
        return { code: 0, stdout: "", stderr: "" };
      }
      if (script.includes("pbcopy <")) {
        pb.text = tempFiles.get(arg1) ?? "";
        pb.count++;
        tempFiles.delete(arg1);
        return { code: 0, stdout: "", stderr: "" };
      }
      if (script.includes("rm -f")) {
        tempFiles.delete(arg1);
        return { code: 0, stdout: "", stderr: "" };
      }
    }
    return { code: 1, stdout: "", stderr: "" };
  };

  const b = await createBoard({ exec, focusedTarget: { terminal: "w1:p1" } });
  bRef = b;

  const nextTimer = (ms) => {
    const i = b.timers.findIndex((t) => t.ms === ms);
    assert.ok(i >= 0, `expected ${ms}ms timer`);
    return b.timers.splice(i, 1)[0];
  };

  // Case 1: user copies something new while pasteToFirstmate waits 300ms after terminal.paste.
  const pastePromise = b.view.pasteToFirstmate("w1:p1", "[Board card] id: title ", b.cx);
  await new Promise((r) => setTimeout(r, 10));
  // Fire 100ms focus timer
  const t1 = nextTimer(100);
  t1.fn();
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(b.commands.some((c) => c.name === "terminal.paste"), true);
  // Simulate user copying new text in another app before 300ms restore timer fires.
  pb.text = "user copied elsewhere";
  pb.count++;
  const t2 = nextTimer(300);
  t2.fn();
  await pastePromise;
  assert.ok(pasteboardReads > 0, "must read pasteboard changeCount");
  assert.equal(pb.text, "user copied elsewhere", "must not overwrite user's newer clipboard");
  assert.equal(tempFiles.size, 0, "must still clean up temporary file");

  // Case 2: clipboard changes during the 100ms focus wait before saving/copying.
  pb.count = 100;
  pb.text = "before focus";
  pb.types = "«class utf8», 12";
  const p2 = bRef.view.pasteToFirstmate("w1:p1", "[Board card] id: title ", bRef.cx);
  await new Promise((r) => setTimeout(r, 10));
  pb.count++;
  pb.text = "copied during focus";
  const t3 = nextTimer(100);
  t3.fn();
  await assert.rejects(p2, /Clipboard changed/);
  assert.equal(pb.text, "copied during focus", "aborted paste must leave newer clipboard intact");
  assert.equal(tempFiles.size, 0, "aborted paste must clean up any temp files");
});

test("Finding 5: send surfaces exec Promise rejections in notice and keeps Memo input intact", async () => {
  const exec = async (cmd, args = []) => {
    if (args.some((a) => String(a).includes("/bin/fm-inbox.sh")) && args.includes("note")) {
      throw new Error("cannot start helper");
    }
    return { code: 1, stdout: "", stderr: "" };
  };
  const b = await createBoard({ exec });
  b.view.ask.set_value("keep this memo");
  b.view.askProject = "orchard-atlas";
  b.click("ask-memo");
  await b.settle();
  assert.equal(b.view.notice, "Request failed: cannot start helper");
  assert.equal(b.view.ask.value(), "keep this memo");
  assert.equal(b.view.askProject, "orchard-atlas");
});

test("Finding 7: invalid or non-HTTPS PR URLs are hidden on cards/nodes and rejected on openPr", async () => {
  const opened = [];
  const exec = async (cmd, args = []) => {
    if (cmd === "open") opened.push(args[0]);
    return { code: 1, stdout: "", stderr: "" };
  };
  const snap = structuredClone(baseSnapshot);
  snap.backlog.records.push(
    { id: "bad-file-url", state: "in_flight", repo: "maple-workshop", title: "Bad file URL", structured: true, pr_url: "file:///etc/passwd" },
    { id: "bad-http-url", state: "in_flight", repo: "maple-workshop", title: "Bad http URL", structured: true, pr_url: "http://github.com/FlitCatz/maple-workshop/pull/9" },
    { id: "good-gitlab-url", state: "in_flight", repo: "maple-workshop", title: "Good GitLab PR", structured: true, pr_url: "https://gitlab.com/org/group/repo/-/merge_requests/99" },
    { id: "good-azdo-url", state: "in_flight", repo: "maple-workshop", title: "Good AzDO PR", structured: true, pr_url: "https://dev.azure.com/org/proj/_git/repo/pullrequest/7" },
  );
  snap.tasks.push({
    id: "bad-detail-pr", kind: "ship", project: `${HOME}/projects/maple-workshop`, branch: "fm/bad", harness: "codex", backend: "hc",
    mode: "no-mistakes", yolo: false, spawn_gen: "s1", remote: "origin", secondmate_projects: [],
    paths: { home: HOME, meta: "", status_log: "", worktree: { path: "", present: false }, report: { path: "", present: false } },
    current_state: { state: "done", source: "pane", detail: "checks green · pr=file:///Applications/Calculator.app", raw: "", observed_at: "2026-11-13T03:46:13Z", freshness: "fresh" },
    endpoint: { target: null, exists: false, agent_alive: "not_checked", status: "absent", observed_at: "2026-11-13T03:46:13Z", freshness: "fresh" },
    pr: { url: null, source: "absent", head: null },
    hints: { pending_decision: false, blocked_event: false, open_decisions: [], scout_report_present: false, last_event_text: "" },
    actions: { watch: "", steer: "", return_channel_note: null },
  });

  const b = await createBoard({ exec, snapshot: snap });
  assert.equal(b.ids.includes("pr-bad-file-url"), false, "file:// PR URL must be hidden");
  assert.equal(b.ids.includes("pr-bad-http-url"), false, "http:// PR URL must be hidden");
  assert.equal(b.ids.includes("pr-bad-detail-pr"), false, "pr=file:// detail URL must be hidden");
  assert.equal(b.ids.includes("pr-good-gitlab-url"), true, "supported GitLab HTTPS MR URL is shown");
  assert.equal(b.ids.includes("pr-good-azdo-url"), true, "supported Azure DevOps HTTPS PR URL is shown");

  b.view.openPr("file:///etc/passwd", { id: "bad-file-url", project: "maple-workshop" }, b.cx);
  await b.settle();
  assert.deepEqual(opened, [], "openPr must never call open on invalid/file URL");
  assert.match(b.view.notice, /Cannot open PR/);
});
