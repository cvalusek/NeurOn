# HassleOff

HassleOff is NeurOn's separately deployable dead-man watchdog. It accepts
short authenticated controller leases for explicitly registered targets and
can only issue the registered stop action for the exact target whose lease
expired. It never starts or provisions capacity.

The service is Fastify + TypeScript and stores registrations, lease state,
action requests, synthetic fail-safe-test results, and an append-only audit
trail in SQLite. Full operating and protocol documentation is in
[`control-plane/docs/hassleoff.md`](../control-plane/docs/hassleoff.md).

## Development

```bash
pnpm install
pnpm typecheck
pnpm test
```

`HASSLEOFF_CONTROLLER_TOKEN`, exactly one of `HASSLEOFF_TARGETS_FILE` or
`HASSLEOFF_TARGETS_JSON`, and a writable `HASSLEOFF_SQLITE_PATH` are required
for a real process. The normal root Compose file exposes HassleOff through the
opt-in `hassleoff` profile and persists `/app/data` in a named volume. Use
`docker-compose.hassleoff.yml` for an isolated fake-only stack that does not
read a default `.env` file.

## Published Image

Main-branch builds publish the dedicated image
`ghcr.io/cvalusek/hassleoff`. This is distinct from the control-plane
image. Published tags are `latest`, `main`, and the immutable
`sha-<full-commit-sha>`; pull the full-SHA tag for a pinned deployment.

The workflow does not change GHCR package visibility; it remains inherited from
this public repository. Pull it with:

```bash
docker pull ghcr.io/cvalusek/hassleoff:latest
```

Supply the required configuration from the deployment environment rather than
embedding it in an image or command history. The image entrypoint runs
`node dist/server.js`, listens on port `8091`, and expects durable data at the
configured `HASSLEOFF_SQLITE_PATH` (normally a volume under `/app/data`).
