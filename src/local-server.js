// Sky Overhead app: the "server" functions, running on the phone itself.
// The Apps Script version runs these on Google's servers; in the app they run here,
// fetching straight from each data source through Capacitor's native HTTP (which,
// unlike a web page, isn't blocked from reading other websites). Results are kept
// on the phone for a while so data isn't downloaded more than needed.
(function () {
  const UA = 'SkyOverhead/1.0 (iPhone app)';

  // ---- HTTP: native when inside the app, normal fetch otherwise ----
  async function http(url, opts) {
    opts = opts || {};
    const headers = Object.assign({ 'User-Agent': UA }, opts.headers || {});
    if (window.SKY_HTTP) return window.SKY_HTTP(url, opts.binary, headers);   // used for testing
    const nat = window.Capacitor && window.Capacitor.Plugins && window.Capacitor.Plugins.CapacitorHttp;
    if (nat) {
      const r = await nat.request({ url, method: 'GET', headers, responseType: opts.binary ? 'arraybuffer' : 'text',
                                    connectTimeout: 20000, readTimeout: 60000 });
      const h = {}; Object.keys(r.headers || {}).forEach(k => { h[k.toLowerCase()] = String(r.headers[k]); });
      if (opts.binary) {
        const s = atob(typeof r.data === 'string' ? r.data : '');
        const b = new Uint8Array(s.length); for (let i = 0; i < s.length; i++) b[i] = s.charCodeAt(i);
        return { status: r.status, bytes: b, headers: h };
      }
      return { status: r.status, text: typeof r.data === 'string' ? r.data : JSON.stringify(r.data), headers: h };
    }
    const r = await fetch(url);
    const h = {}; r.headers.forEach((v, k) => { h[k.toLowerCase()] = v; });
    return opts.binary ? { status: r.status, bytes: new Uint8Array(await r.arrayBuffer()), headers: h }
                       : { status: r.status, text: await r.text(), headers: h };
  }

  // ---- a small store on the phone (IndexedDB, falling back to memory) ----
  const mem = {};
  let dbp = null;
  function db() {
    if (dbp) return dbp;
    dbp = new Promise(res => {
      try {
        const rq = indexedDB.open('sky-cache', 1);
        rq.onupgradeneeded = () => rq.result.createObjectStore('kv');
        rq.onsuccess = () => res(rq.result);
        rq.onerror = () => res(null);
      } catch (e) { res(null); }
    });
    return dbp;
  }
  async function cacheGet(k) {
    let v = mem[k];
    if (!v) {
      const d = await db();
      if (d) v = await new Promise(res => {
        try { const rq = d.transaction('kv').objectStore('kv').get(k); rq.onsuccess = () => res(rq.result); rq.onerror = () => res(null); }
        catch (e) { res(null); }
      });
    }
    if (!v || v.exp < Date.now()) return null;
    mem[k] = v;
    return v.val;
  }
  async function cachePut(k, val, ttlSec) {
    const v = { val, exp: Date.now() + ttlSec * 1000 };
    mem[k] = v;
    const d = await db();
    if (d) try { d.transaction('kv', 'readwrite').objectStore('kv').put(v, k); } catch (e) {}
  }

  const GROUPS = ['active', 'visual', 'stations', 'last-30-days', 'oneweb', 'kuiper', 'geo', 'gnss',
                  'gps-ops', 'iridium-NEXT', 'weather', 'resource', 'amateur', 'science', 'starlink'];
  const SIX_H = 21600;

  async function getTles(group) {
    if (GROUPS.indexOf(group) === -1) group = 'active';
    const key = 'omm_' + group, hit = await cacheGet(key);
    if (hit) return hit;
    const res = await http('https://celestrak.org/NORAD/elements/gp.php?GROUP=' + encodeURIComponent(group) + '&FORMAT=csv');
    const text = res.text || '';
    if (res.status !== 200 || text.indexOf('OBJECT_NAME') !== 0) {
      throw new Error('CelesTrak returned ' + res.status + (text ? ' (' + text.slice(0, 120).trim() + ')' : ''));
    }
    await cachePut(key, text, SIX_H);
    return text;
  }

  async function searchSats(query) {
    query = String(query || '').trim();
    if (query.length < 2) return '';
    const isNum = /^\d{1,9}$/.test(query);
    const key = 'q_' + (isNum ? 'n' : 's') + '_' + query.toLowerCase(), hit = await cacheGet(key);
    if (hit != null) return hit;
    const res = await http('https://celestrak.org/NORAD/elements/gp.php?' + (isNum ? 'CATNR=' : 'NAME=') +
                           encodeURIComponent(query) + '&FORMAT=csv');
    let text = res.text || '';
    if (res.status !== 200 || text.indexOf('OBJECT_NAME') !== 0) text = '';
    text = text.split(/\r?\n/).filter(Boolean).slice(0, 31).join('\n');
    await cachePut(key, text, SIX_H);
    return text;
  }

  // Nearest town under a point, from OpenStreetMap (free, no key; asked at most every 30 s by the page)
  async function nearestPlace(lat, lon) {
    lat = Number(lat); lon = Number(lon);
    if (!isFinite(lat) || !isFinite(lon)) throw new Error('Bad coordinates');
    const key = 'geo_' + (Math.round(lat * 4) / 4) + '_' + (Math.round(lon * 4) / 4), hit = await cacheGet(key);
    if (hit != null) return hit;
    const res = await http('https://nominatim.openstreetmap.org/reverse?format=jsonv2&zoom=10&accept-language=en&lat=' +
                           lat.toFixed(3) + '&lon=' + lon.toFixed(3));
    if (res.status !== 200) throw new Error('Place lookup returned ' + res.status);
    const j = JSON.parse(res.text || '{}'), a = j.address || {};
    const town = a.city || a.town || a.village || a.hamlet || a.municipality || a.county || a.state_district || a.state || '';
    const name = j.error ? '' : [town, a.country].filter(Boolean).join(', ');
    await cachePut(key, name, SIX_H);
    return name;
  }

  async function getTides(lat, lon) {
    lat = Number(lat); lon = Number(lon);
    if (!isFinite(lat) || !isFinite(lon)) throw new Error('Bad coordinates');
    const la = lat.toFixed(2), lo = lon.toFixed(2), key = 'tide_' + la + '_' + lo, hit = await cacheGet(key);
    if (hit) return hit;
    const res = await http('https://marine-api.open-meteo.com/v1/marine?latitude=' + la + '&longitude=' + lo +
      '&minutely_15=sea_level_height_msl&hourly=sea_level_height_msl&past_days=1&forecast_days=3&timeformat=unixtime&timezone=GMT');
    if (res.status !== 200) throw new Error('Tide service returned ' + res.status + ' (' + (res.text || '').slice(0, 120) + ')');
    const j = JSON.parse(res.text);
    const has = b => b && b.sea_level_height_msl && b.sea_level_height_msl.some(v => v != null);
    const src = has(j.minutely_15) ? j.minutely_15 : has(j.hourly) ? j.hourly : null;
    const out = JSON.stringify(src ? { t: src.time, h: src.sea_level_height_msl, lat: j.latitude, lon: j.longitude } : { t: [], h: [] });
    await cachePut(key, out, 10800);
    return out;
  }

  async function getLightning(lat, lon) {
    lat = Number(lat); lon = Number(lon);
    if (!isFinite(lat) || !isFinite(lon)) throw new Error('Bad coordinates');
    const key = 'ltg_' + lat.toFixed(1) + '_' + lon.toFixed(1), hit = await cacheGet(key);
    if (hit) return hit;
    const R = 160, W = 240, H = 240;
    const dLat = R / 111.32, dLon = R / (111.32 * Math.cos(lat * Math.PI / 180));
    const box = [lon - dLon, lat - dLat, lon + dLon, lat + dLat];
    const res = await http('https://view.eumetsat.int/geoserver/mtg_fd/wms?service=WMS&version=1.1.0&request=GetMap' +
      '&layers=mtg_fd:li_afa&styles=&srs=EPSG:4326&bbox=' + box.map(v => v.toFixed(4)).join(',') +
      '&width=' + W + '&height=' + H + '&format=image/gif&transparent=true', { binary: true });
    const type = res.headers['content-type'] || '';
    if (res.status !== 200 || type.indexOf('image/gif') === -1) throw new Error('Lightning service returned ' + res.status);
    const img = decodeGif_(res.bytes);
    const lit = i => img.idx[i] >= 0 && img.idx[i] !== img.transp;
    const seen = new Uint8Array(W * H), blobs = [];
    let litCount = 0;
    for (let i = 0; i < W * H; i++) {
      if (!lit(i)) continue;
      litCount++;
      if (seen[i]) continue;
      const stack = [i]; seen[i] = 1;
      let n = 0, sx = 0, sy = 0, best = Infinity;
      while (stack.length) {
        const j = stack.pop(), x = j % W, y = (j - x) / W;
        n++; sx += x; sy += y;
        const plat = box[3] - (y + 0.5) / H * (box[3] - box[1]), plon = box[0] + (x + 0.5) / W * (box[2] - box[0]);
        const d = distKm_(lat, lon, plat, plon);
        if (d < best) best = d;
        for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
          const nx = x + dx, ny = y + dy, k = ny * W + nx;
          if (nx < 0 || ny < 0 || nx >= W || ny >= H || seen[k] || !lit(k)) continue;
          seen[k] = 1; stack.push(k);
        }
      }
      const cx = sx / n, cy = sy / n;
      const clat = box[3] - (cy + 0.5) / H * (box[3] - box[1]), clon = box[0] + (cx + 0.5) / W * (box[2] - box[0]);
      blobs.push({ lat: +clat.toFixed(4), lon: +clon.toFixed(4), near: +best.toFixed(1),
                   brg: Math.round(bearing_(lat, lon, clat, clon)), px: n, km2: Math.round(n * (2 * R / W) * (2 * R / H)) });
    }
    if (litCount > W * H * 0.5) throw new Error('The lightning map came back without transparency, so it can’t be read');
    blobs.sort((a, b) => a.near - b.near);
    const out = JSON.stringify({ t: Date.now(), radius: R, blobs: blobs.filter(b => b.near <= R).slice(0, 40) });
    await cachePut(key, out, 120);
    return out;
  }

  // ---- Wikipedia and satellite catalogue for "More info" ----
  async function wikiLookup_(titles, must) {
    titles = titles.map(String).filter(Boolean).slice(0, 5);
    if (!titles.length) return null;
    const key = 'wiki_' + titles.join('|') + '#' + must, hit = await cacheGet(key);
    if (hit !== null && hit !== undefined) return hit === 'null' ? null : JSON.parse(hit);
    const res = await http('https://en.wikipedia.org/w/api.php?action=query&format=json&formatversion=2&redirects=1' +
      '&prop=extracts|pageimages|info|pageprops|description&exintro=1&explaintext=1&exsentences=6' +
      '&piprop=thumbnail&pithumbsize=400&inprop=url&ppprop=disambiguation&titles=' + encodeURIComponent(titles.join('|')));
    if (res.status !== 200) throw new Error('Wikipedia returned ' + res.status);
    const q = JSON.parse(res.text).query || {};
    const follow = t => {
      (q.normalized || []).forEach(n => { if (n.from === t) t = n.to; });
      (q.redirects || []).forEach(r => { if (r.from === t) t = r.to; });
      return t;
    };
    const re = must ? new RegExp(must, 'i') : null;
    let out = null;
    for (const t of titles) {
      const pg = (q.pages || []).find(x => x.title === follow(t));
      if (!pg || pg.missing || pg.invalid) continue;
      if (pg.pageprops && 'disambiguation' in pg.pageprops) continue;
      if (re && !re.test((pg.description || '') + ' ' + (pg.extract || ''))) continue;
      out = { title: pg.title, desc: pg.description || '', extract: pg.extract || '',
              thumb: pg.thumbnail ? pg.thumbnail.source : '',
              url: pg.fullurl || 'https://en.wikipedia.org/wiki/' + encodeURIComponent(pg.title) };
      break;
    }
    await cachePut(key, JSON.stringify(out), 86400);
    return out;
  }
  async function wikiSearch_(query) {
    const res = await http('https://en.wikipedia.org/w/api.php?action=query&format=json&formatversion=2&list=search&srlimit=3&srsearch=' +
                           encodeURIComponent(query));
    if (res.status !== 200) return [];
    const q = JSON.parse(res.text).query || {};
    return (q.search || []).map(r => r.title);
  }
  async function getWiki(titles, must) {
    return JSON.stringify(await wikiLookup_([].concat(titles || []), must || ''));
  }
  async function getSatInfo(catnr, name) {
    catnr = String(catnr || '').replace(/\D/g, '');
    name = String(name || '');
    if (!catnr) throw new Error('No catalogue number');
    const key = 'satinfo_' + catnr, hit = await cacheGet(key);
    if (hit) return hit;
    let cat = null;
    try {
      const r = await http('https://celestrak.org/satcat/records.php?CATNR=' + catnr + '&FORMAT=JSON');
      if (r.status === 200) { const a = JSON.parse(r.text); if (Array.isArray(a) && a.length) cat = a[0]; }
    } catch (e) {}
    const guess = satWikiGuess_(name);
    let wiki = null;
    try {
      if (guess) wiki = await wikiLookup_([guess], '');
      else {
        const clean = name.replace(/\(.*?\)/g, ' ').replace(/[_]/g, ' ').trim();
        const titles = await wikiSearch_(clean + ' satellite');
        if (titles.length) wiki = await wikiLookup_(titles, 'satellite|spacecraft|space station|orbit|launched');
      }
    } catch (e) {}
    const general = !!guess && /^(STARLINK|ONEWEB|KUIPER|IRIDIUM|GPS|NAVSTAR|GALILEO|GSAT0|GLONASS|COSMOS|BEIDOU|FLOCK|DOVE|LEMUR|BLUEBIRD|SL-)|R\/B|\bDEB\b/i.test(name);
    const out = JSON.stringify({ cat, wiki, general });
    await cachePut(key, out, 86400);
    return out;
  }

  // ---- shared helpers (same code as the Apps Script version) ----
  function distKm_(la1, lo1, la2, lo2) {
    const r = Math.PI / 180, dLa = (la2 - la1) * r, dLo = (lo2 - lo1) * r;
    const h = Math.sin(dLa / 2) ** 2 + Math.cos(la1 * r) * Math.cos(la2 * r) * Math.sin(dLo / 2) ** 2;
    return 2 * 6371 * Math.asin(Math.sqrt(h));
  }

  function bearing_(la1, lo1, la2, lo2) {
    const r = Math.PI / 180, y = Math.sin((lo2 - lo1) * r) * Math.cos(la2 * r);
    const x = Math.cos(la1 * r) * Math.sin(la2 * r) - Math.sin(la1 * r) * Math.cos(la2 * r) * Math.cos((lo2 - lo1) * r);
    return (Math.atan2(y, x) / r + 360) % 360;
  }

  function decodeGif_(b) {
    if (String.fromCharCode(b[0], b[1], b[2]) !== 'GIF') throw new Error('Not a GIF image');
    let p = 6;
    const W = b[p] | (b[p + 1] << 8), H = b[p + 2] | (b[p + 3] << 8), f = b[p + 4];
    p += 7;
    let gct = null;
    if (f & 0x80) { const n = 2 << (f & 7); gct = b.slice(p, p + 3 * n); p += 3 * n; }
    let transp = -1;
    while (p < b.length) {
      const c = b[p++];
      if (c === 0x21) {                                   // extension block
        const label = b[p++];
        if (label === 0xF9 && (b[p + 1] & 1)) transp = b[p + 4];
        for (;;) { const sz = b[p++]; if (!sz) break; p += sz; }
      } else if (c === 0x2C) {                            // the image itself
        const ix = b[p] | (b[p + 1] << 8), iy = b[p + 2] | (b[p + 3] << 8);
        const iw = b[p + 4] | (b[p + 5] << 8), ih = b[p + 6] | (b[p + 7] << 8), lf = b[p + 8];
        p += 9;
        let ct = gct;
        if (lf & 0x80) { const n = 2 << (lf & 7); ct = b.slice(p, p + 3 * n); p += 3 * n; }
        const minCode = b[p++], data = [];
        for (;;) { const sz = b[p++]; if (!sz) break; for (let i = 0; i < sz; i++) data.push(b[p + i]); p += sz; }
        const px = lzw_(data, minCode, iw * ih);
        const rows = [];
        if (lf & 0x40) { [[0, 8], [4, 8], [2, 4], [1, 2]].forEach(([s, st]) => { for (let y = s; y < ih; y += st) rows.push(y); }); }
        else for (let y = 0; y < ih; y++) rows.push(y);
        const idx = new Array(W * H).fill(-1);
        for (let r = 0; r < rows.length; r++) {
          const y = rows[r] + iy;
          if (y >= H) continue;
          for (let x = 0; x < iw && ix + x < W; x++) {
            const v = px[r * iw + x];
            if (v !== undefined) idx[y * W + ix + x] = v;
          }
        }
        return { w: W, h: H, idx, transp, ct };
      } else break;
    }
    throw new Error('No image in GIF');
  }

  function lzw_(data, minCode, n) {
    const clear = 1 << minCode, eoi = clear + 1;
    let size, dict;
    const reset = () => { dict = []; for (let i = 0; i < clear; i++) dict[i] = [i]; dict[clear] = null; dict[eoi] = null; size = minCode + 1; };
    reset();
    const out = [];
    let prev = null, cur = 0, nbits = 0, i = 0;
    while (out.length < n) {
      while (nbits < size) { if (i >= data.length) return out; cur |= data[i++] << nbits; nbits += 8; }
      const code = cur & ((1 << size) - 1);
      cur >>>= size; nbits -= size;
      if (code === clear) { reset(); prev = null; continue; }
      if (code === eoi) break;
      let entry;
      if (code < dict.length && dict[code]) entry = dict[code];
      else if (prev) entry = prev.concat(prev[0]);
      else break;
      for (let k = 0; k < entry.length; k++) out.push(entry[k]);
      if (prev && dict.length < 4096) dict.push(prev.concat(entry[0]));
      prev = entry;
      if (dict.length === (1 << size) && size < 12) size++;
    }
    return out;
  }

  function satWikiGuess_(name) {
    const n = name.toUpperCase();
    const rules = [
      [/^ISS\b|ZARYA/, 'International Space Station'], [/TIANHE|^CSS\b/, 'Tiangong space station'],
      [/^HST$|HUBBLE/, 'Hubble Space Telescope'], [/^STARLINK/, 'Starlink'], [/^ONEWEB/, 'OneWeb'],
      [/^KUIPER/, 'Project Kuiper'], [/^IRIDIUM/, 'Iridium satellite constellation'],
      [/^GPS\b|NAVSTAR/, 'Global Positioning System'], [/^GALILEO|^GSAT0/, 'Galileo (satellite navigation)'],
      [/GLONASS/, 'GLONASS'], [/^BEIDOU/, 'BeiDou'], [/^NOAA[ -]?(\d+)/, m => 'NOAA-' + m[1]],
      [/^METEOSAT/, 'Meteosat'], [/^SENTINEL[- ]?(\w+)/, m => 'Sentinel-' + m[1]],
      [/^LANDSAT[ -]?(\d+)/, m => 'Landsat ' + m[1]], [/^FLOCK|^DOVE/, 'Planet Labs'], [/^LEMUR/, 'Spire Global'],
      [/^AQUA$/, 'Aqua (satellite)'], [/^TERRA$/, 'Terra (satellite)'], [/BLUEWALKER|BLUEBIRD/, 'AST SpaceMobile'],
      [/R\/B|^SL-/, 'Multistage rocket'], [/\bDEB\b/, 'Space debris']
    ];
    for (const [re, t] of rules) {
      const m = n.match(re);
      if (m) return typeof t === 'function' ? t(m) : t;
    }
    return null;
  }

  const API = { getTles, searchSats, nearestPlace, getTides, getLightning, getWiki, getSatInfo };
  window.SKY_LOCAL = API;

  // Stand-in for Apps Script's google.script.run, so the page works unchanged
  function run() {
    let ok = function () {}, bad = function (e) { console.error(e); };
    const r = new Proxy({}, { get: function (_, k) {
      if (k === 'withSuccessHandler') return function (f) { ok = f; return r; };
      if (k === 'withFailureHandler') return function (f) { bad = f; return r; };
      if (k === 'withUserObject') return function () { return r; };
      return function () {
        const f = API[k];
        if (!f) { setTimeout(() => bad(new Error('Unknown function ' + String(k)))); return; }
        Promise.resolve().then(() => f.apply(null, arguments)).then(v => ok(v), e => bad(e instanceof Error ? e : new Error(String(e))));
      };
    } });
    return r;
  }
  window.google = { script: { get run() { return run(); } } };
})();
