---
type: Reference
title: Identity and Access
description: Durable users, authentication, roles, teams, target audiences, account merges, and recovery.
tags: [identity, authentication, authorization, users, teams]
timestamp: 2026-08-21T00:00:00Z
---

# Identity and Access

NeurOn has one durable user entity per person. Local passwords, GitHub identities,
OIDC identities, personal API keys, LiteLLM subjects, profiles, reservations,
favorites, global roles, and team memberships all attach to that user ID. A
provider username may change without changing ownership because external
identities are keyed by provider type, configured method ID, and immutable
provider subject.

## Safe rollout and first Owner

Upgrading an existing database backfills users from the usernames already stored
on profiles, reservations, API keys, and favorites. Those rows keep their IDs,
names, hashes, selections, and history; users do not need to rebuild profiles.
Every backfilled account receives the Member role. NeurOn does not promote every
legacy user when no Owner is configured.

Before the first normal start, or when recovering access, stop NeurOn and create
a one-time Owner link with the offline command:

```bash
npm run build
npm run users -- create-owner-link --username admin --base-url https://neuron.example.test --confirm-application-stopped
```

For Compose, run the built image while the application service is stopped:

```bash
docker compose run --rm neuron node dist/scripts/users.js create-owner-link --username admin --base-url http://localhost:8090 --confirm-application-stopped
```

The command takes the same exclusive storage-operation lock as the application,
prints the registration URL once, and stores only a hash of its token. With a
custom SQLite path the lock is derived beside that database; an explicit
`STORAGE_OPERATION_LOCK_PATH` overrides it for both application and tools. A
lock is considered abandoned only after five minutes without a heartbeat. Never
run the tool until the application is independently confirmed stopped.

`ADMIN_USERS` remains an optional bootstrap/recovery list. Matching normalized
usernames receive the protected Owner role at startup. It does not make every
authenticated user an administrator, and an empty value grants nobody Owner.

## Authentication methods

The built-in local method creates individual username/password credentials.
There is no deployment-wide shared password. Administrators manage the method
under **Admin > Authentication** and may independently disable password sign-in
and invitation registration. Disabling it removes the password form and blocks
HTTP Basic authentication and local registration; personal Bearer API keys and
enabled GitHub/OIDC methods continue to work. A one-time offline Owner recovery
link remains redeemable and signs that Owner into a bounded browser session
without reopening ordinary registration. Verify an external Owner login before
turning local authentication off in an OIDC-only deployment.

Local passwords use scrypt and are never recoverable. Login attempts are bounded
per process (by source/user for the form and by user for HTTP Basic). Browser
sessions are signed, HTTP-only, `SameSite=Lax`, Secure when the public URL is
HTTPS, limited to twelve hours,
and immediately invalidated by disabling, merging, password reset, or explicit
session revocation.

GitHub uses the provider's numeric user ID as its stable subject. OIDC uses the
validated `sub` claim. On first sign-in, an unseen external subject attaches to
an existing account only when its normalized username matches; otherwise NeurOn
creates a new account. Subsequent provider username changes retain the original
user. Administrators can preview and merge an accidental duplicate.

OIDC team rules are validated before save: rule IDs must be unique, regexes must
compile, and referenced teams and team roles must exist. A login computes the
entire desired membership set first and replaces only that provider's OIDC-managed
memberships in one database transaction. Manual memberships are untouched.
Disabling or deleting an OIDC method clears memberships managed by that method.

The administration UI separates **Accounts**, **Teams**, and
**Authentication**. Accounts provides focused tabs for the account list,
invitations, and duplicate-user merges; invitation creation opens from the
account-list action. Authentication separates existing methods from the OIDC
and GitHub creation forms. Teams has its own hierarchy and membership screen.
These identity operations remain available in maintenance mode while every
capacity-affecting mutation and lifecycle loop stays paused.

## Roles and teams

Global roles supply permissions. Built-in roles are immutable and include:

- Owner: protected wildcard authority and offline recovery destination;
- Administrator: users, roles, teams, authentication, targets, reports, and
  system administration without wildcard authority;
- Operator: target, discovery, reservation, and report operations;
- Member: visible-target use and owned/shared profiles, reservations, keys,
  favorites, and reports; and
- Viewer: visible-target and personal-report read access.

Only an Owner may grant or remove wildcard authority, modify another Owner's
access, issue an Owner claim/reset link, or merge an Owner account. PostgreSQL
serializes final-Owner disable/removal checks so concurrent administrator
requests cannot leave the installation without an enabled Owner.

Teams are durable and may be nested. NeurOn stores both the parent relationship
and a rebuilt closure index, so membership in a child satisfies an audience or
shared profile granted to its ancestor. A Team Member may use inherited shared
profiles and publish a profile they own to a team they can use. Team Owner and
Team Manager may also edit, move, and delete team profiles in their managed
hierarchy; global `teams.manage` authorizes shared profile management for every
team. The profile keeps its durable creator user ID for audit and
duplicate-account merges while its sharing scope and optional team ID control
visibility. Approvals, service accounts, and general delegated team administration
remain deliberately deferred.

## Target visibility

Each target has one audience:

- `global`: every user with the corresponding target read/use permission;
- `teams`: members of any listed team, including descendant-team members; or
- `users`: the listed durable user IDs.

Visibility is enforced across the server-rendered UI, REST API, MCP tools,
reservation validation, and LiteLLM traffic attribution. A recognized LiteLLM
subject is credited to a real user only when that user may use the target;
otherwise any valid warm-target traffic signal remains synthetic.

Providers remain installation-global. Provider concurrency and quota policy,
private provisioned targets, approvals, and service accounts are future work.

## Profile audiences

The New/Edit Profile page gives **Audience** its own row. `Only me` keeps a
profile personal. `Everyone` makes it available to every eligible NeurOn user.
A team option appears for every team the creator may use, including an inherited
ancestor, and shares the profile with members of that team and its descendants.
Eligible users see shared profiles on Home, Profiles, Connect, and the REST
API and may start their own reservation from them. The creator retains normal
ownership; team managers may additionally maintain team profiles in their
managed hierarchy.

A team profile accepts only targets available to the whole assigned team: a
global target, or a team target whose audience team is the assigned team or one
of its ancestors. An everyone profile accepts only global targets. User-only
targets are rejected for either broader scope. Current access is checked
again whenever a reservation starts, so later membership or target-audience
changes take effect immediately. A team with shared profiles cannot be deleted
until those profiles are moved or removed.

## Duplicate-account merge API

The admin UI requires a preview before confirmation. Automation can use the
same two admin-only REST operations with an Owner/Administrator personal API
key:

```http
POST /api/admin/users/merge/preview
Authorization: Bearer sk-neuron-...
Content-Type: application/json

{"sourceUserId":"usr_duplicate","targetUserId":"usr_canonical"}
```

```http
POST /api/admin/users/merge
Authorization: Bearer sk-neuron-...
Content-Type: application/json

{"sourceUserId":"usr_duplicate","targetUserId":"usr_canonical","confirm":"MERGE"}
```

The merge transaction moves reservations, profiles, API keys, favorites,
external identities, global roles, team memberships, invitations, LiteLLM
links, and persisted user-target audiences. Conflicting favorites are deduplicated;
the stronger colliding team role is retained; the destination's existing local
password wins. The source becomes a disabled alias of the destination, prior
merge aliases are path-compressed, both users' sessions are revoked, and an
identity audit event records the actor and source/destination IDs. The operation
is intentionally not reversible; retain normal database backups.
