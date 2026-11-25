// Minimal read-only Markdown document tab for terminal Cmd/Ctrl-clicked .md files.
// Renders local Markdown using Herdr's native TextView.markdown with raw HTML disabled.
// props: { file: string, tag?: string } (tag: the unique open tag link.js gave this tab)
import { View, div } from "gpui-kit";
import { TextView, h_flex, v_flex } from "gpui-base";
import { checking, home, panes, props, readTextFile, run, setShared, settings, shared, spaces, theme } from "herdr";
import {
  PENDING_SHARED_KEY,
  TABS_SHARED_KEY,
  findTaggedViewerTab,
  livePending,
  normalizeLocalPath,
  tabTitle,
  withTabRecord,
} from "./state.js";

const DATA_FONT = "Geist Mono";
const READING_MAX_W = 820;

export default class FmMdViewer extends View {
  init(p, cx) {
    const src = p && typeof p === "object" && "file" in p ? p : props();
    this.file = normalizeLocalPath(src?.file, null, home());
    this.tag = typeof src?.tag === "string" && src.tag ? src.tag : null;
    this.content = null;
    this.error = null;

    if (checking() || !this.file) return;
    this.load(cx);
  }

  load(cx) {
    const target = this.file;
    cx.spawn(async (cx) => {
      try {
        const text = await readTextFile(target);
        if (text === null) {
          this.error = "This file is no longer available";
        } else if (text.includes("\0")) {
          this.error = "Binary file · no Markdown preview";
        } else {
          this.content = text;
        }
      } catch {
        this.error = "Cannot read this file (too large or unreadable)";
      } finally {
        cx.notify();
      }
    });
  }

  bindOwnTab() {
    const spaceList = spaces();
    const paneList = panes();
    const own = findTaggedViewerTab(spaceList, paneList, this.file, this.tag);
    if (!own) return;
    const tag = this.tag;
    this.tag = null;
    setShared(TABS_SHARED_KEY, withTabRecord(shared(TABS_SHARED_KEY), spaceList, paneList, { ...own, file: this.file }));
    setShared(PENDING_SHARED_KEY, livePending(shared(PENDING_SHARED_KEY), Date.now()).filter((p) => p.tag !== tag));
    run("tab.rename", { id: own.tab, name: tabTitle(this.file) });
  }

  render() {
    if (this.tag && this.file && !checking()) this.bindOwnTab();
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
              TextView.markdown("md-doc", this.content)
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
