# Voice-enabled Assistant and catalog provisioning

- Added optional dictation, spoken replies, and a dedicated real-time
  PersonaPlex experience to the collapsible NeurOn Assistant. Administrators
  select existing audio deployments and voice settings on **Admin >
  Assistant**; inline reference-voice audio stays private and is redacted from
  read APIs.
- Split target setup into **Connect existing** and **Provision new**. PreFer
  provisioning now resolves a full source commit to a validated llama.cpp or
  audio.cpp release inventory, shows only provider-compatible choices, and
  stores the exact deployment plan before capacity is created.
- RunPod provisioning now follows the pinned catalog plan. AWS EC2 provisioning
  now launches exactly one catalog-selected instance from a provider-owned
  Launch Template and replaces only its explicitly marked deployment
  environment block.
- Added PostgreSQL schema version 9 for independent Assistant audio settings;
  SQLite receives the equivalent additive column and the explicit SQLite to
  PostgreSQL transfer preserves it.
