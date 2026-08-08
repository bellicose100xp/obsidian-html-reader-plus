# HTML Reader Plus

An Obsidian plugin for reading `.html` and `.htm` files. Fork of
[HTML Reader](https://github.com/nuthrash/obsidian-html-plugin) v1.0.15.

The goal is to render a file exactly as a browser would, and to keep Obsidian itself
behaving normally while you are looking at one.

## What is different from upstream

### Files render as written

Upstream shipped five operating modes, four of which sanitized the file to some degree,
stripping scripts, attributes, and whole elements. This fork keeps only the faithful path:
no sanitizing, no script stripping, no injected CSP, no forced background color. The only
change made to a file is a `<base href>` so relative links and images resolve against the
file's own folder.

That means **scripts in the files you open will run**. Every mode that prevented that is
gone, along with the mode setting itself. Only open files you trust.

### Sticky page headers stay pinned

Upstream set `overflow-y: auto` on the rendered document's `<body>`, making it a scroll
container. Elements using `position: sticky` still resolve against the iframe viewport, so
a page's anchored top bar scrolled away instead of staying put.

The horizontal clamp now uses `overflow-x: clip` instead of `hidden`. Both clip the same
way, but `clip` does not create a scroll container, so `<body>` stays out of the way and the
iframe viewport remains the scrollport that sticky resolves against. Wide content is still
kept from scrolling sideways.

### Fixed sidebars and floating buttons stay put

Upstream always set `transform: scale(...)` on `<html>` to apply the zoom level, including
at the default zoom of 1.0 where it changes nothing visible. A transform makes that element
the containing block for its descendants, so `position: fixed` resolves against `<html>`
rather than the viewport and behaves like `position: absolute`. Fixed sidebars and floating
back-to-top buttons drifted with the content instead of staying anchored.

The zoom is now skipped entirely at 1.0. Zooming still works, and returning to 1.0 restores
fixed positioning.

Note that any zoom other than 1.0 reintroduces the containing block, so fixed elements will
drift again while zoomed. That is inherent to implementing zoom with a transform.

### Obsidian hotkeys keep working inside rendered files

Most shortcuts already worked through upstream's bubble-phase event re-dispatch. The gap was
pages that run their own scripts and call `stopImmediatePropagation()` on `keydown` during
the capture phase: that killed the event before Obsidian's keymap saw it, so every shortcut
went dead while such a file was open.

Registering another capture listener does not help, because the page's listener is
registered first and `stopImmediatePropagation()` drops the rest on the same target and
phase. So keyboard events are made unstoppable inside the iframe realm and a copy is
forwarded to `app.keymap.onKeyEvent()`, the same entry point Obsidian uses for webviews.

- only `KeyboardEvent` is affected, mouse and touch handling is untouched
- keystrokes in a page's own `input`, `textarea`, `select`, or `contenteditable` are left
  alone, so typing in an embedded search box does not fire single-key hotkeys
- the page's own key handlers still run

### Settings reduced to one option

Everything else was either a mode that no longer exists or a default that never needed
changing, so the settings tab is down to the zoom gesture toggle. Hotkeys come from
Obsidian's own hotkey settings. Dropped along the way: operating mode, background color
override, extra file extensions, and MHTML support (`.mht` / `.mhtml` files are no longer
opened).

### Not fixed: Vim keybindings

`obsidian-vimrc-support` reaches the editor through `view.editMode?.editor?.cm?.cm`, which
only exists on a MarkdownView. An HTML view has no CodeMirror instance, so `.vimrc` mappings
cannot apply without reimplementing motions against the rendered document.

## Installing with BRAT

[BRAT](https://github.com/TfTHacker/obsidian42-brat) installs plugins straight from a GitHub
repo and can keep them updated. Because this repo is **private**, BRAT needs a token before
it can see it.

1. Install and enable **BRAT** from Community plugins.
2. Create a GitHub personal access token with read access to this repo:
   - Fine-grained: [github.com/settings/personal-access-tokens/new](https://github.com/settings/personal-access-tokens/new),
     scope it to `obsidian-html-reader-plus`, and grant *Contents: Read-only*.
   - Classic tokens work too, with the `repo` scope.
3. In Obsidian: **Settings → BRAT → Personal access token**, paste it in.
4. **Settings → BRAT → Beta plugin list → Add beta plugin**, enter:

       bellicose100xp/obsidian-html-reader-plus

   Leave the version blank to track the latest release.
5. Enable **HTML Reader Plus** in Community plugins, and disable HTML Reader if it is
   installed. Both claim `.html`, so only run one.

BRAT reads `main.js` and `manifest.json` from a GitHub **release**, not from the repo tree,
so a plain `git push` will not update anything on its own. Cut a release for each version you
want to roll out (see below).

To pick up new versions, use *Check for updates to all beta plugins*, or enable auto-update
on startup in BRAT's settings. Auto-update means whatever is in the newest release lands in
your vault, so only release commits you have actually tested.

## Installing manually

Copy `main.js` and `manifest.json` into
`<vault>/.obsidian/plugins/obsidian-html-reader-plus/`, then enable the plugin. Reload
Obsidian if it does not appear.

## Building

    npm install
    node esbuild.config.mjs production

Use esbuild directly. `npm run build` also runs `tsc`, which fails on type errors that were
already present upstream and are unrelated to these changes.

## Cutting a release for BRAT

`main.js` is deliberately gitignored, since the built bundle belongs in release assets
rather than the repo tree. Bump the version in `manifest.json` and `package.json` to match
the tag, then:

    node esbuild.config.mjs production
    gh release create 1.0.16 main.js manifest.json --title 1.0.16 --notes "what changed"

The tag and `manifest.json`'s `version` must match, or BRAT will not see the release.

## Credit

Original plugin by [Nuthrash](https://github.com/nuthrash/obsidian-html-plugin), MIT
licensed. This fork keeps that license.
