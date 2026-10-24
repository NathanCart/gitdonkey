# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

(Electron desktop app; the UI is HTML/CSS rendered in Chromium on macOS first.)

## Stack

Electron + plain HTML/CSS/JS, no framework and no build step (confirmed). Renderer modules are native ES modules; the Git backend is Node in the main process driving the `git` CLI.

## Users

A development team: several engineers of mixed Git skill sharing one desktop Git client. They live in it alongside their editor and terminal all day: reviewing history, staging and committing, branching, pulling and pushing, resolving conflicts.

## Product Purpose

GitDonkey is a GitKraken-style visual Git client. It makes repository history and state legible at a glance (a lane-based commit graph with branch and tag labels) and makes everyday Git operations direct: stage files, hunks or single lines; commit; branch, merge, rebase and cherry-pick by context menu or by dragging one branch onto another; stash; resolve conflicts in a built-in merge tool; undo the last action. Success means the team can do daily Git work without dropping to the terminal and without fear of breaking things.

## Positioning

Familiar GitKraken layout and interaction model (tabs, toolbar, left refs sidebar, center graph, right commit panel) so anyone who knows GitKraken is productive immediately, under its own distinct identity. Free and local: no account, no sign-in, no cloud dependency.

## Operating Context

- Used for hours at a time beside an editor and terminal, often on a laptop screen, frequently in dimmed rooms.
- Works on any local repository; remotes over SSH (agent) or HTTPS (OS credential helper). No interactive credential prompts inside the app.
- Multiple repositories open as tabs.

## Capabilities and Constraints

- Commit graph (all branches, remotes and tags) with WIP row, ref pills, search, infinite loading.
- Staging at file, hunk and line level; discard; commit and amend; message-only amend.
- AI commit messages (opt-in): the user picks a provider (OpenAI, Anthropic, OpenRouter, Google Gemini, Ollama, or any OpenAI-compatible endpoint) and brings their own key, kept encrypted by the OS keychain. The staged diff is sent only when they press Generate.
- Branches: create, checkout (local, remote-tracking, detached), rename, delete, set upstream, fast-forward, merge, rebase, interactive rebase (reword, squash, fixup, drop), cherry-pick, revert, reset soft/mixed/hard.
- Drag a branch onto another to merge, rebase, fast-forward or push.
- Remotes: fetch, pull (merge / ff-only / rebase), push with upstream setup and force-with-lease, add/remove/rename remotes, delete remote branches and tags.
- Stashes and tags: create, apply, pop, drop, push, delete.
- Conflict resolution: per-conflict ours/theirs/both, take whole side, mark resolved, continue/skip/abort merge, rebase, cherry-pick or revert.
- Diff viewer (unified and split, syntax highlighting, image diffs), file history, blame, file view.
- Undo/redo for commit, checkout, branch create/delete, reset, tag create.
- Clone, init, open (dialog or drag-and-drop), recent repositories, auto-refresh on file changes.
- Themes: 21 built in (Patch Bay is the default; the rest include light themes and well-known palettes like Nord, Dracula, Solarized, Gruvbox, Catppuccin), chosen in Themes… with a live preview. A theme builder edits all 24 base colours beside the live app, checks readability (WCAG AA for text, 3:1 for cables) and can fix it, and can design a theme from a description with the AI commit message provider. Themes share as a JSON theme code. Every colour in the app comes from theme tokens; hover steps, shadows and tints are derived.
- Update notices (on by default, off switch in Settings, manual Check for Updates… in the menu): the latest GitHub release is checked at launch and every six hours; the notice shows the version and release notes with Update, Later and Skip this version. The builds are not code-signed, so instead of Squirrel/electron-updater GitDonkey downloads the installer itself (checked against GitHub's SHA-256) and installs it: on macOS it swaps the app bundle and relaunches (an in-app download carries no quarantine flag, so no Open Anyway), falling back to opening the DMG when it can't write to its folder; on Windows it runs the NSIS installer silently.

## Brand Commitments

- Name: **GitDonkey** (confirmed).
- Dark mode is the primary theme (explicit user requirement).
- The user asked for a clean, modern, "award-winning" brand with its own identity: not GitKraken's branding, colors or logo.

## Evidence on Hand

No real users, testimonials, press or metrics exist. Do not fabricate any.

## Product Principles

1. Recognition over relearning: GitKraken users must feel at home in the first minute.
2. State is always visible: current branch, upstream divergence, operation in progress and conflicts are never hidden.
3. Every destructive action is either undoable or confirmed.
4. Direct manipulation first, menus second, terminal never required.
5. Built for a team of mixed skill: clear labels and safe defaults without slowing experts down.
