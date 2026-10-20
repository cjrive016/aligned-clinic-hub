/* =====================================================================
   CLOUDFLARE-ONLY ADDITIONS: email via Resend, cron, backup, entry point
   ===================================================================== */

const UrlFetchApp = { fetch: function () { throw userErr_('Import link could not be fetched.'); } };

function emailCfg_() {
  try { return JSON.parse(PropertiesService.getScriptProperties().getProperty('email_cfg') || '{}'); } catch (e) { return {}; }
}

function adminInfo_() {
  const last = PropertiesService.getScriptProperties().getProperty('last_tick');
  const cfg = emailCfg_();
  return {
    triggerOn: !!last && (Date.now() - Number(last)) < 2 * 3600 * 1000,
    lastTick: last ? new Date(Number(last)).toISOString() : '',
    emailOn: !!cfg.apiKey,
    emailFrom: cfg.from || '',
    emailKeyHint: cfg.apiKey ? '••••' + cfg.apiKey.slice(-4) : '',
    appUrl: appUrl_(),
    emailLog: REQ.emailLog || []
  };
}

function triggerOn_() { return adminInfo_().triggerOn; }

function a_triggersInstall_() { return { triggerOn: triggerOn_() }; }

function a_emailCfgSave_(me, p) {
  const cfg = emailCfg_();
  const key = str_(p.apiKey);
  if (key) {
    if (!/^re_[A-Za-z0-9_]{10,}$/.test(key)) throw userErr_('That does not look like a Resend API key (it starts with re_).');
    cfg.apiKey = key;
  }
  if (p.clearKey) delete cfg.apiKey;
  if (p.from !== undefined) {
    const from = str_(p.from);
    if (from && !/@[^@\s]+\.[^@\s]+>?$/.test(from)) throw userErr_('The "from" address should look like: Clinic Hub <hub@alignedhealthmurray.com>');
    cfg.from = from;
  }
  PropertiesService.getScriptProperties().setProperty('email_cfg', JSON.stringify(cfg));
  return { admin: adminInfo_() };
}

function a_adminInfo_() { return { admin: adminInfo_() }; }

function a_exportAll_() {
  const out = { exportedAt: nowIso_(), settings: settings_(), tables: {} };
  Object.keys(TABLES).forEach(function (n) {
    out.tables[n] = clean_(rows_(n)).map(function (r) { if (n === 'Users') { delete r.salt; delete r.hash; } return r; });
  });
  return out;
}

ACTIONS.emailCfgSave = { fn: a_emailCfgSave_, write: true, admin: true };
ACTIONS.adminInfo = { fn: a_adminInfo_, admin: true };
ACTIONS.exportAll = { fn: a_exportAll_, admin: true };

const PUBLIC_FNS = { appStatus: appStatus, setupAdmin: setupAdmin, login: login, logout: logout, api: api };

/* ---------- one request at a time per worker instance ---------- */
let chain = Promise.resolve();
function serial_(fn) {
  const p = chain.then(fn, fn);
  chain = p.catch(function () {});
  return p;
}

async function runLocked_(env, origin, work) {
  return serial_(async function () {
    await loadAll_(env, origin);
    if (origin && REQ.kv.app_url !== origin) PropertiesService.getScriptProperties().setProperty('app_url', origin);
    const result = work();
    await saveAll_(env);
    return { result: result, mail: REQ.outbox.slice(), cfg: emailCfg_() };
  });
}

async function sendMailBatch_(env, mail, cfg) {
  for (const m of mail) {
    let status = 'not sent: email is not set up yet (Admin > Emails)';
    if (cfg.apiKey) {
      try {
        const res = await fetch('https://api.resend.com/emails', {
          method: 'POST',
          headers: { 'Authorization': 'Bearer ' + cfg.apiKey, 'Content-Type': 'application/json' },
          body: JSON.stringify({ from: cfg.from || 'Aligned Clinic Hub <onboarding@resend.dev>', to: [m.to], subject: m.subject, text: m.body })
        });
        if (res.ok) status = 'sent';
        else { const t = await res.text(); status = 'failed: ' + t.slice(0, 180); }
      } catch (e) { status = 'failed: ' + String(e).slice(0, 180); }
    }
    try {
      await env.DB.prepare('INSERT INTO EmailLog (at, too, subject, status) VALUES (?, ?, ?, ?)').bind(new Date().toISOString(), m.to, m.subject, status).run();
    } catch (e) { console.warn('email log failed', e); }
  }
}

async function fetchOld_(url) {
  url = String(url || '').trim().split('?')[0];
  if (!/^https:\/\/script\.google\.com\/(a\/[^\/]+\/)?macros\/s\/[\w-]+\/exec$/.test(url)) {
    throw new Error('Paste the old app link. It starts with https://script.google.com/macros/s/ and ends with /exec');
  }
  const res = await fetch(url + '?api=load&token=' + encodeURIComponent(CONFIG.OLD_INVENTORY_TOKEN), { redirect: 'follow' });
  let body;
  try { body = JSON.parse(await res.text()); } catch (e) { throw new Error('Could not read the old app. Check the link.'); }
  if (!body.ok) throw new Error('The old app said: ' + (body.error || 'error'));
  return JSON.stringify(body.data);
}

function json_(obj, status) {
  return new Response(JSON.stringify(obj), { status: status || 200, headers: { 'content-type': 'application/json', 'cache-control': 'no-store' } });
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (!env.DB) return new Response('Setup needed: add a D1 database binding named DB to this worker.', { status: 500 });

    if (request.method === 'GET' && (url.pathname === '/' || url.pathname === '/index.html')) {
      return new Response(PAGE_HTML, { headers: {
        'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store',
        'x-frame-options': 'DENY', 'referrer-policy': 'same-origin', 'x-content-type-options': 'nosniff'
      } });
    }

    if (url.pathname === '/api' && request.method === 'POST') {
      let body;
      try { body = await request.json(); } catch (e) { return json_({ ok: false, message: 'Bad request' }, 400); }
      const fn = body && body.fn;
      const args = Array.isArray(body && body.args) ? body.args : [];
      if (!Object.prototype.hasOwnProperty.call(PUBLIC_FNS, fn)) return json_({ ok: false, message: 'Unknown call' }, 400);
      if (fn === 'api' && args[1] === 'importOld' && args[2] && args[2].url && !args[2].json) {
        try { args[2].json = await fetchOld_(args[2].url); } catch (e) { return json_({ ok: false, message: e.message }); }
      }
      try {
        const out = await runLocked_(env, url.origin, function () { return PUBLIC_FNS[fn].apply(null, args); });
        if (out.mail.length) ctx.waitUntil(sendMailBatch_(env, out.mail, out.cfg));
        return json_(out.result);
      } catch (e) {
        console.error(e && e.stack ? e.stack : e);
        return json_({ ok: false, message: 'Something went wrong on the server. Please try again.' }, 500);
      }
    }

    if (url.pathname === '/favicon.ico') return new Response(null, { status: 204 });
    return new Response('Not found', { status: 404 });
  },

  async scheduled(event, env, ctx) {
    const out = await runLocked_(env, env.APP_URL || '', function () {
      PropertiesService.getScriptProperties().setProperty('last_tick', String(Date.now()));
      if (!REQ.origin) REQ.origin = REQ.kv.app_url || '';
      hourlyTick();
    });
    if (out.mail.length) ctx.waitUntil(sendMailBatch_(env, out.mail, out.cfg));
  }
};
