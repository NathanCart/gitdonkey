---
version: 1
slug: "src-renderer-index-html"
primary_target: "src/renderer/index.html"
related_targets: []
---

# GitDonkey desktop app (main repository window)

Scope: the whole renderer (tabs, toolbar, sidebar, commit graph, commit panel, diff/merge views, welcome, dialogs). Visitor mode: Operate.

Audience and job: a dev team of mixed Git skill doing daily Git work for hours, beside editor and terminal, often in dim rooms. Dark is the primary theme (user requirement).

Memorable moment: dragging one branch's plug onto another draws a live sagging cable; dropping patches them (merge / rebase / fast-forward / push).

Unresolved: none blocking. Light theme is out of scope for v1.

## Direction contract

THESIS: GitDonkey is a patched modular rig: branches are cables, commits are jacks, merging is patching one cable into another. It refuses the category default of slate-gray IDE panels, one teal accent and avatar bubbles.

OWN-WORLD: Matte black anodized panels on 1px seams, warm white screen-printed legends, a wide hardware face (Michroma) for panel legends and the wordmark, the system sans for content, mono only for SHAs and code. A ten-colour cable palette drives lanes and ref plugs. Flat pin LEDs carry state. The primary action is a white keycap. No glow, gradients, knobs or screws.

STORY: A teammate opens a repo, sees where they are from the lit HEAD plug and the LEDs, stages and commits in the right-hand module, and merges by patching one branch onto another.

FIRST VIEWPORT: 38px tab rail; 60px toolbar of keyed modules (repo and branch plugs left; Undo, Redo, Pull, Push, Branch, Stash, Pop); 248px jack-field sidebar; the graph case centre with cables and stamped SHA codes; 384px commit module right; 24px status strip with LEDs.

FORM: Patch Bay, position 5 on my ordered list, seed 93e2bd6e. Signature interaction: drag-to-patch cable. Motion grammar: switch-throw steps of 120ms or less, no easing curves.

FINISH: unreviewed and undocumented is unfinished; this build ends with the finish review, the verdict, DESIGN.md, and every shipping raster carrying its provenance
