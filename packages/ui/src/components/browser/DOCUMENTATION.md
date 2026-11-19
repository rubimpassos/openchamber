# Browser views

## Ownership

`ServerBrowserView` pairs context-panel tabs with the selected chat's Chrome
tabs. `usePanelNavigation` delivers the address requested by a context opener
after pairing selects the corresponding Chrome tab. The service owns observed
page URLs, loading and errors. Native webview and iframe engines retain their
own navigation lifecycles in `BrowserPane`.

## Invariants

- A newly requested address survives blank service snapshots until its
  navigation finishes. Page-URL synchronization cannot erase pending intent.
- Existing-tab requests reach the mounted view, or the latest request is
  delivered when that view subscribes. Reopening a working page only focuses it.
- A sign-in browser does not receive chat-link navigation.
- A panel tab mirroring a page already opened by Chrome or the agent consumes
  its first-open marker without navigating that page again.
- Failed requested navigations stay associated with their scope and Chrome tab
  until a successful navigation, reload, history action or claim release. Selecting another
  tab cannot turn a failed page into a working page.

## Decisions

### Why panel URLs are not navigation commands

The service also writes page URLs into panel tabs after navigation and redirects.
Replaying every target-path update would navigate on service synchronization.
Explicit first-open markers and existing-tab load requests distinguish user
intent from observed page state.
