# opencode-neuron

OpenCode plugin for [NeurOn](https://github.com/cvalusek/NeurOn), a lightweight
control plane for shared self-hosted LLM capacity.

The plugin reserves NeurOn capacity before OpenCode sends a chat message. It
waits until NeurOn reports the matching target healthy, then lets the request
continue. After completions, it refreshes the same reservation to keep capacity
warm without stacking long reservation tails.

The wait happens in OpenCode's awaited `chat.message` hook. A cold target does
not receive the model request and ask the user to retry later: the original
request remains pending until NeurOn reports readiness or the configured wait
times out.

## Install

Install the package wherever OpenCode loads npm plugins:

```bash
npm install opencode-neuron
```

For project-local development, this repository also keeps the plugin at:

```text
.opencode/plugins/neuron.js
```

## Configuration

Required:

```env
NEURON_API_KEY=sk-neuron-...
```

Optional:

```env
NEURON_API_BASE_URL=http://localhost:8090
NEURON_ALLOWED_PROVIDERS=litellm
NEURON_RESERVATION_DURATION_MINUTES=2
NEURON_RESERVATION_KEEPALIVE_MINUTES=2
NEURON_WAIT_FOR_HEALTHY=true
NEURON_WAIT_TIMEOUT_SECONDS=600
NEURON_WAIT_POLL_SECONDS=5
```

`NEURON_ALLOWED_PROVIDERS` is a comma-separated, case-insensitive allowlist of
OpenCode provider IDs. Leave it unset or empty to allow any provider whose model
can be mapped to NeurOn. Set it when OpenCode also uses providers that should
never create NeurOn reservations.

## Model Mapping

OpenCode model names are LiteLLM-facing names. The plugin reads NeurOn's
`/api/client-models` map and resolves global aliases, scoped
`<target>/<alias>` names, canonical IDs, backend IDs, runtime IDs, and legacy
display-prefix names to the exact target-model pair. It falls back to the
older `/api/status` and `/api/models` surfaces when talking to an older NeurOn.

Use NeurOn's **Client setup** page to copy an OpenCode provider configuration
that includes every currently published name. When two targets publish the
same global alias, NeurOn assigns the alias to the lower numeric target
priority and retains scoped aliases for both targets. LiteLLM can try those
same deployments in priority order when its pre-call checks and ordered
fallback behavior are enabled.

Aliases for the same target and canonical model refresh one reservation. Models
that share a target retain separate reservations because each can require its
own warmup.

If LiteLLM aliases a route prefix away, configure NeurOn with an empty display
prefix for that target.

## Runtime Warmup

Model warmup happens in NeurOn, not in this plugin. When configured, NeurOn keeps
a target in `provisioning` until the requested reservation models have been
warmed. The plugin simply waits for NeurOn's reservation status to become
healthy.

## License

AGPL-3.0-only.
