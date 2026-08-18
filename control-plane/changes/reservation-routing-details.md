# Clearer reservation connection details

Active reservations now show target-specific LiteLLM global and scoped aliases
prominently, with direct runtime/llama.cpp model IDs labeled separately. Target
and reservation detail cards link to the direct model-host UI when the target
has a safe HTTP endpoint.

Already-prefixed aliases are no longer prefixed a second time when NeurOn builds
their target-scoped route.
