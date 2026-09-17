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

### Files reopen where you left off

Each HTML file reopens at the spot you last scrolled to, whether you switched tabs, closed
the tab, or restarted Obsidian. The position is saved a moment after each scroll and again
when the file is swapped out, and it follows the file through renames. Scrolling back to the
very top forgets the entry. Pages that scroll a nested wrapper instead of the document are
handled too.

Positions live in Obsidian's local storage for this vault on this machine, outside the vault
folder. A vault kept in git or synced by other means never sees them change, so there is
nothing to ignore and nothing to conflict. The flip side is that each machine keeps its own
positions. The feature is on by default and has a toggle in settings.

### Settings reduced to three options

Everything else was either a mode that no longer exists or a default that never needed
changing, so the settings tab is down to the zoom gesture toggle, the vim navigation toggle,
and the remembered scroll position toggle. Hotkeys come from
Obsidian's own hotkey settings. Dropped along the way: operating mode, background color
override, extra file extensions, and MHTML support (`.mht` / `.mhtml` files are no longer
opened).

### Vim navigation keys

`obsidian-vimrc-support` reaches the editor through `view.editMode?.editor?.cm?.cm`, which
only exists on a MarkdownView. An HTML view has no CodeMirror instance, so that plugin cannot
touch it. This fork carries its own normal-mode key engine for rendered files instead, and it
reads the same `.obsidian.vimrc` so one config drives both kinds of view.

Built in, with counts (`10j`, `3<C-d>`):

| Keys | Action |
|---|---|
| `j` `k` `<C-e>` `<C-y>` | scroll one line |
| `h` `l` | scroll sideways |
| `<C-d>` `<C-u>` `J` `K` | half a page |
| `<C-f>` `<C-b>` | a full page |
| `gg` `G` | top and bottom of the page |
| `0` `^` `$` | left and right edge |
| `/` `n` `N` | open the find bar, next and previous match |
| `zz` `zt` `zb` | accepted and ignored, so `10jzz` style mappings still work |

From the vimrc it reads `exmap <name> obcommand <id>`, the normal-mode `map` family
(`map`, `noremap`, `nmap`, `nnoremap`), `unmap` and `nunmap`, `let mapleader`, and `source`.
A mapping's right-hand side must be either `:<exmap-name><CR>` or `:obcommand <id><CR>`,
which runs that Obsidian command, or a chain of the built-in motions above such as `10jzz`
or `^`. Anything that needs a cursor or edits text (`y$`, `<C-q>`, mark and register tricks)
is skipped, since a rendered page has nothing for it to act on. In practice that means
`nnoremap <Space>f :switchfiles<CR>` opens the quick switcher from an HTML file and
`nnoremap J 10jzz` scrolls ten lines, while visual-mode and insert-mode lines are ignored.

A line written as a comment with an `html:` prefix applies only to rendered HTML files, so a
key can mean one thing in the Markdown editor and another here. vimrc-support skips comment
lines, so nothing else sees it:

    nnoremap J 10jzz
    " html: nnoremap J <C-d>

Multi-key sequences wait one second for the next key, matching Vim's `timeoutlen`. Keys typed
in a page's own `input`, `textarea`, `select`, or `contenteditable` are left alone, Space and
Enter stay with a focused button or link, and a page that calls `preventDefault()` on a
keydown keeps that key for itself. Arrow and Page keys are deliberately untouched so the
browser keeps scrolling whichever nested block has focus. If the document
does not scroll, the largest scrollable element in the page is scrolled instead, which covers
layouts that put the content in a fixed-height wrapper.

The vimrc is re-read when a file is opened, and an open view notices edits to it within a
couple of seconds of the next keystroke. The feature is on by default and has a toggle in
settings.

## Installing with BRAT

[BRAT](https://github.com/TfTHacker/obsidian42-brat) installs plugins straight from a GitHub
repo and can keep them updated. This repo is public, so no token is needed.

1. Install and enable **BRAT** from Community plugins.
2. **Settings → BRAT → Beta plugin list → Add beta plugin**, enter:

       bellicose100xp/obsidian-html-reader-plus

   Leave the version blank to track the latest release.
3. Enable **HTML Reader Plus** in Community plugins, and disable HTML Reader if it is
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
