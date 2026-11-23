// Check-in screen: camera QR scanning (jsQR), manual entry, live counter and undo.
// Without JavaScript the page still works: the manual form posts to the server.
(function () {
  'use strict';

  var root = document.querySelector('.checkin');
  if (!root) return;

  var RESULT_MS = 2000; // show each camera result for ~2 seconds, then get ready for the next scan
  var POLL_MS = 5000; // refresh the counter so several door devices stay in sync
  var SAME_CODE_GAP_MS = 1500; // ignore the same QR while it stays in front of the camera

  var eventId = root.getAttribute('data-event-id');
  var csrf = document.querySelector('meta[name="csrf-token"]').getAttribute('content');
  var resultEl = document.getElementById('result');
  var timerEl = document.getElementById('result-timer');
  var form = document.getElementById('manual-form');
  var input = document.getElementById('code-input');
  var countIn = document.getElementById('count-in');
  var countTotal = document.getElementById('count-total');
  var bar = document.getElementById('count-bar');
  var recentList = document.getElementById('recent-list');
  var scanner = document.getElementById('scanner');
  var video = document.getElementById('scanner-video');
  var statusEl = document.getElementById('scanner-status');
  var toggle = document.getElementById('camera-toggle');

  var busy = false;
  var resetTimer = null;
  var stream = null;
  var scanning = false;
  var paused = false;
  var wantCamera = false;
  var lastCode = null;
  var lastSeenAt = 0;
  var lastFrameAt = 0;
  var canvas = document.createElement('canvas');
  var ctx = canvas.getContext('2d', { willReadFrequently: true });
  var audio = null;

  // ------------------------------------------------------------ helpers
  function el(tag, className, text) {
    var node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined && text !== null) node.textContent = text;
    return node;
  }

  function hiddenInput(name, value) {
    var i = document.createElement('input');
    i.type = 'hidden';
    i.name = name;
    i.value = value;
    return i;
  }

  function undoForm(regId, name, className) {
    var f = el('form', className);
    f.method = 'post';
    f.action = '/staff/registrations/' + regId + '/undo-checkin';
    f.setAttribute('data-confirm', 'Undo the check-in for ' + name + '?');
    f.setAttribute('data-undo', String(regId));
    f.appendChild(hiddenInput('_csrf', csrf));
    f.appendChild(hiddenInput('return_to', '/staff/events/' + eventId + '/checkin'));
    return f;
  }

  function setStatus(text) {
    statusEl.textContent = text;
  }

  // Short beep + vibration so door staff don't have to stare at the screen.
  function feedback(tone) {
    try {
      if (navigator.vibrate) navigator.vibrate(tone === 'success' ? 80 : [180, 80, 180]);
      if (!audio) return;
      var notes = tone === 'success' ? [[880, 0, 0.12]] : tone === 'warning' ? [[520, 0, 0.15], [520, 0.2, 0.15]] : [[260, 0, 0.18], [220, 0.22, 0.25]];
      notes.forEach(function (n) {
        var osc = audio.createOscillator();
        var gain = audio.createGain();
        osc.frequency.value = n[0];
        gain.gain.value = 0.08;
        osc.connect(gain).connect(audio.destination);
        osc.start(audio.currentTime + n[1]);
        osc.stop(audio.currentTime + n[1] + n[2]);
      });
    } catch (e) { /* sound is optional */ }
  }

  function unlockAudio() {
    if (audio || !(window.AudioContext || window.webkitAudioContext)) return;
    try { audio = new (window.AudioContext || window.webkitAudioContext)(); } catch (e) { audio = null; }
  }

  // ------------------------------------------------------------ rendering
  function renderResult(r) {
    resultEl.className = 'result result-' + r.tone;
    resultEl.textContent = '';
    resultEl.appendChild(el('span', 'result-icon', r.icon)).setAttribute('aria-hidden', 'true');
    var text = el('div', 'result-text');
    text.appendChild(el('p', 'result-title', r.title));
    if (r.name) text.appendChild(el('p', 'result-name', r.name));
    if (r.message) text.appendChild(el('p', 'result-msg', r.message));
    if (r.code) text.appendChild(el('p', 'result-code mono', r.code));
    resultEl.appendChild(text);
    if (r.result === 'checked_in' && r.registrationId) {
      var f = undoForm(r.registrationId, r.name, 'result-undo');
      var b = el('button', 'btn btn-small btn-ghost', 'Undo');
      b.type = 'submit';
      f.appendChild(b);
      resultEl.appendChild(f);
    }
  }

  function renderReady(message) {
    renderResult({ tone: 'idle', icon: '⌁', title: 'Ready for next scan', message: message || 'Scan a QR code with the camera, or type the ticket code below.' });
  }

  function updateStats(stats) {
    if (!stats) return;
    countIn.textContent = stats.checkedIn;
    countTotal.textContent = stats.registered;
    bar.max = Math.max(stats.registered, 1);
    bar.value = stats.checkedIn;
    bar.textContent = stats.checkedIn + ' of ' + stats.registered;
  }

  function renderRecent(items) {
    if (!items) return;
    recentList.textContent = '';
    if (!items.length) {
      recentList.appendChild(el('li', 'muted', 'No one checked in yet.'));
      return;
    }
    items.forEach(function (r) {
      var li = el('li');
      var left = el('span');
      left.appendChild(el('strong', null, r.name));
      left.appendChild(document.createTextNode(' '));
      left.appendChild(el('span', 'mono muted', r.code));
      var side = el('span', 'recent-side');
      side.appendChild(el('span', 'muted', r.time));
      var f = undoForm(r.id, r.name);
      var b = el('button', 'link-button', 'Undo');
      b.type = 'submit';
      f.appendChild(b);
      side.appendChild(f);
      li.appendChild(left);
      li.appendChild(side);
      recentList.appendChild(li);
    });
  }

  function startResultTimer(onDone) {
    clearTimeout(resetTimer);
    timerEl.hidden = false;
    timerEl.classList.remove('run');
    void timerEl.offsetWidth; // restart the CSS animation
    timerEl.classList.add('run');
    resetTimer = setTimeout(function () {
      timerEl.hidden = true;
      timerEl.classList.remove('run');
      onDone();
    }, RESULT_MS);
  }

  // ------------------------------------------------------------ network
  function api(url, body) {
    return fetch(url, {
      method: body ? 'POST' : 'GET',
      credentials: 'same-origin',
      headers: body ? { 'Content-Type': 'application/json', Accept: 'application/json', 'X-CSRF-Token': csrf } : { Accept: 'application/json' },
      body: body ? JSON.stringify(body) : undefined,
    }).then(function (res) {
      return res.json().catch(function () { return {}; }).then(function (data) {
        if (res.status === 401) throw new Error('Your session ended. Reload the page and sign in again.');
        if (!res.ok) throw new Error(data.error || 'Something went wrong. Try again.');
        return data;
      });
    });
  }

  function submitCode(code, source) {
    if (busy) return;
    busy = true;
    clearTimeout(resetTimer);
    timerEl.hidden = true;
    renderResult({ tone: 'idle', icon: '…', title: 'Checking…', code: code });
    api('/staff/api/events/' + eventId + '/checkin', { code: code })
      .then(function (data) {
        renderResult(data);
        updateStats(data.stats);
        renderRecent(data.recent);
        feedback(data.tone);
      })
      .catch(function (err) {
        renderResult({ tone: 'danger', icon: '✕', title: 'Could not check in', message: err.message === 'Failed to fetch' ? 'No connection to the server. Check the Wi-Fi or data and try again.' : err.message, code: code });
        feedback('danger');
      })
      .then(function () {
        busy = false;
        if (source === 'camera') {
          setStatus('Showing result…');
          startResultTimer(function () {
            paused = false;
            lastSeenAt = performance.now();
            scanner.classList.remove('paused');
            setStatus('Ready: point the camera at the next ticket');
            renderReady('Point the camera at the next ticket.');
          });
        }
      });
  }

  function undo(regId) {
    api('/staff/api/registrations/' + regId + '/undo-checkin', {})
      .then(function (data) {
        renderResult({ tone: 'warning', icon: '↺', title: 'Check-in undone', name: data.name, message: 'This ticket can be checked in again. The undo is recorded in the audit log.', code: data.code });
        updateStats(data.stats);
        renderRecent(data.recent);
      })
      .catch(function (err) {
        renderResult({ tone: 'danger', icon: '✕', title: 'Could not undo', message: err.message });
      });
  }

  // ------------------------------------------------------------ camera
  function cameraProblem(message) {
    scanner.hidden = false;
    scanner.classList.add('scanner-error');
    setStatus(message);
  }

  function startCamera() {
    wantCamera = true;
    scanner.hidden = false;
    scanner.classList.remove('scanner-error');
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      cameraProblem(window.isSecureContext ? 'This browser cannot use the camera. Type the code below instead.' : 'The camera needs HTTPS (or localhost). Type the code below instead.');
      return;
    }
    if (typeof window.jsQR !== 'function') {
      cameraProblem('The QR scanner did not load. Type the code below instead.');
      return;
    }
    setStatus('Starting camera…');
    navigator.mediaDevices
      .getUserMedia({ video: { facingMode: { ideal: 'environment' }, width: { ideal: 1280 }, height: { ideal: 720 } }, audio: false })
      .then(function (s) {
        stream = s;
        video.srcObject = s;
        return video.play();
      })
      .then(function () {
        scanning = true;
        paused = false;
        toggle.textContent = 'Stop camera';
        setStatus('Point the camera at a ticket QR code');
        requestAnimationFrame(tick);
      })
      .catch(function (err) {
        stopCamera(true);
        wantCamera = false;
        cameraProblem(err && err.name === 'NotAllowedError'
          ? 'Camera access was blocked. Allow it in the browser’s site settings, or type the code below.'
          : 'Could not start the camera' + (err && err.name ? ' (' + err.name + ')' : '') + '. Type the code below instead.');
      });
  }

  function stopCamera(keepWanted) {
    scanning = false;
    if (!keepWanted) wantCamera = false;
    if (stream) stream.getTracks().forEach(function (t) { t.stop(); });
    stream = null;
    video.srcObject = null;
    scanner.hidden = true;
    toggle.textContent = '📷 Scan with camera';
  }

  function tick(now) {
    if (!scanning) return;
    requestAnimationFrame(tick);
    if (now - lastFrameAt < 120) return; // ~8 scans per second is plenty
    lastFrameAt = now;
    if (paused || busy || video.readyState < 2 || !video.videoWidth) return;

    var scale = Math.min(1, 720 / Math.max(video.videoWidth, video.videoHeight));
    canvas.width = Math.round(video.videoWidth * scale);
    canvas.height = Math.round(video.videoHeight * scale);
    ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
    var image = ctx.getImageData(0, 0, canvas.width, canvas.height);
    var found = window.jsQR(image.data, image.width, image.height, { inversionAttempts: 'dontInvert' });
    if (!found || !found.data) return;

    var code = found.data.trim();
    if (code === lastCode && now - lastSeenAt < SAME_CODE_GAP_MS) {
      lastSeenAt = now; // same ticket still held up: don't scan it again
      return;
    }
    lastCode = code;
    lastSeenAt = now;
    paused = true;
    scanner.classList.add('paused');
    setStatus('Checking ' + code + '…');
    submitCode(code, 'camera');
  }

  // ------------------------------------------------------------ wiring
  toggle.hidden = false;
  toggle.addEventListener('click', function () {
    unlockAudio();
    if (scanning || wantCamera) stopCamera();
    else startCamera();
  });

  form.addEventListener('submit', function (event) {
    event.preventDefault();
    unlockAudio();
    var code = input.value.trim();
    if (!code) {
      input.focus();
      return;
    }
    submitCode(code, 'manual');
    input.value = '';
    input.focus();
  });

  // Undo buttons (in the result panel and the recent list) use the JSON API.
  root.addEventListener('submit', function (event) {
    var f = event.target;
    if (!f.hasAttribute || !f.hasAttribute('data-undo')) return;
    event.preventDefault();
    undo(f.getAttribute('data-undo'));
  });

  document.addEventListener('visibilitychange', function () {
    if (document.hidden && scanning) {
      stopCamera(true); // save battery; resume when the tab is visible again
    } else if (!document.hidden && wantCamera && !scanning) {
      startCamera();
    }
  });

  setInterval(function () {
    if (document.hidden || busy) return;
    api('/staff/api/events/' + eventId + '/stats')
      .then(function (data) {
        updateStats(data.stats);
        renderRecent(data.recent);
      })
      .catch(function () { /* next poll will retry */ });
  }, POLL_MS);
})();
