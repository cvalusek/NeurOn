# Independent HassleOff watchdog

- HassleOff can run as an independent RunPod CPU watchdog without retaining a
  RunPod API key.
- NeurOn supplies the effective provider credential over authenticated HTTPS
  only when acquiring a protected lease; HassleOff keeps it in memory and
  accepts a resupply after a watchdog restart.
- The operator guide covers same-data-center placement, RunPod's HTTPS proxy,
  durable watchdog state, and the explicit memory-only recovery caveat.
