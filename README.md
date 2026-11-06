# Firstmate for Herdr

A Herdr layout with a Firstmate task board, read-only Files and Changes viewer, and tab bar with a Board button.
It requires a Firstmate installation and home containing its `bin/`, `data/`, `state/`, and `projects/` folders, plus `hc` and the usual Unix command-line tools.

To add it using Herdr's sharing steps:

1. Read [RECIPE.md](RECIPE.md) and the files first: the board runs programs, including Firstmate scripts and `hc`, and reads the Firstmate home and selected project folders outside the mod folder.
2. Copy `layouts/firstmate.json` into your Herdr home's `layouts/` and the two `mods/` folders into its `mods/`, leaving the recipe and preview out.
   The default Herdr home is `~/.config/herdr-app`.
   Never overwrite a name: rename the incoming layout or mod and update its layout references and `mods/<name>/` asset paths if a name is taken.
3. Set the `home` prop on the layout's `fm-board` block to the absolute path of your Firstmate installation and home.
   Run `herdr-app check` on each installed mod folder, then select the Firstmate layout in Herdr settings or run `herdr-app do layout.switch --name firstmate` with your chosen layout name.

Card headers fold and unfold; their Ask icons and decision options prepare editable chat input as described in [RECIPE.md](RECIPE.md#how-it-behaves).

The preview uses fictional projects and tasks.
