# Bots UI contract

## 1. Identity

A bot is a named teammate with a photo, and its work is a normal chat. The page has three regions: the bot navigation, the item's conversation in the native chat column, and the work context beside it. Attention, recorded evidence and explicit configuration are the hierarchy. There is no dashboard, metric grid or per-lead task tracker.

## 2. Color

Use the current theme's surface, foreground, muted foreground, interactive selection and hover tokens. Status warning and error fills describe actual waits, absent proof and failures. Shared Button owns primary actions. No new palette, shadows or colored selection edges.

## 3. Typography

Use typography-ui-header, typography-ui-label, typography-meta and the Settings typography classes. Fonts remain the user's --font-sans and --font-mono. Paths, IDs, commands and hashes are LTR. User titles and evidence use dir="auto" and wrap long strings.

## 4. Spacing and layout

Use the existing 4px spacing scale, including shared compact 1.5 steps. `BotsShell` owns the frame. Config uses an active-pill tab strip and shared Settings rows, sections and container queries. A page view replaces the previous one in the same region and has an explicit Back action.

Layout: bots workspace shell - bot navigation, conversation and work context each hold long content without squashing the others -> fixed-sidenav-shell with a list-detail context pane (https://github.com/changeroa/StyleGallery/blob/main/patterns/viewport-shell/fixed-sidenav-shell.md); scroll owner: the navigation list, the page body for overview, bot page, editor and forms, the chat column's own transcript for a conversation, the context panel body; anti-patterns: page-level scroll, a fourth column for projects, nested scrollers without a named job, a conversation narrower than a readable line.

- Desktop: navigation 15rem with the project picker at its top, then the content. An item's conversation takes the content area unpadded. The work context is a 21.25rem card beside it while the area is at least 860px wide; below that it covers the conversation and returns to it with one control.
- Phone: one view at a time. Overview, bot page, editor and forms share one scroll body with the project picker. A conversation takes the whole surface with Back in its header; the work context covers it the same way as on a narrow desktop.

## 5. Components

- Button, Input, Textarea, Select, NumberInput and Settings fields retain shared default, focus, disabled and invalid states. No new primitive is introduced.
- SortableTabsStrip uses active-pill without reordering. Tabs scroll horizontally at narrow widths and stay one row.
- Brief for an item's conversation. Primary action: write to the bot in the native composer. Priorities: 1. the lead digest and what waits on the user, 2. the conversation, 3. the work context. Left out on purpose: metric tiles, a second answer box beside the chat, a tracker per lead, badges without state, fixed chart or diagram cards for evidence and decisions. Required content: bot photo or initials, bot name and mission, item title and server state, digest, transcript, composer, Work (state, tokens, request, wait, resume, stop, answer, stage sessions, checkout, pull request, timeline, recorded operations, stage reports, diff), Evidence (source, admitted evidence, proof, pages the bot drew), Decisions (judge verdict, pages the bot drew).
- `BotAvatar` shows the photo or initials on `oc-tile-inset`: 20px in rows and headers, 36px in bot tiles, 56px on the bot page and in the editor. It clips to its circle with `oc-row-clip` and never becomes a scroller on a phone. The editor changes or removes the photo with shared buttons; its error keeps a reserved line.
- The conversation is `ChatView` pinned to the item's root conversation with its lead digest. Transcript, composer, model, attachments, permissions and rendered pages are the native ones.
- Evidence and Decisions list the bot's pages by title and time only. A page row is 44px on a touch pointer and compact with a mouse. A page opens in a shared `Dialog` and is drawn by `BotRenderArtifactView`; this module prescribes no layout for its content.
- Navigation rows mark state with a still 6px dot in the state's colour and name the state for assistive technology.
- Bot rows use oc-tile with inline titles and reserved action space. Item rows show state, title and token count. Empty and failed loads are distinct.
- ModelSelector and AgentSelector own catalog loading and keyboard/touch selection. Every read names the selected project's directory.
- McpToolPermissionsEditor owns per-tool Allow/Ask/Deny and catalog failure behavior. Investigation/judge and correction have separate rules.
- Plain-text evidence and reports wrap in flat sections. Proof absence, unsuccessful proof and judge reasons are always visible in detail and audit.
- Policy review displays exact file, fingerprint and content before an explicit approval. A changed rule is human until approved.
- Identity forms keep secrets only in mounted component state, clear them after submission/unmount and never hydrate a secret from a response.
- The Bots sidebar zone contains live blocking requests or server-owned needs-you items, hides when empty, and opens the stage session or item. Ordinary project lists exclude bot metadata and its descendants.

## 6. Motion and interaction

Reuse shared controls and surfaces. Introduce no animation, clock or polling. Refresh is explicit and server events invalidate only the shown project. Mutations disable their action while pending; errors stay beside the action. Existing drafts survive failure. Runtime changes retire requests and clear the visit, including secrets.

## 7. Depth

Layout stays flat. Lists use oc-tile, nested report blocks use oc-tile-inset only where needed. Shared controls supply the raised edge. The work context beside a conversation is a panel card (`oc-panel-edge`). Only section dividers and the hairline between navigation and content draw lines.

## 8. Accessibility constraints and accepted debt

Every input and action has a translated accessible label. An icon-only action (Back, Refresh, the work context toggle beside a conversation) also shows that label in the shared tooltip. Touch sizes follow the project's floor (`openchamber-ui-guidance`, *The phone*): 44px for a list row, 36px for any other touch control, so shared buttons and the tab strip keep their sizes. Tab navigation and popups use shared components. Logical start/end classes mirror RTL. Keyboard and touch users can reach every section and action; long labels wrap in forms and truncate with titles in rows. Errors use role="alert"; asynchronous status uses role="status". No accessibility debt is accepted. Browser, theme, mobile and RTL evidence belongs to the coordinator's combined runtime QA; static checks do not establish paint correctness.
