/**
 * ALIGNED CLINIC HUB — Google Apps Script backend
 * =================================================
 * Tabs: Cleaning sign-off · Supplies (inventory & ordering) · CLIA QC log · Admin
 *
 * HOW TO PUT IT ONLINE (one time)
 *  1. script.google.com > New project. Name it "Aligned Clinic Hub".
 *  2. Replace Code.gs with this file. Add an HTML file named "Index" and paste Index.html.
 *     (Optional) Project Settings > show appsscript.json > paste the included appsscript.json.
 *  3. Deploy > New deployment > type: Web app
 *        Execute as: Me      Who has access: Anyone
 *     Approve the Google permission screens (email, sheets, triggers).
 *  4. Open the web-app link. Enter the SETUP_CODE below and create your admin account.
 *  5. Admin tab > "Turn on automatic emails".
 *
 * All data is saved in a Google Sheet ("Aligned Clinic Hub — Data") in your Drive.
 * Things you may want to change are marked  >>> EDIT ME
 */

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
  Orders:   ['id', 'itemId', 'name', 'qty', 'price', 'assignTo', 'by', 'note', 'status', 'requestedAt', 'orderedAt', 'receivedAt', 'supplier'],
  Quotes:   ['id', 'item', 'supplier', 'price', 'packQty', 'notes', 'updatedBy', 'updatedAt', 'byUser'],
  Cleaning: ['id', 'date', 'day', 'task', 'assigned', 'assignedName', 'doneBy', 'doneByName', 'doneAt', 'offAssignment', 'late', 'comment', 'kind'],
  Pricing:  ['id', 'grp', 'sort', 'code', 'dose', 'doseMg', 'volMl', 'units', 'price', 'vial', 'updatedBy', 'updatedAt'],
  Meds:     ['id', 'name', 'ndc', 'lot', 'expiration', 'qty', 'location', 'notes', 'addedBy', 'addedAt', 'updatedBy', 'updatedAt'],
  Swaps:    ['id', 'date', 'task', 'fromName', 'toName', 'coverId', 'origDate', 'createdAt'],
  Notes:    ['id', 'wall', 'text', 'color', 'fromUser', 'fromName', 'createdAt', 'seenAt', 'done', 'doneAt', 'doneBy', 'groupId', 'walls', 'deleted', 'deletedAt', 'deletedBy', 'editedAt', 'authorFlag'],
  NoteComments: ['id', 'noteKey', 'text', 'byUser', 'byName', 'at', 'kind'],
  Events:   ['id', 'date', 'endDate', 'kind', 'title', 'time', 'notes', 'byUser', 'byName', 'createdAt', 'updatedAt'],
  QC:       ['id', 'loggedAt', 'test', 'lot', 'expiration', 'reason', 'posControl', 'negControl', 'result', 'byName', 'by', 'notes', 'voided', 'voidReason', 'voidedBy']
};
var KEYS = { Users: 'username' };
var NUM_FIELDS = { qty: 1, price: 1, reorderAt: 1 };
var BOOL_FIELDS = { paid: 1, active: 1, offAssignment: 1, late: 1, voided: 1, done: 1, deleted: 1, authorFlag: 1 };
var DATE_ONLY = { date: 1, expiration: 1 };

/* =====================================================================
   PUBLIC ENTRY POINTS (callable from the page)
   Every other function ends with "_" so the page cannot call it.
   ===================================================================== */

function doGet() {
  return HtmlService.createHtmlOutputFromFile('Index')
    .setTitle(CONFIG.APP_NAME)
    .addMetaTag('viewport', 'width=device-width, initial-scale=1')
    .setXFrameOptionsMode(HtmlService.XFrameOptionsMode.DEFAULT);
}

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

/** Run this once from the editor if Google asks you to authorize. Safe to run any time. */
function authorize() {
  db_();
  MailApp.getRemainingDailyQuota();
  ScriptApp.getProjectTriggers();
  return 'ok';
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
  quoteSave:        { fn: a_quoteSave_, write: true },
  quoteDelete:      { fn: a_quoteDelete_, write: true },
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
  eventSave:        { fn: a_eventSave_, write: true },
  eventDelete:      { fn: a_eventDelete_, write: true },
  notePurge:        { fn: a_notePurge_, write: true, admin: true },
  medDelete:        { fn: a_medDelete_, write: true, admin: true },
  priceSave:        { fn: a_priceSave_, write: true, admin: true },
  priceDelete:      { fn: a_priceDelete_, write: true, admin: true },
  priceNoteSave:    { fn: a_priceNoteSave_, write: true, admin: true },

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
    quotes: clean_(rows_('Quotes')),
    qc: clean_(rows_('QC')),
    meds: clean_(rows_('Meds')),
    events: clean_(rows_('Events')),
    pricing: pricing_(),
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
    out.admin = { triggerOn: triggerOn_(), dbUrl: db_().getUrl(), appUrl: appUrl_() };
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
  return { items: clean_(rows_('Items')), orders: clean_(rows_('Orders')), quotes: clean_(rows_('Quotes')) };
}

/* ---------- price comparison: what each supplier charges for an item ---------- */
function a_quoteSave_(me, p) {
  var item = str_(p.item).slice(0, 120), supplier = str_(p.supplier).slice(0, 80);
  if (!item) throw userErr_('Which item is this price for?');
  if (!supplier) throw userErr_('Where is this price from? (e.g. Amazon, McKesson, Henry Schein)');
  var price = parseFloat(String(p.price == null ? '' : p.price).replace(/[$,\s]/g, ''));
  if (!isFinite(price) || price < 0) throw userErr_('Enter the price, like 24.99.');
  var pack = parseInt(p.packQty, 10); if (!isFinite(pack) || pack < 1) pack = 1;
  var data = { item: item, supplier: supplier, price: String(round2_(price)), packQty: String(pack), notes: str_(p.notes).slice(0, 300),
               updatedBy: me.name, updatedAt: nowIso_() };
  var rec = p.id ? find_('Quotes', p.id) : null;
  if (!rec) {   // same item + supplier → update that price instead of adding a duplicate
    rec = rows_('Quotes').filter(function (q) { return q.item.toLowerCase() === item.toLowerCase() && q.supplier.toLowerCase() === supplier.toLowerCase(); })[0] || null;
  }
  if (rec) {
    if (!quoteCanEdit_(me, rec)) throw userErr_((rec.updatedBy || 'Someone') + ' already saved a price from ' + rec.supplier + ' for this item. Only they or an admin can change it.');
    update_('Quotes', rec.id, data);
  } else { data.id = uid_(); data.byUser = me.username; insert_('Quotes', data); }
  return supplies_();
}
/** Admins can change any price; staff can change prices they added. */
function quoteCanEdit_(me, q) { return me.role === 'admin' || (!!q.byUser && q.byUser === me.username); }
function a_quoteDelete_(me, p) {
  var q = find_('Quotes', p.id);
  if (q) {
    if (!quoteCanEdit_(me, q)) throw userErr_('Only the person who added this price (or an admin) can delete it.');
    remove_('Quotes', q.id);
  }
  return supplies_();
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
  var patch = { status: 'ordered', orderedAt: nowIso_() };
  if (p.supplier !== undefined) patch.supplier = str_(p.supplier).slice(0, 80);
  if (p.price !== undefined && String(p.price).trim() !== '') {
    var pr = parseFloat(p.price);
    if (isFinite(pr) && pr >= 0) {
      patch.price = round2_(pr);
      if (o.itemId && find_('Items', o.itemId)) update_('Items', o.itemId, { price: patch.price });
    }
  }
  update_('Orders', o.id, patch);
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

/* =====================================================================
   GLP PRICING — everyone can view; only admins can change it
   ===================================================================== */
var DEFAULT_PRICING = [
  ['Semaglutide 1 mg/mL', 'SEMA1', '0.25 mg', '0.22', '0.22', '22', '100', '1 mL'],
  ['Semaglutide 1 mg/mL', 'SEMA2', '0.5 mg', '0.44', '0.44', '44', '129', '2 mL'],
  ['Semaglutide 4 mg/mL', 'SEMA3', '0.75 mg', '0.88', '0.22', '22', '160', '1 mL'],
  ['Semaglutide 4 mg/mL', 'SEMA4', '1 mg', '1.5', '0.38', '38', '180', '2 mL'],
  ['Semaglutide 4 mg/mL', 'SEMA5', '2 mg', '2.15', '0.54', '54', '200', '3 mL'],
  ['Semaglutide 4 mg/mL', 'SEMA6', '2.5 mg', '2.67', '0.67', '67', '200', '3 mL'],
  ['Tirzepatide 10 mg/mL', 'TIRZE1', '2.5 mg', '2.2', '0.22', '22', '180', '1 mL'],
  ['Tirzepatide 10 mg/mL', 'TIRZE2', '5 mg', '4.4', '0.44', '44', '210', '2 mL'],
  ['Tirzepatide 30 mg/mL', 'TIRZE3', '7.5 mg', '6.6', '0.22', '22', '250', '1 mL'],
  ['Tirzepatide 30 mg/mL', 'TIRZE4', '10 mg', '8.8', '0.29', '29', '290', '1.5 mL'],
  ['Tirzepatide 30 mg/mL', 'TIRZE5', '12.5 mg', '11', '0.37', '37', '290', '1.5 mL'],
  ['Tirzepatide 30 mg/mL', 'TIRZE6', '15 mg', '13.2', '0.44', '44', '290', '2 mL'],
  ['Tirzepatide 30 mg/mL', 'TIRZE7', '—', '16.6*', '0.55', '55', '340', '3 mL']
];
var DEFAULT_PRICING_NOTE = "* TIRZE7: weekly dose per Lexington's clinic sheet for the 3 mL vial. 55 units of 30 mg/mL delivers 16.5 mg. " +
  'This is above the 15 mg maximum commercial tirzepatide dose and requires provider approval.\n' +
  'Prices per 4-week vial · Updated October 2026 · Clinic pricing';
function pricing_() {
  var props = PropertiesService.getScriptProperties();
  if (!props.getProperty('pricing_seeded')) {
    props.setProperty('pricing_seeded', '1');
    if (!rows_('Pricing').length) {
      DEFAULT_PRICING.forEach(function (r, i) {
        insert_('Pricing', { id: uid_(), grp: r[0], sort: String(i + 1), code: r[1], dose: r[2], doseMg: r[3], volMl: r[4], units: r[5], price: r[6], vial: r[7], updatedBy: '', updatedAt: '' });
      });
      props.setProperty('pricing_note', DEFAULT_PRICING_NOTE);
    }
  }
  var rows = clean_(rows_('Pricing')).sort(function (a, b) { return Number(a.sort) - Number(b.sort); });
  return { rows: rows, note: props.getProperty('pricing_note') || '' };
}
function a_priceSave_(me, p) {
  var f = function (k, max) { return str_(p[k]).slice(0, max || 60); };
  var grp = f('grp', 80), code = f('code', 30);
  if (!grp) throw userErr_('Enter the medication / concentration (for example "Semaglutide 1 mg/mL").');
  if (!code) throw userErr_('Enter the procedure code.');
  var price = f('price').replace(/[$,\s]/g, '');
  if (price && !/^\d+(\.\d{1,2})?$/.test(price)) throw userErr_('Price should be a number, like 180 or 180.50.');
  var data = { grp: grp, code: code, dose: f('dose'), doseMg: f('doseMg'), volMl: f('volMl'), units: f('units'), price: price, vial: f('vial'),
               updatedBy: me.name, updatedAt: nowIso_() };
  var rec = p.id ? find_('Pricing', p.id) : null;
  if (rec) update_('Pricing', rec.id, data);
  else {
    var inGroup = rows_('Pricing').filter(function (r) { return r.grp === grp; });
    var pool = inGroup.length ? inGroup : rows_('Pricing');
    var max = 0;
    pool.forEach(function (r) { max = Math.max(max, Number(r.sort) || 0); });
    // new row goes at the end of its group; shift later rows down
    rows_('Pricing').forEach(function (r) { if ((Number(r.sort) || 0) > max) update_('Pricing', r.id, { sort: String(Number(r.sort) + 1) }); });
    data.id = uid_(); data.sort = String(max + 1);
    insert_('Pricing', data);
  }
  return { pricing: pricing_() };
}
function a_priceDelete_(me, p) {
  if (find_('Pricing', p.id)) remove_('Pricing', p.id);
  return { pricing: pricing_() };
}
function a_priceNoteSave_(me, p) {
  PropertiesService.getScriptProperties().setProperty('pricing_note', String(p.note || '').slice(0, 2000));
  return { pricing: pricing_() };
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
      groupId: groupId, walls: groupId ? wallList : '', deleted: false, deletedAt: '', deletedBy: '', editedAt: '', authorFlag: false });
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
  // and for the person who wrote the note (when it isn't on their own wall)
  var group = noteGroup_(n);
  var authorOnWall = group.some(function (x) { return x.wall === n.fromUser; });
  var flagAuthor = n.fromUser !== me.username && !authorOnWall;
  group.forEach(function (x) { update_('Notes', x.id, { authorFlag: flagAuthor }); });
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
function a_noteSeen_(me, p) {
  var now = nowIso_();
  if (p && p.view === 'sent') {
    rows_('Notes').forEach(function (n) { if (n.fromUser === me.username && n.authorFlag) update_('Notes', n.id, { authorFlag: false }); });
    return noteOut_(me);
  }
  rows_('Notes').forEach(function (n) { if (n.wall === me.username && !n.seenAt) update_('Notes', n.id, { seenAt: now }); });
  return noteOut_(me);
}

/* =====================================================================
   CALENDAR
   - Anyone can add days off, drug rep lunches, meetings, etc.
   - Only the person who added an entry (or an admin) can change or delete it.
   ===================================================================== */
var EVENT_KINDS = ['off', 'rep', 'meeting', 'other'];
function eventsOut_() { return { events: clean_(rows_('Events')) }; }
function isYmd_(s) { return /^\d{4}-\d{2}-\d{2}$/.test(String(s || '')); }
function a_eventSave_(me, p) {
  var kind = EVENT_KINDS.indexOf(p.kind) >= 0 ? p.kind : 'other';
  var date = str_(p.date), endDate = str_(p.endDate);
  if (!isYmd_(date)) throw userErr_('Pick a date.');
  if (endDate && !isYmd_(endDate)) endDate = '';
  if (endDate && endDate < date) throw userErr_('The "through" date is before the start date.');
  if (endDate === date) endDate = '';
  var title = str_(p.title).slice(0, 120);
  if (!title && kind !== 'off') throw userErr_(kind === 'rep' ? 'Enter the rep or company name.' : 'Enter what it is.');
  var fields = { date: date, endDate: endDate, kind: kind, title: title, time: str_(p.time).slice(0, 40), notes: str_(p.notes).slice(0, 500), updatedAt: nowIso_() };
  if (p.id) {
    var ev = find_('Events', p.id);
    if (!ev) throw userErr_('That calendar entry was removed. Refresh the page.');
    if (ev.byUser !== me.username && me.role !== 'admin') throw userErr_('Only ' + ev.byName + ' (or an admin) can change this entry.');
    update_('Events', ev.id, fields);
  } else {
    fields.id = uid_(); fields.byUser = me.username; fields.byName = me.name; fields.createdAt = nowIso_();
    insert_('Events', fields);
  }
  return eventsOut_();
}
function a_eventDelete_(me, p) {
  var ev = find_('Events', p.id);
  if (!ev) return eventsOut_();
  if (ev.byUser !== me.username && me.role !== 'admin') throw userErr_('Only ' + ev.byName + ' (or an admin) can delete this entry.');
  remove_('Events', ev.id);
  return eventsOut_();
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

function a_triggersInstall_() {
  ScriptApp.getProjectTriggers().forEach(function (t) {
    if (t.getHandlerFunction() === 'hourlyTick') ScriptApp.deleteTrigger(t);
  });
  ScriptApp.newTrigger('hourlyTick').timeBased().everyMinutes(30).create();
  return { triggerOn: triggerOn_() };
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

function triggerOn_() {
  return ScriptApp.getProjectTriggers().some(function (t) { return t.getHandlerFunction() === 'hourlyTick'; });
}

/* =====================================================================
   DATA STORE — a Google Sheet, one tab per table, everything stored as text
   ===================================================================== */

var _ss = null, _sheets = {}, _rows = {};

function db_() {
  if (_ss) return _ss;
  var props = PropertiesService.getScriptProperties();
  var id = props.getProperty('db_id');
  if (id) { try { _ss = SpreadsheetApp.openById(id); } catch (e) { _ss = null; } }
  if (!_ss) {
    _ss = SpreadsheetApp.create(CONFIG.APP_NAME + ' — Data');
    props.setProperty('db_id', _ss.getId());
  }
  return _ss;
}

function sheet_(name) {
  if (_sheets[name]) return _sheets[name];
  var ss = db_();
  var cols = TABLES[name];
  var sh = ss.getSheetByName(name);
  if (!sh) {
    sh = ss.insertSheet(name);
    sh.getRange(1, 1, sh.getMaxRows(), Math.max(cols.length, 26)).setNumberFormat('@');
    sh.getRange(1, 1, 1, cols.length).setValues([cols]).setFontWeight('bold');
    sh.setFrozenRows(1);
    var def = ss.getSheetByName('Sheet1');
    if (def && ss.getSheets().length > 1 && def.getLastRow() === 0) ss.deleteSheet(def);
  }
  _sheets[name] = sh;
  return sh;
}

function fromCell_(c, v) {
  if (v instanceof Date) v = DATE_ONLY[c] ? ymd_(v) : v.toISOString();
  if (NUM_FIELDS[c]) return (v === '' || v === null) ? null : Number(v);
  if (BOOL_FIELDS[c]) return v === true || String(v).toUpperCase() === 'TRUE';
  return v === null || v === undefined ? '' : String(v);
}

function toCell_(c, v) {
  if (NUM_FIELDS[c]) return (v === null || v === undefined || v === '' || !isFinite(Number(v))) ? '' : String(v);
  if (BOOL_FIELDS[c]) return v ? 'TRUE' : '';
  return v === null || v === undefined ? '' : String(v);
}

function rows_(name) {
  if (_rows[name]) return _rows[name];
  var sh = sheet_(name);
  var cols = TABLES[name];
  var key = KEYS[name] || 'id';
  var last = sh.getLastRow();
  var out = [];
  if (last >= 2) {
    var vals = sh.getRange(2, 1, last - 1, cols.length).getValues();
    for (var i = 0; i < vals.length; i++) {
      var o = { _row: i + 2 };
      for (var j = 0; j < cols.length; j++) o[cols[j]] = fromCell_(cols[j], vals[i][j]);
      if (o[key] !== '') out.push(o);
    }
  }
  _rows[name] = out;
  return out;
}

function find_(name, id) {
  var key = KEYS[name] || 'id';
  if (id === null || id === undefined || id === '') return null;
  return rows_(name).filter(function (r) { return r[key] === String(id); })[0] || null;
}

function insert_(name, obj) {
  insertMany_(name, [obj]);
}

function insertMany_(name, list) {
  if (!list.length) return;
  var cols = TABLES[name];
  var sh = sheet_(name);
  var start = sh.getLastRow() + 1;
  if (sh.getMaxRows() < start + list.length) sh.insertRowsAfter(sh.getMaxRows(), list.length + 10);
  sh.getRange(start, 1, list.length, cols.length).setNumberFormat('@')
    .setValues(list.map(function (o) { return cols.map(function (c) { return toCell_(c, o[c]); }); }));
  delete _rows[name];
}

function update_(name, id, patch) {
  var r = find_(name, id);
  if (!r) return;
  var cols = TABLES[name];
  var merged = merge_(r, patch);
  sheet_(name).getRange(r._row, 1, 1, cols.length).setValues([cols.map(function (c) { return toCell_(c, merged[c]); })]);
  delete _rows[name];
}

function remove_(name, id) {
  var r = find_(name, id);
  if (!r) return;
  sheet_(name).deleteRow(r._row);
  delete _rows[name];
}

function clean_(list) {
  return list.map(function (r) { var o = {}; for (var k in r) if (k !== '_row') o[k] = r[k]; return o; });
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
