// Read-only Files and Changes view of one folder, drawn inside the Board.
// Adapted from Herdr's shipped files/changes mods, which follow the focused pane;
// this one follows the folder the Board picks (a project's local copy or a worker's
// isolated copy). It never writes: no commit, and every git read leaves .git untouched,
// because firstmate does not change project copies.
import { div, svg } from "gpui-kit";
import { v_flex, h_flex, Editor, EditorState, Scrollbar, v_virtual_list } from "gpui-base";
import { exec, readTextFile, watchFolder, settings } from "herdr";
import { HIGHLIGHT_SYNC_MAX, HIGHLIGHT_CHUNK, capLineSpans, detectLanguage, DiffHighlighter, editorSyntax, syntaxColor, tint } from "./highlight.js";

const READ = ["--no-optional-locks", "-c", "core.fsmonitor=false", "-c", "diff.autoRefreshIndex=false"];
const LANG = { ts: "js", tsx: "js", mts: "js", cts: "js", jsx: "js", mjs: "js", cjs: "js", toml: "yaml", jsonc: "json", svelte: "html", vue: "html" };
const PER_FOLDER = 500, TOTAL = 5000, CHANGED_LIMIT = 1000, DIFF_LINES = 1500;
const countLines = (text) => text ? text.split("\n").length - Number(text.endsWith("\n")) : 0;

function isValidRelPath(rel, { allowEmpty = false } = {}) {
  if (typeof rel !== "string") return false;
  if (rel === "") return allowEmpty;
  if (rel.startsWith("/") || rel.includes("\0")) return false;
  return rel.split("/").every((seg) => seg !== "" && seg !== "." && seg !== "..");
}

// Shared boundary check for exploration and both file-read paths: never traverse or follow symlinks inside root.
const PATH_GUARD = 'rel=$1; root=$2; [ -n "$root" ] && [ -d "$root" ] || exit 2; '
  + 'real_root=$(cd -P -- "$root" 2>/dev/null && pwd -P) || exit 2; cur=$root; '
  + 'if [ -n "$rel" ]; then IFS=/; set -f; for seg in $rel; do '
  + '[ -n "$seg" ] && [ "$seg" != "." ] && [ "$seg" != ".." ] || exit 3; '
  + 'cur="$cur/$seg"; [ ! -L "$cur" ] || exit 4; done; set +f; unset IFS; fi';

const DIRECTORY_SCRIPT = `${PATH_GUARD}; [ -d "$cur" ] || exit 2; `
  + 'real_cur=$(cd -P -- "$cur" 2>/dev/null && pwd -P) || exit 2; '
  + 'case "$real_cur" in "$real_root"|"$real_root"/*) ;; *) exit 4 ;; esac; '
  + 'n=0; for p in "$cur"/* "$cur"/.[!.]* "$cur"/..?*; do [ -e "$p" ] || [ -L "$p" ] || continue; '
  + 'name=${p##*/}; [ "$name" = .git ] && continue; '
  + 'if [ -L "$p" ]; then kind=l; elif [ -d "$p" ]; then kind=d; else kind=f; fi; '
  + 'printf "%s\\0%s\\0" "$kind" "$name"; n=$((n+1)); [ "$n" -gt 500 ] && break; done; exit 0';

const SAFE_FILE_SCRIPT = `${PATH_GUARD}; [ -n "$rel" ] || exit 3; [ -e "$cur" ] || exit 5; [ ! -d "$cur" ] || exit 6; `
  + 'parent=${cur%/*}; real_parent=$(cd -P -- "$parent" 2>/dev/null && pwd -P) || exit 2; '
  + 'case "$real_parent" in "$real_root"|"$real_root"/*) ;; *) exit 4 ;; esac';

async function directory(root, rel = "") {
  if (!isValidRelPath(rel, { allowEmpty: true })) throw new Error("Cannot list outside the selected folder");
  const r = await exec("sh", ["-c", DIRECTORY_SCRIPT, "files", rel, root]);
  if (r.code === 4) throw new Error("Symbolic links cannot be opened as folders");
  if (r.code !== 0) throw new Error(r.stderr || "Cannot list this folder");
  const fields = r.stdout.split("\0"), out = [];
  for (let i = 0; i + 1 < fields.length; i += 2) {
    out.push({ name: fields[i + 1], dir: fields[i] === "d", link: fields[i] === "l" });
  }
  return out;
}

async function verifySafeFile(root, rel) {
  if (!root || !isValidRelPath(rel)) return { ok: false, error: "Cannot preview file outside the selected folder" };
  const r = await exec("sh", ["-c", SAFE_FILE_SCRIPT, "safe-path", rel, root]).catch(() => null);
  if (!r) return { ok: false, error: "Cannot preview this file (binary, too large, or unreadable)" };
  if (r.code === 4) return { ok: false, error: "Symbolic links are not previewed" };
  if (r.code === 5) return { ok: false, error: "This file is no longer available" };
  if (r.code !== 0) return { ok: false, error: "Cannot preview this file (binary, too large, or unreadable)" };
  return { ok: true };
}

function diffRows(lines) {
  let old = 0, next = 0;
  return lines.map((line) => {
    const match = /^@@ -(\d+)(?:,\d+)? \+(\d+)/.exec(line);
    if (match) { old = +match[1]; next = +match[2]; return { kind: "@", text: line }; }
    const kind = line[0];
    if (kind === "-") return { kind, number: old++, text: line.slice(1) || " " };
    if (kind === "+") return { kind, number: next++, text: line.slice(1) || " " };
    if (kind === " ") { old++; return { kind, number: next++, text: line.slice(1) || " " }; }
    return { kind: "", text: line };
  });
}

export class FolderViewer {
  constructor() { this.root = null; this.label = ""; this.tab = "files"; this.gen = 0; this.fileSeq = 0; this.diffSeq = 0; this.reset(); }

  cancelDiffHighlight() { this.diffHighlightTimer?.cancel?.(); this.diffHighlightTimer = null; }

  reset() {
    this.folderWatch?.cancel(); this.folderWatch = null;
    this.cancelDiffHighlight();
    this.fileSeq++; this.diffSeq++;
    this.code?.release?.();
    this.entries = new Map(); this.folders = new Set(); this.pending = new Set(); this.marks = {};
    this.file = null; this.code = null; this.fileError = null; this.error = null; this.loading = false; this.limited = false;
    this.changed = []; this.rows = []; this.diffSpans = []; this.diffKey = ""; this.diffWidth = 300; this.open = null; this.closed = false;
    this.changesError = null; this.changesLoading = false; this.changesLimited = false; this.gitRoot = null; this.hasHead = false;
  }

  highlightDiff(path, diffKey, cx) {
    const gen = this.gen, rows = this.rows, spans = this.diffSpans, highlighter = new DiffHighlighter();
    const isCurrent = () => this.gen === gen && this.diffKey === diffKey && this.open === path;
    const fill = (limit) => {
      const res = highlighter.highlight(path, diffKey, rows, limit);
      for (let i = spans.length; i < res.length; i++) spans[i] = capLineSpans(res[i]);
    };
    fill(HIGHLIGHT_SYNC_MAX);
    if (rows.length <= HIGHLIGHT_SYNC_MAX || !cx?.timer?.after) return;
    const step = (timerCx) => {
      if (!isCurrent()) return;
      this.diffHighlightTimer = null;
      fill(spans.length + HIGHLIGHT_CHUNK);
      if (spans.length < rows.length && timerCx?.timer?.after) this.diffHighlightTimer = timerCx.timer.after(0, step);
      timerCx.notify();
    };
    this.diffHighlightTimer = cx.timer.after(0, step);
  }

  // Same folder again keeps the open folders and file; a new one starts over.
  target(root, label, cx) {
    this.label = label;
    if (root === this.root) { cx.notify(); return; }
    this.gen++; this.root = root; this.reset();
    this.refresh(cx); this.watch(cx);
  }

  close(cx) { this.gen++; this.root = null; this.reset(); cx.notify(); }

  watch(cx) {
    const gen = this.gen, root = this.root;
    cx.spawn(async (cx) => {
      // A tree too large to watch throws here; the Board's timer still refreshes it.
      try {
        while (this.gen === gen) {
          const watch = this.folderWatch = watchFolder(root);
          try { await watch; }
          finally { if (this.folderWatch === watch) this.folderWatch = null; }
          if (this.gen === gen) this.refresh(cx);
        }
      } catch {}
    });
  }

  refresh(cx) {
    if (!this.root) return;
    const root = this.root;
    let gitPromise = null;
    const getGitStatus = () => (gitPromise ??= this.fetchGitStatus(root));
    this.refreshFiles(cx, getGitStatus); this.refreshChanges(cx, getGitStatus);
  }

  async fetchGitStatus(root) {
    const top = await exec("git", ["rev-parse", "--show-toplevel", "--show-prefix"], { cwd: root }).catch(() => null);
    if (!top || top.code !== 0) return { ok: false, notGit: true };
    const lines = top.stdout.split("\n");
    const gitRoot = lines[0]?.trim() ?? "";
    const rawPrefix = (lines[1] ?? "").replace(/\r$/, "");
    const prefix = rawPrefix && !rawPrefix.endsWith("/") ? `${rawPrefix}/` : rawPrefix;
    const status = await exec("git", [...READ, "status", "--porcelain=v1", "-z", "--no-renames", "--untracked-files=all", "--", "."], { cwd: root })
      .catch((e) => ({ code: 1, stdout: "", stderr: String(e?.message ?? e) }));
    if (status.code !== 0) return { ok: false, notGit: false, error: status.stderr || "Cannot read git status" };
    const entries = [];
    for (const entry of status.stdout.split("\0").filter(Boolean)) {
      const xy = entry.slice(0, 2), gitPath = entry.slice(3);
      if (prefix && !gitPath.startsWith(prefix)) continue;
      const path = prefix ? gitPath.slice(prefix.length) : gitPath;
      if (!isValidRelPath(path)) continue;
      entries.push({ xy, path });
    }
    return { ok: true, gitRoot, prefix, entries };
  }

  async loadFolder(path, gen) {
    if (!isValidRelPath(path, { allowEmpty: true })) return;
    const entries = await directory(this.root, path);
    if (gen !== this.gen || (path && !this.folders.has(path))) return;
    const used = [...this.entries.entries()].filter(([p]) => p !== path).reduce((n, [, e]) => n + e.length, 0);
    this.entries.set(path, entries.slice(0, Math.max(0, Math.min(PER_FOLDER, TOTAL - used)))
      .sort((a, b) => Number(b.dir) - Number(a.dir) || a.name.localeCompare(b.name)));
    if (entries.length > PER_FOLDER || used + entries.length > TOTAL) this.limited = true;
  }

  refreshFiles(cx, getGitStatus) {
    if (this.loading) return;
    const gen = this.gen, root = this.root;
    const readGit = getGitStatus ?? (() => this.fetchGitStatus(root));
    this.loading = true; this.limited = false;
    cx.spawn(async (cx) => {
      try {
        for (const path of ["", ...this.folders]) { if (gen !== this.gen) return; await this.loadFolder(path, gen); }
        const git = await readGit();
        if (gen !== this.gen) return;
        const marks = {};
        if (git.ok) {
          for (const { xy, path } of git.entries.slice(0, TOTAL)) {
            marks[path] = xy === "??" || xy.includes("A") ? "A" : xy.includes("U") ? "U" : xy.includes("D") ? "D" : "M";
          }
        }
        this.marks = marks; this.error = null;
      } catch (e) { if (gen === this.gen) this.error = String(e?.message ?? e); }
      finally { if (gen === this.gen) this.loading = false; cx.notify(); }
    });
  }

  toggleFolder(path, cx) {
    if (!isValidRelPath(path)) return;
    if (this.folders.has(path)) {
      for (const folder of [...this.folders]) if (folder === path || folder.startsWith(path + "/")) { this.folders.delete(folder); this.entries.delete(folder); }
    } else {
      this.folders.add(path);
      if (!this.entries.has(path) && !this.pending.has(path)) {
        const gen = this.gen;
        this.pending.add(path);
        cx.spawn(async (cx) => {
          try { await this.loadFolder(path, gen); }
          catch (e) {
            if (gen === this.gen) {
              this.folders.delete(path);
              this.error = String(e?.message ?? e);
            }
          }
          finally { if (gen === this.gen) this.pending.delete(path); cx.notify(); }
        });
      }
    }
    cx.notify();
  }

  showFile(path, cx, t) {
    const seq = ++this.fileSeq;
    this.code?.release?.(); this.code = null; this.file = path; this.fileError = null;
    if (!path) { cx.notify(); return; }
    const gen = this.gen, root = this.root;
    cx.spawn(async (cx) => {
      try {
        const safe = await verifySafeFile(root, path);
        if (seq !== this.fileSeq || gen !== this.gen) return;
        if (!safe.ok) { this.fileError = safe.error; return; }
        const text = await readTextFile(`${root}/${path}`);
        if (seq !== this.fileSeq || gen !== this.gen) return;
        if (text === null) { this.fileError = "This file is no longer available"; return; }
        if (text.includes("\0")) { this.fileError = "Binary file · no text preview"; return; }
        const ext = path.includes(".") ? path.split(".").pop() : "txt";
        this.code = EditorState.new({ language: LANG[ext] ?? ext, readonly: true,
          value: text.length > 400000 ? text.slice(0, 400000) + "\n… (file truncated)" : text,
          font_family: settings().font_family, font_size: 12, syntax: editorSyntax(t) });
      } catch { if (seq === this.fileSeq && gen === this.gen) this.fileError = "Cannot preview this file (binary, too large, or unreadable)"; }
      finally { if (seq === this.fileSeq && gen === this.gen) cx.notify(); }
    });
    cx.notify();
  }

  refreshChanges(cx, getGitStatus) {
    if (this.changesLoading) return;
    const gen = this.gen, root = this.root;
    const readGit = getGitStatus ?? (() => this.fetchGitStatus(root));
    this.changesLoading = true;
    cx.spawn(async (cx) => {
      try {
        const gitStatus = await readGit();
        if (gen !== this.gen) return;
        if (!gitStatus.ok && gitStatus.notGit) {
          this.gitRoot = null; this.changed = []; this.diffSeq++; this.setLines([], null, cx); this.open = null; this.changesError = "Not a git repository";
          return;
        }
        if (!gitStatus.ok) throw new Error(gitStatus.error);
        const { gitRoot, prefix, entries } = gitStatus;
        const git = (args) => exec("git", [...READ, ...args], { cwd: root });
        const head = await git(["rev-parse", "--verify", "HEAD"]);
        const stats = {};
        const results = head.code === 0 ? [await git(["diff", "HEAD", "--numstat", "-z", "--no-renames", "--", "."])]
          : [await git(["diff", "--cached", "--numstat", "-z", "--no-renames", "--", "."]), await git(["diff", "--numstat", "-z", "--no-renames", "--", "."])];
        for (const result of results) {
          if (result.code !== 0) throw new Error(result.stderr);
          for (const entry of result.stdout.split("\0")) {
            const [a, d, ...parts] = entry.split("\t");
            if (!parts.length) continue;
            const gitPath = parts.join("\t");
            if (prefix && !gitPath.startsWith(prefix)) continue;
            const path = prefix ? gitPath.slice(prefix.length) : gitPath;
            if (!isValidRelPath(path)) continue;
            const old = stats[path] ?? { add: 0, del: 0 };
            stats[path] = { add: old.add + (Number(a) || 0), del: old.del + (Number(d) || 0), binary: a === "-" };
          }
        }
        const changed = [];
        for (const { xy, path } of entries.slice(0, CHANGED_LIMIT)) {
          const fresh = xy === "??";
          const s = xy.includes("U") || xy === "AA" || xy === "DD" ? "U" : xy.includes("D") ? "D" : fresh || xy.includes("A") ? "A" : "M";
          changed.push({ path, status: s, fresh, ...(stats[path] ?? { add: 0, del: 0 }) });
        }
        if (gen !== this.gen) return;
        this.gitRoot = gitRoot; this.hasHead = head.code === 0; this.changed = changed; this.changesLimited = entries.length > CHANGED_LIMIT; this.changesError = null;
        if (this.open && !changed.some((f) => f.path === this.open)) { this.open = null; this.diffSeq++; this.setLines([], null, cx); }
        if (!this.open && !this.closed && changed.length) this.open = changed[0].path;
        if (this.open) {
          const seq = ++this.diffSeq;
          try { await this.loadDiff(this.open, gen, seq, cx); }
          catch { if (gen === this.gen && seq === this.diffSeq) this.setLines(["Cannot preview this diff (too large or unreadable)"], null, cx); }
        }
      } catch (e) { if (gen === this.gen) this.changesError = String(e?.message ?? e); }
      finally { if (gen === this.gen) this.changesLoading = false; cx.notify(); }
    });
  }

  async loadDiff(path, gen, seq = this.diffSeq, cx = null) {
    if (gen !== this.gen || seq !== this.diffSeq || this.open !== path) return;
    const file = this.changed.find((f) => f.path === path), root = this.root;
    if (!file || !root || !isValidRelPath(path)) return;
    let lines;
    if (file.fresh || (!this.hasHead && file.status === "A")) {
      const safe = await verifySafeFile(root, path);
      if (gen !== this.gen || seq !== this.diffSeq || this.open !== path) return;
      if (!safe.ok) lines = [safe.error];
      else {
        const text = await readTextFile(`${root}/${path}`).catch(() => null);
        if (gen !== this.gen || seq !== this.diffSeq || this.open !== path) return;
        if (text === null) lines = ["Cannot preview this file (binary, too large, or unreadable)"];
        else if (text.includes("\0")) lines = ["Binary file · no text diff"];
        else { file.add = countLines(text); lines = [`@@ -0,0 +1,${file.add} @@`, ...text.slice(0, 400000).replace(/\n$/, "").split("\n").slice(0, DIFF_LINES).map((l) => `+${l}`)]; }
      }
    } else {
      const r = await exec("git", [...READ, "diff", ...(this.hasHead ? ["HEAD"] : []), "--no-ext-diff", "--no-textconv", "--no-color", "--", path], { cwd: root });
      if (gen !== this.gen || seq !== this.diffSeq || this.open !== path) return;
      if (r.code !== 0) throw new Error(r.stderr);
      const all = r.stdout.replace(/\n$/, "").split("\n"), first = all.findIndex((l) => l.startsWith("@@"));
      lines = first < 0 ? [file.binary ? "Binary file changed" : "No text diff available"] : all.slice(first);
    }
    if (gen === this.gen && seq === this.diffSeq && this.open === path) {
      this.setLines(lines.slice(0, DIFF_LINES).map((l) => l.length > 4000 ? l.slice(0, 4000) + "… (line truncated)" : l), path, cx);
    }
  }

  setLines(lines, path = this.open, cx = null) {
    const diffKey = lines.length ? `${path ?? ""}\0${lines.join("\n")}` : "";
    if (diffKey && this.diffKey === diffKey && this.rows.length) return;
    this.cancelDiffHighlight();
    this.diffKey = diffKey;
    this.rows = diffRows(lines);
    this.diffWidth = Math.max(300, ...lines.map((l) => l.length * 7 + 50));
    this.diffSpans = [];
    if (path && this.rows.length && detectLanguage(path) !== "plain") this.highlightDiff(path, diffKey, cx);
  }

  pickChange(path, cx) {
    const seq = ++this.diffSeq;
    this.open = this.open === path ? null : path; this.setLines([], null, cx); this.closed = !this.open;
    const gen = this.gen;
    if (this.open) cx.spawn(async (cx) => {
      try { await this.loadDiff(path, gen, seq, cx); }
      catch { if (gen === this.gen && seq === this.diffSeq && this.open === path) this.setLines(["Cannot preview this diff (too large or unreadable)"], null, cx); }
      if (gen === this.gen && seq === this.diffSeq) cx.notify();
    });
    cx.notify();
  }

  collectFileRows(prefix, depth, out) {
    if (out.length >= TOTAL || depth > 40) return out;
    for (const entry of this.entries.get(prefix) ?? []) {
      if (out.length >= TOTAL) break;
      const path = prefix ? `${prefix}/${entry.name}` : entry.name;
      const open = entry.dir && this.folders.has(path);
      const mark = entry.link ? null : this.marks[path];
      out.push({ path, depth, entry, open, mark });
      if (entry.dir && open) this.collectFileRows(path, depth + 1, out);
    }
    return out;
  }

  renderFileRow({ path, depth, entry, open, mark }, t, fs) {
    const row = h_flex().id(`vf-${path}`).h(26).flex_none().pl(6 + depth * 16).pr(6).gap(6).items_center().rounded(6);
    if (entry.link) {
      return row
        .child(div().w(12).flex_none())
        .child(svg("mods/files/file.svg").size(13).flex_none().text_color(t.dim))
        .child(div().flex_1().min_w(0).truncate().text_size(fs(12)).text_color(t.dim).child(entry.name))
        .child(div().flex_none().text_size(fs(10)).text_color(t.dim).child("link"));
    }
    return row.cursor_pointer().hover((s) => s.bg(t.hover))
      .child(entry.dir ? svg(`mods/files/chevron-${open ? "down" : "right"}.svg`).size(12).flex_none().text_color(t.dim) : div().w(12).flex_none())
      .child(svg(`mods/files/${entry.dir ? "folder" : "file"}.svg`).size(13).flex_none().text_color(t.muted))
      .child(div().flex_1().min_w(0).truncate().text_size(fs(12)).child(entry.name))
      .when(Boolean(mark), (el) => el.child(div().text_size(fs(11)).text_color(mark === "A" ? t.ansi2 : mark === "D" || mark === "U" ? t.ansi1 : t.blocked).child(mark)));
  }

  renderHighlightedLine(text, spans, t) {
    if (!spans || !spans.length) {
      return div().flex_1().min_w(0).truncate().child(text || " ");
    }
    return h_flex().flex_1().min_w(0).overflow_hidden().children(
      spans.map((sp) => div().flex_none().whitespace_nowrap()
        .when(sp.kind !== "plain", (e) => e.text_color(syntaxColor(t, sp.kind)))
        .child(sp.text))
    );
  }

  filesBody(t, fs) {
    if (this.file) {
      return v_flex().flex_1().min_h(0)
        .child(h_flex().flex_none().gap(6).px(6).py(4).items_center().border_b(1).border_color(t.border)
          .child(div().id("vf-back").cursor_pointer().text_color(t.muted).on_click((_e, cx) => this.showFile(null, cx, t)).child("←"))
          .child(div().flex_1().min_w(0).truncate().text_size(fs(11)).text_color(t.dim).child(this.file)))
        .child(this.code ? Editor.new(this.code).flex_1().min_h(0) : div().p(10).text_size(fs(12)).text_color(t.dim).child(this.fileError || "Loading file…"));
    }
    const rows = this.collectFileRows("", 0, []);
    const rowByPath = new Map(rows.map((r) => [r.path, r]));
    const tree = v_flex().id("vf-tree").flex_1().min_h(0).p(4);
    if (this.error && rows.length) tree.child(div().id("vf-error").flex_none().px(8).py(4).text_size(fs(11)).text_color(t.ansi1).child(this.error));
    if (!rows.length) {
      tree.child(div().p(8).text_size(fs(12)).text_color(t.dim).child(this.error || (this.loading ? "Loading files…" : "No files")));
    } else {
      tree.child(div().flex_1().min_h(0).relative()
        .child(v_virtual_list("vf-list", rows.length, 26, (i) => rows[i].path,
          (range) => rows.slice(range.start, range.end).map((row) => this.renderFileRow(row, t, fs)))
          .size_full()
          .on_item_click((key, cx) => {
            const row = rowByPath.get(key);
            if (!row || row.entry.link) return;
            if (row.entry.dir) this.toggleFolder(row.path, cx);
            else this.showFile(row.path, cx, t);
          }))
        .child(Scrollbar.vertical("vf-list").viewport_from_layout().absolute().inset_0()));
    }
    if (this.limited) tree.child(div().flex_none().p(8).text_size(fs(11)).text_color(t.dim).child("File list limited to 500 entries per folder and 5,000 total"));
    return tree;
  }

  diffRow({ kind, number, text }, index, t) {
    if (kind === "@") return div().w_full().px(10).h(20).flex_none().truncate().bg(t.raised).text_color(t.dim).child(text);
    return h_flex().w_full().h(20).flex_none().gap(8)
      .when(kind === "+", (e) => e.bg(tint(t.ansi2, "1c")))
      .when(kind === "-", (e) => e.bg(tint(t.blocked, "1a")))
      .child(div().w(30).flex_none().text_right().text_color(t.dim).child(number === undefined ? "" : String(number)))
      .child(this.renderHighlightedLine(text, this.diffSpans[index], t));
  }

  renderChangeRow(f, t, fs) {
    const parts = f.path.split("/"), name = parts.pop();
    return h_flex().id(`vc-${f.path}`).h(26).flex_none().px(6).gap(6).items_center().rounded(6).cursor_pointer()
      .when(this.open === f.path, (e) => e.bg(t.selected)).hover((s) => s.bg(t.hover))
      .child(div().w(12).text_size(fs(11)).text_color(f.status === "A" ? t.ansi2 : f.status === "D" || f.status === "U" ? t.ansi1 : t.blocked).child(f.status))
      .child(h_flex().flex_1().min_w(0).text_size(fs(12)).child(div().text_color(t.dim).truncate().child(parts.length ? parts.join("/") + "/" : "")).child(div().min_w(0).truncate().child(name)))
      .when(f.add > 0, (e) => e.child(div().text_size(fs(11)).text_color(t.ansi2).child(`+${f.add}`)))
      .when(f.del > 0, (e) => e.child(div().text_size(fs(11)).text_color(t.ansi1).child(`−${f.del}`)));
  }

  changesBody(t, fs) {
    const list = v_flex().id("vc-list").flex_none().h(Math.min(180, Math.max(40, this.changed.length * 26 + 10))).p(4).border_b(1).border_color(t.border);
    if (!this.changed.length) {
      list.child(div().p(6).text_size(fs(12)).text_color(t.dim).child(this.changesError || (this.changesLoading ? "Loading changes…" : "No uncommitted changes")));
    } else {
      list.child(div().flex_1().min_h(0).relative()
        .child(v_virtual_list("vc-items", this.changed.length, 26, (i) => this.changed[i].path,
          (range) => this.changed.slice(range.start, range.end).map((f) => this.renderChangeRow(f, t, fs)))
          .size_full()
          .on_item_click((key, cx) => this.pickChange(key, cx)))
        .child(Scrollbar.vertical("vc-items").viewport_from_layout().absolute().inset_0()));
    }
    const body = v_flex().flex_1().min_h(0).child(list);
    if (this.changesError && this.changed.length) body.child(div().id("vc-error").flex_none().px(10).py(3).text_size(fs(11)).text_color(t.ansi1).child(this.changesError));
    if (this.changesLimited) body.child(div().px(10).py(3).text_size(fs(11)).text_color(t.dim).child("Showing the first 1,000 changed files"));
    return body.child(div().flex_1().min_h(0).relative().font_family(settings().font_family ?? "JetBrains Mono").text_size(11)
      .child(div().id("vc-diff-x").size_full().overflow_x_scrollbar()
        .child(div().w_full().min_w(this.diffWidth).h_full().child(v_virtual_list("vc-diff", this.rows.length, 20, (i) => String(i),
          (range) => this.rows.slice(range.start, range.end).map((row, off) => this.diffRow(row, range.start + off, t))).size_full())))
      .child(Scrollbar.vertical("vc-diff").viewport_from_layout().absolute().inset_0())
      .when(!this.open && this.changed.length > 0, (e) => e.child(div().absolute().top(6).px(10).text_color(t.dim).child("Select a file to view its changes"))));
  }

  // sources: [{ path, label }] the Board offers for this project; the current one is highlighted.
  render(t, fs, sources) {
    const add = this.changed.reduce((n, f) => n + f.add, 0), del = this.changed.reduce((n, f) => n + f.del, 0);
    const tab = (id, label, extra) => h_flex().id(`vt-${id}`).gap(4).px(8).py(2).rounded(5).cursor_pointer().items_center()
      .bg(this.tab === id ? t.selected : t.raised).text_size(fs(11)).text_color(this.tab === id ? t.foreground : t.muted)
      .on_click((_e, cx) => { this.tab = id; cx.notify(); }).child(label).when(Boolean(extra), (e) => e.child(extra));
    const header = v_flex().flex_none().gap(6).p(8).border_b(1).border_color(t.border)
      .child(h_flex().gap(6).items_center()
        .child(div().flex_1().min_w(0).truncate().text_size(fs(12)).font_semibold().text_color(t.foreground).child(this.label))
        .child(tab("files", "Files"))
        .child(tab("changes", "Changes", this.changed.length ? div().text_size(fs(10)).text_color(t.dim).child(`${this.changed.length} · +${add} −${del}`) : null))
        .child(div().id("vt-close").px(6).cursor_pointer().text_color(t.dim).hover((s) => s.text_color(t.foreground)).on_click((_e, cx) => this.close(cx)).child("✕")))
      .child(div().truncate().text_size(fs(10)).text_color(t.dim).child(this.root ?? ""));
    if (sources?.length > 1) {
      header.child(h_flex().gap(4).flex_wrap().children(sources.map((s) => {
        const on = s.path === this.root;
        return div().id(`vs-${s.label}`).px(6).py(1).rounded(9).border(1).border_color(on ? t.foreground : t.border)
          .text_size(fs(10)).text_color(on ? t.foreground : t.muted).cursor_pointer().hover((e) => e.opacity(0.75))
          .on_click((_e, cx) => this.target(s.path, s.title, cx)).child(s.label);
      })));
    }
    return v_flex().id("viewer").size_full().min_h(0).rounded(8).overflow_hidden().bg(t.background).border(1).border_color(t.border).text_color(t.foreground)
      .child(header).child(this.tab === "files" ? this.filesBody(t, fs) : this.changesBody(t, fs));
  }
}
