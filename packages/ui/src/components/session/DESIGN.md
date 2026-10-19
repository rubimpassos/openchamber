# PR fix-loop UI contract

## 1. Identity

This flow extends OpenChamber's existing compact session controls. Preparation,
model access, activation and publication are separate explicit actions. The exact
commit and destination remain visible together before publication.

## 2. Color

Use the active theme's `surface.elevated`, `surface.foreground`,
`surface.mutedForeground`, `interactive.border`, `interactive.selection`,
`interactive.hover` and `interactive.focusRing` through semantic utilities.
`status.warning` and `status.error` describe actual failures or retained work.
The shared Button owns primary actions. No new palette or accent border marks state.

## 3. Typography

Use `typography-ui-header` for dialog titles, `typography-ui-label` for controls
and `typography-meta` for metadata. Font families and sizes stay with the user's
configured `--font-sans`, `--font-mono` and `--text-*` tokens. Commits, repository
identifiers and refs use mono text with `dir="ltr"`; user names use `dir="auto"`.

## 4. Spacing and layout

Use existing spacing steps 1, 1.5, 2, 3, 4 and 5. The dialog is a bounded
scroll-body shell: header and actions stay fixed; ScrollableOverlay owns body
scrolling. Its shrinking flex child has `min-h-0`. The existing Dialog remains
the outer shell on phones; model, grant and setup sheets use MobileOverlayPanel
above it. Buttons wrap instead of truncating.
Long refs and hashes wrap within `min-w-0` containers.

Spatial reference: https://github.com/changeroa/StyleGallery/blob/main/patterns/viewport-shell/scroll-body-shell.md.

## 5. Components

- Button, Input, Select and SettingsStackedField retain their shared states,
  sizes, focus rings and disabled behavior. Configuration uses the existing
  PrFixLoopConfigFields. Existing loops cannot change execution mode.
- ModelSelector supplies search, keyboard navigation and its mobile picker.
  No model or place is selected on behalf of the user.
- IsolatedSpacesSettings supplies the existing opt-in switch and place setup.
  The contextual dialog does not change the global Spaces release flag.
- SpaceAccessDialog owns explicit credential grants. Worker readiness requires
  the protected purpose, a running undamaged space and authoritative model access.
- Worker status uses the existing Spaces journey and progress events. A failed
  read has a visible retry and cannot authorize activation.
- Receipt review groups exact commit, retained host ref, repository IDs,
  destination ref and expected remote head. Comparison reads use immutable SHAs
  and exclude the working tree. Approval sends only the receipt ID.
- Proposed GitHub replies appear as quoted plain text with the original target
  kind and ID. Thread actions explicitly say whether the host will resolve the
  thread or leave it open. The open inspection retains the receipt and proposals
  together; a changed receipt or proposal disables publication.
- A watching loop whose PR is ready shows "PR ready · watching for new CI and
  reviews" in the success tone, with Stop and no Dismiss; the iteration count
  shows only once the round has one. "Keep watching after the PR is ready" is
  the first control in the start dialog, the edit dialog and Settings.
- The loop's messages to the session render as one collapsed OpenChamber row in
  the transcript, never as a user bubble; a queued one offers Remove only.
- The loop row announces the host's review state and completed/total operations,
  including retained blockers. Configuration stays disabled while a receipt or
  pending/blocked review job exists. Posting has no separate button.

## 6. Motion and interaction

Reuse shared modal, sheet and control transitions. Add no animation or timer.
Async controls disable immediately and keep their outcome beside the action.
The existing grant dialog temporarily releases the preparation modal's focus
trap. Configuration remains in place while a nested setup dialog is open.

Interaction reference: https://beui.dev/r/action-swap/raw. Its state-label
mechanism is adapted through existing Button labels, without importing motion
or adding width, filter or layout animation.

## 7. Depth

Use the existing elevated dialog surface, modal shadow and window corners.
Groups inside it stay flat, separated by spacing and neutral dividers.
Selection uses the shared selection wash and glyph; no local shadow or radius.

## 8. Accessibility constraints and evidence

Preserve logical start/end layout, visible focus, complete translated labels,
live progress announcements, errors and retry actions. Publication is a button
with an explicit outcome, separate from diff inspection. Stop retains work and
receipts. Keyboard and touch users must reach every action without a hidden
scroll region. Long Arabic, Hebrew and CJK labels must remain readable.
Quoted replies preserve whitespace, wrap long content, and use `dir="auto"`.
Generated markup is never rendered as HTML or Markdown. Target IDs remain LTR.

Browser, mobile, RTL, contrast and reduced-motion QA are pending the parent's
combined build, as requested. Component tests establish contracts, not paint.
No accessibility debt is accepted by this document.
