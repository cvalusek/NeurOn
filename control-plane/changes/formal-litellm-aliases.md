# Correct LiteLLM aliases and fallbacks

NeurOn now keeps one canonical LiteLLM deployment for each target/model and
publishes friendly names through LiteLLM's formal model-group aliases. Target
priority collisions become explicit ordered fallbacks instead of duplicate
alias-named model rows with deployment order values.

The first successful discovery sync removes redundant NeurOn-owned alias rows
from older releases while preserving operator-owned deployments and router
settings. Administrators should pin and test a LiteLLM release that exposes the
database-backed model, credential, and router-settings management APIs.
