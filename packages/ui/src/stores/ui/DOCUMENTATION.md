# UI store composition

## Ownership

`../useUIStore.ts` creates the single Zustand store, attaches devtools and
persistence, and preserves the public imports used by every UI runtime.
This folder owns its state contract, initial values, persistence, context-tab
transitions, and action groups.

Action factories receive the same store's `set`, `get`, and API. Calls between
groups go through `get()` so they use the current state and actions.
`contextTabs.ts` normalizes tab identities and targets. `contextPanelState.ts`
owns directory-panel transformations and saved-panel sanitization.
`sessionBrowserActions.ts` owns session browser visibility and following;
`parkedBrowserTabs.ts` retains parked tabs and their active-zone identities.
`browserTabActions.ts` owns browser-tab creation and requested navigation.
Neighbouring stores still own terminal state and the files view's open paths.

## Invariants

- There is one `useUIStore` instance for all action groups.
- Initial arrays, maps, templates, and keyboard preferences are created when
  the store initializer runs.
- Persistence keeps the `ui-store` key, version 30, migration ordering, and
  the same saved fields.
- Context-tab actions retain their terminal and files-view side effects.
- Browser tab IDs share `browserTabIdentity.ts`'s module-level sequence across
  user tabs, agent tabs and session reveals.
- Browser tabs parked for another session survive persistence. Restoring a
  session restores its active Browser zone; switching to the in-app browser
  restores every parked tab. Retired Server Browser extension tabs are discarded.
- A Server Browser tab captures its chat at creation, including tabs opened by
  the person. The selected directory and chat are transient context, never
  persisted as another session-selection authority. The same address in two
  chats has two tab identities. A chat without a browser inherits no Browser
  panel from the chat it replaces.
- Closing named tabs removes parked tabs as well as visible ones and prunes
  their saved active identities. A browser closed from Work Status cannot
  return when its chat is selected again. Close confirmation retains its
  original chat even if the person switches chats before answering.
- Bots and Suggested tasks navigation stays transient. Opening another main
  surface clears these pages and the one-shot Bots target in the same update.
- GitHub automation defaults, notification classification and browser-follow
  preferences retain their fork defaults and persisted fields at version 30.
- Consumers continue to import the store, public types, constants, and helpers
  from `../useUIStore.ts`.

## Decisions

### Why tabs acquire their chat at creation

Adopting an unowned tab on the next session switch assigned a tab opened during
one chat to the next chat. Creation captures the selected owner; adoption is
reserved for restored tabs without an owner or tabs opened before a chat existed.

### Why action groups share the store

Each group needs current values from other groups, and callers subscribe to
the existing combined state. Separate Zustand stores would change subscription
and persistence behavior, so these modules only compose the original store.

### Why the zone return stack is transient and opt-in on close

`contextZoneReturnStack` records per-zone navigation history only in memory,
never in `ui-store` persistence, so a restart never reopens an old panel when
dismissing a current one. Programmatic jumps (`openContextPanelTab`,
`openTrackerItem`) push the zone's active surface while explicit rail switches
(`openContextSurface`) and plain `closeContextZone` calls clear the stack; only
the panel header close action passes `returnToPrevious: true`, so layout
displacement and shortcuts always close the zone immediately.
