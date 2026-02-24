// ==UserScript==
// @name         UNOWA Finder Stable Fast Scan (clean draggable)
// @namespace    https://unowa.eu/
// @version      2.2.3
// @description  Fast search across UNOWA 3D models with auto language, 100/page, clickable results, row highlight and draggable UI
// @author       ChatGPT
// @match        https://*.unowa.eu/*
// @run-at       document-idle
// @grant        none
// @homepageURL  https://github.com/Lex-Dorosh/UNOWA
// @supportURL   https://github.com/Lex-Dorosh/UNOWA/issues
// @updateURL    https://raw.githubusercontent.com/Lex-Dorosh/UNOWA/main/UNOWA-3D-Finder.user.js
// @downloadURL  https://raw.githubusercontent.com/Lex-Dorosh/UNOWA/main/UNOWA-3D-Finder.user.js
// ==/UserScript==

(function () {
  'use strict';

  if (window.__UNOWA_FINDER_V223__) return;
  window.__UNOWA_FINDER_V223__ = true;

  const CFG = {
    ui: {
      width: 460,
      zIndex: 2147483000
    },
    timings: {
      pollMs: 120,
      stableForMs: 220,
      pageStableTimeoutMs: 2600,
      shortTimeoutMs: 1800,
      afterClickMs: 90,
      afterPageClickMs: 140,
      afterTypeSwitchMs: 180,
      afterSelectMs: 140,
      flashMs: 4200
    },
    scan: {
      preferredPerPage: 100,
      emptyPageRetries: 2,
      pageRetrySleepMs: 380
    },
    storage: {
      minimized: 'unowaFinder.minimized',
      hidden: 'unowaFinder.hidden',
      query: 'unowaFinder.query',
      languageMode: 'unowaFinder.languageMode',
      position: 'unowaFinder.position'
    }
  };

  const state = {
    running: false,
    stopRequested: false,
    booted: false,
    hidden: localStorage.getItem(CFG.storage.hidden) === '1',
    minimized: localStorage.getItem(CFG.storage.minimized) === '1',
    results: [],
    searchMeta: null,
    ui: {},
    lastHighlightedRow: null,
    drag: {
      active: false,
      offsetX: 0,
      offsetY: 0
    }
  };

  const sleep = (ms) => new Promise(r => setTimeout(r, ms));
  const q = (sel, root = document) => root.querySelector(sel);
  const qa = (sel, root = document) => Array.from(root.querySelectorAll(sel));

  function normalizeText(s) {
    return String(s || '').replace(/\s+/g, ' ').replace(/\u00A0/g, ' ').trim();
  }

  function escapeRegExp(s) {
    return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }

  function hasCyrillic(s) {
    return /[\u0400-\u04FF\u0500-\u052F]/.test(s || '');
  }

  function hasLatin(s) {
    return /[A-Za-z]/.test(s || '');
  }

  function detectQueryLanguage(query) {
    if (hasCyrillic(query)) return 'ru';
    if (hasLatin(query)) return 'en';
    return null;
  }

  function buildMatcher(query, opts) {
    const textQuery = String(query || '');
    if (!textQuery.trim()) throw new Error('Пустой запрос');
    const flags = opts.caseSensitive ? 'g' : 'gi';
    const re = opts.useRegex ? new RegExp(textQuery, flags) : new RegExp(escapeRegExp(textQuery), flags);
    return {
      re,
      test(text) {
        re.lastIndex = 0;
        return re.test(text || '');
      }
    };
  }

  function clickEl(el) {
    if (!el) return false;
    try { el.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' }); } catch {}
    try {
      el.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }));
      el.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
      el.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
      el.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    } catch {
      try { el.click(); } catch { return false; }
    }
    return true;
  }

  async function waitUntil(fn, timeoutMs = 2000, pollMs = 100) {
    const t0 = Date.now();
    while (Date.now() - t0 < timeoutMs) {
      try {
        const v = fn();
        if (v) return v;
      } catch {}
      await sleep(pollMs);
    }
    return null;
  }

  function clamp(n, min, max) {
    return Math.max(min, Math.min(max, n));
  }

  function readSavedPosition() {
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

  function savePosition(x, y) {
    try {
      localStorage.setItem(CFG.storage.position, JSON.stringify({ x, y }));
    } catch {}
  }

  function applyPosition(x, y) {
    const root = state.ui.root;
    if (!root) return;
    const vw = window.innerWidth || document.documentElement.clientWidth || 1200;
    const vh = window.innerHeight || document.documentElement.clientHeight || 800;
    const panelW = CFG.ui.width;
    const panelH = Math.max(80, root.offsetHeight || 80);
    const nx = clamp(Math.round(x), 0, Math.max(0, vw - panelW));
    const ny = clamp(Math.round(y), 0, Math.max(0, vh - Math.min(panelH, vh)));
    root.style.left = `${nx}px`;
    root.style.top = `${ny}px`;
    root.style.right = 'auto';
    root.style.bottom = 'auto';
    savePosition(nx, ny);
  }

  function injectStyles() {
    if (q('#unowa-finder-styles')) return;
    const st = document.createElement('style');
    st.id = 'unowa-finder-styles';
    st.textContent = `
#unowaFinderRoot{position:fixed;top:12px;right:12px;width:${CFG.ui.width}px;z-index:${CFG.ui.zIndex};font:12px/1.35 Arial,sans-serif;color:#eaeaea}
#unowaFinderPanel{background:#1f2329;border:1px solid #3a404a;border-radius:12px;box-shadow:0 8px 28px rgba(0,0,0,.35);overflow:hidden}
#unowaFinderHeader{display:flex;align-items:center;justify-content:space-between;padding:8px 10px;background:#2a3038;border-bottom:1px solid #3a404a;gap:8px;cursor:move;user-select:none}
#unowaFinderTitle{font-weight:700;letter-spacing:.2px;display:flex;align-items:center;gap:6px}
#unowaFinderHeaderBtns{display:flex;gap:6px}
.unowa-btn-icon{border:1px solid #515966;background:#39424d;color:#fff;border-radius:8px;padding:2px 8px;cursor:pointer;font-size:12px}
.unowa-btn-icon:hover{background:#485465}
#unowaFinderBody{padding:10px;display:flex;flex-direction:column;gap:8px;max-height:78vh}
#unowaFinderBody.min{display:none}
#unowaFinderLauncher{position:fixed;top:12px;right:12px;z-index:${CFG.ui.zIndex};display:none;background:#1f2329;color:#fff;border:1px solid #3a404a;border-radius:999px;padding:8px 12px;box-shadow:0 8px 28px rgba(0,0,0,.35);cursor:pointer;font:12px Arial,sans-serif}
#unowaFinderLauncher.show{display:block}
#unowaFinderRoot.hidden{display:none}
#unowaFinderQuery{width:100%;box-sizing:border-box;padding:8px 10px;border-radius:8px;border:1px solid #4b5462;background:#111418;color:#fff;outline:none}
#unowaFinderQuery:focus{border-color:#7ea6ff;box-shadow:0 0 0 2px rgba(126,166,255,.22)}
.unowa-row{display:flex;gap:8px;align-items:center;flex-wrap:wrap}
.unowa-row.nowrap{flex-wrap:nowrap}
.unowa-label{opacity:.9}
.unowa-select{padding:5px 6px;border-radius:8px;border:1px solid #4b5462;background:#111418;color:#fff}
.unowa-check{display:inline-flex;gap:4px;align-items:center}
.unowa-mainbtn{border:1px solid #4e6db3;background:#3359c8;color:#fff;border-radius:8px;padding:6px 10px;cursor:pointer;font-weight:600}
.unowa-mainbtn:hover{background:#3f66d7}
.unowa-mainbtn.secondary{border-color:#515966;background:#39424d}
.unowa-mainbtn.secondary:hover{background:#485465}
.unowa-mainbtn.stop{border-color:#8f3f4a;background:#7c2f3a}
.unowa-mainbtn.stop:hover{background:#8c3845}
.unowa-mainbtn:disabled{opacity:.55;cursor:not-allowed}
#unowaFinderStatus{padding:6px 8px;border:1px solid #3a404a;border-radius:8px;background:#151a1f;color:#d5d9e0;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
#unowaFinderResults{border:1px solid #3a404a;border-radius:10px;background:#111418;overflow:auto;min-height:120px;max-height:46vh;padding:6px}
.uf-empty{opacity:.75;padding:8px}
.uf-item{border:1px solid #313844;border-radius:10px;background:#171c22;padding:8px;margin-bottom:6px}
.uf-item:last-child{margin-bottom:0}
.uf-top{display:flex;justify-content:space-between;gap:8px;align-items:flex-start}
.uf-badges{display:flex;gap:6px;flex-wrap:wrap}
.uf-badge{padding:2px 6px;border-radius:999px;border:1px solid #4d5766;background:#232a33;color:#d8deea;font-size:11px}
.uf-model{font-weight:700;color:#fff;margin:6px 0 4px;word-break:break-word}
.uf-desc{color:#cdd3dd;opacity:.92;word-break:break-word;max-height:46px;overflow:hidden}
.uf-actions{display:flex;gap:6px;margin-top:8px;flex-wrap:wrap}
.uf-linkbtn{border:1px solid #4f5f75;background:#243243;color:#fff;border-radius:8px;padding:4px 8px;cursor:pointer;font-size:12px}
.uf-linkbtn:hover{background:#2e4056}
.uf-linkbtn.alt{background:#2d2734;border-color:#675683}
.uf-linkbtn.alt:hover{background:#3a3145}
.uf-small{opacity:.8;font-size:11px}
.uf-count{font-weight:700;color:#fff}
.uf-highlight-row{outline:2px solid #ffce4b !important;outline-offset:-2px;background:rgba(255,206,75,.12) !important;transition:background .2s ease}
`;
    document.head.appendChild(st);
  }

  function escapeHtml(s) {
    return String(s || '').replace(/[&<>"']/g, ch => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[ch]));
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
        <button class="unowa-btn-icon" id="unowaFinderMinBtn" title="Свернуть/развернуть">${state.minimized ? '▢' : '—'}</button>
        <button class="unowa-btn-icon" id="unowaFinderCloseBtn" title="Скрыть">✕</button>
      </div>`;

    const body = document.createElement('div');
    body.id = 'unowaFinderBody';
    if (state.minimized) body.classList.add('min');

    const lastQuery = localStorage.getItem(CFG.storage.query) || '';
    const lastLangMode = localStorage.getItem(CFG.storage.languageMode) || 'auto';

    body.innerHTML = `
      <input id="unowaFinderQuery" placeholder="Запрос (например: глаз / eye / regex)" value="${escapeHtml(lastQuery)}" />
      <div class="unowa-row">
        <label class="unowa-check"><input type="checkbox" id="ufScanStructure" checked> Structure</label>
        <label class="unowa-check"><input type="checkbox" id="ufScanAnimation" checked> Animation</label>
        <label class="unowa-check"><input type="checkbox" id="ufCaseSensitive"> Case</label>
        <label class="unowa-check"><input type="checkbox" id="ufUseRegex"> Regex</label>
      </div>
      <div class="unowa-row nowrap">
        <span class="unowa-label">Язык:</span>
        <select id="ufLanguageMode" class="unowa-select">
          <option value="auto">auto (кириллица→ru, латиница→en)</option>
          <option value="ru">ru</option>
          <option value="en">en</option>
          <option value="keep">keep (не менять)</option>
        </select>
      </div>
      <div class="unowa-row">
        <button id="ufStartBtn" class="unowa-mainbtn">Start</button>
        <button id="ufStopBtn" class="unowa-mainbtn stop" disabled>Stop</button>
        <button id="ufClearBtn" class="unowa-mainbtn secondary">Clear</button>
        <span class="uf-small">Найдено: <span id="ufCount" class="uf-count">0</span></span>
      </div>
      <div id="unowaFinderStatus">Готов. Введите запрос и нажмите Start</div>
      <div id="unowaFinderResults"><div class="uf-empty">Результаты появятся здесь</div></div>
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
      root, panel, header, body, launcher,
      query: q('#unowaFinderQuery', root),
      scanStructure: q('#ufScanStructure', root),
      scanAnimation: q('#ufScanAnimation', root),
      caseSensitive: q('#ufCaseSensitive', root),
      useRegex: q('#ufUseRegex', root),
      languageMode: q('#ufLanguageMode', root),
      startBtn: q('#ufStartBtn', root),
      stopBtn: q('#ufStopBtn', root),
      clearBtn: q('#ufClearBtn', root),
      status: q('#unowaFinderStatus', root),
      results: q('#unowaFinderResults', root),
      count: q('#ufCount', root),
      minBtn: q('#unowaFinderMinBtn', root),
      closeBtn: q('#unowaFinderCloseBtn', root)
    };

    state.ui.languageMode.value = ['auto', 'ru', 'en', 'keep'].includes(lastLangMode) ? lastLangMode : 'auto';

    const savedPos = readSavedPosition();
    if (savedPos) {
      requestAnimationFrame(() => applyPosition(savedPos.x, savedPos.y));
    }

    bindUIEvents();
    bindDrag();
    updateButtons();
  }

  function bindDrag() {
    const { header, root } = state.ui;
    if (!header || !root) return;

    function isInteractiveTarget(el) {
      return !!(el.closest('button') || el.closest('input') || el.closest('select') || el.closest('textarea') || el.closest('a') || el.closest('label'));
    }

    function onPointerDown(e) {
      if (e.button !== 0) return;
      if (isInteractiveTarget(e.target)) return;
      const rect = root.getBoundingClientRect();
      state.drag.active = true;
      state.drag.offsetX = e.clientX - rect.left;
      state.drag.offsetY = e.clientY - rect.top;
      root.style.right = 'auto';
      root.style.left = `${rect.left}px`;
      root.style.top = `${rect.top}px`;
      try { header.setPointerCapture(e.pointerId); } catch {}
      e.preventDefault();
    }

    function onPointerMove(e) {
      if (!state.drag.active) return;
      const x = e.clientX - state.drag.offsetX;
      const y = e.clientY - state.drag.offsetY;
      applyPosition(x, y);
      e.preventDefault();
    }

    function onPointerUp() {
      state.drag.active = false;
    }

    header.addEventListener('pointerdown', onPointerDown);
    window.addEventListener('pointermove', onPointerMove);
    window.addEventListener('pointerup', onPointerUp);
    window.addEventListener('pointercancel', onPointerUp);
    window.addEventListener('resize', () => {
      const rect = root.getBoundingClientRect();
      if (rect.width || rect.height) applyPosition(rect.left, rect.top);
    });
  }

  function bindUIEvents() {
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
      runSearch().catch((e) => {
        setStatus(`Ошибка: ${e?.message || e}`);
        state.running = false;
        updateButtons();
      });
    });

    ui.stopBtn.addEventListener('click', () => {
      state.stopRequested = true;
      setStatus('Остановка...');
    });

    ui.clearBtn.addEventListener('click', () => {
      state.results = [];
      renderResults();
      setStatus('Очищено');
    });

    ui.query.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        if (!state.running) ui.startBtn.click();
      }
    });

    ui.languageMode.addEventListener('change', () => {
      localStorage.setItem(CFG.storage.languageMode, ui.languageMode.value);
    });
  }

  function setStatus(text) {
    if (!state.ui.status) return;
    state.ui.status.textContent = text;
  }

  function updateButtons() {
    const ui = state.ui;
    if (!ui.startBtn) return;
    ui.startBtn.disabled = state.running;
    ui.stopBtn.disabled = !state.running;
  }

  function renderResults() {
    const box = state.ui.results;
    const count = state.ui.count;
    if (!box || !count) return;

    count.textContent = String(state.results.length);

    if (!state.results.length) {
      box.innerHTML = `<div class="uf-empty">Результаты появятся здесь</div>`;
      return;
    }

    box.innerHTML = '';
    state.results.forEach((r, idx) => {
      const item = document.createElement('div');
      item.className = 'uf-item';
      item.innerHTML = `
        <div class="uf-top">
          <div class="uf-badges">
            <span class="uf-badge">${idx + 1}</span>
            <span class="uf-badge">${escapeHtml(r.type)}</span>
            <span class="uf-badge">page ${r.page}</span>
            <span class="uf-badge">row ${r.rowIndex}</span>
          </div>
          <div class="uf-small">${escapeHtml(r.lang || '')}</div>
        </div>
        <div class="uf-model">${escapeHtml(r.model || '(без названия)')}</div>
        <div class="uf-desc">${escapeHtml(r.description || '')}</div>
        <div class="uf-actions">
          <button class="uf-linkbtn" data-act="open">Перейти к строке</button>
          <button class="uf-linkbtn alt" data-act="actions">Открыть Actions</button>
        </div>`;

      item.addEventListener('click', async (e) => {
        const btn = e.target.closest('button[data-act]');
        if (!btn) return;
        const act = btn.getAttribute('data-act');
        try {
          btn.disabled = true;
          btn.textContent = act === 'open' ? 'Переход...' : 'Открываю...';
          if (act === 'open') await navigateToResult(r, false);
          else await navigateToResult(r, true);
        } catch (ex) {
          setStatus(`Не удалось перейти: ${ex?.message || ex}`);
        } finally {
          btn.disabled = false;
          btn.textContent = act === 'open' ? 'Перейти к строке' : 'Открыть Actions';
        }
      });

      box.appendChild(item);
    });
  }

  function is3DPlayerRoute() {
    return /\/3d-player(?:\/|$)/.test(location.pathname || '');
  }

  function find3DModelsTitle() {
    const titles = qa('h1,h2,h3');
    return titles.find(el => /3D\s*models/i.test(normalizeText(el.textContent)));
  }

  function is3DModelsPageReady() {
    return !!(is3DPlayerRoute() && find3DModelsTitle() && getTable());
  }

  async function waitFor3DModelsPage(timeoutMs = 15000) {
    setStatus('Ожидание страницы 3D models...');
    const ok = await waitUntil(() => is3DModelsPageReady(), timeoutMs, 250);
    if (!ok) throw new Error('Страница 3D models не обнаружена');
    setStatus('Страница 3D models обнаружена');
    return true;
  }

  function get3DRoot() {
    const title = find3DModelsTitle();
    if (!title) return document.body;
    let node = title.parentElement;
    for (let i = 0; i < 8 && node; i++, node = node.parentElement) {
      if (q('table', node) && q('.mantine-Pagination-root', node)) return node;
    }
    return title.closest('div') || document.body;
  }

  function getTable() {
    return q('table.mantine-Table-table') || q('table');
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
    const model = normalizeText(tds[0]?.innerText || tds[0]?.textContent || '');
    const description = normalizeText(tds[1]?.innerText || tds[1]?.textContent || '');
    const actionBtn = q('button[aria-label="Actions"]', row) || q('button', tds[2] || row);
    return { row, tds, model, description, actionBtn };
  }

  function getTypeControlInputs() {
    return qa('input.mantine-SegmentedControl-input[type="radio"]').filter(i => ['structure', 'animation'].includes(i.value));
  }

  function getCurrentType() {
    const inp = getTypeControlInputs().find(i => i.checked);
    return inp?.value || null;
  }

  function getTypeLabelForValue(value) {
    const inp = getTypeControlInputs().find(i => i.value === value);
    if (!inp) return null;
    let label = null;
    if (inp.id) label = document.querySelector(`label[for="${CSS.escape(inp.id)}"]`);
    return label || inp.closest('div') || inp;
  }

  async function ensureType(value) {
    const cur = getCurrentType();
    if (cur === value) return true;
    setStatus(`Переключаюсь на ${capitalize(value)}...`);
    const target = getTypeLabelForValue(value);
    if (!target) throw new Error(`Не найден переключатель типа ${value}`);
    clickEl(target);
    await sleep(CFG.timings.afterTypeSwitchMs);
    const ok = await waitUntil(() => getCurrentType() === value, CFG.timings.shortTimeoutMs, 80);
    if (!ok) throw new Error(`Не удалось переключить тип на ${value}`);
    return true;
  }

  function capitalize(s) {
    return s ? s.charAt(0).toUpperCase() + s.slice(1) : s;
  }

  function findSelectWrapperByLabelText(labelNeedle) {
    const wrappers = qa('.mantine-InputWrapper-root.mantine-Select-root');
    return wrappers.find(w => {
      const label = q('label', w);
      return label && normalizeText(label.textContent).toLowerCase().includes(labelNeedle.toLowerCase());
    }) || null;
  }

  function getSelectDisplayInput(wrapper) {
    return wrapper ? q('input.mantine-Select-input[readonly]', wrapper) : null;
  }

  function getSelectHiddenInput(wrapper) {
    if (!wrapper) return null;
    return q('input[type="hidden"]', wrapper.parentElement || wrapper) || q('input[type="hidden"]', wrapper);
  }

  function getPerPageValue() {
    const wrap = findSelectWrapperByLabelText('Per page');
    if (!wrap) return null;
    const hidden = getSelectHiddenInput(wrap);
    if (hidden && /^\d+$/.test(hidden.value)) return Number(hidden.value);
    const inp = getSelectDisplayInput(wrap);
    const m = (inp?.value || '').match(/(\d+)/);
    return m ? Number(m[1]) : null;
  }

  function getLanguageValue() {
    const wrap = findSelectWrapperByLabelText('Language');
    if (!wrap) return null;
    const hidden = getSelectHiddenInput(wrap);
    if (hidden && hidden.value) return String(hidden.value).toLowerCase();
    const inp = getSelectDisplayInput(wrap);
    const txt = normalizeText(inp?.value || '').toLowerCase();
    if (txt.includes('english')) return 'en';
    if (txt.includes('рус') || txt.includes('russian')) return 'ru';
    return txt || null;
  }

  function getOpenComboboxOptions() {
    const selectors = ['[role="option"]', '.mantine-Combobox-option', '[data-combobox-option]'];
    const all = selectors.flatMap(s => qa(s));
    const unique = Array.from(new Set(all));
    return unique.filter(el => {
      const txt = normalizeText(el.textContent);
      if (!txt) return false;
      const style = getComputedStyle(el);
      return style.display !== 'none' && style.visibility !== 'hidden';
    });
  }

  async function openSelectAndChoose(wrapper, chooserFn) {
    const input = getSelectDisplayInput(wrapper);
    if (!input) return false;
    clickEl(input);
    await sleep(CFG.timings.afterClickMs);

    let options = getOpenComboboxOptions();
    if (!options.length) options = await waitUntil(() => getOpenComboboxOptions(), 1200, 80) || [];
    if (!options.length) return false;

    const chosen = chooserFn(options);
    if (!chosen) return false;
    clickEl(chosen);
    await sleep(CFG.timings.afterSelectMs);
    return true;
  }

  async function ensurePerPage100() {
    setStatus('Setting Per page -> 100');
    const cur = getPerPageValue();
    if (cur === CFG.scan.preferredPerPage) return true;

    const wrap = findSelectWrapperByLabelText('Per page');
    if (!wrap) return false;

    const ok = await openSelectAndChoose(wrap, (options) => {
      return options.find(o => /(^|\s|\/)100(\s|\/|$)/i.test(normalizeText(o.textContent))) ||
             options.find(o => normalizeText(o.textContent).includes('100'));
    });
    if (!ok) return false;

    await waitUntil(() => getPerPageValue() === 100, 1800, 90);
    return true;
  }

  async function ensureLanguage(lang) {
    if (!lang || lang === 'keep') return true;
    const cur = getLanguageValue();
    if (cur === lang) return true;

    setStatus(`Режим языка: ${lang}`);
    const wrap = findSelectWrapperByLabelText('Language');
    if (!wrap) return false;

    const ok = await openSelectAndChoose(wrap, (options) => {
      const texts = options.map(o => ({ el: o, t: normalizeText(o.textContent).toLowerCase() }));
      if (lang === 'en') return texts.find(x => x.t === 'english' || x.t.includes('english'))?.el || null;
      if (lang === 'ru') return texts.find(x => x.t.includes('рус'))?.el || texts.find(x => x.t.includes('russian'))?.el || null;
      return null;
    });
    if (!ok) return false;

    await waitUntil(() => getLanguageValue() === lang, 1800, 90);
    return true;
  }

  function parseTotalItems() {
    const root = get3DRoot();
    const texts = qa('.mantine-Text-root, p, span, div', root).map(el => normalizeText(el.textContent)).filter(Boolean);
    for (const t of texts) {
      const m = t.match(/^Total:\s*(\d+)$/i) || t.match(/\bTotal:\s*(\d+)\b/i);
      if (m) return Number(m[1]);
    }
    return null;
  }

  function getPaginationRoot() {
    return q('.mantine-Pagination-root');
  }

  function getPaginationInfo() {
    const root = getPaginationRoot();
    if (!root) return { current: null, totalPages: null };
    const btns = qa('button', root);
    const curBtn = q('button[aria-current="page"]', root);
    const current = curBtn ? Number(normalizeText(curBtn.textContent)) || null : null;
    const numeric = btns.map(b => Number(normalizeText(b.textContent))).filter(n => Number.isFinite(n));
    const totalPages = numeric.length ? Math.max(...numeric) : null;
    return { current, totalPages, root, buttons: btns };
  }

  function getTableHeaders() {
    const t = getTable();
    if (!t) return [];
    return qa('thead th', t).map(th => normalizeText(th.textContent)).filter(Boolean);
  }

  function getTableSnapshot() {
    const rows = getRows();
    const pag = getPaginationInfo();
    return {
      realRows: rows.length,
      p: { current: pag.current, totalPages: pag.totalPages },
      total: parseTotalItems(),
      perPage: getPerPageValue(),
      type: getCurrentType(),
      headers: getTableHeaders()
    };
  }

  function snapshotSignature(s, expectedPage = null) {
    return JSON.stringify({
      rows: s.realRows,
      cur: s.p.current,
      totalPages: s.p.totalPages,
      perPage: s.perPage,
      type: s.type,
      headers: s.headers,
      expectedPage
    });
  }

  async function waitForTableStable(label, opts = {}) {
    const timeoutMs = opts.timeoutMs ?? CFG.timings.pageStableTimeoutMs;
    const expectedPage = opts.expectedPage ?? null;
    const requireRows = !!opts.requireRows;

    let lastSig = null;
    let lastChange = 0;
    let lastSnap = null;
    const t0 = Date.now();

    while (Date.now() - t0 < timeoutMs) {
      const snap = getTableSnapshot();
      lastSnap = snap;
      const sig = snapshotSignature(snap, expectedPage);

      if (sig !== lastSig) {
        lastSig = sig;
        lastChange = Date.now();
      }

      const pageOk = expectedPage == null || snap.p.current === expectedPage;
      const rowsOk = requireRows ? snap.realRows > 0 : true;
      const tableOk = !!getTable();

      if (tableOk && pageOk && rowsOk && (Date.now() - lastChange) >= CFG.timings.stableForMs) return snap;
      await sleep(CFG.timings.pollMs);
    }

    return lastSnap || getTableSnapshot();
  }

  function findPageButton(pageNum) {
    const root = getPaginationRoot();
    if (!root) return null;
    return qa('button', root).find(b => normalizeText(b.textContent) === String(pageNum));
  }

  function getPrevNextButtons() {
    const root = getPaginationRoot();
    if (!root) return { prev: null, next: null };
    const btns = qa('button', root);
    if (btns.length < 2) return { prev: null, next: null };
    return { prev: btns[0], next: btns[btns.length - 1] };
  }

  async function goToPage(pageNum) {
    const target = Number(pageNum);
    if (!Number.isFinite(target) || target < 1) return false;

    let info = getPaginationInfo();
    if (info.current === target) return true;

    let btn = findPageButton(target);
    if (btn) {
      clickEl(btn);
      await sleep(CFG.timings.afterPageClickMs);
      const ok = await waitUntil(() => getPaginationInfo().current === target, 1800, 90);
      return !!ok;
    }

    const maxHops = 80;
    for (let hop = 0; hop < maxHops; hop++) {
      info = getPaginationInfo();
      if (info.current === target) return true;
      const { prev, next } = getPrevNextButtons();
      const stepBtn = (info.current && info.current < target) ? next : prev;
      if (!stepBtn) break;
      clickEl(stepBtn);
      await sleep(CFG.timings.afterPageClickMs);

      const changed = await waitUntil(() => {
        const c = getPaginationInfo().current;
        return c && c !== info.current;
      }, 1500, 80);

      if (!changed) break;

      btn = findPageButton(target);
      if (btn) {
        clickEl(btn);
        await sleep(CFG.timings.afterPageClickMs);
        const ok = await waitUntil(() => getPaginationInfo().current === target, 1800, 90);
        return !!ok;
      }
    }

    return false;
  }

  function collectMatchesOnCurrentPage(matcher, scanLang) {
    const rows = getRows();
    const matches = [];

    rows.forEach((tr, idx) => {
      const rd = getRowData(tr);
      const hay = `${rd.model}\n${rd.description}`;
      if (!matcher.test(hay)) return;

      matches.push({
        type: getCurrentType() || 'unknown',
        page: getPaginationInfo().current || 1,
        rowIndex: idx + 1,
        model: rd.model,
        description: rd.description,
        lang: scanLang || getLanguageValue() || '',
        key: makeResultKey(rd.model, rd.description)
      });
    });

    return matches;
  }

  function makeResultKey(model, desc) {
    return normalizeText(`${model}||${desc}`).toLowerCase();
  }

  async function scanType(typeName, matcher, scanLang) {
    await ensureType(typeName);
    await ensurePerPage100();
    await waitForTableStable(`before scan ${typeName}`, { requireRows: true, timeoutMs: 2200 });

    let info = getPaginationInfo();
    const perPage = getPerPageValue() || 100;
    const totalItems = parseTotalItems();
    let totalPages = info.totalPages || null;
    if (!totalPages && totalItems && perPage) totalPages = Math.ceil(totalItems / perPage);
    if (!totalPages) totalPages = 1;

    await goToPage(1);
    await waitForTableStable(`page 1 settled (${typeName})`, { expectedPage: 1, requireRows: true, timeoutMs: 2200 });

    for (let page = 1; page <= totalPages; page++) {
      if (state.stopRequested) return;

      setStatus(`Поиск: ${capitalize(typeName)} | страница ${page}/${totalPages}...`);

      if (page > 1) {
        const okPage = await goToPage(page);
        if (!okPage) {}
      }

      let snap = await waitForTableStable(`scan page ${page} (${typeName})`, {
        expectedPage: page,
        requireRows: true,
        timeoutMs: CFG.timings.pageStableTimeoutMs
      });

      let rowsCount = snap?.realRows ?? getRows().length;
      let attempt = 0;

      while (rowsCount === 0 && attempt < CFG.scan.emptyPageRetries) {
        attempt++;
        await sleep(CFG.scan.pageRetrySleepMs);
        const btn = findPageButton(page);
        if (btn) clickEl(btn);
        await sleep(CFG.timings.afterPageClickMs);
        snap = await waitForTableStable(`scan page ${page} retry ${attempt} (${typeName})`, {
          expectedPage: page,
          requireRows: false,
          timeoutMs: 1800
        });
        rowsCount = snap?.realRows ?? getRows().length;
      }

      const found = collectMatchesOnCurrentPage(matcher, scanLang);
      if (found.length) {
        for (const f of found) {
          const dup = state.results.find(r => r.type === f.type && r.page === f.page && r.key === f.key);
          if (!dup) state.results.push(f);
        }
        renderResults();
      }
    }
  }

  async function runSearch() {
    if (state.running) return;

    const ui = state.ui;
    const query = ui.query.value.trim();
    if (!query) {
      setStatus('Введите запрос');
      return;
    }

    localStorage.setItem(CFG.storage.query, query);
    localStorage.setItem(CFG.storage.languageMode, ui.languageMode.value);

    const opts = {
      scanStructure: !!ui.scanStructure.checked,
      scanAnimation: !!ui.scanAnimation.checked,
      caseSensitive: !!ui.caseSensitive.checked,
      useRegex: !!ui.useRegex.checked,
      languageMode: ui.languageMode.value
    };

    if (!opts.scanStructure && !opts.scanAnimation) {
      setStatus('Выберите хотя бы один тип (Structure/Animation)');
      return;
    }

    let matcher;
    try {
      matcher = buildMatcher(query, opts);
    } catch (e) {
      setStatus(`Ошибка regex: ${e.message || e}`);
      return;
    }

    state.running = true;
    state.stopRequested = false;
    state.results = [];
    state.searchMeta = { query, ...opts };
    renderResults();
    updateButtons();

    try {
      await waitFor3DModelsPage();
      setStatus('Подготовка страницы...');
      await waitForTableStable('initial settle', { requireRows: true, timeoutMs: 2200 });

      let scanLang = null;
      if (opts.languageMode === 'auto') {
        scanLang = detectQueryLanguage(query);
        setStatus(`Режим языка: авто${scanLang ? ` (${scanLang})` : ''}`);
      } else if (opts.languageMode === 'ru' || opts.languageMode === 'en') {
        scanLang = opts.languageMode;
        setStatus(`Режим языка: ${scanLang}`);
      } else {
        scanLang = null;
        setStatus('Режим языка: keep');
      }

      if (scanLang) {
        await ensureLanguage(scanLang);
        await waitForTableStable('after language switch', { requireRows: true, timeoutMs: 2200 });
      }

      await ensurePerPage100();
      await waitForTableStable('after per-page switch', { requireRows: true, timeoutMs: 2200 });

      const types = [];
      if (opts.scanStructure) types.push('structure');
      if (opts.scanAnimation) types.push('animation');

      for (const type of types) {
        if (state.stopRequested) break;
        await scanType(type, matcher, scanLang || getLanguageValue() || '');
      }

      if (state.stopRequested) setStatus(`Остановлено. Найдено: ${state.results.length}`);
      else {
        setStatus(`Готово. Найдено: ${state.results.length}`);
        if (!state.results.length) setStatus('Готово. Найдено: 0');
      }
    } finally {
      state.running = false;
      state.stopRequested = false;
      updateButtons();
      renderResults();
    }
  }

  function clearRowHighlight() {
    if (state.lastHighlightedRow && state.lastHighlightedRow.isConnected) {
      state.lastHighlightedRow.classList.remove('uf-highlight-row');
    }
    state.lastHighlightedRow = null;
  }

  function flashRow(row) {
    clearRowHighlight();
    if (!row) return;
    row.classList.add('uf-highlight-row');
    try { row.scrollIntoView({ behavior: 'smooth', block: 'center' }); } catch {}
    state.lastHighlightedRow = row;
    setTimeout(() => {
      if (row.isConnected) row.classList.remove('uf-highlight-row');
      if (state.lastHighlightedRow === row) state.lastHighlightedRow = null;
    }, CFG.timings.flashMs);
  }

  function findRowByResult(result) {
    const rows = getRows();
    const targetModel = normalizeText(result.model).toLowerCase();
    const targetDesc = normalizeText(result.description).toLowerCase();

    for (const tr of rows) {
      const rd = getRowData(tr);
      if (normalizeText(rd.model).toLowerCase() === targetModel && normalizeText(rd.description).toLowerCase() === targetDesc) {
        return { tr, rd };
      }
    }

    for (const tr of rows) {
      const rd = getRowData(tr);
      if (normalizeText(rd.model).toLowerCase() === targetModel) return { tr, rd };
    }

    for (const tr of rows) {
      const rd = getRowData(tr);
      const m = normalizeText(rd.model).toLowerCase();
      const d = normalizeText(rd.description).toLowerCase();
      if (m.includes(targetModel) || targetModel.includes(m) || (targetDesc && d.includes(targetDesc.slice(0, Math.min(40, targetDesc.length))))) {
        return { tr, rd };
      }
    }

    const tr = rows[result.rowIndex - 1];
    if (tr) return { tr, rd: getRowData(tr) };
    return null;
  }

  async function navigateToResult(result, openActions = false) {
    if (state.running) throw new Error('Сначала дождитесь окончания поиска');

    await waitFor3DModelsPage(10000);
    await ensureType(result.type);
    await ensurePerPage100();

    const ok = await goToPage(result.page);
    if (!ok) throw new Error(`Не удалось перейти на страницу ${result.page}`);

    await waitForTableStable(`navigate result page ${result.page}`, {
      expectedPage: result.page,
      requireRows: true,
      timeoutMs: 2600
    });

    const hit = findRowByResult(result);
    if (!hit) throw new Error('Строка результата не найдена на странице');

    flashRow(hit.tr);
    setStatus(`Открыт результат: ${result.model}`);

    if (openActions) {
      if (!hit.rd.actionBtn) throw new Error('Кнопка Actions не найдена');
      clickEl(hit.rd.actionBtn);
      setStatus(`Actions открыто: ${result.model}`);
    }

    return true;
  }

  function attachRouteWatcher() {
    if (state._routeWatcherAttached) return;
    state._routeWatcherAttached = true;

    const origPush = history.pushState;
    const origReplace = history.replaceState;

    function onRouteMaybeChanged() {
      setTimeout(() => {
        if (state.routePath !== location.pathname) {
          state.routePath = location.pathname;
          if (is3DPlayerRoute()) setStatus('Ожидание страницы 3D models...');
        }
      }, 0);
    }

    history.pushState = function (...args) {
      const r = origPush.apply(this, args);
      onRouteMaybeChanged();
      return r;
    };

    history.replaceState = function (...args) {
      const r = origReplace.apply(this, args);
      onRouteMaybeChanged();
      return r;
    };

    window.addEventListener('popstate', onRouteMaybeChanged);
  }

  function boot() {
    if (state.booted) return;
    state.booted = true;
    createUI();
    attachRouteWatcher();

    if (is3DPlayerRoute()) setStatus('Готов. Введите запрос и нажмите Start');
    else setStatus('Перейдите на страницу /3d-player');
  }

  waitUntil(() => document.body, 15000, 60).then(() => boot());
})();
