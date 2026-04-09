/**
 * API Performance Analyzer - Backend Server
 * Express.js + Node.js backend with full proxy, analytics, and history
 */

const http = require('http');
const https = require('https');
const url = require('url');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const PORT = process.env.PORT || 3001;

// ─── In-memory store (swap for SQLite/Redis in production) ───────────────────
const store = {
  requests: [],          // Full request log
  sessions: new Map(),   // sessionId -> metadata
  maxHistory: 500,
};

// ─── CORS helper ─────────────────────────────────────────────────────────────
function setCORS(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PUT,DELETE,PATCH,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-Session-Id');
}

// ─── JSON response helpers ────────────────────────────────────────────────────
function sendJSON(res, status, data) {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(data));
}

function sendError(res, status, message) {
  sendJSON(res, status, { success: false, error: message });
}

// ─── UUID ────────────────────────────────────────────────────────────────────
function uuid() {
  return crypto.randomBytes(16).toString('hex');
}

// ─── Compute percentile ──────────────────────────────────────────────────────
function percentile(arr, p) {
  if (!arr.length) return 0;
  const sorted = [...arr].sort((a, b) => a - b);
  const idx = Math.ceil((p / 100) * sorted.length) - 1;
  return sorted[Math.max(0, idx)];
}

// ─── Analytics from stored requests ─────────────────────────────────────────
function computeAnalytics(requests) {
  if (!requests.length) {
    return {
      total: 0, success: 0, failed: 0, errors: 0,
      successRate: 0, errorRate: 0,
      avgLatency: 0, minLatency: 0, maxLatency: 0,
      p50: 0, p95: 0, p99: 0,
      methodBreakdown: {}, statusBreakdown: {},
      latencyBuckets: { fast: 0, medium: 0, slow: 0, timeout: 0 },
      recentTrend: [],
    };
  }

  const latencies = requests.map(r => r.latency);
  const success = requests.filter(r => r.status >= 200 && r.status < 300).length;
  const failed = requests.filter(r => r.status >= 400).length;
  const errors = requests.filter(r => r.status === 0).length;

  const methodBreakdown = {};
  const statusBreakdown = {};
  requests.forEach(r => {
    methodBreakdown[r.method] = (methodBreakdown[r.method] || 0) + 1;
    const bucket = r.status === 0 ? 'error' : String(Math.floor(r.status / 100)) + 'xx';
    statusBreakdown[bucket] = (statusBreakdown[bucket] || 0) + 1;
  });

  const latencyBuckets = { fast: 0, medium: 0, slow: 0, timeout: 0 };
  latencies.forEach(l => {
    if (l < 200) latencyBuckets.fast++;
    else if (l < 800) latencyBuckets.medium++;
    else if (l < 3000) latencyBuckets.slow++;
    else latencyBuckets.timeout++;
  });

  // Last 10 for sparkline
  const recentTrend = requests.slice(-10).map(r => ({ latency: r.latency, status: r.status }));

  return {
    total: requests.length,
    success,
    failed,
    errors,
    successRate: +((success / requests.length) * 100).toFixed(1),
    errorRate: +(((failed + errors) / requests.length) * 100).toFixed(1),
    avgLatency: Math.round(latencies.reduce((a, b) => a + b, 0) / latencies.length),
    minLatency: Math.min(...latencies),
    maxLatency: Math.max(...latencies),
    p50: percentile(latencies, 50),
    p95: percentile(latencies, 95),
    p99: percentile(latencies, 99),
    methodBreakdown,
    statusBreakdown,
    latencyBuckets,
    recentTrend,
  };
}

// ─── Core proxy function ─────────────────────────────────────────────────────
function proxyRequest(targetUrl, method, headers, body, callback) {
  let parsed;
  try {
    parsed = new url.URL(targetUrl);
  } catch (e) {
    return callback({ error: 'Invalid URL: ' + e.message, status: 0, latency: 0 });
  }

  const isHttps = parsed.protocol === 'https:';
  const lib = isHttps ? https : http;
  const port = parsed.port || (isHttps ? 443 : 80);

  // Strip hop-by-hop headers that shouldn't be forwarded
  const forbidden = new Set([
    'host', 'connection', 'transfer-encoding', 'upgrade',
    'proxy-authorization', 'te', 'trailers', 'keep-alive',
  ]);

  const outHeaders = {};
  Object.entries(headers || {}).forEach(([k, v]) => {
    if (!forbidden.has(k.toLowerCase())) outHeaders[k] = v;
  });

  const bodyBuf = body ? Buffer.from(body) : null;
  if (bodyBuf) outHeaders['content-length'] = bodyBuf.length;

  const opts = {
    hostname: parsed.hostname,
    port,
    path: parsed.pathname + parsed.search,
    method: method.toUpperCase(),
    headers: outHeaders,
    timeout: 15000,
  };

  const t0 = Date.now();
  let responded = false;

  const req = lib.request(opts, (res) => {
    const latency = Date.now() - t0;
    const chunks = [];
    res.on('data', c => chunks.push(c));
    res.on('end', () => {
      if (responded) return;
      responded = true;
      const rawBody = Buffer.concat(chunks);
      const encoding = res.headers['content-encoding'];
      // Return raw - let client handle encoding
      callback({
        status: res.statusCode,
        statusText: res.statusMessage,
        headers: res.headers,
        body: rawBody.toString('utf8'),
        latency,
        size: rawBody.length,
        error: null,
      });
    });
  });

  req.on('timeout', () => {
    if (responded) return;
    responded = true;
    req.destroy();
    callback({ error: 'Request timed out (15s)', status: 0, latency: Date.now() - t0 });
  });

  req.on('error', (err) => {
    if (responded) return;
    responded = true;
    callback({ error: err.message, status: 0, latency: Date.now() - t0 });
  });

  if (bodyBuf) req.write(bodyBuf);
  req.end();
}

// ─── Request body parser ─────────────────────────────────────────────────────
function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', c => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

// ─── Route handlers ──────────────────────────────────────────────────────────

// POST /api/proxy  — proxy a request to an external API
async function handleProxy(req, res) {
  let payload;
  try {
    const raw = await readBody(req);
    payload = JSON.parse(raw);
  } catch {
    return sendError(res, 400, 'Invalid JSON body');
  }

  const { url: targetUrl, method = 'GET', headers = {}, body, sessionId } = payload;
  if (!targetUrl) return sendError(res, 400, 'url is required');

  const allowedMethods = ['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'HEAD', 'OPTIONS'];
  if (!allowedMethods.includes((method || '').toUpperCase())) {
    return sendError(res, 400, 'Unsupported HTTP method');
  }

  proxyRequest(targetUrl, method, headers, body, (result) => {
    const record = {
      id: uuid(),
      sessionId: sessionId || 'default',
      url: targetUrl,
      method: method.toUpperCase(),
      requestHeaders: headers,
      requestBody: body || null,
      status: result.status || 0,
      statusText: result.statusText || '',
      responseHeaders: result.headers || {},
      responseBody: result.body || '',
      latency: result.latency || 0,
      size: result.size || 0,
      error: result.error || null,
      timestamp: new Date().toISOString(),
    };

    store.requests.push(record);
    if (store.requests.length > store.maxHistory) {
      store.requests.shift();
    }

    if (result.error) {
      sendJSON(res, 200, {
        success: false,
        error: result.error,
        latency: result.latency,
        id: record.id,
        timestamp: record.timestamp,
      });
    } else {
      sendJSON(res, 200, {
        success: true,
        id: record.id,
        status: result.status,
        statusText: result.statusText,
        headers: result.headers,
        body: result.body,
        latency: result.latency,
        size: result.size,
        timestamp: record.timestamp,
      });
    }
  });
}

// GET /api/history?limit=50&method=GET&status=200&sessionId=x
function handleHistory(req, res) {
  const q = new url.URL('http://x' + req.url).searchParams;
  const limit = Math.min(parseInt(q.get('limit') || '50'), 200);
  const methodFilter = q.get('method');
  const statusFilter = q.get('status');
  const sessionId = q.get('sessionId');
  const search = q.get('search');

  let filtered = [...store.requests].reverse();

  if (sessionId) filtered = filtered.filter(r => r.sessionId === sessionId);
  if (methodFilter) filtered = filtered.filter(r => r.method === methodFilter.toUpperCase());
  if (statusFilter) {
    const s = parseInt(statusFilter);
    filtered = filtered.filter(r => Math.floor(r.status / 100) === Math.floor(s / 100));
  }
  if (search) {
    const q2 = search.toLowerCase();
    filtered = filtered.filter(r => r.url.toLowerCase().includes(q2));
  }

  const page = Math.max(1, parseInt(q.get('page') || '1'));
  const total = filtered.length;
  const sliced = filtered.slice((page - 1) * limit, page * limit);

  sendJSON(res, 200, {
    success: true,
    total,
    page,
    limit,
    data: sliced.map(r => ({
      id: r.id,
      method: r.method,
      url: r.url,
      status: r.status,
      statusText: r.statusText,
      latency: r.latency,
      size: r.size,
      error: r.error,
      timestamp: r.timestamp,
    })),
  });
}

// GET /api/analytics
function handleAnalytics(req, res) {
  const q = new url.URL('http://x' + req.url).searchParams;
  const sessionId = q.get('sessionId');
  const last = parseInt(q.get('last') || '0');

  let reqs = store.requests;
  if (sessionId) reqs = reqs.filter(r => r.sessionId === sessionId);
  if (last > 0) reqs = reqs.slice(-last);

  sendJSON(res, 200, { success: true, analytics: computeAnalytics(reqs) });
}

// GET /api/requests/:id — single request detail
function handleDetail(req, res, id) {
  const record = store.requests.find(r => r.id === id);
  if (!record) return sendError(res, 404, 'Request not found');
  sendJSON(res, 200, { success: true, data: record });
}

// DELETE /api/history — clear all
function handleClear(req, res) {
  store.requests = [];
  sendJSON(res, 200, { success: true, message: 'History cleared' });
}

// DELETE /api/requests/:id
function handleDeleteOne(req, res, id) {
  const idx = store.requests.findIndex(r => r.id === id);
  if (idx === -1) return sendError(res, 404, 'Not found');
  store.requests.splice(idx, 1);
  sendJSON(res, 200, { success: true });
}

// GET /api/health
function handleHealth(req, res) {
  sendJSON(res, 200, {
    success: true,
    status: 'healthy',
    uptime: process.uptime(),
    requests: store.requests.length,
    memory: process.memoryUsage(),
    version: '1.0.0',
    timestamp: new Date().toISOString(),
  });
}

// GET /api/export?format=csv|json
function handleExport(req, res) {
  const q = new url.URL('http://x' + req.url).searchParams;
  const format = q.get('format') || 'json';

  if (format === 'csv') {
    const header = 'id,method,url,status,latency,size,error,timestamp\n';
    const rows = store.requests.map(r =>
      [r.id, r.method, `"${r.url}"`, r.status, r.latency, r.size, `"${r.error || ''}"`, r.timestamp].join(',')
    ).join('\n');
    res.writeHead(200, {
      'Content-Type': 'text/csv',
      'Content-Disposition': 'attachment; filename="api-history.csv"',
    });
    res.end(header + rows);
  } else {
    res.writeHead(200, {
      'Content-Type': 'application/json',
      'Content-Disposition': 'attachment; filename="api-history.json"',
    });
    res.end(JSON.stringify({ exported: new Date().toISOString(), data: store.requests }, null, 2));
  }
}

// ─── Main router ─────────────────────────────────────────────────────────────
const server = http.createServer(async (req, res) => {
  setCORS(res);

  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    return res.end();
  }

  const parsed = url.parse(req.url);
  const pathname = parsed.pathname;

  // Serve frontend HTML
  if (req.method === 'GET' && (pathname === '/' || pathname === '/index.html')) {
    const htmlPath = path.join(__dirname, 'public', 'index.html');
    if (fs.existsSync(htmlPath)) {
      res.writeHead(200, { 'Content-Type': 'text/html' });
      return res.end(fs.readFileSync(htmlPath));
    }
    res.writeHead(200, { 'Content-Type': 'text/html' });
    return res.end('<h1>API Analyzer Backend Running</h1><p>Place your frontend in ./public/index.html</p>');
  }

  // API routes
  try {
    if (req.method === 'POST' && pathname === '/api/proxy') return handleProxy(req, res);
    if (req.method === 'GET'  && pathname === '/api/history') return handleHistory(req, res);
    if (req.method === 'GET'  && pathname === '/api/analytics') return handleAnalytics(req, res);
    if (req.method === 'GET'  && pathname === '/api/health') return handleHealth(req, res);
    if (req.method === 'GET'  && pathname === '/api/export') return handleExport(req, res);
    if (req.method === 'DELETE' && pathname === '/api/history') return handleClear(req, res);

    // /api/requests/:id
    const detailMatch = pathname.match(/^\/api\/requests\/([a-f0-9]+)$/);
    if (detailMatch) {
      if (req.method === 'GET') return handleDetail(req, res, detailMatch[1]);
      if (req.method === 'DELETE') return handleDeleteOne(req, res, detailMatch[1]);
    }

    sendError(res, 404, `Route not found: ${req.method} ${pathname}`);
  } catch (err) {
    console.error('Unhandled error:', err);
    sendError(res, 500, 'Internal server error');
  }
});

server.listen(PORT, () => {
  console.log(`\n  ╔══════════════════════════════════════════╗`);
  console.log(`  ║   API Performance Analyzer — Backend     ║`);
  console.log(`  ╠══════════════════════════════════════════╣`);
  console.log(`  ║   Server  : http://localhost:${PORT}         ║`);
  console.log(`  ║   Health  : http://localhost:${PORT}/api/health ║`);
  console.log(`  ║   Frontend: http://localhost:${PORT}/         ║`);
  console.log(`  ╚══════════════════════════════════════════╝\n`);
});

server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    console.error(`Port ${PORT} is in use. Set PORT env var to change.`);
  } else {
    console.error('Server error:', err);
  }
  process.exit(1);
});

module.exports = server;
