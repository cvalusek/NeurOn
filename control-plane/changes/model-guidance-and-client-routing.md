# Model guidance, usage, and client routing

Profile creation and editing now use a dedicated page with hard context, cost,
capability, and hosting-mode requirements plus a snapping Good/Fast/Cheap
ranking triangle. Model cards show durable intelligence, target-specific speed,
effective context, estimated quality retained, hourly cost, aliases, favorites,
profile use, and recent popularity. Admins can maintain model facts, run one
target discovery/benchmark or sequential Rediscover all, and review daily usage
by user, provider, target, and model.

Client setup now generates OpenCode configuration and lists global and scoped
LiteLLM aliases. Alias collisions resolve by target priority and publish ordered
fallback candidates; operators should enable LiteLLM pre-call checks and verify
their pinned LiteLLM version. Stale NeurOn-owned aliases are retired without
deleting LiteLLM history. AWS target discovery hides already-configured EC2
instances by default.
