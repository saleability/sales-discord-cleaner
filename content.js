// Runs inside the discord.com tab. Holds the job queue so it keeps running
// after the popup closes. All requests go only to https://discord.com/api.

(() => {
  const VERSION = chrome.runtime.getManifest().version;

  const API = 'https://discord.com/api/v9';

  const state = {
    running: false,
    paused: false,
    stop: false,
    finished: false,
    kind: null,
    dryRun: true,
    total: 0,
    done: 0,
    current: '',
    resting: '',
    stats: { ok: 0, failed: 0, skipped: 0, messages: 0 },
    log: [],
  };

  let me = null;
  let pacing = null;

  class StopError extends Error {}

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  function log(text, level = 'info') {
    state.log.push({ t: Date.now(), text, level });
    if (state.log.length > 400) state.log.shift();
  }

  // Waits while paused; throws if the user pressed Stop.
  async function checkpoint() {
    while (state.paused && !state.stop) await sleep(250);
    if (state.stop) throw new StopError('Stopped');
  }

  // Sleep that can be interrupted by Stop and frozen by Pause.
  async function wait(ms) {
    let remaining = ms;
    while (remaining > 0) {
      if (state.stop) throw new StopError('Stopped');
      if (state.paused) {
        await sleep(250);
        continue;
      }
      const step = Math.min(250, remaining);
      await sleep(step);
      remaining -= step;
    }
  }

  // ---------- Pacing (anti-ban speed control) ----------
  // Each action waits base delay ± jitter. Every `breakEvery` actions it also
  // takes a longer rest so the activity doesn't look like a constant stream.

  function makePacer(opts) {
    let count = 0;
    const jitter = Math.min(Math.max(opts.jitter ?? 0.4, 0), 0.9);
    const randomize = (ms) => Math.max(250, Math.round(ms * (1 - jitter + Math.random() * jitter * 2)));

    return async function pace(kind) {
      const base = kind === 'message' ? opts.msgDelay : opts.delay;
      await wait(randomize(base));
      count++;
      if (opts.breakEvery > 0 && count % opts.breakEvery === 0 && opts.breakMs > 0) {
        const rest = randomize(opts.breakMs);
        log(`Taking a ${(rest / 1000).toFixed(0)}s break after ${count} actions…`, 'muted');
        state.resting = `Resting ${(rest / 1000).toFixed(0)}s`;
        try {
          await wait(rest);
        } finally {
          state.resting = '';
        }
      }
    };
  }

  // ---------- API ----------

  async function getToken() {
    const r = await chrome.runtime.sendMessage({ type: 'getToken' });
    if (!r || !r.token) {
      throw new Error('No Discord session captured yet. Reload the Discord tab (F5) and try again.');
    }
    return r.token;
  }

  async function api(method, path) {
    const token = await getToken();
    for (let attempt = 0; attempt < 12; attempt++) {
      const res = await fetch(API + path, { method, headers: { Authorization: token } });

      if (res.status === 429) {
        const body = await res.json().catch(() => ({}));
        const secs = Number(body.retry_after ?? res.headers.get('retry-after') ?? 5) || 5;
        log(`Rate limited by Discord — waiting ${secs.toFixed(1)}s`, 'warn');
        // Back off a bit more than asked, and slow future actions down.
        if (pacing) {
          pacing.delay = Math.min(pacing.delay * 1.25, 15000);
          pacing.msgDelay = Math.min(pacing.msgDelay * 1.25, 15000);
        }
        await wait(secs * 1000 + 1000);
        continue;
      }

      if (res.status === 204) return null;
      const data = await res.json().catch(() => null);

      if (res.status === 401) throw new Error('Discord rejected the session (401). Reload the Discord tab.');
      if (!res.ok) {
        const err = new Error((data && data.message) || `HTTP ${res.status}`);
        err.status = res.status;
        err.code = data && data.code;
        throw err;
      }
      return data;
    }
    throw new Error('Gave up after repeated rate limits.');
  }

  async function getMe() {
    if (!me) me = await api('GET', '/users/@me');
    return me;
  }

  // ---------- Loaders ----------

  const userName = (u) =>
    !u ? 'Unknown user' : u.global_name ? `${u.global_name} (@${u.username})` : `@${u.username}`;

  const REL_TYPES = { 1: 'Friend', 2: 'Blocked', 3: 'Incoming request', 4: 'Outgoing request' };

  const snow = (id) => BigInt(id || 0);
  const byNewest = (a, b) => {
    const x = snow(a.last_message_id);
    const y = snow(b.last_message_id);
    return x > y ? -1 : x < y ? 1 : 0;
  };

  const LOADERS = {
    async friends() {
      const rels = await api('GET', '/users/@me/relationships');
      return rels
        .map((r) => ({ id: r.id, label: userName(r.user), sub: REL_TYPES[r.type] || `Type ${r.type}`, group: r.type }))
        .sort((a, b) => a.group - b.group || a.label.localeCompare(b.label));
    },

    async servers() {
      const guilds = await api('GET', '/users/@me/guilds');
      return guilds
        .map((g) => ({
          id: g.id,
          label: g.name,
          sub: g.owner ? 'You own this server — transfer or delete it instead' : '',
          disabled: !!g.owner,
        }))
        .sort((a, b) => a.label.localeCompare(b.label));
    },

    async dms() {
      const channels = await api('GET', '/users/@me/channels');
      return channels
        .filter((c) => c.type === 1 || c.type === 3)
        .sort(byNewest)
        .map((c) => {
          if (c.type === 1) {
            return { id: c.id, label: userName(c.recipients && c.recipients[0]), sub: 'Direct message' };
          }
          const names = (c.recipients || []).map((u) => u.global_name || u.username).join(', ');
          return { id: c.id, label: c.name || names || 'Group DM', sub: 'Group DM (closing it leaves the group)' };
        });
    },

    // Settings → Authorized Apps (OAuth2 apps you've granted access to).
    async apps() {
      const tokens = await api('GET', '/oauth2/tokens');
      return tokens
        .map((t) => ({
          id: t.id,
          label: (t.application && t.application.name) || 'Unknown app',
          sub: (t.scopes || []).length ? `Access: ${t.scopes.join(', ')}` : '',
        }))
        .sort((a, b) => a.label.localeCompare(b.label));
    },
  };

  // ---------- Jobs ----------

  async function runSimple(items, opts, pace, { path, verb }) {
    for (const it of items) {
      await checkpoint();
      state.current = it.label;
      if (opts.dryRun) {
        log(`[dry run] would ${verb} ${it.label}`);
        state.stats.ok++;
      } else {
        try {
          await api('DELETE', path(it.id));
          log(`${verb[0].toUpperCase() + verb.slice(1)}: ${it.label}`, 'ok');
          state.stats.ok++;
        } catch (e) {
          if (e instanceof StopError) throw e;
          log(`Failed to ${verb} ${it.label}: ${e.message}`, 'error');
          state.stats.failed++;
        }
        state.done++;
        await pace('action');
        continue;
      }
      state.done++;
    }
  }

  // Regular user messages (0) and replies (19). System messages (calls,
  // group joins, etc.) can't be deleted, so they're skipped.
  const DELETABLE_TYPES = new Set([0, 19]);

  async function purgeChannel(it, myId, opts, pace) {
    let before = null;
    let found = 0;
    let deleted = 0;
    log(`Scanning ${it.label}…`);

    while (true) {
      await checkpoint();
      const q = `?limit=100${before ? `&before=${before}` : ''}`;
      const batch = await api('GET', `/channels/${it.id}/messages${q}`);
      if (!batch || batch.length === 0) break;
      before = batch[batch.length - 1].id;

      for (const m of batch) {
        if (!m.author || m.author.id !== myId) continue;
        if (!DELETABLE_TYPES.has(m.type)) {
          state.stats.skipped++;
          continue;
        }
        await checkpoint();
        found++;
        if (opts.dryRun) continue;

        try {
          await api('DELETE', `/channels/${it.id}/messages/${m.id}`);
          deleted++;
          state.stats.messages++;
        } catch (e) {
          if (e instanceof StopError) throw e;
          if (e.status !== 404) {
            state.stats.skipped++;
            log(`Couldn't delete a message in ${it.label}: ${e.message}`, 'warn');
          }
        }
        state.current = `${it.label} — ${deleted} deleted`;
        await pace('message');
      }

      if (opts.dryRun) state.current = `${it.label} — ${found} found so far`;
      // Small pause between history pages.
      await wait(opts.dryRun ? 400 : 800);
    }

    if (opts.dryRun) {
      state.stats.messages += found;
      log(`[dry run] ${it.label}: ${found} of your messages would be deleted`);
    } else {
      log(`${it.label}: deleted ${deleted} of ${found} messages`, 'ok');
    }
  }

  async function runDms(items, opts, pace) {
    const myId = (await getMe()).id;
    for (const it of items) {
      await checkpoint();
      state.current = it.label;
      try {
        if (opts.deleteMessages) await purgeChannel(it, myId, opts, pace);
        if (opts.closeDm) {
          if (opts.dryRun) {
            log(`[dry run] would close ${it.label}`);
          } else {
            await api('DELETE', `/channels/${it.id}`);
            log(`Closed ${it.label}`, 'ok');
            await pace('action');
          }
        }
        state.stats.ok++;
      } catch (e) {
        if (e instanceof StopError) throw e;
        log(`Failed on ${it.label}: ${e.message}`, 'error');
        state.stats.failed++;
      }
      state.done++;
    }
  }

  const RUNNERS = {
    friends: (items, opts, pace) =>
      runSimple(items, opts, pace, { path: (id) => `/users/@me/relationships/${id}`, verb: 'remove' }),
    servers: (items, opts, pace) =>
      runSimple(items, opts, pace, { path: (id) => `/users/@me/guilds/${id}`, verb: 'leave' }),
    dms: runDms,
    apps: (items, opts, pace) =>
      runSimple(items, opts, pace, { path: (id) => `/oauth2/tokens/${id}`, verb: 'deauthorize' }),
  };

  function startJob({ kind, items, opts }) {
    if (state.running) throw new Error('A job is already running.');
    if (!RUNNERS[kind]) throw new Error(`Unknown job: ${kind}`);
    if (!Array.isArray(items) || items.length === 0) throw new Error('Nothing selected.');
    if (kind === 'dms' && !opts.deleteMessages && !opts.closeDm) {
      throw new Error('Pick at least one DM option (delete messages and/or close DM).');
    }

    pacing = {
      dryRun: !!opts.dryRun,
      delay: Math.max(500, Number(opts.delay) || 1500),
      msgDelay: Math.max(500, Number(opts.msgDelay) || 1200),
      jitter: Number(opts.jitter ?? 0.4),
      breakEvery: Math.max(0, Number(opts.breakEvery) || 0),
      breakMs: Math.max(0, Number(opts.breakMs) || 0),
      deleteMessages: !!opts.deleteMessages,
      closeDm: !!opts.closeDm,
    };
    const pace = makePacer(pacing);

    Object.assign(state, {
      running: true,
      paused: false,
      stop: false,
      finished: false,
      kind,
      dryRun: pacing.dryRun,
      total: items.length,
      done: 0,
      current: '',
      resting: '',
      stats: { ok: 0, failed: 0, skipped: 0, messages: 0 },
      log: [],
    });

    log(
      `${pacing.dryRun ? 'DRY RUN — nothing will be changed. ' : ''}Starting ${kind}: ${items.length} selected. ` +
        `Delay ~${pacing.delay}ms (messages ~${pacing.msgDelay}ms)` +
        (pacing.breakEvery ? `, break ${Math.round(pacing.breakMs / 1000)}s every ${pacing.breakEvery}` : '') +
        '.'
    );

    RUNNERS[kind](items, pacing, pace)
      .then(() => log('Finished.', 'ok'))
      .catch((e) =>
        e instanceof StopError ? log('Stopped by you.', 'warn') : log(`Job failed: ${e.message}`, 'error')
      )
      .finally(() => {
        state.running = false;
        state.paused = false;
        state.finished = true;
        state.current = '';
        state.resting = '';
        pacing = null;
      });
  }

  function snapshot() {
    return {
      running: state.running,
      paused: state.paused,
      finished: state.finished,
      kind: state.kind,
      dryRun: state.dryRun,
      total: state.total,
      done: state.done,
      current: state.current,
      resting: state.resting,
      stats: { ...state.stats },
      log: state.log.slice(-150),
    };
  }

  async function handle(msg) {
    switch (msg && msg.type) {
      case 'ping':
        return { ok: true, version: VERSION, lists: Object.keys(LOADERS) };
      case 'status':
        return snapshot();
      case 'load':
        if (state.running) throw new Error('Wait for the current job to finish first.');
        if (!LOADERS[msg.what]) {
          throw new Error('The Discord tab is running an older version. Reload the Discord tab (F5) and try again.');
        }
        return { items: await LOADERS[msg.what]() };
      case 'start':
        startJob(msg);
        return snapshot();
      case 'pause':
        if (state.running) state.paused = !state.paused;
        return snapshot();
      case 'stop':
        if (state.running) {
          state.stop = true;
          state.paused = false;
        }
        return snapshot();
      default:
        throw new Error('Unknown request.');
    }
  }

  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (sender.id !== chrome.runtime.id) return;
    handle(msg).then(sendResponse, (e) => sendResponse({ error: e.message }));
    return true;
  });

  window.addEventListener('beforeunload', (e) => {
    if (state.running) {
      e.preventDefault();
      e.returnValue = '';
    }
  });
})();
