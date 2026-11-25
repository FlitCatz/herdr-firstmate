// Read-only Files view of one folder, drawn inside the Board.
// Adapted from Herdr's shipped files mod, which follows the focused pane;
// this one follows the folder the Board picks (a project's local copy or a worker's
// isolated copy). It never writes, and every git read leaves .git untouched,
// because firstmate does not change project copies.
import { div, svg } from "gpui-kit";
import { v_flex, h_flex, Editor, EditorState, Scrollbar, v_virtual_list } from "gpui-base";
import { exec, readTextFile, watchFolder, settings } from "herdr";
import { editorSyntax } from "./highlight.js";

const READ = ["--no-optional-locks", "-c", "core.fsmonitor=false", "-c", "diff.autoRefreshIndex=false"];
const LANG = { ts: "js", tsx: "js", mts: "js", cts: "js", jsx: "js", mjs: "js", cjs: "js", toml: "yaml", jsonc: "json", svelte: "html", vue: "html" };
const PER_FOLDER = 500, TOTAL = 5000;

function isValidRelPath(rel, { allowEmpty = false } = {}) {
  if (typeof rel !== "string") return false;
  if (rel === "") return allowEmpty;
  if (rel.startsWith("/") || rel.includes("\0")) return false;
  return rel.split("/").every((seg) => seg !== "" && seg !== "." && seg !== "..");
}

// Shared boundary check for exploration and file reading: never traverse or follow symlinks inside root.
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

export class FolderViewer {
  constructor() { this.root = null; this.label = ""; this.gen = 0; this.fileSeq = 0; this.reset(); }

  reset() {
    this.folderWatch?.cancel(); this.folderWatch = null;
    this.fileSeq++;
    this.code?.release?.();
    this.entries = new Map(); this.folders = new Set(); this.pending = new Set(); this.marks = {};
    this.file = null; this.code = null; this.fileError = null; this.error = null; this.loading = false; this.limited = false;
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
    this.refreshFiles(cx);
  }

  async fetchGitStatus(root) {
    const top = await exec("git", ["rev-parse", "--show-toplevel", "--show-prefix"], { cwd: root }).catch(() => null);
    if (!top || top.code !== 0) return { ok: false, notGit: true };
    const lines = top.stdout.split("\n");
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
    return { ok: true, entries };
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

  refreshFiles(cx) {
    if (this.loading) return;
    const gen = this.gen, root = this.root;
    this.loading = true; this.limited = false;
    cx.spawn(async (cx) => {
      try {
        for (const path of ["", ...this.folders]) { if (gen !== this.gen) return; await this.loadFolder(path, gen); }
        const git = await this.fetchGitStatus(root);
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

  // sources: [{ path, label }] the Board offers for this project; the current one is highlighted.
  render(t, fs, sources) {
    const header = v_flex().flex_none().gap(6).p(8).border_b(1).border_color(t.border)
      .child(h_flex().gap(6).items_center()
        .child(div().flex_1().min_w(0).truncate().text_size(fs(12)).font_semibold().text_color(t.foreground).child(this.label))
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
      .child(header).child(this.filesBody(t, fs));
  }
}
