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
