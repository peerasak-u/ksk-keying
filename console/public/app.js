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
    board: document.getElementById('board'),
    queueCount: document.getElementById('queue-count'),
    queueList: document.getElementById('queue-list'),
    progressCount: document.getElementById('progress-count'),
    runningContainer: document.getElementById('running-container'),
    endCount: document.getElementById('end-count'),
    historyList: document.getElementById('history-list'),

    clientTree: document.getElementById('client-tree'),
    confirmBar: document.getElementById('confirm-bar'),
    confirmLabel: document.getElementById('confirm-label'),
    runBtn: document.getElementById('run-btn'),
  };

  // --- icons ---
  // Raw lucide-style SVG markup, injected via innerHTML into a small wrapper
  // element whose CSS class controls the rendered size (.footer-time svg,
  // .subagent-icon svg, .menu-btn svg, etc.) — never string-edit the
  // width="24" height="24" attributes below; resize via CSS at the call site.

  const ICON_MENU =
    '<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 5h16"/><path d="M4 12h16"/><path d="M4 19h16"/></svg>';

  const ICON_CHEVRON_LEFT =
    '<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m15 18-6-6 6-6"/></svg>';

  const ICON_CLOCK =
    '<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><path d="M12 6v6l4 2"/></svg>';

  const ICON_BOT =
    '<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 8V4H8"/><rect width="16" height="12" x="4" y="8" rx="2"/><path d="M2 14h2"/><path d="M20 14h2"/><path d="M15 13v2"/><path d="M9 13v2"/></svg>';

  const ICON_PLAY =
    '<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M5 5a2 2 0 0 1 3.008-1.728l11.997 6.998a2 2 0 0 1 .003 3.458l-12 7A2 2 0 0 1 5 19z"/></svg>';

  const ICON_MORE_HORIZONTAL =
    '<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="1"/><circle cx="19" cy="12" r="1"/><circle cx="5" cy="12" r="1"/></svg>';

  const ICON_ALERT =
    '<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3Z"/><path d="M12 9v4"/><path d="M12 17h.01"/></svg>';

  const ICON_PAUSE =
    '<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="14" y="3" width="5" height="18" rx="1"/><rect x="5" y="3" width="5" height="18" rx="1"/></svg>';

  const ICON_X =
    '<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M18 6 6 18"/><path d="m6 6 12 12"/></svg>';

  const ICON_ROTATE_CCW =
    '<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8"/><path d="M3 3v5h5"/></svg>';

  const ICON_EXTERNAL_LINK =
    '<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M15 3h6v6"/><path d="M10 14 21 3"/><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/></svg>';

  const ICON_GRADUATION_CAP =
    '<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21.42 10.922a1 1 0 0 0-.019-1.838L12.83 5.18a2 2 0 0 0-1.66 0L2.6 9.08a1 1 0 0 0 0 1.832l8.57 3.908a2 2 0 0 0 1.66 0z"/><path d="M22 10v6"/><path d="M6 12.5V16a6 3 0 0 0 12 0v-3.5"/></svg>';

  // Sole remaining purpose: supplies the error-chip label text in a history
  // card's footer (queued/running/done/stopped no longer render a chip at all).
  const STATUS_LABEL = {
    error: 'ผิดพลาด',
  };

  // Deterministic per-agent-name color for the running card's sub-agent line.
  // Plain JS lookup table rather than CSS custom properties — this project
  // has no build step, and keeping the hash function and its color table
  // co-located in one module is simpler than round-tripping through 8 new
  // --agent-color-N custom properties for a single JS call site.
  const AGENT_COLOR_PALETTE = [
    '#b91c1c', '#b45309', '#166534', '#1d4ed8',
    '#6d28d9', '#be185d', '#0f766e', '#4338ca',
  ];

  function hashAgentColor(name) {
    const s = String(name || '');
    let hash = 0;
    for (let i = 0; i < s.length; i++) hash = (hash * 31 + s.charCodeAt(i)) | 0;
    return AGENT_COLOR_PALETTE[Math.abs(hash) % AGENT_COLOR_PALETTE.length];
  }

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

  // At most one card's ••• menu can be open at a time — a single (runId, status)
  // pair, not a set. Opening a different card's menu simply overwrites the pair.
  let openMenuRunId = null;
  let openMenuRunStatus = null;

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

  // "216/เดือนเมษายน" -> { primary: "216 — บริษัท ชามหวาน จำกัด (มหาชน)", secondary: "เดือนเมษายน" };
  // falls back to the raw clientId for `primary` when the client id isn't known
  // yet or has no companyName on file, same fallback rule as the customer picker.
  function formatRunLabelParts(path) {
    const slash = path.indexOf('/');
    const clientId = slash === -1 ? path : path.slice(0, slash);
    const rest = slash === -1 ? '' : path.slice(slash + 1);
    const companyName = clientsById.get(clientId);
    const primary = companyName ? clientId + ' — ' + companyName : clientId;
    return { primary, secondary: rest };
  }

  // Shared two-line label builder used by all three render*Section functions.
  // The secondary line is omitted entirely when empty (mirrors the old
  // single-line format's silent omission of the ' · ' + rest suffix) rather
  // than rendering a visibly blank second row.
  function buildRunLabel(path) {
    const { primary, secondary } = formatRunLabelParts(path);
    const label = document.createElement('div');
    label.className = 'run-card-label';
    const primarySpan = document.createElement('span');
    primarySpan.className = 'run-label-primary';
    primarySpan.textContent = primary;
    label.appendChild(primarySpan);
    if (secondary) {
      const secondarySpan = document.createElement('span');
      secondarySpan.className = 'run-label-secondary';
      secondarySpan.textContent = secondary;
      label.appendChild(secondarySpan);
    }
    return label;
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

  // Builds a `.run-card-footer` containing the left-hand time text and the
  // right-hand ••• menu. `timeHTML` may embed markup (a leading icon, an
  // empty span for later text injection) — callers control it explicitly.
  function buildFooter(run, timeHTML, menuEl) {
    const footer = document.createElement('div');
    footer.className = 'run-card-footer';
    const timeSpan = document.createElement('span');
    timeSpan.className = 'footer-time';
    timeSpan.innerHTML = timeHTML;
    footer.appendChild(timeSpan);
    footer.appendChild(menuEl);
    return footer;
  }

  // --- dropdown menu (•••) state + logic ---

  function isMenuOpenFor(run) {
    return openMenuRunId === run.id && openMenuRunStatus === run.status;
  }

  function toggleMenu(run) {
    if (isMenuOpenFor(run)) {
      closeMenu();
      return;
    }
    openMenuRunId = run.id;
    openMenuRunStatus = run.status;
    renderAll();
  }

  function closeMenu() {
    if (openMenuRunId == null) return;
    openMenuRunId = null;
    openMenuRunStatus = null;
    renderAll();
  }

  // Shared builder for the `.menu-wrap` (••• trigger + its `.menu-list`) used
  // by every card type. `itemConfigs` is an array of
  // { text, icon, danger?, disabled?, onClick? }.
  function buildMenu(run, itemConfigs) {
    const wrap = document.createElement('div');
    wrap.className = 'menu-wrap';

    const open = isMenuOpenFor(run);

    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'icon-btn menu-btn';
    btn.setAttribute('aria-haspopup', 'menu');
    btn.setAttribute('aria-expanded', String(open));
    btn.setAttribute('aria-label', 'ตัวเลือก');
    btn.innerHTML = ICON_MORE_HORIZONTAL;
    // stopPropagation is load-bearing: toggleMenu() calls renderAll() synchronously,
    // which replaces the DOM node the click originated from. Without stopping the
    // click here, it would still bubble to the document-level dismiss listener
    // against the now-detached old target.
    btn.addEventListener('click', (event) => {
      event.stopPropagation();
      toggleMenu(run);
    });
    wrap.appendChild(btn);

    const list = document.createElement('div');
    list.className = 'menu-list';
    list.setAttribute('role', 'menu');
    list.hidden = !open;
    for (const cfg of itemConfigs) {
      list.appendChild(makeMenuItem(cfg));
    }
    wrap.appendChild(list);

    return wrap;
  }

  function makeMenuItem(cfg) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.setAttribute('role', 'menuitem');
    btn.className = 'menu-item' + (cfg.danger ? ' menu-item--danger' : '');
    const iconSpan = document.createElement('span');
    iconSpan.className = 'menu-item-icon';
    iconSpan.innerHTML = cfg.icon || '';
    btn.appendChild(iconSpan);
    btn.appendChild(document.createTextNode(cfg.text));
    if (cfg.disabled) {
      btn.disabled = true;
      btn.setAttribute('aria-disabled', 'true');
    } else if (cfg.onClick) {
      // See the comment on the menu-btn listener above — same detached-node
      // bubbling hazard applies here, since closeMenu() also calls renderAll().
      btn.addEventListener('click', (event) => {
        event.stopPropagation();
        cfg.onClick();
        closeMenu();
      });
    }
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
      els.navBtn.innerHTML = ICON_CHEVRON_LEFT;
      els.navBtn.setAttribute('aria-label', 'กลับ');
      els.navBtn.onclick = () => {
        location.hash = '';
      };
    } else {
      els.navBtn.innerHTML = ICON_MENU;
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
    // Drop a stale open-menu reference before anything else: either the run
    // no longer exists in the latest poll, or it moved lanes (status changed)
    // since the menu was opened — in both cases the menu closes rather than
    // silently reopening with a now-wrong action set.
    if (openMenuRunId != null) {
      const r = runsById.get(openMenuRunId);
      if (!r || r.status !== openMenuRunStatus) {
        openMenuRunId = null;
        openMenuRunStatus = null;
      }
    }

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

    // Once at least one run has ever existed, the board itself (all 3 lanes,
    // Trello-style) stays permanently visible — an individual lane with 0
    // cards shows its own "ว่าง" hint rather than the whole lane
    // disappearing, same as a real Trello board with an empty column.
    if (runs.length === 0) {
      els.paneRunEmpty.hidden = false;
      els.board.hidden = true;
      return;
    }

    els.paneRunEmpty.hidden = true;
    els.board.hidden = false;

    renderQueueSection(queuedRuns);
    renderRunningSection(runningRun);
    renderHistorySection(historyRuns);
    positionOpenMenu();
  }

  // The menu-list defaults to opening upward (anchored to the ••• button's
  // bottom) so it doesn't cover the button that opened it. That default
  // overflows past the top of the viewport (behind the sticky header) for a
  // card near the top of its lane — flip to opening downward instead when
  // the up-anchored box would start above where the header ends. Runs after
  // every full re-render, since each render rebuilds the menu DOM from
  // scratch with no memory of the previous direction.
  function positionOpenMenu() {
    if (openMenuRunId == null) return;
    const list = document.querySelector('.menu-list:not([hidden])');
    if (!list) return;
    const header = document.getElementById('header');
    const minTop = header ? header.getBoundingClientRect().bottom : 0;
    const rect = list.getBoundingClientRect();
    list.classList.toggle('menu-list--down', rect.top < minTop);
  }

  // --- running card (0 or 1) ---

  function renderRunningSection(run) {
    els.progressCount.textContent = run ? '1' : '0';
    const container = els.runningContainer;
    container.textContent = '';
    runningElapsedRunId = run ? run.id : null;
    if (!run) {
      const p = document.createElement('div');
      p.className = 'lane-empty';
      p.textContent = 'ว่าง';
      container.appendChild(p);
      return;
    }

    const card = document.createElement('div');
    card.className = 'run-card run-card--running';
    card.dataset.runId = run.id;

    card.appendChild(buildRunLabel(run.path));

    const subagentLine = document.createElement('div');
    subagentLine.className = 'subagent-line';
    subagentLine.hidden = true;
    const subagentIcon = document.createElement('span');
    subagentIcon.className = 'subagent-icon';
    subagentIcon.innerHTML = ICON_BOT;
    const subagentName = document.createElement('span');
    subagentName.className = 'subagent-name';
    const subagentDesc = document.createElement('span');
    subagentDesc.className = 'subagent-desc';
    subagentLine.appendChild(subagentIcon);
    subagentLine.appendChild(subagentName);
    subagentLine.appendChild(subagentDesc);
    card.appendChild(subagentLine);

    const footer = buildFooter(
      run,
      ICON_CLOCK + '<span class="elapsed-text"></span>',
      buildMenu(run, [
        {
          text: 'หยุดชั่วคราว',
          icon: ICON_PAUSE,
          danger: true,
          onClick: () => doStopOrCancel(run.id),
        },
      ]),
    );
    card.appendChild(footer);

    container.appendChild(card);
    updateElapsedDisplay();
    updateRunningSubAgentDisplay();
  }

  function updateElapsedDisplay() {
    if (!runningElapsedRunId) return;
    const run = runsById.get(runningElapsedRunId);
    if (!run) return;
    const el = els.runningContainer.querySelector('.elapsed-text');
    if (!el) return;
    const mins = minutesBetween(run.startedAt, null);
    el.textContent = (mins == null ? '–' : mins) + ' นาที';
  }

  function updateRunningSubAgentDisplay() {
    const line = els.runningContainer.querySelector('.subagent-line');
    if (!line) return;
    if (currentSubAgent) {
      line.hidden = false;
      const nameSpan = line.querySelector('.subagent-name');
      const descSpan = line.querySelector('.subagent-desc');
      if (nameSpan) {
        nameSpan.textContent = currentSubAgent.name;
        nameSpan.style.color = hashAgentColor(currentSubAgent.name);
      }
      if (descSpan) descSpan.textContent = ' - ' + currentSubAgent.description;
    } else {
      line.hidden = true;
    }
  }

  // --- queue cards ---

  function renderQueueSection(queuedRuns) {
    els.queueCount.textContent = String(queuedRuns.length);
    els.queueList.textContent = '';
    if (queuedRuns.length === 0) {
      const p = document.createElement('div');
      p.className = 'lane-empty';
      p.textContent = 'ว่าง';
      els.queueList.appendChild(p);
      return;
    }

    for (const run of queuedRuns) {
      const card = document.createElement('div');
      card.className = 'run-card run-card--queued';
      card.dataset.runId = run.id;

      card.appendChild(buildRunLabel(run.path));

      const footer = buildFooter(
        run,
        ICON_CLOCK + 'เข้าคิว ' + formatHHMM(run.queuedAt),
        buildMenu(run, [
          { text: 'ยกเลิก', icon: ICON_X, danger: true, onClick: () => doStopOrCancel(run.id) },
        ]),
      );
      card.appendChild(footer);

      els.queueList.appendChild(card);
    }
  }

  // --- history cards ---

  function renderHistorySection(historyRuns) {
    els.endCount.textContent = String(historyRuns.length);
    els.historyList.textContent = '';
    if (historyRuns.length === 0) {
      const p = document.createElement('div');
      p.className = 'lane-empty';
      p.textContent = 'ว่าง';
      els.historyList.appendChild(p);
      return;
    }

    for (const run of historyRuns) {
      const card = document.createElement('div');
      card.className = 'run-card run-card--history run-card--' + run.status;
      card.dataset.runId = run.id;

      card.appendChild(buildRunLabel(run.path));

      const footer = document.createElement('div');
      footer.className = 'run-card-footer';
      card.appendChild(footer);
      buildHistoryCardFooter(footer, run);

      els.historyList.appendChild(card);
    }
  }

  // done -> [เริ่มใหม่, ตรวจทาน (always — opens ตรวจทาน/index.html directly), เรียนรู้ (disabled)]
  // error/stopped -> [เริ่มใหม่] alone
  function buildHistoryCardFooter(footerEl, run) {
    footerEl.textContent = '';

    const timeSpan = document.createElement('span');
    timeSpan.className = 'footer-time';
    const mins = minutesBetween(run.startedAt, run.endedAt);
    timeSpan.innerHTML = ICON_CLOCK + (mins == null ? '–' : mins) + ' นาที';
    if (run.status === 'error') {
      const chip = document.createElement('span');
      chip.className = 'chip error';
      const chipIcon = document.createElement('span');
      chipIcon.className = 'chip-icon';
      chipIcon.innerHTML = ICON_ALERT;
      chip.appendChild(chipIcon);
      chip.appendChild(document.createTextNode(STATUS_LABEL.error));
      timeSpan.appendChild(chip);
    }
    footerEl.appendChild(timeSpan);

    const itemConfigs = [
      { text: 'เริ่มใหม่', icon: ICON_ROTATE_CCW, onClick: () => doRestart(run) },
    ];

    if (run.status === 'done') {
      itemConfigs.push({
        text: 'ตรวจทาน',
        icon: ICON_EXTERNAL_LINK,
        onClick: () => {
          window.open(
            '/files/' + encodeRelPath(joinRel(run.path, 'ตรวจทาน/index.html')),
            '_blank',
            'noopener',
          );
        },
      });
      itemConfigs.push({ text: 'เรียนรู้', icon: ICON_GRADUATION_CAP, disabled: true });
    }

    footerEl.appendChild(buildMenu(run, itemConfigs));
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

  // Dismiss the open ••• menu on any outside click or Escape. Because every
  // internal menu click (menu-btn, menu-item) calls stopPropagation(), a click
  // reaching this listener while a menu is open is necessarily outside it — no
  // .closest()/.contains() containment check is needed. Registered exactly once
  // here, never inside a render function (which re-runs every 10s poll).
  document.addEventListener('click', () => {
    if (openMenuRunId != null) closeMenu();
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && openMenuRunId != null) closeMenu();
  });

  applyRoute();
  loadConfig();
  loadClients();
  loadRuns();
  setInterval(loadRuns, 10000);
  setInterval(updateElapsedDisplay, 25000);
})();
