const http = require("http");
const fs = require("fs");
const path = require("path");
const { URL } = require("url");

const PORT = process.env.PORT || 3000;
const PUBLIC_DIR = path.resolve(__dirname, "public");
const MAX_BODY_BYTES = 1024 * 1024;
const USER_AGENT = "BulkLinkChecker/0.1 (+https://github.com/)";

const MIME_TYPES = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
};

const server = http.createServer(async (req, res) => {
  const requestUrl = new URL(req.url, `http://${req.headers.host || "localhost"}`);

  if (requestUrl.pathname === "/api/check" && req.method === "POST") {
    await handleCheck(req, res);
    return;
  }

  if (req.method !== "GET" && req.method !== "HEAD") {
    res.writeHead(405, { "Content-Type": "text/plain; charset=utf-8" });
    res.end("Method Not Allowed");
    return;
  }

  serveStatic(requestUrl.pathname, req, res);
});

server.listen(PORT, () => {
  console.log(`Bulk Link Checker running at http://localhost:${PORT}`);
});

async function handleCheck(req, res) {
  try {
    const payload = await readJson(req);
    const urls = Array.isArray(payload.urls) ? payload.urls : [];

    if (urls.length === 0) {
      sendJson(res, 400, { error: "Provide at least one URL." });
      return;
    }

    const options = normalizeOptions(payload);
    const startedAt = Date.now();
    const results = await runPool(urls, options.concurrency, (value) =>
      checkUrl(value, options)
    );

    sendJson(res, 200, {
      results,
      durationMs: Date.now() - startedAt,
    });
  } catch (error) {
    const message = formatError(error);
    const status = error instanceof SyntaxError || message === "Payload too large."
      ? 400
      : 500;
    sendJson(res, status, { error: message });
  }
}

function normalizeOptions(payload) {
  return {
    timeoutMs: clampNumber(payload.timeoutMs, 8000, 2000, 30000),
    maxRedirects: clampNumber(payload.maxRedirects, 6, 0, 15),
    concurrency: clampNumber(payload.concurrency, 6, 1, 20),
    fetchTitle: payload.fetchTitle !== false,
  };
}

function clampNumber(value, fallback, min, max) {
  const number = Number(value);
  if (!Number.isFinite(number)) {
    return fallback;
  }
  return Math.min(Math.max(Math.round(number), min), max);
}

async function checkUrl(rawValue, options) {
  const startedAt = Date.now();
  const inputUrl = typeof rawValue === "string" ? rawValue.trim() : String(rawValue ?? "");
  const normalizedUrl = normalizeInputUrl(inputUrl);

  if (!normalizedUrl) {
    return buildResult({
      inputUrl,
      normalizedUrl: null,
      status: null,
      ok: false,
      finalUrl: null,
      redirects: [],
      durationMs: Date.now() - startedAt,
      title: null,
      contentType: null,
      error: "Invalid URL",
    });
  }

  let currentUrl = normalizedUrl;
  const redirects = [currentUrl];
  let response = null;
  let errorMessage = null;

  for (let hop = 0; hop <= options.maxRedirects; hop += 1) {
    try {
      response = await requestWithFallback(currentUrl, options.timeoutMs);
    } catch (error) {
      errorMessage = formatError(error);
      response = null;
      break;
    }

    const location = response.headers.get("location");

    if (response.status >= 300 && response.status < 400 && location) {
      response.body?.cancel();
      if (hop === options.maxRedirects) {
        errorMessage = "Too many redirects";
        break;
      }
      currentUrl = new URL(location, currentUrl).toString();
      redirects.push(currentUrl);
      continue;
    }

    break;
  }

  const status = response ? response.status : null;
  const ok = status !== null && status >= 200 && status < 400 && !errorMessage;
  const finalUrl = response ? currentUrl : null;
  const contentType = response ? response.headers.get("content-type") : null;
  let title = null;

  if (options.fetchTitle && response && status >= 200 && status < 400) {
    try {
      title = await fetchTitle(finalUrl, options.timeoutMs);
    } catch (error) {
      title = null;
    }
  }

  response?.body?.cancel();

  return buildResult({
    inputUrl,
    normalizedUrl,
    status,
    ok,
    finalUrl,
    redirects,
    durationMs: Date.now() - startedAt,
    title,
    contentType,
    error: errorMessage,
  });
}

function buildResult(result) {
  return {
    inputUrl: result.inputUrl,
    normalizedUrl: result.normalizedUrl,
    status: result.status,
    ok: result.ok,
    finalUrl: result.finalUrl,
    redirects: result.redirects,
    durationMs: result.durationMs,
    title: result.title,
    contentType: result.contentType,
    error: result.error,
  };
}

async function requestWithFallback(url, timeoutMs) {
  const response = await fetchOnce(url, "HEAD", timeoutMs);
  if (response.status === 405 || response.status === 501) {
    response.body?.cancel();
    return fetchOnce(url, "GET", timeoutMs);
  }
  return response;
}

async function fetchOnce(url, method, timeoutMs) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  try {
    return await fetch(url, {
      method,
      redirect: "manual",
      headers: {
        "user-agent": USER_AGENT,
        accept: "*/*",
      },
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timeout);
  }
}

async function fetchTitle(url, timeoutMs) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(url, {
      method: "GET",
      redirect: "follow",
      headers: {
        "user-agent": USER_AGENT,
        accept: "text/html,*/*",
      },
      signal: controller.signal,
    });

    const contentType = response.headers.get("content-type") || "";
    if (!contentType.includes("text/html")) {
      response.body?.cancel();
      return null;
    }

    const text = await response.text();

    return extractTitle(text);
  } finally {
    clearTimeout(timeout);
  }
}

function extractTitle(html) {
  const match = html.match(/<title[^>]*>([^<]*)<\/title>/i);
  if (!match) {
    return null;
  }
  return match[1].replace(/\s+/g, " ").trim().slice(0, 200);
}

function normalizeInputUrl(value) {
  if (!value) {
    return null;
  }
  const trimmed = value.trim();
  if (!trimmed) {
    return null;
  }
  const hasScheme = /^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(trimmed);
  const candidate = hasScheme ? trimmed : `https://${trimmed}`;

  try {
    const parsed = new URL(candidate);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      return null;
    }
    return parsed.toString();
  } catch (error) {
    return null;
  }
}

async function runPool(items, limit, worker) {
  const results = new Array(items.length);
  let nextIndex = 0;

  const runners = Array.from({ length: Math.min(limit, items.length) }, () =>
    (async () => {
      while (true) {
        const index = nextIndex;
        nextIndex += 1;
        if (index >= items.length) {
          return;
        }
        results[index] = await worker(items[index], index);
      }
    })()
  );

  await Promise.all(runners);
  return results;
}

async function readJson(req) {
  const chunks = [];
  let size = 0;

  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_BODY_BYTES) {
      throw new Error("Payload too large.");
    }
    chunks.push(chunk);
  }

  const text = Buffer.concat(chunks).toString("utf8");
  if (!text) {
    return {};
  }
  return JSON.parse(text);
}

function serveStatic(pathname, req, res) {
  const safePath = path.resolve(PUBLIC_DIR, `.${pathname}`);
  if (!safePath.startsWith(PUBLIC_DIR)) {
    res.writeHead(403, { "Content-Type": "text/plain; charset=utf-8" });
    res.end("Forbidden");
    return;
  }

  let filePath = safePath;
  try {
    const stat = fs.statSync(filePath);
    if (stat.isDirectory()) {
      filePath = path.join(filePath, "index.html");
    }
  } catch (error) {
    res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
    res.end("Not Found");
    return;
  }

  const ext = path.extname(filePath).toLowerCase();
  const contentType = MIME_TYPES[ext] || "application/octet-stream";

  res.writeHead(200, { "Content-Type": contentType });
  if (req.method === "HEAD") {
    res.end();
    return;
  }

  fs.createReadStream(filePath).pipe(res);
}

function sendJson(res, status, payload) {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(payload));
}

function formatError(error) {
  if (!error) {
    return "Unknown error";
  }

  const target = error.cause || error;
  if (target.name === "AbortError") {
    return "Request timed out";
  }

  if (target.code === "ENOTFOUND") {
    return "DNS lookup failed";
  }

  if (target.code === "ECONNREFUSED") {
    return "Connection refused";
  }

  if (target.code === "ECONNRESET") {
    return "Connection reset";
  }

  return target.message || String(target);
}
