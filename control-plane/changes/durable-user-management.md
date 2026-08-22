# Durable users, roles, teams, and target access

- NeurOn now gives each person one durable user record across local password,
  GitHub, OIDC, API-key, and LiteLLM identities. Existing profiles,
  reservations, keys, favorites, and history are retained during the automatic
  schema upgrade.
- Local users have individual passwords instead of a deployment-wide shared
  password. Operators can disable local sign-in after verifying an external
  Owner and can recover access with a one-time offline Owner link.
- Built-in and custom roles, protected Owner authority, nested teams, OIDC
  membership rules, and global/team/user target audiences provide a clean
  authorization foundation.
- Administrators can preview and confirm duplicate-account merges through the
  UI or authenticated REST API. The merge transfers owned state and external
  identity links in one transaction and records an audit event.
- LiteLLM traffic can link to known NeurOn users automatically, while target
  visibility is enforced consistently across the UI, REST API, MCP, reservation
  creation, and traffic attribution.
