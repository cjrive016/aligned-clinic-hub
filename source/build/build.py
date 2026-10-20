#!/usr/bin/env python3
"""Builds dist/worker.js (single file to paste into Cloudflare) from the Apps Script version."""
import re, json, pathlib
ROOT = pathlib.Path(__file__).parent
HUB = pathlib.Path('/home/claude/hub')

def must_replace(s, old, new, count=1):
    n = s.count(old)
    assert n == count, f'expected {count} of {old[:60]!r}, found {n}'
    return s.replace(old, new)

def cut(s, start_pat, end_pat):
    a = s.index(start_pat); b = s.index(end_pat, a)
    return s[:a] + s[b:]

# ---------------- server logic ----------------
code = (HUB / 'Code.gs').read_text()
code = code[code.index('var CONFIG'):]            # drop Apps Script deploy header
code = cut(code, 'function doGet()', 'function appStatus()')
code = cut(code, '/** Run this once from the editor', '/* =====================================================================\n   ACTIONS')
code = cut(code, '/* =====================================================================\n   DATA STORE', '/* =====================================================================\n   SMALL HELPERS')
code = cut(code, 'function triggerOn_()', '/* =====================================================================')
code = cut(code, 'function a_triggersInstall_()', 'function a_testEmail_')
code = must_replace(code, "out.admin = { triggerOn: triggerOn_(), dbUrl: db_().getUrl(), appUrl: appUrl_() };", "out.admin = adminInfo_();")
assert 'db_()' not in code and 'SpreadsheetApp' not in code and 'ScriptApp.newTrigger' not in code

header = '''/**
 * ALIGNED CLINIC HUB — Cloudflare Worker (single file)
 * ----------------------------------------------------
 * Needs:  a D1 database binding named  DB
 *         a Cron Trigger that runs every 30 minutes
 * Tables are created automatically on first visit.
 * Email (Resend API key) is set from inside the app: Admin > Emails.
 */
'''

# ---------------- page ----------------
html = (HUB / 'Index.src.html').read_text()
old_index = (HUB / 'Index.html').read_text()
logo = re.search(r'src="(data:image/png;base64,[^"]+)"', (pathlib.Path('/home/claude/src/Index.html')).read_text()).group(1)

shim = '''<script>
/* talk to the Cloudflare worker the same way the page talked to Apps Script */
window.google = { script: { get run() {
  let ok = () => {}, bad = () => {};
  const p = new Proxy({}, { get(_, k) {
    if (k === 'withSuccessHandler') return f => { ok = f; return p; };
    if (k === 'withFailureHandler') return f => { bad = f; return p; };
    return (...args) => fetch('/api', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ fn: k, args }) })
      .then(r => r.json()).then(ok, bad);
  } });
  return p;
} } };
</script>'''
html = must_replace(html, '<base target="_top">\n', '')
html = must_replace(html, '</head>', shim + '\n</head>')

# Emails card -> Resend setup + status + log
old_emails = html[html.index('      <div class="card">\n        <div class="cardhead"><h2>Emails</h2>'):html.index('      <div class="card">\n        <div class="cardhead"><h2>CLIA QC test list</h2>')]
new_emails = '''      <div class="card">
        <div class="cardhead"><h2>Emails</h2><span id="trigPill"></span></div>
        <div class="formgrid">
          <div class="full"><label for="set-email">Send alerts to</label><input id="set-email" type="email"></div>
          <div><label for="set-morning">Morning reminder</label><select id="set-morning" class="hourSelect"></select></div>
          <div><label for="set-check">"Not done" check</label><select id="set-check" class="hourSelect"></select></div>
          <div><label for="set-start">Cleaning starts on</label><input id="set-start" type="date"></div>
        </div>
        <div class="formactions"><button class="btn btn-primary" onclick="saveEmailSettings()">Save</button>
          <button class="btn btn-white" onclick="testEmail()">Send test email</button></div>
        <p class="muted" style="margin-top:12px">You get an email when: an order is requested · someone does a task on a day they're not assigned (with their reason) · tasks aren't done by the check time · a QC check fails.</p>
      </div>

      <div class="card">
        <div class="cardhead"><h2>Email sending</h2><span id="emailPill"></span></div>
        <p class="muted" style="margin-bottom:12px">Emails go out through <strong>Resend</strong> (free). Make an account at resend.com, create an API key, and paste it here. Until then, every alert is still saved in the log below.</p>
        <div class="formgrid">
          <div class="full"><label for="em-key">Resend API key</label><input id="em-key" autocomplete="off" placeholder="re_…"></div>
          <div class="full"><label for="em-from">From address (after you verify your domain in Resend)</label><input id="em-from" placeholder="Clinic Hub &lt;hub@alignedhealthmurray.com&gt;"></div>
        </div>
        <div class="formactions"><button class="btn btn-primary" onclick="saveEmailCfg()">Save email setup</button></div>
        <h3 style="font-size:14px;margin:16px 0 8px">Recent emails</h3>
        <div id="emailLog" class="muted"></div>
      </div>

'''
html = html.replace(old_emails, new_emails)

# Data card -> backup download
old_data = html[html.index('      <div class="card">\n        <div class="cardhead"><h2>Data</h2>'):html.index('    </div>\n  </section>\n</main>')]
new_data = '''      <div class="card">
        <div class="cardhead"><h2>Backup</h2></div>
        <p class="muted" style="margin-bottom:12px">Everything is stored in your Cloudflare account. Download a full copy any time for your records.</p>
        <div class="formactions" style="margin-top:0"><button class="btn btn-white" onclick="downloadBackup()">Download full backup</button></div>
      </div>
'''
html = html.replace(old_data, new_data)

# admin JS
html = must_replace(html, """  renderTrigger();
  if(D.admin && D.admin.dbUrl) $('dbLink').href = D.admin.dbUrl;""", """  renderTrigger();
  renderEmailCfg();""")
html = must_replace(html, """function renderTrigger(){
  const on = D.admin && D.admin.triggerOn;
  $('trigPill').innerHTML = '<span class="pill ' + (on ? 'on' : 'off') + '"><span class="dot"></span>' + (on ? 'Automatic emails on' : 'Automatic emails off') + '</span>';
  $('trigBtn').textContent = on ? 'Re-install automatic emails' : 'Turn on automatic emails';
}""", """function renderTrigger(){
  const a = D.admin || {};
  const on = a.triggerOn;
  $('trigPill').innerHTML = '<span class="pill ' + (on ? 'on' : 'off') + '"><span class="dot"></span>' + (on ? 'Daily checks running' : 'Daily checks not running yet') + '</span>';
}
function renderEmailCfg(){
  const a = D.admin || {};
  $('emailPill').innerHTML = '<span class="pill ' + (a.emailOn ? 'on' : 'off') + '"><span class="dot"></span>' + (a.emailOn ? 'Connected ' + esc(a.emailKeyHint || '') : 'Not set up') + '</span>';
  $('em-key').value = '';
  $('em-key').placeholder = a.emailOn ? 'Saved (' + (a.emailKeyHint || '') + ') — paste a new key to replace' : 're_…';
  $('em-from').value = a.emailFrom || '';
  const log = a.emailLog || [];
  const tag = st => st === 'sent' ? '<span class="tag green">Sent</span>' : /^failed/.test(st) ? '<span class="tag red" title="' + esc(st) + '">Failed</span>' : '<span class="tag gray" title="' + esc(st) + '">Not sent</span>';
  $('emailLog').innerHTML = log.length ? log.slice(0, 15).map(m => '<div style="padding:8px 0;border-bottom:1px solid var(--line)"><div style="display:flex;justify-content:space-between;gap:8px;align-items:flex-start"><strong style="color:var(--ink);font-size:13px">' + esc(m.subject) + '</strong>' + tag(m.status) + '</div>'
    + '<div class="sub2">' + esc(m.to) + ' · ' + esc(fmtDateTime(m.at)) + '</div></div>').join('') : 'No emails yet.';
}
async function saveEmailCfg(){
  const res = await act('emailCfgSave', { apiKey: $('em-key').value, from: $('em-from').value }, 'Email setup saved.');
  if(res){ D.admin = res.admin; renderEmailCfg(); }
}
async function refreshAdminInfo(){
  const res = await act('adminInfo', {});
  if(res){ D.admin = res.admin; renderTrigger(); renderEmailCfg(); }
}
async function downloadBackup(){
  const res = await act('exportAll', {});
  if(!res) return;
  const blob = new Blob([JSON.stringify(res, null, 2)], { type:'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob); a.download = 'clinic-hub-backup-' + new Date().toISOString().slice(0,10) + '.json';
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 1500);
}""")
html = must_replace(html, """async function installTriggers(){
  const res = await act('triggersInstall', {}, 'Automatic emails are on.');
  if(res){ D.admin.triggerOn = res.triggerOn; renderTrigger(); }
}
""", "")
html = must_replace(html, """  const res = await act('testEmail', {});
  if(res) toast('Test email sent to ' + res.sentTo + '.');""", """  const res = await act('testEmail', {});
  if(res){ toast('Test email queued for ' + res.sentTo + '.'); setTimeout(refreshAdminInfo, 2500); }""")
html = must_replace(html, "<p class=\"muted\" style=\"margin-bottom:10px\">Do this once. Paste the old inventory app link (the one in your Chrome bookmark).</p>",
                    "<p class=\"muted\" style=\"margin-bottom:10px\">Do this once. Paste the link from your “Aligned Inventory” Chrome bookmark.</p>")
html = html.replace('{{LOGO}}', logo)
assert 'trigBtn' not in html and 'dbLink' not in html

(ROOT / 'dist').mkdir(exist_ok=True)
(ROOT / 'dist' / 'index.html').write_text(html)

worker = header + '\n' + (ROOT / 'src/shims.js').read_text() + '\n' + code + '\n' + (ROOT / 'src/store.js').read_text() + '\n' + \
    (ROOT / 'src/entry.js').read_text() + '\n\nconst PAGE_HTML = ' + json.dumps(html) + ';\n'
(ROOT / 'dist' / 'worker.js').write_text(worker)
print('worker.js', len(worker), 'bytes')
