/* Peak Age Packing — core logic (no UI). Works in the Android app and in Node for testing. */
(function (root) {
  'use strict';

  var EXCLUDED_STATUSES = ['cancelled', 'refunded', 'failed', 'pending', 'checkout-draft', 'trash', 'draft'];
  var PHOTO_META = '_pa_pack_photo';
  var PACK_META = '_pa_pack_list';

  function b64(s) {
    if (typeof btoa === 'function') return btoa(unescape(encodeURIComponent(s)));
    return Buffer.from(s, 'utf8').toString('base64');
  }

  /* ---------- API wrapper ----------
     transport(method, url, headers, body, bodyIsBase64) -> Promise<{status, text}> */
  function createApi(cfg, transport) {
    var base = (cfg.storeUrl || 'https://peak-age.com').replace(/\/+$/, '');
    var wcAuth = 'Basic ' + b64(cfg.ck + ':' + cfg.cs);
    var wpAuth = cfg.wpUser ? 'Basic ' + b64(cfg.wpUser + ':' + String(cfg.wpPass || '').replace(/\s+/g, '')) : null;

    function call(method, path, opts) {
      opts = opts || {};
      var url = base + '/wp-json' + path;
      if (opts.query) {
        var q = Object.keys(opts.query).filter(function (k) { return opts.query[k] !== undefined && opts.query[k] !== null; })
          .map(function (k) { return encodeURIComponent(k) + '=' + encodeURIComponent(opts.query[k]); }).join('&');
        if (q) url += (url.indexOf('?') < 0 ? '?' : '&') + q;
      }
      var headers = { 'Accept': 'application/json' };
      headers['Authorization'] = opts.wp ? wpAuth : wcAuth;
      if (opts.wp && !wpAuth) return Promise.reject(new Error('WordPress username and app password are not set (Settings).'));
      var body = null, isB64 = false;
      if (opts.base64) { body = opts.base64; isB64 = true; }
      else if (opts.body !== undefined) { body = JSON.stringify(opts.body); headers['Content-Type'] = 'application/json'; }
      if (opts.headers) Object.keys(opts.headers).forEach(function (k) { headers[k] = opts.headers[k]; });
      return transport(method, url, headers, body, isB64).then(function (res) {
        var data = null;
        try { data = res.text ? JSON.parse(res.text) : null; } catch (e) { data = null; }
        if (res.status < 200 || res.status >= 300) {
          var msg = (data && (data.message || data.code)) || ('HTTP ' + res.status);
          if (res.status === 0) msg = 'No connection: ' + (res.text || 'network error');
          var err = new Error(msg); err.status = res.status; throw err;
        }
        return data;
      });
    }
    return { call: call, base: base };
  }

  /* ---------- Tracking ---------- */
  var TRACK_RE = /shipped via\s+(.+?)\s+on\s+(.+?)\s+with tracking number\s+([A-Za-z0-9]+)/i;
  var TRACK_LOOSE = /tracking (?:number|#)[:\s]+([A-Za-z0-9]{8,})/i;

  function stripTags(s) { return String(s || '').replace(/<[^>]*>/g, ' ').replace(/&nbsp;/g, ' ').replace(/\s+/g, ' ').trim(); }

  function parseTracking(notes) {
    var out = [], seen = {};
    (notes || []).slice().sort(function (a, b) { return a.date_created < b.date_created ? -1 : 1; }).forEach(function (n) {
      var text = stripTags(n.note), m = TRACK_RE.exec(text), num, carrier = '', shipped = '';
      if (m) { carrier = m[1].trim(); shipped = m[2].trim(); num = m[3]; }
      else { m = TRACK_LOOSE.exec(text); if (!m) return; num = m[1]; }
      if (seen[num]) return;
      seen[num] = 1;
      out.push({ number: num, carrier: carrier || guessCarrier(num), shipped: shipped, at: n.date_created });
    });
    return out;
  }

  function guessCarrier(num) {
    if (/^1Z/i.test(num)) return 'UPS';
    if (/^9[2-5]\d{18,24}$/.test(num)) return 'USPS';
    if (/^\d{12}$|^\d{15}$/.test(num)) return 'FedEx';
    return '';
  }

  function trackingUrl(t) {
    var c = (t.carrier || '').toLowerCase(), n = encodeURIComponent(t.number);
    if (c.indexOf('usps') >= 0) return 'https://tools.usps.com/go/TrackConfirmAction?tLabels=' + n;
    if (c.indexOf('ups') >= 0) return 'https://www.ups.com/track?tracknum=' + n;
    if (c.indexOf('fedex') >= 0) return 'https://www.fedex.com/fedextrack/?trknbr=' + n;
    if (c.indexOf('dhl') >= 0) return 'https://www.dhl.com/us-en/home/tracking.html?tracking-id=' + n;
    return 'https://www.google.com/search?q=' + n;
  }

  /* ---------- Photos stored on the order ---------- */
  function getMeta(obj, key) {
    var m = (obj.meta_data || []).filter(function (x) { return x.key === key; })[0];
    return m ? m.value : null;
  }

  function orderPhotos(order) {
    var v = getMeta(order, PHOTO_META);
    if (!v) return [];
    try { var a = typeof v === 'string' ? JSON.parse(v) : v; return Array.isArray(a) ? a : [a]; } catch (e) { return []; }
  }

  /* ---------- Orders ---------- */
  function isActive(order) { return EXCLUDED_STATUSES.indexOf(order.status) < 0; }

  function fetchRecentOrders(api, days, since) {
    var after = new Date(Date.now() - (days || 14) * 86400000).toISOString().slice(0, 19);
    if (since && since + 'T00:00:00' > after) after = since + 'T00:00:00';
    var all = [];
    function page(n) {
      return api.call('GET', '/wc/v3/orders', { query: { per_page: 100, page: n, after: after, orderby: 'date', order: 'asc' } })
        .then(function (list) {
          all = all.concat(list || []);
          if (list && list.length === 100 && n < 20) return page(n + 1);
          return all.filter(isActive);
        });
    }
    return page(1);
  }

  function fetchNotes(api, orderId) { return api.call('GET', '/wc/v3/orders/' + orderId + '/notes'); }

  function mapLimit(items, limit, fn) {
    var i = 0, results = new Array(items.length);
    function worker() {
      if (i >= items.length) return Promise.resolve();
      var idx = i++;
      return Promise.resolve(fn(items[idx], idx)).then(function (r) { results[idx] = r; }, function (e) { results[idx] = { error: e }; }).then(worker);
    }
    var ws = []; for (var k = 0; k < Math.min(limit, items.length); k++) ws.push(worker());
    return Promise.all(ws).then(function () { return results; });
  }

  /* Returns {notShipped: [...], shipped: [...]} each entry {order, tracking, photos} */
  function loadQueues(api, days, since) {
    return fetchRecentOrders(api, days, since).then(function (orders) {
      return mapLimit(orders, 4, function (o) {
        return fetchNotes(api, o.id).then(function (notes) {
          return { order: o, tracking: parseTracking(notes), photos: orderPhotos(o) };
        });
      });
    }).then(function (rows) {
      var notShipped = [], shipped = [], errors = 0;
      rows.forEach(function (r) {
        if (!r || r.error) { errors++; return; }
        if (r.photos.length) shipped.push(r);
        else if (r.tracking.length) notShipped.push(r);
      });
      shipped.sort(function (a, b) { return lastPhotoAt(b) < lastPhotoAt(a) ? -1 : 1; });
      return { notShipped: notShipped, shipped: shipped, errors: errors };
    });
  }

  function lastPhotoAt(r) { var p = r.photos[r.photos.length - 1]; return p ? p.at : ''; }

  /* ---------- Pack lists (bundle contents) ---------- */
  function lineKey(li) { return li.variation_id ? li.variation_id : li.product_id; }

  function fetchPackLists(api, orders, cache) {
    cache = cache || {};
    var parents = {}, variations = [];
    orders.forEach(function (o) {
      (o.line_items || []).forEach(function (li) {
        if (li.variation_id) variations.push({ parent: li.product_id, id: li.variation_id });
        else if (li.product_id) parents[li.product_id] = 1;
      });
    });
    var ids = Object.keys(parents);
    var jobs = [];
    for (var i = 0; i < ids.length; i += 100) {
      jobs.push(api.call('GET', '/wc/v3/products', { query: { include: ids.slice(i, i + 100).join(','), per_page: 100, status: 'any' } })
        .then(function (list) { (list || []).forEach(function (p) { cache[p.id] = parsePack(getMeta(p, PACK_META)); }); }));
    }
    var seenVar = {};
    variations.forEach(function (v) {
      if (seenVar[v.id]) return; seenVar[v.id] = 1;
      jobs.push(api.call('GET', '/wc/v3/products/' + v.parent + '/variations/' + v.id)
        .then(function (p) { cache[p.id] = parsePack(getMeta(p, PACK_META)); }, function () { cache[v.id] = null; }));
    });
    return Promise.all(jobs).then(function () { return cache; });
  }

  function parsePack(v) {
    if (!v) return null;
    try { var a = typeof v === 'string' ? JSON.parse(v) : v; return Array.isArray(a) ? a : null; } catch (e) { return null; }
  }

  /* Build the itemized packing list for one order. */
  function buildPackingList(order, packCache) {
    var lines = [], totals = {}, warnings = 0;
    (order.line_items || []).forEach(function (li) {
      var pack = packCache[lineKey(li)];
      var contents = [];
      if (pack && pack.length) {
        pack.forEach(function (p) {
          var qty = p.qty === null || p.qty === undefined ? null : p.qty * li.quantity;
          if (p.review || qty === null) warnings++;
          contents.push({ item: p.item, sku: p.sku, qty: qty, review: !!p.review || qty === null, note: p.note || '' });
        });
      } else {
        warnings++;
        contents.push({ item: li.name, sku: li.sku, qty: li.quantity, review: true, note: 'No pack list found for this product. Check the Product Contents sheet.' });
      }
      contents.forEach(function (c) {
        var k = c.item.toLowerCase();
        if (!totals[k]) totals[k] = { item: c.item, sku: c.sku, qty: 0, unknown: false, review: false };
        if (c.qty === null) totals[k].unknown = true; else totals[k].qty += c.qty;
        if (c.review) totals[k].review = true;
      });
      lines.push({ sku: li.sku, name: li.name, quantity: li.quantity, contents: contents });
    });
    var totalList = Object.keys(totals).map(function (k) { return totals[k]; });
    return { lines: lines, totals: totalList, warnings: warnings };
  }

  /* ---------- Saving a photo ---------- */
  function randomId(n) {
    var s = '', chars = 'abcdefghijkmnpqrstuvwxyz23456789';
    for (var i = 0; i < n; i++) s += chars[Math.floor(Math.random() * chars.length)];
    return s;
  }

  function uploadPhoto(api, order, jpegBase64) {
    var filename = 'pack-' + order.number + '-' + randomId(10) + '.jpg';
    return api.call('POST', '/wp/v2/media', {
      wp: true, base64: jpegBase64,
      headers: { 'Content-Type': 'image/jpeg', 'Content-Disposition': 'attachment; filename="' + filename + '"' }
    }).then(function (m) { return { url: m.source_url, media_id: m.id }; });
  }

  function savePhotoOnOrder(api, order, photo) {
    return api.call('GET', '/wc/v3/orders/' + order.id).then(function (fresh) {
      var photos = orderPhotos(fresh).concat([photo]);
      return api.call('PUT', '/wc/v3/orders/' + order.id, { body: { meta_data: [{ key: PHOTO_META, value: JSON.stringify(photos) }] } });
    });
  }

  function esc(s) {
    return String(s === undefined || s === null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  function customerEmailHtml(order, photoUrl, tracking) {
    var first = (order.billing && order.billing.first_name) || (order.shipping && order.shipping.first_name) || '';
    var tlines = (tracking || []).map(function (t) {
      return (t.carrier ? esc(t.carrier) + ' ' : '') + '<a href="' + esc(trackingUrl(t)) + '">' + esc(t.number) + '</a>';
    }).join('<br>');
    return '<p>Hi ' + esc(first.trim() || 'there') + ',</p>' +
      '<p>Your Peak Age order #' + esc(order.number) + ' is on its way! Here is a photo of your order exactly as we packed it, so you can check everything when it arrives.</p>' +
      '<p><img src="' + esc(photoUrl) + '" alt="Photo of your packed order" style="max-width:100%;height:auto;border-radius:8px;" /></p>' +
      '<p><a href="' + esc(photoUrl) + '">View the photo full size</a></p>' +
      (tlines ? '<p>Tracking: ' + tlines + '</p>' : '') +
      '<p>If anything looks off when your package arrives, please contact us and mention order #' + esc(order.number) + '.</p>';
  }

  function emailCustomer(api, order, photoUrl, tracking) {
    return api.call('POST', '/wc/v3/orders/' + order.id + '/notes', {
      body: { note: customerEmailHtml(order, photoUrl, tracking), customer_note: true }
    });
  }

  /* Full flow: upload, attach to order, optionally email. */
  function completePacking(api, order, jpegBase64, opts) {
    opts = opts || {};
    var photo;
    return uploadPhoto(api, order, jpegBase64).then(function (up) {
      photo = { url: up.url, media_id: up.media_id, at: new Date().toISOString(), by: opts.packer || '', tracking: (opts.tracking || []).map(function (t) { return t.number; }), emailed: false };
      return savePhotoOnOrder(api, order, photo);
    }).then(function () {
      if (!opts.email) return null;
      return emailCustomer(api, order, photo.url, opts.tracking).then(function () {
        photo.emailed = true;
        return api.call('GET', '/wc/v3/orders/' + order.id).then(function (fresh) {
          var photos = orderPhotos(fresh).map(function (p) { return p.url === photo.url ? photo : p; });
          return api.call('PUT', '/wc/v3/orders/' + order.id, { body: { meta_data: [{ key: PHOTO_META, value: JSON.stringify(photos) }] } });
        });
      });
    }).then(function () { return photo; });
  }

  /* ---------- Lookup ---------- */
  function lookup(api, term) {
    term = String(term || '').trim().replace(/^#/, '');
    if (!term) return Promise.resolve([]);
    var byNumber = /^\d+$/.test(term)
      ? api.call('GET', '/wc/v3/orders/' + term).then(function (o) { return [o]; }, function () { return []; })
      : Promise.resolve([]);
    var bySearch = api.call('GET', '/wc/v3/orders', { query: { search: term, per_page: 30 } }).catch(function () { return []; });
    return Promise.all([byNumber, bySearch]).then(function (r) {
      var seen = {}, out = [];
      r[0].concat(r[1] || []).forEach(function (o) { if (o && !seen[o.id]) { seen[o.id] = 1; out.push(o); } });
      return out;
    });
  }

  root.PackCore = {
    createApi: createApi, parseTracking: parseTracking, trackingUrl: trackingUrl, orderPhotos: orderPhotos,
    fetchRecentOrders: fetchRecentOrders, fetchNotes: fetchNotes, loadQueues: loadQueues, fetchPackLists: fetchPackLists,
    buildPackingList: buildPackingList, completePacking: completePacking, emailCustomer: emailCustomer,
    customerEmailHtml: customerEmailHtml, lookup: lookup, esc: esc, stripTags: stripTags
  };
})(typeof window !== 'undefined' ? window : globalThis);
