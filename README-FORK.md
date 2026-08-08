# HTML Reader Plus

Fork of [HTML Reader](https://github.com/nuthrash/obsidian-html-plugin) v1.0.15 with two fixes.

## Sticky page headers stay pinned

Upstream set `overflow-y: auto` on the rendered document's `<body>`, which made body a
scroll container. Elements using `position: sticky` still resolve against the iframe
viewport, so a page's anchored top bar scrolled out of view instead of staying put.

The horizontal clamp now uses `overflow-x: clip` rather than `hidden`. Both clip the same
way, but `clip` does not create a scroll container, so `<body>` stays out of the way and
the iframe viewport remains the scrollport sticky resolves against. Wide content is still
prevented from scrolling sideways.

## Obsidian hotkeys keep working inside rendered files

Most shortcuts already worked through the existing bubble-phase re-dispatch. The gap was
pages that run their own scripts and call `stopImmediatePropagation()` on `keydown` in the
capture phase: that killed the event before Obsidian's keymap saw it, so every shortcut
went dead while such a file was open.

Registering another capture listener does not help, because the page's listener is
registered first and `stopImmediatePropagation()` drops the rest on the same target and
phase. So keyboard events are made unstoppable inside the iframe realm and a copy is
forwarded to `app.keymap.onKeyEvent()`, the same entry point Obsidian uses for webviews.

Scope of that change:

- only `KeyboardEvent` is affected, mouse and touch handling is untouched
- keystrokes in a page's own `input`, `textarea`, `select`, or `contenteditable` are left
  alone, so typing in an embedded search box does not trigger single-key hotkeys
- the page's own key handlers still run

## Not fixed: Vim keybindings

`obsidian-vimrc-support` reaches the editor through `view.editMode?.editor?.cm?.cm`, which
only exists on a MarkdownView. An HTML view has no CodeMirror instance, so `.vimrc`
mappings cannot apply without reimplementing motions against the rendered document.

## Build

    npm install
    node esbuild.config.mjs production

`npm run build` also runs `tsc`, which fails on pre-existing upstream type errors unrelated
to these changes.

## Fixed sidebars and floating buttons stay put

Upstream always set `transform: scale(...)` on `<html>` to apply the zoom level, including
at the default zoom of 1.0 where it does nothing visible. A transform makes that element
the containing block for its descendants, so `position: fixed` resolves against `<html>`
rather than the viewport and behaves like `position: absolute`. Fixed sidebars and floating
back-to-top buttons scrolled away with the content instead of staying anchored.

The zoom is now skipped entirely at 1.0 and the transform properties are removed, so fixed
elements resolve against the viewport the way they do in a browser. Zooming still works,
and returning to 1.0 restores fixed positioning.

Note that a zoom other than 1.0 reintroduces the containing block, so fixed elements will
drift again while zoomed. That is inherent to implementing zoom with a transform.
