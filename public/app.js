const urlInput = document.getElementById("urlInput");
const timeoutInput = document.getElementById("timeoutInput");
const redirectInput = document.getElementById("redirectInput");
const concurrencyInput = document.getElementById("concurrencyInput");
const titleToggle = document.getElementById("titleToggle");
const runButton = document.getElementById("runButton");
const clearButton = document.getElementById("clearButton");
const exportButton = document.getElementById("exportButton");
const sampleButton = document.getElementById("sampleButton");
const statusText = document.getElementById("statusText");
const resultsBody = document.getElementById("resultsBody");
const errorsOnly = document.getElementById("errorsOnly");
const searchInput = document.getElementById("searchInput");

const totalCount = document.getElementById("totalCount");
const okCount = document.getElementById("okCount");
const redirectCount = document.getElementById("redirectCount");
const errorCount = document.getElementById("errorCount");
const avgTime = document.getElementById("avgTime");

const sampleUrls = [
  "https://example.com",
  "https://developer.mozilla.org",
  "https://www.github.com",
  "https://news.ycombinator.com",
  "https://httpstat.us/404",
].join("\n");

let results = [];

timeoutInput.value = 8000;
redirectInput.value = 6;
concurrencyInput.value = 6;

sampleButton.addEventListener("click", () => {
  urlInput.value = sampleUrls;
  setStatus("Sample list loaded.");
});

clearButton.addEventListener("click", () => {
  urlInput.value = "";
  results = [];
  renderResults();
  updateSummary();
  exportButton.disabled = true;
  setStatus("Cleared.");
});

runButton.addEventListener("click", runCheck);
errorsOnly.addEventListener("change", renderResults);
searchInput.addEventListener("input", renderResults);

exportButton.addEventListener("click", () => {
  if (results.length === 0) {
    return;
  }
  const csv = buildCsv(results);
  const blob = new Blob([csv], { type: "text/csv" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = "link-check-results.csv";
  link.click();
  URL.revokeObjectURL(url);
});

async function runCheck() {
  const urls = parseUrls(urlInput.value);
  if (urls.length === 0) {
    setStatus("Add at least one URL to check.");
    return;
  }

  setLoading(true);
  setStatus(`Checking ${urls.length} links...`);

  try {
    const payload = {
      urls,
      timeoutMs: Number(timeoutInput.value),
      maxRedirects: Number(redirectInput.value),
      concurrency: Number(concurrencyInput.value),
      fetchTitle: titleToggle.checked,
    };

    const response = await fetch("/api/check", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });

    if (!response.ok) {
      throw new Error(`Request failed (${response.status})`);
    }

    const data = await response.json();
    results = Array.isArray(data.results) ? data.results : [];
    renderResults();
    updateSummary();
    exportButton.disabled = results.length === 0;

    const duration = data.durationMs ? formatDuration(data.durationMs) : "";
    setStatus(`Done. ${results.length} results ${duration ? `in ${duration}.` : ""}`);
  } catch (error) {
    setStatus(`Failed: ${error.message || "Unknown error"}`);
  } finally {
    setLoading(false);
  }
}

function parseUrls(text) {
  return text
    .split(/\n/)
    .map((line) => line.trim())
    .filter(Boolean);
}

function renderResults() {
  const filtered = applyFilters(results);

  resultsBody.innerHTML = "";

  if (filtered.length === 0) {
    const row = document.createElement("tr");
    row.className = "placeholder";
    row.innerHTML = "<td colspan=\"6\">No matching results.</td>";
    resultsBody.appendChild(row);
    return;
  }

  filtered.forEach((item, index) => {
    const row = document.createElement("tr");
    row.className = "fade-in";
    row.style.animationDelay = `${Math.min(index * 30, 240)}ms`;

    const statusClass = getStatusClass(item);
    const statusLabel = item.status !== null ? item.status : "ERR";
    const detail = item.error ? item.error : item.title || "-";
    const timeValue = formatDuration(item.durationMs);
    const finalUrl = item.finalUrl || "-";

    row.innerHTML = `
      <td>${index + 1}</td>
      <td>
        ${escapeHtml(item.inputUrl || "-")}
        <div class="url-meta">${escapeHtml(formatRedirects(item.redirects))}</div>
      </td>
      <td><span class="status-pill ${statusClass}">${escapeHtml(statusLabel)}</span></td>
      <td>${escapeHtml(finalUrl)}</td>
      <td>${escapeHtml(timeValue)}</td>
      <td>${escapeHtml(detail)}</td>
    `;

    resultsBody.appendChild(row);
  });
}

function updateSummary() {
  const total = results.length;
  const ok = results.filter((item) => isOk(item)).length;
  const redirects = results.filter((item) => isRedirect(item)).length;
  const errors = results.filter((item) => isError(item)).length;
  const avg = total ? Math.round(results.reduce((sum, item) => sum + (item.durationMs || 0), 0) / total) : 0;

  totalCount.textContent = total;
  okCount.textContent = ok;
  redirectCount.textContent = redirects;
  errorCount.textContent = errors;
  avgTime.textContent = total ? formatDuration(avg) : "-";
}

function applyFilters(items) {
  const query = searchInput.value.trim().toLowerCase();

  return items.filter((item) => {
    if (errorsOnly.checked && !isError(item)) {
      return false;
    }

    if (query) {
      const haystack = `${item.inputUrl || ""} ${item.finalUrl || ""} ${item.title || ""}`.toLowerCase();
      if (!haystack.includes(query)) {
        return false;
      }
    }

    return true;
  });
}

function isOk(item) {
  return !item.error && item.status >= 200 && item.status < 300;
}

function isRedirect(item) {
  return !item.error && item.status >= 300 && item.status < 400;
}

function isError(item) {
  return Boolean(item.error) || (item.status !== null && item.status >= 400);
}

function getStatusClass(item) {
  if (isOk(item)) {
    return "ok";
  }
  if (isRedirect(item)) {
    return "redirect";
  }
  return "error";
}

function formatDuration(value) {
  if (value === null || value === undefined) {
    return "-";
  }
  if (value < 1000) {
    return `${value} ms`;
  }
  return `${(value / 1000).toFixed(2)} s`;
}

function formatRedirects(list) {
  if (!Array.isArray(list) || list.length === 0) {
    return "No redirects";
  }
  if (list.length === 1) {
    return "Direct";
  }
  return `${list.length - 1} redirect${list.length - 1 === 1 ? "" : "s"}`;
}

function setStatus(message) {
  statusText.textContent = message;
}

function setLoading(isLoading) {
  runButton.disabled = isLoading;
  runButton.textContent = isLoading ? "Checking..." : "Check links";
}

function buildCsv(items) {
  const headers = [
    "input_url",
    "status",
    "final_url",
    "duration_ms",
    "title",
    "error",
    "redirects",
  ];

  const rows = items.map((item) => [
    item.inputUrl || "",
    item.status ?? "",
    item.finalUrl || "",
    item.durationMs ?? "",
    item.title || "",
    item.error || "",
    Array.isArray(item.redirects) ? item.redirects.join(" | ") : "",
  ]);

  return [headers, ...rows].map((row) => row.map(escapeCsv).join(",")).join("\n");
}

function escapeCsv(value) {
  const stringValue = String(value ?? "");
  if (/[",\n]/.test(stringValue)) {
    return `"${stringValue.replace(/"/g, '""')}"`;
  }
  return stringValue;
}

function escapeHtml(value) {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

renderResults();
updateSummary();
