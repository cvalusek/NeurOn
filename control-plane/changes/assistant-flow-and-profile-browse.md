# Smoother Assistant and model browsing

- Assistant requests now show distinct sleeping/waking and thinking spinner
  bubbles without holding one request open through a cold start. Chat and
  pending confirmations survive page navigation until the user clears them;
  Enter sends and Shift+Enter inserts a line break.
- Guided navigation and form actions point to the ordinary NeurOn control they
  use. Profile saves, reservation starts, rediscovery, and other mutating tools
  still require an exact user confirmation.
- Administrators can add trusted local guidance on the independent Assistant
  settings page. Cold starts use reservation duration, while the advanced
  response timeout applies only to an already-ready model.
- Profile creation now defaults to ordinary search, hard filters, and sorting.
  The Good/Fast/Cheap triangle is an optional **Help me choose** wizard with
  visible magnetic snap points.
