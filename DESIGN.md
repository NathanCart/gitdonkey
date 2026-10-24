---
name: GitDonkey
description: A visual Git client built as a patched modular rig; branches are cables, commits are jacks.
colors:
  case: "#0b0c0e"
  panel: "#131417"
  panel-2: "#191a1e"
  panel-3: "#202227"
  panel-4: "#292b31"
  seam: "#040405"
  rule: "#24262b"
  rule-2: "#31343a"
  legend: "#ece8df"
  legend-2: "#aaa69e"
  legend-3: "#8e8a81"
  keycap: "#ece8df"
  keycap-hover: "#ffffff"
  keycap-ink: "#0e0f11"
  amber: "#ffb627"
  cyan: "#36c3d0"
  red: "#ff5a3c"
  violet: "#a07cff"
  green: "#86d05a"
  pink: "#ff6fae"
  blue: "#4c8dff"
  orange: "#ff8a3d"
  teal: "#2fd4a3"
  bone: "#d9d4c7"
typography:
  display:
    fontFamily: "Michroma, Eurostile, Microgramma, -apple-system, sans-serif"
    fontSize: "30px"
    fontWeight: 400
    lineHeight: 1.1
    letterSpacing: "0.04em"
  title:
    fontFamily: "-apple-system, BlinkMacSystemFont, 'SF Pro Text', 'Segoe UI', system-ui, sans-serif"
    fontSize: "15px"
    fontWeight: 600
    lineHeight: 1.35
  body:
    fontFamily: "-apple-system, BlinkMacSystemFont, 'SF Pro Text', 'Segoe UI', system-ui, sans-serif"
    fontSize: "13px"
    fontWeight: 400
    lineHeight: 1.4
  label:
    fontFamily: "Michroma, Eurostile, Microgramma, -apple-system, sans-serif"
    fontSize: "10px"
    fontWeight: 400
    lineHeight: 1
    letterSpacing: "0.06em"
  mono:
    fontFamily: "'SF Mono', ui-monospace, 'JetBrains Mono', Menlo, Consolas, monospace"
    fontSize: "12.5px"
    fontWeight: 400
    lineHeight: "20px"
    fontFeature: "tnum"
rounded:
  sm: "3px"
  md: "4px"
  lg: "6px"
spacing:
  xs: "4px"
  sm: "8px"
  md: "12px"
  lg: "16px"
components:
  button-key:
    backgroundColor: "{colors.keycap}"
    textColor: "{colors.keycap-ink}"
    rounded: "{rounded.md}"
    padding: "0 14px"
    height: "30px"
  button-key-hover:
    backgroundColor: "{colors.keycap-hover}"
    textColor: "{colors.keycap-ink}"
  button:
    backgroundColor: "{colors.panel-3}"
    textColor: "{colors.legend}"
    rounded: "{rounded.md}"
    padding: "0 14px"
    height: "30px"
  button-hover:
    backgroundColor: "{colors.panel-4}"
  toolbar-key:
    textColor: "{colors.legend}"
    typography: "{typography.label}"
    rounded: "{rounded.md}"
    padding: "0 8px"
  toolbar-key-hover:
    backgroundColor: "{colors.panel-3}"
  input:
    backgroundColor: "{colors.case}"
    textColor: "{colors.legend}"
    typography: "{typography.body}"
    rounded: "{rounded.md}"
    padding: "0 10px"
    height: "30px"
  plug:
    textColor: "{colors.legend}"
    rounded: "{rounded.sm}"
    padding: "0 7px 0 6px"
    height: "20px"
  plug-lit:
    backgroundColor: "{colors.amber}"
    textColor: "{colors.keycap-ink}"
  stamp:
    backgroundColor: "{colors.case}"
    textColor: "{colors.legend}"
    typography: "{typography.mono}"
    rounded: "{rounded.sm}"
    padding: "0 7px"
    height: "22px"
  menu-item-hover:
    backgroundColor: "{colors.keycap}"
    textColor: "{colors.keycap-ink}"
    rounded: "{rounded.sm}"
    height: "28px"
---

# Design System: GitDonkey

## Overview

**Creative North Star: "The Patch Bay"**

GitDonkey is a patched modular rig. Every surface is a matte black anodized module seated in a case, divided by 1px seams; every label is a warm white legend screen-printed in a wide hardware face; every branch is a coloured patch cable and every commit is a jack it runs through. Merging is literal: you drag one branch's plug onto another and a cable follows the pointer. The metaphor is load-bearing, not decoration: lanes, ref plugs, author identity, selection and state are all expressed as cables, jacks and pin LEDs.

The rig is dense and calm. Rows are 28px, side modules are fixed-width, and colour is spent almost entirely on the ten cable hues, which carry meaning (lane, ref, author, diff status, syntax). Everything else is ply: five near-black panel tones and three legend whites. Motion is a switch being thrown, not a curve being eased: state changes land in two hard steps over 90ms.

It refuses the category default of slate-grey IDE panels with one teal accent and avatar bubbles. It also refuses the hardware-skeuomorph trap: no glow, no colour gradients on surfaces, no knobs, no screws. The hardware lives in the system's vocabulary and its type, not in rendered materials.

**Key Characteristics:**
- Matte black ply (case to panel-4) on 1px seams; depth by tone, not shadow.
- Ten patch-cable hues, alternating warm and cool, with amber always first for HEAD.
- Michroma legends (uppercase, at least 10px) over a system-sans content layer; mono only for SHAs and code.
- A white keycap is the one primary action per module.
- Flat pin LEDs and jacks carry state, identity and selection.
- Stepped motion: 90ms in two steps, no easing curves.

## Colors

A near-black ply with warm white legends, lit only by ten saturated patch-cable hues that always mean something.

### Primary
- **Keycap White** (keycap): The primary action. One white keycap per module (Commit, Stage all, the confirming button in a dialog), the checked checkbox, and the hovered menu item. It shares its value with the legend white so the primary key reads as a printed key, not a coloured button.
- **HEAD Amber** (amber): The first cable. HEAD's lane, the lit HEAD plug, the active tab's top edge, focus rings, text caret, selection highlight and progress fill. Amber is where you are.

### Secondary
- **The Cable Loom** (amber, cyan, red, violet, green, pink, blue, orange, teal, bone): The ten lane colours, assigned by graph column in this exact order so neighbouring lanes alternate warm and cool. The same ten hues colour ref plugs (via the lane), author pin LEDs (hashed by email), and highlight.js syntax. Fixed semantic loans: green is additions and "ahead", red is deletions, conflicts and danger, amber is modified, cyan is renamed and "behind"; in the merge tool cyan is ours and violet is theirs.

### Neutral
- **Case Black** (case): The deepest ply. The graph case, the welcome field, the rail, the status strip, input wells and code stamps.
- **Panel** (panel): Sidebar and commit module faces, graph header, modal bodies.
- **Raised Panel** (panel-2): Module heads, the toolbar face, commit box, menus and toasts.
- **Hover Ply** (panel-3) and **Pressed Ply** (panel-4): Hover and on/pressed fills on keys, rows and segmented controls.
- **Seam** (seam): The 1px gaps between modules. The app grid itself is drawn in seam with a 1px gap.
- **Rule** (rule) and **Strong Rule** (rule-2): Inner dividers and component borders.
- **Legend** (legend): Primary text and printed legends on module heads.
- **Legend Dim** (legend-2): Secondary text, idle icons.
- **Legend Faint** (legend-3): Tertiary text, column legends, SHAs, dates, placeholders. Held at the recorded value for legibility on case black; do not darken it.
- **Keycap Ink** (keycap-ink): Text on keycaps, lit plugs and coloured badges.

### Named Rules
**The Lane Order Rule.** Lanes take the cable palette in order by column: amber, cyan, red, violet, green, pink, blue, orange, teal, bone. Amber is column 0 and therefore HEAD; the alternation of warm and cool is what keeps adjacent cables apart. Never reorder or reshuffle the palette.

**The Colour Means Something Rule.** Cable hues appear only where they encode a lane, ref, author, status or syntax token. Chrome is ply and legend white.

## Typography

**Display Font:** Michroma (with Eurostile, Microgramma, system sans fallback)
**Body Font:** System UI sans (-apple-system, SF Pro Text, Segoe UI)
**Label/Mono Font:** Michroma for legends; SF Mono / ui-monospace for SHAs, diffs and code

**Character:** Michroma is the screen printing on the panel: wide, uppercase, tracked. The system sans is everything a person wrote or reads at length: commit messages, branch names, file paths. Mono is reserved for machine strings.

### Hierarchy
- **Display** (Michroma 400, 30px, 1.1, 0.04em): The wordmark on the welcome screen only.
- **Title** (system 600, 15px, 1.35): The commit subject in the commit-details module; file names in the detail header use 600 at 13.5px.
- **Body** (system 400, 13px, 1.4): Commit messages, branch and file names, controls. Secondary text steps down to 12.5px, 12px and 11.5px.
- **Label** (Michroma 400, 10px, 0.06em, uppercase): Module heads, toolbar key legends, column headers, field legends above the repository and branch plugs. Empty-state titles use the same face at 11 to 12px with 0.08em.
- **Mono** (12.5px/20px for diffs, blame and merge; 11.5 to 12px for SHAs and stamps; tabular figures).

### Named Rules
**The Ten Pixel Floor Rule.** Michroma is never set below 10px. Its wide, thin forms collapse at smaller sizes; if a legend does not fit at 10px, shorten it or drop it (as the toolbar key legends do below 1360px), never shrink it.

**The Printed Legend Rule.** Michroma labels hardware: modules, keys, columns, fields. Content (anything from the repository) is always in the system sans or mono, never Michroma.

## Layout

A fixed rig with a fluid centre. The app is a CSS grid drawn on seam black with 1px gaps: a 38px tab rail, a 62px toolbar of keyed modules, the main area, and a 24px status strip. The main area is a five-column grid: a 248px sidebar, 1px splitter, the graph case (minimum 320px), 1px splitter, and the 392px commit module. Both side modules can be hidden and resized by their splitters.

The graph is a column grid shared by its header and every 28px row: refs (176px), graph lanes, message (flexible, minimum 120px), author (120px), date (88px), SHA (72px). The graph pane is a container: below 720px the author column drops (the commit module repeats it); below 560px the SHA drops. SHA is the last column to go.

The toolbar hides key legends below 1360px viewport width and keeps icons only. Spacing runs on a tight 4px-based rhythm (4, 6, 8, 10, 12, 14, 16); module heads are 36px, list rows 26px, graph rows 28px.

## Elevation & Depth

Depth is tonal. The resting rig is completely flat: modules sit at different ply tones (case, panel, panel-2) separated by seams, and hover and pressed states step one ply lighter. Shadows exist only on things that float above the rig: menus, modals, toasts, the expanded multi-ref stack, the selection bar and the patch label. They are soft and dark, never coloured, and never glow.

### Shadow Vocabulary
- **Floating overlay** (`box-shadow: 0 14px 40px rgba(0, 0, 0, 0.6)`): Context menus; toasts use 0.55 alpha.
- **Modal** (`box-shadow: 0 24px 64px rgba(0, 0, 0, 0.6)`): Dialogs over a 66% seam scrim.
- **Lifted strip** (`box-shadow: 0 8px 24px rgba(0, 0, 0, 0.5)`): The expanded ref stack on hover.
- **Selection bar** (`box-shadow: 0 10px 30px rgba(0, 0, 0, 0.55)`): The floating line-selection bar in the diff view.

### Named Rules
**The Flat Rig Rule.** Nothing seated in the rig casts a shadow. Only overlays float.

**The Seam Rule.** Modules are separated by 1px seam gaps or seam borders, not by margins or outlines.

## Shapes

Small, machined corners. Controls use 4px; plugs, stamps, chips, menu items and checkboxes use 3px; floating surfaces (modals, menus, toasts, the welcome module) use 6px. Tabs round only their top corners. The circle is the system's signature form: jacks (a coloured ring around a case-black hole, with a white core when lit), pin LEDs (7px flat dots), and the graph's commit jacks. Cables are 3.5px with round caps and joins. Remote refs are drawn with a dashed border; uncommitted work with a dashed jack and dashed cable. Hatching (fine 135-degree stripes) marks absent content in split diffs and collapsed context.

## Components

### Buttons
Printed keys on a dark face: quiet until pressed, with one white keycap per module.
- **Shape:** gently machined corners (4px), 30px tall; small 26px and tiny 22px variants.
- **Primary (keycap):** keycap white face, keycap-ink text, weight 600. Hover goes to pure white. Disabled falls back to the hover ply with faint legend text. Danger keycap swaps the face to red.
- **Secondary:** hover-ply face with a strong-rule border and legend text; steps to pressed ply on hover.
- **Toolbar keys:** borderless icon over a Michroma legend, grouped into modules separated by short vertical rules. Hover fills with hover ply. Ahead and behind counts sit as small green and cyan badges on the Pull and Push keys.
- **Focus:** 2px amber outline, 1px offset.

### Plugs (refs)
Branch, remote and tag labels are plugs: a 20px pill tinted 16% with its lane colour, a 55% lane-colour border, and a small jack. The HEAD plug is lit: a solid lane-colour face with keycap-ink text. Remote plugs use a dashed border; tags are neutral ply. Plugs are draggable, and dragging one draws a live patch cable to the drop target, which takes a 2px legend outline.

### Inputs / Fields
- **Style:** case-black well, strong-rule border, 4px corners, 30px tall (commit summary 34px).
- **Focus:** border turns amber; no glow.
- **Labels:** 12px weight-600 field labels in legend-2; hints in legend-3; errors in red.

### Navigation
- **Tab rail:** tabs on the case with top-rounded corners; the active tab steps up to panel-2 with a 2px amber top edge. The wordmark sits at the right in a 10px Michroma legend.
- **Sidebar:** sticky Michroma section heads with counts; 26px rows with jacks in each ref's lane colour; HEAD is weight 600 with a lit jack. Ahead and behind counts in green and cyan.
- **Context menus:** raised-ply panel; the hovered item becomes a keycap (white face, ink text); danger items turn red.

### Commit Graph (signature)
Cables, not lines. Each lane is a 3.5px round-capped cable in its cable colour. Where a cable changes lanes, it is drawn over a 6.5px case-coloured sheath so crossings read as one cable passing over another; straight runs draw first and curves on top. Commits are jacks: a 7px coloured ring with a case-black hole; HEAD's jack carries a white core; merges are solid 5px dots; uncommitted work is a dashed ring. Refs connect to their jack by a 2px leader. **Selection is a 1.5px legend-white ring around the jack**, with the row's message turning white and weight 600: never a filled row. Authors appear as 7px pin LEDs in a colour hashed from their email, beside the name; there are no avatar bubbles. SHAs are stamped in mono on every row.

### Commit Module
The right-hand module: a Working Tree head with view toggles, unstaged and staged file lists (status icons in cable colours, a keycap row action on hover), and a commit box with a Michroma legend, character counter (amber near the limit, red over), summary and description fields, and a full-width keycap commit button.

### Toasts
Raised-ply cards with a 6px corner and floating shadow, stacked bottom-right but positioned clear of the commit module (offset by the module's width plus 16px) so they never cover the commit box. They move to the window edge only when the module is hidden or on the welcome screen.

The update notice is a pinned toast: it stays until answered, steps aside while a modal is open, and keeps one keycap (Update, then Restart to update). Its release notes sit in a case-black well like other detail, its download progress is the amber progress fill, and after Later a key on the status strip brings it back, lit cyan (the "behind" colour) while an update waits, amber while it downloads and green when it's ready.

### Themes
Patch Bay is the default and the reference; every other theme keeps its structure and swaps the ply, legends, keycap and the ten cable colours. Tokens a theme doesn't set (the fifth ply step, a third rule, the brightest/dim/disabled legends, shadow, scrim) are derived in `src/renderer/lib/themes.js`, and tints use `color-mix()` on the cable tokens, so a theme can't leave a hard-coded colour behind. Light themes invert the ply ramp (the case is the lightest layer, panels step towards the legend), use dark keycaps with light ink, and get softer shadows and a lighter scrim. The theme picker and builder dock to the right with no scrim so the window behind is the preview.

### Welcome
A cable-field illustration (jacks on a rule with cables sagging between them), the wordmark and tagline, then one module with Start and Recent columns. Start actions are bare 22px line icons beside a title and sub-line, with the icon turning amber on hover: no icon tiles or boxes.

### Motion
One token governs it: the throw (`90ms steps(2, jump-end)`). Background, colour and border changes, chevron rotation, and the 4px ply-in of modals and toasts all move in two hard steps. Reduced-motion removes all transitions and animations.

## Do's and Don'ts

### Do:
- **Do** take lane colours in palette order by column, amber first for HEAD.
- **Do** draw cables at 3.5px with round caps and a case-coloured sheath where they curve.
- **Do** show selection in the graph as a ring on the jack.
- **Do** show authors as small pin LEDs in their hashed cable colour.
- **Do** give each module at most one white keycap for its primary action.
- **Do** set Michroma legends uppercase at 10px or larger, and keep legend-3 at #8e8a81.
- **Do** animate with the throw (90ms steps(2)).
- **Do** drop graph columns by container width: author first, SHA last.
- **Do** keep toasts clear of the commit module.
- **Do** separate modules with 1px seams and step ply tones for hover and pressed states.

### Don't:
- **Don't** use avatar bubbles or initials circles for authors.
- **Don't** fill a graph row to mark selection.
- **Don't** use easing curves (ease, ease-out, cubic-bezier) for UI state changes.
- **Don't** add glow, coloured shadows, knobs or screws.
- **Don't** fill surfaces with colour gradients. Hatching and pattern fills that mark absent content are part of the system.
- **Don't** set Michroma below 10px or use it for repository content.
- **Don't** spend cable colours on chrome that encodes nothing.
- **Don't** put welcome actions in icon tiles.
- **Don't** cast shadows from anything seated in the rig.
