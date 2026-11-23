/* backup.js — MODE LOKAL: hanya backup & pulihkan lewat file.
   Sinkron cloud dan kode sync DIMATIKAN sementara; tidak ada koneksi ke server.
   Kontrak dengan tagihan.html: window.LaporanBackup.open(), .last, dan event laporan-sync-state. */
(function () {
  'use strict';
  var CH = 600000, K_DEV = 'lb_dev';

  var D_PJ = { db: 'pj-v1', st: 'pj-data' };
  var OTHERS = [
    { db: 'pjbatal-v1', st: 'pjbatal-data' },
    { db: 'pjharga-v1', st: 'pjharga-data' },
    { db: 'pjuangmasuk-v1', st: 'pjuangmasuk-data' },
    { db: 'pjtagihan-v1', st: 'pjtagihan-data' },
    { db: 'pjtitip-v1', st: 'pjtitip-data' },
    { db: 'pjitembatal-v1', st: 'pjitembatal-data' }];   // Batal item per faktur   // Cek Titip
  var D_ARSIP = { db: 'pjarsip-v1', st: 'arsip' };   // Arsip riwayat Tagihan & Uang Masuk (banyak kunci)
  var D_PARSE = { db: 'pj-parse-v1', st: 'c' };

  var busy = false, restoring = false;
  var LB = { last: { kind: 'ok', msg: 'Mode lokal: data tersimpan di perangkat ini' } };
  window.LaporanBackup = LB;

  /* ---------- util ---------- */
  function pad(n) { return String(n).padStart(2, '0'); }
  function lsGet(k) { try { return localStorage.getItem(k) || ''; } catch (e) { return ''; } }
  function lsSet(k, v) { try { localStorage.setItem(k, v); } catch (e) {} }
  function devId() { var d = lsGet(K_DEV); if (!d) { d = 'd' + Math.random().toString(36).slice(2, 8); lsSet(K_DEV, d); } return d; }
  function setState(kind, msg) {
    LB.last = { kind: kind, msg: msg || '' };
    var el = document.getElementById('lbStatus'); if (el) el.textContent = msg || '';
    try { window.dispatchEvent(new CustomEvent('laporan-sync-state', { detail: LB.last })); } catch (e) {}
  }
  function errMsg(e) {
    var m = String(e && e.message || e);
    if (/Failed to fetch|NetworkError|Load failed/i.test(m)) return 'Tidak bisa terhubung ke server';
    return 'Gagal: ' + m;
  }
  function hhmm() { var d = new Date(); return pad(d.getHours()) + ':' + pad(d.getMinutes()); }

  /* ---------- IndexedDB (store dibuat persis seperti index.html) ---------- */
  function open(def) {
    return new Promise(function (ok, no) {
      var r = indexedDB.open(def.db, 1);
      r.onupgradeneeded = function () { if (!r.result.objectStoreNames.contains(def.st)) r.result.createObjectStore(def.st); };
      r.onsuccess = function () { var db = r.result; db.onversionchange = function () { db.close(); }; ok(db); };
      r.onerror = function () { no(r.error); };
    });
  }
  function idbGet(def) {
    return open(def).then(function (db) {
      return new Promise(function (ok, no) {
        var q = db.transaction(def.st, 'readonly').objectStore(def.st).get('latest');
        q.onsuccess = function () { db.close(); ok(q.result); };
        q.onerror = function () { db.close(); no(q.error); };
      });
    });
  }
  function idbPut(def, val) {
    return open(def).then(function (db) {
      return new Promise(function (ok, no) {
        var tx = db.transaction(def.st, 'readwrite'); tx.objectStore(def.st).put(val, 'latest');
        tx.oncomplete = function () { db.close(); ok(); };
        tx.onerror = tx.onabort = function () { db.close(); no(tx.error); };
      });
    });
  }
  function idbGetAll(def) {   // semua kunci -> objek {kunci: nilai}
    return open(def).then(function (db) {
      return new Promise(function (ok, no) {
        var o = {}, c = db.transaction(def.st, 'readonly').objectStore(def.st).openCursor();
        c.onsuccess = function () { var cur = c.result; if (cur) { o[cur.key] = cur.value; cur.continue(); } else { db.close(); ok(o); } };
        c.onerror = function () { db.close(); no(c.error); };
      });
    });
  }
  function idbPutAll(def, obj) {   // ganti seluruh isi store dengan objek {kunci: nilai}
    return open(def).then(function (db) {
      return new Promise(function (ok, no) {
        var tx = db.transaction(def.st, 'readwrite'), st = tx.objectStore(def.st);
        st.clear(); Object.keys(obj || {}).forEach(function (k) { st.put(obj[k], k); });
        tx.oncomplete = function () { db.close(); ok(); };
        tx.onerror = tx.onabort = function () { db.close(); no(tx.error); };
      });
    });
  }
  function putOthers(o) {   // tulis semua data selain file penjualan (dipakai saat pulihkan)
    return Promise.all(OTHERS.map(function (d) { return o[d.db] !== undefined ? idbPut(d, dec(o[d.db])) : Promise.resolve(); })
      .concat([o[D_ARSIP.db] !== undefined ? idbPutAll(D_ARSIP, dec(o[D_ARSIP.db])) : Promise.resolve()]));
  }
  function idbClear(def) {
    return open(def).then(function (db) {
      return new Promise(function (ok) {
        var tx = db.transaction(def.st, 'readwrite'); tx.objectStore(def.st).clear();
        tx.oncomplete = tx.onerror = tx.onabort = function () { db.close(); ok(); };
      });
    });
  }

  /* ---------- serialisasi ---------- */
  function ab2b64(buf) {
    var u = new Uint8Array(buf), s = '';
    for (var i = 0; i < u.length; i += 0x8000) s += String.fromCharCode.apply(null, u.subarray(i, i + 0x8000));
    return btoa(s);
  }
  function b642ab(b) { var s = atob(b), u = new Uint8Array(s.length); for (var i = 0; i < s.length; i++) u[i] = s.charCodeAt(i); return u.buffer; }
  function enc(v) {
    if (v === null || typeof v !== 'object') return v;
    if (v instanceof ArrayBuffer) return { __t: 'ab', d: ab2b64(v) };
    if (ArrayBuffer.isView(v)) return { __t: 'view', c: v.constructor.name, d: ab2b64(v.buffer.slice(v.byteOffset, v.byteOffset + v.byteLength)) };
    if (v instanceof Map) return { __t: 'map', d: Array.from(v.entries()).map(function (e) { return [enc(e[0]), enc(e[1])]; }) };
    if (v instanceof Set) return { __t: 'set', d: Array.from(v.values()).map(enc) };
    if (v instanceof Date) return { __t: 'date', d: v.getTime() };
    if (Array.isArray(v)) return v.map(enc);
    var o = {}; Object.keys(v).forEach(function (k) { o[k] = enc(v[k]); }); return o;
  }
  function dec(v) {
    if (v === null || typeof v !== 'object') return v;
    if (Array.isArray(v)) return v.map(dec);
    if (v.__t === 'ab') return b642ab(v.d);
    if (v.__t === 'view') { var C = window[v.c] || Uint8Array; return new C(b642ab(v.d)); }
    if (v.__t === 'map') return new Map(v.d.map(function (e) { return [dec(e[0]), dec(e[1])]; }));
    if (v.__t === 'set') return new Set(v.d.map(dec));
    if (v.__t === 'date') return new Date(v.d);
    var o = {}; Object.keys(v).forEach(function (k) { o[k] = dec(v[k]); }); return o;
  }
  function fid(buf) {      // sidik jari isi file (2 hash 32-bit + panjang)
    var u = new Uint8Array(buf), h1 = 0x811c9dc5, h2 = 5381;
    for (var i = 0; i < u.length; i++) { h1 ^= u[i]; h1 = Math.imul(h1, 16777619); h2 = (Math.imul(h2, 33) + u[i]) | 0; }
    return (h1 >>> 0).toString(36) + (h2 >>> 0).toString(36) + '-' + u.length.toString(36);
  }
  function hashStr(s) { var h = 0x811c9dc5; for (var i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); } return (h >>> 0).toString(36) + '-' + s.length.toString(36); }

  /* ---------- baca data lokal ---------- */
  function readFiles() {
    return idbGet(D_PJ).then(function (v) {
      var out = [];
      ((v && v.files) || []).forEach(function (f) {
        var buf = null;
        if (f.buf instanceof ArrayBuffer) buf = f.buf;
        else if (f.buf && ArrayBuffer.isView(f.buf)) buf = f.buf.buffer.slice(f.buf.byteOffset, f.buf.byteOffset + f.buf.byteLength);
        else if (typeof f.b64 === 'string') buf = b642ab(f.b64);
        if (buf) out.push({ name: f.name, buf: buf });
      });
      return out;
    }).catch(function () { return []; });
  }
  function readOtherJson() {
    var o = {};
    return Promise.all(OTHERS.map(function (d) { return idbGet(d).then(function (v) { if (v !== undefined) o[d.db] = enc(v); }); })
      .concat([idbGetAll(D_ARSIP).then(function (m) { if (Object.keys(m).length) o[D_ARSIP.db] = enc(m); }).catch(function () {})]))
      .then(function () { return JSON.stringify(o); });
  }
  function localSig() {
    return Promise.all([readFiles(), readOtherJson()]).then(function (a) {
      var s = a[0].map(function (f) { return f.name + '|' + fid(f.buf); }).join(';') + '#' + a[1];
      return { sig: hashStr(s), files: a[0], other: a[1] };
    });
  }

  function exportFile() {
    setState('busy', 'Menyiapkan file backup…');
    return Promise.all([readFiles(), readOtherJson()]).then(function (a) {
      var payload = { v: 2, at: Date.now(), files: a[0].map(function (f) { return { name: f.name, b64: ab2b64(f.buf) }; }), other: JSON.parse(a[1]) };
      var blob = new Blob([JSON.stringify(payload)], { type: 'application/json' });
      var el = document.createElement('a'), d = new Date();
      el.href = URL.createObjectURL(blob);
      el.download = 'backup-laporan-' + d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()) + '.json';
      document.body.appendChild(el); el.click(); el.remove();
      setTimeout(function () { URL.revokeObjectURL(el.href); }, 5000);
      setState('ok', '💾 File backup diunduh');
    }).catch(function (e) { setState('error', errMsg(e)); });
  }
  function importFile(file) {
    if (!file) return;
    if (!confirm('Data di perangkat ini akan DIGANTI dengan isi file "' + file.name + '". Lanjutkan?')) return;
    setState('busy', 'Membaca file backup…');
    var fr = new FileReader();
    fr.onerror = function () { setState('error', 'File tidak bisa dibaca'); };
    fr.onload = function () {
      var p;
      try { p = JSON.parse(fr.result); } catch (e) { setState('error', 'File bukan backup yang valid'); return; }
      var other = p && (p.other || null), files = p && p.files;
      if (p && p.stores && !other) {   // format backup versi sebelumnya
        other = {}; OTHERS.forEach(function (d) { if (p.stores[d.db] !== undefined) other[d.db] = p.stores[d.db]; });
        var pj = p.stores[D_PJ.db]; files = pj && pj.files ? pj.files.map(function (f) { return { name: f.name, b64: f.buf && f.buf.__t === 'ab' ? f.buf.d : f.b64 }; }) : [];
      }
      if (!files || !other) { setState('error', 'File bukan backup yang valid'); return; }
      restoring = true;
      idbPut(D_PJ, { files: files.filter(function (f) { return typeof f.b64 === 'string'; }).map(function (f) { return { name: f.name, buf: b642ab(f.b64) }; }) })
        .then(function () { return putOthers(other); })
        .then(function () { return idbClear(D_PARSE); })
        .then(function () { setState('busy', 'Selesai, memuat ulang…'); setTimeout(function () { location.reload(); }, 300); })
        .catch(function (e) { restoring = false; setState('error', errMsg(e)); });
    };
    fr.readAsText(file);
  }

  /* ---------- tampilan ---------- */
  function ui() {
    var ov = document.getElementById('lbOverlay'); if (ov) return ov;
    ov = document.createElement('div'); ov.id = 'lbOverlay';
    ov.style.cssText = 'position:fixed;inset:0;z-index:10000;background:rgba(0,0,0,.5);display:none;align-items:center;justify-content:center;padding:12px';
    var btn = 'display:block;width:100%;margin:.35rem 0;padding:.55rem .7rem;border:1px solid var(--border,#ccc);border-radius:8px;background:var(--card,#fff);color:var(--text,#222);font:600 .9rem system-ui,sans-serif;cursor:pointer;text-align:left';
    ov.innerHTML =
      '<div style="width:100%;max-width:430px;max-height:92vh;overflow:auto;background:var(--card,#fff);color:var(--text,#222);border:1px solid var(--border,#ccc);border-radius:12px;padding:1rem 1.1rem;font-family:system-ui,sans-serif">' +
      '<h3 style="margin:0 0 .3rem;font-size:1.05rem">💾 Backup Data</h3>' +
      '<p style="margin:0 0 .6rem;font-size:.8rem;opacity:.75">Mode lokal: data tersimpan di perangkat ini saja. Unduh file backup secara berkala, dan pulihkan dari file bila pindah perangkat.</p>' +
      '<div id="lbStatus" style="font-size:.85rem;font-weight:600;padding:.45rem .6rem;border-radius:8px;background:rgba(128,128,128,.15);margin-bottom:.5rem"></div>' +
      '<button type="button" id="lbExp" style="' + btn + '">💾 Unduh File Backup</button>' +
      '<button type="button" id="lbImp" style="' + btn + '">📥 Pulihkan dari File Backup</button>' +
      '<input type="file" id="lbFile" accept=".json,application/json" style="display:none">' +
      '<button type="button" id="lbClose" style="' + btn + ';text-align:center;margin-top:.6rem">Tutup</button></div>';
    document.body.appendChild(ov);
    var $ = function (id) { return document.getElementById(id); };
    $('lbExp').onclick = exportFile;
    $('lbImp').onclick = function () { $('lbFile').click(); };
    $('lbFile').onchange = function () { importFile(this.files[0]); this.value = ''; };
    $('lbClose').onclick = LB.close;
    ov.addEventListener('click', function (e) { if (e.target === ov) LB.close(); });
    document.addEventListener('keydown', function (e) { if (e.key === 'Escape') LB.close(); });
    return ov;
  }
  LB.open = function () {
    ui().style.display = 'flex';
    var dd = document.getElementById('dropdown'); if (dd) dd.classList.remove('open', 'show', 'active');
    var s = document.getElementById('lbStatus'); if (s) s.textContent = LB.last.msg || 'Siap';
  };
  LB.close = function () { var ov = document.getElementById('lbOverlay'); if (ov) ov.style.display = 'none'; };
  LB.exportFile = exportFile; LB.importFile = importFile;

  setState('ok', LB.last.msg);
})();
