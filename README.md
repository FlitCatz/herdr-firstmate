# Firstmate for Herdr

A Herdr layout with a Firstmate task board, read-only Files viewer, read-only Markdown terminal-link viewer, and tab bar with PR and Board buttons.
Requires Herdr 0.1.18 or later (for terminal `link_handlers`).
It requires a Firstmate installation and home containing its `bin/`, `data/`, `state/`, and `projects/` folders, plus `hc` and the usual Unix command-line tools.

To add it using Herdr's sharing steps:

1. Read [RECIPE.md](RECIPE.md) and the files first: the board runs programs, including Firstmate scripts and `hc`, and reads the Firstmate home and selected project folders outside the mod folder.
2. Copy `layouts/firstmate.json` into your Herdr home's `layouts/` and the three `mods/` folders (`fm-board`, `fm-tabs`, `fm-md-viewer`) into its `mods/`, leaving the recipe, preview, and tests out.
   The layout's PR panel shows the separate [herdr-pr-viewer](https://github.com/FlitCatz/herdr-pr-viewer) mod: install it as its README says, or remove the `pr` block from the layout's panel stack if you do not want it (the tab bar's PR button only appears while that block exists).
   The default Herdr home is `~/.config/herdr-app`.
   Never overwrite a name: rename the incoming layout or mod and update its layout references and `mods/<name>/` asset paths if a name is taken.
3. Set the `home` prop on the layout's `fm-board` block to the absolute path of your Firstmate installation and home.
   Run `herdr-app check` on each installed mod folder, then select the Firstmate layout in Herdr settings or run `herdr-app do layout.switch --name firstmate` with your chosen layout name.

## Keyboard shortcuts

`fm-board` sets `"focusable": true` in `mod.json` and accepts the `focus` command (`fm-board.focus`, or `pane.go` onto the visible Board panel) to move keyboard focus onto the Board:

- `j` / `k` or `Down` / `Up`: in Kanban, move selection up and down within the current column and stop at its ends (in Chains and Focus mode, move across drawn cards / decision cards)
- `h` / `l` or `Left` / `Right`: in Kanban, move selection to the previous / next non-empty expanded column at the same row (or its last card when shorter), skipping collapsed and empty columns
- `Enter`: in Kanban, fold or unfold the selected card like its header; in Chains, open its detail (outside Focus mode, `Enter` never drafts an answer)
- `?`: put the selected card (or, in Focus mode, the selected call) into the Firstmate input, like its question-mark icon
- `o`: open the selected card's worker terminal
- `f`: toggle Focus mode across decision cards in Kanban (inside Focus mode, `Enter` still drafts the recommended option)
- `Esc`: close what is open on the Board first (Kanban Projects menu, Files viewer, Focus mode, Dependency Inspector / Chains detail, or NEXT MOVE ring); press `Esc` again when nothing is open to return focus to the terminal (`pane.focus`)

The Board is reached through the separate leader-key mod (herdr-leader-keys): `Ctrl+Space` then `b` runs `layout.select` to show the Board panel and then the Board's key command `fm-board.focus`. The leader keeps every terminal key, including `Ctrl+B`, free for the terminal.
When the Board or one of its inputs holds keyboard focus, `fm-board` outlines its full perimeter with a 1px `accent` border (radius `10`, matching the terminal pane over the unfocused `border` outline with no layout shift). The border clears after mouse presses outside the panel, `Esc` or worker focus moves, leader keys, and any key pressed in the panel. The Files, Changes, and PR panels do not get this focus border; [RECIPE.md](RECIPE.md#built-from) explains why.

The board uses the Ledger look it shares with the separate PR viewer mod: hairline-ruled headings, columns split by hairlines, a status-colored bar on each card's left edge, and Geist Mono for counts and ids.
A Today strip counts what was done today, what waits on you, what is working, what is ready to land (unmerged PRs and finished local-only branches waiting for landing approval), and what is blocked. Below it, a NEXT MOVE band shows the longest-waiting hold to answer now, with its options as answer drafts. Its first line names the card the hold belongs to, and clicking it brings that card into view on the board.
`Focus` (or `f`) dims everything but your calls, `j`/`k` move between them while peeking at each worker's terminal beside the board, and `Enter` drafts the recommended answer.
PR links show the PR in the layout's PR panel (the separate herdr-pr-viewer mod, opened with the tab bar's PR button) when that mod is installed and the layout has that panel, and in the browser otherwise.
Card headers fold and unfold and select the card (a double-click toggles once); clicking a Kanban card's body only selects it; `?` or their Ask icons and held decisions' options prepare editable chat input as described in [RECIPE.md](RECIPE.md#how-it-behaves).
The Held column groups its cards under the headings `Answer now`, `Deferred` (with a card's `until` date when it has one), and `Waiting on other work`.
There is no Failed column: a task whose worker reported `failed:` is drawn in the Blocked column with a red `Failed` label and a red border.
A card lists every decision its worker still has open, and answering one from the card names its key in the draft so Firstmate can close exactly that decision.
Cards whose worker has its own copy of the project open it in the Files viewer with a `Files` button. File contents open in Herdr's read-only code editor, with selection and copy, and syntax colors taken from Herdr `theme()` when the file opens, so a light or dark theme switch applies to the next file opened.
Cards with a live worker terminal end in a separate Live strip with Open worker and Peek icons, where Peek opens that terminal over the current tab, and the last lines of the worker's screen, refreshed every few seconds.
A card whose worker terminal still runs a job after its agent's turn ended, such as a build, a test run, or a CI wait, says so with `백그라운드 실행 중: <job>`, and a Paused card is drawn in Working while that job runs.
A Paused card shows `Waiting for: <reason>` from its worker's latest `paused` status line (with machine noise stripped and `until` times shown in local time; the row puts any waiting, `until`, or resume clause first, while the tooltip keeps the full cleaned text in its original order), alongside any background-job row when both apply.
Cards in every column show dependency badges derived from `unresolved_blocker_ids`: `★ Blocks N →` on tasks that downstream work waits on, and `← Waits on …` on tasks waiting on unfinished blockers.
Hovering a card in a dependency chain highlights its upstream, selected, and downstream tasks by color, and clicking one marks them with `Upstream`, `Selected`, and `Downstream` labels; clicking a badge or the toolbar `Inspector` button opens the connected chain grouped by topological level in the Dependency Inspector (in the right `h_resizable` split when the Board half beside it stays at least 720px wide, otherwise pinned as a compact chain card at the top of the board), dims unrelated cards while a chain is selected, and lets you click any node to highlight its card, show it unfolded, and scroll to it (`Esc` or `Close` clears it).
A `Kanban | Chains` toggle beside the search bar switches between the default Kanban columns and the Chains swimlane view (and remembers the choice): in Kanban, a horizontally scrollable project tab strip sits above the columns with `All` first followed by one tab per project with Kanban cards and its card count (keeping any selected or hidden project's tab even at zero so you can change it back, remembering the selected tab across Board reloads and Herdr restarts, and keeping untagged cards visible under `All`); selecting a project tab shows only that project's cards while `All` returns to the multi-project view, and a secondary `Projects` button opens a popover to mark repository tags `Visible` or `Invisible` under `All` (starting with all projects visible, retaining the choice in local storage across Board reloads and Herdr restarts, and leaving Today/NEXT MOVE, Chains, and backlog data untouched); while any project is hidden under `All`, the `Projects` button shows the hidden count and its popover offers a one-step `Show all` action to restore every project's visibility; clicking a Dependency Inspector node of a card filtered out by the active project tab or hidden under `All` shows only that card briefly, with the NEXT MOVE ring, without changing the saved selection or visibility choice. Chains groups unfinished tasks into one collapsible swimlane per connected dependency component (ordered by most-blocking and deepest chain first), lays out each chain on a dependency-level grid (`L0`…`Ln`) with fixed-width hairline cards joined by right-angle connectors with rounded elbows and arrowheads (dashed for cross-project links) and side branches aligned by level (switching below 720px wide to a vertical stepper), highlights upstream and downstream paths by color and opacity against an always-visible legend, puts tasks without dependencies into a collapsible `Independent` drawer at the bottom, applies the same search filtering, and opens the card's detail below its lane when a node is clicked.

The Commands section's Memo button saves what is typed in the field as a Firstmate inbox note that asks Firstmate to file it in the backlog without starting work. Unlike Scout and Task it never types into the Firstmate terminal, so a note jotted while Firstmate is stopped on a usage limit is still written to disk at once and shows in the Projects tab as a pending request, counted on the tab itself (`2 pending`) so it is not missed.

Below the board, one tab strip holds `Commands`, `Projects` (with its count of unhandled requests), and `Checks`, with supervision watcher status and the latest refresh time on its right.
Each project row shows its delivery-mode chip and, when auto-merge is on, a small `Auto-merge` tag beside the project name on wide panels or below it on narrow panels.
The `Files` and `Open terminal` buttons stay on the title line.
Left-clicking `Open terminal` opens a focused terminal tab at the project's folder, and right-clicking opens a `Split Vertical` / `Split Horizontal` / `New Tab` menu.
Clicking the open tab folds the group away, and the chosen tab is remembered. Dragging the `Files` split divider remembers its width locally across closes, reopens, and Herdr restarts (first open keeps the 1:1 default). The Checks tab lists `state/*.check.sh` filenames alongside the home-wide `state/.last-check` sweep time in local time (`Last sweep (all checks)`). Per-check running state, last-run time, and results are not recorded by Firstmate and are not displayed, and the Board never reads check scripts, outputs, or private check state directories.

Cmd/Ctrl-clicking an existing local Markdown file path (`.md`) printed in a Herdr terminal opens it in a focused, read-only tab in the current space (`fm-md-viewer`, registered via `layouts/firstmate.json` `link_handlers`), rendered with Herdr's native `TextView.markdown` with raw HTML disabled; clicking the same file again selects and focuses that space's open tab. URLs, remote terminal paths, non-Markdown files (including `.markdown`), and missing or unreadable files pass through unchanged to Herdr's default link path.

The preview is a headless render of an HTML replica of the board, using fictional projects and tasks.

`node --test tests/` checks the board's cards against a fictional snapshot in the real `fm-fleet-snapshot.v1` shape, hiding retained decision options on done Kanban cards, Kanban project focus tabs, per-project visibility filtering, and persistence, registered checks, tab behavior, folder-watch cleanup, Files viewer syntax colors, git status marks, and path guards, check-mode side-effect guards, Board keyboard navigation, card folding, and escape behavior, and `fm-md-viewer` link routing, tab reuse, and read-only Markdown rendering; it needs only Node.js, not Herdr.
This repository has no CI and declares that to no-mistakes in `.no-mistakes.yaml`.
