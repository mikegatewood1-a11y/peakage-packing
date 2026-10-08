/* Peak Age Packing — screens */
(function () {
  'use strict';
  var C = window.PackCore, esc = C.esc;
  var $view = document.getElementById('view');
  var $title = document.getElementById('title');
  var $back = document.getElementById('btnBack');
  var $camera = document.getElementById('camera');

  /* ---------- settings ---------- */
  var CFG_KEY = 'pa_cfg_v1';
  function today() { var d = new Date(); return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()); }
  function pad(n) { return (n < 10 ? '0' : '') + n; }
  function loadCfg() {
    var c = {};
    try { c = JSON.parse(localStorage.getItem(CFG_KEY) || '{}'); } catch (e) {}
    if (!c.storeUrl) c.storeUrl = 'https://peak-age.com';
    if (!c.days) c.days = 14;
    if (!c.startDate) { c.startDate = today(); saveCfg(c); }
    if (c.email === undefined) c.email = true;
    return c;
  }
  function saveCfg(c) { localStorage.setItem(CFG_KEY, JSON.stringify(c)); }
  var cfg = loadCfg();
  function configured() { return cfg.ck && cfg.cs; }

  /* ---------- transport: native bridge in the app, fetch in a browser ---------- */
  var pending = {}, seq = 0;
  window.__httpDone = function (id, status, text) {
    var p = pending[id]; if (!p) return; delete pending[id];
    p({ status: status, text: text });
  };
  function transport(method, url, headers, body, isB64) {
    if (window.AndroidBridge) {
      return new Promise(function (resolve) {
        var id = 'r' + (++seq); pending[id] = resolve;
        window.AndroidBridge.http(id, method, url, JSON.stringify(headers), body || '', isB64 ? '1' : '0');
      });
    }
    var init = { method: method, headers: headers };
    if (body) init.body = isB64 ? Uint8Array.from(atob(body), function (ch) { return ch.charCodeAt(0); }) : body;
    return fetch(url, init).then(function (r) { return r.text().then(function (t) { return { status: r.status, text: t }; }); },
      function (e) { return { status: 0, text: String(e) }; });
  }
  function api() { return C.createApi(cfg, transport); }

  /* ---------- state ---------- */
  var state = { tab: 'queue', queue: null, shipped: null, packCache: {}, checks: {}, loading: false, loadedAt: null, lookupTerm: '', lookupResults: null };
  var stack = []; // navigation stack of render functions

  function toast(msg, isErr) {
    var t = document.getElementById('toast');
    t.textContent = msg; t.className = 'toast' + (isErr ? ' error' : '');
    clearTimeout(toast._t); toast._t = setTimeout(function () { t.className = 'toast hidden'; }, isErr ? 6000 : 3000);
  }
  function busy(msg) {
    var o = document.createElement('div'); o.className = 'overlay'; o.innerHTML = '<div class="spinner"></div><div>' + esc(msg) + '</div>';
    document.body.appendChild(o); return function () { o.remove(); };
  }
  function setTitle(t, showBack) { $title.textContent = t; $back.classList.toggle('hidden', !showBack); }
  function fmtDate(iso) {
    if (!iso) return '';
    var d = new Date(iso.length === 19 ? iso + 'Z' : iso);
    return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' }) + ' ' + d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
  }
  function custName(o) { var s = o.shipping && o.shipping.first_name ? o.shipping : o.billing; return ((s.first_name || '') + ' ' + (s.last_name || '')).trim(); }
  function shipAddr(o) {
    var s = o.shipping && o.shipping.address_1 ? o.shipping : o.billing;
    return [custName(o), s.company, s.address_1, s.address_2, [s.city, s.state, s.postcode].filter(Boolean).join(', ')].filter(Boolean).join('\n');
  }

  /* ---------- data loading ---------- */
  function refresh() {
    if (!configured()) { showSettings(true); return; }
    state.loading = true; render();
    var a = api();
    C.loadQueues(a, cfg.days, cfg.startDate).then(function (q) {
      state.queue = q.notShipped; state.shipped = q.shipped; state.loadedAt = new Date();
      return C.fetchPackLists(a, q.notShipped.concat(q.shipped).map(function (r) { return r.order; }), state.packCache);
    }).then(function () {
      state.loading = false; render();
      document.getElementById('countQueue').textContent = state.queue.length;
    }).catch(function (e) {
      state.loading = false; render(); toast('Could not load orders: ' + e.message, true);
    });
  }

  /* ---------- top-level tabs ---------- */
  function render() {
    stack = [];
    document.querySelectorAll('.tabs button').forEach(function (b) { b.classList.toggle('active', b.dataset.tab === state.tab); });
    if (state.tab === 'queue') renderQueue();
    else if (state.tab === 'shipped') renderShipped();
    else renderLookup();
    window.scrollTo(0, 0);
  }

  function loadingHtml() { return '<div class="spinner"></div><p class="empty">Loading orders…</p>'; }

  function orderCard(r, i, list) {
    var o = r.order, pl = C.buildPackingList(o, state.packCache);
    var skus = (o.line_items || []).map(function (li) { return (li.quantity > 1 ? li.quantity + '× ' : '') + (li.sku || li.name); }).join(', ');
    var thumb = r.photos && r.photos.length ? '<img class="thumb" loading="lazy" src="' + esc(r.photos[r.photos.length - 1].url) + '">' : '';
    return '<div class="card order-card" data-list="' + list + '" data-i="' + i + '">' + thumb +
      '<div class="main"><div class="num">#' + esc(o.number) +
      (list === 'queue' && pl.warnings ? '<span class="pill warn">check items</span>' : '') +
      (list === 'shipped' ? (r.photos[r.photos.length - 1].emailed ? '<span class="pill ok">emailed</span>' : '<span class="pill warn">not emailed</span>') : '') +
      '</div><div class="who">' + esc(custName(o)) + '</div><div class="skus">' + esc(skus) + '</div>' +
      (list === 'shipped' ? '<div class="skus">Packed ' + esc(fmtDate(r.photos[r.photos.length - 1].at)) + '</div>' : '') +
      '</div><div class="chev">›</div></div>';
  }

  function bindCards(list, rows) {
    $view.querySelectorAll('.order-card').forEach(function (el) {
      el.onclick = function () { openOrder(rows[+el.dataset.i], list); };
    });
  }

  function renderQueue() {
    setTitle('Not Shipped', false);
    if (!configured()) { $view.innerHTML = '<p class="empty">Open Settings (⚙) to connect the store.</p>'; return; }
    if (state.loading || !state.queue) { $view.innerHTML = loadingHtml(); return; }
    var q = state.queue;
    var h = '';
    if (q.length) h += '<button class="btn" id="btnPrintAll">Print all ' + q.length + ' packing slips</button>';
    h += '<div class="section-title">' + q.length + ' order' + (q.length === 1 ? '' : 's') + ' to pack' +
      (state.loadedAt ? ' · updated ' + state.loadedAt.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' }) : '') + '</div>';
    if (!q.length) h += '<div class="empty">Nothing waiting. Orders appear here once their ShipStation label is printed.</div>';
    q.forEach(function (r, i) { h += orderCard(r, i, 'queue'); });
    var startToday = new Date(); startToday.setHours(0, 0, 0, 0);
    var older = q.filter(function (r) { return new Date(r.order.date_created_gmt ? r.order.date_created_gmt + 'Z' : r.order.date_created) < startToday; });
    if (older.length) h += '<button class="btn secondary" id="btnClearOld">Clear ' + older.length + ' order' + (older.length === 1 ? '' : 's') + ' from before today (already shipped)</button>';
    $view.innerHTML = h;
    bindCards('queue', q);
    var pb = document.getElementById('btnPrintAll'); if (pb) pb.onclick = function () { printSlips(q); };
    var cb = document.getElementById('btnClearOld');
    if (cb) cb.onclick = function () {
      if (!confirm('Mark these ' + older.length + ' orders placed before today as already shipped?\n\n' + older.map(function (r) { return '#' + r.order.number + ' ' + custName(r.order); }).join('\n') + '\n\nNo emails are sent. They stay searchable in Look Up.')) return;
      var done = busy('Clearing ' + older.length + ' orders…'), failed = 0;
      Promise.all(older.map(function (r) { return C.markShipped(api(), r.order, cfg.packer).catch(function () { failed++; }); })).then(function () {
        done(); toast(failed ? failed + ' could not be cleared; try again.' : 'Cleared ' + older.length + ' orders.', !!failed); refresh();
      });
    };
  }

  function renderShipped() {
    setTitle('Shipped', false);
    if (state.loading || !state.shipped) { $view.innerHTML = loadingHtml(); return; }
    var s = state.shipped, h = '<div class="section-title">Packed in the last ' + cfg.days + ' days</div>';
    if (!s.length) h += '<div class="empty">No packed orders yet.</div>';
    s.forEach(function (r, i) { h += orderCard(r, i, 'shipped'); });
    $view.innerHTML = h; bindCards('shipped', s);
  }

  function renderLookup() {
    setTitle('Look Up', false);
    var h = '<div class="search"><input id="q" type="search" placeholder="Order # or customer name" value="' + esc(state.lookupTerm) + '"><button class="btn" id="go">Search</button></div>';
    if (state.lookupResults === 'loading') h += '<div class="spinner"></div>';
    else if (state.lookupResults) {
      h += '<div class="section-title">' + state.lookupResults.length + ' result(s)</div>';
      if (!state.lookupResults.length) h += '<div class="empty">No orders found.</div>';
      state.lookupResults.forEach(function (r, i) {
        var o = r.order, ph = r.photos;
        h += '<div class="card order-card" data-i="' + i + '">' + (ph.length ? '<img class="thumb" loading="lazy" src="' + esc(ph[ph.length - 1].url) + '">' : '<div class="thumb"></div>') +
          '<div class="main"><div class="num">#' + esc(o.number) + (ph.length ? '<span class="pill ok">' + ph.length + ' photo' + (ph.length > 1 ? 's' : '') + '</span>' : '<span class="pill warn">no photo</span>') +
          '</div><div class="who">' + esc(custName(o)) + '</div><div class="skus">' + esc(fmtDate(o.date_created)) + ' · ' + esc(o.status) + '</div></div><div class="chev">›</div></div>';
      });
    } else h += '<p class="empty">Search by order number (e.g. 3725) or a customer\'s first or last name to see the photo of what was packed.</p>';
    $view.innerHTML = h;
    var $q = document.getElementById('q');
    function go() {
      state.lookupTerm = $q.value.trim(); if (!state.lookupTerm) return;
      state.lookupResults = 'loading'; renderLookup();
      C.lookup(api(), state.lookupTerm).then(function (orders) {
        state.lookupResults = orders.map(function (o) { return { order: o, photos: C.orderPhotos(o), tracking: null }; });
        return C.fetchPackLists(api(), orders, state.packCache);
      }).then(function () { if (state.tab === 'lookup') renderLookup(); })
        .catch(function (e) { state.lookupResults = []; renderLookup(); toast('Search failed: ' + e.message, true); });
    }
    document.getElementById('go').onclick = go;
    $q.onkeydown = function (e) { if (e.key === 'Enter') go(); };
    if (Array.isArray(state.lookupResults)) bindCards('lookup', state.lookupResults);
  }

  /* ---------- order screen ---------- */
  function openOrder(r, from) {
    stack.push(function () { render(); });
    var o = r.order;
    setTitle('Order #' + o.number, true);
    if (r.tracking === null) {
      $view.innerHTML = loadingHtml();
      C.fetchNotes(api(), o.id).then(function (notes) { r.tracking = C.parseTracking(notes); stack.pop(); openOrder(r, from); })
        .catch(function (e) { toast(e.message, true); r.tracking = []; stack.pop(); openOrder(r, from); });
      return;
    }
    var pl = C.buildPackingList(o, state.packCache);
    var checks = state.checks[o.id] || (state.checks[o.id] = {});
    var total = 0;
    var h = '<div class="card"><div class="head-num">#' + esc(o.number) + '</div>' +
      '<div class="addr">' + esc(shipAddr(o)) + '</div>' +
      '<div class="small muted" style="margin-top:6px">Ordered ' + esc(fmtDate(o.date_created)) + (o.shipping_lines && o.shipping_lines[0] ? ' · ' + esc(o.shipping_lines[0].method_title) : '') + '</div>' +
      (r.tracking.length ? '<div class="track small" style="margin-top:6px">' + r.tracking.map(function (t) { return esc(t.carrier) + ' <a href="' + esc(C.trackingUrl(t)) + '">' + esc(t.number) + '</a>'; }).join('<br>') + '</div>' : '<div class="small" style="color:var(--warn);margin-top:6px">No tracking number on this order yet.</div>') +
      (o.customer_note ? '<div class="small" style="margin-top:8px"><b>Customer note:</b> ' + esc(o.customer_note) + '</div>' : '') + '</div>';

    if (r.photos.length) {
      h += '<div class="section-title">Packing photo' + (r.photos.length > 1 ? 's' : '') + '</div>';
      r.photos.slice().reverse().forEach(function (p) {
        h += '<img class="photo" src="' + esc(p.url) + '"><div class="photo-meta">Packed ' + esc(fmtDate(p.at)) + (p.by ? ' by ' + esc(p.by) : '') + ' · ' + (p.emailed ? 'emailed to customer' : 'not emailed') + '</div>';
      });
    }

    h += '<div class="section-title">Items to pull</div><div class="card">';
    pl.lines.forEach(function (ln, li) {
      h += '<div class="line-head"><span>' + esc(ln.sku || '') + ' <span class="muted small">' + esc(ln.name) + '</span></span><span class="q">× ' + esc(ln.quantity) + '</span></div>';
      ln.contents.forEach(function (c, ci) {
        var key = li + ':' + ci; total++;
        h += '<label class="pick' + (checks[key] ? ' done' : '') + (c.review ? ' review' : '') + '"><input type="checkbox" data-k="' + key + '"' + (checks[key] ? ' checked' : '') + '>' +
          '<span class="what">' + esc(c.item) + (c.review ? '<span class="note">⚠ ' + esc(c.note || 'Quantity not set — check the Product Contents sheet') + '</span>' : '') + '</span>' +
          '<span class="qty">' + (c.qty === null ? '?' : esc(c.qty)) + '</span></label>';
      });
    });
    h += '<div class="progress"><div id="prog"></div></div><div class="small muted" id="progText"></div></div>';

    if (pl.lines.length > 1 || pl.totals.length !== pl.lines.reduce(function (a, l) { return a + l.contents.length; }, 0)) {
      h += '<div class="section-title">Total to pull for this order</div><div class="card small">' +
        pl.totals.map(function (t) { return '<div class="row" style="justify-content:space-between;padding:4px 0"><span>' + esc(t.item) + '</span><b>' + (t.unknown ? (t.qty ? t.qty + ' + ?' : '?') : t.qty) + '</b></div>'; }).join('') + '</div>';
    }

    h += '<div id="photoArea"></div>';
    h += '<button class="btn" id="btnPhoto">' + (r.photos.length ? 'Add another photo' : 'Take photo of packed order') + '</button>';
    h += '<button class="btn secondary" id="btnPrintOne">Print this packing slip</button>';
    if (r.photos.length) h += '<button class="btn secondary" id="btnResend">Email latest photo to customer again</button>';
    if (!r.photos.length && from === 'queue') h += '<button class="btn secondary" id="btnMarkShipped">Already shipped — remove from list</button>';
    $view.innerHTML = h;
    window.scrollTo(0, 0);

    function updateProgress() {
      var n = Object.keys(checks).filter(function (k) { return checks[k]; }).length;
      document.getElementById('prog').style.width = (total ? Math.round(100 * n / total) : 0) + '%';
      document.getElementById('progText').textContent = n + ' of ' + total + ' items laid out';
    }
    $view.querySelectorAll('.pick input').forEach(function (cb) {
      cb.onchange = function () { checks[cb.dataset.k] = cb.checked; cb.parentNode.classList.toggle('done', cb.checked); updateProgress(); };
    });
    updateProgress();
    document.getElementById('btnPhoto').onclick = function () { capturePhoto(r, total, checks); };
    document.getElementById('btnPrintOne').onclick = function () { printSlips([r]); };
    var ms = document.getElementById('btnMarkShipped');
    if (ms) ms.onclick = function () {
      if (!confirm('Order #' + o.number + ' was already shipped? It will be removed from Not Shipped. No email is sent.')) return;
      var done = busy('Updating order…');
      C.markShipped(api(), o, cfg.packer).then(function () {
        done();
        if (state.queue) state.queue = state.queue.filter(function (x) { return x.order.id !== o.id; });
        document.getElementById('countQueue').textContent = state.queue ? state.queue.length : 0;
        toast('Removed #' + o.number + ' from the list.'); stack = []; render();
      }, function (e) { done(); toast('Could not update: ' + e.message, true); });
    };
    var rs = document.getElementById('btnResend');
    if (rs) rs.onclick = function () {
      if (!confirm('Email the latest packing photo to ' + (o.billing.email || 'the customer') + ' again?')) return;
      var done = busy('Sending email…');
      C.emailCustomer(api(), o, r.photos[r.photos.length - 1].url, r.tracking).then(function () { done(); toast('Email sent.'); }, function (e) { done(); toast('Email failed: ' + e.message, true); });
    };
  }

  /* ---------- photo ---------- */
  function capturePhoto(r, total, checks) {
    var n = Object.keys(checks).filter(function (k) { return checks[k]; }).length;
    if (n < total && !confirm('Only ' + n + ' of ' + total + ' items are checked off. Take the photo anyway?')) return;
    $camera.value = '';
    $camera.onchange = function () {
      var f = $camera.files && $camera.files[0]; if (!f) return;
      var done = busy('Preparing photo…');
      resizeImage(f, 1600, 0.82).then(function (dataUrl) { done(); showPreview(r, dataUrl); }, function (e) { done(); toast('Could not read photo: ' + e.message, true); });
    };
    $camera.click();
  }

  function resizeImage(file, maxSide, quality) {
    return new Promise(function (resolve, reject) {
      var url = URL.createObjectURL(file), img = new Image();
      img.onload = function () {
        var s = Math.min(1, maxSide / Math.max(img.width, img.height));
        var c = document.createElement('canvas'); c.width = Math.round(img.width * s); c.height = Math.round(img.height * s);
        c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
        URL.revokeObjectURL(url); resolve(c.toDataURL('image/jpeg', quality));
      };
      img.onerror = function () { reject(new Error('unsupported image')); };
      img.src = url;
    });
  }

  function showPreview(r, dataUrl) {
    var o = r.order;
    var area = document.getElementById('photoArea');
    area.innerHTML = '<div class="section-title">New photo</div><img class="photo" src="' + dataUrl + '">' +
      '<label class="toggle"><input type="checkbox" id="chkEmail"' + (cfg.email && o.billing.email ? ' checked' : '') + (o.billing.email ? '' : ' disabled') + '> Email photo + tracking to ' + esc(o.billing.email || '(no email on order)') + '</label>' +
      '<div class="row"><button class="btn secondary" id="btnRetake">Retake</button><button class="btn ok" id="btnSave">Save photo</button></div>';
    document.getElementById('btnPhoto').classList.add('hidden');
    area.scrollIntoView({ behavior: 'smooth' });
    document.getElementById('btnRetake').onclick = function () { area.innerHTML = ''; document.getElementById('btnPhoto').classList.remove('hidden'); document.getElementById('btnPhoto').click(); };
    document.getElementById('btnSave').onclick = function () {
      var email = document.getElementById('chkEmail').checked;
      var done = busy(email ? 'Saving photo and emailing customer…' : 'Saving photo…');
      C.completePacking(api(), o, dataUrl.split(',')[1], { email: email, packer: cfg.packer || '', tracking: r.tracking }).then(function (photo) {
        done();
        r.photos = r.photos.concat([photo]);
        if (state.queue) state.queue = state.queue.filter(function (x) { return x.order.id !== o.id; });
        if (state.shipped && !state.shipped.some(function (x) { return x.order.id === o.id; })) state.shipped.unshift(r);
        document.getElementById('countQueue').textContent = state.queue ? state.queue.length : 0;
        toast(email ? 'Saved and emailed to the customer.' : 'Photo saved to the order.');
        stack.pop(); openOrder(r, 'shipped');
      }).catch(function (e) { done(); toast('Save failed: ' + e.message + '. Nothing was emailed; try again.', true); });
    };
  }

  /* ---------- printing ---------- */
  function slipHtml(r) {
    var o = r.order, pl = C.buildPackingList(o, state.packCache);
    var rows = '';
    pl.lines.forEach(function (ln) {
      rows += '<tr class="lh"><td colspan="3">' + esc(ln.sku || '') + ' — ' + esc(ln.name) + ' &nbsp; × ' + esc(ln.quantity) + '</td></tr>';
      ln.contents.forEach(function (c) {
        rows += '<tr><td class="box">&#9744;</td><td>' + esc(c.item) + (c.review ? '<div class="w">⚠ ' + esc(c.note || 'Quantity not set') + '</div>' : '') + '</td><td class="q">' + (c.qty === null ? '?' : esc(c.qty)) + '</td></tr>';
      });
    });
    return '<section class="slip"><div class="top"><div><div class="n">Order #' + esc(o.number) + '</div><div>' + esc(fmtDate(o.date_created)) + '</div></div>' +
      '<div class="addr">' + esc(shipAddr(o)) + '</div></div>' +
      '<div class="t">' + (r.tracking || []).map(function (t) { return esc(t.carrier) + ' ' + esc(t.number); }).join(' · ') + (o.shipping_lines && o.shipping_lines[0] ? ' · ' + esc(o.shipping_lines[0].method_title) : '') + '</div>' +
      (o.customer_note ? '<div class="cn"><b>Customer note:</b> ' + esc(o.customer_note) + '</div>' : '') +
      '<table>' + rows + '</table>' +
      '<div class="foot">Packed by: ________________ &nbsp;&nbsp; Photo taken: &#9744;</div></section>';
  }

  function printSlips(rows) {
    var html = '<!doctype html><html><head><meta charset="utf-8"><style>' +
      'body{font-family:Arial,sans-serif;margin:0;color:#000}.slip{padding:28px 32px;page-break-after:always}.slip:last-child{page-break-after:auto}' +
      '.top{display:flex;justify-content:space-between;gap:24px;border-bottom:3px solid #000;padding-bottom:10px}.n{font-size:30px;font-weight:800}' +
      '.addr{white-space:pre-line;font-size:15px;text-align:right}.t{margin:8px 0;font-size:14px}.cn{border:1px solid #000;padding:6px 8px;margin:8px 0;font-size:14px}' +
      'table{width:100%;border-collapse:collapse;margin-top:8px}td{padding:9px 6px;border-bottom:1px solid #999;font-size:17px;vertical-align:top}' +
      '.lh td{background:#e8e8e8;font-weight:700;font-size:14px;border-bottom:1px solid #000}.box{width:30px;font-size:24px;line-height:1}.q{width:60px;text-align:right;font-size:22px;font-weight:800}' +
      '.w{font-size:12px;font-weight:700}.foot{margin-top:24px;font-size:14px}</style></head><body>' +
      rows.map(slipHtml).join('') + '</body></html>';
    var job = 'Packing slips ' + today();
    if (window.AndroidBridge && window.AndroidBridge.print) window.AndroidBridge.print(html, job);
    else { var w = window.open('', '_blank'); w.document.write(html); w.document.close(); w.print(); }
  }

  /* ---------- settings ---------- */
  function showSettings(first) {
    stack.push(function () { render(); });
    setTitle('Settings', true);
    function f(id, label, val, type, hint) {
      return '<div class="field"><label for="' + id + '">' + label + '</label><input id="' + id + '" type="' + (type || 'text') + '" value="' + esc(val || '') + '" autocomplete="off" autocapitalize="off" spellcheck="false">' + (hint ? '<div class="hint">' + hint + '</div>' : '') + '</div>';
    }
    $view.innerHTML = (first ? '<div class="card small">Enter the store connection once. It stays on this phone.</div>' : '') +
      '<div class="card">' +
      f('sUrl', 'Store address', cfg.storeUrl) +
      f('sCk', 'WooCommerce consumer key', cfg.ck, 'text', 'Starts with ck_') +
      f('sCs', 'WooCommerce consumer secret', cfg.cs, 'password', 'Starts with cs_') +
      f('sWpU', 'WordPress username', cfg.wpUser, 'text', 'Used to upload photos') +
      f('sWpP', 'WordPress application password', cfg.wpPass, 'password', 'From Users → Profile → Application Passwords') +
      f('sPacker', 'Packer name', cfg.packer, 'text', 'Saved with each photo') +
      f('sStart', 'Only queue orders placed on or after', cfg.startDate, 'date', 'Older orders still show in Look Up') +
      f('sDays', 'Days of orders to check', cfg.days, 'number') +
      '<label class="toggle"><input type="checkbox" id="sEmail"' + (cfg.email ? ' checked' : '') + '> Email customers by default</label>' +
      '</div><button class="btn" id="sSave">Save</button><button class="btn secondary" id="sTest">Test connection</button>' +
      '<p class="small muted" style="text-align:center">Peak Age Packing v1.1</p>';
    function read() {
      return { storeUrl: val('sUrl').replace(/\/+$/, ''), ck: val('sCk'), cs: val('sCs'), wpUser: val('sWpU'), wpPass: val('sWpP'), packer: val('sPacker'),
        startDate: val('sStart') || today(), days: Math.max(1, parseInt(val('sDays'), 10) || 14), email: document.getElementById('sEmail').checked };
    }
    function val(id) { return document.getElementById(id).value.trim(); }
    document.getElementById('sSave').onclick = function () { cfg = read(); saveCfg(cfg); toast('Saved.'); stack = []; refresh(); };
    document.getElementById('sTest').onclick = function () {
      var c = read(), a = C.createApi(c, transport), done = busy('Testing…');
      a.call('GET', '/wc/v3/orders', { query: { per_page: 1 } }).then(function () {
        if (!c.wpUser) return 'Store OK. WordPress login not set, so photos can\'t upload yet.';
        return a.call('GET', '/wp/v2/users/me', { wp: true, query: { context: 'edit' } }).then(function (u) {
          var caps = u.capabilities || {};
          return caps.upload_files === false ? 'Store OK, but this WordPress user cannot upload files.' : 'All good: store and photo upload connected (' + (u.name || c.wpUser) + ').';
        }, function (e) { return 'Store OK. WordPress login failed: ' + e.message; });
      }).then(function (msg) { done(); toast(msg, /failed|cannot|not set/.test(msg)); }, function (e) { done(); toast('Store connection failed: ' + e.message, true); });
    };
  }

  /* ---------- wiring ---------- */
  document.querySelectorAll('.tabs button').forEach(function (b) {
    b.onclick = function () { state.tab = b.dataset.tab; render(); };
  });
  document.getElementById('btnRefresh').onclick = function () { stack = []; refresh(); };
  document.getElementById('btnSettings').onclick = function () { showSettings(false); };
  $back.onclick = function () { window.appBack(); };
  window.appBack = function () {
    var fn = stack.pop();
    if (fn) { fn(); return true; }
    if (state.tab !== 'queue') { state.tab = 'queue'; render(); return true; }
    return false;
  };

  render();
  refresh();
})();
