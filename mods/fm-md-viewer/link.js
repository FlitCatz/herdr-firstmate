// Terminal Cmd/Ctrl-click link handler for local Markdown files.
// Opens existing local .md files in a focused, read-only fm-md-viewer tab
// in the source space (reusing an open tab for the same file), and passes through
// URLs, remote files, non-Markdown paths, and missing or unreadable files.
import { home, panes, readTextFile, run, setShared, shared, spaces } from "herdr";
import {
  MOD_NAME,
  TABS_SHARED_KEY,
  findMatchingTab,
  findNewViewerTab,
  isMarkdownPath,
  normalizeLocalPath,
  reconcileTabs,
  tabTitle,
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
  const { entries, changed } = reconcileTabs(shared(TABS_SHARED_KEY), spaceList, panes());

  const existing = findMatchingTab(entries, targetSpaceId, resolvedPath);
  if (existing) {
    if (changed) setShared(TABS_SHARED_KEY, entries);
    run("tab.select", { id: existing.tab });
    run("pane.focus", { pane: existing.pane });
    return "handled";
  }

  /** @type {Record<string, unknown>} */
  const args = {
    name: tabTitle(resolvedPath),
    mod: MOD_NAME,
    props: { file: resolvedPath },
    focus: true,
  };
  if (targetSpaceId) args.space = targetSpaceId;
  const knownTabIds = new Set(spaceList.flatMap((s) => (s.tabs ?? []).map((t) => t.id)));
  run("tab.new", args);

  const created = findNewViewerTab(knownTabIds, spaces(), panes(), targetSpaceId);
  if (created) {
    setShared(TABS_SHARED_KEY, [...entries, { ...created, file: resolvedPath }]);
  } else if (changed) {
    setShared(TABS_SHARED_KEY, entries);
  }
  return "handled";
}
