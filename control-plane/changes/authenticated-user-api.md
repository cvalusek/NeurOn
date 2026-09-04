# Authenticated user API for reservation clients

The control plane now exposes `GET /api/me` for authenticated API clients. Reservation integrations can use the response to identify the current user and safely scope adoption of existing reservations. The endpoint requires the caller's normal authentication credentials.
