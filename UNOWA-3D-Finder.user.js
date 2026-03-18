// ==UserScript==
// @name         UNOWA Finder + Export Logger
// @namespace    https://unowa.eu/
// @version      2.8.1
// @description  Search UNOWA models and export embed iframe catalog with stable sequential pagination
// @author       ChatGPT
// @match        https://*.unowa.eu/*
// @run-at       document-idle
// @grant        none
// @homepageURL  https://github.com/YOUR_GITHUB_USERNAME/YOUR_REPO
// @supportURL   https://github.com/YOUR_GITHUB_USERNAME/YOUR_REPO/issues
// @updateURL    https://raw.githubusercontent.com/Lex-Dorosh/UNOWA/main/UNOWA-3D-Finder.user.js
// @downloadURL  https://raw.githubusercontent.com/Lex-Dorosh/UNOWA/main/UNOWA-3D-Finder.user.js
// ==/UserScript==

(function () {
  'use strict';

  if (window.__UNOWA_FINDER_V281__) return;
  window.__UNOWA_FINDER_V281__ = true;

  const CFG = {
    ui: {
      width: 590,
      zIndex: 2147483000
    },
    timings: {
      pollMs: 80,
      stableForMs: 180,
      shortMs: 120,
      clickSettleMs: 130,
      typeSwitchMs: 260,
      menuOpenMs: 260,
      menuActionMs: 360,
      tableTimeoutMs: 3000,
      pageMoveTimeoutMs: 3200
    },
    retries: {
      pageMove: 4,
      pageReady: 3,
      embedSameRow: 3,
      embedRecovery: 3,
      rowRefind: 3,
      langSwitch: 3
    },
    storage: {
      minimized: 'unowaFinder.minimized',
      hidden: 'unowaFinder.hidden',
      position: 'unowaFinder.position',
      query: 'unowaFinder.query',
      lang: 'unowaFinder.lang',
      exportAllLangs: 'unowaFinder.exportAllLangs'
    }
  };

  const state = {
    running: false,
    stopRequested: false,
    results: [],
    failures: [],
    logs: [],
    panelMode: 'results',
    lastHighlightedRow: null,
    hidden: localStorage.getItem(CFG.storage.hidden) === '1',
    minimized: localStorage.getItem(CFG.storage.minimized) === '1',
    drag: { active: false, dx: 0, dy: 0 },
    ui: {}
  };

  const sleep = (ms) => new Promise(r => setTimeout(r, ms));
  const q = (sel, root = document) => root.querySelector(sel);
  const qa = (sel, root = document) => Array.from(root.querySelectorAll(sel));
  const norm = (s) => String(s || '').replace(/\u00A0/g, ' ').replace(/\s+/g, ' ').trim();
  const lower = (s) => norm(s).toLowerCase();
  const escHtml = (s) => String(s || '').replace(/[&<>"']/g, m => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' }[m]));
  const clamp = (n, min, max) => Math.max(min, Math.min(max, n));

  function clickEl(el) {
    if (!el) return false;
    try { el.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' }); } catch {}
    try {
      el.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }));
      el.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
      el.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
      el.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      return true;
    } catch {}
    try { el.click(); return true; } catch {}
    return false;
  }

  async function waitUntil(fn, timeoutMs = 2000, pollMs = 100) {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      try {
        const v = fn();
        if (v) return v;
      } catch {}
      await sleep(pollMs);
    }
    return null;
  }

  function isVisible(el) {
    if (!el) return false;
    const cs = getComputedStyle(el);
    const r = el.getBoundingClientRect();
    return cs.display !== 'none' && cs.visibility !== 'hidden' && r.width > 0 && r.height > 0;
  }

  function savePos(x, y) {
    try { localStorage.setItem(CFG.storage.position, JSON.stringify({ x, y })); } catch {}
  }

  function loadPos() {
    try {
      const raw = localStorage.getItem(CFG.storage.position);
      if (!raw) return null;
      const p = JSON.parse(raw);
      if (!p || typeof p.x !== 'number' || typeof p.y !== 'number') return null;
      return p;
    } catch {
      return null;
    }
  }

  function applyPos(x, y) {
    const root = state.ui.root;
    if (!root) return;
    const vw = window.innerWidth || document.documentElement.clientWidth || 1400;
    const vh = window.innerHeight || document.documentElement.clientHeight || 900;
    const w = CFG.ui.width;
    const h = Math.max(60, root.offsetHeight || 60);
    const nx = clamp(Math.round(x), 0, Math.max(0, vw - w));
    const ny = clamp(Math.round(y), 0, Math.max(0, vh - Math.min(h, vh)));
    root.style.left = `${nx}px`;
    root.style.top = `${ny}px`;
    root.style.right = 'auto';
    root.style.bottom = 'auto';
    savePos(nx, ny);
  }

  function setStatus(text) {
    if (state.ui.status) state.ui.status.textContent = text;
  }

  function appendLog(text, kind = 'info') {
    const now = new Date();
    const hh = String(now.getHours()).padStart(2, '0');
    const mm = String(now.getMinutes()).padStart(2, '0');
    const ss = String(now.getSeconds()).padStart(2, '0');

    state.logs.push({
      ts: `${hh}:${mm}:${ss}`,
      text: String(text || ''),
      kind
    });

    if (state.logs.length > 2500) state.logs = state.logs.slice(-2000);

    if (state.panelMode === 'logs') renderLogs();
  }

  function setPanelMode(mode) {
    state.panelMode = mode === 'logs' ? 'logs' : 'results';
    if (state.ui.resultsTab) state.ui.resultsTab.classList.toggle('active', state.panelMode === 'results');
    if (state.ui.logsTab) state.ui.logsTab.classList.toggle('active', state.panelMode === 'logs');
    renderPanel();
  }

  function renderPanel() {
    if (state.panelMode === 'logs') renderLogs();
    else renderResults();
  }

  function injectStyles() {
    if (q('#unowaFinderStyles')) return;
    const st = document.createElement('style');
    st.id = 'unowaFinderStyles';
    st.textContent = `
#unowaFinderRoot{position:fixed;top:12px;right:12px;width:${CFG.ui.width}px;z-index:${CFG.ui.zIndex};font:12px/1.35 Arial,sans-serif;color:#eaeaea}
#unowaFinderRoot.hidden{display:none}
#unowaFinderPanel{background:#1f2329;border:1px solid #3a404a;border-radius:12px;box-shadow:0 8px 28px rgba(0,0,0,.35);overflow:hidden}
#unowaFinderHeader{display:flex;align-items:center;justify-content:space-between;padding:8px 10px;background:#2a3038;border-bottom:1px solid #3a404a;gap:8px;cursor:move;user-select:none}
#unowaFinderTitle{font-weight:700;letter-spacing:.2px}
#unowaFinderHeaderBtns{display:flex;gap:6px}
.uf-iconbtn{border:1px solid #515966;background:#39424d;color:#fff;border-radius:8px;padding:2px 8px;cursor:pointer;font-size:12px}
.uf-iconbtn:hover{background:#485465}
#unowaFinderBody{padding:10px;display:flex;flex-direction:column;gap:8px;max-height:82vh}
#unowaFinderBody.min{display:none}
#unowaFinderLauncher{position:fixed;top:12px;right:12px;z-index:${CFG.ui.zIndex};display:none;background:#1f2329;color:#fff;border:1px solid #3a404a;border-radius:999px;padding:8px 12px;box-shadow:0 8px 28px rgba(0,0,0,.35);cursor:pointer;font:12px Arial,sans-serif}
#unowaFinderLauncher.show{display:block}
#ufQuery{width:100%;box-sizing:border-box;padding:8px 10px;border-radius:8px;border:1px solid #4b5462;background:#111418;color:#fff;outline:none}
#ufQuery:focus{border-color:#7ea6ff;box-shadow:0 0 0 2px rgba(126,166,255,.22)}
.uf-row{display:flex;gap:8px;align-items:center;flex-wrap:wrap}
.uf-check{display:inline-flex;gap:4px;align-items:center}
.uf-select{padding:5px 6px;border-radius:8px;border:1px solid #4b5462;background:#111418;color:#fff}
.uf-btn{border:1px solid #4e6db3;background:#3359c8;color:#fff;border-radius:8px;padding:6px 10px;cursor:pointer;font-weight:600}
.uf-btn:hover{background:#3f66d7}
.uf-btn.secondary{border-color:#515966;background:#39424d}
.uf-btn.secondary:hover{background:#485465}
.uf-btn.stop{border-color:#8f3f4a;background:#7c2f3a}
.uf-btn.stop:hover{background:#8c3845}
.uf-btn.export{border-color:#5a8a50;background:#2f7c3a}
.uf-btn.export:hover{background:#399346}
.uf-btn:disabled{opacity:.55;cursor:not-allowed}
#ufStatus{padding:6px 8px;border:1px solid #3a404a;border-radius:8px;background:#151a1f;color:#d5d9e0;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
#ufPanelTabs{display:flex;gap:6px}
.uf-tab{border:1px solid #4e5662;background:#222831;color:#d9dfeb;border-radius:8px;padding:4px 8px;cursor:pointer}
.uf-tab.active{background:#3658b8;border-color:#5e83ef;color:#fff}
#ufPanelHost{border:1px solid #3a404a;border-radius:10px;background:#111418;overflow:auto;min-height:140px;max-height:52vh;padding:6px}
.uf-empty{opacity:.75;padding:8px}
.uf-item{border:1px solid #313844;border-radius:10px;background:#171c22;padding:8px;margin-bottom:6px}
.uf-item:last-child{margin-bottom:0}
.uf-top{display:flex;justify-content:space-between;gap:8px;align-items:flex-start}
.uf-badges{display:flex;gap:6px;flex-wrap:wrap}
.uf-badge{padding:2px 6px;border-radius:999px;border:1px solid #4d5766;background:#232a33;color:#d8deea;font-size:11px}
.uf-model{font-weight:700;color:#fff;margin:6px 0 4px;word-break:break-word}
.uf-desc{color:#cdd3dd;opacity:.92;word-break:break-word;max-height:48px;overflow:hidden}
.uf-actions{display:flex;gap:6px;margin-top:8px;flex-wrap:wrap}
.uf-linkbtn{border:1px solid #4f5f75;background:#243243;color:#fff;border-radius:8px;padding:4px 8px;cursor:pointer;font-size:12px}
.uf-linkbtn:hover{background:#2e4056}
.uf-linkbtn.alt{background:#2d2734;border-color:#675683}
.uf-linkbtn.alt:hover{background:#3a3145}
.uf-small{opacity:.8;font-size:11px}
.uf-log{font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;border-bottom:1px solid #232931;padding:4px 2px;white-space:pre-wrap;word-break:break-word}
.uf-log:last-child{border-bottom:none}
.uf-log .t{opacity:.7;margin-right:8px}
.uf-log.info{color:#d7dcef}
.uf-log.ok{color:#9de3a6}
.uf-log.warn{color:#ffd27a}
.uf-log.err{color:#ff9088}
.uf-highlight-row{outline:3px solid #ff2d2d !important;outline-offset:-2px;background:rgba(255,45,45,.18) !important;box-shadow:inset 0 0 0 1px rgba(255,45,45,.40) !important}
`;
    document.head.appendChild(st);
  }

  function updateButtons() {
    if (!state.ui.startBtn) return;
    state.ui.startBtn.disabled = state.running;
    state.ui.exportBtn.disabled = state.running;
    state.ui.stopBtn.disabled = !state.running;
  }

  function createResultKey(lang, type, model, desc) {
    return `${lang || ''}||${type || ''}||${lower(model)}||${lower(desc)}`;
  }

  function addResult(item) {
    const key = createResultKey(item.lang, item.type, item.model, item.description);
    if (state.results.some(x => x.uniqueKey === key)) return false;
    item.uniqueKey = key;
    state.results.push(item);
    return true;
  }

  function renderResults() {
    const box = state.ui.panelHost;
    if (!box) return;
    state.ui.count.textContent = String(state.results.length);

    if (!state.results.length) {
      box.innerHTML = `<div class="uf-empty">Результаты появятся здесь</div>`;
      return;
    }

    box.innerHTML = '';
    state.results.forEach((r, idx) => {
      const div = document.createElement('div');
      div.className = 'uf-item';
      div.innerHTML = `
        <div class="uf-top">
          <div class="uf-badges">
            <span class="uf-badge">${idx + 1}</span>
            <span class="uf-badge">${escHtml(r.lang || '')}</span>
            <span class="uf-badge">${escHtml(r.type)}</span>
            <span class="uf-badge">page ${r.page}</span>
          </div>
          <div class="uf-small">row ${r.rowIndex}</div>
        </div>
        <div class="uf-model">${escHtml(r.model)}</div>
        <div class="uf-desc">${escHtml(r.description)}</div>
        <div class="uf-actions">
          <button class="uf-linkbtn" data-act="open">Перейти к строке</button>
          <button class="uf-linkbtn alt" data-act="actions">Открыть Actions</button>
        </div>
      `;

      div.addEventListener('click', async (e) => {
        const btn = e.target.closest('button[data-act]');
        if (!btn) return;
        const act = btn.getAttribute('data-act');
        btn.disabled = true;
        try {
          if (act === 'open') {
            btn.textContent = 'Переход...';
            await navigateToResult(r, false);
          } else {
            btn.textContent = 'Открываю...';
            await navigateToResult(r, true);
          }
        } catch (err) {
          setStatus(`Ошибка перехода: ${err?.message || err}`);
          appendLog(`Переход к результату не удался: ${err?.message || err}`, 'err');
        } finally {
          btn.disabled = false;
          btn.textContent = act === 'open' ? 'Перейти к строке' : 'Открыть Actions';
        }
      });

      box.appendChild(div);
    });
  }

  function renderLogs() {
    const box = state.ui.panelHost;
    if (!box) return;

    if (!state.logs.length) {
      box.innerHTML = `<div class="uf-empty">Логи появятся здесь</div>`;
      return;
    }

    const stickBottom = Math.abs((box.scrollTop + box.clientHeight) - box.scrollHeight) < 24;
    box.innerHTML = state.logs.map(l => `
      <div class="uf-log ${escHtml(l.kind)}"><span class="t">${escHtml(l.ts)}</span>${escHtml(l.text)}</div>
    `).join('');

    if (stickBottom || state.running) box.scrollTop = box.scrollHeight;
  }

  function createUI() {
    if (q('#unowaFinderRoot')) return;

    injectStyles();

    const root = document.createElement('div');
    root.id = 'unowaFinderRoot';
    if (state.hidden) root.classList.add('hidden');

    const panel = document.createElement('div');
    panel.id = 'unowaFinderPanel';

    const header = document.createElement('div');
    header.id = 'unowaFinderHeader';
    header.innerHTML = `
      <div id="unowaFinderTitle">🔎 UNOWA Finder</div>
      <div id="unowaFinderHeaderBtns">
        <button class="uf-iconbtn" id="ufMinBtn">${state.minimized ? '▢' : '—'}</button>
        <button class="uf-iconbtn" id="ufCloseBtn">✕</button>
      </div>
    `;

    const body = document.createElement('div');
    body.id = 'unowaFinderBody';
    if (state.minimized) body.classList.add('min');

    const savedQuery = localStorage.getItem(CFG.storage.query) || '';
    const savedLang = localStorage.getItem(CFG.storage.lang) || 'keep';
    const savedExportAll = localStorage.getItem(CFG.storage.exportAllLangs) === '1';

    body.innerHTML = `
      <input id="ufQuery" placeholder="Запрос (например: глаз / eye)" value="${escHtml(savedQuery)}">
      <div class="uf-row">
        <label class="uf-check"><input type="checkbox" id="ufScanStructure" checked> Structure</label>
        <label class="uf-check"><input type="checkbox" id="ufScanAnimation" checked> Animation</label>
      </div>
      <div class="uf-row">
        <span>Язык:</span>
        <select id="ufLanguage" class="uf-select">
          <option value="keep">Текущий</option>
          <option value="en">English</option>
          <option value="ru">Русский</option>
        </select>
        <label class="uf-check"><input type="checkbox" id="ufExportAllLangs"> Export all languages</label>
      </div>
      <div class="uf-row">
        <button id="ufStartBtn" class="uf-btn">Start</button>
        <button id="ufStopBtn" class="uf-btn stop" disabled>Stop</button>
        <button id="ufClearBtn" class="uf-btn secondary">Clear</button>
        <button id="ufExportBtn" class="uf-btn export">Export catalog CSV</button>
        <span class="uf-small">Найдено: <b id="ufCount">0</b></span>
      </div>
      <div id="ufStatus">Готов. Введите запрос и нажмите Start</div>
      <div class="uf-row" style="justify-content:space-between">
        <div id="ufPanelTabs">
          <button class="uf-tab active" id="ufResultsTab">Results</button>
          <button class="uf-tab" id="ufLogsTab">Logs</button>
        </div>
      </div>
      <div id="ufPanelHost"><div class="uf-empty">Результаты появятся здесь</div></div>
    `;

    panel.appendChild(header);
    panel.appendChild(body);
    root.appendChild(panel);
    document.body.appendChild(root);

    const launcher = document.createElement('button');
    launcher.id = 'unowaFinderLauncher';
    launcher.textContent = '🔎 UNOWA Finder';
    if (state.hidden) launcher.classList.add('show');
    document.body.appendChild(launcher);

    state.ui = {
      root,
      panel,
      header,
      body,
      launcher,
      query: q('#ufQuery', root),
      scanStructure: q('#ufScanStructure', root),
      scanAnimation: q('#ufScanAnimation', root),
      language: q('#ufLanguage', root),
      exportAllLangs: q('#ufExportAllLangs', root),
      startBtn: q('#ufStartBtn', root),
      stopBtn: q('#ufStopBtn', root),
      clearBtn: q('#ufClearBtn', root),
      exportBtn: q('#ufExportBtn', root),
      status: q('#ufStatus', root),
      panelHost: q('#ufPanelHost', root),
      count: q('#ufCount', root),
      minBtn: q('#ufMinBtn', root),
      closeBtn: q('#ufCloseBtn', root),
      resultsTab: q('#ufResultsTab', root),
      logsTab: q('#ufLogsTab', root)
    };

    state.ui.language.value = ['keep', 'en', 'ru'].includes(savedLang) ? savedLang : 'keep';
    state.ui.exportAllLangs.checked = !!savedExportAll;

    bindUI();
    bindDrag();

    const pos = loadPos();
    if (pos) requestAnimationFrame(() => applyPos(pos.x, pos.y));

    updateButtons();
    renderPanel();
  }

  function bindDrag() {
    const { header, root } = state.ui;
    if (!header || !root) return;

    function isInteractive(el) {
      return !!(el.closest('button') || el.closest('input') || el.closest('select') || el.closest('textarea') || el.closest('a') || el.closest('label'));
    }

    header.addEventListener('pointerdown', (e) => {
      if (e.button !== 0) return;
      if (isInteractive(e.target)) return;
      const r = root.getBoundingClientRect();
      state.drag.active = true;
      state.drag.dx = e.clientX - r.left;
      state.drag.dy = e.clientY - r.top;
      root.style.left = `${r.left}px`;
      root.style.top = `${r.top}px`;
      root.style.right = 'auto';
      try { header.setPointerCapture(e.pointerId); } catch {}
      e.preventDefault();
    });

    window.addEventListener('pointermove', (e) => {
      if (!state.drag.active) return;
      applyPos(e.clientX - state.drag.dx, e.clientY - state.drag.dy);
      e.preventDefault();
    });

    window.addEventListener('pointerup', () => { state.drag.active = false; });
    window.addEventListener('pointercancel', () => { state.drag.active = false; });
    window.addEventListener('resize', () => {
      const r = root.getBoundingClientRect();
      applyPos(r.left, r.top);
    });
  }

  function bindUI() {
    const ui = state.ui;

    ui.minBtn.addEventListener('click', () => {
      state.minimized = !state.minimized;
      localStorage.setItem(CFG.storage.minimized, state.minimized ? '1' : '0');
      ui.body.classList.toggle('min', state.minimized);
      ui.minBtn.textContent = state.minimized ? '▢' : '—';
    });

    ui.closeBtn.addEventListener('click', () => {
      state.hidden = true;
      localStorage.setItem(CFG.storage.hidden, '1');
      ui.root.classList.add('hidden');
      ui.launcher.classList.add('show');
    });

    ui.launcher.addEventListener('click', () => {
      state.hidden = false;
      localStorage.setItem(CFG.storage.hidden, '0');
      ui.root.classList.remove('hidden');
      ui.launcher.classList.remove('show');
    });

    ui.startBtn.addEventListener('click', () => {
      runSearch().catch(err => {
        state.running = false;
        updateButtons();
        setStatus(`Ошибка: ${err?.message || err}`);
        appendLog(`Search fatal: ${err?.message || err}`, 'err');
      });
    });

    ui.exportBtn.addEventListener('click', () => {
      exportCatalog().catch(err => {
        state.running = false;
        updateButtons();
        setStatus(`Ошибка экспорта: ${err?.message || err}`);
        appendLog(`Export fatal: ${err?.message || err}`, 'err');
      });
    });

    ui.stopBtn.addEventListener('click', () => {
      state.stopRequested = true;
      setStatus('Остановка...');
      appendLog('Пользователь запросил остановку', 'warn');
    });

    ui.clearBtn.addEventListener('click', () => {
      state.results = [];
      state.logs = [];
      clearHighlight();
      renderPanel();
      setStatus('Очищено');
    });

    ui.query.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !state.running) {
        e.preventDefault();
        ui.startBtn.click();
      }
    });

    ui.language.addEventListener('change', () => {
      localStorage.setItem(CFG.storage.lang, ui.language.value);
    });

    ui.exportAllLangs.addEventListener('change', () => {
      localStorage.setItem(CFG.storage.exportAllLangs, ui.exportAllLangs.checked ? '1' : '0');
    });

    ui.resultsTab.addEventListener('click', () => setPanelMode('results'));
    ui.logsTab.addEventListener('click', () => setPanelMode('logs'));
  }

  function mapLangDisplayToCode(text) {
    const t = lower(text);
    if (!t) return null;
    if (t.includes('english')) return 'en';
    if (t.includes('рус') || t.includes('russian')) return 'ru';
    return null;
  }

  function getSelectedTypesFromUI() {
    const out = [];
    if (state.ui.scanStructure?.checked) out.push('structure');
    if (state.ui.scanAnimation?.checked) out.push('animation');
    return out;
  }

  function getTable() {
    return qa('table').find(t => qa('tbody tr', t).length && qa('button[aria-haspopup="menu"]', t).length) || q('table.mantine-Table-table') || q('table');
  }

  function getTbody() {
    const t = getTable();
    return t ? (q('tbody', t) || t.tBodies?.[0] || null) : null;
  }

  function getRows() {
    const tbody = getTbody();
    if (!tbody) return [];
    return qa(':scope > tr', tbody).filter(tr => qa('td', tr).length >= 2);
  }

  function getRowData(row) {
    const tds = qa('td', row);
    const model = norm(tds[0]?.innerText || tds[0]?.textContent || '');
    const description = norm(tds[1]?.innerText || tds[1]?.textContent || '');
    const actionBtn = q('button[aria-haspopup="menu"]', row) || q('button', tds[2] || row);
    return { row, tds, model, description, actionBtn };
  }

  function rowContentSignature(row) {
    const rd = getRowData(row);
    return `${lower(rd.model)}||${lower(rd.description)}`;
  }

  function getRowsSignature() {
    const rows = getRows();
    return rows.map(rowContentSignature).join('###');
  }

  function getTotalTextNode() {
    const nodes = qa('p,span,div');
    return nodes.find(el => /^Total:\s*\d+$/i.test(norm(el.textContent)));
  }

  function parseTotalItems() {
    const el = getTotalTextNode();
    if (!el) return null;
    const m = norm(el.textContent).match(/^Total:\s*(\d+)$/i);
    return m ? Number(m[1]) : null;
  }

  function getPaginationRoot() {
    return qa('.mantine-Pagination-root').find(isVisible) || q('.mantine-Pagination-root');
  }

  function getPaginationInfo() {
    const root = getPaginationRoot();
    if (!root) return { current: null, totalPages: null, buttons: [] };
    const buttons = qa('button', root).filter(isVisible);
    const curBtn = q('button[aria-current="page"]', root);
    const current = curBtn ? Number(norm(curBtn.textContent)) || null : null;
    const nums = buttons.map(b => Number(norm(b.textContent))).filter(n => Number.isFinite(n));
    const totalPages = nums.length ? Math.max(...nums) : null;
    return { current, totalPages, buttons, root };
  }

  function getPrevNextButtons() {
    const root = getPaginationRoot();
    if (!root) return { prev: null, next: null };
    const btns = qa('button', root).filter(isVisible);
    if (btns.length < 2) return { prev: null, next: null };
    return { prev: btns[0], next: btns[btns.length - 1] };
  }

  function getTypeInputs() {
    return qa('input[type="radio"]').filter(i => ['structure', 'animation'].includes(String(i.value || '').toLowerCase()));
  }

  function getCurrentType() {
    const inp = getTypeInputs().find(i => i.checked);
    return inp ? String(inp.value).toLowerCase() : null;
  }

  function getTypeLabel(value) {
    const inp = getTypeInputs().find(i => String(i.value).toLowerCase() === value);
    if (!inp) return null;
    if (inp.id) {
      const esc = window.CSS && CSS.escape ? CSS.escape(inp.id) : inp.id.replace(/"/g, '\\"');
      const lbl = document.querySelector(`label[for="${esc}"]`);
      if (lbl) return lbl;
    }
    return inp.closest('label') || inp.closest('div') || inp;
  }

  async function ensureType(value) {
    value = String(value).toLowerCase();
    if (getCurrentType() === value) return true;
    const target = getTypeLabel(value);
    if (!target) throw new Error(`Не найден переключатель типа ${value}`);
    const beforeSig = getRowsSignature();
    clickEl(target);
    await sleep(CFG.timings.typeSwitchMs);
    await waitUntil(() => getCurrentType() === value, 1800, 70);
    await waitForTableStable({ requireRows: true, timeoutMs: CFG.timings.tableTimeoutMs, previousRowsSig: beforeSig });
    if (getCurrentType() !== value) throw new Error(`Не удалось переключить тип на ${value}`);
    appendLog(`Тип переключен: ${value}`, 'ok');
    return true;
  }

  function getHiddenInputForSelectWrapper(wrapper) {
    if (!wrapper) return null;

    let n = wrapper.nextElementSibling;
    while (n) {
      if (n.matches && n.matches('input[type="hidden"]')) return n;
      if (n.matches && n.matches('.mantine-InputWrapper-root, .mantine-Select-root')) break;
      n = n.nextElementSibling;
    }

    const parent = wrapper.parentElement;
    if (parent) {
      const children = Array.from(parent.children);
      const idx = children.indexOf(wrapper);
      for (let i = idx + 1; i < children.length; i++) {
        const el = children[i];
        if (el.matches?.('input[type="hidden"]')) return el;
        if (el.matches?.('.mantine-InputWrapper-root, .mantine-Select-root')) break;
      }
    }

    return null;
  }

  function getLanguageSelectWrapper() {
    const wrappers = qa('.mantine-Select-root').filter(isVisible);
    for (const w of wrappers) {
      const display = q('input.mantine-Select-input[readonly]', w);
      if (!display) continue;
      const hidden = getHiddenInputForSelectWrapper(w);
      const hv = String(hidden?.value || '').toLowerCase();
      const dv = mapLangDisplayToCode(display.value);
      if (['en', 'ru'].includes(hv) || dv) return w;
    }
    return null;
  }

  function getLanguageValue() {
    const w = getLanguageSelectWrapper();
    if (!w) return null;
    const hidden = getHiddenInputForSelectWrapper(w);
    const hv = String(hidden?.value || '').toLowerCase();
    if (['en', 'ru'].includes(hv)) return hv;
    const display = q('input.mantine-Select-input[readonly]', w);
    return mapLangDisplayToCode(display?.value || '') || null;
  }

  function getOpenOptions() {
    const selectors = ['[role="option"]', '.mantine-Combobox-option', '[data-combobox-option]'];
    const all = selectors.flatMap(s => qa(s));
    return Array.from(new Set(all)).filter(isVisible).filter(el => norm(el.textContent));
  }

  async function closePopups() {
    try {
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
      document.dispatchEvent(new KeyboardEvent('keyup', { key: 'Escape', bubbles: true }));
    } catch {}
    await sleep(70);
  }

  async function openSelectAndChoose(wrapper, chooser) {
    const input = q('input.mantine-Select-input[readonly]', wrapper);
    if (!input) return false;
    clickEl(input);
    await sleep(CFG.timings.clickSettleMs);

    let opts = getOpenOptions();
    if (!opts.length) opts = await waitUntil(() => getOpenOptions(), 1200, 60) || [];
    if (!opts.length) return false;

    const chosen = chooser(opts);
    if (!chosen) {
      await closePopups();
      return false;
    }

    clickEl(chosen);
    await sleep(CFG.timings.clickSettleMs);
    return true;
  }

  async function ensureLanguage(lang) {
    if (!lang || lang === 'keep') return true;
    if (!['en', 'ru'].includes(lang)) return false;

    for (let attempt = 1; attempt <= CFG.retries.langSwitch; attempt++) {
      const current = getLanguageValue();
      if (current === lang) return true;

      const wrapper = getLanguageSelectWrapper();
      if (!wrapper) return false;

      const beforeSig = getRowsSignature();
      const ok = await openSelectAndChoose(wrapper, opts => opts.find(o => mapLangDisplayToCode(o.textContent) === lang) || null);
      if (!ok) {
        await sleep(130 * attempt);
        continue;
      }

      await waitUntil(() => getLanguageValue() === lang, 1800, 70);
      await waitForTableStable({ requireRows: true, timeoutMs: CFG.timings.tableTimeoutMs, previousRowsSig: beforeSig });

      if (getLanguageValue() === lang) {
        appendLog(`Язык переключен: ${lang}`, 'ok');
        return true;
      }

      await sleep(120 * attempt);
    }

    return getLanguageValue() === lang;
  }

  async function getAvailableLanguages() {
    const wrapper = getLanguageSelectWrapper();
    const found = [];

    if (!wrapper) {
      const cur = getLanguageValue();
      if (cur && ['en', 'ru'].includes(cur)) return [{ value: cur, label: cur }];
      return [{ value: 'en', label: 'English' }, { value: 'ru', label: 'Русский' }];
    }

    const input = q('input.mantine-Select-input[readonly]', wrapper);
    const originalDisplay = input ? norm(input.value) : '';
    const originalCode = getLanguageValue();

    clickEl(input);
    await sleep(CFG.timings.clickSettleMs);

    let opts = getOpenOptions();
    if (!opts.length) opts = await waitUntil(() => getOpenOptions(), 1200, 60) || [];
    for (const o of opts) {
      const code = mapLangDisplayToCode(o.textContent);
      const label = norm(o.textContent);
      if (code && !found.some(x => x.value === code)) found.push({ value: code, label });
    }

    await closePopups();

    if (!found.length && originalCode && ['en', 'ru'].includes(originalCode)) {
      found.push({ value: originalCode, label: originalDisplay || originalCode });
    }

    if (!found.length) {
      found.push({ value: 'en', label: 'English' }, { value: 'ru', label: 'Русский' });
    }

    return found.filter(x => ['en', 'ru'].includes(x.value));
  }

  function hasModelsTableUI() {
    const table = getTable();
    const rows = getRows();
    const hasActions = !!q('button[aria-haspopup="menu"]', table || document);
    const pag = getPaginationRoot();
    const total = getTotalTextNode();
    return !!table && !!hasActions && (!!rows.length || !!pag || !!total);
  }

  async function waitFor3DModelsPage(timeoutMs = 12000) {
    setStatus('Ожидание страницы 3D models...');
    const ok = await waitUntil(() => hasModelsTableUI(), timeoutMs, 160);
    if (!ok) throw new Error('Страница 3D models не обнаружена');
    setStatus('Страница 3D models обнаружена');
    appendLog('Страница 3D models обнаружена', 'ok');
    return true;
  }

  function getTableSnapshot() {
    const rows = getRows();
    const p = getPaginationInfo();
    return {
      rows: rows.length,
      current: p.current,
      totalPages: p.totalPages,
      total: parseTotalItems(),
      type: getCurrentType(),
      lang: getLanguageValue(),
      rowsSig: getRowsSignature()
    };
  }

  async function waitForTableStable(opts = {}) {
    const timeoutMs = opts.timeoutMs ?? CFG.timings.tableTimeoutMs;
    const expectedPage = opts.expectedPage ?? null;
    const requireRows = !!opts.requireRows;
    const previousRowsSig = opts.previousRowsSig ?? null;

    let lastSig = '';
    let lastChange = Date.now();
    let lastSnap = getTableSnapshot();
    const start = Date.now();

    while (Date.now() - start < timeoutMs) {
      const snap = getTableSnapshot();
      lastSnap = snap;

      const sig = JSON.stringify({
        rows: snap.rows,
        current: snap.current,
        totalPages: snap.totalPages,
        total: snap.total,
        type: snap.type,
        lang: snap.lang,
        rowsSig: snap.rowsSig
      });

      if (sig !== lastSig) {
        lastSig = sig;
        lastChange = Date.now();
      }

      const pageOk = expectedPage == null || snap.current === expectedPage;
      const rowsOk = !requireRows || snap.rows > 0;
      const contentOk = !previousRowsSig || (snap.rowsSig && snap.rowsSig !== previousRowsSig) || (snap.current === expectedPage && snap.rows > 0);

      if (pageOk && rowsOk && contentOk && (Date.now() - lastChange) >= CFG.timings.stableForMs) {
        return snap;
      }

      await sleep(CFG.timings.pollMs);
    }

    return lastSnap;
  }

  async function moveOnePage(direction, previousRowsSig = null) {
    const dir = direction === 'prev' ? 'prev' : 'next';

    for (let attempt = 1; attempt <= CFG.retries.pageMove; attempt++) {
      if (state.stopRequested) return { ok: false, snap: getTableSnapshot() };

      const before = getTableSnapshot();
      const btns = getPrevNextButtons();
      const btn = dir === 'next' ? btns.next : btns.prev;

      if (!btn || btn.disabled) {
        return { ok: false, snap: before };
      }

      clickEl(btn);
      await sleep(CFG.timings.clickSettleMs);

      await waitUntil(() => {
        const now = getTableSnapshot();
        const pageChanged = now.current != null && before.current != null && now.current !== before.current;
        const contentChanged = now.rowsSig && before.rowsSig && now.rowsSig !== before.rowsSig;
        return pageChanged || contentChanged;
      }, CFG.timings.pageMoveTimeoutMs, 60);

      const after = await waitForTableStable({
        requireRows: true,
        timeoutMs: CFG.timings.tableTimeoutMs,
        previousRowsSig: previousRowsSig || before.rowsSig || null
      });

      const movedPage = before.current != null && after.current != null && after.current !== before.current;
      const movedContent = before.rowsSig && after.rowsSig && after.rowsSig !== before.rowsSig;
      const directionOk =
        before.current == null || after.current == null
          ? movedContent
          : dir === 'next'
            ? after.current > before.current || movedContent
            : after.current < before.current || movedContent;

      if (directionOk && (movedPage || movedContent)) {
        return { ok: true, snap: after };
      }

      appendLog(`Не подтвержден переход ${dir}, попытка ${attempt}/${CFG.retries.pageMove}`, 'warn');
      await sleep(120 * attempt);
    }

    return { ok: false, snap: getTableSnapshot() };
  }

  async function resetToFirstPage() {
    const start = Date.now();
    let guard = 0;

    while (guard < 120) {
      if (state.stopRequested) return false;

      const p = getPaginationInfo();
      if (!p.current || p.current === 1) {
        await waitForTableStable({ expectedPage: 1, requireRows: true, timeoutMs: 1800 });
        return true;
      }

      const beforeSig = getRowsSignature();
      const moved = await moveOnePage('prev', beforeSig);
      if (!moved.ok) break;

      guard++;
      if (Date.now() - start > 45000) break;
    }

    return (getPaginationInfo().current || 1) === 1;
  }

  async function goToPageSequential(targetPage) {
    targetPage = Number(targetPage);
    if (!Number.isFinite(targetPage) || targetPage < 1) return false;

    const current = getPaginationInfo().current || 1;
    if (current === targetPage) {
      await waitForTableStable({ expectedPage: targetPage, requireRows: true, timeoutMs: 1800 });
      return true;
    }

    const okFirst = await resetToFirstPage();
    if (!okFirst) return false;

    let now = getPaginationInfo().current || 1;
    if (now !== 1) return false;

    if (targetPage === 1) return true;

    let lastSig = getRowsSignature();
    while (now < targetPage) {
      if (state.stopRequested) return false;

      const moved = await moveOnePage('next', lastSig);
      if (!moved.ok) return false;

      now = moved.snap.current || (now + 1);
      lastSig = moved.snap.rowsSig || getRowsSignature();

      if (now > targetPage) return false;
    }

    return (getPaginationInfo().current || now) === targetPage;
  }

  function clearHighlight() {
    if (state.lastHighlightedRow && state.lastHighlightedRow.isConnected) {
      state.lastHighlightedRow.classList.remove('uf-highlight-row');
    }
    state.lastHighlightedRow = null;
  }

  function highlightRowPersistent(row) {
    if (!row) return;
    clearHighlight();
    row.classList.add('uf-highlight-row');
    try { row.scrollIntoView({ behavior: 'smooth', block: 'center' }); } catch {}
    state.lastHighlightedRow = row;
  }

  function findRowForResult(result) {
    const rows = getRows();
    const targetModel = lower(result.model);
    const targetDesc = lower(result.description);

    for (const tr of rows) {
      const rd = getRowData(tr);
      if (lower(rd.model) === targetModel && lower(rd.description) === targetDesc) return { tr, rd };
    }

    for (const tr of rows) {
      const rd = getRowData(tr);
      if (lower(rd.model) === targetModel) return { tr, rd };
    }

    return null;
  }

  async function openResultHere(hit, result, openActions) {
    highlightRowPersistent(hit.tr);
    if (openActions) {
      if (!hit.rd.actionBtn) throw new Error('Кнопка Actions не найдена');
      await sleep(80);
      clickEl(hit.rd.actionBtn);
    }
    setStatus(`Открыт результат: ${result.model} (стр. ${getPaginationInfo().current || result.page})`);
  }

  async function navigateToResult(result, openActions = false) {
    if (state.running) throw new Error('Дождитесь окончания операции');

    await waitFor3DModelsPage();

    if (result.lang && result.lang !== 'keep') {
      const okLang = await ensureLanguage(result.lang);
      if (!okLang) throw new Error(`Не удалось переключить язык на ${result.lang}`);
    }

    await ensureType(result.type);

    const currentPageBefore = getPaginationInfo().current || 1;

    clearHighlight();

    if (currentPageBefore === result.page) {
      await waitForTableStable({ expectedPage: result.page, requireRows: true, timeoutMs: 2000 });
      const hitHere = findRowForResult(result);
      if (hitHere) {
        await openResultHere(hitHere, result, openActions);
        return;
      }
    }

    const pagesToTry = [];
    const seen = new Set();
    [result.page, result.page - 1, result.page + 1, result.page - 2, result.page + 2].forEach(p => {
      if (Number.isFinite(p) && p >= 1 && !seen.has(p)) {
        seen.add(p);
        pagesToTry.push(p);
      }
    });

    for (const p of pagesToTry) {
      const currentPage = getPaginationInfo().current || 1;

      if (currentPage !== p) {
        const ok = await goToPageSequential(p);
        if (!ok) continue;
      }

      await waitForTableStable({ expectedPage: p, requireRows: true, timeoutMs: 2200 });

      const hit = findRowForResult(result);
      if (hit) {
        await openResultHere(hit, result, openActions);
        if (p !== result.page) appendLog(`Результат найден на соседней странице: ожидалась ${result.page}, фактически ${p}`, 'warn');
        return;
      }
    }

    throw new Error('Строка не найдена на целевой и соседних страницах');
  }

  function makeMatcher(query) {
    const needle = lower(query);
    return {
      test(text) {
        return lower(text).includes(needle);
      }
    };
  }

  function collectMatchesCurrentPage(matcher, scanLang, typeName, actualPage) {
    const rows = getRows();
    const out = [];
    const pageNow = actualPage || getPaginationInfo().current || 1;

    rows.forEach((row, idx) => {
      const rd = getRowData(row);
      const hay = `${rd.model}\n${rd.description}`;
      if (!matcher.test(hay)) return;

      out.push({
        lang: scanLang || getLanguageValue() || '',
        type: typeName || getCurrentType() || 'unknown',
        page: pageNow,
        rowIndex: idx + 1,
        model: rd.model,
        description: rd.description
      });
    });

    return out;
  }

  async function scanTypeSequential(typeName, matcher, langCode) {
    await ensureType(typeName);

    const okFirst = await resetToFirstPage();
    if (!okFirst) throw new Error(`Не удалось перейти на страницу 1 для ${typeName}`);

    let snap = await waitForTableStable({ expectedPage: 1, requireRows: true, timeoutMs: CFG.timings.tableTimeoutMs });
    let currentPage = snap.current || 1;
    let currentSig = snap.rowsSig || getRowsSignature();

    const rowsOnFirst = getRows().length || 20;
    const totalItems = parseTotalItems();
    const pInfo = getPaginationInfo();
    let totalPages = pInfo.totalPages || null;
    if (!totalPages && totalItems) totalPages = Math.ceil(totalItems / rowsOnFirst);
    if (!totalPages) totalPages = 1;

    appendLog(`Сканирование ${typeName}, язык ${langCode}, страниц: ${totalPages}`, 'info');

    const visitedPageSignatures = new Set();

    while (true) {
      if (state.stopRequested) return;

      const pageNumber = getPaginationInfo().current || currentPage || 1;
      const stable = await waitForTableStable({ expectedPage: pageNumber, requireRows: true, timeoutMs: 1800 });
      currentPage = stable.current || pageNumber;
      currentSig = stable.rowsSig || getRowsSignature();

      const visitKey = `${typeName}::${langCode}::${currentPage}::${currentSig}`;
      if (!visitedPageSignatures.has(visitKey)) {
        visitedPageSignatures.add(visitKey);

        const found = collectMatchesCurrentPage(matcher, langCode, typeName, currentPage);
        found.forEach(addResult);

        if (found.length) appendLog(`Страница ${currentPage}: найдено ${found.length}`, 'ok');
        else appendLog(`Страница ${currentPage}: совпадений нет`, 'info');

        renderResults();
      } else {
        appendLog(`Страница ${currentPage}: пропуск повторного снимка`, 'warn');
      }

      const { next } = getPrevNextButtons();
      const endByDisabled = !next || next.disabled;
      const endByCount = totalPages && currentPage >= totalPages;

      if (endByDisabled || endByCount) break;

      setStatus(`Поиск: ${typeName} | страница ${currentPage + 1}/${totalPages || '?' }...`);
      const moved = await moveOnePage('next', currentSig);

      if (!moved.ok) {
        appendLog(`Не удалось перейти на следующую страницу после ${currentPage} (${typeName})`, 'warn');
        break;
      }

      currentPage = moved.snap.current || (currentPage + 1);
      currentSig = moved.snap.rowsSig || getRowsSignature();
    }
  }

  function getOpenMenus() {
    const selectors = ['.mantine-Menu-dropdown', '[role="menu"]', '[id$="-dropdown"]'];
    return Array.from(new Set(selectors.flatMap(s => qa(s)))).filter(isVisible);
  }

  function getMenuItems(menu) {
    return qa('button[role="menuitem"], button[data-menu-item="true"], [role="menuitem"]', menu).filter(isVisible);
  }

  function validEmbedValue(text) {
    const s = String(text || '').trim();
    if (!s) return '';
    if (/<iframe\b/i.test(s) && /src=/i.test(s) && /\/3d-player\//i.test(s)) return s;
    const m = s.match(/https?:\/\/[^\s"'<>]+\/3d-player\/[^\s"'<>]+/i);
    if (m) {
      const url = m[0];
      return `<iframe src="${url}" style="border:0;width:100%;height:400px" allow="fullscreen; autoplay; clipboard-read; clipboard-write"></iframe>`;
    }
    return '';
  }

  async function readClipboardTextSafe() {
    if (navigator.clipboard && typeof navigator.clipboard.readText === 'function') {
      try {
        return String(await navigator.clipboard.readText() || '');
      } catch {}
    }
    return '';
  }

  async function captureClipboardTextByClick(el) {
    let captured = '';
    let patched = false;
    let originalWrite = null;

    try {
      if (navigator.clipboard && typeof navigator.clipboard.writeText === 'function') {
        originalWrite = navigator.clipboard.writeText.bind(navigator.clipboard);
        navigator.clipboard.writeText = async (text) => {
          captured = String(text || '');
          return Promise.resolve();
        };
        patched = true;
      }
    } catch {}

    try {
      clickEl(el);
      await sleep(CFG.timings.menuActionMs);
      if (!captured) {
        const clip = await readClipboardTextSafe();
        if (clip) captured = clip;
      }
    } finally {
      if (patched && originalWrite) {
        try { navigator.clipboard.writeText = originalWrite; } catch {}
      }
    }

    return String(captured || '').trim();
  }

  async function extractEmbedFromRowOnce(row) {
    const rd = getRowData(row);
    if (!rd.actionBtn) return '';

    await closePopups();
    clickEl(rd.actionBtn);
    await sleep(CFG.timings.menuOpenMs);

    const menu = await waitUntil(() => getOpenMenus()[0], 1200, 50);
    if (!menu) return '';

    const items = getMenuItems(menu);
    const embedItem =
      items.find(i => lower(i.textContent).includes('встроить')) ||
      items.find(i => lower(i.textContent).includes('embed'));

    if (!embedItem) {
      await closePopups();
      return '';
    }

    const captured = await captureClipboardTextByClick(embedItem);
    const valid = validEmbedValue(captured);
    await closePopups();
    return valid;
  }

  async function extractEmbedFromRow(row, attempts = 1) {
    for (let i = 1; i <= attempts; i++) {
      const embed = await extractEmbedFromRowOnce(row);
      if (validEmbedValue(embed)) return embed;
      if (i < attempts) await sleep(150 * i);
    }
    return '';
  }

  function findRowByIdentity(identity) {
    const rows = getRows();
    const targetModel = lower(identity.model);
    const targetDesc = lower(identity.description);

    for (const row of rows) {
      const rd = getRowData(row);
      if (lower(rd.model) === targetModel && lower(rd.description) === targetDesc) return row;
    }

    for (const row of rows) {
      const rd = getRowData(row);
      if (lower(rd.model) === targetModel) return row;
    }

    if (identity.rowIndex && rows[identity.rowIndex - 1]) {
      const rd = getRowData(rows[identity.rowIndex - 1]);
      if (lower(rd.model) === targetModel) return rows[identity.rowIndex - 1];
    }

    return null;
  }

  function csvEscape(v) {
    return `"${String(v ?? '').replace(/"/g, '""')}"`;
  }

  function buildCsv(rows) {
    const header = ['language', 'type', 'page', 'model', 'description', 'embed_iframe'];
    const lines = [header.map(csvEscape).join(';')];
    for (const r of rows) {
      lines.push([
        r.language,
        r.type,
        r.page,
        r.model,
        r.description,
        r.embed_iframe
      ].map(csvEscape).join(';'));
    }
    return '\uFEFF' + lines.join('\r\n');
  }

  function buildFailuresCsv(rows) {
    const header = ['language', 'type', 'page', 'model', 'description', 'error'];
    const lines = [header.map(csvEscape).join(';')];
    for (const r of rows) {
      lines.push([
        r.language,
        r.type,
        r.page,
        r.model,
        r.description,
        r.error
      ].map(csvEscape).join(';'));
    }
    return '\uFEFF' + lines.join('\r\n');
  }

  function downloadTextFile(filename, text, mime = 'text/plain;charset=utf-8') {
    const blob = new Blob([text], { type: mime });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 2500);
  }

  function fileStamp() {
    const d = new Date();
    const p = (n) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}_${p(d.getHours())}-${p(d.getMinutes())}-${p(d.getSeconds())}`;
  }

  async function runSearch() {
    if (state.running) return;

    const query = state.ui.query.value.trim();
    if (!query) {
      setStatus('Введите запрос');
      return;
    }

    const selectedTypes = getSelectedTypesFromUI();
    const lang = state.ui.language.value || 'keep';

    if (!selectedTypes.length) {
      setStatus('Выберите хотя бы один тип');
      return;
    }

    localStorage.setItem(CFG.storage.query, query);
    localStorage.setItem(CFG.storage.lang, state.ui.language.value);

    state.running = true;
    state.stopRequested = false;
    state.results = [];
    clearHighlight();
    updateButtons();
    setPanelMode('results');
    renderResults();

    try {
      await waitFor3DModelsPage();
      setStatus('Подготовка страницы...');
      appendLog(`Start search: "${query}" | lang=${lang} | types=${selectedTypes.join(',')}`, 'info');

      if (lang !== 'keep') {
        const okLang = await ensureLanguage(lang);
        if (!okLang) {
          appendLog(`Не удалось переключить язык на ${lang}, продолжаю как есть`, 'warn');
          setStatus(`Не удалось переключить язык на ${lang}, продолжаю как есть`);
        }
      }

      await waitForTableStable({ requireRows: true, timeoutMs: 1800 });

      const matcher = makeMatcher(query);

      for (const type of selectedTypes) {
        if (state.stopRequested) break;
        await scanTypeSequential(type, matcher, lang === 'keep' ? (getLanguageValue() || '') : lang);
      }

      setStatus(state.stopRequested ? `Остановлено. Найдено: ${state.results.length}` : `Готово. Найдено: ${state.results.length}`);
      appendLog(`Search done. Found: ${state.results.length}`, 'ok');
    } finally {
      state.running = false;
      state.stopRequested = false;
      updateButtons();
      renderResults();
    }
  }

  async function exportCatalog() {
    if (state.running) return;

    const selectedTypes = getSelectedTypesFromUI();
    if (!selectedTypes.length) {
      setStatus('Для экспорта выберите хотя бы один тип');
      return;
    }

    state.running = true;
    state.stopRequested = false;
    state.failures = [];
    state.logs = [];
    updateButtons();
    setPanelMode('logs');

    try {
      await waitFor3DModelsPage();
      setStatus('Подготовка экспорта...');
      appendLog('Экспорт запущен', 'info');

      const exportAllLangs = !!state.ui.exportAllLangs.checked;
      let languages = [];

      if (exportAllLangs) {
        languages = await getAvailableLanguages();
      } else {
        const selected = state.ui.language.value || 'keep';
        if (selected === 'keep') {
          const current = getLanguageValue() || 'en';
          languages = [{ value: ['en', 'ru'].includes(current) ? current : 'en', label: current }];
        } else {
          languages = [{ value: ['en', 'ru'].includes(selected) ? selected : 'en', label: selected }];
        }
      }

      appendLog(`Языки для экспорта: ${languages.map(x => x.value).join(', ')}`, 'info');
      appendLog(`Типы для экспорта: ${selectedTypes.join(', ')}`, 'info');

      const out = [];
      const uniqueOut = new Set();

      for (const lang of languages) {
        if (state.stopRequested) break;

        appendLog(`--- Язык: ${lang.value} ---`, 'info');

        const okLang = await ensureLanguage(lang.value);
        if (!okLang) {
          const err = `Не удалось переключить язык на ${lang.value}`;
          state.failures.push({ language: lang.value, type: '', page: '', model: '', description: '', error: err });
          appendLog(err, 'err');
          continue;
        }

        await waitForTableStable({ requireRows: true, timeoutMs: 1800 });

        for (const type of selectedTypes) {
          if (state.stopRequested) break;

          appendLog(`Тип: ${type}`, 'info');
          await ensureType(type);

          const okFirst = await resetToFirstPage();
          if (!okFirst) {
            const err = `Не удалось перейти на страницу 1 для ${lang.value}/${type}`;
            state.failures.push({ language: lang.value, type, page: 1, model: '', description: '', error: err });
            appendLog(err, 'err');
            continue;
          }

          let snap = await waitForTableStable({ expectedPage: 1, requireRows: true, timeoutMs: CFG.timings.tableTimeoutMs });
          let currentPage = snap.current || 1;
          let currentSig = snap.rowsSig || getRowsSignature();

          const rowsOnFirst = getRows().length || 20;
          const totalItems = parseTotalItems();
          const pInfo = getPaginationInfo();
          let totalPages = pInfo.totalPages || null;
          if (!totalPages && totalItems) totalPages = Math.ceil(totalItems / rowsOnFirst);
          if (!totalPages) totalPages = 1;

          appendLog(`Страниц: ${totalPages}, total: ${totalItems ?? 'unknown'}`, 'info');

          const visitedSnapshots = new Set();

          while (true) {
            if (state.stopRequested) break;

            const stable = await waitForTableStable({ expectedPage: currentPage, requireRows: true, timeoutMs: 2000 });
            currentPage = stable.current || currentPage;
            currentSig = stable.rowsSig || currentSig || getRowsSignature();

            const snapshotKey = `${lang.value}::${type}::${currentPage}::${currentSig}`;
            if (!visitedSnapshots.has(snapshotKey)) {
              visitedSnapshots.add(snapshotKey);

              setStatus(`Export: ${lang.value} | ${type} | page ${currentPage}/${totalPages}`);
              appendLog(`На странице ${currentPage} строк: ${getRows().length}`, 'info');

              const snapshotRows = getRows().map((row, idx) => {
                const rd = getRowData(row);
                return {
                  language: lang.value,
                  type,
                  page: currentPage,
                  rowIndex: idx + 1,
                  model: rd.model,
                  description: rd.description
                };
              });

              for (let i = 0; i < snapshotRows.length; i++) {
                if (state.stopRequested) break;

                const item = snapshotRows[i];
                const key = createResultKey(item.language, item.type, item.model, item.description);

                if (uniqueOut.has(key)) {
                  appendLog(`Skip duplicate safety: ${item.model}`, 'warn');
                  continue;
                }

                setStatus(`Export: ${lang.value} | ${type} | page ${currentPage}/${totalPages} | row ${i + 1}/${snapshotRows.length}`);
                appendLog(`Row ${i + 1}/${snapshotRows.length}: ${item.model}`, 'info');

                let row = findRowByIdentity(item);
                let embed = '';

                if (row) {
                  embed = await extractEmbedFromRow(row, CFG.retries.embedSameRow);
                }

                if (!validEmbedValue(embed)) {
                  appendLog(`Fast failed: ${item.model}`, 'warn');

                  for (let retry = 1; retry <= CFG.retries.embedRecovery; retry++) {
                    if (state.stopRequested) break;

                    appendLog(`Recovery ${retry}/${CFG.retries.embedRecovery}: ${item.model} | ${lang.value} | ${type} | page ${currentPage}`, 'warn');

                    await goToPageSequential(currentPage);
                    await waitForTableStable({ expectedPage: currentPage, requireRows: true, timeoutMs: 2200 });

                    let refound = null;
                    for (let rr = 1; rr <= CFG.retries.rowRefind; rr++) {
                      refound = findRowByIdentity(item);
                      if (refound) break;
                      await sleep(120 * rr);
                    }

                    if (!refound) {
                      continue;
                    }

                    embed = await extractEmbedFromRow(refound, 2);
                    if (validEmbedValue(embed)) break;
                    await sleep(180 * retry);
                  }
                }

                if (validEmbedValue(embed)) {
                  uniqueOut.add(key);
                  out.push({
                    language: item.language,
                    type: item.type,
                    page: item.page,
                    model: item.model,
                    description: item.description,
                    embed_iframe: embed
                  });
                  appendLog(`OK: ${item.model}`, 'ok');
                } else {
                  const err = 'Не удалось получить ссылку "Встроить"';
                  state.failures.push({
                    language: item.language,
                    type: item.type,
                    page: item.page,
                    model: item.model,
                    description: item.description,
                    error: err
                  });
                  appendLog(`FAIL: ${item.model} | ${err}`, 'err');
                }
              }
            } else {
              appendLog(`Пропуск повторного снимка страницы ${currentPage}`, 'warn');
            }

            const { next } = getPrevNextButtons();
            const endByDisabled = !next || next.disabled;
            const endByCount = totalPages && currentPage >= totalPages;

            if (endByDisabled || endByCount) break;

            appendLog(`Переход на страницу ${currentPage + 1}/${totalPages}`, 'info');
            const moved = await moveOnePage('next', currentSig);

            if (!moved.ok) {
              const err = `Не удалось перейти на следующую страницу после ${currentPage}`;
              state.failures.push({ language: lang.value, type, page: currentPage, model: '', description: '', error: err });
              appendLog(err, 'err');
              break;
            }

            currentPage = moved.snap.current || (currentPage + 1);
            currentSig = moved.snap.rowsSig || currentSig || getRowsSignature();
          }
        }
      }

      if (state.stopRequested) {
        setStatus(`Экспорт остановлен. Успешно: ${out.length}. Ошибок: ${state.failures.length}`);
        appendLog(`Экспорт остановлен. Успешно: ${out.length}. Ошибок: ${state.failures.length}`, 'warn');
      } else {
        const stamp = fileStamp();
        if (out.length) {
          downloadTextFile(`unowa_catalog_export_${stamp}.csv`, buildCsv(out), 'text/csv;charset=utf-8');
          appendLog(`CSV сохранён: ${out.length} строк`, 'ok');
        }
        if (state.failures.length) {
          downloadTextFile(`unowa_catalog_export_failures_${stamp}.csv`, buildFailuresCsv(state.failures), 'text/csv;charset=utf-8');
          appendLog(`CSV ошибок сохранён: ${state.failures.length} строк`, 'warn');
        }
        setStatus(`Экспорт завершён. Успешно: ${out.length}. Ошибок: ${state.failures.length}`);
        appendLog(`Экспорт завершён. Успешно: ${out.length}. Ошибок: ${state.failures.length}`, 'ok');
      }
    } finally {
      state.running = false;
      state.stopRequested = false;
      updateButtons();
      renderLogs();
    }
  }

  function boot() {
    createUI();
    setStatus('Готов. Введите запрос и нажмите Start');
    appendLog('Boot complete', 'info');
  }

  waitUntil(() => document.body, 12000, 80).then(() => boot());
})();
