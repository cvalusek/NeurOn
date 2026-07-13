# NeurOn

[![License: AGPL v3](https://img.shields.io/badge/License-AGPL%20v3-blue.svg)](https://www.gnu.org/licenses/agpl-3.0)

NeurOn is a lightweight control plane for shared self-hosted LLM capacity. It
lets developers reserve the runtime targets and models they expect to use,
keeps matching capacity on while reservations or recent traffic need it, and
scales the target back down when demand is gone.

NeurOn does not ship an inference image or create default capacity. Bring an
OpenAI-compatible runtime by adding a provider and target in the UI or by
supplying declarative configuration. Provider adapters currently support Docker
containers, Docker Compose projects, RunPod, and AWS ECS/Auto Scaling Group
targets.

## Layout

```text
control-plane/        Fastify/TypeScript app, examples, and product docs
hassleoff/            Separately deployable dead-man watchdog
.github/workflows/    Control-plane build workflow
```

Detailed design and operations notes live in
[control-plane/docs](control-plane/docs/index.md).

## Optional HassleOff

The normal Compose file includes HassleOff as an opt-in profile. After setting
the shared controller settings and a target-registration file as described in
the [HassleOff operating guide](control-plane/docs/hassleoff.md), start the
watchdog and then NeurOn:

```bash
docker compose --profile hassleoff up -d hassleoff
docker compose up -d neuron
```

HassleOff defaults to `http://localhost:8091`; its admin status and safe
synthetic test are at **Admin > HassleOff safety** in NeurOn. Running
`docker compose up -d neuron` without the profile preserves the default
NeurOn-only experience.

For an isolated fake-only verification stack that does not load a default
`.env` file:

```bash
docker compose --env-file control-plane/examples/compose-hassleoff.properties -f docker-compose.hassleoff.yml up --build
```

NeurOn is at `http://localhost:18090`; HassleOff health/readiness is at
`http://localhost:18091/healthz` and `http://localhost:18091/readyz`.

## Quick Start

Copy the example environment file:

```bash
cp .env.example .env
```

Run NeurOn locally:

```bash
docker compose up --build neuron
```

Open `http://localhost:8090`, sign in with any username and the configured
shared password, then add providers and targets from Admin. The Docker socket is
mounted so NeurOn can manage Docker targets when you configure a Docker provider.

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
- `SHARED_PASSWORD`, `COOKIE_SECRET`, and `ADMIN_USERS` configure auth.
- `GITHUB_AUTH_CLIENT_ID` and `GITHUB_AUTH_CLIENT_SECRET` enable GitHub
  sign-in; admins can manage persisted GitHub methods from Admin > Auth.
- Users can create `sk-neuron-...` API keys for Bearer-auth API, OpenAPI, and
  MCP clients.
- `CAPACITY_TARGETS_FILE`, `CAPACITY_TARGETS_JSON`, or `CAPACITY_TARGET_KEYS`
  define the capacity targets NeurOn can control.
- `STORAGE_DRIVER=sqlite` is the local Compose default and persists
  reservations plus API keys in `./data/neuron.db`.
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
provider details, Health URL, and optional LiteLLM backend metadata.

Start with [control-plane/examples/capacity-targets.example.json](control-plane/examples/capacity-targets.example.json)
or the env-expanded pattern documented in
[control-plane/docs/configuration.md](control-plane/docs/configuration.md).

## Integrations

NeurOn exposes:

- Swagger UI at `http://localhost:8090/docs`
- OpenAPI 3.0 at `http://localhost:8090/openapi.json`
- MCP JSON-RPC at `http://localhost:8090/mcp`

Create user API keys from `http://localhost:8090/api-keys`, then use them with
`Authorization: Bearer sk-neuron-...`. See
[control-plane/docs/integrations.md](control-plane/docs/integrations.md).
