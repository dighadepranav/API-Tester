# API Performance Analyzer Dashboard

A full-stack API performance monitoring tool. Zero npm dependencies — runs entirely on Node.js built-ins.

## Quick Start

```bash
# 1. Enter the project folder
cd api-analyzer

# 2. Start the backend (no npm install needed!)
node server.js

# 3. Open your browser
open http://localhost:3001
```

That's it. The backend serves the frontend automatically.

---

## Project Structure

```
api-analyzer/
├── server.js          ← Backend (Node.js, zero dependencies)
├── package.json
├── README.md
└── public/
    └── index.html     ← Frontend (served by backend)
```

---

## API Endpoints

| Method | Endpoint | Description |
|--------|----------|-------------|
| POST | `/api/proxy` | Proxy a request to an external API |
| GET | `/api/history` | Get paginated request history |
| GET | `/api/analytics` | Get performance analytics |
| GET | `/api/health` | Backend health check |
| GET | `/api/export?format=csv\|json` | Export history |
| GET | `/api/requests/:id` | Get full detail of one request |
| DELETE | `/api/requests/:id` | Delete one request |
| DELETE | `/api/history` | Clear all history |

### POST /api/proxy — Request body

```json
{
  "url": "https://api.example.com/users",
  "method": "GET",
  "headers": {
    "Authorization": "Bearer token"
  },
  "body": null,
  "sessionId": "optional-session-id"
}
```

### GET /api/history — Query params

| Param | Description |
|-------|-------------|
| `limit` | Results per page (default 50, max 200) |
| `page` | Page number (default 1) |
| `method` | Filter by HTTP method |
| `status` | Filter by status code |
| `search` | Search in URL |

---

## Configuration

```bash
# Change port (default 3001)
PORT=8080 node server.js
```

---

## Features

- **Zero dependencies** — uses only Node.js built-ins (http, https, url, fs, crypto)
- **Real proxy** — forwards requests to any external API, measures latency accurately
- **Analytics** — p50/p95/p99 latencies, method/status breakdowns, latency buckets
- **History** — paginated, filterable, searchable request log (up to 500 entries)
- **Export** — CSV or JSON download
- **Detail view** — full request + response inspection per entry
- **Auto health poll** — frontend pings backend every 10s

---

## Extending (Production)

To persist history across restarts, replace the in-memory `store.requests` array in `server.js` with:
- **SQLite**: use the `better-sqlite3` package
- **Redis**: use `ioredis`
- **PostgreSQL**: use `pg`

The `computeAnalytics()` function and all routes require no changes.
