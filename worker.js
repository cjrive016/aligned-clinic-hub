/**
 * ALIGNED CLINIC HUB — Cloudflare Worker (single file)
 * ----------------------------------------------------
 * Needs:  a D1 database binding named  DB
 *         a Cron Trigger that runs every 30 minutes
 * Tables are created automatically on first visit.
 * Email (Resend API key) is set from inside the app: Admin > Emails.
 */

// ===================================================================
// Cloudflare Worker runtime shims — give the clinic logic the same
// small set of services it used on Google Apps Script, backed by D1.
// ===================================================================

/* ---------- SHA-256 (sync, pure JS) ---------- */
function sha256Bytes_(str) {
  const msg = new TextEncoder().encode(str);
  const K = [0x428a2f98,0x71374491,0xb5c0fbcf,0xe9b5dba5,0x3956c25b,0x59f111f1,0x923f82a4,0xab1c5ed5,0xd807aa98,0x12835b01,0x243185be,0x550c7dc3,0x72be5d74,0x80deb1fe,0x9bdc06a7,0xc19bf174,0xe49b69c1,0xefbe4786,0x0fc19dc6,0x240ca1cc,0x2de92c6f,0x4a7484aa,0x5cb0a9dc,0x76f988da,0x983e5152,0xa831c66d,0xb00327c8,0xbf597fc7,0xc6e00bf3,0xd5a79147,0x06ca6351,0x14292967,0x27b70a85,0x2e1b2138,0x4d2c6dfc,0x53380d13,0x650a7354,0x766a0abb,0x81c2c92e,0x92722c85,0xa2bfe8a1,0xa81a664b,0xc24b8b70,0xc76c51a3,0xd192e819,0xd6990624,0xf40e3585,0x106aa070,0x19a4c116,0x1e376c08,0x2748774c,0x34b0bcb5,0x391c0cb3,0x4ed8aa4a,0x5b9cca4f,0x682e6ff3,0x748f82ee,0x78a5636f,0x84c87814,0x8cc70208,0x90befffa,0xa4506ceb,0xbef9a3f7,0xc67178f2];
  const H = [0x6a09e667,0xbb67ae85,0x3c6ef372,0xa54ff53a,0x510e527f,0x9b05688c,0x1f83d9ab,0x5be0cd19];
  const l = msg.length, nBlocks = ((l + 9 + 63) >> 6);
  const buf = new Uint8Array(nBlocks * 64); buf.set(msg); buf[l] = 0x80;
  const bits = l * 8, dv = new DataView(buf.buffer);
  dv.setUint32(buf.length - 4, bits >>> 0); dv.setUint32(buf.length - 8, Math.floor(bits / 0x100000000));
  const W = new Uint32Array(64);
  for (let b = 0; b < nBlocks; b++) {
    for (let t = 0; t < 16; t++) W[t] = dv.getUint32(b * 64 + t * 4);
    for (let t = 16; t < 64; t++) {
      const s0 = ((W[t-15]>>>7)|(W[t-15]<<25)) ^ ((W[t-15]>>>18)|(W[t-15]<<14)) ^ (W[t-15]>>>3);
      const s1 = ((W[t-2]>>>17)|(W[t-2]<<15)) ^ ((W[t-2]>>>19)|(W[t-2]<<13)) ^ (W[t-2]>>>10);
      W[t] = (W[t-16] + s0 + W[t-7] + s1) >>> 0;
    }
    let [a,b2,c,d,e,f,g,h] = H;
    for (let t = 0; t < 64; t++) {
      const S1 = ((e>>>6)|(e<<26)) ^ ((e>>>11)|(e<<21)) ^ ((e>>>25)|(e<<7));
      const ch = (e & f) ^ (~e & g);
      const t1 = (h + S1 + ch + K[t] + W[t]) >>> 0;
      const S0 = ((a>>>2)|(a<<30)) ^ ((a>>>13)|(a<<19)) ^ ((a>>>22)|(a<<10));
      const mj = (a & b2) ^ (a & c) ^ (b2 & c);
      const t2 = (S0 + mj) >>> 0;
      h = g; g = f; f = e; e = (d + t1) >>> 0; d = c; c = b2; b2 = a; a = (t1 + t2) >>> 0;
    }
    H[0]=(H[0]+a)>>>0; H[1]=(H[1]+b2)>>>0; H[2]=(H[2]+c)>>>0; H[3]=(H[3]+d)>>>0;
    H[4]=(H[4]+e)>>>0; H[5]=(H[5]+f)>>>0; H[6]=(H[6]+g)>>>0; H[7]=(H[7]+h)>>>0;
  }
  const out = [];
  H.forEach(x => out.push((x>>>24)&255, (x>>>16)&255, (x>>>8)&255, x&255));
  return out;
}

/* ---------- per-request state ---------- */
const REQ = { kv: {}, kvDirty: {}, tables: {}, ops: [], outbox: [], origin: '' };

const Utilities = {
  DigestAlgorithm: { SHA_256: 'sha256' },
  Charset: { UTF_8: 'utf8' },
  computeDigest: (alg, s) => sha256Bytes_(String(s)),
  base64Encode: bytes => { let s = ''; bytes.forEach(b => { s += String.fromCharCode(b & 255); }); return btoa(s); },
  getUuid: () => crypto.randomUUID(),
  formatDate(d, tz, f) {
    const p = {};
    new Intl.DateTimeFormat('en-US', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false, weekday: 'short' })
      .formatToParts(d).forEach(x => { p[x.type] = x.value; });
    const hr = Number(p.hour) % 24;
    const wd = { Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6, Sun: 7 }[p.weekday];
    if (f === 'yyyy-MM-dd') return p.year + '-' + p.month + '-' + p.day;
    if (f === 'u') return String(wd);
    if (f === 'H') return String(hr);
    if (f === 'm') return String(Number(p.minute));
    if (f === 'EEE MMM d, yyyy h:mm a') {
      const mon = new Intl.DateTimeFormat('en-US', { timeZone: tz, month: 'short' }).format(d);
      return p.weekday + ' ' + mon + ' ' + Number(p.day) + ', ' + p.year + ' ' + (hr % 12 || 12) + ':' + p.minute + ' ' + (hr < 12 ? 'AM' : 'PM');
    }
    throw new Error('Unsupported date format ' + f);
  }
};

const Session = { getScriptTimeZone: () => 'America/Chicago' };

const PropertiesService = {
  getScriptProperties: () => ({
    getProperty: k => (Object.prototype.hasOwnProperty.call(REQ.kv, k) ? REQ.kv[k] : null),
    setProperty: (k, v) => { REQ.kv[k] = String(v); REQ.kvDirty[k] = true; },
    deleteProperty: k => { delete REQ.kv[k]; REQ.kvDirty[k] = true; },
    getProperties: () => Object.assign({}, REQ.kv)
  })
};

const CacheService = {
  getScriptCache: () => ({
    get: k => {
      const raw = REQ.kv['cache_' + k];
      if (!raw) return null;
      try { const o = JSON.parse(raw); if (o.exp < Date.now()) return null; return o.v; } catch (e) { return null; }
    },
    put: (k, v, secs) => { REQ.kv['cache_' + k] = JSON.stringify({ v: String(v), exp: Date.now() + (secs || 600) * 1000 }); REQ.kvDirty['cache_' + k] = true; },
    remove: k => { delete REQ.kv['cache_' + k]; REQ.kvDirty['cache_' + k] = true; }
  })
};

const LockService = { getScriptLock: () => ({ tryLock: () => true, releaseLock() {} }) };

const MailApp = {
  sendEmail: m => { REQ.outbox.push(m); },
  getRemainingDailyQuota: () => 100
};

const ScriptApp = { getService: () => ({ getUrl: () => REQ.origin }) };

var CONFIG = {
  APP_NAME: 'Aligned Clinic Hub',
  /** >>> EDIT ME: default address for alerts (can also be changed in Admin) */
  NOTIFY_EMAIL: 'jacob@alignedhealthmurray.com',
  /** >>> EDIT ME: code needed once to create the first admin account */
  SETUP_CODE: 'aligned-setup-2026',
  /** token of the old Aligned Inventory app (used only for the one-time import) */
  OLD_INVENTORY_TOKEN: 'aligned-health-clinic-2026',
  /** >>> EDIT ME: who supplies can be assigned to. "Clinic" is the house account. */
  PEOPLE: ['Clinic', 'Sarah', 'Erica'],
  HOUSE: 'Clinic',
  SESSION_DAYS: 14,
  QC_RETENTION_DAYS: 730 // 2 years
};

var DAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri'];
var DAY_NAMES = { Mon: 'Monday', Tue: 'Tuesday', Wed: 'Wednesday', Thu: 'Thursday', Fri: 'Friday' };

/** >>> EDIT ME: starting cleaning schedule — [person, task] pairs for each day.
 *  The person is matched to an account by username or first name. */
var SCHEDULE_VERSION = 4;
/** >>> EDIT ME: first day cleaning sign-offs and emails count. Change it in Admin. */
var CLEANING_START = '2026-10-20';
var SETTINGS_VERSION = 3;
var DEFAULT_SCHEDULE = {
  Mon: [['Dianne', 'Sweep'], ['Jerry', 'Restrooms'], ['Team', 'Trash']],
  Tue: [['Megan', 'Sweep'], ['Shayla', 'Restrooms'], ['Team', 'Trash']],
  Wed: [['Dianne', 'Sweep & Mop'], ['Megan', 'Restrooms'], ['Team', 'Trash']],
  Thu: [['Jerry', 'Sweep & Mop'], ['Shayla', 'Restrooms'], ['Team', 'Trash']],
  Fri: [['Megan', 'Sweep'], ['Jerry', 'Restrooms'], ['Team', 'Trash']]
};
var CLEANING_RULE = 'Sweeping: if you see a spot, mop it up. Don\'t leave it for mop days (Wed & Thu). ' +
  'Trash is a team job: both people on that day are responsible. Jobs swap every other week so everyone gets a turn. ' +
  'If you leave early, you still must do your task. Tasks can be done with or without patients here. ' +
  'Do NOT push it off until the next day: new day = new task. ' +
  'Every task needs 2 people to sign off: one person signs off, then a second person checks it and confirms. ' +
  'If a task is missed it carries over to your next work day until it is done. If someone covers your task, you take their next turn at that task.';

var DEFAULT_QC_TESTS = [
  'Strep A', 'Influenza A/B', 'COVID-19', 'Flu/COVID combo', 'RSV',
  'Urine pregnancy (hCG)', 'Urinalysis dipstick', 'Glucose meter', 'Hemoglobin A1c', 'Mono'
];

/* ---------- tables (one sheet tab each) ---------- */
var TABLES = {
  Users:    ['username', 'name', 'email', 'role', 'salt', 'hash', 'active', 'createdAt'],
  Items:    ['id', 'name', 'category', 'owner', 'qty', 'price', 'reorderAt', 'notes', 'paid', 'paidDate', 'createdAt'],
  Orders:   ['id', 'itemId', 'name', 'qty', 'price', 'assignTo', 'by', 'note', 'status', 'requestedAt', 'orderedAt', 'receivedAt'],
  Cleaning: ['id', 'date', 'day', 'task', 'assigned', 'assignedName', 'doneBy', 'doneByName', 'doneAt', 'offAssignment', 'late', 'comment', 'kind'],
  Meds:     ['id', 'name', 'ndc', 'lot', 'expiration', 'qty', 'location', 'notes', 'addedBy', 'addedAt', 'updatedBy', 'updatedAt'],
  Swaps:    ['id', 'date', 'task', 'fromName', 'toName', 'coverId', 'origDate', 'createdAt'],
  Notes:    ['id', 'wall', 'text', 'color', 'fromUser', 'fromName', 'createdAt', 'seenAt', 'done', 'doneAt', 'doneBy', 'groupId', 'walls', 'deleted', 'deletedAt', 'deletedBy', 'editedAt'],
  NoteComments: ['id', 'noteKey', 'text', 'byUser', 'byName', 'at', 'kind'],
  QC:       ['id', 'loggedAt', 'test', 'lot', 'expiration', 'reason', 'posControl', 'negControl', 'result', 'byName', 'by', 'notes', 'voided', 'voidReason', 'voidedBy']
};
var KEYS = { Users: 'username' };
var NUM_FIELDS = { qty: 1, price: 1, reorderAt: 1 };
var BOOL_FIELDS = { paid: 1, active: 1, offAssignment: 1, late: 1, voided: 1, done: 1, deleted: 1 };
var DATE_ONLY = { date: 1, expiration: 1 };

/* =====================================================================
   PUBLIC ENTRY POINTS (callable from the page)
   Every other function ends with "_" so the page cannot call it.
   ===================================================================== */

function appStatus() {
  return guard_(function () {
    return { needsSetup: rows_('Users').length === 0, appName: CONFIG.APP_NAME };
  });
}

function setupAdmin(code, form) {
  return guard_(function () {
    return withLock_(function () {
      if (rows_('Users').length) throw userErr_('Setup is already done. Please sign in.');
      if (String(code || '').trim() !== CONFIG.SETUP_CODE) throw userErr_('That setup code is not correct.');
      var u = createUser_(form || {}, 'admin');
      return { token: newSession_(u.username) };
    });
  });
}

function login(username, password) {
  return guard_(function () {
    var un = String(username || '').trim().toLowerCase();
    var cache = CacheService.getScriptCache();
    var ck = 'fail_' + un;
    var fails = Number(cache.get(ck) || 0);
    if (fails >= 5) throw userErr_('Too many tries. Wait 10 minutes and try again.');
    var u = findUser_(un);
    if (!u || !u.active || hash_(u.salt, String(password || '')) !== u.hash) {
      cache.put(ck, String(fails + 1), 600);
      throw userErr_('Username or password is not correct.');
    }
    cache.remove(ck);
    pruneSessions_();
    return { token: newSession_(u.username) };
  });
}

function logout(token) {
  return guard_(function () {
    if (token) PropertiesService.getScriptProperties().deleteProperty('sess_' + token);
    return true;
  });
}

function api(token, action, payload) {
  return guard_(function () {
    var me = sessionUser_(token);
    var h = ACTIONS[action];
    if (!h) throw userErr_('Unknown action.');
    if (h.admin && me.role !== 'admin') throw userErr_('Only an admin can do that.');
    var run = function () { return h.fn(me, payload || {}); };
    return h.write ? withLock_(run) : run();
  });
}

/** Runs every 30 minutes once "automatic emails" is turned on in Admin. */
function hourlyTick() {
  var s = settings_();
  var now = new Date();
  var tz = tz_();
  var dow = Number(Utilities.formatDate(now, tz, 'u')); // 1 = Monday … 7 = Sunday
  if (dow > 5) return;
  var hour = Number(Utilities.formatDate(now, tz, 'H')) + Number(Utilities.formatDate(now, tz, 'm')) / 60;
  var today = ymd_(now);
  var dayKey = DAYS[dow - 1];
  if (s.closedDates.indexOf(today) >= 0) return;
  if (s.startDate && today < s.startDate) return;
  var props = PropertiesService.getScriptProperties();
  if (hour >= s.morningHour && hour < s.checkHour && props.getProperty('sent_morning') !== today) {
    props.setProperty('sent_morning', today);
    try { sendMorning_(s, dayKey, today); } catch (e) { console.warn('Morning email failed: ' + e); }
  }
  if (hour >= s.checkHour && props.getProperty('sent_check') !== today) {
    props.setProperty('sent_check', today);
    try { sendMissed_(s, dayKey, today); } catch (e) { console.warn('Missed email failed: ' + e); }
  }
}

/* =====================================================================
   ACTIONS
   ===================================================================== */

var ACTIONS = {
  bootstrap:        { fn: a_bootstrap_ },
  changePassword:   { fn: a_changePassword_, write: true },

  cleanDone:        { fn: a_cleanDone_, write: true },
  cleanUndo:        { fn: a_cleanUndo_, write: true },
  cleanMonth:       { fn: a_cleanMonth_ },

  itemSave:         { fn: a_itemSave_, write: true },
  itemQty:          { fn: a_itemQty_, write: true },
  itemDelete:       { fn: a_itemDelete_, write: true, admin: true },
  itemPaid:         { fn: a_itemPaid_, write: true, admin: true },
  orderFlagItem:    { fn: a_orderFlagItem_, write: true },
  orderRequest:     { fn: a_orderRequest_, write: true },
  orderCost:        { fn: a_orderCost_, write: true, admin: true },
  orderOrdered:     { fn: a_orderOrdered_, write: true, admin: true },
  orderReceived:    { fn: a_orderReceived_, write: true },
  orderRemove:      { fn: a_orderRemove_, write: true, admin: true },

  qcAdd:            { fn: a_qcAdd_, write: true },
  qcVoid:           { fn: a_qcVoid_, write: true, admin: true },
  qcDelete:         { fn: a_qcDelete_, write: true, admin: true },

  medSave:          { fn: a_medSave_, write: true },
  noteAdd:          { fn: a_noteAdd_, write: true },
  noteDone:         { fn: a_noteDone_, write: true },
  noteDelete:       { fn: a_noteDelete_, write: true },
  noteSeen:         { fn: a_noteSeen_, write: true },
  noteEdit:         { fn: a_noteEdit_, write: true },
  noteComment:      { fn: a_noteComment_, write: true },
  notePurge:        { fn: a_notePurge_, write: true, admin: true },
  medDelete:        { fn: a_medDelete_, write: true, admin: true },

  userAdd:          { fn: a_userAdd_, write: true, admin: true },
  userUpdate:       { fn: a_userUpdate_, write: true, admin: true },
  userResetPw:      { fn: a_userResetPw_, write: true, admin: true },
  userDelete:       { fn: a_userDelete_, write: true, admin: true },
  settingsSave:     { fn: a_settingsSave_, write: true, admin: true },
  dayClosed:        { fn: a_dayClosed_, write: true, admin: true },
  triggersInstall:  { fn: a_triggersInstall_, write: true, admin: true },
  testEmail:        { fn: a_testEmail_, admin: true },
  importOld:        { fn: a_importOld_, write: true, admin: true }
};

/* ---------- bootstrap ---------- */
function a_bootstrap_(me) {
  var s = settings_();
  var isAdmin = me.role === 'admin';
  var week = weekInfo_();
  var out = {
    me: pubUser_(me, true),
    today: week.today,
    todayKey: week.todayKey,
    weekDates: week.dates,
    schedule: s.schedule,
    weekSchedule: weekSchedule_(s, week),
    rotateWeekly: s.rotateWeekly !== false,
    closedDates: s.closedDates,
    qcTests: s.qcTests,
    people: CONFIG.PEOPLE,
    house: CONFIG.HOUSE,
    users: rows_('Users').filter(function (u) { return u.active; }).map(function (u) { return pubUser_(u, isAdmin); }),
    cleaning: cleaningBetween_(week.dates.Mon, week.dates.Fri),
    carryOver: carryOver_(s, week.today),
    items: clean_(rows_('Items')),
    orders: clean_(rows_('Orders')),
    qc: clean_(rows_('QC')),
    meds: clean_(rows_('Meds')),
    notes: notesList_(me).notes,
    noteComments: notesList_(me).noteComments,
    qcRetentionDays: CONFIG.QC_RETENTION_DAYS,
    cleaningRule: CLEANING_RULE,
    startDate: s.startDate || '',
    settings: null,
    admin: null
  };
  if (isAdmin) {
    out.settings = { notifyEmail: s.notifyEmail, morningHour: s.morningHour, checkHour: s.checkHour, startDate: s.startDate };
    out.admin = adminInfo_();
  }
  return out;
}

function a_changePassword_(me, p) {
  if (hash_(me.salt, String(p.current || '')) !== me.hash) throw userErr_('Your current password is not correct.');
  var next = String(p.next || '');
  if (next.length < 6) throw userErr_('New password must be at least 6 characters.');
  var salt = uid_() + uid_();
  update_('Users', me.username, { salt: salt, hash: hash_(salt, next) });
  return true;
}

/* =====================================================================
   CLEANING
   ===================================================================== */

function cleaningBetween_(from, to) {
  return clean_(rows_('Cleaning').filter(function (r) { return r.date >= from && r.date <= to; }));
}

function a_cleanDone_(me, p) {
  var s = settings_();
  var week = weekInfo_();
  var day, date;
  if (p.date) {
    date = String(p.date);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw userErr_('Bad date.');
    day = dayKeyOf_(date);
    if (!day) throw userErr_('Pick a weekday.');
    if (date < addDaysYmd_(week.today, -CARRY_LOOKBACK_DAYS)) throw userErr_('That day is too far back to sign off.');
  } else {
    day = String(p.day || '');
    date = week.dates[day];
  }
  if (!date) throw userErr_('Pick a weekday.');
  if (date > week.today) throw userErr_("You can't sign off a day that hasn't happened yet.");
  if (s.startDate && date < s.startDate) throw userErr_('Cleaning sign-offs start ' + prettyDate_(s.startDate) + '.');
  var task = String(p.task || '');
  var dd = dayFor_(s, day, date);
  if (dd.tasks.indexOf(task) < 0) throw userErr_('That task is no longer on the schedule. Refresh the page.');
  var existing = signoffs_(date, task);
  if (existing.length >= SIGNOFFS_NEEDED) throw userErr_('Already signed off by ' + existing.map(function (r) { return r.doneByName; }).join(' and ') + '.');
  if (existing.some(function (r) { return r.doneBy === me.username; })) throw userErr_('You already signed off this task. A second person needs to sign off too.');
  var second = existing.length > 0;

  var labels = assigneesOf_(dd, task);
  var mine = labels.some(function (l) { var u = personUser_(l); return u && u.username === me.username; });
  var off = !second && labels.length > 0 && !mine;
  var comment = String(p.comment || '').trim();
  if (off && comment.length < 3) throw userErr_('Please add a comment telling Jacob why you are doing this task.');
  var assigned = labels.map(function (l) { var u = personUser_(l); return u ? u.username : l; }).join(',');
  var assignedName = labels.length ? labels.map(displayName_).join(' + ') : 'No one';
  var late = date < week.today;
  var recId = uid_();

  insert_('Cleaning', {
    id: recId, date: date, day: day, task: task,
    assigned: assigned, assignedName: assignedName,
    doneBy: me.username, doneByName: me.name, doneAt: nowIso_(),
    offAssignment: off, late: late, comment: comment, kind: second ? 'check' : 'done'
  });

  var payback = null;
  if (off && labels.length === 1 && !isTeamLabel_(dd.who[task])) {
    payback = makePayback_(s, me, task, labels[0], date, recId, week.today);
  }
  var payLine = payback
    ? '\n\nPay-back: ' + payback.toName + ' will do ' + me.name + "'s " + task + ' on ' + DAY_NAMES[dayKeyOf_(payback.date)] + ' ' + prettyDate_(payback.date) + '.'
    : '';
  if (payback) {
    var owedU = personUser_(labels[0]);
    if (owedU && owedU.email) {
      try {
        sendMail_(owedU.email, 'Cleaning: you owe ' + me.name + ' a ' + task + ' turn',
          'Hi ' + owedU.name + ',\n\n' + me.name + ' did your ' + task + ' task from ' + DAY_NAMES[day] + ' ' + prettyDate_(date) + '.\n\n' +
          'To make it even, you are now on ' + task + ' on ' + DAY_NAMES[dayKeyOf_(payback.date)] + ' ' + prettyDate_(payback.date) + ' (' + me.name + "'s turn).\n\nThank you!");
      } catch (e) { console.warn('Pay-back email failed: ' + e); }
    }
  }
  if (off) {
    try {
      sendMail_(s.notifyEmail,
        'Cleaning: ' + me.name + ' did ' + assignedName + "'s task (" + DAY_NAMES[day] + ')',
        me.name + ' signed off a cleaning task that is assigned to ' + assignedName + '.\n\n' +
        'Task: ' + task + '\n' +
        'Scheduled day: ' + DAY_NAMES[day] + ' ' + prettyDate_(date) + (late ? '  (done late)' : '') + '\n' +
        'Assigned to: ' + assignedName + '\n' +
        'Done by: ' + me.name + '\n' +
        'Signed off: ' + prettyNow_() + '\n\n' +
        'Their reason:\n"' + comment + '"' + payLine);
    } catch (e) { console.warn('Off-day email failed: ' + e); }
  }
  return cleanState_(s, week, payback ? { payback: payback } : null);
}

function cleanState_(s, week, extra) {
  var o = { cleaning: cleaningBetween_(week.dates.Mon, week.dates.Fri), weekSchedule: weekSchedule_(s, week), carryOver: carryOver_(s, week.today) };
  if (extra) Object.keys(extra).forEach(function (k) { o[k] = extra[k]; });
  return o;
}

/** How many different people must sign off each cleaning task. */
var SIGNOFFS_NEEDED = 2;
function signoffs_(date, task) {
  return rows_('Cleaning').filter(function (r) { return r.date === date && r.task === task; })
    .sort(function (a, b) { return a.doneAt < b.doneAt ? -1 : 1; });
}

function a_cleanUndo_(me, p) {
  var week = weekInfo_();
  var rec = find_('Cleaning', p.id);
  if (!rec) throw userErr_('That sign-off was already removed.');
  var allowed = me.role === 'admin' || (rec.doneBy === me.username && ymd_(new Date(rec.doneAt)) === week.today);
  if (!allowed) throw userErr_('Only an admin can undo this sign-off.');
  remove_('Cleaning', rec.id);
  rows_('Swaps').filter(function (w) { return w.coverId === rec.id; }).forEach(function (w) { remove_('Swaps', w.id); });
  return cleanState_(settings_(), week);
}

function a_cleanMonth_(me, p) {
  var m = String(p.month || '');
  if (!/^\d{4}-\d{2}$/.test(m)) throw userErr_('Pick a month.');
  var list = rows_('Cleaning').filter(function (r) { return String(r.date).slice(0, 7) === m; });
  list.sort(function (a, b) { return a.date < b.date ? 1 : a.date > b.date ? -1 : (a.doneAt < b.doneAt ? 1 : -1); });
  return { month: m, rows: clean_(list) };
}

function sendMorning_(s, dayKey, date) {
  var d = dayFor_(s, dayKey, date);
  var carry = carryOver_(s, date);
  if (!d.tasks.length && !carry.length) return;
  var byUser = {};
  var add = function (l, text) {
    var u = personUser_(l);
    if (!u || !u.email) return;
    if (!byUser[u.username]) byUser[u.username] = { u: u, tasks: [] };
    byUser[u.username].tasks.push(text);
  };
  d.tasks.forEach(function (t) {
    var team = isTeamLabel_((d.who || {})[t]);
    var sw = d.swaps[t];
    assigneesOf_(d, t).forEach(function (l) {
      add(l, t + (team ? ' (team job, shared with your partner)' : '') + (sw ? ' (' + sw.fromName + "'s turn: they covered your " + t + ' on ' + prettyDate_(sw.origDate) + ')' : ''));
    });
  });
  carry.forEach(function (c) {
    var dd = dayFor_(s, c.day, c.date);
    assigneesOf_(dd, c.task).forEach(function (l) {
      add(l, c.task + ': MISSED on ' + DAY_NAMES[c.day] + ' ' + prettyDate_(c.date) + ', carried over to today' + (c.recs.length ? ' (needs a 2nd sign-off)' : ''));
    });
  });
  var team = teamNames_(d);
  Object.keys(byUser).forEach(function (k) {
    var e = byUser[k];
    var partners = team.filter(function (n) { var pu = personUser_(n); return !(pu && pu.username === e.u.username); });
    try {
      sendMail_(e.u.email,
        'Your cleaning task for ' + DAY_NAMES[dayKey] + ' (' + prettyDate_(date) + ')',
        'Good morning ' + e.u.name + ',\n\nYou are on cleaning today' + (partners.length ? ' with ' + partners.join(' and ') : '') + '. ' +
        'Please press "I did this" in the Clinic Hub when you finish. Each task needs two people to sign off, so have your partner (or anyone working) confirm it too:\n\n' +
        e.tasks.map(function (t) { return '  • ' + t; }).join('\n') +
        '\n\nReminder: ' + CLEANING_RULE + '\n\nThank you!');
    } catch (err) { console.warn('Morning email to ' + e.u.username + ' failed: ' + err); }
  });
}

/** Distinct people on a day, in task order ("Dianne", "Jerry"). */
function teamNames_(d) {
  var seen = {}, out = [];
  (d.tasks || []).forEach(function (t) {
    var n = str_((d.who || {})[t]);
    if (!n || isTeamLabel_(n)) return;
    var u = personUser_(n);
    var disp = u ? u.name : n;
    if (seen[disp.toLowerCase()]) return;
    seen[disp.toLowerCase()] = true; out.push(disp);
  });
  return out;
}

function sendMissed_(s, dayKey, date) {
  var d = dayFor_(s, dayKey, date);
  var older = carryOver_(s, date);
  if (!d.tasks.length && !older.length) return;
  var signed = {};
  rows_('Cleaning').forEach(function (r) { if (r.date === date) (signed[r.task] = signed[r.task] || []).push(r.doneByName); });
  var missing = d.tasks.filter(function (t) { return (signed[t] || []).length < SIGNOFFS_NEEDED; });
  if (!missing.length && !older.length) return;
  var whoOf = function (t) {
    var l = assigneesOf_(d, t);
    return l.length ? l.map(displayName_).join(' + ') : 'No one assigned';
  };
  sendMail_(s.notifyEmail,
    'Cleaning NOT done: ' + missing.length + ' task' + (missing.length === 1 ? '' : 's') + ' (' + DAY_NAMES[dayKey] + ')' + (older.length ? ' + ' + older.length + ' carried over' : ''),
    'These cleaning tasks were not fully signed off today (' + DAY_NAMES[dayKey] + ' ' + prettyDate_(date) + '). Each task needs ' + SIGNOFFS_NEEDED + ' people to sign off.\n\n' +
    missing.map(function (t) {
      var by = signed[t] || [];
      return '  • ' + t + ' — ' + whoOf(t) + (by.length ? '  (only signed off by ' + by.join(', ') + ' — needs a second sign-off)' : '  (not signed off)');
    }).join('\n') +
    '\n\n' + (d.tasks.length - missing.length) + ' of ' + d.tasks.length + ' tasks were completed.' +
    '\n\nMissed tasks carry over to the next work day for the same person until they are signed off.' +
    (older.length ? '\n\nStill not done from earlier days:\n' + older.map(function (c) {
      return '  • ' + c.task + ' (' + DAY_NAMES[c.day] + ' ' + prettyDate_(c.date) + ') — ' + (c.people.join(' + ') || 'No one assigned') +
        (c.recs.length ? '  (only signed off by ' + c.recs.map(function (r) { return r.doneByName; }).join(', ') + ')' : '');
    }).join('\n') : ''));
}

/* =====================================================================
   SUPPLIES (same rules as the original Aligned Inventory app)
   ===================================================================== */

function supplies_() {
  return { items: clean_(rows_('Items')), orders: clean_(rows_('Orders')) };
}

function owner_(v) { return CONFIG.PEOPLE.indexOf(v) >= 0 ? v : CONFIG.HOUSE; }

function a_itemSave_(me, p) {
  var name = str_(p.name);
  if (!name) throw userErr_('Please enter an item name.');
  var rec = {
    name: name,
    category: str_(p.category) || 'General',
    owner: owner_(p.owner),
    qty: Math.max(0, parseInt(p.qty, 10) || 0),
    price: Math.max(0, round2_(parseFloat(p.price) || 0)),
    reorderAt: (p.reorderAt === '' || p.reorderAt === null || p.reorderAt === undefined) ? null : Math.max(0, parseInt(p.reorderAt, 10) || 0),
    notes: str_(p.notes)
  };
  if (p.id) {
    if (!find_('Items', p.id)) throw userErr_('That item was deleted. Refresh the page.');
    update_('Items', p.id, rec);
  } else {
    rec.id = uid_(); rec.paid = false; rec.paidDate = ''; rec.createdAt = nowIso_();
    insert_('Items', rec);
  }
  autoFlag_();
  return supplies_();
}

function a_itemQty_(me, p) {
  var it = find_('Items', p.id);
  if (!it) throw userErr_('That item was deleted. Refresh the page.');
  update_('Items', it.id, { qty: Math.max(0, (it.qty || 0) + (parseInt(p.delta, 10) || 0)) });
  autoFlag_();
  return supplies_();
}

function a_itemDelete_(me, p) {
  var it = find_('Items', p.id);
  if (it) {
    remove_('Items', it.id);
    rows_('Orders').filter(function (o) { return o.itemId === it.id && o.status !== 'received'; })
      .forEach(function (o) { remove_('Orders', o.id); });
  }
  return supplies_();
}

function a_itemPaid_(me, p) {
  var it = find_('Items', p.id);
  if (!it) throw userErr_('That item was deleted. Refresh the page.');
  var paid = !!p.paid;
  update_('Items', it.id, { paid: paid, paidDate: paid ? nowIso_() : '' });
  return supplies_();
}

function openOrderFor_(itemId, name) {
  var lname = String(name || '').toLowerCase();
  return rows_('Orders').filter(function (o) {
    if (o.status === 'received') return false;
    if (itemId) return o.itemId === itemId;
    return String(o.name).toLowerCase() === lname;
  })[0] || null;
}

function newOrder_(o) {
  var rec = {
    id: uid_(), itemId: o.itemId || '', name: o.name, qty: Math.max(1, parseInt(o.qty, 10) || 1),
    price: null, assignTo: o.assignTo || CONFIG.HOUSE, by: o.by || '', note: o.note || '',
    status: 'needs', requestedAt: nowIso_(), orderedAt: '', receivedAt: ''
  };
  insert_('Orders', rec);
  return rec;
}

function a_orderFlagItem_(me, p) {
  var it = find_('Items', p.id);
  if (!it) throw userErr_('That item was deleted. Refresh the page.');
  if (openOrderFor_(it.id)) throw userErr_('"' + it.name + '" is already in the order queue.');
  var o = newOrder_({ itemId: it.id, name: it.name, qty: p.qty, by: me.name, note: str_(p.note), assignTo: it.owner });
  notifyOrders_([o]);
  return supplies_();
}

function a_orderRequest_(me, p) {
  var raw = str_(p.name);
  if (!raw) throw userErr_('Please enter an item name.');
  var assignTo = String(p.assignTo || '');
  if (CONFIG.PEOPLE.indexOf(assignTo) < 0 && assignTo !== 'Split') throw userErr_('Please pick who this is for (Clinic, Sarah, Erica, or Split).');
  var match = rows_('Items').filter(function (i) { return i.name.toLowerCase() === raw.toLowerCase(); })[0];
  var itemId = match ? match.id : '';
  var name = match ? match.name : raw;
  if (openOrderFor_(itemId, name)) throw userErr_('"' + name + '" is already in the order queue.');
  var o = newOrder_({ itemId: itemId, name: name, qty: p.qty, by: me.name, note: str_(p.note), assignTo: assignTo });
  notifyOrders_([o]);
  return supplies_();
}

function a_orderCost_(me, p) {
  var o = find_('Orders', p.id);
  if (!o) throw userErr_('That order was removed. Refresh the page.');
  var price = null;
  if (String(p.price === null || p.price === undefined ? '' : p.price).trim() !== '') {
    price = parseFloat(p.price);
    if (!isFinite(price) || price < 0) throw userErr_('Please enter a valid cost (0 or more).');
    price = round2_(price);
  }
  update_('Orders', o.id, { price: price });
  if (o.itemId && price !== null && find_('Items', o.itemId)) update_('Items', o.itemId, { price: price });
  return supplies_();
}

function a_orderOrdered_(me, p) {
  var o = find_('Orders', p.id);
  if (!o) throw userErr_('That order was removed. Refresh the page.');
  update_('Orders', o.id, { status: 'ordered', orderedAt: nowIso_() });
  return supplies_();
}

function a_orderReceived_(me, p) {
  var o = find_('Orders', p.id);
  if (!o) throw userErr_('That order was removed. Refresh the page.');
  var add = Math.max(0, parseInt(p.addQty, 10) || 0);
  var it = o.itemId ? find_('Items', o.itemId) : null;
  if (it) {
    var patch = { qty: (it.qty || 0) + add };
    if (o.price !== null && (!it.price || Number(it.price) === 0)) patch.price = o.price;
    update_('Items', it.id, patch);
  } else if (add > 0) {
    addReceivedInventory_(o.name, add, o.assignTo, o.note, o.price);
  }
  var now = nowIso_();
  update_('Orders', o.id, { status: 'received', receivedAt: now, orderedAt: o.orderedAt || now });
  return supplies_();
}

function addReceivedInventory_(name, qty, assignTo, notes, unitPrice) {
  var price = Math.max(0, Number(unitPrice) || 0);
  var base = { name: name, category: 'General', price: price, reorderAt: null, paid: false, paidDate: '', createdAt: nowIso_() };
  if (assignTo === 'Split') {
    var qSarah = Math.floor(qty / 2), qErica = qty - qSarah;
    if (qSarah > 0) insert_('Items', merge_(base, { id: uid_(), owner: 'Sarah', qty: qSarah, notes: notes || 'Split 50/50 order' }));
    if (qErica > 0) insert_('Items', merge_(base, { id: uid_(), owner: 'Erica', qty: qErica, notes: notes || 'Split 50/50 order' }));
    return;
  }
  insert_('Items', merge_(base, { id: uid_(), owner: owner_(assignTo), qty: qty, notes: notes || '' }));
}

function a_orderRemove_(me, p) {
  if (find_('Orders', p.id)) remove_('Orders', p.id);
  return supplies_();
}

/** If qty drops to/below the reorder point, add it to the queue automatically. */
function autoFlag_() {
  var orders = rows_('Orders');
  var created = [];
  rows_('Items').forEach(function (it) {
    if (it.reorderAt === null || it.qty > it.reorderAt) return;
    var open = orders.some(function (o) { return o.itemId === it.id && o.status !== 'received'; });
    if (open) return;
    created.push(newOrder_({
      itemId: it.id, name: it.name, qty: Math.max(1, (it.reorderAt || 0) + 1 - it.qty),
      by: 'Auto (low stock)', note: 'Qty fell to ' + it.qty, assignTo: it.owner
    }));
  });
  if (created.length) notifyOrders_(created);
}

function assignLabel_(a) {
  if (a === 'Split') return 'Split 50/50 (Sarah & Erica)';
  return a || CONFIG.HOUSE;
}

function notifyOrders_(list) {
  if (!list.length) return;
  var lines = list.map(function (o) {
    return '- ' + o.name + ' x ' + o.qty +
      '\n  For: ' + assignLabel_(o.assignTo) +
      '\n  Requested by: ' + (o.by || '(unknown)') +
      (o.note ? '\n  Note: ' + o.note : '') +
      '\n  Date: ' + prettyNow_();
  });
  try {
    sendMail_(settings_().notifyEmail,
      list.length === 1 ? 'Aligned Inventory - 1 item needs to be ordered'
                        : 'Aligned Inventory - ' + list.length + ' items need to be ordered',
      'Something was flagged for ordering.\n\n' + lines.join('\n\n') +
      '\n\nOpen Supplies > Ordering to mark it ordered / received.');
  } catch (e) { console.warn('Order email failed: ' + e); }
}

/* =====================================================================
   NDC / LOT LIST
   ===================================================================== */

function a_medSave_(me, p) {
  var name = str_(p.name), ndc = str_(p.ndc), lot = str_(p.lot), exp = str_(p.expiration);
  if (!name) throw userErr_('Please enter the medication name.');
  if (!ndc) throw userErr_('Please enter the NDC.');
  if (!/^[0-9-]{8,14}$/.test(ndc)) throw userErr_('The NDC should be numbers and dashes, like 0409-4888-02.');
  if (!lot) throw userErr_('Please enter the lot number.');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(exp)) throw userErr_('Please pick the expiration date.');
  var qty = (p.qty === '' || p.qty === null || p.qty === undefined) ? null : Math.max(0, parseInt(p.qty, 10) || 0);
  var rec = { name: name, ndc: ndc, lot: lot, expiration: exp, qty: qty, location: str_(p.location), notes: str_(p.notes),
              updatedBy: me.name, updatedAt: nowIso_() };
  if (p.id) {
    if (!find_('Meds', p.id)) throw userErr_('That entry was deleted. Refresh the page.');
    update_('Meds', p.id, rec);
  } else {
    var dup = rows_('Meds').filter(function (m) { return m.ndc === ndc && m.lot.toLowerCase() === lot.toLowerCase(); })[0];
    if (dup) throw userErr_('That NDC and lot is already on the list. Edit the existing entry instead.');
    rec.id = uid_(); rec.addedBy = me.name; rec.addedAt = nowIso_();
    insert_('Meds', rec);
  }
  return { meds: clean_(rows_('Meds')) };
}

function a_medDelete_(me, p) {
  if (find_('Meds', p.id)) remove_('Meds', p.id);
  return { meds: clean_(rows_('Meds')) };
}

/* =====================================================================
   STICKY NOTES
   - You only see notes on YOUR wall and notes YOU wrote (on anyone's wall).
     Admins can see every note on every wall.
   - Nobody can change or remove text someone already wrote. "Edit" only
     ADDS to the writer's own note; the original text always stays.
   - A note posted to several walls is one note (copies share a groupId).
   - Anyone who can see a note can comment on it; the writer can edit it.
   - Completing or deleting a note moves it to the archive. Archived notes
     are read-only for staff. Only admins see the whole archive and can
     restore or permanently remove archived notes.
   ===================================================================== */
var NOTE_COLORS = ['yellow', 'pink', 'blue', 'green', 'nyellow', 'npink', 'ngreen', 'norange', 'nblue', 'npurple', 'nred', 'nlime'];
function noteKey_(n) { return n.groupId || n.id; }
function noteGroup_(n) {
  if (!n.groupId) return [n];
  return rows_('Notes').filter(function (x) { return x.groupId === n.groupId; });
}
function noteArchived_(n) { return !!(n.done || n.deleted); }
function canSeeNote_(me, n) {
  if (n.fromUser === me.username) return true;
  if (noteGroup_(n).some(function (x) { return x.wall === me.username; })) return true;
  return me.role === 'admin';
}
function notesList_(me) {
  var list = rows_('Notes').filter(function (n) { return canSeeNote_(me, n); });
  var keys = {};
  list.forEach(function (n) { keys[noteKey_(n)] = true; });
  var comments = rows_('NoteComments').filter(function (c) { return keys[c.noteKey]; });
  return { notes: clean_(list), noteComments: clean_(comments) };
}
function noteOut_(me) { var o = notesList_(me); return { notes: o.notes, noteComments: o.noteComments }; }
function mustSeeNote_(me, id) {
  var n = find_('Notes', id);
  if (!n || !canSeeNote_(me, n)) throw userErr_('That note was removed. Refresh the page.');
  return n;
}
function noteLocked_(me, n) {
  if (noteArchived_(n)) throw userErr_('This note is in the archive. Only an admin can change archived notes.');
}
function noteNotify_(me, n, subject, body) {
  var to = {};
  noteGroup_(n).forEach(function (x) { to[x.wall] = true; });
  to[n.fromUser] = true;
  delete to[me.username];
  Object.keys(to).forEach(function (un) {
    var u = findUser_(un);
    if (!u || !u.active || !u.email) return;
    try { sendMail_(u.email, subject, 'Hi ' + u.name + ',\n\n' + body + '\n\nOpen the Sticky Notes tab in the Clinic Hub to see it.'); }
    catch (e) { console.warn('Note email failed: ' + e); }
  });
}

function a_noteAdd_(me, p) {
  var text = str_(p.text).slice(0, 1000);
  if (!text) throw userErr_('Write something on the sticky note.');
  var names = Array.isArray(p.walls) ? p.walls : [p.wall];
  var owners = [], seen = {};
  names.forEach(function (w) {
    var u = findUser_(String(w || '').toLowerCase());
    if (u && u.active && !seen[u.username]) { seen[u.username] = true; owners.push(u); }
  });
  if (!owners.length) throw userErr_('Pick at least one wall to post it on.');
  var color = NOTE_COLORS.indexOf(p.color) >= 0 ? p.color : 'yellow';
  var groupId = owners.length > 1 ? uid_() : '';
  var wallList = owners.map(function (u) { return u.username; }).join(',');
  var now = nowIso_();
  owners.forEach(function (owner) {
    insert_('Notes', { id: uid_(), wall: owner.username, text: text, color: color, fromUser: me.username, fromName: me.name,
      createdAt: now, seenAt: owner.username === me.username ? now : '', done: false, doneAt: '', doneBy: '',
      groupId: groupId, walls: groupId ? wallList : '', deleted: false, deletedAt: '', deletedBy: '', editedAt: '' });
    if (owner.username !== me.username && owner.email) {
      var others = owners.filter(function (o) { return o.username !== owner.username; }).map(function (o) { return o.name; });
      try {
        sendMail_(owner.email, 'New sticky note from ' + me.name,
          'Hi ' + owner.name + ',\n\n' + me.name + ' left a sticky note on your wall in the Clinic Hub' +
          (others.length ? ' (also posted to ' + others.join(', ') + ')' : '') + ':\n\n"' + text + '"\n\n' +
          'Open the Sticky Notes tab to see it, comment on it, or mark it done.');
      } catch (e) { console.warn('Note email failed: ' + e); }
    }
  });
  return noteOut_(me);
}

function a_noteEdit_(me, p) {
  var n = mustSeeNote_(me, p.id);
  noteLocked_(me, n);
  if (n.fromUser !== me.username) throw userErr_('Only the person who wrote this note can add to it. You can add a comment instead.');
  var text = str_(p.text).slice(0, 1000);
  if (!text) throw userErr_('Write what you want to add.');
  var now = nowIso_();
  insert_('NoteComments', { id: uid_(), noteKey: noteKey_(n), text: text, byUser: me.username, byName: me.name, at: now, kind: 'addition' });
  noteGroup_(n).forEach(function (x) {
    update_('Notes', x.id, { editedAt: now, seenAt: x.wall === me.username ? x.seenAt : '' });
  });
  noteNotify_(me, n, me.name + ' added to a sticky note',
    me.name + ' added to their sticky note.\n\nOriginal: "' + n.text + '"\n\nAdded: "' + text + '"');
  return noteOut_(me);
}

function a_noteComment_(me, p) {
  var n = mustSeeNote_(me, p.id);
  noteLocked_(me, n);
  var text = str_(p.text).slice(0, 500);
  if (!text) throw userErr_('Write a comment first.');
  insert_('NoteComments', { id: uid_(), noteKey: noteKey_(n), text: text, byUser: me.username, byName: me.name, at: nowIso_(), kind: 'comment' });
  // flag it as new again for the other walls
  noteGroup_(n).forEach(function (x) { if (x.wall !== me.username) update_('Notes', x.id, { seenAt: '' }); });
  noteNotify_(me, n, me.name + ' commented on a sticky note',
    me.name + ' commented on the sticky note:\n\n"' + n.text + '"\n\nComment: "' + text + '"');
  return noteOut_(me);
}

function noteCanClose_(me, n) {
  return me.role === 'admin' || n.fromUser === me.username || noteGroup_(n).some(function (x) { return x.wall === me.username; });
}
function a_noteDone_(me, p) {
  var n = mustSeeNote_(me, p.id);
  if (p.done === false) {
    if (me.role !== 'admin') throw userErr_('Only an admin can reopen a note from the archive.');
    noteGroup_(n).forEach(function (x) { update_('Notes', x.id, { done: false, doneAt: '', doneBy: '', deleted: false, deletedAt: '', deletedBy: '' }); });
    return noteOut_(me);
  }
  noteLocked_(me, n);
  if (!noteCanClose_(me, n)) throw userErr_('Only the person whose wall it is (or who wrote it) can mark this done.');
  var at = nowIso_();
  noteGroup_(n).forEach(function (x) { update_('Notes', x.id, { done: true, doneAt: at, doneBy: me.name }); });
  return noteOut_(me);
}
function a_noteDelete_(me, p) {
  var n = find_('Notes', p.id);
  if (!n) return noteOut_(me);
  if (!canSeeNote_(me, n)) throw userErr_('That note was removed. Refresh the page.');
  noteLocked_(me, n);
  if (!noteCanClose_(me, n)) throw userErr_('Only the person whose wall it is (or who wrote it) can delete this note.');
  var at = nowIso_();
  noteGroup_(n).forEach(function (x) { update_('Notes', x.id, { deleted: true, deletedAt: at, deletedBy: me.name }); });
  return noteOut_(me);
}
/** Admin only: permanently remove an archived note and its comments. */
function a_notePurge_(me, p) {
  var n = find_('Notes', p.id);
  if (n) {
    if (!noteArchived_(n)) throw userErr_('Archive the note first (mark it done or delete it).');
    var key = noteKey_(n);
    noteGroup_(n).forEach(function (x) { remove_('Notes', x.id); });
    rows_('NoteComments').filter(function (c) { return c.noteKey === key; }).forEach(function (c) { remove_('NoteComments', c.id); });
  }
  return noteOut_(me);
}
function a_noteSeen_(me) {
  var now = nowIso_();
  rows_('Notes').forEach(function (n) { if (n.wall === me.username && !n.seenAt) update_('Notes', n.id, { seenAt: now }); });
  return noteOut_(me);
}

/* =====================================================================
   CLIA QC LOG
   ===================================================================== */

function a_qcAdd_(me, p) {
  var test = str_(p.test), lot = str_(p.lot);
  if (!test) throw userErr_('Please enter the test / kit name.');
  if (!lot) throw userErr_('Please enter the lot number.');
  var ok = ['Pass', 'Fail', 'N/A'];
  var pos = ok.indexOf(p.posControl) >= 0 ? p.posControl : '';
  var neg = ok.indexOf(p.negControl) >= 0 ? p.negControl : '';
  if (!pos || !neg) throw userErr_('Pick a result for both the positive and negative control.');
  var result = (pos === 'Fail' || neg === 'Fail') ? 'Fail' : 'Pass';
  var rec = {
    id: uid_(), loggedAt: nowIso_(), test: test, lot: lot, expiration: str_(p.expiration),
    reason: str_(p.reason) || 'New box opened', posControl: pos, negControl: neg, result: result,
    byName: me.name, by: me.username, notes: str_(p.notes), voided: false, voidReason: '', voidedBy: ''
  };
  insert_('QC', rec);
  if (result === 'Fail') {
    try {
      sendMail_(settings_().notifyEmail, 'QC FAILED: ' + test + ' (lot ' + lot + ')',
        'A QC check was logged as FAILED. Do not report patient results on this lot until it is resolved.\n\n' +
        'Test: ' + test + '\nLot: ' + lot + '\nExpiration: ' + (rec.expiration || '—') +
        '\nPositive control: ' + pos + '\nNegative control: ' + neg +
        '\nReason: ' + rec.reason + '\nBy: ' + me.name + '\nWhen: ' + prettyNow_() +
        (rec.notes ? '\nNotes: ' + rec.notes : ''));
    } catch (e) { console.warn('QC email failed: ' + e); }
  }
  return { qc: clean_(rows_('QC')) };
}

function a_qcVoid_(me, p) {
  var r = find_('QC', p.id);
  if (!r) throw userErr_('Entry not found.');
  var reason = str_(p.reason);
  if (reason.length < 3) throw userErr_('Please give a reason for voiding this entry.');
  update_('QC', r.id, { voided: true, voidReason: reason, voidedBy: me.name + ' · ' + prettyNow_() });
  return { qc: clean_(rows_('QC')) };
}

function a_qcDelete_(me, p) {
  var r = find_('QC', p.id);
  if (!r) throw userErr_('Entry not found.');
  var ageDays = (Date.now() - new Date(r.loggedAt).getTime()) / 864e5;
  if (ageDays < CONFIG.QC_RETENTION_DAYS) throw userErr_('QC records must be kept at least 2 years. You can void it instead.');
  remove_('QC', r.id);
  return { qc: clean_(rows_('QC')) };
}

/* =====================================================================
   ADMIN
   ===================================================================== */

function a_userAdd_(me, p) {
  var u = createUser_(p, null);
  var emailed = false;
  if (u && u.email) {
    try {
      var url = appUrl_();
      sendMail_(u.email, 'Your Aligned Clinic Hub account',
        'Hi ' + u.name + ',\n\n' + me.name + ' set up your Aligned Clinic Hub account.\n\n' +
        'Website: ' + (url || '(ask Jacob for the link)') + '\n' +
        'Username: ' + u.username + '\n' +
        'Password: ' + me.name + ' will give you your temporary password.\n\n' +
        'After you sign in, click the "Password" button at the top to change your password. ' +
        'Bookmark the website or add it to your phone\'s home screen.\n\n' +
        'Cleaning rule: ' + CLEANING_RULE + '\n\nThank you!');
      emailed = true;
    } catch (e) { console.warn('Welcome email failed: ' + e); }
  }
  return { users: allUsersAdmin_(), emailed: emailed };
}

function a_userUpdate_(me, p) {
  var u = findUser_(String(p.username || '').toLowerCase());
  if (!u) throw userErr_('Account not found.');
  var role = p.role === 'admin' ? 'admin' : 'staff';
  if (u.role === 'admin' && role !== 'admin' && adminCount_() <= 1) throw userErr_('You need at least one admin.');
  update_('Users', u.username, { name: str_(p.name) || u.name, email: str_(p.email), role: role });
  return { users: allUsersAdmin_() };
}

function a_userResetPw_(me, p) {
  var u = findUser_(String(p.username || '').toLowerCase());
  if (!u) throw userErr_('Account not found.');
  var pw = String(p.password || '');
  if (pw.length < 6) throw userErr_('Password must be at least 6 characters.');
  var salt = uid_() + uid_();
  update_('Users', u.username, { salt: salt, hash: hash_(salt, pw) });
  return { users: allUsersAdmin_() };
}

function a_userDelete_(me, p) {
  var u = findUser_(String(p.username || '').toLowerCase());
  if (!u) throw userErr_('Account not found.');
  if (u.username === me.username) throw userErr_("You can't delete your own account.");
  if (u.role === 'admin' && adminCount_() <= 1) throw userErr_('You need at least one admin.');
  remove_('Users', u.username);
  return { users: allUsersAdmin_(), schedule: settings_().schedule };
}

function a_settingsSave_(me, p) {
  var s = settings_();
  if (p.notifyEmail !== undefined) {
    var em = str_(p.notifyEmail);
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(em)) throw userErr_('Please enter a valid alert email.');
    s.notifyEmail = em;
  }
  if (p.morningHour !== undefined || p.checkHour !== undefined) {
    var mh = Math.round(parseFloat(p.morningHour) * 2) / 2, ch = Math.round(parseFloat(p.checkHour) * 2) / 2;
    if (!(mh >= 0 && mh <= 23 && ch >= 0 && ch <= 23 && mh < ch)) throw userErr_('The reminder time must be before the "not done" check time.');
    s.morningHour = mh; s.checkHour = ch;
  }
  if (p.schedule) {
    DAYS.forEach(function (d) {
      var src = p.schedule[d] || {};
      var srcWho = (src.who && typeof src.who === 'object') ? src.who : {};
      var seen = {};
      var tasks = (Array.isArray(src.tasks) ? src.tasks : []).map(str_).filter(function (t) {
        if (!t || seen[t.toLowerCase()]) return false; seen[t.toLowerCase()] = true; return true;
      }).slice(0, 50);
      var who = {};
      tasks.forEach(function (t) { var n = str_(srcWho[t]).slice(0, 40); if (n) who[t] = n; });
      s.schedule[d] = { tasks: tasks, who: who };
    });
  }
  if (p.rotateWeekly !== undefined) s.rotateWeekly = !!p.rotateWeekly;
  if (p.startDate !== undefined) {
    var sd = String(p.startDate || '');
    if (sd && !/^\d{4}-\d{2}-\d{2}$/.test(sd)) throw userErr_('Pick a valid start date.');
    s.startDate = sd;
  }
  if (p.qcTests) {
    s.qcTests = (Array.isArray(p.qcTests) ? p.qcTests : []).map(str_).filter(Boolean).slice(0, 60);
  }
  saveSettings_(s);
  return {
    schedule: s.schedule, weekSchedule: weekSchedule_(s, weekInfo_()), rotateWeekly: s.rotateWeekly !== false, qcTests: s.qcTests,
    settings: { notifyEmail: s.notifyEmail, morningHour: s.morningHour, checkHour: s.checkHour, startDate: s.startDate }, startDate: s.startDate
  };
}

function a_dayClosed_(me, p) {
  var s = settings_();
  var date = String(p.date || weekInfo_().today);
  s.closedDates = s.closedDates.filter(function (d) { return d !== date; });
  if (p.closed) s.closedDates.push(date);
  saveSettings_(s);
  return { closedDates: s.closedDates };
}

function a_testEmail_(me) {
  var s = settings_();
  sendMail_(s.notifyEmail, 'Clinic Hub test email', 'This is a test from the Aligned Clinic Hub. Emails are working.');
  return { sentTo: s.notifyEmail, quotaLeft: MailApp.getRemainingDailyQuota() };
}

/** One-time import from the old Aligned Inventory Apps Script app (link or pasted JSON). */
function a_importOld_(me, p) {
  var data;
  if (str_(p.json)) {
    try { data = JSON.parse(p.json); } catch (e) { throw userErr_('That text is not valid JSON.'); }
    if (data && data.data) data = data.data;
  } else {
    var url = str_(p.url).split('?')[0];
    if (!/^https:\/\/script\.google\.com\/(a\/[^\/]+\/)?macros\/s\/[\w-]+\/exec$/.test(url)) {
      throw userErr_('Paste the old app link. It starts with https://script.google.com/macros/s/ and ends with /exec');
    }
    var res = UrlFetchApp.fetch(url + '?api=load&token=' + encodeURIComponent(CONFIG.OLD_INVENTORY_TOKEN),
      { muteHttpExceptions: true, followRedirects: true });
    var body;
    try { body = JSON.parse(res.getContentText()); } catch (e) { throw userErr_('Could not read the old app. Check the link.'); }
    if (!body.ok) throw userErr_('The old app said: ' + (body.error || 'error'));
    data = body.data;
  }
  if (!data || !Array.isArray(data.items)) throw userErr_('That does not look like Aligned Inventory data.');
  if (rows_('Items').length && !p.force) throw userErr_('Supplies already has items. Tick "Import anyway" to add on top.');

  var idMap = {};
  var items = data.items.map(function (i) {
    var id = uid_(); idMap[String(i.id)] = id;
    return {
      id: id, name: str_(i.name) || 'Item', category: str_(i.category) || 'General', owner: owner_(i.owner),
      qty: Math.max(0, parseInt(i.qty, 10) || 0), price: round2_(Number(i.price) || 0),
      reorderAt: (i.reorderAt === null || i.reorderAt === undefined || i.reorderAt === '') ? null : Number(i.reorderAt),
      notes: str_(i.notes), paid: !!i.paid, paidDate: toIso_(i.paidDate), createdAt: nowIso_()
    };
  });

  var byId = {};
  (data.orders || []).forEach(function (o) { if (o && o.id != null) byId[String(o.id)] = o; });
  (data.orderHistory || []).forEach(function (h) {
    if (!h || h.id == null) return;
    var cur = byId[String(h.id)];
    if (cur) {
      if (!cur.orderedDate) cur.orderedDate = h.orderedDate;
      if (!cur.receivedDate) cur.receivedDate = h.receivedDate;
      if (cur.price == null) cur.price = h.price;
    } else {
      byId[String(h.id)] = {
        id: h.id, itemId: null, name: h.name, qty: h.qty, price: h.price, assignTo: h.assignTo,
        by: h.by, note: h.note, date: h.requestedDate, orderedDate: h.orderedDate,
        receivedDate: h.receivedDate, status: h.status
      };
    }
  });
  var orders = Object.keys(byId).map(function (k) {
    var o = byId[k];
    var st = ['needs', 'ordered', 'received'].indexOf(o.status) >= 0 ? o.status : 'needs';
    return {
      id: uid_(), itemId: (o.itemId != null && idMap[String(o.itemId)]) || '', name: str_(o.name) || 'Item',
      qty: Math.max(1, parseInt(o.qty, 10) || 1),
      price: (o.price === null || o.price === undefined || o.price === '') ? null : round2_(Number(o.price)),
      assignTo: (o.assignTo === 'Split' ? 'Split' : owner_(o.assignTo)), by: str_(o.by), note: str_(o.note),
      status: st, requestedAt: toIso_(o.date), orderedAt: toIso_(o.orderedDate), receivedAt: toIso_(o.receivedDate)
    };
  });

  insertMany_('Items', items);
  insertMany_('Orders', orders);
  var out = supplies_();
  out.imported = { items: items.length, orders: orders.length };
  return out;
}

/* =====================================================================
   ACCOUNTS / SESSIONS
   ===================================================================== */

function createUser_(f, roleOverride) {
  var username = String(f.username || '').trim().toLowerCase();
  if (!/^[a-z0-9._-]{2,30}$/.test(username)) throw userErr_('Username: 2–30 letters or numbers, no spaces.');
  if (findUser_(username)) throw userErr_('That username is already taken.');
  var pw = String(f.password || '');
  if (pw.length < 6) throw userErr_('Password must be at least 6 characters.');
  var email = str_(f.email);
  if (email && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) throw userErr_('That email does not look right.');
  var salt = uid_() + uid_();
  var u = {
    username: username, name: str_(f.name) || username, email: email,
    role: roleOverride || (f.role === 'admin' ? 'admin' : 'staff'),
    salt: salt, hash: hash_(salt, pw), active: true, createdAt: nowIso_()
  };
  insert_('Users', u);
  return u;
}

function findUser_(username) { return find_('Users', String(username || '').toLowerCase()); }
/** Match a schedule name ("Dianne") to an active account: username, full name, or first name. */
function personUser_(label) {
  var k = String(label || '').trim().toLowerCase();
  if (!k) return null;
  var users = rows_('Users').filter(function (u) { return u.active; });
  var nm = function (u) { return String(u.name || '').trim().toLowerCase(); };
  return users.filter(function (u) { return u.username === k; })[0] ||
    users.filter(function (u) { return nm(u) === k; })[0] ||
    users.filter(function (u) { return nm(u).split(/\s+/)[0] === k; })[0] || null;
}
function isTeamLabel_(n) { return /^(team|both)$/i.test(String(n || '').trim()); }
/** Monday-to-Monday weeks between the cleaning start and this date. */
function weekIndex_(s, date) {
  var base = s.startDate || CLEANING_START;
  var mon = function (ymd) { var d = new Date(ymd + 'T12:00:00Z'); var dow = (d.getUTCDay() + 6) % 7; return d.getTime() - dow * 864e5; };
  return Math.round((mon(date) - mon(base)) / (7 * 864e5));
}
/** The schedule for a given day/date, with jobs swapped on alternate weeks. */
function dayFor_(s, dayKey, date, raw) {
  var base = s.schedule[dayKey] || { tasks: [], who: {} };
  var who = {}; Object.keys(base.who || {}).forEach(function (k) { who[k] = base.who[k]; });
  var odd = ((weekIndex_(s, date) % 2) + 2) % 2 === 1;
  if (s.rotateWeekly !== false && odd) {
    var ts = base.tasks.filter(function (t) { return who[t] && !isTeamLabel_(who[t]); });
    var names = ts.map(function (t) { return who[t]; });
    if (names.length > 1) ts.forEach(function (t, i) { who[t] = names[(i + 1) % names.length]; });
  }
  var swaps = {};
  if (!raw) {
    rows_('Swaps').forEach(function (w) {
      if (w.date !== date || base.tasks.indexOf(w.task) < 0) return;
      who[w.task] = w.toName;
      swaps[w.task] = { fromName: w.fromName, toName: w.toName, origDate: w.origDate };
    });
  }
  return { tasks: base.tasks.slice(), who: who, weekB: odd, swaps: swaps };
}
function addDaysYmd_(ymd, n) {
  var d = new Date(ymd + 'T12:00:00Z'); d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}
/** 'Mon'…'Fri' for a yyyy-mm-dd date, or null on weekends. */
function dayKeyOf_(ymd) {
  var dow = (new Date(ymd + 'T12:00:00Z').getUTCDay() + 6) % 7;
  return dow < 5 ? DAYS[dow] : null;
}
/** Past cleaning tasks (before `today`) that never got both sign-offs. They carry over until done. */
var CARRY_LOOKBACK_DAYS = 42;
function carryOver_(s, today) {
  var out = [];
  var from = addDaysYmd_(today, -CARRY_LOOKBACK_DAYS);
  if (s.startDate && from < s.startDate) from = s.startDate;
  for (var d = from; d < today; d = addDaysYmd_(d, 1)) {
    var key = dayKeyOf_(d);
    if (!key || s.closedDates.indexOf(d) >= 0) continue;
    var dd = dayFor_(s, key, d);
    dd.tasks.forEach(function (t) {
      var recs = signoffs_(d, t);
      if (recs.length >= SIGNOFFS_NEEDED) return;
      var labels = assigneesOf_(dd, t);
      out.push({ date: d, day: key, task: t, who: dd.who[t] || '', team: isTeamLabel_(dd.who[t]),
                 people: labels.map(displayName_), users: labels.map(function (l) { var u = personUser_(l); return u ? u.username : ''; }),
                 recs: clean_(recs) });
    });
  }
  return out;
}
/**
 * Pay-back: when someone covers a task that was another person's, the person they covered for
 * takes the coverer's next turn at that same task.
 */
function makePayback_(s, me, task, owedLabel, origDate, coverId, today) {
  for (var i = 1; i <= 70; i++) {
    var d = addDaysYmd_(today, i);
    var key = dayKeyOf_(d);
    if (!key || s.closedDates.indexOf(d) >= 0) continue;
    var dd = dayFor_(s, key, d);
    if (dd.tasks.indexOf(task) < 0 || dd.swaps[task]) continue;
    var lbl = dd.who[task];
    if (!lbl || isTeamLabel_(lbl)) continue;
    var u = personUser_(lbl);
    if (!u || u.username !== me.username) continue;
    var sw = { id: uid_(), date: d, task: task, fromName: me.name, toName: displayName_(owedLabel), coverId: coverId, origDate: origDate, createdAt: nowIso_() };
    insert_('Swaps', sw);
    return sw;
  }
  return null;
}
function weekSchedule_(s, week) {
  var o = {}; DAYS.forEach(function (d) { o[d] = dayFor_(s, d, week.dates[d]); }); return o;
}
/** People labels responsible for a task ("Team" = everyone else on that day). */
function assigneesOf_(d, task) {
  var n = str_((d.who || {})[task]);
  if (!n) return [];
  if (!isTeamLabel_(n)) return [n];
  var out = [], seen = {};
  (d.tasks || []).forEach(function (t) { var x = str_((d.who || {})[t]); if (x && !isTeamLabel_(x) && !seen[x.toLowerCase()]) { seen[x.toLowerCase()] = 1; out.push(x); } });
  return out;
}
function displayName_(label) { var u = personUser_(label); return u ? u.name : label; }
function defaultSchedule_() {
  var o = {};
  DAYS.forEach(function (d) {
    var who = {};
    var list = DEFAULT_SCHEDULE[d] || [];
    list.forEach(function (p) { who[p[1]] = p[0]; });
    o[d] = { tasks: list.map(function (p) { return p[1]; }), who: who };
  });
  return o;
}
function adminCount_() { return rows_('Users').filter(function (u) { return u.role === 'admin'; }).length; }
function allUsersAdmin_() { return rows_('Users').map(function (u) { return pubUser_(u, true); }); }
function pubUser_(u, withEmail) {
  var o = { username: u.username, name: u.name, role: u.role };
  if (withEmail) o.email = u.email;
  return o;
}

function hash_(salt, pw) {
  var v = salt + '|' + pw;
  for (var i = 0; i < 300; i++) {
    v = Utilities.base64Encode(Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, v + salt, Utilities.Charset.UTF_8));
  }
  return v;
}

function newSession_(username) {
  var token = uid_() + uid_() + uid_();
  PropertiesService.getScriptProperties().setProperty('sess_' + token,
    JSON.stringify({ u: username, exp: Date.now() + CONFIG.SESSION_DAYS * 864e5 }));
  return token;
}

function sessionUser_(token) {
  if (!token || !/^[a-f0-9]{20,}$/.test(String(token))) throw authErr_();
  var props = PropertiesService.getScriptProperties();
  var raw = props.getProperty('sess_' + token);
  if (!raw) throw authErr_();
  var s;
  try { s = JSON.parse(raw); } catch (e) { throw authErr_(); }
  if (!s || s.exp < Date.now()) { props.deleteProperty('sess_' + token); throw authErr_(); }
  var u = findUser_(s.u);
  if (!u || !u.active) throw authErr_();
  return u;
}

function pruneSessions_() {
  var props = PropertiesService.getScriptProperties();
  var all = props.getProperties();
  var now = Date.now();
  Object.keys(all).forEach(function (k) {
    if (k.indexOf('sess_') !== 0) return;
    try { if (JSON.parse(all[k]).exp < now) props.deleteProperty(k); } catch (e) { props.deleteProperty(k); }
  });
}

/* =====================================================================
   SETTINGS
   ===================================================================== */

function defaultSettings_() {
  return {
    notifyEmail: CONFIG.NOTIFY_EMAIL, morningHour: 8.5, checkHour: 17, startDate: CLEANING_START, settingsVersion: SETTINGS_VERSION,
    schedule: defaultSchedule_(), scheduleVersion: SCHEDULE_VERSION,
    closedDates: [], qcTests: DEFAULT_QC_TESTS.slice()
  };
}

function settings_() {
  var s = defaultSettings_();
  var raw = PropertiesService.getScriptProperties().getProperty('settings_v1');
  var stored = {};
  if (raw) {
    try { stored = JSON.parse(raw) || {}; Object.keys(stored).forEach(function (k) { s[k] = stored[k]; }); } catch (e) { stored = {}; }
  }
  if (!(stored.settingsVersion >= SETTINGS_VERSION)) {
    s.morningHour = 8.5; s.checkHour = 17; s.startDate = CLEANING_START; s.settingsVersion = SETTINGS_VERSION;
  }
  if (!stored.schedule || !(stored.scheduleVersion >= SCHEDULE_VERSION)) {
    s.schedule = defaultSchedule_();
    s.scheduleVersion = SCHEDULE_VERSION;
  }
  DAYS.forEach(function (d) {
    if (!s.schedule[d]) s.schedule[d] = { tasks: [], who: {} };
    if (!Array.isArray(s.schedule[d].tasks)) s.schedule[d].tasks = [];
    if (!s.schedule[d].who || typeof s.schedule[d].who !== 'object') s.schedule[d].who = {};
  });
  if (!Array.isArray(s.closedDates)) s.closedDates = [];
  if (!Array.isArray(s.qcTests)) s.qcTests = DEFAULT_QC_TESTS.slice();
  return s;
}

function saveSettings_(s) {
  s.closedDates = (s.closedDates || []).slice(-60);
  PropertiesService.getScriptProperties().setProperty('settings_v1', JSON.stringify(s));
}

/* =====================================================================
   SMALL HELPERS
   ===================================================================== */

function guard_(fn) {
  try {
    return { ok: true, data: fn() };
  } catch (e) {
    if (!e.userMsg) console.error(e && e.stack ? e.stack : e);
    return { ok: false, error: e.code || 'error', message: e.userMsg || ('Something went wrong: ' + (e && e.message ? e.message : e)) };
  }
}
function userErr_(msg) { var e = new Error(msg); e.userMsg = msg; return e; }
function authErr_() { var e = userErr_('Please sign in again.'); e.code = 'auth'; return e; }

function withLock_(fn) {
  var lock = LockService.getScriptLock();
  if (!lock.tryLock(20000)) throw userErr_('The system is busy. Please try again.');
  try { return fn(); } finally { lock.releaseLock(); }
}

function sendMail_(to, subject, body) {
  if (!to) return;
  var url = appUrl_();
  MailApp.sendEmail({
    to: to, subject: subject, name: CONFIG.APP_NAME,
    body: body + '\n\n— ' + CONFIG.APP_NAME + ' (automatic message)' + (url ? '\n' + url : '')
  });
}

function appUrl_() { try { return ScriptApp.getService().getUrl() || ''; } catch (e) { return ''; } }
function tz_() { return Session.getScriptTimeZone() || 'America/Chicago'; }
function ymd_(d) { return Utilities.formatDate(d, tz_(), 'yyyy-MM-dd'); }
function nowIso_() { return new Date().toISOString(); }
function prettyNow_() { return Utilities.formatDate(new Date(), tz_(), 'EEE MMM d, yyyy h:mm a'); }
function prettyDate_(ymd) {
  var p = String(ymd).split('-');
  return Number(p[1]) + '/' + Number(p[2]) + '/' + p[0];
}
function uid_() { return Utilities.getUuid().replace(/-/g, '').slice(0, 12); }
function str_(v) { return v === null || v === undefined ? '' : String(v).trim().slice(0, 500); }
function round2_(n) { return Math.round(n * 100) / 100; }
function merge_(a, b) { var o = {}, k; for (k in a) o[k] = a[k]; for (k in b) o[k] = b[k]; return o; }
function toIso_(s) {
  if (!s) return '';
  var d = new Date(s);
  if (isNaN(d.getTime())) return '';
  if (!/T\d/.test(String(s))) d.setHours(12, 0, 0, 0);
  return d.toISOString();
}

function weekInfo_() {
  var now = new Date();
  var tz = tz_();
  var dow = Number(Utilities.formatDate(now, tz, 'u'));
  var dates = {};
  for (var i = 0; i < 5; i++) {
    dates[DAYS[i]] = Utilities.formatDate(new Date(now.getTime() + (i - (dow - 1)) * 864e5), tz, 'yyyy-MM-dd');
  }
  return { today: ymd_(now), todayKey: dow <= 5 ? DAYS[dow - 1] : null, dates: dates };
}

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


const PAGE_HTML = "<!DOCTYPE html>\n<html lang=\"en\">\n<head>\n<meta charset=\"UTF-8\">\n<meta name=\"viewport\" content=\"width=device-width, initial-scale=1.0\">\n<title>Aligned Clinic Hub</title>\n<style>\n  /* ============================================================\n     ALIGNED CLINIC HUB \u2014 THEME (edit colors here)\n     ============================================================ */\n  :root{\n    --ink:#1B2430; --ink-soft:#5A6573; --ink-faint:#8A94A1;\n    --paper:#F2F6FA; --surface:#FFFFFF; --line:#DCE6EF; --line-strong:#C6D5E3;\n    --brand:#2E7AB8; --brand-dark:#1F5E93; --brand-soft:#E7F2FB; --brand-light:#8ECFF2;\n    --good:#2E7D4F; --good-soft:#E5F4EB;\n    --flag:#C43D3D; --flag-soft:#FBEAEA;\n    --warn:#B07A28; --warn-soft:#FBF1DE;\n    --sarah:#7C4A78; --sarah-soft:#F3EAF2;\n    --erica:#B07A28; --erica-soft:#F7EFDF;\n    --clinic:#2E7AB8; --clinic-soft:#E7F2FB;\n    --radius:12px;\n    --shadow:0 1px 2px rgba(27,36,48,.05), 0 6px 18px rgba(46,122,184,.07);\n  }\n  *{ box-sizing:border-box; margin:0; padding:0; }\n  html,body{ min-height:100%; }\n  body{ font-family:\"Segoe UI\",\"Avenir Next\",system-ui,-apple-system,sans-serif; background:var(--paper); color:var(--ink); font-size:15px; line-height:1.45; -webkit-font-smoothing:antialiased; }\n  .hidden{ display:none !important; }\n  button{ font-family:inherit; }\n\n  /* ---------- auth ---------- */\n  .auth{ min-height:100vh; display:flex; align-items:center; justify-content:center; padding:24px 16px;\n    background: radial-gradient(1200px 500px at 50% -10%, #DCEEFB 0%, var(--paper) 60%); }\n  .authcard{ width:100%; max-width:400px; background:var(--surface); border:1px solid var(--line); border-radius:18px; box-shadow:var(--shadow); padding:30px 28px; }\n  .authcard .logo{ height:46px; display:block; margin:0 auto 8px; }\n  .authcard h1{ text-align:center; font-size:22px; margin-bottom:2px; }\n  .authcard .lead{ text-align:center; color:var(--ink-soft); font-size:13.5px; margin-bottom:22px; }\n  .authcard .field{ margin-bottom:14px; }\n  .authcard .btn{ width:100%; padding:12px; font-size:15px; }\n  .err{ color:var(--flag); font-size:13px; font-weight:600; min-height:18px; margin-top:10px; text-align:center; }\n\n  /* ---------- header ---------- */\n  header{ background:var(--surface); border-bottom:1px solid var(--line); position:sticky; top:0; z-index:20; }\n  .bar{ max-width:1120px; margin:0 auto; padding:12px 20px 0; display:flex; align-items:center; justify-content:space-between; gap:12px; flex-wrap:wrap; }\n  .brand{ display:flex; align-items:center; gap:12px; min-width:0; }\n  .brand img{ height:40px; width:auto; display:block; }\n  .brand .sub{ font-size:10.5px; color:var(--brand); letter-spacing:.8px; text-transform:uppercase; font-weight:700; }\n  .brand h1{ font-size:18px; font-weight:700; letter-spacing:.1px; line-height:1.15; }\n  .who{ display:flex; align-items:center; gap:8px; flex-wrap:wrap; }\n  .avatar{ width:32px; height:32px; border-radius:50%; background:var(--brand-soft); color:var(--brand-dark); font-weight:800; display:flex; align-items:center; justify-content:center; font-size:13px; }\n  .who .nm{ font-weight:700; font-size:13.5px; line-height:1.1; }\n  .who .rl{ font-size:11.5px; color:var(--ink-soft); }\n  nav{ max-width:1120px; margin:0 auto; padding:8px 20px 0; display:flex; gap:2px; overflow-x:auto; scrollbar-width:none; }\n  nav::-webkit-scrollbar{ display:none; }\n  nav button{ appearance:none; border:0; background:transparent; cursor:pointer; color:var(--ink-soft); font-weight:600; font-size:14.5px; padding:11px 16px 13px; border-bottom:3px solid transparent; white-space:nowrap; display:flex; align-items:center; gap:7px; }\n  nav button svg{ width:17px; height:17px; }\n  nav button:hover{ color:var(--brand); }\n  nav button.active{ color:var(--brand); border-bottom-color:var(--brand); }\n  .badge{ display:inline-block; min-width:20px; padding:1px 7px; background:var(--flag); color:#fff; border-radius:999px; font-size:12px; font-weight:800; text-align:center; line-height:1.5; }\n  .badge.soft{ background:var(--brand-soft); color:var(--brand-dark); }\n  .badge.zero{ display:none; }\n  .notebar{ display:flex; gap:10px; align-items:center; flex-wrap:wrap; background:var(--flag); color:#fff; border-radius:var(--radius); padding:11px 16px; margin-bottom:16px; font-weight:700; cursor:pointer; }\n  .notebar .btn{ margin-left:auto; }\n  .wallhead{ display:flex; gap:12px; align-items:center; flex-wrap:wrap; margin-bottom:14px; }\n  .wallhead select{ max-width:260px; }\n  .notegrid{ display:grid; grid-template-columns:repeat(auto-fill,minmax(210px,1fr)); gap:16px; }\n  .sticky{ position:relative; border-radius:4px 4px 12px 4px; padding:16px 14px 12px; min-height:150px; box-shadow:0 6px 14px rgba(30,40,60,.13); display:flex; flex-direction:column; gap:8px; transform:rotate(-.6deg); }\n  .sticky:nth-child(2n){ transform:rotate(.7deg); }\n  .sticky.yellow{ background:#FFF4A8; } .sticky.pink{ background:#FFD6E3; } .sticky.blue{ background:#D3EAFF; } .sticky.green{ background:#D6F5D6; }\n  .sticky.nyellow{ background:#FAFF00; } .sticky.npink{ background:#FF5CC8; } .sticky.ngreen{ background:#39FF88; } .sticky.norange{ background:#FF9F1C; }\n  .sticky.nblue{ background:#2EE6FF; } .sticky.npurple{ background:#C77DFF; } .sticky.nred{ background:#FF4D6D; } .sticky.nlime{ background:#C6FF1A; }\n  .sticky.npink .ntext, .sticky.npurple .ntext, .sticky.nred .ntext{ color:#1a1a1a; font-weight:550; }\n  .sticky.npink .nmeta, .sticky.npurple .nmeta, .sticky.nred .nmeta{ color:#222; }\n  .colorpick{ flex-wrap:wrap; }\n  .sticky .ntext{ white-space:pre-wrap; word-break:break-word; font-size:15px; color:#2a2a2a; flex:1; }\n  .sticky .nmeta{ font-size:12px; color:#555; }\n  .sticky .nact{ display:flex; gap:6px; flex-wrap:wrap; }\n  .sticky .nact button{ font-size:12px; padding:4px 9px; border-radius:7px; border:1px solid rgba(0,0,0,.15); background:rgba(255,255,255,.65); cursor:pointer; font-weight:650; }\n  .sticky .newflag{ position:absolute; top:-9px; right:10px; background:var(--flag); color:#fff; font-size:11px; font-weight:800; padding:2px 8px; border-radius:999px; letter-spacing:.4px; }\n  .sticky.isdone{ opacity:.8; transform:none; }\n  .sticky.isdel{ opacity:.7; transform:none; filter:grayscale(.5); }\n  .sticky.isdel .ntext{ text-decoration:line-through; }\n  .sticky .nadd{ font-size:14px; color:#2a2a2a; border-left:3px solid rgba(0,0,0,.25); padding-left:7px; white-space:pre-wrap; word-break:break-word; }\n  .sticky .nadd small{ display:block; font-size:11px; color:#777; font-style:italic; }\n  .sticky .ncomments{ border-top:1px dashed rgba(0,0,0,.18); padding-top:6px; display:flex; flex-direction:column; gap:5px; }\n  .sticky .ncomment{ font-size:12.5px; color:#333; background:rgba(255,255,255,.55); border-radius:6px; padding:5px 7px; white-space:pre-wrap; word-break:break-word; }\n  .sticky .ncomment small{ color:#666; }\n  .sticky .nstatus{ font-size:12px; font-weight:700; border-radius:6px; padding:4px 7px; background:rgba(255,255,255,.7); }\n  .sticky .nstatus.del{ color:var(--flag); } .sticky .nstatus.ok{ color:var(--good); }\n  .colorpick{ display:flex; gap:8px; }\n  .wallpick{ display:flex; flex-wrap:wrap; gap:6px; }\n  .wallpick label{ display:inline-flex; align-items:center; gap:6px; margin:0; padding:6px 11px; border:1px solid var(--line, #D8E0E8); border-radius:999px; font-size:13.5px; font-weight:600; cursor:pointer; background:#fff; text-transform:none; letter-spacing:normal; white-space:nowrap; color:var(--ink); }\n  .wallpick label.on{ background:var(--brand-soft); border-color:var(--brand-dark); color:var(--brand-dark); }\n  .wallpick input{ margin:0; }\n  .wallpick .allbtn{ border:none; background:none; color:var(--brand-dark); font-weight:700; font-size:13px; cursor:pointer; padding:6px 4px; }\n  .sticky .nalso{ font-size:12px; color:#555; margin-top:4px; }\n  .colorpick button{ width:30px; height:30px; border-radius:7px; border:2px solid transparent; cursor:pointer; }\n  .colorpick button.on{ border-color:var(--ink); }\n  .walltabs{ display:flex; gap:6px; flex-wrap:wrap; }\n  .walltabs button{ border:1px solid var(--line); background:#fff; border-radius:999px; padding:5px 12px; font-weight:650; cursor:pointer; font-size:13.5px; }\n  .walltabs button.on{ background:var(--brand); color:#fff; border-color:var(--brand); }\n  .walltabs .cnt{ margin-left:6px; font-size:11.5px; padding:0 6px; border-radius:999px; background:rgba(0,0,0,.08); }\n\n  /* ---------- layout ---------- */\n  main{ max-width:1120px; margin:0 auto; padding:22px 20px 70px; }\n  .tab{ display:none; } .tab.active{ display:block; }\n  h2{ font-size:16.5px; font-weight:700; }\n  .card{ background:var(--surface); border:1px solid var(--line); border-radius:var(--radius); box-shadow:var(--shadow); padding:18px 20px; margin-bottom:18px; }\n  .cardhead{ display:flex; align-items:center; justify-content:space-between; gap:10px; flex-wrap:wrap; margin-bottom:14px; }\n  .muted{ color:var(--ink-soft); font-size:13px; }\n  .section-title{ display:flex; align-items:center; justify-content:space-between; gap:10px; margin:24px 0 10px; flex-wrap:wrap; }\n\n  /* ---------- forms ---------- */\n  .formgrid{ display:grid; grid-template-columns:repeat(auto-fit,minmax(160px,1fr)); gap:12px; }\n  .span2{ grid-column:span 2; } .full{ grid-column:1 / -1; }\n  @media (max-width:520px){ .span2{ grid-column:1 / -1; } }\n  label{ display:block; font-size:11.5px; font-weight:700; color:var(--ink-soft); letter-spacing:.5px; text-transform:uppercase; margin-bottom:5px; }\n  input, select, textarea{ width:100%; padding:10px 11px; border:1px solid var(--line-strong); border-radius:9px; font:inherit; font-size:14.5px; color:var(--ink); background:#fff; }\n  textarea{ resize:vertical; min-height:80px; }\n  input:focus, select:focus, textarea:focus{ outline:2px solid var(--brand); outline-offset:0; border-color:var(--brand); }\n  .formactions{ margin-top:14px; display:flex; gap:10px; align-items:center; flex-wrap:wrap; }\n  .check{ display:flex; align-items:center; gap:8px; font-size:13.5px; text-transform:none; letter-spacing:0; font-weight:600; color:var(--ink); }\n  .check input{ width:auto; }\n\n  .btn{ appearance:none; cursor:pointer; border:1px solid transparent; border-radius:9px; font-weight:650; font-size:13.5px; padding:9px 15px; line-height:1.2; display:inline-flex; align-items:center; justify-content:center; gap:6px; white-space:nowrap; }\n  .btn:focus-visible{ outline:2px solid var(--ink); outline-offset:2px; }\n  .btn:disabled{ opacity:.55; cursor:default; }\n  .btn-primary{ background:var(--brand); color:#fff; } .btn-primary:hover{ background:var(--brand-dark); }\n  .btn-good{ background:var(--good); color:#fff; } .btn-good:hover{ filter:brightness(1.08); }\n  .btn-flag{ background:var(--flag); color:#fff; } .btn-flag:hover{ filter:brightness(1.06); }\n  .btn-quiet{ background:var(--brand-soft); color:var(--brand-dark); } .btn-quiet:hover{ background:#D6E9F7; }\n  .btn-white{ background:#fff; border-color:var(--line-strong); color:var(--ink); } .btn-white:hover{ background:#F7FAFC; }\n  .btn-link{ background:none; border:0; color:var(--brand); padding:4px 2px; text-decoration:underline; font-weight:600; }\n  .btn-sm{ padding:6px 10px; font-size:12.5px; border-radius:8px; }\n  .btn-lg{ padding:12px 20px; font-size:15px; }\n\n  /* ---------- tables ---------- */\n  .toolbar{ display:flex; gap:10px; flex-wrap:wrap; align-items:center; margin-bottom:12px; }\n  .toolbar input[type=search]{ max-width:260px; }\n  .toolbar select, .toolbar input[type=month]{ width:auto; max-width:220px; }\n  .tablewrap{ overflow-x:auto; border:1px solid var(--line); border-radius:var(--radius); background:var(--surface); box-shadow:var(--shadow); }\n  table{ width:100%; border-collapse:collapse; min-width:720px; }\n  .section-title .toolbar{ justify-content:flex-end; }\n  td.nowrap{ white-space:nowrap; }\n  thead th{ text-align:left; font-size:11px; letter-spacing:.6px; text-transform:uppercase; color:var(--ink-soft); background:#F6F9FC; padding:10px 12px; border-bottom:1px solid var(--line); white-space:nowrap; }\n  tbody td{ padding:11px 12px; border-bottom:1px solid var(--line); vertical-align:middle; font-size:14px; }\n  tbody tr:last-child td{ border-bottom:0; }\n  tbody tr:hover{ background:#F8FBFD; }\n  td.num, th.num{ text-align:right; font-variant-numeric:tabular-nums; }\n  td.empty{ text-align:center; color:var(--ink-soft); padding:28px; }\n  tr.flagged{ background:var(--flag-soft); } tr.flagged:hover{ background:#F7DFDF; }\n  tr.flagged td:first-child{ box-shadow:inset 4px 0 0 var(--flag); }\n  tr.voided td{ color:var(--ink-faint); } tr.voided td.strike{ text-decoration:line-through; }\n  .sub2{ font-size:12px; color:var(--ink-soft); margin-top:2px; }\n  .rowactions{ display:flex; gap:6px; flex-wrap:wrap; }\n\n  .chip{ display:inline-block; padding:2px 10px; border-radius:999px; font-size:12px; font-weight:700; white-space:nowrap; }\n  .chip.Clinic{ background:var(--clinic-soft); color:var(--clinic); }\n  .chip.Sarah{ background:var(--sarah-soft); color:var(--sarah); }\n  .chip.Erica{ background:var(--erica-soft); color:var(--erica); }\n  .chip.gray{ background:#EEF2F6; color:var(--ink-soft); }\n  .tag{ display:inline-block; border-radius:6px; font-size:10.5px; font-weight:800; letter-spacing:.5px; padding:2px 7px; text-transform:uppercase; vertical-align:middle; }\n  .tag.red{ background:var(--flag); color:#fff; } .tag.amber{ background:var(--warn-soft); color:#8A5A12; }\n  .tag.green{ background:var(--good-soft); color:var(--good); } .tag.blue{ background:var(--brand-soft); color:var(--brand-dark); }\n  .tag.gray{ background:#EEF2F6; color:var(--ink-soft); }\n  .paidtag{ color:var(--good); font-weight:700; font-size:12.5px; } .owedtag{ color:var(--flag); font-weight:700; font-size:12.5px; }\n\n  /* ---------- cleaning ---------- */\n  .hero{ display:grid; grid-template-columns:1fr auto; gap:16px; align-items:center; background:linear-gradient(135deg,#2E7AB8 0%,#3E93D1 100%); color:#fff; border-radius:16px; padding:22px 24px; margin-bottom:18px; box-shadow:0 8px 24px rgba(46,122,184,.25); }\n  .hero .eyebrow{ font-size:12px; letter-spacing:.8px; text-transform:uppercase; opacity:.85; font-weight:700; }\n  .hero h2{ font-size:24px; margin:2px 0 6px; color:#fff; }\n  .hero .assign{ font-size:14.5px; opacity:.95; }\n  .hero .assign strong{ font-weight:800; }\n  .ring{ width:92px; height:92px; position:relative; }\n  .ring svg{ width:92px; height:92px; transform:rotate(-90deg); }\n  .ring .lbl{ position:absolute; inset:0; display:flex; flex-direction:column; align-items:center; justify-content:center; font-weight:800; font-size:20px; line-height:1; }\n  .ring .lbl small{ font-size:11px; font-weight:600; opacity:.85; margin-top:3px; }\n  .hero .heroactions{ grid-column:1 / -1; display:flex; gap:8px; flex-wrap:wrap; }\n  .hero .btn-white{ background:rgba(255,255,255,.16); border-color:rgba(255,255,255,.35); color:#fff; }\n  .hero .btn-white:hover{ background:rgba(255,255,255,.26); }\n\n  .daychips{ display:grid; grid-template-columns:repeat(5,1fr); gap:8px; margin-bottom:14px; }\n  .daychip{ appearance:none; cursor:pointer; text-align:left; background:var(--surface); border:1px solid var(--line); border-radius:12px; padding:10px 12px; box-shadow:var(--shadow); position:relative; }\n  .daychip .d{ font-weight:800; font-size:14px; }\n  .daychip .dt{ font-size:12px; color:var(--ink-soft); }\n  .daychip .st{ font-size:12px; margin-top:4px; font-weight:700; color:var(--ink-soft); }\n  .daychip.sel{ border-color:var(--brand); box-shadow:0 0 0 2px var(--brand) inset, var(--shadow); }\n  .daychip.today .d::after{ content:\"Today\"; margin-left:6px; font-size:10px; background:var(--brand); color:#fff; border-radius:5px; padding:1px 5px; vertical-align:2px; }\n  .daychip.missed .st{ color:var(--flag); } .daychip.complete .st{ color:var(--good); }\n  @media (max-width:640px){ .daychip{ padding:8px; } .daychip .dt{ display:none; } .daychip.today .d::after{ display:none; } .daychip.today{ border-color:var(--brand); } }\n\n  .tasks{ list-style:none; }\n  .task{ display:grid; grid-template-columns:34px 1fr auto; gap:12px; align-items:center; padding:13px 2px; border-bottom:1px solid var(--line); }\n  .task:last-child{ border-bottom:0; }\n  .tick{ width:30px; height:30px; border-radius:50%; border:2px solid var(--line-strong); display:flex; align-items:center; justify-content:center; color:#fff; }\n  .task.done .tick{ background:var(--good); border-color:var(--good); }\n  .task.missed .tick{ border-color:var(--flag); }\n  .carryhead{ display:flex; align-items:center; gap:8px; margin:4px 0 6px; font-weight:800; color:var(--flag); font-size:14px; }\n  .task.carry{ background:#FFF6F5; border-radius:10px; padding-left:8px; padding-right:8px; }\n  .swaptag{ display:inline-block; font-size:11.5px; font-weight:700; background:var(--warn-soft); color:#8A5A12; border-radius:999px; padding:2px 8px; margin-left:6px; vertical-align:2px; }\n  .task.half .tick{ background:var(--warn-soft); border-color:var(--warn); color:var(--warn); font-weight:800; font-size:12px; display:flex; align-items:center; justify-content:center; }\n  .task .tname{ font-weight:650; font-size:15px; }\n  .task.done .tname{ color:var(--ink-soft); }\n  .task .tmeta{ font-size:12.5px; color:var(--ink-soft); margin-top:2px; }\n  .task .quote{ font-size:12.5px; color:var(--ink); background:#F6F9FC; border-left:3px solid var(--warn); padding:6px 9px; border-radius:6px; margin-top:6px; }\n  @media (max-width:520px){ .task{ grid-template-columns:30px 1fr; } .task .tact{ grid-column:2; } }\n\n  /* ---------- supplies ---------- */\n  .subnav{ display:flex; gap:6px; flex-wrap:wrap; margin-bottom:16px; }\n  .subnav button{ appearance:none; cursor:pointer; border:1px solid var(--line); background:var(--surface); color:var(--ink-soft); font-weight:650; font-size:13.5px; padding:8px 14px; border-radius:999px; display:flex; align-items:center; gap:6px; }\n  .subnav button.active{ background:var(--brand); border-color:var(--brand); color:#fff; }\n  .subnav button.active .badge{ background:#fff; color:var(--flag); }\n  .alertbar{ display:flex; align-items:center; gap:10px; background:var(--flag-soft); border:1px solid #EFC9C9; color:#8C2B2B; border-radius:var(--radius); padding:12px 16px; margin-bottom:16px; font-weight:650; flex-wrap:wrap; }\n  .alertbar .btn{ margin-left:auto; }\n  .infobar{ display:flex; align-items:center; gap:10px; background:var(--brand-soft); border:1px solid #C9E0F2; color:var(--brand-dark); border-radius:var(--radius); padding:11px 15px; margin-bottom:16px; font-size:13.5px; font-weight:600; flex-wrap:wrap; }\n  .order-item{ border:1px solid #EFC9C9; border-left:6px solid var(--flag); background:var(--surface); border-radius:var(--radius); box-shadow:var(--shadow); padding:14px 16px; margin-bottom:10px; display:grid; grid-template-columns:1fr auto; gap:8px 14px; align-items:center; }\n  .order-item.ordered{ border-color:#E8DDC3; border-left-color:var(--warn); }\n  .oi-title{ font-weight:700; font-size:15.5px; display:flex; align-items:center; gap:8px; flex-wrap:wrap; }\n  .oi-meta{ font-size:12.5px; color:var(--ink-soft); margin-top:3px; }\n  @media (max-width:640px){ .order-item{ grid-template-columns:1fr; } }\n  .emptymsg{ color:var(--ink-soft); padding:26px; text-align:center; background:var(--surface); border:1px dashed var(--line-strong); border-radius:var(--radius); }\n  .moneygrid{ display:grid; grid-template-columns:repeat(auto-fit,minmax(160px,1fr)); gap:12px; margin-top:14px; }\n  .moneycard{ background:var(--paper); border:1px solid var(--line); border-radius:10px; padding:12px 14px; }\n  .moneycard .lbl{ font-size:11px; font-weight:700; letter-spacing:.4px; text-transform:uppercase; color:var(--ink-soft); }\n  .moneycard .amt{ font-size:22px; font-weight:800; margin-top:4px; font-variant-numeric:tabular-nums; }\n  .moneycard .hint{ font-size:12px; color:var(--ink-soft); margin-top:2px; }\n  .moneycard.good .amt{ color:var(--good); } .moneycard.bad .amt{ color:var(--flag); }\n  .balgrid{ display:grid; grid-template-columns:repeat(auto-fit,minmax(240px,1fr)); gap:14px; margin-bottom:18px; }\n  .balcard{ background:var(--surface); border:1px solid var(--line); border-radius:var(--radius); box-shadow:var(--shadow); padding:16px 18px; border-top:5px solid var(--line); }\n  .balcard.Sarah{ border-top-color:var(--sarah); } .balcard.Erica{ border-top-color:var(--erica); } .balcard.Clinic{ border-top-color:var(--clinic); }\n  .balcard .who2{ font-weight:800; font-size:15px; margin-bottom:6px; }\n  .balcard .big{ font-size:26px; font-weight:800; font-variant-numeric:tabular-nums; }\n  .qtyctl{ display:inline-flex; align-items:center; gap:6px; }\n  .qtyctl strong{ min-width:22px; text-align:center; display:inline-block; }\n\n  /* ---------- QC ---------- */\n  .result{ font-weight:800; font-size:12.5px; }\n  .result.Pass{ color:var(--good); } .result.Fail{ color:var(--flag); } .result.NA{ color:var(--ink-soft); }\n  .seg{ display:inline-flex; border:1px solid var(--line-strong); border-radius:9px; overflow:hidden; width:100%; }\n  .seg button{ flex:1; appearance:none; border:0; background:#fff; padding:10px 6px; font-weight:700; font-size:13.5px; cursor:pointer; color:var(--ink-soft); border-right:1px solid var(--line-strong); }\n  .seg button:last-child{ border-right:0; }\n  .seg button.on.Pass{ background:var(--good); color:#fff; } .seg button.on.Fail{ background:var(--flag); color:#fff; } .seg button.on.NA{ background:#6B7684; color:#fff; }\n\n  /* ---------- admin ---------- */\n  .weekgrid{ display:grid; grid-template-columns:repeat(auto-fit,minmax(190px,1fr)); gap:12px; }\n  .daycard{ border:1px solid var(--line); border-radius:10px; padding:12px; background:#FBFDFE; }\n  .daycard h3{ font-size:14.5px; margin-bottom:8px; }\n  .daycard textarea{ min-height:150px; font-size:13.5px; }\n  .rulebar{ display:flex; gap:12px; align-items:flex-start; background:var(--warn-soft); border:1px solid #EBD3A6; border-left:5px solid var(--warn); color:#5E4310; border-radius:var(--radius); padding:12px 16px; margin-bottom:16px; font-size:14px; line-height:1.45; }\n  .rulebar .ico{ font-size:20px; line-height:1; }\n  .rulebar strong{ color:#4A3409; }\n  .whotag{ display:inline-block; font-size:12px; font-weight:700; background:var(--brand-soft); color:var(--brand-dark); border-radius:999px; padding:2px 9px; margin-left:6px; vertical-align:2px; }\n  .whotag.me{ background:var(--good); color:#fff; }\n  .srow{ display:grid; grid-template-columns:1fr 1.3fr auto; gap:6px; margin-bottom:6px; align-items:center; }\n  .srow input{ font-size:13.5px; padding:7px 8px; min-width:0; }\n  .srow .x{ border:none; background:none; color:var(--ink-soft); font-size:18px; cursor:pointer; padding:0 4px; }\n  .srow .x:hover{ color:var(--flag); }\n  #schedEditor{ grid-template-columns:repeat(auto-fill,minmax(300px,1fr)); }\n  .shead{ display:grid; grid-template-columns:1fr 1.3fr auto; gap:6px; font-size:11.5px; font-weight:700; text-transform:uppercase; letter-spacing:.4px; color:var(--ink-soft); margin-bottom:4px; }\n  .pill{ display:inline-flex; align-items:center; gap:6px; font-weight:700; font-size:13px; padding:4px 10px; border-radius:999px; }\n  .pill.on{ background:var(--good-soft); color:var(--good); } .pill.off{ background:var(--flag-soft); color:var(--flag); }\n  .pill .dot{ width:8px; height:8px; border-radius:50%; background:currentColor; }\n  .admingrid{ display:grid; grid-template-columns:repeat(auto-fit,minmax(320px,1fr)); gap:18px; }\n  .admingrid .card{ margin-bottom:0; }\n\n  /* ---------- modal + toast ---------- */\n  .modal-bg{ position:fixed; inset:0; background:rgba(20,30,42,.45); display:flex; align-items:center; justify-content:center; padding:16px; z-index:50; }\n  .modal{ background:#fff; border-radius:16px; width:100%; max-width:460px; box-shadow:0 20px 60px rgba(0,0,0,.25); padding:22px; max-height:90vh; overflow:auto; }\n  .modal h3{ font-size:18px; margin-bottom:6px; }\n  .modal .msg{ color:var(--ink-soft); font-size:14px; margin-bottom:14px; white-space:pre-line; }\n  .modal .field{ margin-bottom:12px; }\n  .modal .acts{ display:flex; justify-content:flex-end; gap:8px; margin-top:16px; }\n  .toast{ position:fixed; left:50%; bottom:22px; transform:translateX(-50%) translateY(20px); background:#1B2430; color:#fff; padding:11px 18px; border-radius:10px; font-weight:600; font-size:14px; box-shadow:0 10px 30px rgba(0,0,0,.25); opacity:0; pointer-events:none; transition:all .2s ease; z-index:60; max-width:calc(100% - 32px); }\n  .toast.show{ opacity:1; transform:translateX(-50%) translateY(0); }\n  .toast.bad{ background:var(--flag); }\n  .loading{ position:fixed; top:0; left:0; height:3px; background:var(--brand); z-index:70; width:0; transition:width .3s ease; }\n  .loading.on{ width:70%; transition:width 4s cubic-bezier(.1,.7,.2,1); }\n\n  @media (max-width:640px){\n    .bar{ padding:10px 14px 0; } nav{ padding:4px 8px 0; } main{ padding:16px 14px 60px; }\n    .brand img{ height:32px; } .brand h1{ font-size:16px; }\n    .who .rl, .who .nm{ display:none; }\n    .hero{ padding:18px; } .hero h2{ font-size:20px; } .ring, .ring svg{ width:76px; height:76px; }\n    nav button{ padding:10px 12px 12px; font-size:14px; }\n  }\n  @media (prefers-reduced-motion: reduce){ *{ transition:none !important; animation:none !important; } }\n</style>\n<script>\n/* talk to the Cloudflare worker the same way the page talked to Apps Script */\nwindow.google = { script: { get run() {\n  let ok = () => {}, bad = () => {};\n  const p = new Proxy({}, { get(_, k) {\n    if (k === 'withSuccessHandler') return f => { ok = f; return p; };\n    if (k === 'withFailureHandler') return f => { bad = f; return p; };\n    return (...args) => fetch('/api', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ fn: k, args }) })\n      .then(r => r.json()).then(ok, bad);\n  } });\n  return p;\n} } };\n</script>\n</head>\n<body>\n<div class=\"loading\" id=\"loading\"></div>\n\n<!-- ======================= SIGN IN ======================= -->\n<div id=\"screen-auth\" class=\"auth hidden\">\n  <div class=\"authcard\">\n    <img class=\"logo\" src=\"data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAARgAAABgCAYAAADGiG2UAAAEt0lEQVR4nO3dWascRRjG8ScaI2oUjbiAQUVBjPKIMe4XRlBBwbglaIzLlZ9AL/wE3voFvFMvXZJ4UOIeCIqiKLx6J3qlBkTQKC4RjZT2QAg5p2umu7przvx/cOAwU91Vc5aHqu6qagkAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAABAJ2tUgWc/O3Skr3M9ufmMKj4TAOkEfggASiFgABRDwAAohoABUAwBA6CYteVOjT7YvkjSN5l3/P6WtDEiDvZU96OSXmgp9mlEXNuxnickPVe6HgyPHkz90j957q33EyU9VLg9QDYCpn6PTFl+V6F2AFMjYCpme4ukTVMedr3tSws1CZgKAVO3x2Y8jl4MqkDAVMp2up6yc8bDCRhUgYCp1x2Szpvx2MttX9Nze4CpETDzOzz6qOV9ejEYHQFTIdunSbp3hSJ/SFpqOc1O2/x+MSr+AOv0gKQUMsv5XFK0nOMCSVt7bhcwFQKm3sl1K3lb0gFJbfvoMEzCqAiYytg+X9JtLcWWIuJHSZ+0lNtue12PzQOGW4vU5050femrTSPujJd6HekW9XK+l/Rx8/1uSdetUPYsSXdJ2tNzG4H5Wuz40v6vO59jx9ZLtADDo70RMQnRFBzPZCw1IGAwCoZIFbF9haTNLcVSr+U/EfGlpK9ayt9t+/R+WghMh4CZr7kvv0h695jX2nonp0i6v2O7gPkeIi0622sy7vq8ERGHj9OjearluHTe51XGFtvVXYtDHejB1OMWSRfmDo+O8oGkH1qOu932uR3aBsyEgJmf4dFfkl4/9sWI+EfSay3HshEVRkHAVMD2yWnOSkux9yPi52Xey7lLxKQ7DI6AqcM2SWfOMDyaeEvSby3H32h7VdzHx/wgYOZjeHRkpV5KRPwu6c2MeujFYFAEzMhsb5B0Z8aO+t926OFMEDAYFLepx5eeArCuh/BYah5bstIyg022r46ItBq7L4eb5QtdrJd0dk/tQUUImPnYd7c1YNLiR9sHMrZoSL2YPgMmBnouEuYQATOi5qLrTRlFv7DdV7UP2376qPVMQDFcg6l7YWMJG5tJfUBxBMx8PVStL1zsxSAImJHYvkHSZSNVv8P2SSPVjQVCwCzW8GhiQ7MRFbAYF3lXyWZRWWyvreAh9WmYtHfkNmCVW1vDtpJ9br054laX00gT684ZuQ3bbK+PiF9HbgdWMYZI9Q6PDko6tdkwatqvxzPOn859Xw+fBah/iLQomu0r78kourtZYzRLHWnd0p+S0irttrtYL85SB5CDHszwtje9jDavzlpBRByS9E5G0bQR1dhDNaxiBEydSwN+kvRex3pezuzBPtixHmBZBMyAbKfHud6aUTQ9WC3tYNfFnmbxYxsm3aEYAmZYuzJ/5q90rah58uP+jKI32764a33A8RAw9Q2P0s50+3qqLzeo6MWgCAJmIP5/OXTOkuh9EdG2/WWudKE4Z44RAYMiCJi6ei+9DI8mIuI7SR9mFL3S9lV91QtMVDHrdQFn8gILgR4MgGIIGADFEDAAiiFgABRDwAAohoABUAwBAwAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAKibfwGpTtV6dkaZCAAAAABJRU5ErkJggg==\" alt=\"Aligned Health\">\n    <h1>Clinic Hub</h1>\n    <p class=\"lead\" id=\"authLead\">Sign in to continue</p>\n\n    <form id=\"loginForm\" autocomplete=\"on\">\n      <div class=\"field\"><label for=\"l-user\">Username</label><input id=\"l-user\" autocomplete=\"username\" autocapitalize=\"none\" required></div>\n      <div class=\"field\"><label for=\"l-pass\">Password</label><input id=\"l-pass\" type=\"password\" autocomplete=\"current-password\" required></div>\n      <button class=\"btn btn-primary\" type=\"submit\" id=\"loginBtn\">Sign in</button>\n      <div class=\"err\" id=\"loginErr\"></div>\n    </form>\n\n    <form id=\"setupForm\" class=\"hidden\" autocomplete=\"off\">\n      <div class=\"field\"><label for=\"s-code\">Setup code</label><input id=\"s-code\" required></div>\n      <div class=\"field\"><label for=\"s-name\">Your name</label><input id=\"s-name\" required placeholder=\"Jacob\"></div>\n      <div class=\"field\"><label for=\"s-user\">Username</label><input id=\"s-user\" required autocapitalize=\"none\" placeholder=\"jacob\"></div>\n      <div class=\"field\"><label for=\"s-email\">Email</label><input id=\"s-email\" type=\"email\" value=\"jacob@alignedhealthmurray.com\"></div>\n      <div class=\"field\"><label for=\"s-pass\">Password (6+ characters)</label><input id=\"s-pass\" type=\"password\" required autocomplete=\"new-password\"></div>\n      <button class=\"btn btn-primary\" type=\"submit\" id=\"setupBtn\">Create admin account</button>\n      <div class=\"err\" id=\"setupErr\"></div>\n    </form>\n  </div>\n</div>\n\n<!-- ======================= APP ======================= -->\n<div id=\"screen-app\" class=\"hidden\">\n<header>\n  <div class=\"bar\">\n    <div class=\"brand\">\n      <img src=\"data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAARgAAABgCAYAAADGiG2UAAAEt0lEQVR4nO3dWascRRjG8ScaI2oUjbiAQUVBjPKIMe4XRlBBwbglaIzLlZ9AL/wE3voFvFMvXZJ4UOIeCIqiKLx6J3qlBkTQKC4RjZT2QAg5p2umu7przvx/cOAwU91Vc5aHqu6qagkAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAABAJ2tUgWc/O3Skr3M9ufmMKj4TAOkEfggASiFgABRDwAAohoABUAwBA6CYteVOjT7YvkjSN5l3/P6WtDEiDvZU96OSXmgp9mlEXNuxnickPVe6HgyPHkz90j957q33EyU9VLg9QDYCpn6PTFl+V6F2AFMjYCpme4ukTVMedr3tSws1CZgKAVO3x2Y8jl4MqkDAVMp2up6yc8bDCRhUgYCp1x2Szpvx2MttX9Nze4CpETDzOzz6qOV9ejEYHQFTIdunSbp3hSJ/SFpqOc1O2/x+MSr+AOv0gKQUMsv5XFK0nOMCSVt7bhcwFQKm3sl1K3lb0gFJbfvoMEzCqAiYytg+X9JtLcWWIuJHSZ+0lNtue12PzQOGW4vU5050femrTSPujJd6HekW9XK+l/Rx8/1uSdetUPYsSXdJ2tNzG4H5Wuz40v6vO59jx9ZLtADDo70RMQnRFBzPZCw1IGAwCoZIFbF9haTNLcVSr+U/EfGlpK9ayt9t+/R+WghMh4CZr7kvv0h695jX2nonp0i6v2O7gPkeIi0622sy7vq8ERGHj9OjearluHTe51XGFtvVXYtDHejB1OMWSRfmDo+O8oGkH1qOu932uR3aBsyEgJmf4dFfkl4/9sWI+EfSay3HshEVRkHAVMD2yWnOSkux9yPi52Xey7lLxKQ7DI6AqcM2SWfOMDyaeEvSby3H32h7VdzHx/wgYOZjeHRkpV5KRPwu6c2MeujFYFAEzMhsb5B0Z8aO+t926OFMEDAYFLepx5eeArCuh/BYah5bstIyg022r46ItBq7L4eb5QtdrJd0dk/tQUUImPnYd7c1YNLiR9sHMrZoSL2YPgMmBnouEuYQATOi5qLrTRlFv7DdV7UP2376qPVMQDFcg6l7YWMJG5tJfUBxBMx8PVStL1zsxSAImJHYvkHSZSNVv8P2SSPVjQVCwCzW8GhiQ7MRFbAYF3lXyWZRWWyvreAh9WmYtHfkNmCVW1vDtpJ9br054laX00gT684ZuQ3bbK+PiF9HbgdWMYZI9Q6PDko6tdkwatqvxzPOn859Xw+fBah/iLQomu0r78kourtZYzRLHWnd0p+S0irttrtYL85SB5CDHszwtje9jDavzlpBRByS9E5G0bQR1dhDNaxiBEydSwN+kvRex3pezuzBPtixHmBZBMyAbKfHud6aUTQ9WC3tYNfFnmbxYxsm3aEYAmZYuzJ/5q90rah58uP+jKI32764a33A8RAw9Q2P0s50+3qqLzeo6MWgCAJmIP5/OXTOkuh9EdG2/WWudKE4Z44RAYMiCJi6ei+9DI8mIuI7SR9mFL3S9lV91QtMVDHrdQFn8gILgR4MgGIIGADFEDAAiiFgABRDwAAohoABUAwBAwAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAKibfwGpTtV6dkaZCAAAAABJRU5ErkJggg==\" alt=\"Aligned Health\">\n      <div><div class=\"sub\">Aligned Health</div><h1>Clinic Hub</h1></div>\n    </div>\n    <div class=\"who\">\n      <div class=\"avatar\" id=\"meAvatar\">?</div>\n      <div><div class=\"nm\" id=\"meName\"></div><div class=\"rl\" id=\"meRole\"></div></div>\n      <button class=\"btn btn-white btn-sm\" onclick=\"changeMyPassword()\">Password</button>\n      <button class=\"btn btn-white btn-sm\" onclick=\"signOut()\">Sign out</button>\n    </div>\n  </div>\n  <nav id=\"mainnav\">\n    <button data-tab=\"cleaning\" class=\"active\" onclick=\"showTab('cleaning')\">\n      <svg viewBox=\"0 0 24 24\" fill=\"none\" stroke=\"currentColor\" stroke-width=\"2\" stroke-linecap=\"round\" stroke-linejoin=\"round\"><path d=\"M9 11l3 3L22 4\"/><path d=\"M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11\"/></svg>\n      Cleaning <span class=\"badge soft zero\" id=\"cleanBadge\">0</span></button>\n    <button data-tab=\"supplies\" onclick=\"showTab('supplies')\">\n      <svg viewBox=\"0 0 24 24\" fill=\"none\" stroke=\"currentColor\" stroke-width=\"2\" stroke-linecap=\"round\" stroke-linejoin=\"round\"><path d=\"M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16z\"/><path d=\"M3.27 6.96L12 12.01l8.73-5.05M12 22.08V12\"/></svg>\n      Supplies <span class=\"badge zero\" id=\"supBadge\">0</span></button>\n    <button data-tab=\"qc\" onclick=\"showTab('qc')\">\n      <svg viewBox=\"0 0 24 24\" fill=\"none\" stroke=\"currentColor\" stroke-width=\"2\" stroke-linecap=\"round\" stroke-linejoin=\"round\"><path d=\"M9 2v6L4 18a2 2 0 0 0 1.8 3h12.4A2 2 0 0 0 20 18L15 8V2\"/><path d=\"M8 2h8M7 14h10\"/></svg>\n      CLIA QC</button>\n    <button data-tab=\"meds\" onclick=\"showTab('meds')\">\n      <svg viewBox=\"0 0 24 24\" fill=\"none\" stroke=\"currentColor\" stroke-width=\"2\" stroke-linecap=\"round\" stroke-linejoin=\"round\"><path d=\"M10.5 20.5 3.5 13.5a4.95 4.95 0 0 1 7-7l7 7a4.95 4.95 0 0 1-7 7z\"/><path d=\"m8.5 8.5 7 7\"/></svg>\n      NDC / Lot <span class=\"badge zero\" id=\"medBadge\">0</span></button>\n    <button data-tab=\"notes\" onclick=\"showTab('notes')\">\n      <svg viewBox=\"0 0 24 24\" fill=\"none\" stroke=\"currentColor\" stroke-width=\"2\" stroke-linecap=\"round\" stroke-linejoin=\"round\"><path d=\"M15.5 3H5a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2V8.5L15.5 3z\"/><path d=\"M15 3v6h6\"/></svg>\n      Sticky Notes <span class=\"badge zero\" id=\"noteBadge\">0</span></button>\n    <button data-tab=\"admin\" id=\"adminNavBtn\" class=\"hidden\" onclick=\"showTab('admin')\">\n      <svg viewBox=\"0 0 24 24\" fill=\"none\" stroke=\"currentColor\" stroke-width=\"2\" stroke-linecap=\"round\" stroke-linejoin=\"round\"><circle cx=\"12\" cy=\"12\" r=\"3\"/><path d=\"M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.6 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.6a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z\"/></svg>\n      Admin</button>\n  </nav>\n</header>\n\n<main>\n  <!-- ================= CLEANING ================= -->\n  <div class=\"notebar hidden\" id=\"noteBar\" onclick=\"showTab('notes'); pickWall(D.me.username)\"><span>\ud83d\udccc <span id=\"noteBarText\"></span></span><button class=\"btn btn-white btn-sm\">Open</button></div>\n  <section id=\"tab-cleaning\" class=\"tab active\">\n    <div class=\"hero\" id=\"cleanHero\"></div>\n    <div class=\"rulebar\" id=\"cleanRule\"></div>\n    <div class=\"daychips\" id=\"dayChips\"></div>\n    <div class=\"card\" id=\"cleanList\"></div>\n\n    <div class=\"section-title\">\n      <h2>Cleaning history</h2>\n      <div class=\"toolbar\" style=\"margin:0\">\n        <input type=\"month\" id=\"histMonth\" onchange=\"loadHistory()\">\n        <button class=\"btn btn-white btn-sm\" onclick=\"exportHistoryCSV()\">Export CSV</button>\n      </div>\n    </div>\n    <div class=\"tablewrap\">\n      <table>\n        <thead><tr><th>Date</th><th>Task</th><th>Assigned</th><th>Done by</th><th>Time</th><th>Note</th></tr></thead>\n        <tbody id=\"histBody\"><tr><td colspan=\"6\" class=\"empty\">Loading\u2026</td></tr></tbody>\n      </table>\n    </div>\n  </section>\n\n  <!-- ================= SUPPLIES ================= -->\n  <section id=\"tab-supplies\" class=\"tab\">\n    <div class=\"subnav\" id=\"supnav\">\n      <button data-sub=\"inventory\" class=\"active\" onclick=\"showSub('inventory')\">Inventory</button>\n      <button data-sub=\"ordering\" onclick=\"showSub('ordering')\">Ordering <span class=\"badge zero\" id=\"orderBadge\">0</span></button>\n      <button data-sub=\"monthly\" onclick=\"showSub('monthly')\">Ordered by month</button>\n      <button data-sub=\"balances\" onclick=\"showSub('balances')\">Balances</button>\n    </div>\n\n    <!-- inventory -->\n    <div class=\"sub\" id=\"sub-inventory\">\n      <div class=\"alertbar hidden\" id=\"orderAlert\">\n        <span>\u26a0 <span id=\"orderAlertText\"></span></span>\n        <button class=\"btn btn-flag btn-sm\" onclick=\"showSub('ordering')\">Go to Ordering</button>\n      </div>\n      <div class=\"card\">\n        <div class=\"cardhead\"><h2 id=\"itemFormTitle\">Add inventory item</h2></div>\n        <div class=\"formgrid\">\n          <div class=\"span2\"><label for=\"f-name\">Item name</label><input id=\"f-name\" placeholder=\"e.g. Nitrile gloves (M), box of 100\"></div>\n          <div><label for=\"f-category\">Category</label><input id=\"f-category\" list=\"catlist\" placeholder=\"Supplies\"><datalist id=\"catlist\"></datalist></div>\n          <div><label for=\"f-owner\">For / Assigned to</label><select id=\"f-owner\" class=\"ownerSelect\"></select></div>\n          <div><label for=\"f-qty\">Qty on hand</label><input id=\"f-qty\" type=\"number\" min=\"0\" step=\"1\" value=\"1\"></div>\n          <div><label for=\"f-price\">Unit price ($)</label><input id=\"f-price\" type=\"number\" min=\"0\" step=\"0.01\" placeholder=\"0.00\"></div>\n          <div><label for=\"f-reorder\">Reorder at qty (optional)</label><input id=\"f-reorder\" type=\"number\" min=\"0\" step=\"1\" placeholder=\"e.g. 2\"></div>\n          <div class=\"full\"><label for=\"f-notes\">Notes (optional)</label><input id=\"f-notes\" placeholder=\"Vendor, size, link, etc.\"></div>\n        </div>\n        <div class=\"formactions\">\n          <button class=\"btn btn-primary\" onclick=\"submitItem()\" id=\"itemFormBtn\">Add item</button>\n          <button class=\"btn btn-link hidden\" id=\"itemFormCancel\" onclick=\"cancelEdit()\">Cancel edit</button>\n        </div>\n      </div>\n      <div class=\"toolbar\">\n        <input type=\"search\" id=\"searchBox\" placeholder=\"Search items\u2026\" oninput=\"renderInventory()\">\n        <select id=\"filterOwner\" onchange=\"renderInventory()\"></select>\n        <select id=\"filterCat\" onchange=\"renderInventory()\"><option value=\"\">All categories</option></select>\n        <span style=\"flex:1\"></span>\n        <button class=\"btn btn-white btn-sm\" onclick=\"exportInventoryCSV()\">Export CSV</button>\n      </div>\n      <div class=\"tablewrap\">\n        <table>\n          <thead><tr><th>Item</th><th>Category</th><th>For</th><th class=\"num\">Qty</th><th class=\"num\">Unit $</th><th class=\"num\">Total $</th><th>Paid</th><th>Actions</th></tr></thead>\n          <tbody id=\"invBody\"></tbody>\n        </table>\n      </div>\n    </div>\n\n    <!-- ordering -->\n    <div class=\"sub hidden\" id=\"sub-ordering\">\n      <div class=\"card\">\n        <div class=\"cardhead\"><h2>Request an order</h2><span class=\"muted\">Jacob gets an email as soon as you submit.</span></div>\n        <div class=\"formgrid\">\n          <div class=\"span2\"><label for=\"o-item\">Item (pick existing or type a new one)</label><input id=\"o-item\" list=\"itemlist\" placeholder=\"Item name\" onkeydown=\"if(event.key==='Enter')submitOrder()\"><datalist id=\"itemlist\"></datalist></div>\n          <div><label for=\"o-qty\">Qty needed</label><input id=\"o-qty\" type=\"number\" min=\"1\" step=\"1\" value=\"1\"></div>\n          <div><label for=\"o-assign\">Provider / Assign to *</label>\n            <select id=\"o-assign\"><option value=\"\">Select\u2026</option></select></div>\n          <div class=\"full\"><label for=\"o-note\">Note (optional)</label><input id=\"o-note\" placeholder=\"Brand, size, urgency\u2026\" onkeydown=\"if(event.key==='Enter')submitOrder()\"></div>\n        </div>\n        <div class=\"formactions\">\n          <button class=\"btn btn-flag\" onclick=\"submitOrder()\" id=\"orderBtn\">Submit order</button>\n          <span class=\"muted\" id=\"orderByHint\"></span>\n        </div>\n      </div>\n      <div class=\"section-title\"><h2>Order queue</h2></div>\n      <div id=\"orderList\"></div>\n    </div>\n\n    <!-- monthly -->\n    <div class=\"sub hidden\" id=\"sub-monthly\">\n      <div class=\"card\">\n        <div class=\"cardhead\">\n          <h2>Ordered by month</h2>\n          <div class=\"toolbar\" style=\"margin:0\">\n            <select id=\"monthPick\" onchange=\"renderMonthly()\"></select>\n            <button class=\"btn btn-white btn-sm\" onclick=\"exportMonthCSV()\">Export month CSV</button>\n          </div>\n        </div>\n        <p class=\"muted\">Every order is saved here by the month it was marked <strong>Ordered</strong>. Pick any past month to look back.</p>\n        <div class=\"moneygrid\" id=\"monthMoney\"></div>\n        <div id=\"monthSummary\" class=\"muted\" style=\"margin-top:12px\"></div>\n      </div>\n      <div class=\"tablewrap\">\n        <table>\n          <thead><tr><th>Ordered</th><th>Item</th><th class=\"num\">Qty</th><th>For</th><th>Requested by</th><th class=\"num\">Unit $</th><th class=\"num\">Total $</th><th>Status</th></tr></thead>\n          <tbody id=\"monthBody\"></tbody>\n        </table>\n      </div>\n    </div>\n\n    <!-- balances -->\n    <div class=\"sub hidden\" id=\"sub-balances\">\n      <div class=\"balgrid\" id=\"balCards\"></div>\n      <div class=\"section-title\"><h2>Unpaid items by person</h2></div>\n      <div class=\"tablewrap\">\n        <table>\n          <thead><tr><th>For</th><th>Item</th><th class=\"num\">Qty</th><th class=\"num\">Unit $</th><th class=\"num\">Owes $</th><th></th></tr></thead>\n          <tbody id=\"balBody\"></tbody>\n        </table>\n      </div>\n    </div>\n  </section>\n\n  <!-- ================= CLIA QC ================= -->\n  <section id=\"tab-qc\" class=\"tab\">\n    <div class=\"card\">\n      <div class=\"cardhead\"><h2>Log a QC check</h2><span class=\"muted\">Records are kept at least 2 years and can't be deleted.</span></div>\n      <div class=\"formgrid\">\n        <div class=\"span2\"><label for=\"q-test\">Test / kit</label><input id=\"q-test\" list=\"qctestlist\" placeholder=\"e.g. Strep A\"><datalist id=\"qctestlist\"></datalist></div>\n        <div><label for=\"q-lot\">Lot #</label><input id=\"q-lot\" placeholder=\"Lot number\"></div>\n        <div><label for=\"q-exp\">Expiration</label><input id=\"q-exp\" type=\"date\"></div>\n        <div class=\"span2\"><label for=\"q-reason\">Reason</label>\n          <select id=\"q-reason\">\n            <option>New box opened</option>\n            <option>New lot / shipment received</option>\n            <option>Monthly QC</option>\n            <option>New staff / operator</option>\n            <option>Troubleshooting / repeat</option>\n            <option>Other</option>\n          </select></div>\n        <div><label>Positive control</label><div class=\"seg\" data-qc=\"pos\"></div></div>\n        <div><label>Negative control</label><div class=\"seg\" data-qc=\"neg\"></div></div>\n        <div class=\"full\"><label for=\"q-notes\">Notes (optional)</label><input id=\"q-notes\" placeholder=\"Anything unusual, corrective action, etc.\"></div>\n      </div>\n      <div class=\"formactions\">\n        <button class=\"btn btn-primary\" onclick=\"submitQC()\" id=\"qcBtn\">Save QC entry</button>\n        <span class=\"muted\" id=\"qcByHint\"></span>\n      </div>\n    </div>\n\n    <div class=\"section-title\">\n      <h2>QC log</h2>\n      <div class=\"toolbar\" style=\"margin:0\">\n        <input type=\"search\" id=\"qcSearch\" placeholder=\"Search test or lot\u2026\" oninput=\"renderQC()\">\n        <select id=\"qcMonth\" onchange=\"renderQC()\"></select>\n        <button class=\"btn btn-white btn-sm\" onclick=\"exportQCCSV()\">Export CSV</button>\n      </div>\n    </div>\n    <div class=\"tablewrap\">\n      <table>\n        <thead><tr><th>Date / time</th><th>Test</th><th>Lot</th><th>Exp.</th><th>Reason</th><th>Pos</th><th>Neg</th><th>Result</th><th>By</th><th>Notes</th><th></th></tr></thead>\n        <tbody id=\"qcBody\"></tbody>\n      </table>\n    </div>\n  </section>\n\n  <!-- ================= NDC / LOT ================= -->\n  <section id=\"tab-meds\" class=\"tab\">\n    <div class=\"alertbar hidden\" id=\"medAlert\"><span>\u26a0 <span id=\"medAlertText\"></span></span>\n      <button class=\"btn btn-flag btn-sm\" onclick=\"setMedFilter('soon')\">Show them</button></div>\n    <div class=\"card\">\n      <div class=\"cardhead\"><h2 id=\"medFormTitle\">Add a medication</h2><span class=\"muted\">Medication, NDC, lot number, and expiration date</span></div>\n      <div class=\"formgrid\">\n        <div class=\"span2\"><label for=\"m-name\">Medication</label><input id=\"m-name\" list=\"medNameList\" placeholder=\"e.g. Ceftriaxone 1 g vial\"><datalist id=\"medNameList\"></datalist></div>\n        <div><label for=\"m-ndc\">NDC</label><input id=\"m-ndc\" inputmode=\"numeric\" placeholder=\"0409-4888-02\"></div>\n        <div><label for=\"m-lot\">Lot #</label><input id=\"m-lot\" placeholder=\"Lot number\"></div>\n        <div><label for=\"m-exp\">Expiration</label><input id=\"m-exp\" type=\"date\"></div>\n        <div><label for=\"m-qty\">Qty on hand (optional)</label><input id=\"m-qty\" type=\"number\" min=\"0\" step=\"1\" placeholder=\"\u2014\"></div>\n        <div><label for=\"m-loc\">Location (optional)</label><input id=\"m-loc\" list=\"medLocList\" placeholder=\"Med fridge, cabinet B\u2026\"><datalist id=\"medLocList\"></datalist></div>\n        <div class=\"full\"><label for=\"m-notes\">Notes (optional)</label><input id=\"m-notes\" placeholder=\"Manufacturer, concentration, multi-dose opened date\u2026\"></div>\n      </div>\n      <div class=\"formactions\">\n        <button class=\"btn btn-primary\" onclick=\"submitMed()\" id=\"medBtn\">Add to list</button>\n        <button class=\"btn btn-link hidden\" id=\"medCancel\" onclick=\"cancelMedEdit()\">Cancel edit</button>\n      </div>\n    </div>\n\n    <div class=\"section-title\">\n      <h2>NDC / Lot list</h2>\n      <div class=\"toolbar\" style=\"margin:0\">\n        <input type=\"search\" id=\"medSearch\" placeholder=\"Search name, NDC or lot\u2026\" oninput=\"renderMeds()\">\n        <select id=\"medFilter\" onchange=\"renderMeds()\">\n          <option value=\"\">All</option>\n          <option value=\"soon\">Expired or expiring in 60 days</option>\n          <option value=\"expired\">Expired only</option>\n        </select>\n        <button class=\"btn btn-white btn-sm\" onclick=\"exportMedsCSV()\">Export CSV</button>\n      </div>\n    </div>\n    <div class=\"tablewrap\">\n      <table>\n        <thead><tr><th>Medication</th><th>NDC</th><th>Lot</th><th>Expiration</th><th>Status</th><th class=\"num\">Qty</th><th>Location</th><th>Added</th><th></th></tr></thead>\n        <tbody id=\"medBody\"></tbody>\n      </table>\n    </div>\n  </section>\n\n  <!-- ================= ADMIN ================= -->\n  <section id=\"tab-notes\" class=\"tab\">\n    <div class=\"card\">\n      <div class=\"cardhead\"><h2>Post a sticky note</h2><span class=\"muted\">The person gets an email and a red flag when they sign in</span></div>\n      <div class=\"formgrid\">\n        <div class=\"span2\"><label for=\"n-text\">Note</label><textarea id=\"n-text\" rows=\"3\" maxlength=\"1000\" placeholder=\"e.g. Can you order more exam table paper?\"></textarea></div>\n        <div class=\"span2\"><label>Put it on whose wall? <span class=\"muted\" style=\"font-weight:400\">\u2014 pick one or more</span></label><div class=\"wallpick\" id=\"n-walls\"></div></div>\n        <div><label>Color</label><div class=\"colorpick\" id=\"n-colors\"></div></div>\n      </div>\n      <div class=\"formactions\"><button class=\"btn btn-primary\" id=\"noteBtn\" onclick=\"addNote()\">Post note</button></div>\n    </div>\n    <div class=\"wallhead\"><h2 id=\"wallTitle\" style=\"margin:0\">My wall</h2><div class=\"walltabs\" id=\"wallTabs\"></div></div>\n    <div class=\"muted\" id=\"wallHint\" style=\"margin:-6px 0 14px\"></div>\n    <div class=\"notegrid\" id=\"noteGrid\"></div>\n  </section>\n\n  <section id=\"tab-admin\" class=\"tab\">\n    <div class=\"card\">\n      <div class=\"cardhead\"><h2>Accounts</h2><span class=\"muted\">Only people with an account can open the hub.</span></div>\n      <div class=\"tablewrap\" style=\"box-shadow:none;margin-bottom:16px\">\n        <table>\n          <thead><tr><th>Name</th><th>Username</th><th>Email</th><th>Role</th><th></th></tr></thead>\n          <tbody id=\"usersBody\"></tbody>\n        </table>\n      </div>\n      <h3 style=\"font-size:14.5px;margin-bottom:10px\">Add an account</h3>\n      <div class=\"formgrid\">\n        <div><label for=\"u-name\">Name</label><input id=\"u-name\" placeholder=\"Erica\"></div>\n        <div><label for=\"u-user\">Username</label><input id=\"u-user\" autocapitalize=\"none\" placeholder=\"erica\"></div>\n        <div class=\"span2\"><label for=\"u-email\">Email (for daily cleaning emails)</label><input id=\"u-email\" type=\"email\" placeholder=\"name@alignedhealthmurray.com\"></div>\n        <div><label for=\"u-role\">Role</label><select id=\"u-role\"><option value=\"staff\">Staff</option><option value=\"admin\">Admin</option></select></div>\n        <div><label for=\"u-pass\">Temporary password</label><input id=\"u-pass\" placeholder=\"6+ characters\" autocomplete=\"new-password\"></div>\n      </div>\n      <div class=\"formactions\"><button class=\"btn btn-primary\" onclick=\"addUser()\">Add account</button></div>\n    </div>\n\n    <div class=\"card\">\n      <div class=\"cardhead\">\n        <h2>Cleaning schedule</h2>\n        <button class=\"btn btn-primary\" onclick=\"saveSchedule()\">Save schedule</button>\n      </div>\n      <p class=\"muted\" style=\"margin-bottom:8px\">This is the <strong>Week A</strong> schedule. Put a person next to each task. Names match staff accounts by first name or username (e.g. \"Dianne\"). Type <strong>Team</strong> for a job both people that day share (like Trash). Each person gets an email that morning with their tasks. Only admins can change this.</p>\n      <label style=\"display:flex;gap:8px;align-items:center;margin-bottom:12px;font-weight:600;text-transform:none;letter-spacing:0;font-size:14px\"><input type=\"checkbox\" id=\"rotateWeekly\" style=\"width:auto\"> Swap jobs every other week (Week B) so everyone gets a turn</label>\n      <div class=\"weekgrid\" id=\"schedEditor\"></div>\n    </div>\n\n    <div class=\"admingrid\">\n      <div class=\"card\">\n        <div class=\"cardhead\"><h2>Emails</h2><span id=\"trigPill\"></span></div>\n        <div class=\"formgrid\">\n          <div class=\"full\"><label for=\"set-email\">Send alerts to</label><input id=\"set-email\" type=\"email\"></div>\n          <div><label for=\"set-morning\">Morning reminder</label><select id=\"set-morning\" class=\"hourSelect\"></select></div>\n          <div><label for=\"set-check\">\"Not done\" check</label><select id=\"set-check\" class=\"hourSelect\"></select></div>\n          <div><label for=\"set-start\">Cleaning starts on</label><input id=\"set-start\" type=\"date\"></div>\n        </div>\n        <div class=\"formactions\"><button class=\"btn btn-primary\" onclick=\"saveEmailSettings()\">Save</button>\n          <button class=\"btn btn-white\" onclick=\"testEmail()\">Send test email</button></div>\n        <p class=\"muted\" style=\"margin-top:12px\">You get an email when: an order is requested \u00b7 someone does a task on a day they're not assigned (with their reason) \u00b7 tasks aren't done by the check time \u00b7 a QC check fails.</p>\n      </div>\n\n      <div class=\"card\">\n        <div class=\"cardhead\"><h2>Email sending</h2><span id=\"emailPill\"></span></div>\n        <p class=\"muted\" style=\"margin-bottom:12px\">Emails go out through <strong>Resend</strong> (free). Make an account at resend.com, create an API key, and paste it here. Until then, every alert is still saved in the log below.</p>\n        <div class=\"formgrid\">\n          <div class=\"full\"><label for=\"em-key\">Resend API key</label><input id=\"em-key\" autocomplete=\"off\" placeholder=\"re_\u2026\"></div>\n          <div class=\"full\"><label for=\"em-from\">From address (after you verify your domain in Resend)</label><input id=\"em-from\" placeholder=\"Clinic Hub &lt;hub@alignedhealthmurray.com&gt;\"></div>\n        </div>\n        <div class=\"formactions\"><button class=\"btn btn-primary\" onclick=\"saveEmailCfg()\">Save email setup</button></div>\n        <h3 style=\"font-size:14px;margin:16px 0 8px\">Recent emails</h3>\n        <div id=\"emailLog\" class=\"muted\"></div>\n      </div>\n\n      <div class=\"card\">\n        <div class=\"cardhead\"><h2>CLIA QC test list</h2><button class=\"btn btn-primary btn-sm\" onclick=\"saveQcTests()\">Save</button></div>\n        <label for=\"set-qctests\">Tests shown in the QC dropdown (one per line)</label>\n        <textarea id=\"set-qctests\" style=\"min-height:170px\"></textarea>\n      </div>\n\n      <div class=\"card\">\n        <div class=\"cardhead\"><h2>Import from old Aligned Inventory</h2></div>\n        <p class=\"muted\" style=\"margin-bottom:10px\">Do this once. Paste the link from your \u201cAligned Inventory\u201d Chrome bookmark.</p>\n        <label for=\"imp-url\">Old app link</label>\n        <input id=\"imp-url\" placeholder=\"https://script.google.com/macros/s/\u2026/exec\">\n        <details style=\"margin-top:10px\"><summary class=\"muted\" style=\"cursor:pointer\">Or paste exported JSON instead</summary>\n          <textarea id=\"imp-json\" style=\"margin-top:8px\" placeholder='{\"items\":[\u2026],\"orders\":[\u2026]}'></textarea>\n        </details>\n        <label class=\"check\" style=\"margin-top:10px\"><input type=\"checkbox\" id=\"imp-force\"> Import anyway (adds on top of current items)</label>\n        <div class=\"formactions\"><button class=\"btn btn-primary\" onclick=\"importOld()\">Import</button></div>\n      </div>\n\n      <div class=\"card\">\n        <div class=\"cardhead\"><h2>Backup</h2></div>\n        <p class=\"muted\" style=\"margin-bottom:12px\">Everything is stored in your Cloudflare account. Download a full copy any time for your records.</p>\n        <div class=\"formactions\" style=\"margin-top:0\"><button class=\"btn btn-white\" onclick=\"downloadBackup()\">Download full backup</button></div>\n      </div>\n    </div>\n  </section>\n</main>\n</div>\n\n<!-- modal + toast -->\n<div id=\"modalRoot\"></div>\n<div class=\"toast\" id=\"toast\"></div>\n\n<script>\n/* ============================================================\n   ALIGNED CLINIC HUB \u2014 PAGE LOGIC\n   ============================================================ */\nconst $ = id => document.getElementById(id);\nconst DAYS = ['Mon','Tue','Wed','Thu','Fri'];\nconst DAY_NAMES = {Mon:'Monday',Tue:'Tuesday',Wed:'Wednesday',Thu:'Thursday',Fri:'Friday'};\nconst money = n => '$' + (Number(n)||0).toFixed(2);\nconst esc = s => String(s ?? '').replace(/[&<>\"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','\"':'&quot;',\"'\":'&#39;'}[c]));\n\nlet TOKEN = null;\nlet D = null;                  // everything from the server\nconst ui = { tab:'cleaning', sub:'inventory', day:null, editingId:null, qcPos:'', qcNeg:'', history:[] };\n\n/* ---------- token storage (per browser) ---------- */\nfunction loadToken(){ try { return localStorage.getItem('hub_token'); } catch(e){ return null; } }\nfunction saveToken(t){ try { t ? localStorage.setItem('hub_token', t) : localStorage.removeItem('hub_token'); } catch(e){} }\nfunction loadPref(k, d){ try { return localStorage.getItem('hub_'+k) || d; } catch(e){ return d; } }\nfunction savePref(k, v){ try { localStorage.setItem('hub_'+k, v); } catch(e){} }\n\n/* ---------- server calls ---------- */\nlet busy = 0;\nfunction setBusy(delta){\n  busy = Math.max(0, busy + delta);\n  const el = $('loading');\n  if(busy){ el.classList.add('on'); } else { el.classList.remove('on'); el.style.width='100%'; setTimeout(()=>{ el.style.width=''; }, 250); }\n}\nfunction run(fn, ...args){\n  return new Promise((resolve, reject) => {\n    setBusy(1);\n    google.script.run\n      .withSuccessHandler(r => { setBusy(-1); if(r && r.ok) resolve(r.data); else reject(Object.assign(new Error((r && r.message) || 'Something went wrong.'), { code: r && r.error })); })\n      .withFailureHandler(e => { setBusy(-1); reject(new Error('Could not reach the server. Check your internet and try again.')); })\n      [fn](...args);\n  });\n}\nasync function call(action, payload){\n  try {\n    return await run('api', TOKEN, action, payload || {});\n  } catch(e){\n    if(e.code === 'auth'){ saveToken(null); TOKEN = null; showAuth(); toast('Please sign in again.', true); }\n    throw e;\n  }\n}\nasync function act(action, payload, okMsg){\n  try {\n    const res = await call(action, payload);\n    if(okMsg) toast(okMsg);\n    return res;\n  } catch(e){\n    if(e.code !== 'auth') toast(e.message, true);\n    return null;\n  }\n}\n\n/* ---------- toast + modal ---------- */\nlet toastTimer;\nfunction toast(msg, bad){\n  const t = $('toast'); t.textContent = msg; t.classList.toggle('bad', !!bad); t.classList.add('show');\n  clearTimeout(toastTimer); toastTimer = setTimeout(() => t.classList.remove('show'), bad ? 5000 : 2600);\n}\nlet modalOpen = false;\nfunction ask(opts){\n  return new Promise(resolve => {\n    modalOpen = true;\n    const fields = opts.fields || [];\n    const root = $('modalRoot');\n    root.innerHTML = '<div class=\"modal-bg\"><div class=\"modal\" role=\"dialog\" aria-modal=\"true\">'\n      + '<h3>' + esc(opts.title || '') + '</h3>'\n      + (opts.message ? '<div class=\"msg\">' + esc(opts.message) + '</div>' : '')\n      + fields.map((f,i) => '<div class=\"field\"><label for=\"mf'+i+'\">'+esc(f.label)+'</label>'\n          + (f.type === 'textarea'\n              ? '<textarea id=\"mf'+i+'\" placeholder=\"'+esc(f.placeholder||'')+'\">'+esc(f.value||'')+'</textarea>'\n              : f.type === 'select'\n                ? '<select id=\"mf'+i+'\">' + f.options.map(o => '<option value=\"'+esc(o.value)+'\"'+(o.value===f.value?' selected':'')+'>'+esc(o.label)+'</option>').join('') + '</select>'\n                : '<input id=\"mf'+i+'\" type=\"'+(f.type||'text')+'\" value=\"'+esc(f.value ?? '')+'\" placeholder=\"'+esc(f.placeholder||'')+'\"'+(f.type==='number'?' step=\"'+(f.step||'1')+'\" min=\"0\"':'')+'>')\n          + '</div>').join('')\n      + '<div class=\"err\" id=\"modalErr\" style=\"text-align:left\"></div>'\n      + '<div class=\"acts\">'\n      + (opts.noCancel ? '' : '<button class=\"btn btn-white\" id=\"mCancel\">Cancel</button>')\n      + '<button class=\"btn '+(opts.danger ? 'btn-flag' : 'btn-primary')+'\" id=\"mOk\">'+esc(opts.okText || 'OK')+'</button>'\n      + '</div></div></div>';\n    const close = val => { root.innerHTML = ''; modalOpen = false; resolve(val); };\n    const ok = () => {\n      const out = {};\n      for(let i=0;i<fields.length;i++){\n        const v = $('mf'+i).value.trim();\n        if(fields[i].required && v.length < (fields[i].min || 1)){\n          $('modalErr').textContent = fields[i].requiredMsg || ('Please fill in: ' + fields[i].label);\n          $('mf'+i).focus(); return;\n        }\n        out[fields[i].id] = v;\n      }\n      close(out);\n    };\n    $('mOk').onclick = ok;\n    if($('mCancel')) $('mCancel').onclick = () => close(null);\n    root.querySelector('.modal-bg').addEventListener('click', e => { if(e.target.classList.contains('modal-bg') && !opts.noCancel) close(null); });\n    root.querySelector('.modal').addEventListener('keydown', e => {\n      if(e.key === 'Escape' && !opts.noCancel) close(null);\n      if(e.key === 'Enter' && e.target.tagName === 'INPUT') { e.preventDefault(); ok(); }\n    });\n    setTimeout(() => { const f = $('mf0') || $('mOk'); f && f.focus(); }, 30);\n  });\n}\nconst confirmBox = (title, message, okText, danger) => ask({ title, message, okText: okText || 'OK', danger }).then(r => r !== null);\n\n/* ---------- dates ---------- */\nconst parseYmd = s => { const [y,m,d] = String(s).split('-').map(Number); return new Date(y, m-1, d, 12); };\nconst fmtTime = iso => iso ? new Date(iso).toLocaleTimeString([], {hour:'numeric', minute:'2-digit'}) : '';\nconst fmtDate = iso => iso ? new Date(iso).toLocaleDateString([], {month:'short', day:'numeric', year:'numeric'}) : '';\nconst fmtDateTime = iso => iso ? fmtDate(iso) + ' ' + fmtTime(iso) : '';\nconst fmtYmd = s => s ? parseYmd(s).toLocaleDateString([], {month:'short', day:'numeric'}) : '';\nconst fmtYmdLong = s => s ? parseYmd(s).toLocaleDateString([], {weekday:'long', month:'long', day:'numeric'}) : '';\nconst monthKey = iso => { if(!iso) return ''; const d = new Date(iso); return isNaN(d) ? '' : d.getFullYear() + '-' + String(d.getMonth()+1).padStart(2,'0'); };\nconst monthLabel = k => { if(!/^\\d{4}-\\d{2}$/.test(k||'')) return k||''; const [y,m] = k.split('-').map(Number); return new Date(y, m-1, 1).toLocaleString([], {month:'long', year:'numeric'}); };\nconst thisMonth = () => monthKey(new Date().toISOString());\n\n/* =========================================================\n   AUTH\n   ========================================================= */\nfunction showAuth(){ $('screen-app').classList.add('hidden'); $('screen-auth').classList.remove('hidden'); }\nfunction showApp(){ $('screen-auth').classList.add('hidden'); $('screen-app').classList.remove('hidden'); }\n\n$('loginForm').addEventListener('submit', async e => {\n  e.preventDefault();\n  $('loginErr').textContent = ''; $('loginBtn').disabled = true;\n  try {\n    const r = await run('login', $('l-user').value, $('l-pass').value);\n    TOKEN = r.token; saveToken(TOKEN); $('l-pass').value = '';\n    await boot();\n  } catch(err){ $('loginErr').textContent = err.message; }\n  $('loginBtn').disabled = false;\n});\n\n$('setupForm').addEventListener('submit', async e => {\n  e.preventDefault();\n  $('setupErr').textContent = ''; $('setupBtn').disabled = true;\n  try {\n    const r = await run('setupAdmin', $('s-code').value, { name:$('s-name').value, username:$('s-user').value, email:$('s-email').value, password:$('s-pass').value });\n    TOKEN = r.token; saveToken(TOKEN);\n    await boot();\n    toast('Welcome! Add your staff in the Admin tab.');\n    showTab('admin');\n  } catch(err){ $('setupErr').textContent = err.message; }\n  $('setupBtn').disabled = false;\n});\n\nasync function signOut(){\n  const t = TOKEN; TOKEN = null; saveToken(null); D = null; $('toast').classList.remove('show');\n  try { await run('logout', t); } catch(e){}\n  $('loginForm').classList.remove('hidden'); $('setupForm').classList.add('hidden');\n  $('authLead').textContent = 'Sign in to continue';\n  showAuth();\n}\n\nasync function changeMyPassword(){\n  const r = await ask({ title:'Change your password', okText:'Change password', fields:[\n    { id:'current', label:'Current password', type:'password', required:true },\n    { id:'next', label:'New password (6+ characters)', type:'password', required:true, min:6, requiredMsg:'New password must be at least 6 characters.' }\n  ]});\n  if(!r) return;\n  await act('changePassword', r, 'Password changed.');\n}\n\n/* =========================================================\n   BOOT + REFRESH\n   ========================================================= */\nasync function start(){\n  TOKEN = loadToken();\n  if(TOKEN){\n    try { await boot(); return; } catch(e){ /* fall through to sign in */ }\n  }\n  try {\n    const st = await run('appStatus');\n    if(st.needsSetup){\n      $('loginForm').classList.add('hidden'); $('setupForm').classList.remove('hidden');\n      $('authLead').textContent = 'First-time setup \u2014 create the admin account';\n    }\n  } catch(e){ $('loginErr').textContent = e.message; }\n  showAuth();\n}\n\nasync function boot(){\n  D = await call('bootstrap');\n  showApp();\n  const me = D.me;\n  $('meName').textContent = me.name;\n  $('meRole').textContent = me.role === 'admin' ? 'Admin' : 'Staff';\n  $('meAvatar').textContent = (me.name || '?').trim().charAt(0).toUpperCase();\n  $('adminNavBtn').classList.toggle('hidden', me.role !== 'admin');\n  $('orderByHint').textContent = 'Requested by: ' + me.name;\n  $('qcByHint').textContent = 'Logged by: ' + me.name + ' \u00b7 time stamped automatically';\n  if(!ui.day) ui.day = D.todayKey || 'Fri';\n  setupStaticSelects();\n  if(!$('histMonth').value) $('histMonth').value = thisMonth();\n  renderAll();\n  if(me.role === 'admin') renderAdmin();\n  loadHistory();\n  const lastTab = loadPref('tab', 'cleaning');\n  showTab(lastTab === 'admin' && me.role !== 'admin' ? 'cleaning' : lastTab, true);\n  showSub(loadPref('sub', 'inventory'));\n}\n\nasync function refresh(){\n  if(!TOKEN || !D || modalOpen || document.hidden || ui.editingId || medEditingId) return;\n  if(document.activeElement && document.activeElement.id === 'n-text') return;\n  try {\n    const fresh = await run('api', TOKEN, 'bootstrap', {});\n    const keepAdmin = D.settings;\n    D = fresh; if(!D.settings) D.settings = keepAdmin;\n    renderAll();\n  } catch(e){ if(e.code === 'auth'){ saveToken(null); TOKEN = null; showAuth(); } }\n}\nsetInterval(refresh, 45000);\ndocument.addEventListener('visibilitychange', () => { if(!document.hidden) refresh(); });\n\nfunction renderAll(){\n  renderCleaning();\n  renderSupplies();\n  renderQC();\n  renderMeds();\n  renderNotes();\n}\n\n/* =========================================================\n   STICKY NOTES\n   ========================================================= */\nconst NOTE_COLORS = { yellow:'#FFF4A8', pink:'#FFD6E3', blue:'#D3EAFF', green:'#D6F5D6', nyellow:'#FAFF00', npink:'#FF5CC8', ngreen:'#39FF88', norange:'#FF9F1C', nblue:'#2EE6FF', npurple:'#C77DFF', nred:'#FF4D6D', nlime:'#C6FF1A' };\nlet noteColor = 'yellow';\nconst noteArchived = n => !!(n.done || n.deleted);\nconst noteKey = n => n.groupId || n.id;\nconst noteWalls = n => n.walls ? String(n.walls).split(',') : [n.wall];\nfunction myNewNotes(){ return (D.notes || []).filter(n => n.wall === D.me.username && !noteArchived(n) && !n.seenAt); }\nfunction pickWall(v){ ui.noteView = v; renderNotes(); if(v === 'mine' && ui.tab === 'notes') markNotesSeen(); }\nlet seenTimer = null;\nfunction markNotesSeen(){\n  if(!myNewNotes().length) return;\n  clearTimeout(seenTimer);\n  seenTimer = setTimeout(async () => { try { const r = await call('noteSeen', {}); if(r){ applyNotes(r); } } catch(e){} }, 4000);\n}\nfunction applyNotes(r){ if(!r) return; D.notes = r.notes; D.noteComments = r.noteComments || []; if(ui.tab === 'notes') renderNotes(); else renderNotesBadges(); }\nfunction renderNotesBadges(){\n  const fresh = myNewNotes().length;\n  $('noteBadge').textContent = fresh; $('noteBadge').classList.toggle('zero', fresh === 0);\n  $('noteBar').classList.toggle('hidden', fresh === 0 || ui.tab === 'notes');\n  $('noteBarText').textContent = 'You have ' + fresh + ' new sticky note' + (fresh === 1 ? '' : 's') + ' (or comments) on your wall';\n}\n/** one card per note, even if it was posted to several walls */\nfunction dedupe(list){ const seen = {}; return list.filter(n => { const k = noteKey(n); if(seen[k]) return false; seen[k] = 1; return true; }); }\nfunction renderNotes(){\n  if(!D) return;\n  const me = D.me.username, admin = D.me.role === 'admin';\n  const users = (D.users || []).slice().sort((a,b) => a.username === me ? -1 : b.username === me ? 1 : a.name.localeCompare(b.name));\n  const notes = D.notes || [];\n  if(!['mine','sent','all','archive'].includes(ui.noteView) || (ui.noteView === 'all' && !admin)) ui.noteView = 'mine';\n  const mineList = notes.filter(n => n.wall === me && !noteArchived(n));\n  const sentList = dedupe(notes.filter(n => n.fromUser === me && !noteArchived(n) && noteWalls(n).some(w => w !== me)));\n  const archList = dedupe(notes.filter(noteArchived));\n  const allOpen = notes.filter(n => !noteArchived(n));\n  if(ui.allWall && !users.find(u => u.username === ui.allWall)) ui.allWall = '';\n  const allList = ui.allWall ? allOpen.filter(n => n.wall === ui.allWall) : dedupe(allOpen);\n  const newCount = myNewNotes().length;\n  const tab = (v, label, cnt, red) => '<button class=\"' + (ui.noteView === v ? 'on' : '') + '\" onclick=\"pickWall(\\'' + v + '\\')\">' + label + (cnt ? '<span class=\"cnt\"' + (red ? ' style=\"background:var(--flag);color:#fff\"' : '') + '>' + cnt + '</span>' : '') + '</button>';\n  $('wallTabs').innerHTML = tab('mine', 'My wall', newCount || mineList.length, !!newCount) + tab('sent', 'Notes I left', sentList.length)\n    + (admin ? tab('all', 'All walls (admin)', dedupe(allOpen).length) : '') + tab('archive', 'Archive', 0);\n  $('wallTitle').textContent = ui.noteView === 'mine' ? 'My wall' : ui.noteView === 'sent' ? 'Notes I left for others' : ui.noteView === 'all' ? 'All walls' : 'Archive';\n  $('wallHint').innerHTML = ui.noteView === 'all'\n    ? 'Every open note on every wall. Show: <select onchange=\"ui.allWall=this.value; renderNotes()\" style=\"display:inline-block;width:auto;padding:4px 8px\">'\n      + '<option value=\"\">Everyone</option>' + users.map(u => '<option value=\"' + esc(u.username) + '\"' + (ui.allWall === u.username ? ' selected' : '') + '>' + esc(u.name) + '\\'s wall</option>').join('') + '</select>'\n    : esc(ui.noteView === 'mine' ? 'Only you, whoever wrote each note, and admins can see these.'\n    : ui.noteView === 'sent' ? 'Notes you posted on other people\\'s walls. You can add to them or comment.'\n    : admin ? 'Completed and deleted notes from everyone. Only admins can reopen or permanently remove them.'\n            : 'Completed and deleted notes you were part of. These can\\'t be changed. Ask an admin if something needs to be reopened.');\n  // post form\n  if(!ui.noteWalls) ui.noteWalls = [me];\n  ui.noteWalls = ui.noteWalls.filter(w => users.find(u => u.username === w));\n  $('n-walls').innerHTML = users.map(u => { const on = ui.noteWalls.includes(u.username);\n      return '<label class=\"' + (on ? 'on' : '') + '\"><input type=\"checkbox\" ' + (on ? 'checked' : '') + ' onchange=\"toggleNoteWall(\\'' + esc(u.username) + '\\', this.checked)\">' + (u.username === me ? 'Me' : esc(u.name)) + '</label>'; }).join('')\n    + '<button type=\"button\" class=\"allbtn\" onclick=\"allNoteWalls()\">' + (ui.noteWalls.length === users.length ? 'Clear' : 'Everyone') + '</button>';\n  $('n-colors').innerHTML = Object.keys(NOTE_COLORS).map(c => '<button type=\"button\" title=\"' + (c[0] === 'n' ? 'Neon ' + c.slice(1) : c) + '\" class=\"' + (c === noteColor ? 'on' : '') + '\" style=\"background:' + NOTE_COLORS[c] + '\" onclick=\"noteColor=\\'' + c + '\\'; renderNotes()\"></button>').join('');\n  // cards\n  const nameOf = u => u === me ? 'You' : userName(u);\n  const comments = D.noteComments || [];\n  const card = n => {\n    const arch = noteArchived(n);\n    const canClose = !arch && (admin || n.fromUser === me || noteWalls(n).includes(me));\n    const isNew = ui.noteView === 'mine' && n.wall === me && !n.seenAt && !arch;\n    const all = comments.filter(c => c.noteKey === noteKey(n)).sort((a,b) => a.at < b.at ? -1 : 1);\n    const adds = all.filter(c => c.kind === 'addition'), cs = all.filter(c => c.kind !== 'addition');\n    const id = esc(n.id);\n    let acts = '';\n    if(!arch){\n      acts = '<button onclick=\"noteDone(\\'' + id + '\\', true)\">\u2713 Done</button>'\n        + '<button onclick=\"noteComment(\\'' + id + '\\')\">\ud83d\udcac Comment</button>'\n        + (n.fromUser === me ? '<button onclick=\"noteEdit(\\'' + id + '\\')\">\u270e Add to note</button>' : '')\n        + (canClose ? '<button onclick=\"noteDelete(\\'' + id + '\\')\">Delete</button>' : '');\n    } else if(admin){\n      acts = '<button onclick=\"noteDone(\\'' + id + '\\', false)\">\u21ba Reopen</button><button onclick=\"notePurge(\\'' + id + '\\')\">Remove forever</button>';\n    }\n    return '<div class=\"sticky ' + esc(n.color || 'yellow') + (n.deleted ? ' isdel' : n.done ? ' isdone' : '') + '\">'\n      + (isNew ? '<span class=\"newflag\">NEW</span>' : '')\n      + (arch ? '<div class=\"nstatus ' + (n.deleted ? 'del' : 'ok') + '\">' + (n.deleted ? '\ud83d\uddd1 Deleted by ' + esc(n.deletedBy) + ' \u00b7 ' + esc(fmtDateTime(n.deletedAt)) : '\u2713 Completed by ' + esc(n.doneBy) + ' \u00b7 ' + esc(fmtDateTime(n.doneAt))) + '</div>' : '')\n      + '<div class=\"ntext\">' + esc(n.text) + '</div>'\n      + adds.map(c => '<div class=\"nadd\">+ ' + esc(c.text) + '<small>added ' + esc(fmtDateTime(c.at)) + '</small></div>').join('')\n      + '<div class=\"nmeta\">From <strong>' + esc(n.fromUser === me ? 'You' : n.fromName) + '</strong> \u2192 ' + esc(noteWalls(n).map(nameOf).join(', ')) + '<br>' + esc(fmtDateTime(n.createdAt)) + '</div>'\n      + (cs.length ? '<div class=\"ncomments\">' + cs.map(c => '<div class=\"ncomment\"><strong>' + esc(c.byUser === me ? 'You' : c.byName) + ':</strong> ' + esc(c.text) + '<br><small>' + esc(fmtDateTime(c.at)) + '</small></div>').join('') + '</div>' : '')\n      + (acts ? '<div class=\"nact\">' + acts + '</div>' : '')\n      + '</div>';\n  };\n  let list = ui.noteView === 'mine' ? mineList : ui.noteView === 'sent' ? sentList : ui.noteView === 'all' ? allList : archList;\n  list = list.slice().sort((a,b) => {\n    const ka = ui.noteView === 'archive' ? (a.deletedAt || a.doneAt) : a.createdAt, kb = ui.noteView === 'archive' ? (b.deletedAt || b.doneAt) : b.createdAt;\n    return ka < kb ? 1 : -1; });\n  $('noteGrid').innerHTML = list.length ? list.map(card).join('')\n    : '<div class=\"emptymsg\">' + (ui.noteView === 'mine' ? 'No sticky notes on your wall.' : ui.noteView === 'all' ? 'No open notes.' : ui.noteView === 'sent' ? 'You haven\\'t left any open notes for anyone.' : 'Nothing in the archive yet.') + '</div>';\n  renderNotesBadges();\n}\nasync function addNote(){\n  const text = $('n-text').value.trim();\n  if(!text){ toast('Write something on the sticky note.', true); return; }\n  const walls = (ui.noteWalls || []).slice();\n  if(!walls.length){ toast('Pick at least one wall.', true); return; }\n  const others = walls.filter(w => w !== D.me.username).map(userName);\n  const res = await act('noteAdd', { text, walls, color: noteColor }, others.length ? 'Note posted. ' + others.join(', ') + (others.length === 1 ? ' was' : ' were') + ' emailed.' : 'Note posted.');\n  if(res){ $('n-text').value = ''; ui.noteView = others.length ? 'sent' : 'mine'; applyNotes(res); }\n}\nfunction toggleNoteWall(w, on){\n  ui.noteWalls = (ui.noteWalls || []).filter(x => x !== w);\n  if(on) ui.noteWalls.push(w);\n  renderNotes();\n}\nfunction allNoteWalls(){\n  const all = (D.users || []).map(u => u.username);\n  ui.noteWalls = (ui.noteWalls || []).length === all.length ? [] : all;\n  renderNotes();\n}\nfunction findNote(id){ return (D.notes || []).find(n => n.id === id); }\nasync function noteEdit(id){\n  const n = findNote(id); if(!n) return;\n  const r = await ask({ title:'Add to your note', message:'Your original note stays exactly as written. What you add here shows underneath it, with the time. Everyone on the note gets an email.\\n\\nOriginal: \"' + n.text.slice(0, 200) + (n.text.length > 200 ? '\u2026' : '') + '\"', okText:'Add',\n    fields:[{ id:'text', label:'Add', type:'textarea', placeholder:'e.g. Also need the large size', required:true }] });\n  if(!r) return;\n  applyNotes(await act('noteEdit', { id, text: r.text }, 'Added to your note.'));\n}\nasync function noteComment(id){\n  const n = findNote(id); if(!n) return;\n  const r = await ask({ title:'Add a comment', message:'\"' + n.text.slice(0, 140) + (n.text.length > 140 ? '\u2026' : '') + '\"', okText:'Post comment',\n    fields:[{ id:'text', label:'Comment', type:'textarea', placeholder:'e.g. Ordered \u2014 should be here Friday', required:true }] });\n  if(!r) return;\n  applyNotes(await act('noteComment', { id, text: r.text }, 'Comment added. Everyone on the note was emailed.'));\n}\nasync function noteDone(id, done){\n  if(done && !await confirmBox('Mark this note done?', 'It moves to the archive for everyone on it. Only an admin can reopen it.', 'Mark done')) return;\n  applyNotes(await act('noteDone', { id, done }, done ? 'Done \u2713 \u2014 moved to the archive.' : 'Reopened.'));\n}\nasync function noteDelete(id){\n  if(!await confirmBox('Delete this sticky note?', 'It is removed from every wall and kept in the archive. Only an admin can reopen it.', 'Delete', true)) return;\n  applyNotes(await act('noteDelete', { id }, 'Note deleted \u2014 kept in the archive.'));\n}\nasync function notePurge(id){\n  if(!await confirmBox('Remove forever?', 'This permanently erases the note and its comments from the archive. This cannot be undone.', 'Remove forever', true)) return;\n  applyNotes(await act('notePurge', { id }, 'Removed from the archive.'));\n}\n\nfunction showTab(name, silent){\n  ui.tab = name; savePref('tab', name);\n  document.querySelectorAll('.tab').forEach(t => t.classList.toggle('active', t.id === 'tab-' + name));\n  document.querySelectorAll('#mainnav button').forEach(b => b.classList.toggle('active', b.dataset.tab === name));\n  if(name === 'admin' && !silent && D && D.me.role === 'admin') renderAdmin();\n  if(D && name === 'notes'){ renderNotes(); if((ui.noteView || 'mine') === 'mine') markNotesSeen(); }\n  if(D) renderNotesBadges();\n  if(!silent) window.scrollTo({ top:0 });\n}\nfunction showSub(name){\n  ui.sub = name; savePref('sub', name);\n  document.querySelectorAll('#tab-supplies .sub').forEach(s => s.classList.toggle('hidden', s.id !== 'sub-' + name));\n  document.querySelectorAll('#supnav button').forEach(b => b.classList.toggle('active', b.dataset.sub === name));\n}\n\nfunction userName(username){\n  if(!username) return '';\n  const u = (D.users || []).find(x => x.username === username);\n  return u ? u.name : username;\n}\n\n/* schedule names (\"Dianne\") -> account, matched by username, full name or first name */\nfunction personUser(label){\n  const k = String(label || '').trim().toLowerCase();\n  if(!k) return null;\n  const us = D.users || [];\n  const nm = u => String(u.name || '').trim().toLowerCase();\n  return us.find(u => u.username === k) || us.find(u => nm(u) === k) || us.find(u => nm(u).split(/\\s+/)[0] === k) || null;\n}\nconst isTeamLabel = n => /^(team|both)$/i.test(String(n || '').trim());\nfunction sched(day){ return ((D.weekSchedule || D.schedule) || {})[day] || { tasks:[], who:{} }; }\nfunction whoOf(day, task){ return String((sched(day).who || {})[task] || '').trim(); }\nfunction personName(label){ const u = personUser(label); return u ? u.name : label; }\n/* people labels responsible for a task; \"Team\" = everyone else on that day */\nfunction assigneesOf(day, task){\n  const n = whoOf(day, task); if(!n) return [];\n  if(!isTeamLabel(n)) return [n];\n  const seen = {}, out = [];\n  sched(day).tasks.forEach(t => { const x = whoOf(day, t); if(x && !isTeamLabel(x) && !seen[x.toLowerCase()]){ seen[x.toLowerCase()] = 1; out.push(x); } });\n  return out;\n}\nfunction isMine(label){ const u = personUser(label); return !!(u && u.username === D.me.username); }\nfunction isMyTask(day, task){ return assigneesOf(day, task).some(isMine); }\nfunction teamOf(day){\n  const seen = {}; const out = [];\n  sched(day).tasks.forEach(t => { const n = whoOf(day, t); if(!n || isTeamLabel(n)) return; const disp = personName(n); if(seen[disp.toLowerCase()]) return; seen[disp.toLowerCase()] = 1; out.push(disp); });\n  return out;\n}\n\nfunction setupStaticSelects(){\n  const people = D.people;\n  const ownerOpts = people.map(p => '<option value=\"'+esc(p)+'\">'+esc(p === D.house ? p + ' (Aligned)' : p)+'</option>').join('');\n  document.querySelectorAll('.ownerSelect').forEach(s => { const v = s.value; s.innerHTML = ownerOpts; if(v) s.value = v; });\n  const fo = $('filterOwner'), fv = fo.value;\n  fo.innerHTML = '<option value=\"\">All owners</option>' + people.map(p => '<option>'+esc(p)+'</option>').join(''); fo.value = fv;\n  const oa = $('o-assign'), ov = oa.value;\n  oa.innerHTML = '<option value=\"\">Select provider\u2026</option>' + people.map(p => '<option value=\"'+esc(p)+'\">'+esc(p === D.house ? p + ' (Aligned)' : p)+'</option>').join('')\n    + (people.includes('Sarah') && people.includes('Erica') ? '<option value=\"Split\">Split 50/50 (Sarah &amp; Erica)</option>' : '');\n  oa.value = ov;\n  renderSeg('pos'); renderSeg('neg');\n}\n\n/* =========================================================\n   CLEANING\n   ========================================================= */\nconst SIGNOFFS_NEEDED = 2;\nfunction cleanRecs(date, task){ return D.cleaning.filter(r => r.date === date && r.task === task).sort((a,b) => a.doneAt < b.doneAt ? -1 : 1); }\nfunction cleanFor(date, task){ return cleanRecs(date, task).length >= SIGNOFFS_NEEDED; }\nfunction myCarry(){ return (D.carryOver || []).filter(c => (c.users || []).includes(D.me.username)); }\nfunction dayStats(day){\n  const date = D.weekDates[day];\n  const tasks = sched(day).tasks || [];\n  const done = tasks.filter(t => cleanFor(date, t)).length;\n  const notYet = !!D.startDate && date < D.startDate;\n  return { date, tasks, done, total: tasks.length, past: !notYet && date < D.today, future: notYet || date > D.today, notYet, isToday: date === D.today };\n}\n\nfunction renderCleaning(){\n  const me = D.me;\n  $('cleanRule').innerHTML = '<span class=\"ico\">\u26a0\ufe0f</span><div><strong>Cleaning rule:</strong> ' + esc(D.cleaningRule || '') + '</div>';\n  const todayKey = D.todayKey;\n\n  /* hero */\n  const hero = $('cleanHero');\n  if(todayKey){\n    const s = dayStats(todayKey);\n    const team = teamOf(todayKey);\n    const myTasks = s.tasks.filter(t => isMyTask(todayKey, t));\n    const closed = D.closedDates.includes(D.today);\n    const pct = s.total ? s.done / s.total : 0;\n    const C = 2 * Math.PI * 40;\n    hero.innerHTML = '<div>'\n      + '<div class=\"eyebrow\">Today \u00b7 ' + esc(fmtYmdLong(D.today)) + '</div>'\n      + '<h2>' + (s.notYet ? 'Cleaning starts ' + esc(fmtYmdLong(D.startDate)) : closed ? 'Clinic marked closed today' : !s.total ? 'No cleaning tasks set for today' : s.done === s.total ? 'All cleaning done \u2713' : (s.total - s.done) + ' task' + (s.total - s.done === 1 ? '' : 's') + ' left today') + '</h2>'\n      + ((D.carryOver || []).length ? '<div class=\"assign\"><strong>+ ' + D.carryOver.length + ' carried over</strong> from earlier days (see below)</div>' : '')\n      + '<div class=\"assign\">' + (team.length ? 'Today\\'s team: <strong>' + esc(team.join(' + ')) + '</strong>' : 'No one is assigned today.')\n      + (myTasks.length ? '<br>Your task: <strong>' + esc(myTasks.join(', ')) + '</strong>' : '') + '</div>'\n      + '</div>'\n      + '<div class=\"ring\"><svg viewBox=\"0 0 92 92\"><circle cx=\"46\" cy=\"46\" r=\"40\" fill=\"none\" stroke=\"rgba(255,255,255,.25)\" stroke-width=\"9\"/>'\n      + '<circle cx=\"46\" cy=\"46\" r=\"40\" fill=\"none\" stroke=\"#fff\" stroke-width=\"9\" stroke-linecap=\"round\" stroke-dasharray=\"'+C+'\" stroke-dashoffset=\"'+(C*(1-pct))+'\"/></svg>'\n      + '<div class=\"lbl\">' + s.done + '/' + s.total + '<small>done</small></div></div>'\n      + (me.role === 'admin' ? '<div class=\"heroactions\"><button class=\"btn btn-white btn-sm\" onclick=\"toggleClosed()\">' + (closed ? 'Undo \"closed today\"' : 'Mark clinic closed today (no emails)') + '</button></div>' : '');\n    const left = (closed || s.notYet) ? 0 : (s.total - s.done) + (D.carryOver || []).length;\n    $('cleanBadge').textContent = left;\n    $('cleanBadge').classList.toggle('zero', left === 0);\n  } else {\n    hero.innerHTML = '<div><div class=\"eyebrow\">' + esc(fmtYmdLong(D.today)) + '</div><h2>Enjoy the weekend</h2><div class=\"assign\">Cleaning sign-offs run Monday through Friday.'\n      + ((D.carryOver || []).length ? '<br><strong>' + D.carryOver.length + ' task' + (D.carryOver.length === 1 ? '' : 's') + ' carried over</strong> to Monday.' : '') + '</div></div><div></div>';\n    $('cleanBadge').classList.add('zero');\n  }\n\n  /* day chips */\n  $('dayChips').innerHTML = DAYS.map(day => {\n    const s = dayStats(day);\n    const missed = s.past && s.done < s.total;\n    const complete = s.total && s.done === s.total;\n    const cls = ['daychip', day === ui.day ? 'sel' : '', s.isToday ? 'today' : '', missed ? 'missed' : '', complete ? 'complete' : ''].join(' ');\n    const st = !s.total ? '\u2014' : complete ? '\u2713 ' + s.done + '/' + s.total : missed ? s.done + '/' + s.total + ' \u00b7 missed' : s.done + '/' + s.total;\n    return '<button class=\"'+cls+'\" onclick=\"pickDay(\\''+day+'\\')\"><div class=\"d\">'+day+'</div><div class=\"dt\">'+esc(fmtYmd(s.date))+'</div><div class=\"st\">'+st+'</div></button>';\n  }).join('');\n\n  /* task list for selected day */\n  const day = ui.day;\n  const s = dayStats(day);\n  const team = teamOf(day);\n  const closed = D.closedDates.includes(s.date);\n  const whoTag = t => { const n = whoOf(day, t); if(!n) return ''; const mine = isMyTask(day, t);\n    const txt = isTeamLabel(n) ? 'Team: ' + assigneesOf(day, t).map(personName).join(' + ') : personName(n);\n    const sw = (sched(day).swaps || {})[t];\n    return '<span class=\"whotag' + (mine ? ' me' : '') + '\">' + (mine && !isTeamLabel(n) ? 'You' : esc(txt)) + '</span>'\n      + (sw ? '<span class=\"swaptag\">' + esc(sw.fromName) + '\\'s turn \u00b7 pay-back for ' + esc(fmtYmd(sw.origDate)) + '</span>' : ''); };\n  let html = '<div class=\"cardhead\"><div><h2>' + DAY_NAMES[day] + ' \u00b7 ' + esc(fmtYmd(s.date)) + '</h2>'\n    + '<div class=\"muted\">' + (team.length ? 'Buddy team: <strong>' + esc(team.join(' + ')) + '</strong>' : 'No one assigned') + (D.rotateWeekly ? ' \u00b7 ' + (sched(day).weekB ? 'Week B (jobs swapped)' : 'Week A') : '') + (closed ? ' \u00b7 <span class=\"tag gray\">Closed</span>' : '') + '</div></div>'\n    + (s.total ? '<span class=\"tag ' + (s.done === s.total ? 'green' : s.past ? 'red' : 'blue') + '\">' + s.done + ' of ' + s.total + ' done</span>' : '') + '</div>';\n  const canUndo = rec => me.role === 'admin' || (rec.doneBy === me.username && new Date(rec.doneAt).toDateString() === new Date().toDateString());\n  const signLine = (rec, i) => '<div class=\"tmeta\">' + (i === 0 ? 'Done by ' : 'Confirmed by ') + '<strong>' + esc(rec.doneByName) + '</strong> \u00b7 ' + esc(fmtDateTime(rec.doneAt))\n      + (rec.offAssignment ? ' <span class=\"tag amber\">Covered for ' + esc(rec.assignedName) + '</span>' : '')\n      + (rec.late ? ' <span class=\"tag gray\">Late</span>' : '')\n      + (canUndo(rec) ? ' <button class=\"btn btn-link btn-sm\" style=\"padding:0 4px\" onclick=\"undoTask(\\''+esc(rec.id)+'\\')\">Undo</button>' : '') + '</div>'\n      + (rec.comment ? '<div class=\"quote\">\u201c' + esc(rec.comment) + '\u201d</div>' : '');\n  /* carried-over tasks show on today (or on any day over the weekend) */\n  const carry = D.carryOver || [];\n  if(carry.length && (day === D.todayKey || !D.todayKey)){\n    html += '<div class=\"carryhead\">\u23e9 Carried over \u2014 not finished on their day</div><ul class=\"tasks\">' + carry.map((c, ci) => {\n      const iSigned = c.recs.some(r => r.doneBy === me.username);\n      const mine = (c.users || []).includes(me.username);\n      const who = c.team ? 'Team: ' + c.people.join(' + ') : (c.people.join(' + ') || 'No one');\n      return '<li class=\"task carry' + (c.recs.length ? ' half' : ' missed') + '\"><div class=\"tick\">' + (c.recs.length ? '1/2' : '') + '</div>'\n        + '<div><div class=\"tname\">' + esc(c.task) + '<span class=\"whotag' + (mine ? ' me' : '') + '\">' + (mine && !c.team ? 'You' : esc(who)) + '</span></div>'\n        + '<div class=\"tmeta\"><span class=\"tag red\">Missed ' + esc(c.day) + ' ' + esc(fmtYmd(c.date)) + '</span></div>'\n        + c.recs.map(signLine).join('')\n        + (c.recs.length ? '<div class=\"tmeta\"><span class=\"tag amber\">Needs a 2nd sign-off</span></div>' : '') + '</div>'\n        + '<div class=\"tact\">' + (iSigned ? '<span class=\"muted\" style=\"font-size:13px\">Waiting for someone else</span>'\n            : '<button class=\"btn btn-good\" onclick=\"doCarry(' + ci + ')\">' + (c.recs.length ? 'Confirm it\\'s done' : 'I did this') + '</button>') + '</div></li>';\n    }).join('') + '</ul>';\n  }\n  if(carry.length && (day === D.todayKey || !D.todayKey)) html += '<div class=\"carryhead\" style=\"color:var(--ink);margin-top:14px\">' + DAY_NAMES[day] + '\\'s tasks</div>';\n  if(!s.total){\n    html += '<div class=\"emptymsg\">No tasks set for ' + DAY_NAMES[day] + ' yet.' + (me.role === 'admin' ? ' Add them in Admin \u2192 Cleaning schedule.' : '') + '</div>';\n  } else {\n    html += '<ul class=\"tasks\">' + s.tasks.map((t, i) => {\n      const recs = cleanRecs(s.date, t);\n      if(recs.length >= SIGNOFFS_NEEDED){\n        return '<li class=\"task done\"><div class=\"tick\"><svg width=\"16\" height=\"16\" viewBox=\"0 0 24 24\" fill=\"none\" stroke=\"#fff\" stroke-width=\"3.2\" stroke-linecap=\"round\" stroke-linejoin=\"round\"><path d=\"M20 6L9 17l-5-5\"/></svg></div>'\n          + '<div><div class=\"tname\">' + esc(t) + whoTag(t) + '</div>' + recs.map(signLine).join('') + '</div>'\n          + '<div class=\"tact\"></div></li>';\n      }\n      if(recs.length){\n        const iSigned = recs.some(r => r.doneBy === me.username);\n        return '<li class=\"task half' + (s.past ? ' missed' : '') + '\"><div class=\"tick\">1/2</div>'\n          + '<div><div class=\"tname\">' + esc(t) + whoTag(t) + '</div>' + recs.map(signLine).join('')\n          + '<div class=\"tmeta\"><span class=\"tag amber\">Needs a 2nd sign-off</span></div></div>'\n          + '<div class=\"tact\">' + (iSigned ? '<span class=\"muted\" style=\"font-size:13px\">Waiting for someone else</span>'\n              : '<button class=\"btn btn-good\" onclick=\"doTask(\\''+day+'\\','+i+')\">Confirm it\\'s done</button>') + '</div></li>';\n      }\n      if(s.future){\n        return '<li class=\"task\"><div class=\"tick\"></div><div><div class=\"tname\">' + esc(t) + whoTag(t) + '</div><div class=\"tmeta\">' + (s.notYet ? 'Cleaning starts ' + esc(fmtYmdLong(D.startDate)) : 'Upcoming') + '</div></div><div class=\"tact\"></div></li>';\n      }\n      return '<li class=\"task' + (s.past ? ' missed' : '') + '\"><div class=\"tick\"></div>'\n        + '<div><div class=\"tname\">' + esc(t) + whoTag(t) + '</div><div class=\"tmeta\">' + (s.past ? '<span class=\"tag red\">Not done</span>' : 'Not done yet') + '</div></div>'\n        + '<div class=\"tact\"><button class=\"btn btn-good\" onclick=\"doTask(\\''+day+'\\','+i+')\">' + (s.past ? 'I did this (late)' : 'I did this') + '</button></div></li>';\n    }).join('') + '</ul>';\n  }\n  $('cleanList').innerHTML = html;\n}\n\nfunction pickDay(day){ ui.day = day; renderCleaning(); }\n\nfunction applyClean(res){\n  if(!res) return;\n  D.cleaning = res.cleaning;\n  if(res.weekSchedule) D.weekSchedule = res.weekSchedule;\n  if(res.carryOver) D.carryOver = res.carryOver;\n  renderCleaning(); loadHistory();\n}\nasync function doTask(day, idx){\n  const task = sched(day).tasks[idx];\n  if(task === undefined) return;\n  const people = assigneesOf(day, task);\n  const team = isTeamLabel(whoOf(day, task));\n  await signOff({ day, date: D.weekDates[day], task, people: people.map(personName), mine: isMyTask(day, task), team, recs: cleanRecs(D.weekDates[day], task) });\n}\nasync function doCarry(i){\n  const c = (D.carryOver || [])[i];\n  if(!c) return;\n  await signOff({ day: c.day, date: c.date, task: c.task, people: c.people, mine: (c.users || []).includes(D.me.username), team: c.team, recs: c.recs, carry: true });\n}\nasync function signOff(o){\n  const { day, date, task, people } = o;\n  let comment = '';\n  const first = o.recs[0];\n  if(first){\n    if(!await confirmBox('Confirm \"' + task + '\" is done?', first.doneByName + ' signed this off. Check it is really done, then confirm. Every task needs two people to sign off.', 'Yes, it is done')) return;\n    applyClean(await act('cleanDone', { date, task, comment: '' }, 'Confirmed \u2713 \u2014 task complete.'));\n    return;\n  }\n  if(people.length && !o.mine){\n    const nm = people.join(' + ');\n    const r = await ask({\n      title: 'This is ' + nm + \"'s task\",\n      message: '\"' + task + '\" on ' + DAY_NAMES[day] + ' ' + fmtYmd(date) + ' is assigned to ' + nm + '.\\nTell Jacob why you are doing it instead. He will get an email with your note.'\n        + (!o.team && people.length === 1 ? '\\n\\nPay-back: ' + nm + ' will take your next turn at \"' + task + '\".' : ''),\n      okText: 'Sign off & send note',\n      fields: [{ id:'comment', label:'Why are you doing this task?', type:'textarea', required:true, min:3, placeholder:'e.g. Erica is out sick today', requiredMsg:'A comment is required when it is not your assigned day.' }]\n    });\n    if(!r) return;\n    comment = r.comment;\n  }\n  const res = await act('cleanDone', { date, task, comment }, (comment ? 'Signed off \u2014 Jacob was emailed your note.' : 'Signed off \u2713') + ' Now a second person needs to confirm it.');\n  applyClean(res);\n  if(res && res.payback) toast(res.payback.toName + ' will do your ' + task + ' on ' + DAY_NAMES[dayOfYmd(res.payback.date)] + ' ' + fmtYmd(res.payback.date) + '.');\n}\nfunction dayOfYmd(ymd){ return ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'][new Date(ymd + 'T12:00:00').getDay()]; }\n\nasync function undoTask(id){\n  if(!await confirmBox('Undo sign-off?', 'This removes the time stamp for this task.', 'Undo', true)) return;\n  applyClean(await act('cleanUndo', { id }, 'Sign-off removed.'));\n}\n\nasync function toggleClosed(){\n  const closed = D.closedDates.includes(D.today);\n  const res = await act('dayClosed', { date: D.today, closed: !closed }, closed ? 'Today is back on.' : 'Marked closed \u2014 no reminder or \"not done\" email today.');\n  if(res){ D.closedDates = res.closedDates; renderCleaning(); }\n}\n\nasync function loadHistory(){\n  const m = $('histMonth').value || thisMonth();\n  try {\n    const res = await call('cleanMonth', { month: m });\n    ui.history = res.rows;\n    $('histBody').innerHTML = res.rows.length ? res.rows.map(r =>\n      '<tr><td>' + esc(fmtYmd(r.date)) + ' <span class=\"muted\">' + esc(r.day) + '</span></td>'\n      + '<td><strong>' + esc(r.task) + '</strong></td>'\n      + '<td>' + esc(r.assignedName || '\u2014') + '</td>'\n      + '<td>' + esc(r.doneByName) + (r.kind === 'check' ? ' <span class=\"tag blue\">2nd sign-off</span>' : '') + (r.offAssignment ? ' <span class=\"tag amber\">Covered</span>' : '') + (r.late ? ' <span class=\"tag gray\">Late</span>' : '') + '</td>'\n      + '<td>' + esc(fmtDateTime(r.doneAt)) + '</td>'\n      + '<td>' + (r.comment ? '<span class=\"sub2\">\u201c' + esc(r.comment) + '\u201d</span>' : '') + '</td></tr>'\n    ).join('') : '<tr><td colspan=\"6\" class=\"empty\">No sign-offs in ' + esc(monthLabel(m)) + '.</td></tr>';\n  } catch(e){\n    if(e.code !== 'auth') $('histBody').innerHTML = '<tr><td colspan=\"6\" class=\"empty\">' + esc(e.message) + '</td></tr>';\n  }\n}\n\nfunction exportHistoryCSV(){\n  const rows = [['Date','Day','Task','Assigned','Signed off by','Sign-off','Signed at','Off-assignment','Late','Comment']];\n  ui.history.forEach(r => rows.push([r.date, r.day, r.task, r.assignedName, r.doneByName, r.kind === 'check' ? '2nd (confirm)' : '1st', fmtDateTime(r.doneAt), r.offAssignment ? 'Yes' : '', r.late ? 'Yes' : '', r.comment]));\n  downloadCSV(rows, 'cleaning-' + ($('histMonth').value || thisMonth()) + '.csv');\n}\n\n/* =========================================================\n   SUPPLIES\n   ========================================================= */\nconst isAdmin = () => D && D.me.role === 'admin';\nconst needsOrders = () => D.orders.filter(o => o.status === 'needs');\nconst queueOrders = () => D.orders.filter(o => o.status !== 'received').sort((a,b) => (a.status === b.status ? (a.requestedAt < b.requestedAt ? 1 : -1) : a.status === 'needs' ? -1 : 1));\nfunction assignLabel(a){ if(a === 'Split') return 'Split 50/50'; return a || D.house; }\nfunction whoChip(a){\n  if(a === 'Split') return '<span class=\"chip Sarah\">Sarah</span> <span class=\"chip Erica\">Erica</span> <span class=\"sub2\" style=\"display:inline\">50/50</span>';\n  const p = D.people.includes(a) ? a : D.house;\n  return '<span class=\"chip ' + esc(p) + '\">' + esc(p) + '</span>';\n}\n\nfunction renderSupplies(){\n  renderDatalists();\n  renderInventory();\n  renderOrders();\n  renderMonthly();\n  renderBalances();\n}\n\nfunction renderDatalists(){\n  const cats = [...new Set(D.items.map(i => i.category).filter(Boolean))].sort();\n  $('catlist').innerHTML = cats.map(c => '<option value=\"'+esc(c)+'\">').join('');\n  const fc = $('filterCat'), cur = fc.value;\n  fc.innerHTML = '<option value=\"\">All categories</option>' + cats.map(c => '<option'+(c===cur?' selected':'')+'>'+esc(c)+'</option>').join('');\n  $('itemlist').innerHTML = [...new Set(D.items.map(i => i.name))].map(n => '<option value=\"'+esc(n)+'\">').join('');\n}\n\nfunction submitItem(){\n  const name = $('f-name').value.trim();\n  if(!name){ toast('Please enter an item name.', true); $('f-name').focus(); return; }\n  const payload = { id: ui.editingId || '', name, category: $('f-category').value, owner: $('f-owner').value,\n    qty: $('f-qty').value, price: $('f-price').value, reorderAt: $('f-reorder').value, notes: $('f-notes').value };\n  $('itemFormBtn').disabled = true;\n  act('itemSave', payload, ui.editingId ? 'Item saved.' : 'Item added.').then(res => {\n    $('itemFormBtn').disabled = false;\n    if(!res) return;\n    Object.assign(D, res); cancelEdit(); renderSupplies();\n  });\n}\nfunction clearItemForm(){\n  ['f-name','f-category','f-price','f-reorder','f-notes'].forEach(id => $(id).value = '');\n  $('f-qty').value = 1; $('f-owner').value = D.house;\n}\nfunction editItem(id){\n  const it = D.items.find(i => i.id === id); if(!it) return;\n  ui.editingId = id;\n  $('f-name').value = it.name; $('f-category').value = it.category; $('f-owner').value = it.owner;\n  $('f-qty').value = it.qty; $('f-price').value = it.price; $('f-reorder').value = it.reorderAt ?? ''; $('f-notes').value = it.notes || '';\n  $('itemFormTitle').textContent = 'Edit item \u2014 ' + it.name;\n  $('itemFormBtn').textContent = 'Save changes';\n  $('itemFormCancel').classList.remove('hidden');\n  window.scrollTo({ top:0, behavior:'smooth' });\n}\nfunction cancelEdit(){\n  ui.editingId = null; clearItemForm();\n  $('itemFormTitle').textContent = 'Add inventory item';\n  $('itemFormBtn').textContent = 'Add item';\n  $('itemFormCancel').classList.add('hidden');\n}\nasync function deleteItem(id){\n  const it = D.items.find(i => i.id === id); if(!it) return;\n  if(!await confirmBox('Delete item?', 'Delete \"' + it.name + '\" from inventory?', 'Delete', true)) return;\n  const res = await act('itemDelete', { id }, 'Item deleted.');\n  if(res){ Object.assign(D, res); renderSupplies(); }\n}\nasync function adjustQty(id, delta){\n  const it = D.items.find(i => i.id === id); if(!it) return;\n  it.qty = Math.max(0, it.qty + delta); renderInventory();       // instant feel\n  const res = await act('itemQty', { id, delta });\n  if(res){ Object.assign(D, res); renderSupplies(); }\n}\nasync function togglePaid(id){\n  const it = D.items.find(i => i.id === id); if(!it) return;\n  const res = await act('itemPaid', { id, paid: !it.paid }, it.paid ? 'Marked unpaid.' : 'Marked paid.');\n  if(res){ Object.assign(D, res); renderSupplies(); }\n}\nasync function flagItem(id){\n  const it = D.items.find(i => i.id === id); if(!it) return;\n  if(D.orders.some(o => o.itemId === id && o.status !== 'received')){ toast('\"' + it.name + '\" is already in the order queue.', true); showSub('ordering'); return; }\n  const r = await ask({ title:'Order \"' + it.name + '\"', message:'Jacob will get an email right away.', okText:'Flag for ordering',\n    fields:[{ id:'qty', label:'How many need to be ordered?', type:'number', value:'1', required:true }, { id:'note', label:'Note (optional)', placeholder:'Brand, size, urgency\u2026' }] });\n  if(!r) return;\n  const res = await act('orderFlagItem', { id, qty: r.qty, note: r.note }, 'Flagged \u2014 Jacob was emailed.');\n  if(res){ Object.assign(D, res); renderSupplies(); showSub('ordering'); }\n}\n\nfunction renderInventory(){\n  const q = ($('searchBox').value || '').toLowerCase();\n  const fo = $('filterOwner').value, fc = $('filterCat').value;\n  const flagged = new Set(needsOrders().map(o => o.itemId).filter(Boolean));\n  const admin = isAdmin();\n  const rows = D.items\n    .filter(i => !q || i.name.toLowerCase().includes(q) || (i.notes||'').toLowerCase().includes(q))\n    .filter(i => !fo || i.owner === fo)\n    .filter(i => !fc || i.category === fc)\n    .sort((a,b) => (flagged.has(b.id) - flagged.has(a.id)) || a.name.localeCompare(b.name))\n    .map(i => {\n      const f = flagged.has(i.id);\n      const total = (i.qty||0) * (i.price||0);\n      const paidCell = i.owner === D.house ? '<span class=\"muted\">\u2014</span>'\n        : i.paid ? '<span class=\"paidtag\">\u2713 Paid</span>' + (admin ? ' <button class=\"btn btn-white btn-sm\" onclick=\"togglePaid(\\''+i.id+'\\')\">Undo</button>' : '')\n        : '<span class=\"owedtag\">Owes ' + money(total) + '</span>' + (admin ? ' <button class=\"btn btn-white btn-sm\" onclick=\"togglePaid(\\''+i.id+'\\')\">Mark paid</button>' : '');\n      const low = i.reorderAt !== null && i.reorderAt !== undefined;\n      return '<tr class=\"' + (f ? 'flagged' : '') + '\">'\n        + '<td><strong>' + esc(i.name) + '</strong>' + (f ? ' <span class=\"tag red\">Order</span>' : '')\n        + (i.notes ? '<div class=\"sub2\">' + esc(i.notes) + '</div>' : '') + (low ? '<div class=\"sub2\">Reorder at ' + i.reorderAt + '</div>' : '') + '</td>'\n        + '<td>' + esc(i.category) + '</td>'\n        + '<td>' + whoChip(i.owner) + '</td>'\n        + '<td class=\"num\"><span class=\"qtyctl\"><button class=\"btn btn-white btn-sm\" onclick=\"adjustQty(\\''+i.id+'\\',-1)\" aria-label=\"decrease\">\u2212</button><strong>' + i.qty + '</strong><button class=\"btn btn-white btn-sm\" onclick=\"adjustQty(\\''+i.id+'\\',1)\" aria-label=\"increase\">+</button></span></td>'\n        + '<td class=\"num\">' + money(i.price) + '</td>'\n        + '<td class=\"num\"><strong>' + money(total) + '</strong></td>'\n        + '<td>' + paidCell + '</td>'\n        + '<td><div class=\"rowactions\">'\n        + '<button class=\"btn btn-quiet btn-sm\" onclick=\"editItem(\\''+i.id+'\\')\">Edit</button>'\n        + '<button class=\"btn btn-flag btn-sm\" onclick=\"flagItem(\\''+i.id+'\\')\">\ud83d\udea9 Order</button>'\n        + (admin ? '<button class=\"btn btn-white btn-sm\" onclick=\"deleteItem(\\''+i.id+'\\')\">Delete</button>' : '')\n        + '</div></td></tr>';\n    });\n  $('invBody').innerHTML = rows.join('') || '<tr><td colspan=\"8\" class=\"empty\">' + (D.items.length ? 'No items match.' : 'No items yet \u2014 add your first one above' + (isAdmin() ? ', or import from the old app in Admin.' : '.')) + '</td></tr>';\n}\n\nfunction submitOrder(){\n  const name = $('o-item').value.trim(), assignTo = $('o-assign').value;\n  if(!name){ toast('Please enter an item name.', true); $('o-item').focus(); return; }\n  if(!assignTo){ toast('Please pick a provider (Clinic, Sarah, Erica, or Split).', true); $('o-assign').focus(); return; }\n  $('orderBtn').disabled = true;\n  act('orderRequest', { name, qty: $('o-qty').value, assignTo, note: $('o-note').value }, 'Order submitted \u2014 Jacob was emailed.').then(res => {\n    $('orderBtn').disabled = false;\n    if(!res) return;\n    Object.assign(D, res);\n    $('o-item').value = ''; $('o-qty').value = 1; $('o-note').value = ''; $('o-assign').value = '';\n    renderSupplies();\n  });\n}\n\nasync function editOrderCost(id){\n  const o = D.orders.find(x => x.id === id); if(!o) return;\n  const r = await ask({ title:'Unit cost \u2014 ' + o.name, message:'Leave blank if you don\\'t know it yet.', okText:'Save cost',\n    fields:[{ id:'price', label:'Cost each ($)', type:'number', step:'0.01', value: o.price ?? '' }] });\n  if(!r) return;\n  const res = await act('orderCost', { id, price: r.price }, 'Cost saved.');\n  if(res){ Object.assign(D, res); renderSupplies(); }\n}\nasync function markOrdered(id){\n  const res = await act('orderOrdered', { id }, 'Marked ordered.');\n  if(res){ Object.assign(D, res); renderSupplies(); }\n}\nasync function markReceived(id){\n  const o = D.orders.find(x => x.id === id); if(!o) return;\n  const it = o.itemId ? D.items.find(i => i.id === o.itemId) : null;\n  const r = await ask({ title:'Received \"' + o.name + '\"', okText:'Mark received',\n    message: it ? 'How many should be added to stock? (currently ' + it.qty + ')' : 'This item isn\\'t in inventory yet \u2014 it will be added' + (o.assignTo === 'Split' ? ', split between Sarah and Erica.' : '.'),\n    fields:[{ id:'addQty', label:'Add to inventory', type:'number', value: String(o.qty), required:true }] });\n  if(!r) return;\n  const res = await act('orderReceived', { id, addQty: r.addQty }, 'Received \u2014 stock updated.');\n  if(res){ Object.assign(D, res); renderSupplies(); }\n}\nasync function removeOrder(id){\n  const o = D.orders.find(x => x.id === id); if(!o) return;\n  if(!await confirmBox('Remove from queue?', 'Remove \"' + o.name + '\" from the order queue? It will not be saved in the monthly archive.', 'Remove', true)) return;\n  const res = await act('orderRemove', { id }, 'Removed.');\n  if(res){ Object.assign(D, res); renderSupplies(); }\n}\n\nfunction renderOrders(){\n  const open = queueOrders(), needs = needsOrders().length, admin = isAdmin();\n  $('orderList').innerHTML = open.length ? open.map(o => {\n    const pill = o.status === 'ordered' ? '<span class=\"tag amber\">Ordered</span>' : '<span class=\"tag red\">Needs order</span>';\n    const cost = (o.price === null || o.price === undefined) ? 'Cost: not set yet' : 'Cost: ' + money(o.price) + ' each \u00b7 Total ' + money(o.price * o.qty);\n    return '<div class=\"order-item ' + (o.status === 'ordered' ? 'ordered' : '') + '\"><div>'\n      + '<div class=\"oi-title\">' + esc(o.name) + ' \u00d7 ' + o.qty + ' ' + pill + '</div>'\n      + '<div class=\"oi-meta\">For: ' + whoChip(o.assignTo) + '</div>'\n      + '<div class=\"oi-meta\">' + cost + '</div>'\n      + '<div class=\"oi-meta\">' + (o.by ? 'Requested by ' + esc(o.by) + ' \u00b7 ' : '') + esc(fmtDate(o.requestedAt))\n      + (o.status === 'ordered' && o.orderedAt ? ' \u00b7 Ordered ' + esc(fmtDate(o.orderedAt)) : '') + (o.note ? ' \u00b7 ' + esc(o.note) : '') + '</div>'\n      + '</div><div class=\"rowactions\">'\n      + (admin ? '<button class=\"btn btn-white btn-sm\" onclick=\"editOrderCost(\\''+o.id+'\\')\">Edit cost</button>' : '')\n      + (admin && o.status === 'needs' ? '<button class=\"btn btn-quiet btn-sm\" onclick=\"markOrdered(\\''+o.id+'\\')\">Mark ordered</button>' : '')\n      + '<button class=\"btn btn-primary btn-sm\" onclick=\"markReceived(\\''+o.id+'\\')\">Received</button>'\n      + (admin ? '<button class=\"btn btn-white btn-sm\" onclick=\"removeOrder(\\''+o.id+'\\')\">Remove</button>' : '')\n      + '</div></div>';\n  }).join('') : '<div class=\"emptymsg\">Nothing in the queue. Requests show up here and Jacob gets an email.</div>';\n\n  [$('orderBadge'), $('supBadge')].forEach(b => { b.textContent = needs; b.classList.toggle('zero', needs === 0); });\n  $('orderAlert').classList.toggle('hidden', needs === 0);\n  $('orderAlertText').textContent = needs === 1 ? '1 item needs to be ordered.' : needs + ' items need to be ordered.';\n}\n\nfunction monthlyRows(key){\n  return D.orders.filter(o => o.orderedAt && monthKey(o.orderedAt) === key && o.status !== 'needs')\n    .sort((a,b) => a.orderedAt < b.orderedAt ? 1 : -1);\n}\nfunction splitShare(assignTo, total){\n  if(total === null) return { clinic:0, providers:0 };\n  if(!assignTo || assignTo === D.house) return { clinic: total, providers: 0 };\n  return { clinic: 0, providers: total };\n}\nconst lineTotal = o => (o.price === null || o.price === undefined) ? null : o.price * o.qty;\n\nfunction renderMonthly(){\n  const pick = $('monthPick');\n  const keys = new Set(D.orders.filter(o => o.orderedAt).map(o => monthKey(o.orderedAt)).filter(Boolean));\n  keys.add(thisMonth());\n  D.items.forEach(i => { if(i.paid && i.paidDate) keys.add(monthKey(i.paidDate)); });\n  const sorted = [...keys].sort().reverse();\n  const prev = pick.value && keys.has(pick.value) ? pick.value : thisMonth();\n  pick.innerHTML = sorted.map(k => '<option value=\"'+esc(k)+'\"'+(k===prev?' selected':'')+'>'+esc(monthLabel(k))+'</option>').join('');\n  const key = pick.value || thisMonth();\n  const rows = monthlyRows(key);\n  let spent = 0, clinic = 0, providers = 0, missing = 0;\n  rows.forEach(o => { const t = lineTotal(o); if(t === null){ missing++; return; } spent += t; const p = splitShare(o.assignTo, t); clinic += p.clinic; providers += p.providers; });\n  const collected = D.items.filter(i => i.owner !== D.house && i.paid && monthKey(i.paidDate) === key).reduce((s,i) => s + i.qty*i.price, 0);\n  const owed = D.items.filter(i => i.owner !== D.house && !i.paid).reduce((s,i) => s + i.qty*i.price, 0);\n  const bottom = collected - clinic;\n  $('monthMoney').innerHTML =\n      '<div class=\"moneycard\"><div class=\"lbl\">Spent on orders</div><div class=\"amt\">'+money(spent)+'</div><div class=\"hint\">'+rows.length+' ordered</div></div>'\n    + '<div class=\"moneycard\"><div class=\"lbl\">Clinic expense</div><div class=\"amt\">'+money(clinic)+'</div><div class=\"hint\">Assigned to Clinic</div></div>'\n    + '<div class=\"moneycard\"><div class=\"lbl\">Billed to providers</div><div class=\"amt\">'+money(providers)+'</div><div class=\"hint\">Sarah / Erica / Split</div></div>'\n    + '<div class=\"moneycard good\"><div class=\"lbl\">Collected</div><div class=\"amt\">'+money(collected)+'</div><div class=\"hint\">Marked paid this month</div></div>'\n    + '<div class=\"moneycard '+(bottom >= 0 ? 'good' : 'bad')+'\"><div class=\"lbl\">Clinic bottom line</div><div class=\"amt\">'+money(bottom)+'</div><div class=\"hint\">Collected \u2212 clinic expense</div></div>'\n    + '<div class=\"moneycard\"><div class=\"lbl\">Still owed now</div><div class=\"amt\">'+money(owed)+'</div><div class=\"hint\">All unpaid balances</div></div>';\n  $('monthSummary').textContent = rows.length\n    ? monthLabel(key) + ': ' + rows.length + (rows.length === 1 ? ' order' : ' orders') + (missing ? ' \u00b7 ' + missing + ' missing a unit cost (use Edit cost on Ordering)' : '')\n    : 'Nothing marked ordered in ' + monthLabel(key) + '.';\n  $('monthBody').innerHTML = rows.length ? rows.map(o => {\n    const t = lineTotal(o);\n    return '<tr><td>' + esc(fmtDate(o.orderedAt)) + '</td>'\n      + '<td><strong>' + esc(o.name) + '</strong>' + (o.note ? '<div class=\"sub2\">' + esc(o.note) + '</div>' : '') + '</td>'\n      + '<td class=\"num\">' + o.qty + '</td><td>' + whoChip(o.assignTo) + '</td><td>' + esc(o.by || '\u2014') + '</td>'\n      + '<td class=\"num\">' + (o.price === null || o.price === undefined ? '\u2014' : money(o.price)) + '</td>'\n      + '<td class=\"num\">' + (t === null ? '\u2014' : '<strong>' + money(t) + '</strong>') + '</td>'\n      + '<td>' + (o.status === 'received' ? '<span class=\"tag green\">Received ' + esc(fmtDate(o.receivedAt)) + '</span>' : '<span class=\"tag amber\">Ordered</span>') + '</td></tr>';\n  }).join('') : '<tr><td colspan=\"8\" class=\"empty\">No orders logged for this month.</td></tr>';\n}\n\nfunction renderBalances(){\n  const admin = isAdmin();\n  const cards = D.people.filter(p => p !== D.house).map(p => {\n    const theirs = D.items.filter(i => i.owner === p);\n    const total = theirs.reduce((s,i) => s + i.qty*i.price, 0);\n    const owed = theirs.filter(i => !i.paid).reduce((s,i) => s + i.qty*i.price, 0);\n    return '<div class=\"balcard ' + esc(p) + '\"><div class=\"who2\">' + esc(p) + '</div>'\n      + '<div class=\"big\" style=\"color:' + (owed > 0 ? 'var(--flag)' : 'var(--good)') + '\">' + money(owed) + '</div>'\n      + '<div class=\"muted\">owed now \u00b7 ' + money(total) + ' total assigned (' + theirs.length + ' items)</div></div>';\n  });\n  const clinicTotal = D.items.filter(i => i.owner === D.house).reduce((s,i) => s + i.qty*i.price, 0);\n  cards.push('<div class=\"balcard Clinic\"><div class=\"who2\">Clinic (Aligned)</div><div class=\"big\">' + money(clinicTotal) + '</div><div class=\"muted\">inventory value on hand \u2014 house account</div></div>');\n  $('balCards').innerHTML = cards.join('');\n  const unpaid = D.items.filter(i => i.owner !== D.house && !i.paid);\n  $('balBody').innerHTML = unpaid.length ? unpaid.map(i =>\n    '<tr><td>' + whoChip(i.owner) + '</td><td>' + esc(i.name) + '</td><td class=\"num\">' + i.qty + '</td><td class=\"num\">' + money(i.price) + '</td>'\n    + '<td class=\"num\"><strong class=\"owedtag\">' + money(i.qty*i.price) + '</strong></td>'\n    + '<td>' + (admin ? '<button class=\"btn btn-primary btn-sm\" onclick=\"togglePaid(\\''+i.id+'\\')\">Mark paid</button>' : '') + '</td></tr>'\n  ).join('') : '<tr><td colspan=\"6\" class=\"empty\">All settled \u2014 nobody owes anything right now.</td></tr>';\n}\n\nfunction exportInventoryCSV(){\n  const rows = [['Item','Category','For','Qty','Unit Price','Total','Paid','Reorder at','Notes']];\n  D.items.forEach(i => rows.push([i.name, i.category, i.owner, i.qty, (i.price||0).toFixed(2), (i.qty*i.price).toFixed(2), i.owner === D.house ? '' : (i.paid ? 'Yes' : 'No'), i.reorderAt ?? '', i.notes]));\n  downloadCSV(rows, 'aligned-inventory.csv');\n}\nfunction exportMonthCSV(){\n  const key = $('monthPick').value || thisMonth();\n  const rows = [['Ordered date','Item','Qty','For','Requested by','Unit price','Total','Status','Received','Note','Requested date']];\n  monthlyRows(key).forEach(o => { const t = lineTotal(o); rows.push([fmtDate(o.orderedAt), o.name, o.qty, assignLabel(o.assignTo), o.by, o.price ?? '', t ?? '', o.status, fmtDate(o.receivedAt), o.note, fmtDate(o.requestedAt)]); });\n  downloadCSV(rows, 'aligned-orders-' + key + '.csv');\n}\n\n/* =========================================================\n   CLIA QC\n   ========================================================= */\nfunction renderSeg(which){\n  const el = document.querySelector('.seg[data-qc=\"'+which+'\"]');\n  const val = which === 'pos' ? ui.qcPos : ui.qcNeg;\n  el.innerHTML = ['Pass','Fail','N/A'].map(v => '<button type=\"button\" class=\"' + (v === 'N/A' ? 'NA' : v) + (val === v ? ' on' : '') + '\" onclick=\"setSeg(\\''+which+'\\',\\''+v+'\\')\">' + v + '</button>').join('');\n}\nfunction setSeg(which, v){ if(which === 'pos') ui.qcPos = v; else ui.qcNeg = v; renderSeg(which); }\n\nasync function submitQC(){\n  const test = $('q-test').value.trim(), lot = $('q-lot').value.trim(), exp = $('q-exp').value;\n  if(!test){ toast('Please enter the test / kit.', true); $('q-test').focus(); return; }\n  if(!lot){ toast('Please enter the lot number.', true); $('q-lot').focus(); return; }\n  if(!ui.qcPos || !ui.qcNeg){ toast('Pick Pass / Fail for both controls.', true); return; }\n  if(exp && exp < D.today && !await confirmBox('This kit is expired', 'The expiration date (' + exp + ') has passed. Save the entry anyway?', 'Save anyway', true)) return;\n  const fail = ui.qcPos === 'Fail' || ui.qcNeg === 'Fail';\n  $('qcBtn').disabled = true;\n  const res = await act('qcAdd', { test, lot, expiration: exp, reason: $('q-reason').value, posControl: ui.qcPos, negControl: ui.qcNeg, notes: $('q-notes').value },\n    fail ? 'Saved as FAILED \u2014 Jacob was emailed.' : 'QC entry saved \u2713');\n  $('qcBtn').disabled = false;\n  if(!res) return;\n  D.qc = res.qc;\n  $('q-lot').value = ''; $('q-exp').value = ''; $('q-notes').value = ''; ui.qcPos = ''; ui.qcNeg = ''; renderSeg('pos'); renderSeg('neg');\n  renderQC();\n}\n\nfunction qcFiltered(){\n  const q = ($('qcSearch').value || '').toLowerCase();\n  const m = $('qcMonth').value;\n  return D.qc.filter(r => (!q || r.test.toLowerCase().includes(q) || r.lot.toLowerCase().includes(q)) && (!m || monthKey(r.loggedAt) === m))\n    .sort((a,b) => a.loggedAt < b.loggedAt ? 1 : -1);\n}\n\nfunction renderQC(){\n  const tests = [...new Set([...(D.qcTests || []), ...D.qc.map(r => r.test)])];\n  $('qctestlist').innerHTML = tests.map(t => '<option value=\"'+esc(t)+'\">').join('');\n  const sel = $('qcMonth'), cur = sel.value;\n  const months = [...new Set(D.qc.map(r => monthKey(r.loggedAt)).filter(Boolean))].sort().reverse();\n  sel.innerHTML = '<option value=\"\">All months</option>' + months.map(k => '<option value=\"'+k+'\"'+(k===cur?' selected':'')+'>'+esc(monthLabel(k))+'</option>').join('');\n  const admin = isAdmin();\n  const rows = qcFiltered();\n  const res = v => '<span class=\"result ' + (v === 'N/A' ? 'NA' : v) + '\">' + esc(v) + '</span>';\n  $('qcBody').innerHTML = rows.length ? rows.map(r => {\n    const old = (Date.now() - new Date(r.loggedAt).getTime()) / 864e5 >= D.qcRetentionDays;\n    return '<tr class=\"' + (r.voided ? 'voided' : '') + '\">'\n      + '<td class=\"strike\">' + esc(fmtDateTime(r.loggedAt)) + '</td>'\n      + '<td class=\"strike\"><strong>' + esc(r.test) + '</strong></td>'\n      + '<td class=\"strike\">' + esc(r.lot) + '</td>'\n      + '<td class=\"strike\">' + esc(r.expiration ? fmtYmd(r.expiration) + ' ' + r.expiration.slice(0,4) : '\u2014') + '</td>'\n      + '<td class=\"strike\">' + esc(r.reason) + '</td>'\n      + '<td>' + res(r.posControl) + '</td><td>' + res(r.negControl) + '</td>'\n      + '<td>' + (r.voided ? '<span class=\"tag gray\">Voided</span>' : r.result === 'Fail' ? '<span class=\"tag red\">Fail</span>' : '<span class=\"tag green\">Pass</span>') + '</td>'\n      + '<td>' + esc(r.byName) + '</td>'\n      + '<td>' + (r.notes ? '<span class=\"sub2\">' + esc(r.notes) + '</span>' : '') + (r.voided ? '<div class=\"sub2\">Voided: ' + esc(r.voidReason) + ' (' + esc(r.voidedBy) + ')</div>' : '') + '</td>'\n      + '<td>' + (admin && !r.voided ? '<button class=\"btn btn-link btn-sm\" onclick=\"voidQC(\\''+r.id+'\\')\">Void</button>' : '') + (admin && old ? '<button class=\"btn btn-link btn-sm\" onclick=\"deleteQC(\\''+r.id+'\\')\">Delete</button>' : '') + '</td></tr>';\n  }).join('') : '<tr><td colspan=\"11\" class=\"empty\">No QC entries' + (D.qc.length ? ' match.' : ' yet.') + '</td></tr>';\n}\n\nasync function voidQC(id){\n  const r = await ask({ title:'Void QC entry', message:'Voided entries stay in the log (crossed out) for inspection records.', okText:'Void entry', danger:true,\n    fields:[{ id:'reason', label:'Reason', required:true, min:3, placeholder:'e.g. Entered wrong lot number' }] });\n  if(!r) return;\n  const res = await act('qcVoid', { id, reason: r.reason }, 'Entry voided.');\n  if(res){ D.qc = res.qc; renderQC(); }\n}\nasync function deleteQC(id){\n  if(!await confirmBox('Delete QC entry?', 'This entry is over 2 years old. Delete it permanently?', 'Delete', true)) return;\n  const res = await act('qcDelete', { id }, 'Deleted.');\n  if(res){ D.qc = res.qc; renderQC(); }\n}\nfunction exportQCCSV(){\n  const rows = [['Date/time','Test','Lot','Expiration','Reason','Positive control','Negative control','Result','Performed by','Notes','Voided','Void reason']];\n  qcFiltered().forEach(r => rows.push([fmtDateTime(r.loggedAt), r.test, r.lot, r.expiration, r.reason, r.posControl, r.negControl, r.result, r.byName, r.notes, r.voided ? 'Yes' : '', r.voidReason]));\n  downloadCSV(rows, 'clia-qc-log' + ($('qcMonth').value ? '-' + $('qcMonth').value : '') + '.csv');\n}\n\n/* =========================================================\n   NDC / LOT\n   ========================================================= */\nlet medEditingId = null;\nfunction daysUntil(ymd){ return Math.round((parseYmd(ymd) - parseYmd(D.today)) / 864e5); }\nfunction medStatus(m){\n  const d = daysUntil(m.expiration);\n  if (d < 0) return { cls:'red', label:'Expired', rank:0, d };\n  if (d <= 30) return { cls:'red', label: d === 0 ? 'Expires today' : 'Expires in ' + d + ' day' + (d === 1 ? '' : 's'), rank:1, d };\n  if (d <= 60) return { cls:'amber', label:'Expires in ' + d + ' days', rank:2, d };\n  return { cls:'green', label:'OK', rank:3, d };\n}\nfunction setMedFilter(v){ $('medFilter').value = v; renderMeds(); }\nfunction renderMeds(){\n  const meds = D.meds || [];\n  $('medNameList').innerHTML = [...new Set(meds.map(m => m.name))].map(n => '<option value=\"'+esc(n)+'\">').join('');\n  $('medLocList').innerHTML = [...new Set(meds.map(m => m.location).filter(Boolean))].map(n => '<option value=\"'+esc(n)+'\">').join('');\n  const soon = meds.filter(m => medStatus(m).d <= 60);\n  const expired = meds.filter(m => medStatus(m).d < 0).length;\n  const urgent = meds.filter(m => medStatus(m).d <= 30).length;\n  $('medBadge').textContent = urgent; $('medBadge').classList.toggle('zero', urgent === 0);\n  $('medAlert').classList.toggle('hidden', soon.length === 0);\n  $('medAlertText').textContent = (expired ? expired + ' expired' : '') + (expired && soon.length - expired ? ' \u00b7 ' : '') + (soon.length - expired ? (soon.length - expired) + ' expiring within 60 days' : '');\n  const q = ($('medSearch').value || '').toLowerCase().replace(/-/g, '');\n  const f = $('medFilter').value;\n  const admin = isAdmin();\n  const rows = meds\n    .filter(m => !q || (m.name + ' ' + m.ndc + ' ' + m.lot).toLowerCase().replace(/-/g, '').includes(q))\n    .filter(m => !f || (f === 'expired' ? medStatus(m).d < 0 : medStatus(m).d <= 60))\n    .sort((a, b) => a.expiration < b.expiration ? -1 : a.expiration > b.expiration ? 1 : a.name.localeCompare(b.name));\n  $('medBody').innerHTML = rows.length ? rows.map(m => {\n    const st = medStatus(m);\n    return '<tr class=\"' + (st.d < 0 ? 'flagged' : '') + '\">'\n      + '<td><strong>' + esc(m.name) + '</strong>' + (m.notes ? '<div class=\"sub2\">' + esc(m.notes) + '</div>' : '') + '</td>'\n      + '<td class=\"nowrap\" style=\"font-variant-numeric:tabular-nums\">' + esc(m.ndc) + '</td>'\n      + '<td>' + esc(m.lot) + '</td>'\n      + '<td class=\"nowrap\">' + esc(parseYmd(m.expiration).toLocaleDateString([], {month:'short', day:'numeric', year:'numeric'})) + '</td>'\n      + '<td class=\"nowrap\"><span class=\"tag ' + st.cls + '\">' + esc(st.label) + '</span></td>'\n      + '<td class=\"num\">' + (m.qty === null || m.qty === undefined ? '\u2014' : m.qty) + '</td>'\n      + '<td>' + esc(m.location || '\u2014') + '</td>'\n      + '<td><span class=\"sub2\">' + esc(m.addedBy || '') + '<br>' + esc(fmtDate(m.addedAt)) + '</span></td>'\n      + '<td><div class=\"rowactions\"><button class=\"btn btn-quiet btn-sm\" onclick=\"editMed(\\''+m.id+'\\')\">Edit</button>'\n      + (admin ? '<button class=\"btn btn-white btn-sm\" onclick=\"deleteMed(\\''+m.id+'\\')\">Delete</button>' : '') + '</div></td></tr>';\n  }).join('') : '<tr><td colspan=\"9\" class=\"empty\">' + (meds.length ? 'Nothing matches.' : 'No medications listed yet \u2014 add the first one above.') + '</td></tr>';\n}\nfunction clearMedForm(){ ['m-name','m-ndc','m-lot','m-exp','m-qty','m-loc','m-notes'].forEach(id => $(id).value = ''); }\nfunction cancelMedEdit(){ medEditingId = null; clearMedForm(); $('medFormTitle').textContent = 'Add a medication'; $('medBtn').textContent = 'Add to list'; $('medCancel').classList.add('hidden'); }\nfunction editMed(id){\n  const m = (D.meds || []).find(x => x.id === id); if(!m) return;\n  medEditingId = id;\n  $('m-name').value = m.name; $('m-ndc').value = m.ndc; $('m-lot').value = m.lot; $('m-exp').value = m.expiration;\n  $('m-qty').value = m.qty ?? ''; $('m-loc').value = m.location || ''; $('m-notes').value = m.notes || '';\n  $('medFormTitle').textContent = 'Edit \u2014 ' + m.name; $('medBtn').textContent = 'Save changes'; $('medCancel').classList.remove('hidden');\n  window.scrollTo({ top:0, behavior:'smooth' });\n}\nasync function submitMed(){\n  const p = { id: medEditingId || '', name: $('m-name').value.trim(), ndc: $('m-ndc').value.trim(), lot: $('m-lot').value.trim(),\n    expiration: $('m-exp').value, qty: $('m-qty').value, location: $('m-loc').value, notes: $('m-notes').value };\n  if(!p.name){ toast('Please enter the medication name.', true); $('m-name').focus(); return; }\n  if(!p.ndc){ toast('Please enter the NDC.', true); $('m-ndc').focus(); return; }\n  if(!p.lot){ toast('Please enter the lot number.', true); $('m-lot').focus(); return; }\n  if(!p.expiration){ toast('Please pick the expiration date.', true); $('m-exp').focus(); return; }\n  const digits = p.ndc.replace(/\\D/g, '').length;\n  if((digits < 10 || digits > 11) && !await confirmBox('Check the NDC', 'NDCs are usually 10 or 11 digits. This one has ' + digits + '. Save anyway?', 'Save anyway')) return;\n  if(p.expiration < D.today && !medEditingId && !await confirmBox('Already expired', 'That expiration date has passed. Add it anyway?', 'Add anyway', true)) return;\n  $('medBtn').disabled = true;\n  const res = await act('medSave', p, medEditingId ? 'Saved.' : 'Added to the list.');\n  $('medBtn').disabled = false;\n  if(!res) return;\n  D.meds = res.meds; cancelMedEdit(); renderMeds();\n}\nasync function deleteMed(id){\n  const m = (D.meds || []).find(x => x.id === id); if(!m) return;\n  if(!await confirmBox('Remove from list?', m.name + ' \u2014 lot ' + m.lot + '. Remove it from the NDC / Lot list?', 'Remove', true)) return;\n  const res = await act('medDelete', { id }, 'Removed.');\n  if(res){ D.meds = res.meds; renderMeds(); }\n}\nfunction exportMedsCSV(){\n  const rows = [['Medication','NDC','Lot','Expiration','Status','Qty','Location','Notes','Added by','Added on','Last updated by','Last updated']];\n  (D.meds || []).slice().sort((a,b) => a.expiration < b.expiration ? -1 : 1).forEach(m => rows.push([m.name, m.ndc, m.lot, m.expiration, medStatus(m).label, m.qty ?? '', m.location, m.notes, m.addedBy, fmtDate(m.addedAt), m.updatedBy, fmtDateTime(m.updatedAt)]));\n  downloadCSV(rows, 'ndc-lot-list.csv');\n}\n\n/* =========================================================\n   ADMIN\n   ========================================================= */\nfunction hourLabel(h){ h = Number(h); const am = h < 12; const hh = Math.floor(h) % 12 || 12; return hh + (h % 1 ? ':30 ' : ':00 ') + (am ? 'AM' : 'PM'); }\n\nfunction renderAdmin(){\n  if(!isAdmin()) return;\n  renderUsers();\n  renderScheduleEditor();\n  const s = D.settings || {};\n  $('set-email').value = s.notifyEmail || '';\n  document.querySelectorAll('.hourSelect').forEach(sel => {\n    sel.innerHTML = Array.from({length:34}, (_,i) => 5 + i / 2).map(h => '<option value=\"'+h+'\">'+hourLabel(h)+'</option>').join('');\n  });\n  $('set-morning').value = String(s.morningHour ?? 8.5);\n  if($('set-start')) $('set-start').value = s.startDate || '';\n  $('set-check').value = String(s.checkHour ?? 17);\n  $('set-qctests').value = (D.qcTests || []).join('\\n');\n  renderTrigger();\n  renderEmailCfg();\n}\nfunction renderTrigger(){\n  const a = D.admin || {};\n  const on = a.triggerOn;\n  $('trigPill').innerHTML = '<span class=\"pill ' + (on ? 'on' : 'off') + '\"><span class=\"dot\"></span>' + (on ? 'Daily checks running' : 'Daily checks not running yet') + '</span>';\n}\nfunction renderEmailCfg(){\n  const a = D.admin || {};\n  $('emailPill').innerHTML = '<span class=\"pill ' + (a.emailOn ? 'on' : 'off') + '\"><span class=\"dot\"></span>' + (a.emailOn ? 'Connected ' + esc(a.emailKeyHint || '') : 'Not set up') + '</span>';\n  $('em-key').value = '';\n  $('em-key').placeholder = a.emailOn ? 'Saved (' + (a.emailKeyHint || '') + ') \u2014 paste a new key to replace' : 're_\u2026';\n  $('em-from').value = a.emailFrom || '';\n  const log = a.emailLog || [];\n  const tag = st => st === 'sent' ? '<span class=\"tag green\">Sent</span>' : /^failed/.test(st) ? '<span class=\"tag red\" title=\"' + esc(st) + '\">Failed</span>' : '<span class=\"tag gray\" title=\"' + esc(st) + '\">Not sent</span>';\n  $('emailLog').innerHTML = log.length ? log.slice(0, 15).map(m => '<div style=\"padding:8px 0;border-bottom:1px solid var(--line)\"><div style=\"display:flex;justify-content:space-between;gap:8px;align-items:flex-start\"><strong style=\"color:var(--ink);font-size:13px\">' + esc(m.subject) + '</strong>' + tag(m.status) + '</div>'\n    + '<div class=\"sub2\">' + esc(m.to) + ' \u00b7 ' + esc(fmtDateTime(m.at)) + '</div></div>').join('') : 'No emails yet.';\n}\nasync function saveEmailCfg(){\n  const res = await act('emailCfgSave', { apiKey: $('em-key').value, from: $('em-from').value }, 'Email setup saved.');\n  if(res){ D.admin = res.admin; renderEmailCfg(); }\n}\nasync function refreshAdminInfo(){\n  const res = await act('adminInfo', {});\n  if(res){ D.admin = res.admin; renderTrigger(); renderEmailCfg(); }\n}\nasync function downloadBackup(){\n  const res = await act('exportAll', {});\n  if(!res) return;\n  const blob = new Blob([JSON.stringify(res, null, 2)], { type:'application/json' });\n  const a = document.createElement('a');\n  a.href = URL.createObjectURL(blob); a.download = 'clinic-hub-backup-' + new Date().toISOString().slice(0,10) + '.json';\n  document.body.appendChild(a); a.click(); a.remove();\n  setTimeout(() => URL.revokeObjectURL(a.href), 1500);\n}\n\nfunction renderUsers(){\n  const me = D.me.username;\n  $('usersBody').innerHTML = D.users.map(u =>\n    '<tr><td><strong>' + esc(u.name) + '</strong>' + (u.username === me ? ' <span class=\"tag blue\">You</span>' : '') + '</td>'\n    + '<td>' + esc(u.username) + '</td><td>' + esc(u.email || '\u2014') + '</td>'\n    + '<td>' + (u.role === 'admin' ? '<span class=\"tag blue\">Admin</span>' : '<span class=\"tag gray\">Staff</span>') + '</td>'\n    + '<td><div class=\"rowactions\"><button class=\"btn btn-quiet btn-sm\" onclick=\"editUser(\\''+esc(u.username)+'\\')\">Edit</button>'\n    + '<button class=\"btn btn-white btn-sm\" onclick=\"resetPw(\\''+esc(u.username)+'\\')\">Reset password</button>'\n    + (u.username !== me ? '<button class=\"btn btn-white btn-sm\" onclick=\"deleteUser(\\''+esc(u.username)+'\\')\">Delete</button>' : '')\n    + '</div></td></tr>').join('');\n}\nasync function addUser(){\n  const payload = { name:$('u-name').value, username:$('u-user').value, email:$('u-email').value, role:$('u-role').value, password:$('u-pass').value };\n  const res = await act('userAdd', payload, payload.email ? 'Account added. They were emailed the link and username. Give them their temporary password.' : 'Account added. Give them the link, their username and temporary password.');\n  if(!res) return;\n  D.users = res.users; ['u-name','u-user','u-email','u-pass'].forEach(id => $(id).value = ''); $('u-role').value = 'staff';\n  renderUsers(); renderScheduleEditor();\n}\nasync function editUser(username){\n  const u = D.users.find(x => x.username === username); if(!u) return;\n  const r = await ask({ title:'Edit ' + u.name, okText:'Save', fields:[\n    { id:'name', label:'Name', value:u.name, required:true },\n    { id:'email', label:'Email', type:'email', value:u.email || '' },\n    { id:'role', label:'Role', type:'select', value:u.role, options:[{value:'staff',label:'Staff'},{value:'admin',label:'Admin'}] }\n  ]});\n  if(!r) return;\n  const res = await act('userUpdate', Object.assign({ username }, r), 'Saved.');\n  if(res){ D.users = res.users; renderUsers(); renderScheduleEditor(); renderCleaning(); }\n}\nasync function resetPw(username){\n  const r = await ask({ title:'Reset password for ' + userName(username), okText:'Set password',\n    fields:[{ id:'password', label:'New temporary password (6+ characters)', required:true, min:6, requiredMsg:'Password must be at least 6 characters.' }] });\n  if(!r) return;\n  await act('userResetPw', { username, password: r.password }, 'Password reset.');\n}\nasync function deleteUser(username){\n  if(!await confirmBox('Delete account?', userName(username) + ' will no longer be able to sign in. Their past sign-offs and QC entries stay in the records.', 'Delete account', true)) return;\n  const res = await act('userDelete', { username }, 'Account deleted.');\n  if(res){ D.users = res.users; renderUsers(); renderScheduleEditor(); renderCleaning(); }\n}\n\nfunction renderScheduleEditor(){\n  const names = {}; (D.users || []).forEach(u => { names[u.name] = 1; });\n  DAYS.forEach(d => { const w = (D.schedule[d] || {}).who || {}; Object.values(w).forEach(n => { if(n) names[n] = 1; }); });\n  names['Team'] = 1;\n  const dl = '<datalist id=\"schedPeople\">' + Object.keys(names).sort().map(n => '<option value=\"'+esc(n)+'\">').join('') + '</datalist>';\n  if($('rotateWeekly')) $('rotateWeekly').checked = D.rotateWeekly !== false;\n  $('schedEditor').innerHTML = dl + DAYS.map(d => {\n    const day = D.schedule[d] || { tasks:[], who:{} };\n    const rows = day.tasks.length ? day.tasks.map(t => [ (day.who || {})[t] || '', t ]) : [['','']];\n    return '<div class=\"daycard\"><h3>' + DAY_NAMES[d] + '</h3>'\n      + '<div class=\"shead\"><span>Person</span><span>Task</span><span></span></div>'\n      + '<div id=\"sr-'+d+'\">' + rows.map(r => schedRowHtml(r[0], r[1])).join('') + '</div>'\n      + '<button class=\"btn btn-link btn-sm\" onclick=\"addSchedRow(\\''+d+'\\')\">+ Add task</button></div>';\n  }).join('');\n}\nfunction schedRowHtml(person, task){\n  return '<div class=\"srow\"><input list=\"schedPeople\" placeholder=\"Name\" value=\"'+esc(person)+'\" aria-label=\"Person\">'\n    + '<input placeholder=\"Task (e.g. Sweep)\" value=\"'+esc(task)+'\" aria-label=\"Task\">'\n    + '<button class=\"x\" title=\"Remove\" onclick=\"this.parentNode.remove()\">\u00d7</button></div>';\n}\nfunction addSchedRow(d){ $('sr-'+d).insertAdjacentHTML('beforeend', schedRowHtml('', '')); }\nasync function saveSchedule(){\n  const schedule = {};\n  for(const d of DAYS){\n    const tasks = [], who = {}, seen = {};\n    for(const row of $('sr-'+d).querySelectorAll('.srow')){\n      const [pi, ti] = row.querySelectorAll('input');\n      const person = pi.value.trim(), task = ti.value.trim();\n      if(!task){ if(person){ toast('Add a task for ' + person + ' on ' + DAY_NAMES[d] + '.', true); return; } continue; }\n      if(seen[task.toLowerCase()]){ toast('\"' + task + '\" is listed twice on ' + DAY_NAMES[d] + '. Make each task name different (e.g. \"Sweep \u2013 front\").', true); return; }\n      seen[task.toLowerCase()] = 1; tasks.push(task); if(person) who[task] = person;\n    }\n    schedule[d] = { tasks, who };\n  }\n  const res = await act('settingsSave', { schedule, rotateWeekly: $('rotateWeekly') ? $('rotateWeekly').checked : true }, 'Schedule saved.');\n  if(res){ D.schedule = res.schedule; D.weekSchedule = res.weekSchedule; D.rotateWeekly = res.rotateWeekly; renderScheduleEditor(); renderCleaning(); }\n}\nasync function saveEmailSettings(){\n  const res = await act('settingsSave', { notifyEmail: $('set-email').value, morningHour: $('set-morning').value, checkHour: $('set-check').value, startDate: $('set-start') ? $('set-start').value : undefined }, 'Email settings saved.');\n  if(res){ D.settings = res.settings; D.startDate = res.startDate || ''; renderCleaning(); }\n}\nasync function saveQcTests(){\n  const res = await act('settingsSave', { qcTests: $('set-qctests').value.split('\\n').map(s => s.trim()).filter(Boolean) }, 'QC test list saved.');\n  if(res){ D.qcTests = res.qcTests; renderQC(); }\n}\nasync function testEmail(){\n  const res = await act('testEmail', {});\n  if(res){ toast('Test email queued for ' + res.sentTo + '.'); setTimeout(refreshAdminInfo, 2500); }\n}\nasync function importOld(){\n  const url = $('imp-url').value.trim(), json = $('imp-json').value.trim();\n  if(!url && !json){ toast('Paste the old app link first.', true); return; }\n  const res = await act('importOld', { url, json, force: $('imp-force').checked });\n  if(!res) return;\n  D.items = res.items; D.orders = res.orders; renderSupplies();\n  toast('Imported ' + res.imported.items + ' items and ' + res.imported.orders + ' orders.');\n  $('imp-url').value = ''; $('imp-json').value = '';\n}\n\n/* ---------- CSV helper ---------- */\nfunction downloadCSV(rows, filename){\n  const csv = rows.map(r => r.map(c => { const s = String(c ?? ''); return /[\",\\n]/.test(s) ? '\"' + s.replace(/\"/g,'\"\"') + '\"' : s; }).join(',')).join('\\n');\n  const blob = new Blob(['\ufeff' + csv], { type:'text/csv;charset=utf-8' });\n  const a = document.createElement('a');\n  a.href = URL.createObjectURL(blob); a.download = filename;\n  document.body.appendChild(a); a.click(); a.remove();\n  setTimeout(() => URL.revokeObjectURL(a.href), 1500);\n}\n\nstart();\n</script>\n</body>\n</html>\n";
