// Terminal Cmd/Ctrl-click link handler for local Markdown files.
// Opens existing local .md files in a focused, read-only fm-md-viewer tab
// in the source space (reusing an open tab for the same file), and passes through
// URLs, remote files, non-Markdown paths, and missing or unreadable files.
import { home, panes, readTextFile, run, setShared, shared, spaces } from "herdr";
import {
  MOD_NAME,
  PENDING_SHARED_KEY,
  TABS_SHARED_KEY,
  findMatchingTab,
  isMarkdownPath,
  livePending,
  normalizeLocalPath,
  reconcileTabs,
  taggedTabName,
} from "./state.js";

/**
 * @param {import("herdr").LinkClick} click
 * @returns {Promise<"handled" | "pass">}
 */
export async function handleLink(click) {
  if (!click || !click.link || !click.source) return "pass";
  if (click.link.kind !== "file") return "pass";

  // Remote terminals keep their own path handling.
  if (typeof click.source.machine === "string" && click.source.machine.length > 0) return "pass";

  const spaceList = spaces();
  const targetSpace = (click.source.space ? spaceList.find((s) => s.id === click.source.space) : null)
    ?? spaceList.find((s) => s.active)
    ?? null;
  if (targetSpace && typeof targetSpace.machine === "string" && targetSpace.machine.length > 0) return "pass";

  const resolvedPath = normalizeLocalPath(click.link.path, click.source.cwd, home());
  if (!resolvedPath || !isMarkdownPath(resolvedPath)) return "pass";

  // Verify the file exists and is readable UTF-8 text without shell commands or network calls.
  let text;
  try {
    text = await readTextFile(resolvedPath);
  } catch {
    return "pass";
  }
  if (text === null || text.includes("\0")) return "pass";

  const targetSpaceId = click.source.space ?? targetSpace?.id ?? null;
  const { entries, changed } = reconcileTabs(shared(TABS_SHARED_KEY), spaces(), panes());
  if (changed) setShared(TABS_SHARED_KEY, entries);

  const existing = findMatchingTab(entries, targetSpaceId, resolvedPath);
  if (existing) {
    run("tab.select", { id: existing.tab });
    run("pane.focus", { pane: existing.pane });
    return "handled";
  }

  const now = Date.now();
  const pending = livePending(shared(PENDING_SHARED_KEY), now);
  if (pending.some((p) => p.file === resolvedPath && p.space === targetSpaceId)) return "handled";

  const tag = `${now.toString(36)}${Math.random().toString(36).slice(2, 10)}`;
  setShared(PENDING_SHARED_KEY, [...pending, { tag, file: resolvedPath, space: targetSpaceId, at: now }]);

  /** @type {Record<string, unknown>} */
  const args = {
    name: taggedTabName(resolvedPath, tag),
    mod: MOD_NAME,
    props: { file: resolvedPath, tag },
    focus: true,
  };
  if (targetSpaceId) args.space = targetSpaceId;
  run("tab.new", args);
  return "handled";
}
