// Tests the fm-md-viewer link handler (link.js), read-only Markdown view (main.js),
// and layout/mod link_handlers registration outside Herdr.
// Run with: node --test tests/md-link-viewer.test.mjs
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import vm from "node:vm";
import * as stateHelpers from "../mods/fm-md-viewer/state.js";

const rootUrl = new URL("..", import.meta.url);

const THEME = {
  background: "#111214",
  surface: "#181a1f",
  border: "#343942",
  foreground: "#e6edf3",
  muted: "#9aa5b1",
  dim: "#6b7280",
  ansi1: "#ff7b72",
};

function stripImports(source) {
  return source.replace(/^import[\s\S]*?from\s+["'][^"']+["'];?\s*$/gm, "");
}

// Real filesystem-backed stand-in for Herdr's readTextFile(path):
// returns UTF-8 text (up to 1 MiB) for a regular file, or null if absent/directory.
async function fsReadTextFile(filePath) {
  try {
    const buf = await readFile(filePath);
    if (buf.byteLength > 1024 * 1024) throw new Error("Text file exceeds 1 MiB");
    return buf.toString("utf8");
  } catch (err) {
    if (err?.code === "ENOENT" || err?.code === "ENOTDIR" || err?.code === "EISDIR") return null;
    throw err;
  }
}

function element(kind = "div") {
  const node = { id: null, kind, kids: [], props: {} };
  const self = new Proxy(node, {
    get(target, name) {
      if (name === "node") return target;
      return (...args) => {
        if (name === "id") target.id = args[0];
        else if (name === "child") target.kids.push(args[0]);
        else if (name === "children") target.kids.push(...args[0]);
        else if (name === "when") { if (args[0]) args[1](self); }
        else target.props[name] = args.length === 0 ? true : args.length === 1 ? args[0] : args;
        return self;
      };
    },
  });
  return self;
}

function collectNodes(node, out = []) {
  if (!node || typeof node !== "object") return out;
  if (node.node) {
    out.push(node.node);
    for (const k of node.node.kids) collectNodes(k, out);
  }
  return out;
}

function nodeText(node) {
  if (node === null || node === undefined) return "";
  if (typeof node !== "object") return String(node);
  return (node.node?.kids ?? []).map(nodeText).filter(Boolean).join(" ");
}

// Stand-in for Herdr's live model, shared by the link handler and the viewer views.
// run() only queues a command: it shows up in spaces()/panes() when publish() runs, because
// an isolated Herdr 0.1.18 run showed a `tab.new` tab is not in spaces() right after run()
// returns. publish() applies `tab.new {space?, name, mod, props, focus}` (a named tab whose
// only pane is the mod) and `tab.rename {id, name}` as Herdr's command docs describe them.
function fakeHerdr({ spaces = [], panes = [], shared = {}, now = 1_800_000_000_000 } = {}) {
  const model = {
    spaces,
    panes,
    sharedStore: new Map(Object.entries(shared)),
    commands: [],
    queued: [],
    viewProps: new Map(),
    now,
    newTabCount: 0,
    run(name, args) {
      const copy = args === undefined ? undefined : structuredClone(args);
      model.commands.push({ name, args: copy });
      model.queued.push({ name, args: copy });
      return null;
    },
    publish() {
      const created = [];
      for (const { name, args } of model.queued.splice(0)) {
        if (name === "tab.new") {
          const space = model.spaces.find((sp) => sp.id === args.space) ?? model.spaces.find((sp) => sp.active);
          if (!space) continue;
          model.newTabCount++;
          const tab = `tb-new-${model.newTabCount}`;
          space.tabs.push({ id: tab, name: args.name, active: Boolean(args.focus) });
          model.panes.push({ pane: `p-new-${model.newTabCount}`, terminal: null, mod: args.mod, tab, focused: Boolean(args.focus) });
          model.viewProps.set(tab, args.props);
          created.push(tab);
        } else if (name === "tab.rename") {
          for (const space of model.spaces) {
            const tab = space.tabs.find((t) => t.id === args.id);
            if (tab) tab.name = args.name;
          }
        }
      }
      return created;
    },
    tabName(tabId) {
      for (const space of model.spaces) {
        const tab = space.tabs.find((t) => t.id === tabId);
        if (tab) return tab.name;
      }
      return undefined;
    },
    api() {
      return {
        spaces: () => structuredClone(model.spaces),
        panes: () => structuredClone(model.panes),
        run: model.run,
        shared: (key) => (model.sharedStore.has(key) ? structuredClone(model.sharedStore.get(key)) : undefined),
        setShared: (key, value) => {
          model.sharedStore.set(key, structuredClone(value));
          return null;
        },
        Date: { now: () => model.now },
      };
    },
  };
  return model;
}

async function loadLinkHandler({
  spaces = [],
  panes = [],
  shared = {},
  herdr = fakeHerdr({ spaces, panes, shared }),
  homeDir = "/Users/example",
  readTextFile = fsReadTextFile,
} = {}) {
  let execCalls = 0;
  let fetchCalls = 0;

  const linkSource = stripImports(await readFile(new URL("mods/fm-md-viewer/link.js", rootUrl), "utf8"))
    .replace(/^export async function handleLink/m, "async function handleLink")
    .replace(/^export function handleLink/m, "function handleLink");

  const scope = {
    ...stateHelpers,
    ...herdr.api(),
    home: () => homeDir,
    readTextFile: async (p, opts) => readTextFile(p, opts),
    exec: async () => {
      execCalls++;
      throw new Error("link handler must not invoke shell commands");
    },
    fetch: async () => {
      fetchCalls++;
      throw new Error("link handler must not make network requests");
    },
  };

  const handleLink = vm.runInNewContext(`${linkSource}\nhandleLink`, scope);
  return {
    handleLink,
    herdr,
    commands: herdr.commands,
    sharedStore: herdr.sharedStore,
    get execCalls() { return execCalls; },
    get fetchCalls() { return fetchCalls; },
  };
}

async function loadMdViewer({
  props = {},
  spaces = [],
  panes = [],
  shared = {},
  herdr = fakeHerdr({ spaces, panes, shared }),
  homeDir = "/Users/example",
  checking = false,
  settings = { font_size: 14, font_family: "JetBrains Mono" },
  theme = THEME,
  readTextFile = fsReadTextFile,
} = {}) {
  const textViews = [];
  let readCalls = 0;
  let inFlight = 0;
  let notifyCount = 0;

  const mainSource = stripImports(await readFile(new URL("mods/fm-md-viewer/main.js", rootUrl), "utf8"))
    .replace(/^export default class /m, "class ");

  const cx = {
    notify() { notifyCount++; },
    sleep: async () => {},
    spawn(fn) {
      inFlight++;
      return Promise.resolve()
        .then(() => fn(cx))
        .finally(() => { inFlight--; });
    },
  };

  const scope = {
    ...stateHelpers,
    ...herdr.api(),
    View: class View {},
    div: () => element("div"),
    v_flex: () => element("v_flex"),
    h_flex: () => element("h_flex"),
    TextView: {
      markdown(id, markdown) {
        const el = element("TextView.markdown");
        el.id(id);
        el.markdown(markdown);
        textViews.push(el.node);
        return el;
      },
    },
    props: () => props,
    home: () => homeDir,
    checking: () => checking,
    theme: () => theme,
    settings: () => settings,
    readTextFile: async (p, opts) => {
      readCalls++;
      return readTextFile(p, opts);
    },
  };

  const FmMdViewer = vm.runInNewContext(`${mainSource}\nFmMdViewer`, scope);
  const view = new FmMdViewer();
  const settle = async () => {
    for (let i = 0; i < 20; i++) await Promise.resolve();
    while (inFlight > 0) {
      await new Promise((r) => setTimeout(r, 5));
      for (let i = 0; i < 20; i++) await Promise.resolve();
    }
  };
  view.init?.(props, cx);
  await settle();

  const render = () => {
    textViews.length = 0;
    const tree = view.render(cx);
    return { tree, nodes: collectNodes(tree), text: nodeText(tree), textViews: [...textViews] };
  };

  return {
    view,
    cx,
    herdr,
    sharedStore: herdr.sharedStore,
    settle,
    render,
    get readCalls() { return readCalls; },
    get notifyCount() { return notifyCount; },
  };
}

// A tab.new for a viewer tab: focused, in the given space, showing the exact file, and named
// "<file name> · <tag>" with the same non-empty tag the view receives in its props.
function assertViewerTabNew(command, { space, file, title }) {
  assert.equal(command.name, "tab.new");
  const { tag, ...rest } = command.args.props;
  assert.equal(typeof tag, "string");
  assert.ok(tag.length > 0 && !/\s/.test(tag), "the open tag is a non-empty token");
  assert.deepEqual(rest, { file });
  const expected = { name: `${title} · ${tag}`, mod: "fm-md-viewer", props: { file, tag }, focus: true };
  if (space) expected.space = space;
  assert.deepEqual(command.args, expected);
  return tag;
}

// Herdr publishes queued commands, then creates and renders a view for each new viewer tab
// with the props `tab.new` gave it. Returns those views.
async function publishAndRender(herdr) {
  const views = [];
  for (const tab of herdr.publish()) {
    const viewEnv = await loadMdViewer({ herdr, props: herdr.viewProps.get(tab) });
    viewEnv.render();
    views.push(viewEnv);
  }
  herdr.publish();
  return views;
}

test("handleLink opens an existing local .md file in a focused read-only tab in source.space and passes through URLs, remote files, non-Markdown, and missing files", async () => {
  const dir = await mkdtemp(join(tmpdir(), "fm-md-link-"));
  try {
    const mdFile = join(dir, "guide.md");
    const txtFile = join(dir, "notes.txt");
    const missingMd = join(dir, "missing.md");
    await writeFile(mdFile, "# Guide\n\nHello world.\n", "utf8");
    await writeFile(txtFile, "plain text\n", "utf8");

    const env = await loadLinkHandler({
      spaces: [{ id: "sp-1", active: true, machine: null, tabs: [{ id: "tb-1", name: "shell", active: true }] }],
      panes: [{ pane: "p-1", terminal: "t1", tab: "tb-1", focused: true }],
    });

    const rMd = await env.handleLink({
      link: { kind: "file", raw: mdFile, path: mdFile },
      source: { terminal: "t1", machine: null, cwd: dir, pane: "p-1", tab: "tb-1", space: "sp-1" },
    });
    assert.equal(rMd, "handled");
    assert.equal(env.commands.length, 1);
    assertViewerTabNew(env.commands[0], { space: "sp-1", file: mdFile, title: "guide.md" });

    // URL -> pass
    assert.equal(
      await env.handleLink({
        link: { kind: "url", raw: "https://example.com/readme.md", url: "https://example.com/readme.md" },
        source: { terminal: "t1", machine: null, cwd: dir, pane: "p-1", tab: "tb-1", space: "sp-1" },
      }),
      "pass",
    );

    // Remote file -> pass
    assert.equal(
      await env.handleLink({
        link: { kind: "file", raw: mdFile, path: mdFile },
        source: { terminal: "vps/t2", machine: "vps", cwd: dir, pane: "p-2", tab: "tb-2", space: "sp-remote" },
      }),
      "pass",
    );

    // Non-Markdown file -> pass
    assert.equal(
      await env.handleLink({
        link: { kind: "file", raw: txtFile, path: txtFile },
        source: { terminal: "t1", machine: null, cwd: dir, pane: "p-1", tab: "tb-1", space: "sp-1" },
      }),
      "pass",
    );

    // Missing .md file -> pass
    assert.equal(
      await env.handleLink({
        link: { kind: "file", raw: missingMd, path: missingMd },
        source: { terminal: "t1", machine: null, cwd: dir, pane: "p-1", tab: "tb-1", space: "sp-1" },
      }),
      "pass",
    );

    assert.equal(env.commands.length, 1, "pass-through links must not invoke Herdr commands");
    assert.equal(env.execCalls, 0);
    assert.equal(env.fetchCalls, 0);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("handleLink reuses an existing tab for the same file in the same space, isolates spaces, and prunes closed tabs", async () => {
  const dir = await mkdtemp(join(tmpdir(), "fm-md-reuse-"));
  try {
    const subDir = join(dir, "docs");
    await mkdir(subDir);
    const mdFile = join(subDir, "SPEC.MD");
    await writeFile(mdFile, "# Spec\n", "utf8");

    const spaces = [
      { id: "sp-1", active: true, machine: null, tabs: [{ id: "tb-term", name: "1", active: true }, { id: "tb-md-1", name: "SPEC.MD", active: false }] },
      { id: "sp-2", active: false, machine: null, tabs: [{ id: "tb-term-2", name: "1", active: true }] },
    ];
    const panes = [
      { pane: "p-term", terminal: "t1", tab: "tb-term", focused: true },
      { pane: "p-md-1", terminal: null, mod: "fm-md-viewer", tab: "tb-md-1", focused: false },
      { pane: "p-term-2", terminal: "t2", tab: "tb-term-2", focused: false },
    ];

    const env = await loadLinkHandler({
      spaces,
      panes,
      shared: {
        [stateHelpers.TABS_SHARED_KEY]: [
          { tab: "tb-closed", space: "sp-1", pane: "p-closed", file: mdFile },
          { tab: "tb-md-1", space: "sp-1", pane: "p-md-1", file: mdFile },
        ],
      },
    });

    // Clicking with a relative path that normalizes to the same file in sp-1 reuses tb-md-1.
    const rReuse = await env.handleLink({
      link: { kind: "file", raw: "./docs/../docs/SPEC.MD:12", path: "docs/../docs/SPEC.MD", line: 12 },
      source: { terminal: "t1", machine: null, cwd: dir, pane: "p-term", tab: "tb-term", space: "sp-1" },
    });
    assert.equal(rReuse, "handled");
    assert.deepEqual(env.commands, [
      { name: "tab.select", args: { id: "tb-md-1" } },
      { name: "pane.focus", args: { pane: "p-md-1" } },
    ]);
    assert.deepEqual(env.sharedStore.get(stateHelpers.TABS_SHARED_KEY), [
      { tab: "tb-md-1", space: "sp-1", pane: "p-md-1", file: mdFile },
    ], "stale closed tab entry is pruned");

    // Clicking the same file from a different space opens a new tab in sp-2 instead of jumping to sp-1.
    env.commands.length = 0;
    const rOtherSpace = await env.handleLink({
      link: { kind: "file", raw: mdFile, path: mdFile },
      source: { terminal: "t2", machine: null, cwd: dir, pane: "p-term-2", tab: "tb-term-2", space: "sp-2" },
    });
    assert.equal(rOtherSpace, "handled");
    assert.equal(env.commands.length, 1);
    assertViewerTabNew(env.commands[0], { space: "sp-2", file: mdFile, title: "SPEC.MD" });
    await publishAndRender(env.herdr);
    assert.deepEqual(env.sharedStore.get(stateHelpers.TABS_SHARED_KEY), [
      { tab: "tb-md-1", space: "sp-1", pane: "p-md-1", file: mdFile },
      { tab: "tb-new-1", space: "sp-2", pane: "p-new-1", file: mdFile },
    ], "the tab created by tab.new is recorded with its exact file path");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("handleLink passes through directories named *.md, binary files, control-char paths, null paths, and non-.md extensions like .mdx and .markdown", async () => {
  const dir = await mkdtemp(join(tmpdir(), "fm-md-edge-"));
  try {
    const dirNamedMd = join(dir, "folder.md");
    const binaryMd = join(dir, "binary.md");
    const mdxFile = join(dir, "page.mdx");
    const longExtMd = join(dir, "guide.markdown");
    const emptyMd = join(dir, "empty.md");
    await mkdir(dirNamedMd);
    await writeFile(binaryMd, Buffer.from([0x23, 0x20, 0x00, 0x41]));
    await writeFile(mdxFile, "# MDX\n<Widget />\n", "utf8");
    await writeFile(longExtMd, "# Guide\n", "utf8");
    await writeFile(emptyMd, "", "utf8");

    const env = await loadLinkHandler({
      spaces: [{ id: "sp-1", active: true, machine: null, tabs: [{ id: "tb-1", name: "1", active: true }] }],
      panes: [{ pane: "p-1", terminal: "t1", tab: "tb-1", focused: true }],
    });
    const src = { terminal: "t1", machine: null, cwd: dir, pane: "p-1", tab: "tb-1", space: "sp-1" };

    assert.equal(await env.handleLink({ link: { kind: "file", raw: dirNamedMd, path: dirNamedMd }, source: src }), "pass");
    assert.equal(await env.handleLink({ link: { kind: "file", raw: binaryMd, path: binaryMd }, source: src }), "pass");
    assert.equal(await env.handleLink({ link: { kind: "file", raw: mdxFile, path: mdxFile }, source: src }), "pass");
    assert.equal(await env.handleLink({ link: { kind: "file", raw: longExtMd, path: longExtMd }, source: src }), "pass");
    assert.equal(await env.handleLink({ link: { kind: "file", raw: "a.md", path: null }, source: src }), "pass");
    assert.equal(await env.handleLink({ link: { kind: "file", raw: "a.md\nrm -rf /", path: `${dir}/a.md\nrm` }, source: src }), "pass");
    assert.equal(env.commands.length, 0);

    // An existing empty .md file is still a valid local Markdown file and opens cleanly.
    assert.equal(await env.handleLink({ link: { kind: "file", raw: emptyMd, path: emptyMd }, source: src }), "handled");
    assert.equal(env.commands.length, 1);
    assertViewerTabNew(env.commands[0], { space: "sp-1", file: emptyMd, title: "empty.md" });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("layouts/firstmate.json and mods/fm-md-viewer/mod.json declare the Herdr link_handlers contract", async () => {
  const layoutJson = JSON.parse(await readFile(new URL("layouts/firstmate.json", rootUrl), "utf8"));
  assert.ok(Array.isArray(layoutJson.link_handlers), "layouts/firstmate.json must declare root link_handlers array");
  assert.ok(layoutJson.link_handlers.includes("fm-md-viewer"), "layouts/firstmate.json link_handlers must include fm-md-viewer");

  const modJson = JSON.parse(await readFile(new URL("mods/fm-md-viewer/mod.json", rootUrl), "utf8"));
  assert.equal(modJson.place, "none");
  assert.ok(Array.isArray(modJson.link_handlers) && modJson.link_handlers.length >= 1);
  const fileRule = modJson.link_handlers.find((r) => r.kind === "file");
  assert.ok(fileRule, "mod.json must declare a file link_handlers rule");
  const jsPattern = fileRule.pattern.replace(/^\(\?i\)/, "");
  const rx = new RegExp(jsPattern, fileRule.pattern.startsWith("(?i)") ? "i" : "");
  assert.equal(rx.test("/tmp/notes.md"), true);
  assert.equal(rx.test("/tmp/README.MD"), true);
  assert.equal(rx.test("/tmp/guide.markdown"), false);
  assert.equal(rx.test("/tmp/page.mdx"), false);
  assert.equal(rx.test("/tmp/notes.txt"), false);
});

test("FmMdViewer renders local Markdown via native TextView.markdown with raw_html(false) and leaves the shared tab registry alone", async () => {
  const dir = await mkdtemp(join(tmpdir(), "fm-md-view-"));
  try {
    const mdFile = join(dir, "architecture.md");
    await writeFile(mdFile, "# Architecture\n\n- Read-only view\n\n<script>alert(1)</script>\n", "utf8");

    const spaces = [{ id: "sp-1", active: true, machine: null, tabs: [{ id: "tb-md", name: "architecture.md", active: true }] }];
    const panes = [{ pane: "p-md", terminal: null, mod: "fm-md-viewer", tab: "tb-md", focused: true }];

    const env = await loadMdViewer({
      props: { file: mdFile },
      spaces,
      panes,
    });

    const first = env.render();
    assert.equal(first.textViews.length, 1, "must render one native TextView.markdown");
    assert.equal(first.textViews[0].props.raw_html, false, "must disable raw HTML in TextView.markdown");
    assert.equal(first.textViews[0].props.selectable, true, "rendered Markdown must be selectable");
    assert.match(first.textViews[0].props.markdown, /# Architecture/);
    assert.match(first.text, /architecture\.md/);
    assert.match(first.text, /Read-only/);
    assert.equal(env.sharedStore.has(stateHelpers.TABS_SHARED_KEY), false, "the view never registers itself");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("FmMdViewer skips side effects during herdr-app check and handles missing or empty files gracefully", async () => {
  const dir = await mkdtemp(join(tmpdir(), "fm-md-check-"));
  try {
    const checkEnv = await loadMdViewer({ checking: true, props: {} });
    assert.equal(checkEnv.readCalls, 0, "checking() must skip file reads");
    const checkRendered = checkEnv.render();
    assert.equal(checkRendered.textViews.length, 0);
    assert.match(checkRendered.text, /No Markdown file/i);

    const missingPath = join(dir, "gone.md");
    const missingEnv = await loadMdViewer({ props: { file: missingPath } });
    const missingRendered = missingEnv.render();
    assert.equal(missingRendered.textViews.length, 0);
    assert.match(missingRendered.text, /no longer available/i);

    const emptyPath = join(dir, "blank.md");
    await writeFile(emptyPath, "", "utf8");
    const emptyEnv = await loadMdViewer({ props: { file: emptyPath } });
    const emptyRendered = emptyEnv.render();
    assert.equal(emptyRendered.textViews.length, 0);
    assert.match(emptyRendered.text, /Empty Markdown file/i);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("link.js expands ~/ paths", async () => {
  const dir = await mkdtemp(join(tmpdir(), "fm-md-home-"));
  try {
    const mdFile = join(dir, "notes.md");
    await writeFile(mdFile, "# Notes\n", "utf8");

    const linkEnv = await loadLinkHandler({
      homeDir: dir,
      spaces: [{ id: "sp-1", active: true, machine: null, tabs: [{ id: "tb-1", name: "1", active: true }] }],
      panes: [{ pane: "p-1", terminal: "t1", tab: "tb-1", focused: true }],
    });
    const res = await linkEnv.handleLink({
      link: { kind: "file", raw: "~/notes.md", path: "~/notes.md" },
      source: { terminal: "t1", machine: null, cwd: "/tmp", pane: "p-1", tab: "tb-1", space: "sp-1" },
    });
    assert.equal(res, "handled");
    assert.equal(linkEnv.commands[0].args.props.file, mdFile);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("same-basename files in different folders get separate tabs that survive a restart without swapping", async () => {
  const dir = await mkdtemp(join(tmpdir(), "fm-md-basename-"));
  try {
    const readmeA = join(dir, "a", "README.md");
    const readmeB = join(dir, "b", "README.md");
    await mkdir(join(dir, "a"));
    await mkdir(join(dir, "b"));
    await writeFile(readmeA, "# A\n", "utf8");
    await writeFile(readmeB, "# B\n", "utf8");

    const herdr = fakeHerdr({
      spaces: [{ id: "sp-1", active: true, machine: null, tabs: [{ id: "tb-term", name: "1", active: true }] }],
      panes: [{ pane: "p-term", terminal: "t1", tab: "tb-term", focused: true }],
    });
    const src = { terminal: "t1", machine: null, cwd: dir, pane: "p-term", tab: "tb-term", space: "sp-1" };
    const click = (path) => ({ link: { kind: "file", raw: path, path }, source: src });

    const before = await loadLinkHandler({ herdr });
    assert.equal(await before.handleLink(click(readmeA)), "handled");
    assert.equal(await before.handleLink(click(readmeB)), "handled");
    assert.deepEqual(herdr.commands.map((c) => c.name), ["tab.new", "tab.new"], "same basename, different path: two tabs");
    await publishAndRender(herdr);

    const registry = herdr.sharedStore.get(stateHelpers.TABS_SHARED_KEY);
    assert.deepEqual(registry, [
      { tab: "tb-new-1", space: "sp-1", pane: "p-new-1", file: readmeA },
      { tab: "tb-new-2", space: "sp-1", pane: "p-new-2", file: readmeB },
    ]);
    assert.equal(herdr.tabName("tb-new-1"), "README.md");
    assert.equal(herdr.tabName("tb-new-2"), "README.md");

    // Restart: Herdr restores both viewer tabs and the persisted shared registry, then creates
    // each restored view again with its saved props, and both views close on the next quit.
    for (const tab of ["tb-new-1", "tb-new-2"]) {
      const viewEnv = await loadMdViewer({ herdr, props: herdr.viewProps.get(tab) });
      viewEnv.render();
      viewEnv.view.close?.();
    }
    assert.deepEqual(herdr.sharedStore.get(stateHelpers.TABS_SHARED_KEY), registry, "restored views and app quit leave the registry intact");

    herdr.commands.length = 0;
    const after = await loadLinkHandler({ herdr });
    assert.equal(await after.handleLink(click(readmeA)), "handled");
    assert.deepEqual(herdr.commands, [
      { name: "tab.select", args: { id: "tb-new-1" } },
      { name: "pane.focus", args: { pane: "p-new-1" } },
    ], "clicking a/README.md after restart reuses its own tab, not b/README.md's");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("a new tab is recorded only once Herdr publishes it, and repeat clicks while it opens do not open more tabs", async () => {
  const dir = await mkdtemp(join(tmpdir(), "fm-md-pending-"));
  try {
    const mdFile = join(dir, "guide.md");
    await writeFile(mdFile, "# Guide\n", "utf8");

    // An unregistered viewer tab with the same tab name already exists (for example a restored
    // tab for another guide.md); nothing may bind this click to it.
    const herdr = fakeHerdr({
      spaces: [{ id: "sp-1", active: true, machine: null, tabs: [
        { id: "tb-term", name: "1", active: true },
        { id: "tb-other", name: "guide.md", active: false },
      ] }],
      panes: [
        { pane: "p-term", terminal: "t1", tab: "tb-term", focused: true },
        { pane: "p-other", terminal: null, mod: "fm-md-viewer", tab: "tb-other", focused: false },
      ],
    });
    const env = await loadLinkHandler({ herdr });
    const src = { terminal: "t1", machine: null, cwd: dir, pane: "p-term", tab: "tb-term", space: "sp-1" };
    const click = () => env.handleLink({ link: { kind: "file", raw: mdFile, path: mdFile }, source: src });

    assert.equal(await click(), "handled");
    assert.equal(await click(), "handled");
    assert.equal(await click(), "handled");
    assert.deepEqual(herdr.commands.map((c) => c.name), ["tab.new"], "repeat clicks before the tab is published open no more tabs");
    assert.equal(herdr.sharedStore.has(stateHelpers.TABS_SHARED_KEY), false, "nothing is recorded before Herdr publishes the tab");

    // The view of the unrelated restored tab renders while the new tab is still unpublished.
    const otherView = await loadMdViewer({ herdr, props: { file: join(dir, "other", "guide.md") } });
    otherView.render();
    assert.equal(herdr.sharedStore.has(stateHelpers.TABS_SHARED_KEY), false);

    await publishAndRender(herdr);
    assert.deepEqual(herdr.sharedStore.get(stateHelpers.TABS_SHARED_KEY), [
      { tab: "tb-new-1", space: "sp-1", pane: "p-new-1", file: mdFile },
    ]);
    assert.equal(herdr.tabName("tb-new-1"), "guide.md", "the tab ends up named after the file");

    herdr.commands.length = 0;
    assert.equal(await click(), "handled");
    assert.deepEqual(herdr.commands, [
      { name: "tab.select", args: { id: "tb-new-1" } },
      { name: "pane.focus", args: { pane: "p-new-1" } },
    ]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("an open Herdr never publishes stops blocking new clicks after the pending window", async () => {
  const dir = await mkdtemp(join(tmpdir(), "fm-md-expire-"));
  try {
    const mdFile = join(dir, "guide.md");
    await writeFile(mdFile, "# Guide\n", "utf8");
    const herdr = fakeHerdr({
      spaces: [{ id: "sp-1", active: true, machine: null, tabs: [{ id: "tb-term", name: "1", active: true }] }],
      panes: [{ pane: "p-term", terminal: "t1", tab: "tb-term", focused: true }],
    });
    const env = await loadLinkHandler({ herdr });
    const src = { terminal: "t1", machine: null, cwd: dir, pane: "p-term", tab: "tb-term", space: "sp-1" };
    const click = () => env.handleLink({ link: { kind: "file", raw: mdFile, path: mdFile }, source: src });

    assert.equal(await click(), "handled");
    herdr.queued.length = 0;
    herdr.now += stateHelpers.PENDING_TTL_MS;
    assert.equal(await click(), "handled");
    assert.deepEqual(herdr.commands.map((c) => c.name), ["tab.new", "tab.new"]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("concurrent clicks: a slow read of one file does not prune or steal the tab another click opened", async () => {
  const dir = await mkdtemp(join(tmpdir(), "fm-md-race-"));
  try {
    const slowMd = join(dir, "slow.md");
    const fastMd = join(dir, "fast.md");
    await writeFile(slowMd, "# Slow\n", "utf8");
    await writeFile(fastMd, "# Fast\n", "utf8");

    let releaseSlow;
    const slowGate = new Promise((resolve) => { releaseSlow = resolve; });
    const herdr = fakeHerdr({
      spaces: [{ id: "sp-1", active: true, machine: null, tabs: [{ id: "tb-term", name: "1", active: true }] }],
      panes: [{ pane: "p-term", terminal: "t1", tab: "tb-term", focused: true }],
    });
    const env = await loadLinkHandler({
      herdr,
      readTextFile: async (p) => {
        if (p === slowMd) await slowGate;
        return fsReadTextFile(p);
      },
    });
    const src = { terminal: "t1", machine: null, cwd: dir, pane: "p-term", tab: "tb-term", space: "sp-1" };
    const click = (path) => ({ link: { kind: "file", raw: path, path }, source: src });

    const slowResult = env.handleLink(click(slowMd));
    assert.equal(await env.handleLink(click(fastMd)), "handled");
    await publishAndRender(herdr);
    releaseSlow();
    assert.equal(await slowResult, "handled");
    await publishAndRender(herdr);

    assert.deepEqual(herdr.sharedStore.get(stateHelpers.TABS_SHARED_KEY), [
      { tab: "tb-new-1", space: "sp-1", pane: "p-new-1", file: fastMd },
      { tab: "tb-new-2", space: "sp-1", pane: "p-new-2", file: slowMd },
    ], "each file maps to the tab opened for it");
    assert.deepEqual(herdr.sharedStore.get(stateHelpers.PENDING_SHARED_KEY), [], "bound opens leave the pending list");

    herdr.commands.length = 0;
    assert.equal(await env.handleLink(click(slowMd)), "handled");
    assert.deepEqual(herdr.commands, [
      { name: "tab.select", args: { id: "tb-new-2" } },
      { name: "pane.focus", args: { pane: "p-new-2" } },
    ]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
