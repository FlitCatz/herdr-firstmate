import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import vm from "node:vm";
import * as highlight from "../mods/fm-board/highlight.js";

const { editorSyntax, syntaxColor } = highlight;

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

function findEditorState(node) {
  if (!node || typeof node !== "object") return null;
  if (node.node?.props?.editor) return node.node.props.editor;
  for (const k of node.node?.kids ?? []) {
    const hit = findEditorState(k);
    if (hit) return hit;
  }
  return null;
}

function collectIds(node, out = []) {
  if (!node || typeof node !== "object") return out;
  if (node.node?.id) out.push(node.node.id);
  for (const k of node.node?.kids ?? []) collectIds(k, out);
  return out;
}

async function createHighlightedViewer({ exec, readTextFile, virtualRanges } = {}) {
  const source = (await readFile(new URL("mods/fm-board/viewer.js", rootUrl), "utf8"))
    .replace(/^import .*;$/gm, "")
    .replace("export class FolderViewer", "class FolderViewer");
  const vlists = [];
  const editors = [];
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
  const render = (theme = THEME) => {
    vlists.length = 0;
    const tree = view.render(theme, (px) => px, []);
    return { tree, vlists: [...vlists], ids: collectIds(tree) };
  };
  return { view, cx, editors, render, settle };
}

test("syntaxColor and editorSyntax map every token kind to the Herdr theme token table", () => {
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
});

test("FolderViewer highlights Files view with Herdr theme tokens, keeps Git status marks, and omits Changes tab", async () => {
  const sampleTs = [
    'import { readFile } from "node:fs";',
    "export async function loadCount(limit: number): Promise<number> {",
    '  const ok = true; // ready',
    "  return limit + 42;",
    "}",
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
      }
      return { code: 1, stdout: "", stderr: "" };
    },
    readTextFile: async () => sampleTs,
  });

  v.view.target("/repo", "repo", v.cx);
  await v.settle();

  // Files list keeps Git status marks and renders the Files label but no Changes tab.
  let rendered = v.render();
  assert.equal(v.view.marks["app.ts"], "M");
  assert.ok(rendered.ids.includes("vf-app.ts"));
  assert.ok(!rendered.ids.includes("vt-changes"));
  assert.ok(rendered.ids.includes("vt-files"));

  // Files view opens the file in a read-only Editor colored from the theme token table.
  v.view.showFile("app.ts", v.cx, THEME);
  await v.settle();
  assert.equal(v.editors.length, 1);
  const [darkState] = v.editors;
  assert.equal(darkState.opts.readonly, true);
  assert.equal(darkState.opts.language, "js");
  assert.equal(darkState.opts.value, sampleTs);
  assert.deepEqual(darkState.opts.syntax, expectedEditorSyntax(THEME));

  rendered = v.render();
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
});
