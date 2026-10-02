# API Health Monitor

A JavaScript monitor built with Node.js, Express and SQLite. Check HTTP status, response time and JSON values; three consecutive failures open an incident, and a successful check resolves it.

## Run

Requires Node.js 24 or newer.

```sh
npm ci
npm start
```

Open `http://localhost:3000` for the interactive dashboard and API. Monitor data is saved to `data/monitor.db`.

## API

```sh
curl -X POST http://localhost:3000/monitors \
  -H 'Content-Type: application/json' \
  -d '{"name":"Example","url":"https://example.com"}'
```

| Method | Route | Purpose |
| --- | --- | --- |
| GET, POST | `/monitors` | List or create |
| GET, PATCH, DELETE | `/monitors/:id` | View, edit or delete |
| POST | `/monitors/:id/check` | Run a check |
| GET | `/monitors/:id/checks` | Check history |
| GET | `/monitors/:id/incidents` | Incident history |

Intervals range from 10 seconds to 24 hours. Optional rules include `expectedStatus`, `maxResponseMs`, and `expectedJson`, for example `{"path":"data.ready","equals":true}`. Targets must resolve to public IP addresses. Redirects are rejected and responses are capped at 64 KiB.

## Demo and tests

The dashboard runs healthy, wrong-JSON, slow-response, and outage-and-recovery scenarios with fixed sample responses. It uses the real checker and incident logic without contacting outside sites. `npm run demo` runs a terminal version; `npm test` runs the test suite.

For hosting, `render.yaml` configures a free Render web service from `demo-dashboard` with manual deployments. It sets `HOST=0.0.0.0` and `PUBLIC_DEMO=true`. Binding to a non-loopback address disables monitor management and scheduled checks. Only the dashboard and fixed demo routes are exposed. Demo state resets each run. `PUBLIC_DEMO=false` disables the dashboard.
