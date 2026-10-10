# API Health Monitor

A local API monitor built with JavaScript, Node.js, Express and SQLite. Checks HTTP status, response time and optional JSON values. Three consecutive failures open an incident; the next successful check resolves it.

## Run

Requires Node.js 24 or newer.

```sh
npm ci
npm start
```

The API listens at `http://localhost:3000`. Data is saved to `data/monitor.db`. Set `PORT` or `DB_PATH` to override either default. Use `npm run dev` to restart on file changes.

## Try it

```sh
# Create a monitor with a 60-second check interval
curl -X POST http://localhost:3000/monitors \
  -H 'Content-Type: application/json' \
  -d '{"name":"Example","url":"https://example.com","intervalSeconds":60}'

# List monitors and their current status
curl http://localhost:3000/monitors

# Run a check now and save the result
curl -X POST http://localhost:3000/monitors/ID/check

# View recent check results
curl http://localhost:3000/monitors/ID/checks

# View open and resolved incidents
curl http://localhost:3000/monitors/ID/incidents
```

Replace `ID` with the ID returned when creating a monitor.

| Method | Route | Purpose |
| --- | --- | --- |
| GET | `/health` | Service health |
| GET, POST | `/monitors` | List or create monitors |
| GET, PATCH, DELETE | `/monitors/:id` | Read, edit or delete a monitor |
| POST | `/monitors/:id/check` | Run a check now |
| GET | `/monitors/:id/checks` | Recent results |
| GET | `/monitors/:id/incidents` | Incident history |

History routes accept `?limit=50` (maximum 100), newest first.

Optional fields: `expectedStatus` (200), `timeoutMs` (5000), `maxResponseMs`, `enabled` (true), and `expectedJson`, such as `{"path":"data.ready","equals":true}`. JSON comparisons preserve types. Intervals range from 10 seconds to 24 hours; timeouts from 100 to 30,000 ms and cannot exceed the interval.

## Behaviour

- At most four checks run at once, with one per monitor. Busy manual requests return 409 or 429. Checks have no immediate retries.
- New monitors are checked on the next scheduler tick. Later checks wait one interval after completion. Pausing stops scheduled checks; manual checks still work.
- State and history survive restarts. Editing resets the failure streak and closes open incidents as `configuration_changed`. Results from older configurations are discarded.
- Up to 100 monitors, 1,000 results and 100 incidents per monitor are retained. Deleting a monitor removes its history.
- Targets must resolve only to public addresses. Connections use the validated address, redirects are rejected, and responses are capped at 64 KiB. Deadlines include DNS and response reading.

This is a single-process tool with no login or frontend. It binds to loopback and rejects remote browser origins. Checks run from the machine hosting it; monitoring stops when that process or computer stops.

## Tests and demo

```sh
npm test
npm run demo
```

The demo runs a local fixture through the API, checker and database: success, wrong JSON, HTTP 503, timeout, recovery. It uses an isolated test transport; the normal server still blocks local targets. Tests cover validation, network failures, history, scheduling, incidents, persistence and shutdown. GitHub Actions runs both commands.
