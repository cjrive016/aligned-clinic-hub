/* =====================================================================
   DATA STORE — Cloudflare D1. All tables are loaded at the start of a
   request, the clinic logic works on them in memory, and every change
   is written back in one batch at the end.
   ===================================================================== */

function rows_(name) {
  if (!REQ.tables[name]) REQ.tables[name] = [];
  return REQ.tables[name];
}

function keyOf_(name) { return KEYS[name] || 'id'; }

function find_(name, id) {
  if (id === null || id === undefined || id === '') return null;
  const key = keyOf_(name);
  return rows_(name).filter(function (r) { return r[key] === String(id); })[0] || null;
}

function insertMany_(name, list) {
  if (!list.length) return;
  const cols = TABLES[name];
  list.forEach(function (o) {
    const enc = cols.map(function (c) { return toCell_(c, o[c]); });
    const dec = {};
    cols.forEach(function (c, j) { dec[c] = fromCell_(c, enc[j]); });
    rows_(name).push(dec);
    REQ.ops.push({ sql: 'INSERT OR REPLACE INTO "' + name + '" (' + cols.map(q_).join(',') + ') VALUES (' + cols.map(function () { return '?'; }).join(',') + ')', args: enc });
  });
}

function insert_(name, obj) { insertMany_(name, [obj]); }

function update_(name, id, patch) {
  const r = find_(name, id);
  if (!r) return;
  const cols = TABLES[name];
  const key = keyOf_(name);
  Object.keys(patch).forEach(function (k) { r[k] = fromCell_(k, toCell_(k, patch[k])); });
  const setCols = cols.filter(function (c) { return c !== key; });
  REQ.ops.push({ sql: 'UPDATE "' + name + '" SET ' + setCols.map(function (c) { return q_(c) + '=?'; }).join(',') + ' WHERE ' + q_(key) + '=?',
    args: setCols.map(function (c) { return toCell_(c, r[c]); }).concat([r[key]]) });
}

function remove_(name, id) {
  const r = find_(name, id);
  if (!r) return;
  const key = keyOf_(name);
  const list = rows_(name);
  list.splice(list.indexOf(r), 1);
  REQ.ops.push({ sql: 'DELETE FROM "' + name + '" WHERE ' + q_(key) + '=?', args: [r[key]] });
}

function q_(c) { return '"' + c + '"'; }

function fromCell_(c, v) {
  if (NUM_FIELDS[c]) return (v === '' || v === null || v === undefined) ? null : Number(v);
  if (BOOL_FIELDS[c]) return v === true || String(v).toUpperCase() === 'TRUE';
  return v === null || v === undefined ? '' : String(v);
}

function toCell_(c, v) {
  if (NUM_FIELDS[c]) return (v === null || v === undefined || v === '' || !isFinite(Number(v))) ? '' : String(v);
  if (BOOL_FIELDS[c]) return v ? 'TRUE' : '';
  return v === null || v === undefined ? '' : String(v);
}

function clean_(list) {
  return list.map(function (r) { const o = {}; for (const k in r) o[k] = r[k]; return o; });
}

/* ---------- load / save around each request ---------- */
let schemaReady = false;

async function ensureSchema_(env) {
  if (schemaReady) return;
  const stmts = Object.keys(TABLES).map(function (name) {
    const key = keyOf_(name);
    return env.DB.prepare('CREATE TABLE IF NOT EXISTS "' + name + '" (' +
      TABLES[name].map(function (c) { return q_(c) + ' TEXT' + (c === key ? ' PRIMARY KEY' : ''); }).join(', ') + ')');
  });
  stmts.push(env.DB.prepare('CREATE TABLE IF NOT EXISTS kv (k TEXT PRIMARY KEY, v TEXT)'));
  stmts.push(env.DB.prepare('CREATE TABLE IF NOT EXISTS EmailLog (id INTEGER PRIMARY KEY AUTOINCREMENT, at TEXT, too TEXT, subject TEXT, status TEXT)'));
  await env.DB.batch(stmts);
  // add any columns introduced by later versions
  for (const name of Object.keys(TABLES)) {
    const info = await env.DB.prepare('PRAGMA table_info("' + name + '")').all();
    const have = {};
    (info.results || []).forEach(function (r) { have[r.name] = true; });
    for (const c of TABLES[name]) {
      if (!have[c]) await env.DB.prepare('ALTER TABLE "' + name + '" ADD COLUMN ' + q_(c) + ' TEXT').run();
    }
  }
  schemaReady = true;
}

async function loadAll_(env, origin) {
  await ensureSchema_(env);
  REQ.kv = {}; REQ.kvDirty = {}; REQ.tables = {}; REQ.ops = []; REQ.outbox = []; REQ.origin = origin || '';
  const names = Object.keys(TABLES);
  const res = await env.DB.batch(names.map(function (n) { return env.DB.prepare('SELECT * FROM "' + n + '" ORDER BY rowid'); })
    .concat([env.DB.prepare('SELECT k, v FROM kv'), env.DB.prepare('SELECT at, too, subject, status FROM EmailLog ORDER BY id DESC LIMIT 40')]));
  REQ.emailLog = (res[names.length + 1].results || []).map(function (r) { return { at: r.at, to: r.too, subject: r.subject, status: r.status }; });
  names.forEach(function (n, i) {
    REQ.tables[n] = (res[i].results || []).map(function (row) {
      const o = {};
      TABLES[n].forEach(function (c) { o[c] = fromCell_(c, row[c]); });
      return o;
    });
  });
  (res[names.length].results || []).forEach(function (r) { REQ.kv[r.k] = r.v; });
}

async function saveAll_(env) {
  const stmts = REQ.ops.map(function (op) { const s = env.DB.prepare(op.sql); return s.bind.apply(s, op.args); });
  Object.keys(REQ.kvDirty).forEach(function (k) {
    if (Object.prototype.hasOwnProperty.call(REQ.kv, k)) stmts.push(env.DB.prepare('INSERT OR REPLACE INTO kv (k, v) VALUES (?, ?)').bind(k, REQ.kv[k]));
    else stmts.push(env.DB.prepare('DELETE FROM kv WHERE k = ?').bind(k));
  });
  if (stmts.length) await env.DB.batch(stmts);
  REQ.ops = []; REQ.kvDirty = {};
}
