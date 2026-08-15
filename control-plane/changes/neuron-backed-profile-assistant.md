# NeurOn-backed profile assistant

- Administrators now select an existing NeurOn target/model as the profile
  assistant backend instead of configuring an unrelated endpoint.
- A collapsible assistant drawer is available across the application and can
  carry a complete profile draft into the profile builder. It receives a
  privacy-bounded semantic snapshot of the current NeurOn screen and controls,
  not page HTML.
- Assistant tools can fill the screen immediately, while saving profiles,
  starting reservations, and admin rediscovery require explicit confirmation.
- Its system prompt now explains NeurOn target, model, profile, reservation,
  reconciliation, traffic, alias, and confirmation semantics.
