# Issues and pull requests board

The shared list, preview, and existing board actions are documented in
`../references/DOCUMENTATION.md`, under Board.

## GitHub stacks

`SourceBoardView` passes board visibility to the preview so a closed retained
board has no stack read or restack subscription. A stack member already loaded
in the browser is selected with `showItem`. Other members use the board's
existing pinned-link lookup, including closed and merged PRs.

`pullAttachments.ts` owns whole-stack attachment beside its existing comment
and failed-check attachments. It captures the destination session or draft
before loading. Context reads are sequential, include diff and CI detail, and
collect failures per member. Successes and the ordered summary attach together;
a changed runtime or destination never receives an older operation's result.

The compact list badge is an explicitly page-local branch-chain hint. The
preview's native or inferred membership always comes from the server.
