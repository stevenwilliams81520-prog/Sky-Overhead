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
    // Use the layer that worked last time first; fall back to the next if the service doesn't have it
    const known = await cacheGet('ltg_layer');
    const order = LTG_LAYERS_.slice().sort((x, y) => (y.name === known) - (x.name === known));
    let out = null, lastErr = '';
    for (const L of order) {
      const res = await http(ltgUrl_(L.name, box, W, H), { binary: true });
      const type = res.headers['content-type'] || '';
      if (res.status !== 200 || type.indexOf('image/gif') === -1) { lastErr = 'Lightning service returned ' + res.status; continue; }
      out = JSON.stringify({ t: Date.now(), radius: R, layer: L.name, centres: L.centres,
                             blobs: ltgBlobs_(decodeGif_(res.bytes), lat, lon, box, W, H, R, L.reach) });
      await cachePut('ltg_layer', L.name, 86400);
      break;
    }
    if (!out) throw new Error(lastErr);
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

  // Earthquakes near you and the strongest worldwide (EMSC + USGS); kept for 5 minutes
  async function getQuakes(lat, lon, start, minmag) {
    lat = Number(lat); lon = Number(lon); minmag = Number(minmag) || 0; start = String(start);
    if (!isFinite(lat) || !isFinite(lon) || !/^\d{4}-\d\d-\d\dT/.test(start)) throw new Error('Bad request');
    const key = 'eq_' + lat.toFixed(2) + '_' + lon.toFixed(2) + '_' + start.slice(0, 13) + '_' + minmag, hit = await cacheGet(key);
    if (hit) return hit;
    const get = async (url, src) => {
      const r = await http(url);
      if (r.status === 204) return [];
      if (r.status !== 200) throw new Error((src === 'usgs' ? 'USGS' : 'EMSC') + ' returned ' + r.status);
      return quakeParse_(r.text, src);
    };
    let errs = 0, lastErr = '';
    const tryGet = (url, src) => get(url, src).catch(e => { errs++; lastErr = e.message; return []; });
    const lists = await Promise.all([tryGet(quakeUrlEmsc_(lat, lon, start, minmag, 3, 2000), 'emsc'),
                                     tryGet(quakeUrlEmsc_(lat, lon, start, Math.max(minmag, 2.5), 9, 2000), 'emsc')]);
    if (!lists[0].length && !lists[1].length) lists.push(await tryGet(quakeUrlEmsc_(lat, lon, start, Math.max(minmag, 4), 180, 1000), 'emsc'));
    if (errs === lists.length) throw new Error(lastErr);
    let world = null;
    try { world = (await get(quakeUrlUsgsBiggest_(start, minmag), 'usgs'))[0] || null; } catch (e) {}
    const out = JSON.stringify(Object.assign(quakeSummary_(lat, lon, lists), { world, t: Date.now() }));
    await cachePut(key, out, 120);
    return out;
  }

  // The latest (or strongest) 40 earthquakes worldwide since start; kept for 2 minutes
  async function getQuakeFeed(start, minmag, order) {
    minmag = Number(minmag) || 0; start = String(start); order = order === 'strongest' ? 'strongest' : 'latest';
    if (!/^\d{4}-\d\d-\d\dT/.test(start)) throw new Error('Bad request');
    const key = 'eqf_' + start.slice(0, 13) + '_' + minmag + '_' + order, hit = await cacheGet(key);
    if (hit) return hit;
    const r = await http(quakeUrlWorld_(start, minmag, order));
    if (r.status !== 200 && r.status !== 204) throw new Error('EMSC returned ' + r.status);
    const out = JSON.stringify({ t: Date.now(), order, list: r.status === 204 ? [] : quakeParse_(r.text, 'emsc') });
    await cachePut(key, out, 120);
    return out;
  }

  // ---- shared helpers (same code as the Apps Script version) ----
  function quakeUrlWorld_(start, minmag, order) {
    return 'https://www.seismicportal.eu/fdsnws/event/1/query?format=json&nodata=204&limit=40' +
      '&orderby=' + (order === 'strongest' ? 'magnitude' : 'time') +
      '&start=' + encodeURIComponent(start) + (minmag > 0 ? '&minmag=' + minmag : '');
  }
  // ---- earthquakes: shared helpers (EMSC SeismicPortal, CC BY 4.0; USGS, public domain) ----
  function quakeUrlEmsc_(lat, lon, start, minmag, maxradiusDeg, limit) {
    // The whole world is asked for without a centre point: EMSC rejects a 180° radius search
    const where = maxradiusDeg >= 180 ? '' : '&lat=' + lat.toFixed(3) + '&lon=' + lon.toFixed(3) + '&maxradius=' + maxradiusDeg;
    return 'https://www.seismicportal.eu/fdsnws/event/1/query?format=json&nodata=204&orderby=time' + where +
      '&start=' + encodeURIComponent(start) + (minmag > 0 ? '&minmag=' + minmag : '') + '&limit=' + limit;
  }
  function quakeUrlUsgsBiggest_(start, minmag) {
    return 'https://earthquake.usgs.gov/fdsnws/event/1/query?format=geojson&orderby=magnitude&limit=1' +
      '&starttime=' + encodeURIComponent(start) + '&minmagnitude=' + Math.max(minmag, 4.5);
  }
  // One tidy shape for both feeds' GeoJSON
  function quakeParse_(text, src) {
    if (!text || !text.trim()) return [];
    const j = JSON.parse(text);
    return (j.features || []).map(f => {
      const p = f.properties || {}, g = (f.geometry && f.geometry.coordinates) || [];
      const lat = Number(g[1] != null ? g[1] : (p.lat != null ? p.lat : p.Latitude));
      const lon = Number(g[0] != null ? g[0] : (p.lon != null ? p.lon : p.Longitude));
      const depth = Math.abs(Number(p.depth != null ? p.depth : (p.Depth != null ? p.Depth : g[2])));
      const t = src === 'usgs' ? Number(p.time) : Date.parse(p.time || p.Time);
      const place = src === 'usgs' ? (p.place || '') : (p.flynn_region || p.EventLocationName || '');
      return { t, lat, lon, depth: isFinite(depth) ? depth : null, mag: Number(p.mag != null ? p.mag : p.Magnitude),
               magType: p.magtype || p.magType || p.MagType || '', place: String(place),
               id: String(p.unid || p.source_id || p.EventID || f.id || ''), src,
               url: src === 'usgs' ? (p.url || '') : (p.unid ? 'https://www.seismicportal.eu/eventdetails.html?unid=' + p.unid : '') };
    }).filter(q => isFinite(q.lat) && isFinite(q.lon) && isFinite(q.mag) && isFinite(q.t) && (q.src === 'usgs' || !/quarry|explosion/i.test(q.place)));
  }
  // Pick out what the Quakes tab shows
  function quakeSummary_(lat, lon, lists) {
    const seen = {}, all = [];
    [].concat(...lists).forEach(q => {
      const k = q.id || (q.t + ',' + q.lat.toFixed(2) + ',' + q.lon.toFixed(2));
      if (seen[k]) return; seen[k] = 1;
      q.d = Math.round(distKm_(lat, lon, q.lat, q.lon) * 10) / 10;
      all.push(q);
    });
    all.sort((a, b) => a.d - b.d);
    const near = all.filter(q => q.d <= 1000);
    const strongestNear = near.slice().sort((a, b) => b.mag - a.mag || b.t - a.t)[0] || null;
    return { nearest: all[0] || null, strongestNear, list: all.slice(0, 40), count: near.length };
  }
  // Lightning layers to try, sharpest first. "li_af" (Accumulated Flashes) marks just the centre of
  // each flash; "li_afa" (Accumulated Flash Area) spreads each flash over the whole patch of cloud it lit.
  const LTG_LAYERS_ = [{ name: 'mtg_fd:li_af', reach: 3, centres: true }, { name: 'mtg_fd:li_afa', reach: 1, centres: false }];
  function ltgUrl_(layer, box, W, H) {
    return 'https://view.eumetsat.int/geoserver/mtg_fd/wms?service=WMS&version=1.1.0&request=GetMap' +
           '&layers=' + layer + '&styles=&srs=EPSG:4326&bbox=' + box.map(v => v.toFixed(4)).join(',') +
           '&width=' + W + '&height=' + H + '&format=image/gif&transparent=true';
  }
  // Group lit pixels into storms. With flash centres, dots within `reach` pixels (~4 km) count as
  // one storm; each storm's nearest dot gives the distance, its centre the direction.
  function ltgBlobs_(img, lat, lon, box, W, H, R, reach) {
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
        for (let dy = -reach; dy <= reach; dy++) for (let dx = -reach; dx <= reach; dx++) {
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
    return blobs.filter(b => b.near <= R).slice(0, 40);
  }
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

  // How light-polluted the sky is likely to be here, estimated from nearby towns (OpenStreetMap)
  async function getSkyBrightness(lat, lon) {
    lat = Number(lat); lon = Number(lon);
    if (!isFinite(lat) || !isFinite(lon)) throw new Error('Bad coordinates');
    const key = 'skyb_' + (Math.round(lat * 20) / 20) + '_' + (Math.round(lon * 20) / 20), hit = await cacheGet(key);
    if (hit) return hit;
    const res = await http('https://overpass-api.de/api/interpreter?data=' + encodeURIComponent(skyPlacesQuery_(lat, lon)));
    if (res.status !== 200) throw new Error('Place data returned ' + res.status);
    const out = JSON.stringify(estimateSky_(lat, lon, skyPlaces_(JSON.parse(res.text))));
    await cachePut(key, out, 30 * 86400);              // towns don't move: keep for a month
    return out;
  }
  // Estimate the night sky's brightness (and Bortle class) from the towns and cities around a point.
  // Each place adds artificial light to the sky overhead: inside a town it's set by the town's size;
  // further away it fades with distance to the power 2.5 (Walker's law). The total, compared with
  // a natural dark sky of 22.0 mag/arcsec², gives the sky brightness a sky quality meter would read.
  function estimateSky_(lat, lon, places) {
    const contrib = [];
    let R = 0;
    for (const p of places) {
      const d = Math.max(0.05, distKm_(lat, lon, p.lat, p.lon));
      const dens = 3000 * Math.pow(Math.max(1, p.pop / 1e4), 0.15);   // people per km², higher in big cities
      const rc = Math.sqrt(p.pop / dens / Math.PI);          // radius of the brightly lit core, km
      const rin = 0.776 * Math.pow(p.pop, 0.266);            // artificial/natural sky ratio in the town centre
      const r = rin / (1 + Math.pow(d / rc, 2.5));
      if (r > 0.001) { R += r; contrib.push({ name: p.name, d: Math.round(d), r }); }
    }
    const sqm = 22.0 - 2.5 * Math.log10(1 + R);
    const b = sqm >= 21.76 ? '1' : sqm >= 21.6 ? '2' : sqm >= 21.3 ? '3' : sqm >= 20.8 ? '4' : sqm >= 20.3 ? '4.5'
            : sqm >= 19.25 ? '5' : sqm >= 18.5 ? '6' : sqm >= 18.0 ? '7' : sqm >= 17.5 ? '8' : '9';
    contrib.sort((a, b2) => b2.r - a.r);
    const main = contrib.filter(c => c.r >= Math.max(0.05, R * 0.12)).slice(0, 3).map(c => ({ name: c.name, d: c.d }));
    return { sqm: Math.round(sqm * 100) / 100, bortle: b, main, places: places.length };
  }
  // Towns and cities within 200 km and villages within 15 km, from OpenStreetMap (Overpass API, free, no key)
  function skyPlacesQuery_(lat, lon) {
    const ll = lat.toFixed(3) + ',' + lon.toFixed(3);
    return '[out:json][timeout:40];(node["place"~"^(city|town)$"](around:200000,' + ll + ');' +
           'node["place"="village"](around:15000,' + ll + '););out;';
  }
  function skyPlaces_(json) {
    const DEF = { city: 150000, town: 12000, village: 800 };
    return (json.elements || []).map(e => {
      const t = e.tags || {};
      let pop = parseInt(String(t.population || '').replace(/[^\d]/g, ''), 10);
      if (!(pop > 0)) pop = DEF[t.place] || 800;
      return { name: t['name:en'] || t.name || '', lat: e.lat, lon: e.lon, pop: Math.min(pop, 2e7) };
    }).filter(p => isFinite(p.lat) && isFinite(p.lon));
  }

  const API = { getTles, searchSats, nearestPlace, getTides, getLightning, getWiki, getSatInfo, getSkyBrightness, getQuakes, getQuakeFeed };
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

  // Links that open in a new window (LightningMaps, Wikipedia…) open in an in-app browser
  // panel on the iPhone, with a Done button that comes straight back to the app
  document.addEventListener('click', e => {
    const a = e.target.closest && e.target.closest('a[target="_blank"]');
    const B = window.Capacitor && window.Capacitor.Plugins && window.Capacitor.Plugins.Browser;
    if (!a || !B || !/^https?:/i.test(a.href)) return;
    e.preventDefault();
    B.open({ url: a.href, presentationStyle: 'popover' });
  }, true);
})();
