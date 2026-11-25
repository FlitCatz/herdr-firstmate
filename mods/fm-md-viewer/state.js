// Shared path normalization and live tab-registry helpers for fm-md-viewer.
// Used by link.js (terminal Cmd/Ctrl-click routing) and main.js (binding its own tab once Herdr publishes it).

export const MOD_NAME = "fm-md-viewer";
export const TABS_SHARED_KEY = "fm-md-viewer.tabs";
export const PENDING_SHARED_KEY = "fm-md-viewer.pending";
export const PENDING_TTL_MS = 10000;

const CONTROL_CHARS = /[\u0000-\u001f\u007f]/;
const MARKDOWN_EXT = /\.md$/i;

/**
 * Normalizes a local POSIX file path without invoking any shell.
 * Returns null for empty, relative-without-absolute-cwd, directory-trailing-slash,
 * or control-character paths.
 * @param {unknown} rawPath
 * @param {unknown} [cwd]
 * @param {unknown} [homeDir]
 * @returns {string | null}
 */
export function normalizeLocalPath(rawPath, cwd = null, homeDir = null) {
  if (typeof rawPath !== "string" || !rawPath || CONTROL_CHARS.test(rawPath)) return null;
  if (rawPath.endsWith("/")) return null;

  let combined;
  if (rawPath.startsWith("/")) {
    combined = rawPath;
  } else if (rawPath.startsWith("~/")) {
    if (typeof homeDir !== "string" || !homeDir.startsWith("/") || CONTROL_CHARS.test(homeDir)) return null;
    combined = `${homeDir}/${rawPath.slice(2)}`;
  } else {
    if (typeof cwd !== "string" || !cwd.startsWith("/") || CONTROL_CHARS.test(cwd)) return null;
    combined = `${cwd}/${rawPath}`;
  }

  const stack = [];
  for (const seg of combined.split("/")) {
    if (!seg || seg === ".") continue;
    if (seg === "..") {
      if (stack.length > 0) stack.pop();
    } else {
      stack.push(seg);
    }
  }
  if (stack.length === 0) return null;
  return `/${stack.join("/")}`;
}

/** @param {unknown} filePath @returns {boolean} */
export function isMarkdownPath(filePath) {
  return typeof filePath === "string" && MARKDOWN_EXT.test(filePath);
}

/** @param {string | null | undefined} filePath @returns {string} */
export function tabTitle(filePath) {
  if (typeof filePath !== "string" || !filePath) return "Markdown";
  const name = filePath.split("/").filter(Boolean).pop();
  return name || "Markdown";
}

/**
 * Prunes recorded viewer tab entries against live Herdr spaces and panes so closed
 * tabs or tabs whose viewer pane was closed are never reused.
 * @param {unknown} rawEntries
 * @param {Array<{ id?: string, tabs?: Array<{ id?: string }> }>} spaceList
 * @param {Array<{ pane?: string, mod?: string, tab?: string }>} paneList
 * @returns {{ entries: Array<{ tab: string, space: string, pane: string, file: string }>, changed: boolean }}
 */
export function reconcileTabs(rawEntries, spaceList, paneList) {
  const tabToSpace = new Map();
  for (const space of Array.isArray(spaceList) ? spaceList : []) {
    if (!space?.id) continue;
    for (const tab of Array.isArray(space.tabs) ? space.tabs : []) {
      if (tab?.id) tabToSpace.set(tab.id, space.id);
    }
  }

  const viewerPaneByTab = new Map();
  for (const pane of Array.isArray(paneList) ? paneList : []) {
    if (pane?.mod === MOD_NAME && pane.tab && pane.pane && !viewerPaneByTab.has(pane.tab)) {
      viewerPaneByTab.set(pane.tab, pane.pane);
    }
  }

  const list = Array.isArray(rawEntries) ? rawEntries : [];
  const byTab = new Map();
  let changed = !Array.isArray(rawEntries) && rawEntries !== undefined && rawEntries !== null;

  for (const item of list) {
    if (!item || typeof item !== "object") {
      changed = true;
      continue;
    }
    const tab = typeof item.tab === "string" ? item.tab : "";
    const file = normalizeLocalPath(item.file);
    const liveSpace = tabToSpace.get(tab);
    const livePane = viewerPaneByTab.get(tab);
    if (!tab || !file || !liveSpace || !livePane) {
      changed = true;
      continue;
    }
    if (byTab.has(tab) || item.space !== liveSpace || item.pane !== livePane || item.file !== file) {
      changed = true;
    }
    byTab.set(tab, { tab, space: liveSpace, pane: livePane, file });
  }

  return { entries: [...byTab.values()], changed };
}

/**
 * Finds an open viewer tab showing the same file in the target space.
 * @param {Array<{ tab: string, space: string, pane: string, file: string }>} entries
 * @param {string | null} spaceId
 * @param {string} filePath
 */
export function findMatchingTab(entries, spaceId, filePath) {
  return entries.find((e) => e.file === filePath && (!spaceId || e.space === spaceId)) ?? null;
}

/**
 * Tab name for a viewer tab while it is being opened. The tag is unique per open and
 * is carried in the view's props, so the view can find exactly its own tab.
 * @param {string} filePath
 * @param {string} tag
 */
export function taggedTabName(filePath, tag) {
  return `${tabTitle(filePath)} · ${tag}`;
}

/**
 * Finds the published tab named for this exact open that holds an fm-md-viewer pane.
 * @param {Array<{ id?: string, tabs?: Array<{ id?: string, name?: string }> }>} spaceList
 * @param {Array<{ pane?: string, mod?: string, tab?: string }>} paneList
 * @param {string} filePath
 * @param {string} tag
 * @returns {{ tab: string, space: string, pane: string } | null}
 */
export function findTaggedViewerTab(spaceList, paneList, filePath, tag) {
  const name = taggedTabName(filePath, tag);
  for (const space of Array.isArray(spaceList) ? spaceList : []) {
    if (!space?.id) continue;
    const tab = (Array.isArray(space.tabs) ? space.tabs : []).find((t) => t?.id && t.name === name);
    if (!tab) continue;
    const pane = (Array.isArray(paneList) ? paneList : []).find((p) => p?.mod === MOD_NAME && p.tab === tab.id && p.pane);
    return pane ? { tab: tab.id, space: space.id, pane: pane.pane } : null;
  }
  return null;
}

/**
 * Records a viewer tab for its exact file, replacing any earlier record for that tab.
 * @param {unknown} rawEntries
 * @param {Array<{ id?: string, tabs?: Array<{ id?: string }> }>} spaceList
 * @param {Array<{ pane?: string, mod?: string, tab?: string }>} paneList
 * @param {{ tab: string, space: string, pane: string, file: string }} record
 */
export function withTabRecord(rawEntries, spaceList, paneList, record) {
  const { entries } = reconcileTabs(rawEntries, spaceList, paneList);
  return [...entries.filter((e) => e.tab !== record.tab), record];
}

/**
 * Opens still waiting for Herdr to publish their tab, dropping malformed and expired ones.
 * @param {unknown} rawPending
 * @param {number} now
 * @returns {Array<{ tag: string, file: string, space: string | null, at: number }>}
 */
export function livePending(rawPending, now) {
  return (Array.isArray(rawPending) ? rawPending : []).filter((p) =>
    p && typeof p.tag === "string" && typeof p.file === "string" && typeof p.at === "number"
      && now - p.at >= 0 && now - p.at < PENDING_TTL_MS);
}
