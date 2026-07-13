# HassleOff

HassleOff is NeurOn's separately deployable dead-man watchdog. It accepts
short authenticated controller leases for explicitly registered targets and
can only issue the registered stop action for the exact target whose lease
expired. It never starts or provisions capacity.

The service is Fastify + TypeScript and stores registrations, lease state,
action requests, synthetic trip-test results, and an append-only audit trail in
SQLite. Full operating and protocol documentation is in
[`control-plane/docs/hassleoff.md`](../control-plane/docs/hassleoff.md).

## Development

```bash
pnpm install
pnpm typecheck
pnpm test
```

`HASSLEOFF_CONTROLLER_TOKEN`, `HASSLEOFF_TARGETS_JSON`, and a writable
`HASSLEOFF_SQLITE_PATH` are required for a real process. Use
`docker-compose.hassleoff.yml` from the repository root for a fake-only local
stack that does not read a default `.env` file.

## Published Image

Main-branch builds publish the dedicated image
`ghcr.io/cvalusek/neuron-hassleoff`. This is distinct from the control-plane
image. Published tags are `latest`, `main`, and the immutable
`sha-<full-commit-sha>`; pull the full-SHA tag for a pinned deployment.

The workflow does not change GHCR package visibility. Authenticate Docker to
`ghcr.io` with an account or token that can read the repository-inherited
package, then pull it with:

```bash
docker pull ghcr.io/cvalusek/neuron-hassleoff:latest
```

Supply the required configuration from the deployment environment rather than
embedding it in an image or command history. The image entrypoint runs
`node dist/server.js`, listens on port `8091`, and expects durable data at the
configured `HASSLEOFF_SQLITE_PATH` (normally a volume under `/app/data`).
