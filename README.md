# NeurOn

[![License: AGPL v3](https://img.shields.io/badge/License-AGPL%20v3-blue.svg)](https://www.gnu.org/licenses/agpl-3.0)

NeurOn is a lightweight control plane for shared self-hosted LLM capacity. It
lets developers reserve the runtime targets and models they expect to use,
keeps matching capacity on while reservations or recent traffic need it, and
scales the target back down when demand is gone.

NeurOn does not ship an inference image, but the default local setup points at
the published PreFer container image. Bring another OpenAI-compatible runtime
by describing it as a capacity target in configuration. Provider adapters
currently support Docker containers, Docker Compose projects, and AWS
ECS/Auto Scaling Group targets.

## Layout

```text
control-plane/        Fastify/TypeScript app, examples, and product docs
.github/workflows/    Control-plane build workflow
```

Detailed design and operations notes live in
[control-plane/docs](control-plane/docs/index.md).

## Quick Start

Copy the example environment file:

```bash
cp .env.example .env
```

Run NeurOn locally:

```bash
docker compose up --build control-plane
```

Open `http://localhost:8090`, sign in with any username and the configured
shared password, then use Admin to install/discover the configured PreFer
container target. The Docker socket is mounted so NeurOn can pull, create,
start, and stop the local PreFer container.

For app development without Docker:

```bash
cd control-plane
npm install
SHARED_PASSWORD=dev-password USE_FAKE_PROVIDER=true npm run dev
```

## Environment

Most local configuration lives in `.env`; see [.env.example](.env.example).
Useful knobs:

- `CONTROL_PLANE_PORT` sets the host port for the web app.
- `SHARED_PASSWORD`, `COOKIE_SECRET`, and `ADMIN_USERS` configure v1 auth.
- `CAPACITY_TARGETS_FILE`, `CAPACITY_TARGETS_JSON`, or `CAPACITY_TARGET_KEYS`
  define the capacity targets NeurOn can control.
- `USE_FAKE_PROVIDER=true` switches to the fake provider for tests/app-only
  development.
- `LITELLM_API_BASE_URL` and `LITELLM_API_KEY` enable traffic-based keepalive
  from LiteLLM request logs.

## Netskope / Corporate TLS

If Docker builds fail with Python or npm certificate errors, use the Netskope
overlay. Export your corporate root/intermediate certificates as `.crt` files
under `docker/certs/` and run:

```bash
docker compose -f docker-compose.yml -f docker-compose.netskope.yml up --build control-plane
```

Certificate files under `docker/certs/` are ignored by git.

## Configuration

Targets are configuration-first. Each target lists the models users can reserve,
provider details, health check URL, and optional LiteLLM backend metadata.

Start with [control-plane/examples/capacity-targets.example.json](control-plane/examples/capacity-targets.example.json)
or the env-expanded pattern documented in
[control-plane/docs/configuration.md](control-plane/docs/configuration.md).
