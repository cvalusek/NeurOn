# More reliable Assistant and clearer usage reports

- The Assistant now remembers bounded conversation history across pages,
  compacts older turns, and sends only changed screen context behind a stable
  cache-friendly operating prompt.
- Cold-started Assistant requests receive a full reservation-duration response
  window after startup; warm requests keep the configured response timeout.
  Target lifecycle changes also clear stale model-warmup state.
- Empty, malformed, legacy, and transient model responses receive constrained
  compatibility or retry handling, while tool authorization and confirmations
  remain fail closed.
- Administrators can toggle privacy-safe Assistant diagnostics for acquisition,
  timeout, retry, history-size, and context-delta behavior.
- Profile hosting filters now distinguish explicit dedicated, multi-model, and
  unclassified targets and visibly hide nonmatching choices.
- The daily usage report now leads with operational summaries and presents one
  focused Daily, Users, Targets, Providers, or Models breakdown at a time.
