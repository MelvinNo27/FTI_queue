/*
 * P20 DDN – Waiting Room (queue gate)
 *
 * Visitors line up first. The real app (Firebase listeners, form, etc.) only
 * starts after they are let in, so at most `maxActive` people are connected
 * to the live database at the same time.
 *
 * While waiting, the page only makes short REST calls (no live connection).
 * Place in line is kept by the Firebase push-ID (time-ordered), and survives
 * a page refresh.
 *
 * Admin settings (Firebase console > Realtime Database > queue/config):
 *   { "enabled": true, "maxActive": 80 }
 *   enabled:false  -> waiting room is switched off, everyone goes straight in
 */
(function () {
  "use strict";

  // Same database the app already uses (derived from projectId).
  // If your database is in another region, replace with your real databaseURL.
  var DB_URL = "https://fti-queue-f29e9-default-rtdb.firebaseio.com";

  var DEFAULT_CFG = { enabled: true, maxActive: 80 };
  var POLL_MS = 5000; // how often a waiting person checks their place
  var HEARTBEAT_MS = 30000; // how often an admitted person says "still here"
  var STALE_WAITING_MS = 25000; // waiting entry ignored if not seen for this long
  var STALE_ACTIVE_MS = 90000; // admitted entry ignored if not seen for this long
  var SS_KEY = "pq_queue_key";

  var T = {
    en: {
      title: "You're in line",
      sub: "Many people are using the system right now. Please wait — you will be let in automatically.",
      posLabel: "Your position in line",
      ahead: "{n} ahead of you",
      next: "You're next!",
      note: "Keep this page open. If you refresh, you keep your place.",
      connecting: "Connecting…",
      retry: "Connection problem. Retrying…",
      enter: "It's your turn! Opening…",
    },
    ceb: {
      title: "Naa ka sa pila",
      sub: "Daghan kaayo ang naggamit sa sistema karon. Palihug paghulat — awtomatiko ka nga ipasulod.",
      posLabel: "Imong posisyon sa pila",
      ahead: "{n} sa imong unahan",
      next: "Ikaw na ang sunod!",
      note: "Ayaw sirad-i kini nga page. Kung i-refresh, magpabilin imong pwesto.",
      connecting: "Nagkonekta…",
      retry: "Problema sa koneksyon. Gisulayan pag-usab…",
      enter: "Imo na ang turno! Gibuksan…",
    },
  };
  var lang = "en";
  try {
    lang = localStorage.getItem("pq_lang") === "ceb" ? "ceb" : "en";
  } catch (e) {}
  function tr(k) {
    return T[lang][k];
  }

  // Hide the page behind the waiting room until we are let in (prevents a flash).
  var hideStyle = document.createElement("style");
  hideStyle.textContent =
    "body{visibility:hidden}#queue-gate{visibility:visible}";
  document.head.appendChild(hideStyle);

  var key = null;
  var admitted = false;
  var pollTimer = null;
  var gate = null;

  function noop() {}
  var SV = { ".sv": "timestamp" };

  function req(method, path, body, query, keepalive) {
    var url = DB_URL + "/queue/" + path + ".json" + (query ? "?" + query : "");
    var opts = { method: method, cache: "no-store" };
    if (body !== undefined) opts.body = JSON.stringify(body);
    if (keepalive) opts.keepalive = true;
    return fetch(url, opts).then(function (r) {
      if (!r.ok) {
        var e = new Error("HTTP " + r.status);
        e.status = r.status;
        throw e;
      }
      return r.json();
    });
  }

  // ── UI ──────────────────────────────────────────────────────────────────
  function build() {
    gate = document.createElement("div");
    gate.id = "queue-gate";
    gate.style.cssText =
      "position:fixed;inset:0;z-index:100000;background:linear-gradient(135deg,#1e3a5f,#2563eb);" +
      "display:flex;align-items:center;justify-content:center;padding:16px;" +
      "font-family:Nunito,sans-serif;";
    gate.innerHTML =
      '<div style="background:#fff;border-radius:20px;width:100%;max-width:380px;padding:26px 22px;' +
      'text-align:center;box-shadow:0 24px 60px rgba(0,0,0,.3);">' +
      '<div style="font-size:38px;line-height:1">🎫</div>' +
      '<div id="qg-title" style="font-size:20px;font-weight:800;color:#1e293b;margin-top:8px"></div>' +
      '<div id="qg-sub" style="font-size:13px;color:#4b5563;line-height:1.6;margin:8px 0 18px"></div>' +
      '<div style="background:#eff6ff;border:1.5px solid #bfdbfe;border-radius:14px;padding:14px 10px">' +
      '<div id="qg-poslabel" style="font-size:11px;font-weight:800;color:#6b7280;text-transform:uppercase;letter-spacing:.7px"></div>' +
      '<div id="qg-pos" style="font-size:52px;font-weight:800;color:#1d4ed8;line-height:1.1;font-family:\'Courier Prime\',monospace">…</div>' +
      '<div id="qg-ahead" style="font-size:13px;font-weight:700;color:#374151;min-height:18px"></div>' +
      "</div>" +
      '<div id="qg-status" style="font-size:12px;font-weight:700;color:#2563eb;margin-top:14px;min-height:16px"></div>' +
      '<div id="qg-note" style="font-size:11px;color:#92400e;background:#fffbeb;border:1px solid #fde68a;' +
      'border-radius:8px;padding:8px 10px;margin-top:12px;line-height:1.5"></div>' +
      "</div>";
    document.body.appendChild(gate);
    set("qg-title", tr("title"));
    set("qg-sub", tr("sub"));
    set("qg-poslabel", tr("posLabel"));
    set("qg-note", tr("note"));
    set("qg-status", tr("connecting"));
  }
  function set(id, txt) {
    var e = document.getElementById(id);
    if (e) e.textContent = txt;
  }
  function showPosition(pos) {
    set("qg-pos", String(pos));
    set(
      "qg-ahead",
      pos <= 1 ? tr("next") : tr("ahead").replace("{n}", pos - 1),
    );
    set("qg-status", "");
  }

  // ── Open the real app ───────────────────────────────────────────────────
  function runApp() {
    if (gate && gate.parentNode) gate.parentNode.removeChild(gate);
    if (hideStyle.parentNode) hideStyle.parentNode.removeChild(hideStyle);
    var parts = document.querySelectorAll('script[type="text/plain"][data-app]');
    Array.prototype.forEach.call(parts, function (old) {
      var s = document.createElement("script");
      s.text = old.textContent;
      document.body.appendChild(s);
    });
    // The app's own DOMContentLoaded listeners were registered after the event
    // already fired, so trigger them manually.
    document.dispatchEvent(new Event("DOMContentLoaded"));
  }

  function admit() {
    admitted = true;
    clearTimeout(pollTimer);
    set("qg-status", tr("enter"));
    return req("PUT", "active/" + key, SV)
      .catch(noop)
      .then(function () {
        return req("DELETE", "waiting/" + key).catch(noop);
      })
      .then(function () {
        setInterval(function () {
          req("PUT", "active/" + key, SV).catch(noop);
        }, HEARTBEAT_MS);
        setTimeout(runApp, 500);
      });
  }

  // ── Queue logic ─────────────────────────────────────────────────────────
  function step() {
    // 1) tell the server we are still waiting (also gives us "server now")
    return req("PUT", "waiting/" + key, SV)
      .then(function () {
        // 2) everyone ahead of me (push IDs sort by join time), who is inside, settings
        var q = "orderBy=%22%24key%22&endAt=%22" + encodeURIComponent(key) + "%22";
        return Promise.all([
          req("GET", "waiting", undefined, q),
          req("GET", "active"),
          req("GET", "config"),
        ]);
      })
      .then(function (r) {
        var ahead = r[0] || {};
        var active = r[1] || {};
        var cfg = Object.assign({}, DEFAULT_CFG, r[2] || {});

        var serverNow = ahead[key];
        if (typeof serverNow !== "number") serverNow = Date.now();

        var pos = 0;
        Object.keys(ahead).forEach(function (k) {
          var age = serverNow - ahead[k];
          if (age <= STALE_WAITING_MS) pos++;
          else if (age > 120000) req("DELETE", "waiting/" + k).catch(noop);
        });
        if (pos < 1) pos = 1;

        var inside = 0;
        Object.keys(active).forEach(function (k) {
          var age = serverNow - active[k];
          if (age <= STALE_ACTIVE_MS) inside++;
          else if (age > 300000) req("DELETE", "active/" + k).catch(noop);
        });

        var free = Math.max(Number(cfg.maxActive) - inside, 0);
        if (cfg.enabled === false || pos <= free) return admit();
        showPosition(pos);
      });
  }

  function tick() {
    if (admitted) return;
    var p;
    if (!key) {
      p = req("POST", "waiting", SV).then(function (res) {
        key = res.name;
        try {
          sessionStorage.setItem(SS_KEY, key);
        } catch (e) {}
        return step();
      });
    } else {
      p = step();
    }
    p.catch(function (e) {
      // Rules not set up yet -> don't lock everyone out, just open the app.
      if (e && (e.status === 401 || e.status === 403)) {
        console.warn(
          "[queue-gate] Database rules block /queue. Opening app without a waiting room.",
        );
        admitted = true;
        runApp();
        return;
      }
      set("qg-status", tr("retry"));
    }).then(function () {
      if (!admitted)
        pollTimer = setTimeout(tick, POLL_MS + Math.random() * 2000);
    });
  }

  function start() {
    build();
    try {
      key = sessionStorage.getItem(SS_KEY);
    } catch (e) {}
    tick();
  }

  // Free the spot / leave the line as soon as the tab is closed or refreshed.
  window.addEventListener("pagehide", function () {
    if (!key) return;
    try {
      fetch(
        DB_URL + "/queue/" + (admitted ? "active/" : "waiting/") + key + ".json",
        { method: "DELETE", keepalive: true },
      );
    } catch (e) {}
  });
  window.addEventListener("pageshow", function (e) {
    if (e.persisted) location.reload();
  });

  if (document.readyState === "loading")
    document.addEventListener("DOMContentLoaded", start, { once: true });
  else start();
})();
