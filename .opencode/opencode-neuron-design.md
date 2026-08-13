# NeurOn Plugin Documentation

**NeurOn** is an OpenCode plugin that manages GPU reservations for model inference servers. It ensures that when you send a message or execute a tool, your target model server is already warm and ready — preventing cold starts, timeouts, and inconsistent performance.

---

## 1. What is NeurOn?

NeurOn acts as a **GPU reservation system** for model inference servers. Here's how it works:

- Models live on **"capacity targets"** — GPU servers that can be in different states:
  - **Cold/Stopped** — powered down to save resources
  - **Warming up** — starting up and becoming ready
  - **Healthy/Running** — fully operational and accepting requests

- When a capacity target is cold, NeurOn:
  1. Creates a **reservation** to start the server
  2. Waits for the target to become healthy before routing requests
  3. Manages the warmup lifecycle automatically

Without NeurOn, every request to a cold server would:
- Hit the server → timeout → fall back to alternative providers
- Result in slow, expensive, and inconsistent user experiences

With NeurOn:
- Cold starts are detected early
- Reservations are created proactively
- Multiple sessions share a single warmup instead of each spinning their own

---

## 2. Why This Plugin Exists

### The Problem Without NeurOn

```
User sends message
       ↓
Request hits cold GPU server
       ↓
Server takes 2+ minutes to warm up
       ↓
Request times out
       ↓
Orchestrator falls back to alternative providers
       ↓
Slow response, degraded quality, wasted compute
```

### The Solution With NeurOn

```
User sends message
       ↓
NeurOn detects target is cold
       ↓
Creates reservation + starts warmup
       ↓
Other sessions queue behind this warmup
       ↓
Server becomes healthy (~2 min)
       ↓
All queued sessions resume simultaneously
       ↓
Fast, consistent experience
```

### Key Benefits

- **No duplicate warmups** — Multiple sessions targeting the same model share a single warmup
- **Proactive detection** — Cold starts are caught before they cause timeouts
- **Automatic management** — Reservations are created, refreshed, and cleaned up automatically
- **Fail-safe behavior** — If NeurOn is unavailable, requests proceed normally (fails open)

---

## 3. Configuring

NeurOn is configured via environment variables. Here are all available options:

| Variable | Default | Description |
|----------|---------|-------------|
| `NEURON_API_BASE_URL` | `http://localhost:8090` | NeurOn API endpoint URL |
| `NEURON_API_KEY` | *(required)* | Bearer token for API authentication |
| `NEURON_ALLOWED_PROVIDERS` | `*` (all) | Comma-separated list of allowed providers (e.g., `anthropic,google`). Use `*` or omit to allow all providers |
| `NEURON_RESERVATION_DURATION_MINUTES` | `2` | How long a reservation stays active on the server |
| `NEURON_RESERVATION_KEEPALIVE_MINUTES` | `2` | Keepalive window for extending reservations |
| `NEURON_WAIT_FOR_HEALTHY` | `true` | If true, block until target is healthy after reservation; if false, return immediately |
| `NEURON_WAIT_TIMEOUT_SECONDS` | `600` | Maximum wait time for warmup completion (10 minutes default) |
| `NEURON_WAIT_POLL_SECONDS` | `5` | Poll interval when waiting for warmup to complete |
| `NEURON_REQUEST_TIMEOUT_MS` | `8000` | Individual API request timeout |
| `NEURON_PREFLIGHT_TIMEOUT_MS` | `2000` | Fast health-check timeout for preflight checks (2 seconds) |
| `NEURON_COOLDOWN_PERIOD_MS` | `30000` | How long to skip health checks after transport failure (30 seconds) |
| `NEURON_RETRY_MAX_ATTEMPTS` | `3` | Maximum retries for transient errors |
| `NEURON_RETRY_BASE_MS` | `1000` | Initial backoff delay for retries |
| `NEURON_RETRY_MAX_MS` | `8000` | Maximum backoff delay for retries |
| `NEURON_BLOCK_ON_COLD_MESSAGE` | `false` | If true, throw immediately when target is cold and fail fast; if false (default), acquire the shared warmup lock and block until the target becomes healthy |
| `NEURON_STRICT_PROVIDER_MATCH` | `false` | If false, fall back to non-matching providers when a specific provider is requested but not available |
| `NEURON_LOG_FILE` | `~/neuron-plugin.log` | Path to the log file for debugging |

### Example Configuration

```bash
# Minimal required configuration
export NEURON_API_BASE_URL=http://localhost:8090
export NEURON_API_KEY=your-api-key-here

# Optional: restrict to specific providers
export NEURON_ALLOWED_PROVIDERS=anthropic,google

# Optional: extend warmup timeout for slower hardware
export NEURON_WAIT_TIMEOUT_SECONDS=900
```

---

## 4. Architecture: Two Hooks, One Goal

NeurOn integrates into OpenCode through **two entry points** that work together to prevent cold starts.

### Hook 1: `message.updated`

Fires when a user sends a message. This is the primary entry point for user-facing interactions.

**Flow:**
```
User sends message
    ↓
Preflight health check (2-second timeout)
    ↓
┌─────────────────────────────────────┐
│ Target state:                       │
├─────────────────────────────────────┤
│ Healthy → Background refresh        │
│ Stopping → Clear reservation +      │
│            Notify user              │
│ Cold → Acquire warmup lock +        │
│       Wait for warmup               │
│ Unreachable → Fail open silently    │
└─────────────────────────────────────┘
```

### Hook 2: `tool.execute.before`

Fires before any tool (file read, bash command, etc.) executes. This ensures tools don't run on cold targets.

**Flow:**
```
Tool execution requested
    ↓
Fail-open cooldown check (skip if API recently failed)
    ↓
Preflight health check (2-second timeout)
    ↓
┌─────────────────────────────────────┐
│ Target state:                       │
├─────────────────────────────────────┤
│ Healthy → Allow tool execution      │
│ Cold → Acquire warmup lock +        │
│       Block until healthy           │
│ Unreachable → Fail open (skip check)│
└─────────────────────────────────────┘
```

### Shared Warmup Coordinator

Both hooks share the **same warmup lock** keyed by target ID. This prevents race conditions:

```
Session A ──→ Fires message.updated ──→ Acquires warmup lock ──→ Creates reservation
Session B ──→ Fires tool.execute ──────→ Sees lock active ──────→ Waits for A's warmup
Session C ──→ Fires message.updated ───→ Sees lock active ──────→ Waits for A's warmup
                                                    ↓
                                          Target becomes healthy
                                                    ↓
Session A, B, C ──→ All resume on healthy target simultaneously
```

**Key insight:** The lock is keyed by **target ID**, not session ID. Two different models on two different targets each get their own independent lock.

---

## 5. Cold Start Flow (The Warmup Lock)

The warmup lock is NeurOn's most important feature. It ensures that multiple sessions don't each spin up their own warmup for the same target.

### How It Works

```
┌─────────────────────────────────────────────────────────────────────────────┐
│ Session A sends a message                                                   │
│   ↓                                                                         │
│   Detects Target T1 is cold                                                │
│   ↓                                                                         │
│   Becomes "leader" — first to acquire the warmup lock                      │
│   ↓                                                                         │
│   Creates reservation + waits for warmup (~2 minutes)                      │
│                                                                            │
│ Session B sends a message                                                   │
│   ↓                                                                         │
│   Detects Target T1 is cold                                                │
│   ↓                                                                         │
│   Sees leader's lock already active                                        │
│   ↓                                                                         │
│   Queues behind Session A's promise                                        │
│   (does NOT create a duplicate reservation)                                │
│                                                                            │
│ Session C sends a message                                                   │
│   ↓                                                                         │
│   Detects Target T1 is cold                                                │
│   ↓                                                                         │
│   Sees leader's lock already active                                        │
│   ↓                                                                         │
│   Queues behind Session A's promise                                        │
│                                                                            │
│                                 ┌──────────────────┐                       │
│                                 │ T1 becomes        │                       │
│                                 │ healthy (~2 min)  │                       │
│                                 └──────────────────┘                       │
│                                                                            │
│ Session A, B, C ──→ All resume on healthy target simultaneously            │
└─────────────────────────────────────────────────────────────────────────────┘
```

### Real-World Example

Imagine you're working with multiple agents in the same conversation:

```
Agent A → Target T1 (anthropic/claude-sonnet) is cold
         ↓
         Becomes "leader" for T1
         ↓
         Creates reservation + waits
         
Agent A → delegates to Subagent B → Target T2 (google/gemini) is cold
         ↓
         Becomes "leader" for T2 (separate lock!)
         ↓
         Creates reservation + waits
         
Agent A → sends message → Target T1 is now healthy
         ↓
         Resumes with T1
```

**Notice:** Agent A can work with multiple cold targets simultaneously because each target has its own independent lock.

---

## 6. Fail-Safe Behaviors

NeurOn is designed to be resilient. When things go wrong, it fails gracefully.

### API Unreachable

```
NeurOn API check fails (network error, server down, wrong credentials)
    ↓
Fail open — requests proceed without NeurOn interference
    ↓
Cooldown window prevents repeated failed checks (30 seconds default)
    ↓
Subsequent checks resume normally after cooldown
```

**User sees nothing** — no toast notifications, no errors. The system just works.

### Warmup Timeout

```
Reservation created but target never becomes healthy
    ↓
After NEURON_WAIT_TIMEOUT_SECONDS (10 minutes default):
    ↓
Reservation fails with error
    ↓
Warmup lock is released
    ↓
Callers can retry or fall back to alternative providers
```

**Error message:** `Timed out waiting for NeurOn reservation {id} to become healthy`

### Transient Errors (Retried)

These errors are automatically retried with exponential backoff + jitter:

- **Timeouts** (HTTP status 0 or network failures)
- **Rate limits** (HTTP 429)
- **Server errors** (HTTP 5xx)

**Example retry sequence:**
```
Attempt 1: Failed → wait 1s + random jitter
Attempt 2: Failed → wait 2s + random jitter
Attempt 3: Failed → wait 4s + random jitter (capped at 8s max)
Attempt 4: Success → proceed
```

### Permanent Errors (No Retry)

These errors fail immediately without retry:

- **4xx client errors** (e.g., 401 unauthorized, 403 forbidden)
- **Provider mapping errors** (e.g., model not found on target)
- **Configuration errors** (e.g., invalid API URL)

### Plugin Init Failure

```
Environment variables missing or invalid
    ↓
Plugin returns no-op hooks
    ↓
Everything works, just no NeurOn management
```

**No error shown** — the system degrades gracefully. Check `NEURON_LOG_FILE` for details.

---

## 7. Toast Notifications

NeurOn provides visual feedback in the TUI through toast notifications. Here's what users see:

### Cold Target Detected (Warning)

```
┌─────────────────────────────────────────────────────────────────────┐
│ NeurOn: warming up… please retry once warmup completes, up to 10m   │
└─────────────────────────────────────────────────────────────────────┘
```

**When:** Target is detected as cold/stopped during preflight check.

**Purpose:** Inform user that their request will wait for warmup completion. The timeout value reflects your `NEURON_WAIT_TIMEOUT_SECONDS` config (default: `10m`).

### Model Ready (Success)

```
┌──────────────────────────────────────────────────────────┐
│ NeurOn: model ready                                       │
└──────────────────────────────────────────────────────────┘
```

**When:** Background warmup completes successfully.

**Purpose:** Confirm the target is now healthy and ready.

### Target Stopping (Warning)

```
┌────────────────────────────────────────────────────────────────────────────────────┐
│ NeurOn: target stopping, restarting… please retry once warmup completes, up to 10m │
└────────────────────────────────────────────────────────────────────────────────────┘
```

**When:** Target is detected as "stopping" (shutting down) during preflight check on user messages.

**Purpose:** Inform user that the target is restarting and a new warmup is in progress.

### Reservation Failed (Error)

```
┌──────────────────────────────────────────────────────────┐
│ NeurOn: reservation failed (authentication error)         │
│ NeurOn: reservation failed (rate limited — wait and retry)│
│ NeurOn: reservation failed (server error)                 │
│ NeurOn: reservation failed (HTTP 503)                     │
└──────────────────────────────────────────────────────────┘
```

**When:** Reservation creation or warmup fails.

**Purpose:** Provide actionable context about what went wrong.

### Silent Fail-Open

**When:** NeurOn API is unreachable (network error, wrong base URL).

**What you see:** Nothing. The system proceeds without NeurOn interference.

---

## 8. Model → Target Matching

NeurOn maps OpenCode model IDs to NeurOn capacity targets. Here's how the matching works:

### Step-by-Step Matching Process

```
Model ID: "anthropic/claude-sonnet-4-20250514"
    ↓
1. Split into provider ("anthropic") and bare model ID ("claude-sonnet-4-20250514")
    ↓
2. Look up by:
   - Exact model ID match
   - Aliases
   - Backend model IDs
   - Runtime model IDs
    ↓
3. Match against target's supported model list
    ↓
4. Apply provider filter (if NEURON_ALLOWED_PROVIDERS is set)
    ↓
5. Return single target or error if ambiguous
```

### Example: Provider Fallback

If you request `anthropic/claude-sonnet` but the target only supports `google/claude-sonnet`:

```
NEURON_STRICT_PROVIDER_MATCH = false (default)
    ↓
Provider mismatch detected
    ↓
Single alternative target available
    ↓
Fallback allowed → use alternative target
```

```
NEURON_STRICT_PROVIDER_MATCH = true
    ↓
Provider mismatch detected
    ↓
No fallback → error: "Model not found on provider anthropic"
```

### Ambiguous Model Mapping

If a model is available on multiple providers:

```
Model "claude-sonnet" is on:
  - anthropic/claude-sonnet
  - google/claude-sonnet

No provider specified → Error:
"Model 'claude-sonnet' is available on providers: anthropic, google. Specify provider explicitly."
```

---

## 9. Session Lifecycle

NeurOn manages state across the entire session lifecycle:

### Session Creation

```
session.created event received
    ↓
Capture the model ID for this session
    ↓
Store in sessionModels map
    ↓
Ready for reservation management
```

### Model Switching Within a Session

```
User switches from model A to model B
    ↓
Old model's reservation cleaned up (if exists)
    ↓
New model's reservation created (if needed)
```

### Session Idle

```
session.idle event received
    ↓
Refresh reservation (keepalive)
    ↓
Prevents reservation expiration during inactivity
```

### Session Deletion

```
session.deleted event received
    ↓
Scrub all per-session state:
  - Reservations
  - Inflight requests
  - Retry state
  - Session model mapping
```

**Note:** `session.compacted` does NOT scrub state. The session is still alive.

### Plugin Shutdown

```
Plugin dispose() called
    ↓
Clear everything:
  - All reservations
  - All inflight requests
  - All warmup locks
  - All retry state
  - Session model mapping
```

---

## 10. Troubleshooting

### Requests Timing Out on Cold Starts

**Symptom:** Messages consistently timeout when sending to certain models.

**Diagnosis:**
1. Check `NEURON_LOG_FILE` for warmup lock messages
2. Verify `NEURON_WAIT_TIMEOUT_SECONDS` is appropriate for your hardware
3. Look for "warmup lock acquired" messages indicating successful reservation

**Solutions:**
```bash
# Increase timeout for slower hardware
export NEURON_WAIT_TIMEOUT_SECONDS=900  # 15 minutes

# Enable detailed logging
export NEURON_LOG_FILE=/tmp/neuron-debug.log
```

### Wrong Target Selected

**Symptom:** Messages are routed to unexpected providers.

**Diagnosis:**
1. Check `NEURON_ALLOWED_PROVIDERS` — ensure it includes the expected provider
2. Check `NEURON_STRICT_PROVIDER_MATCH` — set to `true` if you want strict provider matching
3. Review `NEURON_LOG_FILE` for target selection messages

**Example:**
```bash
# Allow only Anthropic models
export NEURON_ALLOWED_PROVIDERS=anthropic

# Enable strict provider matching
export NEURON_STRICT_PROVIDER_MATCH=true
```

### Warmup Not Happening

**Symptom:** No warmup notifications, requests immediately timeout.

**Diagnosis:**
1. Verify `NEURON_API_BASE_URL` is correct
2. Verify `NEURON_API_KEY` is valid and has permissions
3. Check `NEURON_LOG_FILE` for "resolve target failure" messages
4. Confirm the API server is actually running

**Debug steps:**
```bash
# Verify API is accessible
curl http://localhost:8090/api/status

# Check authentication
curl -H "Authorization: Bearer YOUR_API_KEY" http://localhost:8090/api/status

# Review logs
cat ~/neuron-plugin.log
```

### Duplicate Reservations

**Symptom:** Multiple reservations for the same target (shouldn't happen).

**Diagnosis:**
1. Check `NEURON_LOG_FILE` for "warmup lock acquired" messages
2. Look for multiple "warmup lock acquired (leader)" messages for the same target
3. Verify no other NeurOn instances are running

**This shouldn't happen** — the warmup lock prevents duplicates. If it does, it indicates a configuration issue or multiple plugin instances.

### Plugin Init Failure

**Symptom:** No NeurOn behavior at all, but no error messages.

**Diagnosis:**
1. Check `NEURON_LOG_FILE` for "plugin init failure" messages
2. Verify all required environment variables are set
3. Validate API URL is a valid HTTP/HTTPS URL

**Example error:**
```
NEURON_API_BASE_URL must be a valid http:// or https:// URL
```

### Cooldown Period Issues

**Symptom:** NeurOn stops checking health after a network error.

**Diagnosis:**
1. Check `NEURON_COOLDOWN_PERIOD_MS` (default 30 seconds)
2. Verify network is restored after cooldown period
3. Logs will show "fail-open: reason=transport_cooldown"

**Solution:** Increase cooldown if you expect intermittent network issues:
```bash
export NEURON_COOLDOWN_PERIOD_MS=60000  # 60 seconds
```

---

## Quick Reference

### Common Environment Variables

```bash
# Required
export NEURON_API_BASE_URL=http://localhost:8090
export NEURON_API_KEY=your-api-key

# Optional (with defaults)
export NEURON_WAIT_TIMEOUT_SECONDS=600        # 10 minutes
export NEURON_RESERVATION_DURATION_MINUTES=2  # 2 minutes
export NEURON_ALLOWED_PROVIDERS=*             # All providers
```

### Key Concepts

| Term | Meaning |
|------|---------|
| **Capacity target** | A GPU server that can host models |
| **Reservation** | A commitment to keep a target warm |
| **Warmup lock** | Prevents duplicate warmups for the same target |
| **Fail open** | NeurOn unavailable, proceed normally |
| **Preflight** | Fast health check before blocking |

### When to Use Which Hook

| Use Case | Hook |
|----------|------|
| User sends message | `message.updated` |
| Tool needs to execute | `tool.execute.before` |
| Session is idle | `session.idle` |
| Session is deleted | `session.deleted` |

---

## License

This plugin is part of the OpenCode project. See the main repository for licensing information.
