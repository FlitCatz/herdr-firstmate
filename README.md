# Firstmate for Herdr

A Herdr layout with a Firstmate task board, read-only Files and Changes viewer, and tab bar with a Board button.
Requires Herdr 0.1.16 or later.
It requires a Firstmate installation and home containing its `bin/`, `data/`, `state/`, and `projects/` folders, plus `hc` and the usual Unix command-line tools.

To add it using Herdr's sharing steps:

1. Read [RECIPE.md](RECIPE.md) and the files first: the board runs programs, including Firstmate scripts and `hc`, and reads the Firstmate home and selected project folders outside the mod folder.
2. Copy `layouts/firstmate.json` into your Herdr home's `layouts/` and the two `mods/` folders into its `mods/`, leaving the recipe, preview, and tests out.
   The default Herdr home is `~/.config/herdr-app`.
   Never overwrite a name: rename the incoming layout or mod and update its layout references and `mods/<name>/` asset paths if a name is taken.
3. Set the `home` prop on the layout's `fm-board` block to the absolute path of your Firstmate installation and home.
   Run `herdr-app check` on each installed mod folder, then select the Firstmate layout in Herdr settings or run `herdr-app do layout.switch --name firstmate` with your chosen layout name.

Card headers fold and unfold; their Ask icons and held decisions' options prepare editable chat input as described in [RECIPE.md](RECIPE.md#how-it-behaves).
The Held column groups its cards under the headings `Answer now`, `Deferred` (with a card's `until` date when it has one), and `Waiting on other work`.
A card lists every decision its worker still has open, and answering one from the card names its key in the draft so Firstmate can close exactly that decision.
Cards whose worker has its own copy of the project open it in the Files and Changes viewer with a `Files · Changes` button.
Cards with a live worker terminal end in a separate Live strip with Open worker and Peek icons, where Peek opens that terminal over the current tab, and the last lines of the worker's screen, refreshed every few seconds.
A card whose worker terminal still runs a job after its agent's turn ended, such as a build, a test run, or a CI wait, says so with `백그라운드 실행 중: <job>`, and a Paused card is drawn in Working while that job runs.
A Paused card shows `Waiting for: <reason>` from its worker's latest `paused` status line (with machine noise stripped and `until` times shown in local time; the row puts any waiting, `until`, or resume clause first, while the tooltip keeps the full cleaned text in its original order), alongside any background-job row when both apply.
Cards in every column show dependency badges derived from `unresolved_blocker_ids`: `★ Blocks N →` on tasks that downstream work waits on, and `← Waits on …` on tasks waiting on unfinished blockers.
Hovering a card in a dependency chain highlights its upstream, selected, and downstream tasks by color, and clicking one marks them with `Upstream`, `Selected`, and `Downstream` labels; clicking a badge or the toolbar `Inspector` button opens the connected chain grouped by topological level in the Dependency Inspector (in the right `h_resizable` split when the Board half beside it stays at least 720px wide, otherwise pinned as a compact chain card at the top of the board), dims unrelated cards while a chain is selected, and lets you click any node to highlight its card, show it unfolded, and scroll to it (`Esc` or `Close` clears it).
A `Kanban | Chains` toggle beside the search bar switches between the default Kanban columns and the Chains swimlane view (and remembers the choice): Chains groups unfinished tasks into one collapsible swimlane per connected dependency component (ordered by most-blocking and deepest chain first), lays out each chain on a dependency-level grid (`L0`…`Ln`) with fixed-width hairline cards joined by right-angle connectors with rounded elbows and arrowheads (dashed for cross-project links) and side branches aligned by level (switching below 720px wide to a vertical stepper), highlights upstream and downstream paths by color and opacity against an always-visible legend, puts tasks without dependencies into a collapsible `Independent` drawer at the bottom, applies the same search filtering, and opens the same card detail when a node is clicked.

The Commands section's Memo button saves what is typed in the field as a Firstmate inbox note that asks Firstmate to file it in the backlog without starting work. Unlike Scout and Task it never types into the Firstmate terminal, so a note jotted while Firstmate is stopped on a usage limit is still written to disk at once and shows in the Projects list as a pending request.

A footer below the columns shows supervision watcher status and the latest refresh time, followed by a collapsible Registered checks section that lists `state/*.check.sh` filenames alongside the home-wide `state/.last-check` sweep time in local time (`Last sweep (all checks)`). Per-check running state, last-run time, and results are not recorded by Firstmate and are not displayed, and the Board never reads check scripts, outputs, or private check state directories.

The preview uses fictional projects and tasks.

`node --test tests/` checks the board's cards against a fictional snapshot in the real `fm-fleet-snapshot.v1` shape, registered checks, tab behavior, folder-watch cleanup, and check-mode side-effect guards; it needs only Node.js, not Herdr.
This repository has no CI and declares that to no-mistakes in `.no-mistakes.yaml`.
