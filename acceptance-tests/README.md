# Acceptance Tests

This directory contains acceptance tests for the Fiber L402 payment flow.

## Known Issues

| Issue | Description | Priority |
|-------|-------------|----------|
| issue1 | Fiber node RPC URL must be reachable before running tests | Medium |
| issue2 | Proxy server must include CORS configuration to allow cross-origin requests from the web frontend; without it the full payment flow cannot complete | **High** |
| issue3 | `L402_ROOT_KEY` must be a valid 32-byte hex string (64 characters) | Medium |

## Running Acceptance Tests

```bash
pnpm test
```

> **Note:** Make sure the proxy server has CORS configured (see issue2 above) and that both services are running before executing the acceptance tests.
