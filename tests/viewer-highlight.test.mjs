import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import vm from "node:vm";
import {
  HIGHLIGHT_CHUNK,
  HIGHLIGHT_SYNC_MAX,
  MAX_LINE_SPANS,
  DiffHighlighter,
  FileHighlighter,
  capLineSpans,
  detectLanguage,
  highlightLine,
  syntaxColor,
  tint,
} from "../mods/fm-board/highlight.js";

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
    HIGHLIGHT_SYNC_MAX,
    HIGHLIGHT_CHUNK,
    MAX_LINE_SPANS,
    capLineSpans,
    detectLanguage,
    DiffHighlighter,
    FileHighlighter,
    syntaxColor,
    tint,
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
  const render = () => {
    vlists.length = 0;
    const tree = view.render(THEME, (px) => px, []);
    return { tree, vlists: [...vlists] };
  };
  return { view, cx, timers, tickNext, render, settle, getNotifyCount: () => notifyCount };
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

test("syntaxColor maps every token kind to the Herdr theme token table and tint appends hex alpha", () => {
  assert.equal(syntaxColor(THEME, "keyword"), THEME.ansi5);
  assert.equal(syntaxColor(THEME, "string"), THEME.ansi2);
  assert.equal(syntaxColor(THEME, "comment"), THEME.dim);
  assert.equal(syntaxColor(THEME, "number"), THEME.ansi1);
  assert.equal(syntaxColor(THEME, "type"), THEME.ansi3);
  assert.equal(syntaxColor(THEME, "function"), THEME.ansi4);
  assert.equal(syntaxColor(THEME, "constant"), THEME.ansi6);
  assert.equal(syntaxColor(THEME, "plain"), THEME.foreground);

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

test("FileHighlighter and DiffHighlighter produce chunk-consistent spans and cap excessive spans", () => {
  const fileLines = Array.from({ length: 200 }, (_, i) => {
    if (i === 78) return "/* multi-line";
    if (i === 79) return " * across chunk";
    if (i === 80) return " * still comment";
    if (i === 81) return " */";
    return `const x_${i}: number = calc(${i}, "v${i}");`;
  });
  const oneShotFile = new FileHighlighter().highlight("src/app.ts", "k1", fileLines, fileLines.length);
  const chunkedFile = new FileHighlighter();
  assert.equal(chunkedFile.cached("src/app.ts", "k1"), null);
  for (let limit = 40; limit <= fileLines.length + 40; limit += 40) {
    chunkedFile.highlight("src/app.ts", "k1", fileLines, limit);
  }
  assert.deepEqual(chunkedFile.cached("src/app.ts", "k1"), oneShotFile);

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

  // Files view highlights synchronously for small files and preserves code.value.
  v.view.tab = "files";
  v.view.showFile("app.ts", v.cx, THEME);
  await v.settle();
  assert.equal(v.view.code?.value, sampleTs);
  assert.equal(v.timers.length, 0, "small file must not schedule chunk timers");

  let rendered = v.render();
  const codeList = rendered.vlists.find((x) => x.id === "vf-code");
  assert.ok(codeList, "Files view renders virtualized code lines");
  assert.equal(findColor(codeList.rendered[0], "import"), THEME.ansi5);
  assert.equal(findColor(codeList.rendered[0], '"node:fs"'), THEME.ansi2);
  assert.equal(findColor(codeList.rendered[1], "loadCount"), THEME.ansi4);
  assert.equal(findColor(codeList.rendered[1], "number"), THEME.ansi3);
  assert.equal(findColor(codeList.rendered[2], "true"), THEME.ansi6);
  assert.equal(findColor(codeList.rendered[2], "// ready"), THEME.dim);
  assert.equal(findColor(codeList.rendered[3], "42"), THEME.ansi1);

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

test("FolderViewer defers highlighting after first 160 rows in bounded chunks for large files and diffs", async () => {
  const bigLines = Array.from({ length: 360 }, (_, i) => {
    if (i === 158) return "/* comment across sync boundary";
    if (i === 160) return " * still in block comment";
    if (i === 162) return " */";
    return `const v_${i}: number = calc(${i}, "s${i}"); // c${i}`;
  });
  const bigText = bigLines.join("\n");
  const bigPatch = `@@ -1,0 +1,360 @@\n${bigLines.map((l) => `+${l}`).join("\n")}`;

  const v = await createHighlightedViewer({
    exec: async (cmd, args = []) => {
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
    },
    readTextFile: async () => bigText,
  });

  v.view.target("/repo", "repo", v.cx);
  await v.settle();

  // Large diff: first 160 rows (0..159) highlighted synchronously; row 250 starts plain, then highlights in chunks.
  v.view.tab = "changes";
  let rendered = v.render();
  let diffRows = rendered.vlists.find((x) => x.id === "vc-diff").rendered;
  assert.equal(hasHighlightedSpans(diffRows[1]), true, "early diff row highlighted synchronously");
  assert.equal(hasHighlightedSpans(diffRows[159]), true, "row 159 (within first 160) highlighted synchronously");
  assert.equal(hasHighlightedSpans(diffRows[200]), false, "row 200 deferred beyond sync cap");
  assert.equal(diffRows[200].node.props.bg, "#3fb9501c", "deferred added row keeps line background tint");

  // Step 1 chunk (80 rows: 160..239) highlights row 200 while row 300 stays plain.
  assert.equal(v.tickNext(), true);
  rendered = v.render();
  diffRows = rendered.vlists.find((x) => x.id === "vc-diff").rendered;
  assert.equal(hasHighlightedSpans(diffRows[200]), true, "row 200 highlighted after first chunk tick");
  assert.equal(findColor(diffRows[161], " * still in block comment"), THEME.dim, "block comment state preserved across sync/chunk boundary");
  assert.equal(hasHighlightedSpans(diffRows[300]), false, "row 300 waits for next chunk tick");

  // Switching files mid-chunk cancels the old diff timer cleanly.
  const notifiesBeforeSwitch = v.getNotifyCount();
  v.view.pickChange("small.ts", v.cx);
  await v.settle();
  assert.equal(v.tickNext(), false, "switching to small diff leaves no active chunk timer from big.ts");
  assert.ok(v.getNotifyCount() >= notifiesBeforeSwitch);

  // Large file in Files view: first 160 lines highlighted synchronously, rest in 80-line chunks.
  v.view.tab = "files";
  v.view.showFile("big.ts", v.cx, THEME);
  await v.settle();
  rendered = v.render();
  let codeRows = rendered.vlists.find((x) => x.id === "vf-code").rendered;
  assert.equal(hasHighlightedSpans(codeRows[0]), true, "file line 0 highlighted synchronously");
  assert.equal(hasHighlightedSpans(codeRows[159]), true, "file line 159 highlighted synchronously");
  assert.equal(hasHighlightedSpans(codeRows[200]), false, "file line 200 deferred");

  let chunkSteps = 0;
  while (v.tickNext()) chunkSteps++;
  assert.equal(chunkSteps, Math.ceil((360 - HIGHLIGHT_SYNC_MAX) / HIGHLIGHT_CHUNK), "360 lines highlight in bounded 80-line chunks");
  rendered = v.render();
  codeRows = rendered.vlists.find((x) => x.id === "vf-code").rendered;
  assert.equal(findColor(codeRows[160], " * still in block comment"), THEME.dim);
  assert.equal(findColor(codeRows[350], "const"), THEME.ansi5);
  assert.equal(findColor(codeRows[350], "calc"), THEME.ansi4);

  // Closing the viewer mid-chunk cancels any pending file highlight timer.
  v.view.showFile("big.ts", v.cx, THEME);
  await v.settle();
  v.view.close(v.cx);
  assert.equal(v.tickNext(), false, "closing viewer cancels active file highlight timer");
});
