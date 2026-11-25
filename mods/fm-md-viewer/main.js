// Minimal read-only Markdown document tab for terminal Cmd/Ctrl-clicked .md files.
// Renders local Markdown using Herdr's native TextView.markdown with raw HTML disabled.
// props: { file: string }
import { View, div } from "gpui-kit";
import { TextView, h_flex, v_flex } from "gpui-base";
import { checking, focused, home, panes, props, readTextFile, setShared, settings, shared, spaces, theme } from "herdr";
import {
  MOD_NAME,
  RELOAD_SHARED_KEY,
  TABS_SHARED_KEY,
  normalizeLocalPath,
  reconcileTabs,
  removeTabRecord,
  tabTitle,
  upsertTabRecord,
} from "./state.js";

const DATA_FONT = "Geist Mono";
const READING_MAX_W = 820;

export default class FmMdViewer extends View {
  init(p, cx) {
    const rawFile = p && typeof p === "object" && "file" in p ? p.file : props()?.file;
    this.file = normalizeLocalPath(rawFile, null, home());
    this.content = null;
    this.error = null;
    this.loading = false;
    this.seq = 0;
    this.renderVersion = 0;
    this.tabId = null;
    this.spaceId = null;
    this.paneId = null;
    this.lastReloadSeq = 0;

    if (checking() || !this.file) return;

    this.load(cx);
    cx.spawn(async (cx) => {
      if (!this.registerTab()) {
        await cx.sleep(50);
        this.registerTab();
      }
    });
  }

  registerTab() {
    if (!this.file || this.tabId) return Boolean(this.tabId);
    const spaceList = spaces();
    const paneList = panes();
    const tabToSpace = new Map();
    for (const space of spaceList) {
      if (!space?.id) continue;
      for (const tab of space.tabs ?? []) {
        if (tab?.id) tabToSpace.set(tab.id, space.id);
      }
    }

    const { entries } = reconcileTabs(shared(TABS_SHARED_KEY), spaceList, paneList);
    const entryByTab = new Map(entries.map((e) => [e.tab, e]));
    const viewerPanes = paneList.filter((p) => p?.mod === MOD_NAME && p.tab && p.pane && tabToSpace.has(p.tab));
    const f = focused();

    let match = null;
    if (f?.pane) {
      const focusedPane = viewerPanes.find((p) => p.pane === f.pane);
      const existing = focusedPane ? entryByTab.get(focusedPane.tab) : null;
      if (focusedPane && (!existing || existing.file === this.file)) match = focusedPane;
    }
    if (!match) {
      match = viewerPanes.find((p) => !entryByTab.has(p.tab)) ?? null;
    }
    if (!match) {
      match = viewerPanes.find((p) => entryByTab.get(p.tab)?.file === this.file) ?? null;
    }
    if (!match) return false;

    const spaceId = tabToSpace.get(match.tab);
    if (!spaceId) return false;

    this.paneId = match.pane;
    this.tabId = match.tab;
    this.spaceId = spaceId;
    setShared(
      TABS_SHARED_KEY,
      upsertTabRecord(shared(TABS_SHARED_KEY), spaceList, paneList, {
        tab: this.tabId,
        space: this.spaceId,
        pane: this.paneId,
        file: this.file,
      }),
    );
    return true;
  }

  close() {
    if (checking() || !this.tabId) return;
    setShared(TABS_SHARED_KEY, removeTabRecord(shared(TABS_SHARED_KEY), spaces(), panes(), this.tabId));
    this.tabId = null;
    this.spaceId = null;
    this.paneId = null;
  }

  load(cx) {
    if (!this.file) return;
    const seq = ++this.seq;
    const target = this.file;
    this.loading = true;
    this.error = null;

    cx.spawn(async (cx) => {
      try {
        const text = await readTextFile(target);
        if (seq !== this.seq) return;
        if (text === null) {
          this.content = null;
          this.error = "This file is no longer available";
          return;
        }
        if (text.includes("\0")) {
          this.content = null;
          this.error = "Binary file · no Markdown preview";
          return;
        }
        if (text !== this.content) {
          this.content = text;
          this.renderVersion++;
        }
        this.error = null;
      } catch {
        if (seq === this.seq) {
          this.content = null;
          this.error = "Cannot read this file (too large or unreadable)";
        }
      } finally {
        if (seq === this.seq) {
          this.loading = false;
          cx.notify();
        }
      }
    });
  }

  render(cx) {
    if (!checking() && this.tabId && this.file) {
      const reload = /** @type {{ tab?: string, seq?: number } | null | undefined} */ (shared(RELOAD_SHARED_KEY));
      if (reload?.tab === this.tabId && typeof reload.seq === "number" && reload.seq !== this.lastReloadSeq) {
        this.lastReloadSeq = reload.seq;
        this.load(cx);
      }
    }

    const t = theme();
    const rawSize = Number(settings()?.font_size);
    const bodySize = Number.isFinite(rawSize) && rawSize > 0 ? rawSize : 14;
    const title = tabTitle(this.file);

    const header = h_flex()
      .id("md-header")
      .h(38)
      .flex_none()
      .px(16)
      .gap(10)
      .items_center()
      .bg(t.surface)
      .border_b(1)
      .border_color(t.border)
      .child(div().id("md-title").flex_none().text_size(13).font_semibold().text_color(t.foreground).child(title))
      .child(
        div()
          .id("md-readonly")
          .flex_none()
          .px(6)
          .py(1)
          .rounded(4)
          .border(1)
          .border_color(t.border)
          .text_size(10)
          .text_color(t.dim)
          .child("Read-only"),
      )
      .when(Boolean(this.file), (el) =>
        el.child(
          div()
            .id("md-path")
            .flex_1()
            .min_w(0)
            .truncate()
            .text_right()
            .font_family(DATA_FONT)
            .text_size(11)
            .text_color(t.dim)
            .child(this.file),
        ),
      );

    let body;
    if (!this.file) {
      body = div().id("md-empty").p(24).text_size(13).text_color(t.dim).child("No Markdown file selected");
    } else if (this.error) {
      body = div().id("md-error").p(24).text_size(13).text_color(t.ansi1).child(this.error);
    } else if (this.content === null) {
      body = div().id("md-loading").p(24).text_size(13).text_color(t.dim).child("Loading…");
    } else if (this.content === "") {
      body = div().id("md-blank").p(24).text_size(13).text_color(t.dim).child("Empty Markdown file");
    } else {
      body = v_flex()
        .id("md-scroll")
        .flex_1()
        .min_h(0)
        .overflow_y_scrollbar()
        .items_center()
        .px(28)
        .py(22)
        .child(
          div()
            .id("md-content")
            .w_full()
            .max_w(READING_MAX_W)
            .min_w(0)
            .text_size(bodySize)
            .child(
              TextView.markdown(`md-doc-${this.renderVersion}`, this.content)
                .selectable(true)
                .raw_html(false),
            ),
        );
    }

    return v_flex()
      .id("md-viewer")
      .size_full()
      .min_h(0)
      .bg(t.background)
      .text_color(t.foreground)
      .child(header)
      .child(body);
  }
}
