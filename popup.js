const $ = (s) => document.querySelector(s);

// Delays are in milliseconds. Each wait is randomized by ±jitter, and a longer
// break is taken every `breakEvery` actions.
const PRESETS = {
  safe: { delay: 3000, msgDelay: 2500, jitter: 0.4, breakEvery: 20, breakMs: 60000 },
  normal: { delay: 1800, msgDelay: 1500, jitter: 0.35, breakEvery: 40, breakMs: 30000 },
  fast: { delay: 900, msgDelay: 800, jitter: 0.25, breakEvery: 0, breakMs: 0 },
};

const VERBS = {
  friends: { noun: 'friend', action: 'Remove' },
  servers: { noun: 'server', action: 'Leave' },
  dms: { noun: 'DM', action: 'Clean' },
  apps: { noun: 'app', action: 'Deauthorize' },
};

const lists = {
  friends: { items: [], selected: new Set(), loaded: false },
  servers: { items: [], selected: new Set(), loaded: false },
  dms: { items: [], selected: new Set(), loaded: false },
  apps: { items: [], selected: new Set(), loaded: false },
};

const INVITE_URL = 'https://discord.gg/rMkAf7tW9e';

let active = 'friends';
let tabId = null;
let running = false;
let confirmTimer = null;

// ---------- Messaging ----------

async function findDiscordTab() {
  const tabs = await chrome.tabs.query({ url: 'https://discord.com/*' });
  if (!tabs.length) return null;
  const [current] = await chrome.tabs.query({ active: true, currentWindow: true });
  const match = current && tabs.find((t) => t.id === current.id);
  return (match || tabs[0]).id;
}

async function send(msg) {
  try {
    const r = await chrome.tabs.sendMessage(tabId, msg);
    if (r && r.error) throw new Error(r.error);
    return r;
  } catch (e) {
    if (/Receiving end does not exist|Could not establish connection/i.test(e.message)) {
      throw new Error('Not connected to the Discord tab yet. Reload the Discord tab (F5), then reopen this menu.');
    }
    throw e;
  }
}

function banner(text) {
  const b = $('#banner');
  b.textContent = text || '';
  b.classList.toggle('hidden', !text);
}

// ---------- Speed settings ----------

function readSpeed() {
  const preset = $('#speed').value;
  if (PRESETS[preset]) return { ...PRESETS[preset] };
  return {
    delay: Math.max(0.5, Number($('#cDelay').value) || 1.5) * 1000,
    msgDelay: Math.max(0.5, Number($('#cMsgDelay').value) || 1.2) * 1000,
    jitter: Math.min(90, Math.max(0, Number($('#cJitter').value) || 0)) / 100,
    breakEvery: Math.max(0, Math.floor(Number($('#cBreakEvery').value) || 0)),
    breakMs: Math.max(0, Number($('#cBreakSec').value) || 0) * 1000,
  };
}

function fillCustom(p) {
  $('#cDelay').value = p.delay / 1000;
  $('#cMsgDelay').value = p.msgDelay / 1000;
  $('#cJitter').value = Math.round(p.jitter * 100);
  $('#cBreakEvery').value = p.breakEvery;
  $('#cBreakSec').value = p.breakMs / 1000;
}

function describeSpeed() {
  const p = readSpeed();
  const j = Math.round(p.jitter * 100);
  let text = `~${(p.delay / 1000).toFixed(1)}s per action, ~${(p.msgDelay / 1000).toFixed(1)}s per message (±${j}%)`;
  text += p.breakEvery ? `, ${Math.round(p.breakMs / 1000)}s break every ${p.breakEvery}.` : ', no breaks.';
  const perHour = Math.round(3600000 / (p.msgDelay + (p.breakEvery ? p.breakMs / p.breakEvery : 0)));
  text += ` ≈ ${perHour.toLocaleString()} messages/hour.`;
  $('#speedInfo').textContent = text;
  $('#custom').classList.toggle('hidden', $('#speed').value !== 'custom');
}

async function saveSettings() {
  await chrome.storage.local.set({
    settings: {
      speed: $('#speed').value,
      custom: readSpeedCustomRaw(),
      optDelete: $('#optDelete').checked,
      optClose: $('#optClose').checked,
    },
  });
}

function readSpeedCustomRaw() {
  return {
    delay: (Number($('#cDelay').value) || 1.5) * 1000,
    msgDelay: (Number($('#cMsgDelay').value) || 1.2) * 1000,
    jitter: (Number($('#cJitter').value) || 0) / 100,
    breakEvery: Number($('#cBreakEvery').value) || 0,
    breakMs: (Number($('#cBreakSec').value) || 0) * 1000,
  };
}

async function loadSettings() {
  const { settings } = await chrome.storage.local.get('settings');
  fillCustom((settings && settings.custom) || PRESETS.normal);
  if (settings) {
    $('#speed').value = settings.speed || 'safe';
    $('#optDelete').checked = settings.optDelete !== false;
    $('#optClose').checked = !!settings.optClose;
  }
  describeSpeed();
}

// ---------- List rendering ----------

function visibleItems() {
  const q = $('#filter').value.trim().toLowerCase();
  const items = lists[active].items;
  return q ? items.filter((it) => (it.label + ' ' + (it.sub || '')).toLowerCase().includes(q)) : items;
}

function renderList() {
  resetConfirm();
  const ul = $('#list');
  ul.textContent = '';
  const L = lists[active];

  if (!L.loaded) {
    const li = document.createElement('li');
    li.className = 'empty';
    li.textContent = 'Click “Load list”.';
    ul.append(li);
  } else {
    const items = visibleItems();
    if (!items.length) {
      const li = document.createElement('li');
      li.className = 'empty';
      li.textContent = L.items.length ? 'No matches.' : 'Nothing here.';
      ul.append(li);
    }
    for (const it of items) {
      const li = document.createElement('li');
      if (it.disabled) li.className = 'disabled';
      const label = document.createElement('label');
      const cb = document.createElement('input');
      cb.type = 'checkbox';
      cb.disabled = !!it.disabled || running;
      cb.checked = L.selected.has(it.id);
      cb.addEventListener('change', () => {
        cb.checked ? L.selected.add(it.id) : L.selected.delete(it.id);
        resetConfirm();
        updateCounts();
      });
      const text = document.createElement('div');
      const name = document.createElement('div');
      name.className = 'name';
      name.textContent = it.label;
      text.append(name);
      if (it.sub) {
        const sub = document.createElement('div');
        sub.className = 'sub';
        sub.textContent = it.sub;
        text.append(sub);
      }
      label.append(cb, text);
      li.append(label);
      ul.append(li);
    }
  }
  updateCounts();
}

function updateCounts() {
  const L = lists[active];
  const n = L.selected.size;
  $('#selCount').textContent = L.loaded ? `${n} of ${L.items.length} selected` : '';
  $('#start').disabled = running || n === 0 || tabId == null;
  if (confirmTimer) return; // keep the "click again to confirm" text while it's pending
  const v = VERBS[active];
  const dry = $('#dryRun').checked;
  const plural = n === 1 ? v.noun : v.noun + 's';
  $('#start').textContent = dry ? `Preview ${n} ${plural} (dry run)` : `${v.action} ${n} ${plural}`;
}

function switchTab(name) {
  active = name;
  document.querySelectorAll('.tab').forEach((t) => t.classList.toggle('active', t.dataset.tab === name));
  $('#dmOpts').classList.toggle('hidden', name !== 'dms');
  $('#filter').value = '';
  renderList();
}

async function loadList() {
  const btn = $('#load');
  btn.disabled = true;
  btn.textContent = 'Loading…';
  try {
    const { items } = await send({ type: 'load', what: active });
    const L = lists[active];
    L.items = items;
    L.loaded = true;
    const ids = new Set(items.map((i) => i.id));
    L.selected = new Set([...L.selected].filter((id) => ids.has(id)));
    banner('');
  } catch (e) {
    banner(e.message);
  } finally {
    btn.disabled = false;
    btn.textContent = 'Reload list';
    renderList();
  }
}

// ---------- Running ----------

function resetConfirm() {
  clearTimeout(confirmTimer);
  confirmTimer = null;
  $('#start').classList.remove('confirm');
}

async function start() {
  const dry = $('#dryRun').checked;
  const L = lists[active];

  // Real runs need a second click within 4 seconds.
  if (!dry && !confirmTimer) {
    const btn = $('#start');
    btn.classList.add('confirm');
    btn.textContent = 'Click again to confirm — this cannot be undone';
    confirmTimer = setTimeout(() => {
      resetConfirm();
      updateCounts();
    }, 4000);
    return;
  }
  resetConfirm();

  const items = L.items.filter((it) => L.selected.has(it.id) && !it.disabled);
  const opts = {
    ...readSpeed(),
    dryRun: dry,
    deleteMessages: $('#optDelete').checked,
    closeDm: $('#optClose').checked,
  };
  try {
    await send({ type: 'start', kind: active, items, opts });
    banner('');
    poll();
  } catch (e) {
    banner(e.message);
  }
}

function renderStatus(s) {
  running = !!s.running;
  const pct = s.total ? Math.round((s.done / s.total) * 100) : 0;
  $('#barFill').style.width = (s.finished && !s.running ? 100 : pct) + '%';

  let text = '';
  if (s.running) {
    text = `${s.paused ? 'Paused' : s.dryRun ? 'Previewing' : 'Working'} — ${s.done}/${s.total}`;
    if (s.resting) text += ` · ${s.resting}`;
    else if (s.current) text += ` · ${s.current}`;
  } else if (s.finished) {
    text = `Done — ${s.done}/${s.total}${s.dryRun ? ' (dry run, nothing changed)' : ''}`;
  }
  $('#statusText').textContent = text;

  const st = s.stats || {};
  const parts = [];
  if (s.kind) {
    parts.push(`${st.ok || 0} ok`, `${st.failed || 0} failed`);
    if (s.kind === 'dms') parts.push(`${st.messages || 0} messages ${s.dryRun ? 'found' : 'deleted'}`, `${st.skipped || 0} skipped`);
  }
  $('#stats').textContent = parts.join(' · ');

  const log = $('#log');
  const atBottom = log.scrollTop + log.clientHeight >= log.scrollHeight - 5;
  log.textContent = '';
  for (const entry of s.log || []) {
    const li = document.createElement('li');
    li.className = entry.level;
    li.textContent = `${new Date(entry.t).toLocaleTimeString()}  ${entry.text}`;
    log.append(li);
  }
  if (atBottom) log.scrollTop = log.scrollHeight;

  $('#pause').disabled = !s.running;
  $('#pause').textContent = s.paused ? 'Resume' : 'Pause';
  $('#stop').disabled = !s.running;
  $('#load').disabled = s.running;
  $('#list').querySelectorAll('input').forEach((cb, i) => {
    const it = visibleItems()[i];
    cb.disabled = s.running || !!(it && it.disabled);
  });
  updateCounts();
}

let pollTimer = null;
async function poll() {
  clearTimeout(pollTimer);
  try {
    renderStatus(await send({ type: 'status' }));
  } catch (e) {
    banner(e.message);
  }
  pollTimer = setTimeout(poll, 700);
}

// ---------- Init ----------

async function init() {
  document.querySelectorAll('.tab').forEach((t) => t.addEventListener('click', () => switchTab(t.dataset.tab)));
  $('#load').addEventListener('click', loadList);
  $('#join').addEventListener('click', () => chrome.tabs.create({ url: INVITE_URL }));
  $('#filter').addEventListener('input', renderList);
  $('#selAll').addEventListener('click', () => {
    visibleItems().forEach((it) => !it.disabled && lists[active].selected.add(it.id));
    renderList();
  });
  $('#selNone').addEventListener('click', () => {
    lists[active].selected.clear();
    renderList();
  });
  $('#dryRun').addEventListener('change', () => {
    resetConfirm();
    updateCounts();
  });
  $('#speed').addEventListener('change', () => {
    describeSpeed();
    saveSettings();
  });
  ['#cDelay', '#cMsgDelay', '#cJitter', '#cBreakEvery', '#cBreakSec', '#optDelete', '#optClose'].forEach((id) =>
    $(id).addEventListener('change', () => {
      describeSpeed();
      saveSettings();
    })
  );
  $('#start').addEventListener('click', start);
  $('#pause').addEventListener('click', async () => renderStatus(await send({ type: 'pause' })));
  $('#stop').addEventListener('click', async () => renderStatus(await send({ type: 'stop' })));

  await loadSettings();
  renderList();

  tabId = await findDiscordTab();
  if (tabId == null) {
    banner('Open https://discord.com/app in a tab and log in, then reopen this menu.');
    updateCounts();
    return;
  }

  try {
    const pong = await send({ type: 'ping' });
    const expected = chrome.runtime.getManifest().version;
    const missing = Object.keys(lists).filter((k) => !(pong.lists || []).includes(k));
    if (pong.version !== expected || missing.length) {
      throw new Error(
        'Your Discord tab is still running an older version of this extension. ' +
          'Reload the Discord tab (F5), then reopen this menu.'
      );
    }
  } catch (e) {
    banner(e.message);
    tabId = null;
    updateCounts();
    return;
  }

  const { hasToken } = await chrome.runtime.sendMessage({ type: 'hasToken' });
  if (!hasToken) banner('Reload the Discord tab (F5) once so the extension can pick up your session.');

  poll();
}

init();
