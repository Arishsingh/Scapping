"use strict";

// ---- state ------------------------------------------------------------------

let leads = [];           // every lead streamed in this run
let selectedIndex = -1;   // index into `leads` of the row shown in the detail panel
let running = false;
let elapsedTimer = null;
let startTime = 0;

const DETAIL_FIELDS = [
  ["name", "Name"], ["category", "Category"], ["full_address", "Address"],
  ["city", "City"], ["state", "State"], ["postal_code", "Postal code"],
  ["phone", "Phone"], ["website", "Website"], ["email", "Email"],
  ["rating", "Rating"], ["reviews_count", "Reviews"], ["opening_hours", "Opening hours"],
  ["latitude", "Latitude"], ["longitude", "Longitude"], ["google_maps_url", "Google Maps"],
];

const $ = (id) => document.getElementById(id);

// Apify plan caps runs; keep result requests bounded to protect usage/cost.
// Blank/non-numeric falls back to the default; 0/negative clamps up to the min.
const MAX_RESULTS = 100000;
const clampMax = (n) => {
  const v = parseInt(n, 10);
  return Number.isNaN(v) ? 100 : Math.min(MAX_RESULTS, Math.max(1, v));
};

// ---- filtering + rendering --------------------------------------------------

function visibleLeads() {
  const noWebsite = $("noWebsite").checked;
  const hasEmail = $("hasEmail").checked;
  const q = $("search").value.trim().toLowerCase();
  return leads.filter((l) => {
    if (noWebsite && (l.website || "").trim()) return false;
    if (hasEmail && !(l.email || "").trim()) return false;
    if (q) {
      const hay = `${l.name} ${l.category} ${l.city} ${l.full_address}`.toLowerCase();
      if (!hay.includes(q)) return false;
    }
    return true;
  });
}

function renderTable() {
  const rows = visibleLeads();
  const body = $("leadsBody");
  body.innerHTML = "";
  for (const l of rows) {
    const idx = leads.indexOf(l);
    const tr = document.createElement("tr");
    if (idx === selectedIndex) tr.classList.add("selected");
    tr.addEventListener("click", () => selectLead(idx));

    const website = (l.website || "").trim()
      ? `<a href="${escapeAttr(l.website)}" target="_blank">${escapeHtml(shorten(l.website))}</a>`
      : `<span class="badge-no">— none —</span>`;

    tr.innerHTML = `
      <td title="${escapeAttr(l.name)}">${escapeHtml(l.name)}</td>
      <td title="${escapeAttr(l.category)}">${escapeHtml(l.category)}</td>
      <td>${escapeHtml(l.city)}</td>
      <td>${escapeHtml(l.phone)}</td>
      <td>${website}</td>
      <td>${escapeHtml(l.email)}</td>
      <td>${escapeHtml(String(l.rating ?? ""))}</td>`;
    body.appendChild(tr);
  }
  updateEmptyState(rows.length);
  $("showing").textContent = `${rows.length} shown / ${leads.length} total`;
}

// Explain WHY the table is empty — either nothing scraped yet, or filters hid
// everything. A blank table with no message reads as "broken".
function updateEmptyState(shownCount) {
  const el = $("emptyState");
  if (leads.length === 0) {
    el.style.display = "block";
    el.textContent = running
      ? "Scraping… waiting for the first lead."
      : "No leads yet. Enter a location and press Start.";
    return;
  }
  if (shownCount === 0) {
    el.style.display = "block";
    const withSite = leads.filter((l) => (l.website || "").trim()).length;
    const q = $("search").value.trim();
    const reasons = [];
    if ($("noWebsite").checked) {
      reasons.push(
        withSite === leads.length
          ? `all ${leads.length} results have a website, so “No website only” hides them all`
          : `“No website only” is on`
      );
    }
    if ($("hasEmail").checked) reasons.push(`“Has email only” is on`);
    if (q) reasons.push(`the search box (“${q}”) is filtering — clear it to widen results`);
    const why = reasons.length ? ` — ${reasons.join("; ")}.` : ".";
    el.textContent = `${leads.length} found, but 0 match the current filters${why}`;
    return;
  }
  el.style.display = "none";
}

function selectLead(idx) {
  selectedIndex = idx;
  const l = leads[idx];
  $("detailName").textContent = l.name || "Details";
  const dl = $("detailBody");
  dl.innerHTML = "";
  for (const [key, label] of DETAIL_FIELDS) {
    const val = l[key];
    const dt = document.createElement("dt");
    dt.textContent = label;
    const dd = document.createElement("dd");
    if (key === "website" && (val || "").trim()) {
      dd.innerHTML = `<a href="${escapeAttr(val)}" target="_blank">${escapeHtml(val)}</a>`;
    } else if (key === "google_maps_url" && (val || "").trim()) {
      dd.innerHTML = `<a href="${escapeAttr(val)}" target="_blank">open in Maps ↗</a>`;
    } else if (key === "email" && (val || "").trim()) {
      dd.innerHTML = `<a href="mailto:${escapeAttr(val)}">${escapeHtml(val)}</a>`;
    } else {
      dd.textContent = (val === "" || val === null || val === undefined) ? "—" : String(val);
    }
    dl.appendChild(dt);
    dl.appendChild(dd);
  }
  $("detail").classList.remove("hidden");
  renderTable();
}

// ---- scrape lifecycle -------------------------------------------------------

function setRunning(on) {
  running = on;
  $("startBtn").disabled = on;
  $("stopBtn").disabled = !on;
  $("location").disabled = on;
  $("category").disabled = on;
  $("maxResults").disabled = on;
  $("source").disabled = on;
}

function tickElapsed() {
  const secs = (Date.now() - startTime) / 1000;
  $("elapsedChip").textContent = `${secs.toFixed(1)}s`;
}

async function start() {
  const location = $("location").value.trim();
  if (!location) { $("location").focus(); return; }

  // reset state
  leads = [];
  selectedIndex = -1;
  $("detail").classList.add("hidden");
  renderTable();
  $("foundChip").textContent = "found: 0";
  $("statusMsg").textContent = "";
  setChip($("stateChip"), "starting…", "active");

  setRunning(true);
  startTime = Date.now();
  clearInterval(elapsedTimer);
  elapsedTimer = setInterval(tickElapsed, 100);

  // Clamp to [1, 100000] and reflect the corrected value back into the field.
  const maxResults = clampMax($("maxResults").value);
  $("maxResults").value = maxResults;

  const cat = $("category").value.trim();
  const scrapeFilters = [$("noWebsite").checked ? "no-website" : "", $("hasEmail").checked ? "has-email" : ""].filter(Boolean);
  logLine(`▶ start — "${cat || "all"} in ${location}" · source=${$("source").value} · max=${maxResults}${scrapeFilters.length ? " · filter: " + scrapeFilters.join(", ") : ""}`, "system");

  const res = await window.api.startScrape({
    location,
    category: $("category").value.trim(),
    maxResults,
    source: $("source").value,
    // The filter toggles, snapshotted at Start, also pre-filter the scrape + CSV.
    onlyNoWebsite: $("noWebsite").checked,
    onlyWithEmail: $("hasEmail").checked,
  });
  if (!res.ok) {
    setChip($("stateChip"), "error", "err");
    $("statusMsg").textContent = res.error || "failed to start";
    finish();
  }
}

function finish() {
  setRunning(false);
  clearInterval(elapsedTimer);
  tickElapsed();
  refreshRuns();
}

function handleEvent(evt) {
  switch (evt.type) {
    case "status":
      $("sourceChip").textContent = `source: ${evt.source || "—"}`;
      setChip($("stateChip"), evt.state, evt.state === "fallback" ? "err" : "active");
      if (evt.message) $("statusMsg").textContent = evt.message;
      logLine(`[${evt.source || "-"}] ${evt.state}${evt.message ? ": " + evt.message : ""}`,
        evt.state === "fallback" ? "fallback" : evt.state === "error" ? "error" : "status");
      break;
    case "progress":
      $("foundChip").textContent = `found: ${evt.found}`;
      break;
    case "lead":
      leads.push(evt.data);
      renderTable();
      logLine(`＋ ${evt.data.name || "(no name)"}  ·  ${(evt.data.website || "").trim() || "no website"}${evt.data.phone ? "  ·  " + evt.data.phone : ""}`, "lead");
      break;
    case "done":
      setChip($("stateChip"), `done (${evt.total})`, "done");
      $("statusMsg").textContent = evt.csv_path ? `saved → ${evt.csv_path}` : "";
      logLine(`✓ done — ${evt.total} lead${evt.total === 1 ? "" : "s"}${evt.csv_path ? " → " + evt.csv_path : ""}`, "done");
      break;
    case "error":
      setChip($("stateChip"), "error", "err");
      $("statusMsg").textContent = evt.message || "error";
      logLine(`✗ ${evt.message || "error"}`, "error");
      break;
    case "exit":
      logLine(`● process exited (code ${evt.code})`, "system");
      finish();
      break;
  }
}

// ---- past runs --------------------------------------------------------------

async function refreshRuns() {
  const runs = await window.api.listRuns();
  const ul = $("runsList");
  ul.innerHTML = "";
  if (!runs.length) {
    ul.innerHTML = `<li class="rmeta">No CSVs in output/ yet.</li>`;
    return;
  }
  for (const r of runs) {
    const li = document.createElement("li");
    const kb = (r.size / 1024).toFixed(1);
    li.innerHTML = `<span class="rname" title="${escapeAttr(r.name)}">${escapeHtml(r.name)}</span>
      <span class="rmeta">${kb} KB</span>`;
    const open = document.createElement("button");
    open.className = "ghost";
    open.textContent = "Open";
    open.addEventListener("click", () => window.api.openRun(r.path));
    li.appendChild(open);
    ul.appendChild(li);
  }
}

// ---- settings ---------------------------------------------------------------

async function openSettings() {
  const s = await window.api.getSettings();
  $("tokenState").textContent = s.hasToken ? "✓ a token is currently saved" : "⚠ no token saved — scraper will use the browser fallback";
  $("tokenState").style.color = s.hasToken ? "var(--accent)" : "var(--danger)";
  $("apifyToken").value = "";
  $("pythonPath").value = s.pythonPath || "";
  const ps = $("pythonState");
  ps.textContent = `Using: ${s.resolvedPython}${s.autoVenv && !s.pythonPath ? " (auto-detected project venv)" : ""}`;
  ps.style.color = s.autoVenv || s.pythonPath ? "var(--accent)" : "var(--muted)";
  $("settingsModal").classList.remove("hidden");
}

async function saveSettings() {
  await window.api.saveSettings({
    apifyToken: $("apifyToken").value,
    pythonPath: $("pythonPath").value,
  });
  $("settingsModal").classList.add("hidden");
}

// ---- helpers ----------------------------------------------------------------

function setChip(el, text, cls) {
  el.textContent = text;
  el.className = "chip" + (cls ? " " + cls : "");
}
function shorten(u) { return u.replace(/^https?:\/\/(www\.)?/, "").slice(0, 30); }
function escapeHtml(s) {
  return String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}
function escapeAttr(s) { return escapeHtml(s); }

// ---- live logs --------------------------------------------------------------

const MAX_LOG_LINES = 800;

function logLine(text, level) {
  const body = $("logBody");
  const ph = body.querySelector(".logempty");
  if (ph) ph.remove();
  const div = document.createElement("div");
  div.className = "logline ev-" + (level || "status");
  const ts = document.createElement("span");
  ts.className = "ts";
  ts.textContent = new Date().toLocaleTimeString();
  div.appendChild(ts);
  div.appendChild(document.createTextNode(text));
  body.appendChild(div);
  while (body.children.length > MAX_LOG_LINES) body.removeChild(body.firstChild);
  if ($("autoscroll").checked) body.scrollTop = body.scrollHeight;
  $("logCount").textContent = `${body.children.length} lines`;
}

function clearLogs() {
  $("logBody").innerHTML = '<div class="logempty">No logs yet — press Start.</div>';
  $("logCount").textContent = "";
}

// ---- wiring -----------------------------------------------------------------

$("startBtn").addEventListener("click", start);
$("stopBtn").addEventListener("click", () => {
  // Immediate feedback; the UI fully resets when the process exits.
  $("stopBtn").disabled = true;
  setChip($("stateChip"), "stopping…", "active");
  logLine("■ stop requested", "system");
  window.api.stopScrape();
});
$("maxResults").addEventListener("change", (e) => { e.target.value = clampMax(e.target.value); });
$("noWebsite").addEventListener("change", renderTable);
$("hasEmail").addEventListener("change", renderTable);
$("search").addEventListener("input", renderTable);
$("detailClose").addEventListener("click", () => { $("detail").classList.add("hidden"); selectedIndex = -1; renderTable(); });
$("refreshRuns").addEventListener("click", refreshRuns);
$("revealOutput").addEventListener("click", () => window.api.revealOutput());
$("exportBtn").addEventListener("click", async () => {
  const rows = visibleLeads();
  if (!rows.length) { $("statusMsg").textContent = "nothing to export in the current view"; return; }
  const res = await window.api.exportFiltered(rows);
  if (res.ok) $("statusMsg").textContent = `exported ${res.count} rows → ${res.path}`;
});

$("settingsBtn").addEventListener("click", openSettings);
$("settingsCancel").addEventListener("click", () => $("settingsModal").classList.add("hidden"));
$("settingsSave").addEventListener("click", saveSettings);

$("clearLogs").addEventListener("click", clearLogs);
$("toggleLogs").addEventListener("click", () => {
  const hidden = $("logBody").classList.toggle("hidden");
  $("toggleLogs").textContent = hidden ? "Show" : "Hide";
});

window.api.onEvent(handleEvent);
clearLogs();
refreshRuns();
renderTable();
