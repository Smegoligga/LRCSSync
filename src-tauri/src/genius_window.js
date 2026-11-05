// Runs inside the Genius window opened by LRCSSync. Shows a bar at the top; once the lyrics are on the
// page (after any bot check) it sends them back to LRCSSync automatically.
(function () {
  if (window.top !== window) return;
  if (!/(^|\.)genius\.com$/.test(location.hostname)) return;
  var sent = false, cancelled = false, countdown = null;

  function extract() {
    var cs = document.querySelectorAll('[data-lyrics-container="true"]');
    if (!cs.length) return null;
    var parts = [];
    cs.forEach(function (c) {
      var x = c.cloneNode(true);
      x.querySelectorAll('[data-exclude-from-selection="true"]').forEach(function (e) { e.remove(); });
      x.querySelectorAll('br').forEach(function (b) { b.replaceWith('\n'); });
      parts.push(x.textContent);
    });
    var t = parts.join('\n').replace(/\n{3,}/g, '\n\n').trim();
    return t.length > 20 ? t : null;
  }

  function isCheck() {
    return /just a moment|attention required|verify/i.test(document.title) ||
      !!document.querySelector('#challenge-form, #challenge-stage, .cf-turnstile, iframe[src*="challenges.cloudflare.com"], #cf-challenge-running');
  }

  function bar() {
    var b = document.getElementById('lrcs-bar');
    if (b) return b;
    b = document.createElement('div');
    b.id = 'lrcs-bar';
    b.style.cssText = 'position:fixed;left:0;right:0;top:0;z-index:2147483647;display:flex;gap:10px;align-items:center;' +
      'padding:10px 14px;background:#161924;color:#e6e8f0;font:14px system-ui,sans-serif;box-shadow:0 4px 18px rgba(0,0,0,.5);border-bottom:2px solid #8b7bff';
    b.innerHTML = '<b style="color:#a698ff">LRCSSync</b><span id="lrcs-msg" style="flex:1"></span>' +
      '<button id="lrcs-send" style="display:none;background:#8b7bff;color:#fff;border:0;border-radius:8px;padding:8px 14px;font:inherit;font-weight:600;cursor:pointer">Send lyrics to LRCSSync</button>' +
      '<button id="lrcs-reload" style="background:#262b3e;color:#e6e8f0;border:1px solid #3a4058;border-radius:8px;padding:8px 12px;font:inherit;cursor:pointer">Reload</button>';
    (document.body || document.documentElement).appendChild(b);
    b.querySelector('#lrcs-reload').onclick = function () { location.reload(); };
    b.querySelector('#lrcs-send').onclick = function () { send(true); };
    return b;
  }

  function msg(t) { var m = document.getElementById('lrcs-msg'); if (m) m.textContent = t; }

  function send(now) {
    var t = extract();
    if (!t || sent) return;
    try { navigator.clipboard && navigator.clipboard.writeText(t).catch(function () {}); } catch (e) {}
    if (!now) return;
    sent = true;
    msg('Sent. You can close this window.');
    window.__TAURI_INTERNALS__.invoke('genius_lyrics', { text: t }).catch(function (e) { sent = false; msg('Could not send: ' + e + '. The lyrics are copied, paste them in LRCSSync.'); });
  }

  var startedAt = Date.now();
  function tick() {
    if (sent) return;
    if (!document.body) return;
    bar();
    var t = extract();
    var btn = document.getElementById('lrcs-send');
    if (t) {
      btn.style.display = '';
      if (cancelled) { msg('Lyrics found.'); return; }
      if (countdown == null) countdown = 3;
      msg('Lyrics found and copied. Sending to LRCSSync in ' + countdown + '...  (click the page to stop)');
      if (countdown-- <= 0) send(true);
      else send(false);
    } else if (isCheck() || Date.now() - startedAt > 9000) {
      msg('Complete the check on this page. If it keeps failing, turn off your VPN, then press Reload.');
    } else {
      msg('Waiting for the lyrics...');
    }
  }
  document.addEventListener('click', function (e) { if (!e.target.closest || !e.target.closest('#lrcs-bar')) cancelled = true; }, true);
  setInterval(tick, 1000);
})();
