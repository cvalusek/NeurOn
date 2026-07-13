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
