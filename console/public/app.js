// KSK Keying Console — frontend. Vanilla JS, no dependencies, no build step.
// Talks to the server strictly via the HTTP API + SSE contract defined in SPEC.md.

(() => {
  'use strict';

  const els = {
    engineBadge: document.getElementById('engine-badge'),
    clientTree: document.getElementById('client-tree'),
    runBtn: document.getElementById('run-btn'),
    paneRunEmpty: document.getElementById('pane-run-empty'),
    sectionRunning: document.getElementById('section-running'),
    runningContainer: document.getElementById('running-container'),
    sectionQueue: document.getElementById('section-queue'),
    queueHeading: document.getElementById('queue-heading'),
    queueList: document.getElementById('queue-list'),
    sectionHistory: document.getElementById('section-history'),
    historyList: document.getElementById('history-list'),
  };

  const STATUS_LABEL = { done: 'เสร็จ', error: 'ผิดพลาด', stopped: 'หยุดแล้ว' };

  // --- state ---
  let selectedMonthPath = null;
  let runsById = new Map();

  // SSE — attached only to whichever run currently has status "running".
  let eventSource = null;
  let sseRunId = null;
  let currentSubAgent = null; // { name, description } | null, for the live running card

  // Which run's elapsed-time text the ticking interval should keep updating.
  let runningElapsedRunId = null;

  // GET /api/html results per run id, fetched lazily per history card and cached
  // (a terminal run's html output does not change further).
  // entry: { status: 'pending' } | { status: 'ready', files: [{name, relPath}] }
  const reviewCache = new Map();

  // Inline resume UI state, kept outside the DOM so a poll-driven re-render of the
  // history list doesn't lose an open textarea or its in-progress draft text.
  const resumeOpenIds = new Set();
  const resumeDrafts = new Map();

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

  // --- client tree ---

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
      summary.textContent = client.name;
      details.appendChild(summary);
      for (const month of client.months || []) {
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'month-item';
        btn.textContent = month.name;
        btn.dataset.path = month.path;
        btn.addEventListener('click', () => selectMonth(month.path, btn));
        details.appendChild(btn);
      }
      els.clientTree.appendChild(details);
    }
  }

  function selectMonth(path, btnEl) {
    selectedMonthPath = path;
    for (const b of els.clientTree.querySelectorAll('.month-item')) {
      b.classList.toggle('selected', b === btnEl);
    }
    els.runBtn.disabled = false;
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
    pathSpan.textContent = run.path;
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
    const stopBtn = document.createElement('button');
    stopBtn.type = 'button';
    stopBtn.className = 'stop-btn';
    stopBtn.textContent = '■ หยุด';
    stopBtn.addEventListener('click', () => doStop(run.id));
    actions.appendChild(stopBtn);
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

  async function doStop(runId) {
    try {
      const data = await fetchJSON('/api/runs/' + encodeURIComponent(runId) + '/stop', {
        method: 'POST',
      });
      runsById.set(data.run.id, data.run);
      renderAll();
    } catch (err) {
      window.alert('หยุดการรันไม่สำเร็จ: ' + err.message);
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
      pathSpan.textContent = run.path;
      head.appendChild(pathSpan);
      card.appendChild(head);

      const meta = document.createElement('div');
      meta.className = 'run-card-meta';
      const queuedSpan = document.createElement('span');
      queuedSpan.className = 'meta-item';
      queuedSpan.textContent = 'เข้าคิว ' + formatHHMM(run.queuedAt);
      meta.appendChild(queuedSpan);
      card.appendChild(meta);

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
      pathSpan.textContent = run.path;
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

      const actions = document.createElement('div');
      actions.className = 'run-card-actions';

      const reviewActions = document.createElement('div');
      reviewActions.className = 'review-actions';
      actions.appendChild(reviewActions);
      ensureReviewFiles(run.id, run.path);
      renderReviewActions(reviewActions, run.id, run);

      const resumeActions = document.createElement('div');
      resumeActions.className = 'resume-actions';
      renderResumeSection(resumeActions, run);
      actions.appendChild(resumeActions);

      card.appendChild(actions);
      els.historyList.appendChild(card);
    }
  }

  // --- review links (per history card, lazy + cached) ---

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
    const container = card.querySelector('.review-actions');
    const run = runsById.get(runId);
    if (!container || !run) return;
    renderReviewActions(container, runId, run);
  }

  // Plain links the browser navigates to / opens in a new tab — never fetched
  // into the page. Exactly one html file -> open it directly; more than one ->
  // reveal a small list of real anchor links instead of guessing which to open.
  function renderReviewActions(container, runId, run) {
    container.textContent = '';
    const entry = reviewCache.get(runId);
    if (!entry || entry.status !== 'ready' || !entry.files || entry.files.length === 0) return;

    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'review-btn';
    btn.textContent = '📄 เปิดหน้าตรวจทาน';

    const linksWrap = document.createElement('div');
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

    btn.addEventListener('click', () => {
      if (entry.files.length === 1) {
        window.open('/files/' + encodeRelPath(joinRel(run.path, entry.files[0].relPath)), '_blank', 'noopener');
      } else {
        linksWrap.hidden = !linksWrap.hidden;
      }
    });

    container.appendChild(btn);
    if (entry.files.length > 1) container.appendChild(linksWrap);
  }

  // --- resume (inline per history card) ---

  function renderResumeSection(container, run) {
    container.textContent = '';
    if (!run.sessionId) return;

    const toggleBtn = document.createElement('button');
    toggleBtn.type = 'button';
    toggleBtn.className = 'resume-toggle-btn';
    toggleBtn.textContent = 'ดำเนินการต่อ';

    const box = document.createElement('div');
    box.className = 'resume-inline';
    box.hidden = !resumeOpenIds.has(run.id);

    const textarea = document.createElement('textarea');
    textarea.placeholder = 'ข้อความสำหรับดำเนินการต่อ…';
    textarea.value = resumeDrafts.get(run.id) || '';
    textarea.addEventListener('input', () => {
      resumeDrafts.set(run.id, textarea.value);
    });

    const submitBtn = document.createElement('button');
    submitBtn.type = 'button';
    submitBtn.className = 'resume-submit-btn';
    submitBtn.textContent = 'ส่ง';
    submitBtn.addEventListener('click', async () => {
      const message = textarea.value.trim();
      if (!message) return;
      submitBtn.disabled = true;
      try {
        const data = await fetchJSON('/api/runs/' + encodeURIComponent(run.id) + '/resume', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ message }),
        });
        runsById.set(data.run.id, data.run);
        resumeOpenIds.delete(run.id);
        resumeDrafts.delete(run.id);
        renderAll();
      } catch (err) {
        window.alert('ดำเนินการต่อไม่สำเร็จ: ' + err.message);
      } finally {
        submitBtn.disabled = false;
      }
    });

    toggleBtn.addEventListener('click', () => {
      if (resumeOpenIds.has(run.id)) {
        resumeOpenIds.delete(run.id);
      } else {
        resumeOpenIds.add(run.id);
      }
      box.hidden = !resumeOpenIds.has(run.id);
    });

    box.appendChild(textarea);
    box.appendChild(submitBtn);
    container.appendChild(toggleBtn);
    container.appendChild(box);
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

  // --- actions ---

  els.runBtn.addEventListener('click', async () => {
    if (!selectedMonthPath) return;
    els.runBtn.disabled = true;
    try {
      const data = await fetchJSON('/api/runs', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ path: selectedMonthPath }),
      });
      runsById.set(data.run.id, data.run);
      renderAll();
    } catch (err) {
      window.alert('เริ่มการรันไม่สำเร็จ: ' + err.message);
    } finally {
      els.runBtn.disabled = !selectedMonthPath;
    }
  });

  // --- boot ---

  loadConfig();
  loadClients();
  loadRuns();
  setInterval(loadRuns, 10000);
  setInterval(updateElapsedDisplay, 25000);
})();
