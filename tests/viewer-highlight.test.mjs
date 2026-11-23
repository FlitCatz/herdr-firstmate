import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import vm from "node:vm";
import * as highlight from "../mods/fm-board/highlight.js";

const {
  HIGHLIGHT_SYNC_MAX,
  MAX_LINE_SPANS,
  DiffHighlighter,
  capLineSpans,
  detectLanguage,
  editorSyntax,
  highlightLine,
  syntaxColor,
  tint,
} = highlight;

const rootUrl = new URL("..", import.meta.url);

const THEME = {
  background: "#111214",
  surface: "#181a1f",
  raised: "#20232a",
  selected: "#282c34",
  hover: "#2c313c",
  border: "#343942",
  foreground: "#e6edf3",
  muted: "#9aa5b1",
  dim: "#6b7280",
  accent: "#58a6ff",
  blocked: "#f85149",
  ansi1: "#ff7b72",
  ansi2: "#3fb950",
  ansi3: "#d29922",
  ansi4: "#79c0ff",
  ansi5: "#d2a8ff",
  ansi6: "#56d4dd",
};

const LIGHT_THEME = {
  ...THEME,
  background: "#ffffff",
  foreground: "#1f2328",
  dim: "#8c959f",
  ansi1: "#cf222e",
  ansi2: "#116329",
  ansi3: "#4d2d00",
  ansi4: "#0969da",
  ansi5: "#8250df",
  ansi6: "#1b7c83",
};

// The herdr-pr-viewer README token table, spelled out with the EditorState `syntax` keys.
const expectedEditorSyntax = (t) => ({
  keyword: t.ansi5,
  string: t.ansi2,
  comment: t.dim,
  function: t.ansi4,
  type: t.ansi3,
  number: t.ansi1,
  constant: t.ansi6,
  boolean: t.ansi6,
  "string.escape": t.ansi6,
  variable: t.foreground,
  operator: t.foreground,
  punctuation: t.foreground,
});

function element() {
  const node = { id: null, kind: "div", click: null, kids: [], props: {} };
  const self = new Proxy(node, {
    get(target, name) {
      if (name === "node") return target;
      return (...args) => {
        if (name === "id") target.id = args[0];
        else if (name === "on_click") target.click = args[0];
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

function collectText(node) {
  if (node === null || node === undefined) return "";
  if (typeof node !== "object") return String(node);
  return (node.node?.kids ?? []).map(collectText).join("");
}

function findColor(node, word) {
  if (!node || typeof node !== "object") return null;
  const kids = node.node?.kids ?? [];
  if (kids.includes(word) && node.node?.props?.text_color) return node.node.props.text_color;
  for (const k of kids) {
    const hit = findColor(k, word);
    if (hit) return hit;
  }
  return null;
}

function findEditorState(node) {
  if (!node || typeof node !== "object") return null;
  if (node.node?.props?.editor) return node.node.props.editor;
  for (const k of node.node?.kids ?? []) {
    const hit = findEditorState(k);
    if (hit) return hit;
  }
  return null;
}

function hasHighlightedSpans(node) {
  if (!node || typeof node !== "object") return false;
  if (node.node?.props?.whitespace_nowrap !== undefined && node.node?.props?.text_color !== undefined) return true;
  return (node.node?.kids ?? []).some(hasHighlightedSpans);
}

async function createHighlightedViewer({ exec, readTextFile, virtualRanges } = {}) {
  const source = (await readFile(new URL("mods/fm-board/viewer.js", rootUrl), "utf8"))
    .replace(/^import .*;$/gm, "")
    .replace("export class FolderViewer", "class FolderViewer");
  const vlists = [];
  const timers = [];
  const editors = [];
  let notifyCount = 0;
  let inFlight = 0;
  const track = (fn) => async (...args) => {
    inFlight++;
    try { return await fn(...args); }
    finally { inFlight--; }
  };
  const cx = {
    notify() { notifyCount++; },
    spawn(fn) { return Promise.resolve().then(() => fn(cx)); },
    timer: {
      after(ms, fn) {
        const entry = { ms, fn, cancelled: false, fired: false };
        timers.push(entry);
        return { cancel() { entry.cancelled = true; } };
      },
    },
  };
  const scope = {
    div: element,
    svg: element,
    v_flex: element,
    h_flex: element,
    Editor: {
      new: (state) => {
        const el = element();
        el.editor(state);
        return el;
      },
    },
    EditorState: {
      new: (opts) => {
        const state = { opts, released: false, release() { state.released = true; return true; } };
        editors.push(state);
        return state;
      },
    },
    Scrollbar: { vertical: () => element() },
    v_virtual_list: (id, count, size, getKey, renderRange) => {
      const range = virtualRanges?.[id] ?? { start: 0, end: count };
      const rendered = count > 0 ? renderRange({ start: range.start, end: Math.min(count, range.end) }, cx) : [];
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
    exec: track(exec),
    readTextFile: track(readTextFile),
    ...highlight,
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
  const tickNext = () => {
    const next = timers.find((t) => !t.cancelled && !t.fired);
    if (!next) return false;
    next.fired = true;
    next.fn(cx);
    return true;
  };
  const render = (theme = THEME) => {
    vlists.length = 0;
    const tree = view.render(theme, (px) => px, []);
    return { tree, vlists: [...vlists] };
  };
  return { view, cx, timers, editors, tickNext, render, settle, getNotifyCount: () => notifyCount };
}

test("detectLanguage maps supported extensions and dotfiles and falls back to plain", () => {
  assert.equal(detectLanguage("src/Api/Auth.cs"), "csharp");
  assert.equal(detectLanguage("scripts/seed.csx"), "csharp");
  assert.equal(detectLanguage("mods/main.ts"), "ts");
  assert.equal(detectLanguage("mods/App.tsx"), "ts");
  assert.equal(detectLanguage("mods/util.mts"), "ts");
  assert.equal(detectLanguage("mods/view.jsx"), "ts");
  assert.equal(detectLanguage("mods/index.mjs"), "ts");
  assert.equal(detectLanguage("lib/app.dart"), "dart");
  assert.equal(detectLanguage("crates/pk/src/lib.rs"), "rust");
  assert.equal(detectLanguage("package.json"), "json");
  assert.equal(detectLanguage("tsconfig.jsonc"), "json");
  assert.equal(detectLanguage(".github/workflows/ci.yml"), "yaml");
  assert.equal(detectLanguage("config/app.yaml"), "yaml");
  assert.equal(detectLanguage("README.md"), "markdown");
  assert.equal(detectLanguage("docs/guide.mdx"), "markdown");
  assert.equal(detectLanguage("bin/fm-spawn.sh"), "shell");
  assert.equal(detectLanguage(".zshrc"), "shell");
  assert.equal(detectLanguage(".bashrc"), "shell");
  assert.equal(detectLanguage("assets/logo.png"), "plain");
  assert.equal(detectLanguage("Makefile"), "plain");
  assert.equal(detectLanguage(""), "plain");
});

test("syntaxColor and editorSyntax map every token kind to the Herdr theme token table and tint appends hex alpha", () => {
  assert.equal(syntaxColor(THEME, "keyword"), THEME.ansi5);
  assert.equal(syntaxColor(THEME, "string"), THEME.ansi2);
  assert.equal(syntaxColor(THEME, "comment"), THEME.dim);
  assert.equal(syntaxColor(THEME, "number"), THEME.ansi1);
  assert.equal(syntaxColor(THEME, "type"), THEME.ansi3);
  assert.equal(syntaxColor(THEME, "function"), THEME.ansi4);
  assert.equal(syntaxColor(THEME, "constant"), THEME.ansi6);
  assert.equal(syntaxColor(THEME, "plain"), THEME.foreground);
  assert.deepEqual(editorSyntax(THEME), expectedEditorSyntax(THEME));
  assert.deepEqual(editorSyntax(LIGHT_THEME), expectedEditorSyntax(LIGHT_THEME));

  assert.equal(tint("#3fb950", "1c"), "#3fb9501c");
  assert.equal(tint("#f85149", "1a"), "#f851491a");
  assert.equal(tint("#3fb95080", "1c"), "#3fb95080");
});

test("highlightLine tokenizes C#, TypeScript, Markdown, Dart, Rust, JSON, YAML, shell, and plain", () => {
  const cs = highlightLine('public sealed record AuthResult(int Code = 0x10) => "ok"; // hi', "csharp").spans;
  assert.ok(cs.some((s) => s.kind === "keyword" && s.text === "public"));
  assert.ok(cs.some((s) => s.kind === "keyword" && s.text === "record"));
  assert.ok(cs.some((s) => s.kind === "type" && s.text === "int"));
  assert.ok(cs.some((s) => s.kind === "function" && s.text === "AuthResult"));
  assert.ok(cs.some((s) => s.kind === "number" && s.text === "0x10"));
  assert.ok(cs.some((s) => s.kind === "string" && s.text === '"ok"'));
  assert.ok(cs.some((s) => s.kind === "comment" && s.text === "// hi"));

  const ts = highlightLine("export async function fetchUser(id: number): Promise<UserRecord> { return 42; }", "ts").spans;
  assert.deepEqual(
    ts.filter((s) => s.kind !== "plain").map((s) => [s.kind, s.text]),
    [
      ["keyword", "export"],
      ["keyword", "async"],
      ["keyword", "function"],
      ["function", "fetchUser"],
      ["type", "number"],
      ["type", "Promise"],
      ["type", "UserRecord"],
      ["keyword", "return"],
      ["number", "42"],
    ],
  );

  assert.deepEqual(highlightLine("## Heading", "markdown").spans, [{ kind: "keyword", text: "## Heading" }]);
  assert.deepEqual(highlightLine("```ts", "markdown").spans, [{ kind: "comment", text: "```ts" }]);
  const md = highlightLine("- See `main.js` and [README](README.md)", "markdown").spans;
  assert.ok(md.some((s) => s.kind === "type" && s.text === "- "));
  assert.ok(md.some((s) => s.kind === "string" && s.text === "`main.js`"));
  assert.ok(md.some((s) => s.kind === "function" && s.text === "README"));
  assert.ok(md.some((s) => s.kind === "string" && s.text === "README.md"));

  const rust = highlightLine("pub fn parse<'a>(s: &'a str) -> Option<usize> { None }", "rust").spans;
  assert.ok(rust.some((s) => s.kind === "type" && s.text === "'a"));
  assert.ok(rust.some((s) => s.kind === "constant" && s.text === "None"));
  assert.equal(rust.some((s) => s.kind === "string"), false);

  const yaml = highlightLine("  timeout: 30 # seconds", "yaml").spans;
  assert.deepEqual(
    yaml.filter((s) => s.kind !== "plain").map((s) => [s.kind, s.text]),
    [["constant", "timeout"], ["number", "30"], ["comment", "# seconds"]],
  );
});

test("DiffHighlighter produces chunk-consistent spans and capLineSpans caps excessive spans", () => {
  const addedRows = Array.from({ length: 200 }, (_, i) => {
    if (i === 78) return { kind: "+", text: "/* multi-line" };
    if (i === 79) return { kind: "+", text: " * across chunk" };
    if (i === 80) return { kind: "+", text: " * still comment" };
    if (i === 81) return { kind: "+", text: " */" };
    return { kind: "+", text: `const x_${i}: number = calc(${i}, "v${i}");` };
  });
  const oneShot = structuredClone(new DiffHighlighter().highlight("src/app.ts", "k1", addedRows, addedRows.length));
  const chunked = new DiffHighlighter();
  let chunkedRes = [];
  for (let limit = 40; limit <= addedRows.length + 40; limit += 40) {
    chunkedRes = chunked.highlight("src/app.ts", "k1", addedRows, limit);
  }
  assert.deepEqual(chunkedRes, oneShot);
  assert.deepEqual(oneShot[80], [{ kind: "comment", text: " * still comment" }]);

  const diffRows = [
    { kind: "@", text: "@@ -1,3 +1,3 @@" },
    { kind: "-", text: "/* old comment" },
    { kind: "+", text: "const ok = true;" },
    { kind: " ", text: "render();" },
  ];
  const diffRes = new DiffHighlighter().highlight("a.ts", "p1", diffRows, diffRows.length);
  assert.equal(diffRes[0], null);
  assert.equal(diffRes[1]?.[0].kind, "comment");
  assert.ok(diffRes[2]?.some((s) => s.kind === "keyword" && s.text === "const"));
  assert.ok(diffRes[3]?.some((s) => s.kind === "function" && s.text === "render"));

  const manySpans = Array.from({ length: 120 }, (_, i) => ({ kind: /** @type {const} */ ("function"), text: `f${i}()` }));
  const capped = capLineSpans(manySpans);
  assert.ok(capped);
  assert.equal(capped.length, MAX_LINE_SPANS);
  assert.equal(capped.at(-1)?.kind, "plain");
  assert.equal(capLineSpans([{ kind: "plain", text: "hello" }]), null);
});

test("FolderViewer highlights Files view and Changes view with Herdr theme tokens and added/removed backgrounds", async () => {
  const sampleTs = [
    'import { readFile } from "node:fs";',
    "export async function loadCount(limit: number): Promise<number> {",
    '  const ok = true; // ready',
    "  return limit + 42;",
    "}",
  ].join("\n");
  const samplePatch = [
    "@@ -1,3 +1,3 @@",
    "-const oldVal = 1;",
    "+const newVal: number = compute(2); // added",
    ' return "done";',
  ].join("\n");

  const v = await createHighlightedViewer({
    exec: async (cmd, args = []) => {
      if (cmd === "sh") {
        if (args[2] === "safe-path") return { code: 0, stdout: "", stderr: "" };
        return { code: 0, stdout: "f\0app.ts\0", stderr: "" };
      }
      if (cmd === "git") {
        if (args.includes("--show-toplevel")) return { code: 0, stdout: "/repo\n\n", stderr: "" };
        if (args.includes("status")) return { code: 0, stdout: " M app.ts\0", stderr: "" };
        if (args.includes("--verify")) return { code: 0, stdout: "deadbeef\n", stderr: "" };
        if (args.includes("--numstat")) return { code: 0, stdout: "1\t1\tapp.ts\0", stderr: "" };
        if (args.includes("diff")) return { code: 0, stdout: `${samplePatch}\n`, stderr: "" };
      }
      return { code: 1, stdout: "", stderr: "" };
    },
    readTextFile: async () => sampleTs,
  });

  v.view.target("/repo", "repo", v.cx);
  await v.settle();

  // Files view opens the file in a read-only Editor colored from the theme token table.
  v.view.tab = "files";
  v.view.showFile("app.ts", v.cx, THEME);
  await v.settle();
  assert.equal(v.editors.length, 1);
  const [darkState] = v.editors;
  assert.equal(darkState.opts.readonly, true);
  assert.equal(darkState.opts.language, "js");
  assert.equal(darkState.opts.value, sampleTs);
  assert.deepEqual(darkState.opts.syntax, expectedEditorSyntax(THEME));

  let rendered = v.render();
  assert.equal(findEditorState(rendered.tree), darkState, "Files view renders the Editor for the open file");

  // Rendering never creates or releases editor state, so a theme switch keeps the open file's editor.
  rendered = v.render(LIGHT_THEME);
  assert.equal(v.editors.length, 1, "render must not create editor state");
  assert.equal(darkState.released, false, "render must not release editor state");
  assert.equal(findEditorState(rendered.tree), darkState);

  // The next file opened under the light theme gets the light colors, and C# uses "cs" for Herdr's grammar set.
  v.view.showFile("AuthService.cs", v.cx, LIGHT_THEME);
  await v.settle();
  assert.equal(v.editors.length, 2);
  const lightState = v.editors[1];
  assert.equal(darkState.released, true, "opening another file releases the previous editor state");
  assert.equal(lightState.opts.value, sampleTs);
  assert.equal(lightState.opts.language, "cs");
  assert.deepEqual(lightState.opts.syntax, expectedEditorSyntax(LIGHT_THEME));
  assert.equal(findEditorState(v.render(LIGHT_THEME).tree), lightState);

  // Changes view highlights synchronously for small diffs with ansi2+"1c" and blocked+"1a" line tints.
  v.view.tab = "changes";
  rendered = v.render();
  const diffList = rendered.vlists.find((x) => x.id === "vc-diff");
  assert.ok(diffList, "Changes view renders diff rows");
  assert.equal(diffList.rendered[0].node.props.bg, THEME.raised);
  assert.equal(diffList.rendered[1].node.props.bg, "#f851491a");
  assert.equal(findColor(diffList.rendered[1].node.kids[1], "const"), THEME.ansi5);
  assert.equal(findColor(diffList.rendered[1].node.kids[1], "1"), THEME.ansi1);
  assert.equal(diffList.rendered[2].node.props.bg, "#3fb9501c");
  assert.equal(findColor(diffList.rendered[2], "const"), THEME.ansi5);
  assert.equal(findColor(diffList.rendered[2], "compute"), THEME.ansi4);
  assert.equal(findColor(diffList.rendered[2], "// added"), THEME.dim);
  assert.equal(findColor(diffList.rendered[3], '"done"'), THEME.ansi2);
  assert.equal(collectText(diffList.rendered[3]).includes('"done"'), true);
});

test("FolderViewer defers diff highlighting after the first 160 rows in bounded 80-row chunks", async () => {
  const bigLines = Array.from({ length: 360 }, (_, i) => {
    if (i === 158) return "/* comment across sync boundary";
    if (i === 160) return " * still in block comment";
    if (i === 162) return " */";
    return `const v_${i}: number = calc(${i}, "s${i}"); // c${i}`;
  });
  const bigPatch = `@@ -1,0 +1,360 @@\n${bigLines.map((l) => `+${l}`).join("\n")}`;

  const v = await createHighlightedViewer({ exec: bigDiffExec(bigPatch), readTextFile: async () => "" });

  v.view.target("/repo", "repo", v.cx);
  await v.settle();

  // Large diff: the hunk row plus rows 1..159 highlight synchronously; row 200 starts plain, then highlights in chunks.
  v.view.tab = "changes";
  let diffRows = renderedDiff(v);
  assert.equal(hasHighlightedSpans(diffRows[1]), true, "early diff row highlighted synchronously");
  assert.equal(hasHighlightedSpans(diffRows[159]), true, "row 159 (within first 160) highlighted synchronously");
  assert.equal(hasHighlightedSpans(diffRows[200]), false, "row 200 deferred beyond sync cap");
  assert.equal(diffRows[200].node.props.bg, "#3fb9501c", "deferred added row keeps line background tint");

  // One chunk (80 rows: 160..239) highlights row 200 while row 300 stays plain.
  assert.equal(v.tickNext(), true);
  diffRows = renderedDiff(v);
  assert.equal(hasHighlightedSpans(diffRows[200]), true, "row 200 highlighted after first chunk tick");
  assert.equal(findColor(diffRows[161], " * still in block comment"), THEME.dim, "block comment state preserved across sync/chunk boundary");
  assert.equal(hasHighlightedSpans(diffRows[300]), false, "row 300 waits for next chunk tick");

  // Switching files mid-chunk cancels the old diff timer cleanly.
  v.view.pickChange("small.ts", v.cx);
  await v.settle();
  assert.equal(v.tickNext(), false, "switching to small diff leaves no active chunk timer from big.ts");

  // Reopening the big diff highlights the rest in 80-row chunks.
  v.view.pickChange("big.ts", v.cx);
  await v.settle();
  let chunkSteps = 0;
  while (v.tickNext()) chunkSteps++;
  assert.equal(chunkSteps, Math.ceil((361 - HIGHLIGHT_SYNC_MAX) / 80), "361 diff rows highlight in bounded 80-row chunks");
  diffRows = renderedDiff(v);
  assert.equal(findColor(diffRows[351], "const"), THEME.ansi5);
  assert.equal(findColor(diffRows[351], "calc"), THEME.ansi4);

  // Closing the viewer mid-chunk cancels any pending diff highlight timer.
  v.view.target("/repo2", "repo2", v.cx);
  await v.settle();
  v.view.close(v.cx);
  assert.equal(v.tickNext(), false, "closing viewer cancels active diff highlight timer");
});

test("a Changes refresh with an unchanged diff keeps highlighting the rest of a large diff", async () => {
  const bigPatch = `@@ -1,0 +1,400 @@\n${Array.from({ length: 400 }, (_, i) => `+const v_${i} = calc(${i});`).join("\n")}`;
  const v = await createHighlightedViewer({ exec: bigDiffExec(bigPatch), readTextFile: async () => "" });
  v.view.target("/repo", "repo", v.cx);
  await v.settle();
  v.view.tab = "changes";
  assert.equal(v.view.open, "big.ts");
  assert.equal(hasHighlightedSpans(renderedDiff(v)[350]), false, "row 350 is deferred at first");

  // The folder watch or the Board's 10-second timer refreshes Changes while chunks are pending.
  v.view.refreshChanges(v.cx);
  await v.settle();
  while (v.tickNext());

  const diffRows = renderedDiff(v);
  assert.equal(hasHighlightedSpans(diffRows[250]), true, "row 250 is highlighted after the refresh");
  assert.equal(findColor(diffRows[400], "calc"), THEME.ansi4, "the last row is highlighted after the refresh");
});

function renderedDiff(v) {
  return v.render().vlists.find((x) => x.id === "vc-diff").rendered;
}

function bigDiffExec(bigPatch) {
  return async (cmd, args = []) => {
    if (cmd === "sh") {
      if (args[2] === "safe-path") return { code: 0, stdout: "", stderr: "" };
      return { code: 0, stdout: "f\0big.ts\0f\0small.ts\0", stderr: "" };
    }
    if (cmd === "git") {
      if (args.includes("--show-toplevel")) return { code: 0, stdout: "/repo\n\n", stderr: "" };
      if (args.includes("status")) return { code: 0, stdout: " M big.ts\0 M small.ts\0", stderr: "" };
      if (args.includes("--verify")) return { code: 0, stdout: "deadbeef\n", stderr: "" };
      if (args.includes("--numstat")) return { code: 0, stdout: "360\t0\tbig.ts\0", stderr: "" };
      if (args.includes("diff")) {
        const path = args.at(-1);
        return { code: 0, stdout: path === "small.ts" ? "@@ -1 +1 @@\n+const s = 1;\n" : `${bigPatch}\n`, stderr: "" };
      }
    }
    return { code: 1, stdout: "", stderr: "" };
  };
}
