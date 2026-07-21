// KSK Keying Console — frontend. Vanilla JS, no dependencies, no build step.
// Talks to the server strictly via the HTTP API + SSE contract defined in SPEC.md.
//
// Mobile-first, two views driven purely by the URL hash:
//   '' / '#tasks'   -> task list (running / queued / history)
//   '#customers'    -> client picker (folder tree + run confirmation)
// No router dependency: hashchange just toggles which <section class="view"> is visible.

(() => {
  'use strict';

  const els = {
    navBtn: document.getElementById('nav-btn'),
    engineBadge: document.getElementById('engine-badge'),

    viewTasks: document.getElementById('view-tasks'),
    viewCustomers: document.getElementById('view-customers'),

    paneRunEmpty: document.getElementById('pane-run-empty'),
    sectionRunning: document.getElementById('section-running'),
    runningContainer: document.getElementById('running-container'),
    sectionQueue: document.getElementById('section-queue'),
    queueHeading: document.getElementById('queue-heading'),
    queueList: document.getElementById('queue-list'),
    sectionHistory: document.getElementById('section-history'),
    historyList: document.getElementById('history-list'),

    clientTree: document.getElementById('client-tree'),
    confirmBar: document.getElementById('confirm-bar'),
    confirmLabel: document.getElementById('confirm-label'),
    runBtn: document.getElementById('run-btn'),
  };

  const STATUS_LABEL = { done: 'เสร็จ', error: 'ผิดพลาด', stopped: 'หยุดแล้ว' };

  // --- state ---
  let selectedMonthPath = null;
  let runsById = new Map();

  // clientId ("216") -> companyName | null, populated by loadClients(). Lets
  // task-list run cards (which only ever get a bare run.path from the
  // server, e.g. "216/เดือนเมษายน") show the same readable company name the
  // customer picker already does, instead of just the folder id.
  let clientsById = new Map();

  // SSE — attached only to whichever run currently has status "running".
  let eventSource = null;
  let sseRunId = null;
  let currentSubAgent = null; // { name, description } | null, for the live running card

  // Which run's elapsed-time text the ticking interval should keep updating.
  let runningElapsedRunId = null;

  // GET /api/html results per run id, fetched lazily per done-card (for the ตรวจทาน
  // button) and cached — a terminal run's html output does not change further.
  // entry: { status: 'pending' } | { status: 'ready', files: [{name, relPath}] }
  const reviewCache = new Map();

  // --- helpers ---

  async function fetchJSON(url, opts) {
    const res = await fetch(url, opts);
    let body = null;
    try {
      body = await res.json();
    } catch (_) {
      body = null;
    }
    if (!res.ok) {
      const message = (body && body.error) || res.statusText || 'request failed';
      throw new Error(message);
    }
    return body;
  }

  // Encode a POSIX-style relative path segment-by-segment so '/' survives
  // while Thai / special characters in each segment round-trip correctly.
  function encodeRelPath(p) {
    return p
      .split('/')
      .filter((seg) => seg.length > 0)
      .map(encodeURIComponent)
      .join('/');
  }

  function joinRel(a, b) {
    if (!a) return b;
    if (!b) return a;
    return a.replace(/\/+$/, '') + '/' + b.replace(/^\/+/, '');
  }

  // "216/เดือนเมษายน" -> "216 — บริษัท ชามหวาน จำกัด (มหาชน) · เดือนเมษายน";
  // falls back to the raw path unchanged when the client id isn't known yet
  // or has no companyName on file, same fallback rule as the customer picker.
  function formatRunLabel(path) {
    const slash = path.indexOf('/');
    const clientId = slash === -1 ? path : path.slice(0, slash);
    const rest = slash === -1 ? '' : path.slice(slash + 1);
    const companyName = clientsById.get(clientId);
    const clientLabel = companyName ? clientId + ' — ' + companyName : clientId;
    return rest ? clientLabel + ' · ' + rest : clientLabel;
  }

  function minutesBetween(startIso, endIso) {
    if (!startIso) return null;
    const start = new Date(startIso).getTime();
    const end = endIso ? new Date(endIso).getTime() : Date.now();
    if (Number.isNaN(start) || Number.isNaN(end)) return null;
    return Math.max(0, Math.round((end - start) / 60000));
  }

  function formatHHMM(iso) {
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return '--:--';
    const hh = String(d.getHours()).padStart(2, '0');
    const mm = String(d.getMinutes()).padStart(2, '0');
    return hh + ':' + mm;
  }

  // "ksk-watson" -> "Watson"; generic stripping applies to any subagent_type,
  // recognized or not — never a hardcoded enum.
  function formatSubagentName(subagentType) {
    let s = typeof subagentType === 'string' ? subagentType : '';
    if (s.toLowerCase().startsWith('ksk-')) s = s.slice(4);
    if (!s) return 'Agent';
    return s.charAt(0).toUpperCase() + s.slice(1);
  }

  function makeButton(text, className, onClick) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = className;
    btn.textContent = text;
    if (onClick) btn.addEventListener('click', onClick);
    return btn;
  }

  // --- routing: '' / '#tasks' -> task list, '#customers' -> client picker ---

  function currentView() {
    return location.hash === '#customers' ? 'customers' : 'tasks';
  }

  function applyRoute() {
    const view = currentView();
    els.viewTasks.hidden = view !== 'tasks';
    els.viewCustomers.hidden = view !== 'customers';

    if (view === 'customers') {
      els.navBtn.textContent = '‹';
      els.navBtn.setAttribute('aria-label', 'กลับ');
      els.navBtn.onclick = () => {
        location.hash = '';
      };
    } else {
      els.navBtn.textContent = '☰';
      els.navBtn.setAttribute('aria-label', 'เมนู');
      els.navBtn.onclick = () => {
        location.hash = '#customers';
      };
    }
  }

  window.addEventListener('hashchange', applyRoute);

  // --- config / header badge ---

  async function loadConfig() {
    try {
      const cfg = await fetchJSON('/api/config');
      els.engineBadge.textContent = cfg.engineMode;
      els.engineBadge.classList.remove('mock', 'claude');
      els.engineBadge.classList.add(cfg.engineMode === 'claude' ? 'claude' : 'mock');
    } catch (err) {
      els.engineBadge.textContent = 'ใช้งานไม่ได้';
    }
  }

  // --- client tree (#customers view) ---

  async function loadClients() {
    els.clientTree.textContent = '';
    let data;
    try {
      data = await fetchJSON('/api/clients');
    } catch (err) {
      const p = document.createElement('div');
      p.className = 'empty-hint';
      p.textContent = 'ไม่สามารถโหลดรายชื่อลูกค้าได้';
      els.clientTree.appendChild(p);
      return;
    }
    const clients = data.clients || [];
    clientsById = new Map(clients.map((c) => [c.name, c.companyName]));
    // Run cards may have already rendered with bare folder ids before this
    // resolved (loadClients/loadRuns fire concurrently at boot) — refresh
    // them now that company names are known, instead of waiting up to 10s
    // for the next runs poll.
    renderAll();
    if (clients.length === 0) {
      const p = document.createElement('div');
      p.className = 'empty-hint';
      p.textContent = 'ไม่พบโฟลเดอร์ลูกค้า';
      els.clientTree.appendChild(p);
      return;
    }
    for (const client of clients) {
      const details = document.createElement('details');
      details.className = 'client-node';
      details.open = true;
      const summary = document.createElement('summary');
      summary.className = 'client-name';
      summary.textContent = client.companyName
        ? client.name + ' — ' + client.companyName
        : client.name;
      details.appendChild(summary);
      for (const month of client.months || []) {
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'month-item';
        btn.textContent = month.name;
        btn.dataset.path = month.path;
        const label = summary.textContent + ' · ' + month.name;
        btn.addEventListener('click', () => selectMonth(month.path, label, btn));
        details.appendChild(btn);
      }
      els.clientTree.appendChild(details);
    }
  }

  function selectMonth(path, label, btnEl) {
    selectedMonthPath = path;
    for (const b of els.clientTree.querySelectorAll('.month-item')) {
      b.classList.toggle('selected', b === btnEl);
    }
    els.confirmLabel.textContent = label;
    els.confirmBar.hidden = false;
  }

  async function createRunFor(path) {
    return fetchJSON('/api/runs', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ path }),
    });
  }

  els.runBtn.addEventListener('click', async () => {
    if (!selectedMonthPath) return;
    els.runBtn.disabled = true;
    try {
      const data = await createRunFor(selectedMonthPath);
      runsById.set(data.run.id, data.run);
      selectedMonthPath = null;
      els.confirmBar.hidden = true;
      renderAll();
      location.hash = ''; // back to the task list so the new run is immediately visible
    } catch (err) {
      window.alert('เริ่มการรันไม่สำเร็จ: ' + err.message);
    } finally {
      els.runBtn.disabled = false;
    }
  });

  // --- restart ("เริ่มใหม่") — reused by done / error / stopped cards ---

  async function doRestart(run) {
    try {
      const data = await createRunFor(run.path);
      runsById.set(data.run.id, data.run);
      renderAll();
      requestAnimationFrame(() => {
        const card = document.querySelector('[data-run-id="' + data.run.id + '"]');
        if (card) card.scrollIntoView({ behavior: 'smooth', block: 'center' });
      });
    } catch (err) {
      window.alert('เริ่มงานใหม่ไม่สำเร็จ: ' + err.message);
    }
  }

  // --- stop / cancel — same endpoint handles a running or a queued run ---

  async function doStopOrCancel(runId) {
    try {
      const data = await fetchJSON('/api/runs/' + encodeURIComponent(runId) + '/stop', {
        method: 'POST',
      });
      runsById.set(data.run.id, data.run);
      renderAll();
    } catch (err) {
      window.alert('ทำรายการไม่สำเร็จ: ' + err.message);
    }
  }

  // --- runs: load + top-level render ---

  async function loadRuns() {
    let data;
    try {
      data = await fetchJSON('/api/runs');
    } catch (err) {
      return;
    }
    const runs = data.runs || [];
    runsById = new Map(runs.map((r) => [r.id, r]));
    renderAll();
  }

  function renderAll() {
    const runs = Array.from(runsById.values());
    const runningRun = runs.find((r) => r.status === 'running') || null;
    const queuedRuns = runs
      .filter((r) => r.status === 'queued')
      .sort((a, b) => (a.queuedAt < b.queuedAt ? -1 : a.queuedAt > b.queuedAt ? 1 : 0));
    const historyRuns = runs
      .filter((r) => r.status === 'done' || r.status === 'error' || r.status === 'stopped')
      .sort((a, b) => {
        const ae = a.endedAt || a.startedAt || a.queuedAt;
        const be = b.endedAt || b.startedAt || b.queuedAt;
        return ae < be ? 1 : ae > be ? -1 : 0;
      });

    syncSSE(runningRun);

    if (runs.length === 0) {
      els.paneRunEmpty.hidden = false;
      els.sectionRunning.hidden = true;
      els.sectionQueue.hidden = true;
      els.sectionHistory.hidden = true;
      return;
    }

    els.paneRunEmpty.hidden = true;
    els.sectionRunning.hidden = false;
    els.sectionHistory.hidden = false;

    renderRunningSection(runningRun);
    renderQueueSection(queuedRuns);
    renderHistorySection(historyRuns);
  }

  // --- running card (0 or 1) ---

  function renderRunningSection(run) {
    const container = els.runningContainer;
    container.textContent = '';
    runningElapsedRunId = run ? run.id : null;
    if (!run) return;

    const card = document.createElement('div');
    card.className = 'run-card run-card--running';
    card.dataset.runId = run.id;

    const head = document.createElement('div');
    head.className = 'run-card-head';
    const pathSpan = document.createElement('span');
    pathSpan.className = 'run-path';
    pathSpan.textContent = formatRunLabel(run.path);
    head.appendChild(pathSpan);
    card.appendChild(head);

    const meta = document.createElement('div');
    meta.className = 'run-card-meta';

    const elapsedSpan = document.createElement('span');
    elapsedSpan.className = 'meta-item elapsed';
    meta.appendChild(elapsedSpan);

    const subagentSpan = document.createElement('span');
    subagentSpan.className = 'meta-item subagent';
    subagentSpan.hidden = true;
    meta.appendChild(subagentSpan);

    card.appendChild(meta);

    const actions = document.createElement('div');
    actions.className = 'run-card-actions';
    actions.appendChild(
      makeButton('■ หยุดชั่วคราว', 'btn btn-danger', () => doStopOrCancel(run.id)),
    );
    card.appendChild(actions);

    container.appendChild(card);
    updateElapsedDisplay();
    updateRunningSubAgentDisplay();
  }

  function updateElapsedDisplay() {
    if (!runningElapsedRunId) return;
    const run = runsById.get(runningElapsedRunId);
    if (!run) return;
    const el = els.runningContainer.querySelector('.elapsed');
    if (!el) return;
    const mins = minutesBetween(run.startedAt, null);
    el.textContent = '⏱ ' + (mins == null ? '–' : mins) + ' นาที';
  }

  function updateRunningSubAgentDisplay() {
    const el = els.runningContainer.querySelector('.subagent');
    if (!el) return;
    if (currentSubAgent) {
      el.hidden = false;
      el.textContent = '🔧 ' + currentSubAgent.name + ' - ' + currentSubAgent.description;
    } else {
      el.hidden = true;
      el.textContent = '';
    }
  }

  // --- queue cards ---

  function renderQueueSection(queuedRuns) {
    if (queuedRuns.length === 0) {
      els.sectionQueue.hidden = true;
      els.queueList.textContent = '';
      return;
    }
    els.sectionQueue.hidden = false;
    els.queueHeading.textContent = 'รอคิว (' + queuedRuns.length + ')';
    els.queueList.textContent = '';

    for (const run of queuedRuns) {
      const card = document.createElement('div');
      card.className = 'run-card run-card--queued';
      card.dataset.runId = run.id;

      const head = document.createElement('div');
      head.className = 'run-card-head';
      const pathSpan = document.createElement('span');
      pathSpan.className = 'run-path';
      pathSpan.textContent = formatRunLabel(run.path);
      head.appendChild(pathSpan);
      card.appendChild(head);

      const meta = document.createElement('div');
      meta.className = 'run-card-meta';
      const queuedSpan = document.createElement('span');
      queuedSpan.className = 'meta-item';
      queuedSpan.textContent = 'เข้าคิว ' + formatHHMM(run.queuedAt);
      meta.appendChild(queuedSpan);
      card.appendChild(meta);

      const actions = document.createElement('div');
      actions.className = 'run-card-actions';
      actions.appendChild(makeButton('ยกเลิก', 'btn btn-danger', () => doStopOrCancel(run.id)));
      card.appendChild(actions);

      els.queueList.appendChild(card);
    }
  }

  // --- history cards ---

  function renderHistorySection(historyRuns) {
    els.historyList.textContent = '';
    if (historyRuns.length === 0) {
      const p = document.createElement('div');
      p.className = 'empty-hint';
      p.textContent = 'ยังไม่มีลูกค้าเสร็จงาน';
      els.historyList.appendChild(p);
      return;
    }

    for (const run of historyRuns) {
      const card = document.createElement('div');
      card.className = 'run-card run-card--history run-card--' + run.status;
      card.dataset.runId = run.id;

      const head = document.createElement('div');
      head.className = 'run-card-head';
      const chip = document.createElement('span');
      chip.className = 'chip ' + run.status;
      chip.textContent = STATUS_LABEL[run.status] || run.status;
      const pathSpan = document.createElement('span');
      pathSpan.className = 'run-path';
      pathSpan.textContent = formatRunLabel(run.path);
      head.appendChild(chip);
      head.appendChild(pathSpan);
      card.appendChild(head);

      const meta = document.createElement('div');
      meta.className = 'run-card-meta';
      const durSpan = document.createElement('span');
      durSpan.className = 'meta-item';
      const mins = minutesBetween(run.startedAt, run.endedAt);
      durSpan.textContent = (mins == null ? '–' : mins) + ' นาที';
      meta.appendChild(durSpan);
      card.appendChild(meta);

      const actionsWrap = document.createElement('div');
      actionsWrap.className = 'actions-wrap';
      card.appendChild(actionsWrap);
      renderHistoryCardActions(actionsWrap, run);

      if (run.status === 'done') ensureReviewFiles(run.id, run.path);

      els.historyList.appendChild(card);
    }
  }

  // done -> [เริ่มใหม่, ตรวจทาน (once html files are known), เรียนรู้ (disabled placeholder)]
  // error/stopped -> [เริ่มใหม่] alone
  function renderHistoryCardActions(container, run) {
    container.textContent = '';

    const actions = document.createElement('div');
    actions.className = 'run-card-actions';
    actions.appendChild(makeButton('เริ่มใหม่', 'btn btn-primary', () => doRestart(run)));

    let linksWrap = null;

    if (run.status === 'done') {
      const entry = reviewCache.get(run.id);
      if (entry && entry.status === 'ready' && entry.files && entry.files.length > 0) {
        if (entry.files.length > 1) {
          linksWrap = document.createElement('div');
          linksWrap.className = 'review-links';
          linksWrap.hidden = true;
          for (const file of entry.files) {
            const a = document.createElement('a');
            a.href = '/files/' + encodeRelPath(joinRel(run.path, file.relPath));
            a.target = '_blank';
            a.rel = 'noopener';
            a.textContent = file.relPath;
            linksWrap.appendChild(a);
          }
        }
        const wrapRef = linksWrap;
        actions.appendChild(
          makeButton('ตรวจทาน', 'btn btn-neutral', () => {
            if (entry.files.length === 1) {
              window.open(
                '/files/' + encodeRelPath(joinRel(run.path, entry.files[0].relPath)),
                '_blank',
                'noopener',
              );
            } else if (wrapRef) {
              wrapRef.hidden = !wrapRef.hidden;
            }
          }),
        );
      }

      const learnBtn = makeButton('เรียนรู้', 'btn btn-disabled', null);
      learnBtn.disabled = true;
      learnBtn.setAttribute('aria-disabled', 'true');
      actions.appendChild(learnBtn);
    }

    container.appendChild(actions);
    if (linksWrap) container.appendChild(linksWrap);
  }

  // --- review files (per done card, lazy + cached) ---

  function ensureReviewFiles(runId, path) {
    const existing = reviewCache.get(runId);
    if (existing) return existing;
    const placeholder = { status: 'pending' };
    reviewCache.set(runId, placeholder);
    fetchJSON('/api/html?path=' + encodeURIComponent(path))
      .then((data) => {
        reviewCache.set(runId, { status: 'ready', files: data.files || [] });
        updateHistoryCardReview(runId);
      })
      .catch(() => {
        reviewCache.set(runId, { status: 'ready', files: [] });
        updateHistoryCardReview(runId);
      });
    return placeholder;
  }

  function updateHistoryCardReview(runId) {
    const card = els.historyList.querySelector('[data-run-id="' + runId + '"]');
    if (!card) return;
    const wrap = card.querySelector('.actions-wrap');
    const run = runsById.get(runId);
    if (!wrap || !run) return;
    renderHistoryCardActions(wrap, run);
  }

  // --- SSE: current sub-agent on the live running card only ---

  function syncSSE(runningRun) {
    const runningId = runningRun ? runningRun.id : null;
    if (runningId === sseRunId) return;
    if (eventSource) {
      eventSource.close();
      eventSource = null;
    }
    sseRunId = runningId;
    currentSubAgent = null;
    if (runningId) {
      eventSource = new EventSource('/api/runs/' + encodeURIComponent(runningId) + '/events');
      eventSource.addEventListener('message', handleSSEMessage);
      eventSource.onerror = () => {
        // EventSource retries on its own; nothing further to do here.
      };
    }
  }

  function handleSSEMessage(ev) {
    let evt;
    try {
      evt = JSON.parse(ev.data);
    } catch (_) {
      return;
    }
    if (!evt || typeof evt !== 'object' || evt.type !== 'assistant') return;
    const blocks = (evt.message && evt.message.content) || [];
    let changed = false;
    for (const block of blocks) {
      if (!block || typeof block !== 'object') continue;
      if (block.type === 'tool_use' && block.name === 'Agent') {
        const input = block.input || {};
        const description = typeof input.description === 'string' ? input.description : '';
        currentSubAgent = { name: formatSubagentName(input.subagent_type), description };
        changed = true;
      }
    }
    if (changed) updateRunningSubAgentDisplay();
  }

  // --- boot ---

  applyRoute();
  loadConfig();
  loadClients();
  loadRuns();
  setInterval(loadRuns, 10000);
  setInterval(updateElapsedDisplay, 25000);
})();
