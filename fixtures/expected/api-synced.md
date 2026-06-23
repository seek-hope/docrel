# API Documentation

## Authentication

The `login` function takes a `username` and `password` and returns an auth token.

### login(username, password)

Authenticates a user with username and password. Returns an auth token.

**Parameters:**
- `username` (string) — the user's login name
- `password` (string) — the user's secret

**Returns:** `string` — an auth token
