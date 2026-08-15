// Heimdall Systems — Roadmap Tracker app logic.
// Reads ROADMAP_DATA / ROADMAP_GENERATED_AT from data.js (regenerated via build_data.py).
(function () {
  "use strict";

  var TODAY = new Date();
  TODAY.setHours(0, 0, 0, 0);

  var STATUS_ORDER = ["Not Started", "Verify - status unclear", "Done"];
  var STATUS_META = {
    "Not Started": { cls: "status-not-started", dotVar: "--text-muted", label: "Not Started" },
    "Verify - status unclear": { cls: "status-verify", dotVar: "--status-warning", label: "Verify — status unclear" },
    "Done": { cls: "status-done", dotVar: "--status-good", label: "Done" }
  };

  var DATA = (window.ROADMAP_DATA || []).slice();

  // ---- status overrides (local-only edits layered on top of the generated data.js) ----
  var OVERRIDES_KEY = "heimdall-status-overrides";
  var STATE_FILE_NAME = "heimdall-state.json";

  function loadOverrides() {
    var store = safeStorage();
    if (!store) return {};
    try {
      return JSON.parse(store.getItem(OVERRIDES_KEY) || "{}") || {};
    } catch (e) {
      return {};
    }
  }
  function saveOverrides(overrides) {
    var store = safeStorage();
    if (store) store.setItem(OVERRIDES_KEY, JSON.stringify(overrides));
  }

  function applyOverridesToData(overrides) {
    DATA.forEach(function (r) {
      var o = overrides[r.id];
      if (o && STATUS_ORDER.indexOf(o) !== -1) r.status = o;
    });
  }
  applyOverridesToData(loadOverrides());

  // On startup, heimdall-state.json (saved next to index.html, served by the local
  // server) is the source of truth if present — it wins over whatever's cached in
  // localStorage, since the file is the thing meant to travel with the app.
  function syncFromStateFile() {
    return fetch(STATE_FILE_NAME, { cache: "no-store" })
      .then(function (res) { return res.ok ? res.json() : null; })
      .catch(function () { return null; })
      .then(function (parsed) {
        var overrides = parsed && parsed.overrides;
        if (overrides && typeof overrides === "object") {
          saveOverrides(overrides);
          applyOverridesToData(overrides);
        }
      });
  }

  function setStatus(id, newStatus) {
    var rec = DATA.find(function (r) { return r.id === id; });
    if (!rec || STATUS_ORDER.indexOf(newStatus) === -1 || rec.status === newStatus) return;
    rec.status = newStatus;
    var overrides = loadOverrides();
    overrides[id] = newStatus;
    saveOverrides(overrides);
    updateLocalEditsUI();
    renderAll();
  }

  function updateLocalEditsUI() {
    var overrides = loadOverrides();
    var n = Object.keys(overrides).length;
    var badge = document.getElementById("localEditsBadge");
    var exportBtn = document.getElementById("exportEditsBtn");
    var resetBtn = document.getElementById("resetEditsBtn");
    var saveBtn = document.getElementById("saveStateBtn");
    if (!badge) return;
    badge.hidden = n === 0;
    badge.textContent = n + (n === 1 ? " local edit" : " local edits");
    exportBtn.hidden = n === 0;
    resetBtn.hidden = n === 0;
    saveBtn.hidden = n === 0;
  }

  function csvField(v) {
    v = String(v == null ? "" : v);
    return /[",\n]/.test(v) ? '"' + v.replace(/"/g, '""') + '"' : v;
  }

  function exportOverrides() {
    var overrides = loadOverrides();
    var ids = Object.keys(overrides);
    if (!ids.length) return;
    var rows = ["ID,Task,New Status"];
    ids.forEach(function (id) {
      var rec = DATA.find(function (r) { return r.id === id; });
      rows.push([csvField(id), csvField(rec ? rec.task : ""), csvField(overrides[id])].join(","));
    });
    var blob = new Blob([rows.join("\n")], { type: "text/csv" });
    var url = URL.createObjectURL(blob);
    var a = document.createElement("a");
    a.href = url;
    a.download = "heimdall-status-updates.csv";
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  }

  // ---- File System Access: remembers the on-disk handle for heimdall-state.json so
  // repeat saves write straight back to the same file (in the app folder) without
  // re-prompting. Falls back to a normal download in browsers that lack the API. ----
  var FSA_SUPPORTED = typeof window.showSaveFilePicker === "function";
  var IDB_NAME = "heimdall-fs";
  var IDB_STORE = "handles";
  var IDB_KEY = "stateFile";

  function idbOpen() {
    return new Promise(function (resolve, reject) {
      var req = indexedDB.open(IDB_NAME, 1);
      req.onupgradeneeded = function () { req.result.createObjectStore(IDB_STORE); };
      req.onsuccess = function () { resolve(req.result); };
      req.onerror = function () { reject(req.error); };
    });
  }
  function idbGetHandle() {
    return idbOpen().then(function (db) {
      return new Promise(function (resolve) {
        var req = db.transaction(IDB_STORE, "readonly").objectStore(IDB_STORE).get(IDB_KEY);
        req.onsuccess = function () { resolve(req.result || null); };
        req.onerror = function () { resolve(null); };
      });
    }).catch(function () { return null; });
  }
  function idbSetHandle(handle) {
    return idbOpen().then(function (db) {
      return new Promise(function (resolve) {
        var tx = db.transaction(IDB_STORE, "readwrite");
        tx.objectStore(IDB_STORE).put(handle, IDB_KEY);
        tx.oncomplete = function () { resolve(); };
        tx.onerror = function () { resolve(); };
      });
    }).catch(function () {});
  }

  function verifyPermission(handle, requestIfNeeded) {
    var opts = { mode: "readwrite" };
    return handle.queryPermission(opts).then(function (status) {
      if (status === "granted") return true;
      if (!requestIfNeeded) return false;
      return handle.requestPermission(opts).then(function (status2) { return status2 === "granted"; });
    });
  }

  // Reuses the remembered handle (re-confirming permission) or, the first time,
  // prompts the user to pick/create heimdall-state.json — point it at this app's
  // own folder so future auto-loads (via syncFromStateFile) pick it up.
  function getWritableHandle() {
    if (!FSA_SUPPORTED) return Promise.resolve(null);
    return idbGetHandle().then(function (handle) {
      if (handle) return verifyPermission(handle, true).then(function (ok) { return ok ? handle : null; });
      return window.showSaveFilePicker({
        suggestedName: STATE_FILE_NAME,
        types: [{ description: "Heimdall state file", accept: { "application/json": [".json"] } }]
      }).then(function (newHandle) {
        return idbSetHandle(newHandle).then(function () { return newHandle; });
      });
    });
  }

  function downloadState(json) {
    var blob = new Blob([json], { type: "application/json" });
    var url = URL.createObjectURL(blob);
    var a = document.createElement("a");
    a.href = url;
    a.download = STATE_FILE_NAME;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  }

  function saveState() {
    var overrides = loadOverrides();
    if (!Object.keys(overrides).length) return;
    var json = JSON.stringify({ savedAt: new Date().toISOString(), overrides: overrides }, null, 2);

    if (!FSA_SUPPORTED) {
      downloadState(json);
      return;
    }
    getWritableHandle()
      .then(function (handle) {
        if (!handle) return downloadState(json);
        return handle.createWritable().then(function (writable) {
          return writable.write(json).then(function () { return writable.close(); });
        });
      })
      .catch(function (err) {
        if (err && err.name === "AbortError") return; // user cancelled the file picker
        downloadState(json);
      });
  }

  function loadState(file) {
    if (!file) return;
    var reader = new FileReader();
    reader.onload = function () {
      var parsed;
      try {
        parsed = JSON.parse(reader.result);
      } catch (e) {
        window.alert("That file isn't valid JSON.");
        return;
      }
      var overrides = parsed && parsed.overrides;
      if (!overrides || typeof overrides !== "object") {
        window.alert("That file doesn't look like a Heimdall state file.");
        return;
      }
      saveOverrides(overrides);
      applyOverridesToData(overrides);
      updateLocalEditsUI();
      renderAll();
    };
    reader.readAsText(file);
  }

  function resetOverrides() {
    var store = safeStorage();
    if (store && window.confirm("Discard all local status changes and revert to the spreadsheet data?")) {
      store.removeItem(OVERRIDES_KEY);
      window.location.reload();
    }
  }

  // ---- derive fixed-order phase list + categorical color assignment ----
  var PHASES = [];
  DATA.forEach(function (r) {
    if (r.phase && PHASES.indexOf(r.phase) === -1) PHASES.push(r.phase);
  });
  var phaseVar = {};
  PHASES.forEach(function (p, i) {
    phaseVar[p] = "--phase-" + ((i % 8) + 1);
  });

  function phaseColor(phase) {
    return "var(" + (phaseVar[phase] || "--phase-1") + ")";
  }

  function phaseShortLabel(phase) {
    if (!phase) return "";
    return phase.replace(/^Phase (\d+) - /, "P$1 · ").replace("Ongoing/Parallel", "Ongoing");
  }

  // ---- state ----
  var state = {
    search: "",
    activePhases: new Set(),
    groupBy: "status",
    sortKey: "id",
    sortDir: "asc"
  };

  // ---- date helpers ----
  function parseDate(s) {
    if (!s) return null;
    var d = new Date(s + "T00:00:00");
    return isNaN(d.getTime()) ? null : d;
  }
  function fmtDate(s) {
    var d = parseDate(s);
    if (!d) return "TBD";
    return d.toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" });
  }
  function fmtDateShort(d) {
    return d.toLocaleDateString("en-GB", { day: "numeric", month: "short" });
  }
  function daysBetween(a, b) {
    return Math.round((b.getTime() - a.getTime()) / 86400000);
  }

  function statusMeta(status) {
    return STATUS_META[status] || { cls: "status-not-started", dotVar: "--text-muted", label: status || "Unknown" };
  }

  // ==================== FILTERING ====================

  function matchesSearch(rec, q) {
    if (!q) return true;
    q = q.toLowerCase();
    return (
      (rec.id || "").toLowerCase().indexOf(q) !== -1 ||
      (rec.task || "").toLowerCase().indexOf(q) !== -1 ||
      (rec.notes || "").toLowerCase().indexOf(q) !== -1 ||
      (rec.phase || "").toLowerCase().indexOf(q) !== -1 ||
      (rec.status || "").toLowerCase().indexOf(q) !== -1
    );
  }

  function getFiltered() {
    return DATA.filter(function (rec) {
      if (state.activePhases.size > 0 && !state.activePhases.has(rec.phase)) return false;
      if (!matchesSearch(rec, state.search)) return false;
      return true;
    });
  }

  // ==================== STATS BAR ====================

  function renderStats() {
    var el = document.getElementById("statsBar");
    var total = DATA.length;
    var done = DATA.filter(function (r) { return r.status === "Done"; }).length;
    var milestones = DATA.filter(function (r) { return r.milestone; });
    var milestonesDone = milestones.filter(function (r) { return r.status === "Done"; }).length;

    var nextMilestone = milestones
      .filter(function (r) { return r.status !== "Done" && parseDate(r.end); })
      .sort(function (a, b) { return parseDate(a.end) - parseDate(b.end); })[0];

    var upNext = DATA
      .filter(function (r) { return !r.milestone && r.status === "Not Started" && parseDate(r.start); })
      .sort(function (a, b) { return parseDate(a.start) - parseDate(b.start); })[0];

    var pct = total ? Math.round((done / total) * 100) : 0;

    var tiles = [];

    tiles.push(
      '<div class="stat-tile"><div class="stat-tile-label">Total Tasks</div>' +
      '<div class="stat-tile-value">' + total + "</div>" +
      '<div class="stat-tile-sub">' + milestones.length + " milestones</div></div>"
    );

    tiles.push(
      '<div class="stat-tile"><div class="stat-tile-label">Completed</div>' +
      '<div class="stat-tile-value is-good">' + done + "/" + total + "</div>" +
      '<div class="stat-tile-bar"><div class="stat-tile-bar-fill" style="width:' + pct + '%"></div></div></div>'
    );

    tiles.push(
      '<div class="stat-tile"><div class="stat-tile-label">Milestones Hit</div>' +
      '<div class="stat-tile-value">' + milestonesDone + "/" + milestones.length + "</div>" +
      '<div class="stat-tile-sub">key gates on the plan</div></div>'
    );

    if (nextMilestone) {
      var nd = parseDate(nextMilestone.end);
      var dleft = daysBetween(TODAY, nd);
      var label = nextMilestone.task.replace(/^MILESTONE( \([^)]+\))?:\s*/i, "");
      tiles.push(
        '<div class="stat-tile"><div class="stat-tile-label">Next Milestone</div>' +
        '<div class="stat-tile-value' + (dleft < 0 ? " is-warning" : "") + '">' + (dleft >= 0 ? dleft + "d" : "overdue") + "</div>" +
        '<div class="stat-tile-sub" title="' + escapeAttr(label) + '">' + escapeHtml(label) + " · " + fmtDate(nextMilestone.end) + "</div></div>"
      );
    }

    if (upNext) {
      tiles.push(
        '<div class="stat-tile"><div class="stat-tile-label">Up Next</div>' +
        '<div class="stat-tile-value" style="font-size:15px;line-height:1.3" title="' + escapeAttr(upNext.task) + '">' + escapeHtml(truncate(upNext.task, 34)) + "</div>" +
        '<div class="stat-tile-sub">' + upNext.id + " · from " + fmtDate(upNext.start) + "</div></div>"
      );
    }

    el.innerHTML = tiles.join("");
  }

  function truncate(s, n) {
    return s.length > n ? s.slice(0, n - 1) + "…" : s;
  }

  // ==================== ESCAPING ====================

  function escapeHtml(s) {
    return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
    });
  }
  function escapeAttr(s) { return escapeHtml(s); }

  // ==================== BOARD (KANBAN) ====================

  function statusSelectHtml(status, id) {
    var m = statusMeta(status);
    var opts = STATUS_ORDER.map(function (s) {
      return '<option value="' + escapeAttr(s) + '"' + (s === status ? " selected" : "") + '>' + escapeHtml(statusMeta(s).label) + "</option>";
    }).join("");
    return '<select class="status-select ' + m.cls + '" data-id="' + escapeAttr(id) + '" aria-label="Change status">' + opts + "</select>";
  }

  function wireStatusSelects(root) {
    root.querySelectorAll(".status-select").forEach(function (sel) {
      sel.addEventListener("click", function (e) { e.stopPropagation(); });
      sel.addEventListener("mousedown", function (e) { e.stopPropagation(); });
      sel.addEventListener("change", function () {
        setStatus(sel.getAttribute("data-id"), sel.value);
      });
    });
  }

  function renderBoard() {
    var panel = document.getElementById("panel-board");
    var data = getFiltered();
    if (!data.length) {
      panel.innerHTML = '<div class="empty-state">No tasks match your filters.</div>';
      return;
    }

    var columns; // [{key, title, colorVar}]
    if (state.groupBy === "status") {
      columns = STATUS_ORDER.map(function (s) {
        return { key: s, title: statusMeta(s).label, dotVar: statusMeta(s).dotVar };
      });
    } else {
      columns = PHASES.map(function (p) {
        return { key: p, title: phaseShortLabel(p), dotVar: phaseVar[p] };
      });
    }

    var byCol = {};
    columns.forEach(function (c) { byCol[c.key] = []; });
    data.forEach(function (rec) {
      var key = state.groupBy === "status" ? rec.status : rec.phase;
      if (!byCol[key]) byCol[key] = [];
      byCol[key].push(rec);
    });

    Object.keys(byCol).forEach(function (k) {
      byCol[k].sort(function (a, b) {
        var da = parseDate(a.start) || parseDate(a.end);
        var db = parseDate(b.start) || parseDate(b.end);
        if (da && db) return da - db;
        if (da) return -1;
        if (db) return 1;
        return a.id.localeCompare(b.id);
      });
    });

    var isStatusGrouped = state.groupBy === "status";
    var html = '<div class="board">';
    columns.forEach(function (col) {
      var items = byCol[col.key] || [];
      html += '<div class="board-col" data-col-key="' + escapeAttr(col.key) + '">';
      html += '<div class="board-col-head"><span class="board-col-title">' +
        '<span class="board-col-status-dot" style="background:var(' + col.dotVar + ')"></span>' +
        escapeHtml(col.title) + '</span><span class="board-col-count">' + items.length + "</span></div>";
      html += '<div class="card-stack" data-dropzone="' + (isStatusGrouped ? "1" : "0") + '">';
      if (!items.length) {
        html += '<div class="board-empty">' + (isStatusGrouped ? "Drop a card here" : "No tasks") + "</div>";
      } else {
        items.forEach(function (rec) { html += cardHtml(rec, state.groupBy); });
      }
      html += "</div></div>";
    });
    html += "</div>";
    panel.innerHTML = html;

    panel.querySelectorAll(".task-card").forEach(function (card) {
      card.addEventListener("click", function () { openModal(card.getAttribute("data-id")); });
      card.addEventListener("dragstart", function (e) {
        card.classList.add("is-dragging");
        e.dataTransfer.effectAllowed = "move";
        e.dataTransfer.setData("text/plain", card.getAttribute("data-id"));
      });
      card.addEventListener("dragend", function () { card.classList.remove("is-dragging"); });
    });

    wireStatusSelects(panel);

    if (isStatusGrouped) {
      panel.querySelectorAll('.card-stack[data-dropzone="1"]').forEach(function (zone) {
        zone.addEventListener("dragover", function (e) {
          e.preventDefault();
          e.dataTransfer.dropEffect = "move";
          zone.classList.add("is-drop-target");
        });
        zone.addEventListener("dragleave", function () { zone.classList.remove("is-drop-target"); });
        zone.addEventListener("drop", function (e) {
          e.preventDefault();
          zone.classList.remove("is-drop-target");
          var id = e.dataTransfer.getData("text/plain");
          var newStatus = zone.closest(".board-col").getAttribute("data-col-key");
          setStatus(id, newStatus);
        });
      });
    }
  }

  function cardHtml(rec, groupBy) {
    var dateStr = rec.start ? fmtDate(rec.start) + " → " + fmtDate(rec.end) : (rec.end ? fmtDate(rec.end) : "TBD");
    var bottom = groupBy === "status"
      ? '<span class="phase-tag" style="--tag-color:' + phaseColor(rec.phase) + '" title="' + escapeAttr(rec.phase) + '">' + escapeHtml(phaseShortLabel(rec.phase)) + "</span>"
      : statusSelectHtml(rec.status, rec.id);
    return (
      '<div class="task-card" draggable="true" data-id="' + escapeAttr(rec.id) + '">' +
      '<div class="task-card-top"><span class="task-card-id">' + escapeHtml(rec.id) + "</span>" +
      (rec.milestone ? '<span class="milestone-badge">★ MILESTONE</span>' : "") +
      "</div>" +
      '<div class="task-card-title">' + escapeHtml(rec.task) + "</div>" +
      '<div class="task-card-bottom">' + bottom + '<span class="task-card-dates">' + dateStr + "</span></div>" +
      "</div>"
    );
  }

  // ==================== GANTT ====================

  var PX_PER_DAY = 16;

  function renderGantt() {
    var panel = document.getElementById("panel-gantt");
    var data = getFiltered();

    var scheduled = data.filter(function (r) { return parseDate(r.start) || parseDate(r.end); });
    var unscheduled = data.filter(function (r) { return !parseDate(r.start) && !parseDate(r.end); });

    if (!scheduled.length) {
      panel.innerHTML = '<div class="empty-state">No dated tasks match your filters.</div>';
      return;
    }

    var minDate = null, maxDate = null;
    scheduled.forEach(function (r) {
      var s = parseDate(r.start) || parseDate(r.end);
      var e = parseDate(r.end) || parseDate(r.start);
      if (!minDate || s < minDate) minDate = s;
      if (!maxDate || e > maxDate) maxDate = e;
    });
    // pad a few days either side
    minDate = new Date(minDate); minDate.setDate(minDate.getDate() - 3);
    maxDate = new Date(maxDate); maxDate.setDate(maxDate.getDate() + 5);

    var totalDays = daysBetween(minDate, maxDate);
    var timelineWidth = totalDays * PX_PER_DAY;

    function xFor(d) { return daysBetween(minDate, d) * PX_PER_DAY; }

    // month ticks
    var ticks = "";
    var cursor = new Date(minDate.getFullYear(), minDate.getMonth(), 1);
    if (cursor < minDate) cursor.setMonth(cursor.getMonth() + 1);
    while (cursor <= maxDate) {
      var left = xFor(cursor);
      ticks += '<div class="gantt-month-tick" style="left:' + left + 'px">' +
        cursor.toLocaleDateString("en-GB", { month: "short", year: "2-digit" }) + "</div>";
      cursor.setMonth(cursor.getMonth() + 1);
    }

    // group scheduled tasks by phase, preserving PHASES order
    var byPhase = {};
    scheduled.forEach(function (r) {
      (byPhase[r.phase] = byPhase[r.phase] || []).push(r);
    });
    Object.keys(byPhase).forEach(function (p) {
      byPhase[p].sort(function (a, b) {
        var da = parseDate(a.start) || parseDate(a.end);
        var db = parseDate(b.start) || parseDate(b.end);
        return da - db;
      });
    });

    var rowsHtml = "";
    PHASES.forEach(function (phase) {
      var items = byPhase[phase];
      if (!items || !items.length) return;
      rowsHtml += '<div class="gantt-phase-group-label" style="--phase-color:' + phaseColor(phase) + '">' +
        escapeHtml(phase) + "</div>";
      items.forEach(function (rec) {
        var s = parseDate(rec.start) || parseDate(rec.end);
        var e = parseDate(rec.end) || parseDate(rec.start);
        var isZero = daysBetween(s, e) <= 0;
        var left = xFor(s);
        var color = phaseColor(rec.phase);
        var barHtml;
        if (isZero) {
          barHtml = '<div class="gantt-bar-zero' + (rec.milestone ? "" : "") + '" data-id="' + escapeAttr(rec.id) +
            '" style="left:' + left + "px;--bar-color:" + color + '"></div>';
        } else {
          var width = Math.max(6, (daysBetween(s, e)) * PX_PER_DAY);
          barHtml = '<div class="gantt-bar' + (rec.status === "Done" ? " is-done" : "") + '" data-id="' + escapeAttr(rec.id) +
            '" style="left:' + left + "px;width:" + width + "px;--bar-color:" + color + '"></div>';
        }
        rowsHtml += '<div class="gantt-row">' +
          '<div class="gantt-row-label" title="' + escapeAttr(rec.task) + '"><span class="id">' + escapeHtml(rec.id) +
          (rec.milestone ? " ★" : "") + '</span><span class="name">' + escapeHtml(rec.task) + "</span></div>" +
          '<div class="gantt-row-track" style="width:' + timelineWidth + 'px">' + barHtml + "</div>" +
          "</div>";
      });
    });

    var todayLeft = xFor(TODAY);
    var todayMarker = "";
    if (todayLeft >= 0 && todayLeft <= timelineWidth) {
      todayMarker = '<div class="gantt-today-line" style="left:' + todayLeft + 'px">' +
        '<div class="gantt-today-label">Today</div></div>';
    }

    var legend = '<div class="gantt-legend">';
    PHASES.forEach(function (p) {
      if (!byPhase[p]) return;
      legend += '<span class="gantt-legend-item"><span class="gantt-legend-swatch" style="--sw-color:' + phaseColor(p) + '"></span>' +
        escapeHtml(phaseShortLabel(p)) + "</span>";
    });
    legend += '<span class="gantt-legend-item"><span style="display:inline-block;width:12px;border-top:2px dashed var(--status-critical)"></span> Today</span>';
    legend += "</div>";

    var tbdNote = unscheduled.length
      ? '<div class="gantt-tbd-note">Not shown (dates TBD): ' +
        unscheduled.map(function (r) { return escapeHtml(r.id) + " – " + escapeHtml(r.task); }).join("; ") +
        "</div>"
      : "";

    panel.innerHTML =
      '<div class="gantt-wrap"><div class="gantt-scroll"><div class="gantt-grid" style="min-width:' + (250 + timelineWidth) + 'px">' +
      '<div class="gantt-header-row" style="min-width:' + (250 + timelineWidth) + 'px">' +
      '<div class="gantt-header-label">Task</div>' +
      '<div class="gantt-timescale" style="width:' + timelineWidth + 'px;position:relative">' + ticks + "</div>" +
      "</div>" +
      '<div style="position:relative;grid-column:1/-1">' + todayMarker + rowsHtml + "</div>" +
      "</div></div>" + legend + tbdNote + "</div>";

    // hover tooltips + click-through to modal
    panel.querySelectorAll(".gantt-bar, .gantt-bar-zero").forEach(function (bar) {
      var id = bar.getAttribute("data-id");
      bar.addEventListener("mouseenter", function (e) { showTooltip(e, id); });
      bar.addEventListener("mousemove", moveTooltip);
      bar.addEventListener("mouseleave", hideTooltip);
      bar.addEventListener("click", function () { openModal(id); });
    });
  }

  function showTooltip(e, id) {
    var rec = DATA.find(function (r) { return r.id === id; });
    if (!rec) return;
    var tip = document.getElementById("tooltip");
    var dateStr = rec.start ? fmtDate(rec.start) + " → " + fmtDate(rec.end) : fmtDate(rec.end);
    tip.innerHTML =
      '<div class="viz-tooltip-title">' + escapeHtml(rec.id) + " — " + escapeHtml(rec.task) + "</div>" +
      '<div class="viz-tooltip-row"><span>' + escapeHtml(rec.status) + "</span><span>" + dateStr + "</span></div>";
    tip.hidden = false;
    moveTooltip(e);
  }
  function moveTooltip(e) {
    var tip = document.getElementById("tooltip");
    if (tip.hidden) return;
    var x = e.clientX + 16, y = e.clientY + 16;
    var maxX = window.innerWidth - 280, maxY = window.innerHeight - 90;
    tip.style.left = Math.min(x, maxX) + "px";
    tip.style.top = Math.min(y, maxY) + "px";
  }
  function hideTooltip() { document.getElementById("tooltip").hidden = true; }

  // ==================== TABLE ====================

  var TABLE_COLS = [
    { key: "id", label: "ID" },
    { key: "phase", label: "Phase" },
    { key: "task", label: "Task" },
    { key: "start", label: "Start" },
    { key: "end", label: "End" },
    { key: "duration", label: "Days" },
    { key: "status", label: "Status" },
    { key: "milestone", label: "Milestone" }
  ];

  function renderTable() {
    var panel = document.getElementById("panel-table");
    var data = getFiltered().slice();

    data.sort(function (a, b) {
      var ka = a[state.sortKey], kb = b[state.sortKey];
      if (state.sortKey === "start" || state.sortKey === "end") {
        ka = parseDate(a[state.sortKey]) || new Date(0);
        kb = parseDate(b[state.sortKey]) || new Date(0);
      }
      if (ka == null) ka = "";
      if (kb == null) kb = "";
      var cmp = ka > kb ? 1 : ka < kb ? -1 : 0;
      return state.sortDir === "asc" ? cmp : -cmp;
    });

    if (!data.length) {
      panel.innerHTML = '<div class="empty-state">No tasks match your filters.</div>';
      return;
    }

    var head = "<tr>" + TABLE_COLS.map(function (c) {
      var arrow = state.sortKey === c.key ? (state.sortDir === "asc" ? " ▲" : " ▼") : "";
      return '<th data-key="' + c.key + '">' + c.label + (arrow ? '<span class="sort-arrow">' + arrow + "</span>" : "") + "</th>";
    }).join("") + "</tr>";

    var rows = data.map(function (rec) {
      return "<tr data-id='" + escapeAttr(rec.id) + "'>" +
        '<td class="id-cell">' + escapeHtml(rec.id) + "</td>" +
        '<td><span class="phase-tag" style="--tag-color:' + phaseColor(rec.phase) + '">' + escapeHtml(phaseShortLabel(rec.phase)) + "</span></td>" +
        "<td>" + escapeHtml(rec.task) + "</td>" +
        '<td class="dates-cell">' + fmtDate(rec.start) + "</td>" +
        '<td class="dates-cell">' + fmtDate(rec.end) + "</td>" +
        "<td>" + (rec.duration != null ? rec.duration : "–") + "</td>" +
        "<td>" + statusSelectHtml(rec.status, rec.id) + "</td>" +
        "<td>" + (rec.milestone ? "★" : "–") + "</td>" +
        "</tr>";
    }).join("");

    panel.innerHTML = '<div class="table-wrap"><table class="roadmap-table"><thead>' + head + "</thead><tbody>" + rows + "</tbody></table></div>";
    wireStatusSelects(panel);

    panel.querySelectorAll("th[data-key]").forEach(function (th) {
      th.addEventListener("click", function () {
        var key = th.getAttribute("data-key");
        if (state.sortKey === key) {
          state.sortDir = state.sortDir === "asc" ? "desc" : "asc";
        } else {
          state.sortKey = key;
          state.sortDir = "asc";
        }
        renderTable();
      });
    });
    panel.querySelectorAll("tbody tr").forEach(function (tr) {
      tr.addEventListener("click", function () { openModal(tr.getAttribute("data-id")); });
    });
  }

  // ==================== MODAL ====================

  function openModal(id) {
    var rec = DATA.find(function (r) { return r.id === id; });
    if (!rec) return;
    var root = document.getElementById("modalRoot");
    var card = root.querySelector(".modal-card");

    var deps = (rec.dependency || []).map(function (depId) {
      var depRec = DATA.find(function (r) { return r.id === depId.trim(); });
      var label = depRec ? depId + " – " + truncate(depRec.task, 28) : depId;
      return '<span class="dep-chip" data-dep="' + escapeAttr(depId.trim()) + '" title="' + escapeAttr(label) + '">' + escapeHtml(depId.trim()) + "</span>";
    }).join("");

    card.innerHTML =
      '<button class="modal-close" type="button" aria-label="Close">✕</button>' +
      '<div class="modal-eyebrow"><span class="phase-tag" style="--tag-color:' + phaseColor(rec.phase) + '">' + escapeHtml(rec.phase) + "</span>" +
      (rec.milestone ? '<span class="milestone-badge">★ MILESTONE</span>' : "") + "</div>" +
      '<h2 class="modal-title">' + escapeHtml(rec.id) + " — " + escapeHtml(rec.task) + "</h2>" +
      '<div class="modal-row"><div class="modal-row-label">Status</div><div class="modal-row-value">' + statusSelectHtml(rec.status, rec.id) + "</div></div>" +
      '<div class="modal-row"><div class="modal-row-label">Dates</div><div class="modal-row-value">' +
      (rec.start ? fmtDate(rec.start) + " → " + fmtDate(rec.end) : fmtDate(rec.end)) +
      (rec.duration != null ? " (" + rec.duration + "d)" : "") + "</div></div>" +
      (deps ? '<div class="modal-row"><div class="modal-row-label">Depends on</div><div class="modal-row-value">' + deps + "</div></div>" : "") +
      (rec.notes ? '<div class="modal-row"><div class="modal-row-label">Notes</div><div class="modal-row-value">' + escapeHtml(rec.notes) + "</div></div>" : "");

    root.hidden = false;
    card.querySelector(".modal-close").addEventListener("click", closeModal);
    card.querySelectorAll(".dep-chip").forEach(function (chip) {
      chip.addEventListener("click", function () { openModal(chip.getAttribute("data-dep")); });
    });
    wireStatusSelects(card);
  }
  function closeModal() { document.getElementById("modalRoot").hidden = true; }

  // ==================== FILTER UI ====================

  function renderPhaseFilter() {
    var el = document.getElementById("phaseFilter");
    el.innerHTML = PHASES.map(function (p) {
      var active = state.activePhases.has(p);
      return '<button type="button" class="phase-chip' + (active ? " is-active" : "") + '" data-phase="' + escapeAttr(p) + '" style="--dot-color:' + phaseColor(p) + '">' +
        '<span class="dot"></span>' + escapeHtml(phaseShortLabel(p)) + "</button>";
    }).join("");
    el.querySelectorAll(".phase-chip").forEach(function (chip) {
      chip.addEventListener("click", function () {
        var p = chip.getAttribute("data-phase");
        if (state.activePhases.has(p)) state.activePhases.delete(p);
        else state.activePhases.add(p);
        renderPhaseFilter();
        renderAll();
      });
    });
  }

  // ==================== TABS ====================

  function switchTab(tab) {
    document.querySelectorAll(".tab-btn").forEach(function (b) {
      var active = b.getAttribute("data-tab") === tab;
      b.classList.toggle("is-active", active);
      b.setAttribute("aria-selected", active ? "true" : "false");
    });
    document.querySelectorAll(".tab-panel").forEach(function (p) {
      p.classList.toggle("is-active", p.id === "panel-" + tab);
    });
  }

  // ==================== THEME ====================

  function applyTheme(theme) {
    if (theme === "dark" || theme === "light") {
      document.documentElement.setAttribute("data-theme", theme);
    } else {
      document.documentElement.removeAttribute("data-theme");
    }
    var icon = document.getElementById("themeToggleIcon");
    var isDark = theme === "dark" || (!theme && window.matchMedia && window.matchMedia("(prefers-color-scheme: dark)").matches);
    icon.innerHTML = isDark ? "☀" : "☽";
  }

  function safeStorage() {
    try {
      var k = "__heimdall_test__";
      window.localStorage.setItem(k, "1");
      window.localStorage.removeItem(k);
      return window.localStorage;
    } catch (e) {
      return null;
    }
  }

  function initTheme() {
    var store = safeStorage();
    var saved = store ? store.getItem("heimdall-theme") : null;
    applyTheme(saved);
    document.getElementById("themeToggle").addEventListener("click", function () {
      var current = document.documentElement.getAttribute("data-theme");
      var isDark = current === "dark" || (!current && window.matchMedia && window.matchMedia("(prefers-color-scheme: dark)").matches);
      var next = isDark ? "light" : "dark";
      if (store) store.setItem("heimdall-theme", next);
      applyTheme(next);
    });
  }

  // ==================== WIRE UP ====================

  function renderAll() {
    renderStats();
    renderBoard();
    renderGantt();
    renderTable();
  }

  function init() {
    document.getElementById("generatedAt").textContent = window.ROADMAP_GENERATED_AT
      ? "Data refreshed " + window.ROADMAP_GENERATED_AT
      : "";

    initTheme();
    document.getElementById("exportEditsBtn").addEventListener("click", exportOverrides);
    document.getElementById("resetEditsBtn").addEventListener("click", resetOverrides);
    document.getElementById("saveStateBtn").addEventListener("click", saveState);
    document.getElementById("loadStateBtn").addEventListener("click", function () {
      document.getElementById("loadStateInput").click();
    });
    document.getElementById("loadStateInput").addEventListener("change", function (e) {
      loadState(e.target.files[0]);
      e.target.value = "";
    });

    document.querySelectorAll(".tab-btn").forEach(function (btn) {
      btn.addEventListener("click", function () { switchTab(btn.getAttribute("data-tab")); });
    });

    var searchInput = document.getElementById("searchInput");
    var searchTimer;
    searchInput.addEventListener("input", function () {
      clearTimeout(searchTimer);
      var val = searchInput.value;
      searchTimer = setTimeout(function () {
        state.search = val;
        renderAll();
      }, 120);
    });

    document.querySelectorAll("[data-group]").forEach(function (btn) {
      btn.addEventListener("click", function () {
        state.groupBy = btn.getAttribute("data-group");
        document.querySelectorAll("[data-group]").forEach(function (b) { b.classList.toggle("is-active", b === btn); });
        renderBoard();
      });
    });

    document.getElementById("modalRoot").addEventListener("click", function (e) {
      if (e.target.hasAttribute("data-close")) closeModal();
    });
    document.addEventListener("keydown", function (e) {
      if (e.key === "Escape") closeModal();
    });

    syncFromStateFile().then(function () {
      updateLocalEditsUI();
      renderPhaseFilter();
      renderAll();
    });
  }

  document.addEventListener("DOMContentLoaded", init);
})();
