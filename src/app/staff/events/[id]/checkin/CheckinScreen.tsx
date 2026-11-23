'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import jsQR from 'jsqr';
import { useCallback, useEffect, useRef, useState } from 'react';
import type { CheckinResult, RecentCheckin } from '@/lib/checkin';
import type { Stats } from '@/lib/types';
import { checkInAction, undoCheckInAction } from '../../../checkin-actions';

const RESULT_MS = 2000; // show each camera result for ~2 seconds, then get ready for the next scan
const POLL_MS = 5000; // refresh the counter so several door devices stay in sync
const SAME_CODE_GAP_MS = 1500; // ignore the same QR while it stays in front of the camera

type Display = {
  tone: 'idle' | 'success' | 'warning' | 'danger';
  icon: string;
  title: string;
  name?: string | null;
  message?: string;
  code?: string;
  undoId?: number | null;
};

const READY: Display = { tone: 'idle', icon: '⌁', title: 'Ready to scan', message: 'Scan a QR code with the camera, or type the ticket code below.' };

type Props = {
  event: { id: number; title: string; dateLabel: string; timeLabel: string; venue: string; isEventDay: boolean };
  initialStats: Stats;
  initialRecent: RecentCheckin[];
};

export function CheckinScreen({ event, initialStats, initialRecent }: Props) {
  const router = useRouter();
  const [display, setDisplay] = useState<Display>(READY);
  const [stats, setStats] = useState(initialStats);
  const [recent, setRecent] = useState(initialRecent);
  const [cameraOn, setCameraOn] = useState(false);
  const [scannerStatus, setScannerStatus] = useState('');
  const [cameraError, setCameraError] = useState(false);
  const [paused, setPaused] = useState(false);
  const [timerKey, setTimerKey] = useState(0); // restarts the result countdown bar

  const videoRef = useRef<HTMLVideoElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const busyRef = useRef(false);
  const pausedRef = useRef(false);
  const wantCameraRef = useRef(false);
  const lastRef = useRef({ code: '', seenAt: 0, frameAt: 0 });
  const resetTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const audioRef = useRef<AudioContext | null>(null);

  // ---------------------------------------------------------------- feedback
  const unlockAudio = () => {
    if (audioRef.current || typeof window.AudioContext === 'undefined') return;
    try {
      audioRef.current = new AudioContext();
    } catch {
      audioRef.current = null;
    }
  };

  /** Short beep + vibration so door staff don't have to stare at the screen. */
  const feedback = (tone: Display['tone']) => {
    try {
      navigator.vibrate?.(tone === 'success' ? 80 : [180, 80, 180]);
      const audio = audioRef.current;
      if (!audio) return;
      const notes = tone === 'success' ? [[880, 0, 0.12]] : tone === 'warning' ? [[520, 0, 0.15], [520, 0.2, 0.15]] : [[260, 0, 0.18], [220, 0.22, 0.25]];
      for (const [freq, at, len] of notes) {
        const osc = audio.createOscillator();
        const gain = audio.createGain();
        osc.frequency.value = freq;
        gain.gain.value = 0.08;
        osc.connect(gain).connect(audio.destination);
        osc.start(audio.currentTime + at);
        osc.stop(audio.currentTime + at + len);
      }
    } catch {
      /* sound is optional */
    }
  };

  const showResult = (r: CheckinResult) =>
    setDisplay({ tone: r.tone, icon: r.icon, title: r.title, name: r.name, message: r.message, code: r.code, undoId: r.result === 'checked_in' ? r.registrationId : null });

  const signedOut = useCallback(() => {
    router.push(`/staff/login?next=${encodeURIComponent(window.location.pathname)}`);
  }, [router]);

  // ---------------------------------------------------------------- actions
  const submitCode = useCallback(
    async (code: string, source: 'camera' | 'manual') => {
      if (busyRef.current) return;
      busyRef.current = true;
      if (resetTimer.current) clearTimeout(resetTimer.current);
      setDisplay({ tone: 'idle', icon: '…', title: 'Checking…', code });
      let tone: Display['tone'] = 'danger';
      try {
        const out = await checkInAction(event.id, code);
        if (out.ok) {
          showResult(out.result);
          setStats(out.result.stats);
          setRecent(out.recent);
          tone = out.result.tone;
        } else {
          if (out.signedOut) return signedOut();
          setDisplay({ tone: 'danger', icon: '✕', title: 'Could not check in', message: out.error, code });
        }
      } catch {
        setDisplay({ tone: 'danger', icon: '✕', title: 'Could not check in', message: 'No connection to the server. Check the Wi-Fi or data and try again.', code });
      } finally {
        busyRef.current = false;
      }
      feedback(tone);

      if (source === 'camera') {
        setScannerStatus('Showing result…');
        setTimerKey((k) => k + 1);
        resetTimer.current = setTimeout(() => {
          setTimerKey(0);
          pausedRef.current = false;
          setPaused(false);
          lastRef.current.seenAt = performance.now();
          setScannerStatus('Ready: point the camera at the next ticket');
          setDisplay({ ...READY, title: 'Ready for next scan', message: 'Point the camera at the next ticket.' });
        }, RESULT_MS);
      }
    },
    [event.id, signedOut]
  );

  const undo = async (registrationId: number, name: string | null | undefined) => {
    if (!window.confirm(`Undo the check-in for ${name || 'this person'}?`)) return;
    try {
      const out = await undoCheckInAction(registrationId);
      if (!out.ok) {
        if (out.signedOut) return signedOut();
        setDisplay({ tone: 'danger', icon: '✕', title: 'Could not undo', message: out.error });
        return;
      }
      setDisplay({ tone: 'warning', icon: '↺', title: 'Check-in undone', name: out.name, message: 'This ticket can be checked in again. The undo is recorded in the audit log.', code: out.code });
      setStats(out.stats);
      setRecent(out.recent);
    } catch {
      setDisplay({ tone: 'danger', icon: '✕', title: 'Could not undo', message: 'No connection to the server. Try again.' });
    }
  };

  // ---------------------------------------------------------------- camera
  const stopCamera = useCallback((keepWanted = false) => {
    if (!keepWanted) wantCameraRef.current = false;
    streamRef.current?.getTracks().forEach((t) => t.stop());
    streamRef.current = null;
    if (videoRef.current) videoRef.current.srcObject = null;
    setCameraOn(false);
  }, []);

  const cameraProblem = (message: string) => {
    setCameraError(true);
    setScannerStatus(message);
  };

  const startCamera = useCallback(async () => {
    wantCameraRef.current = true;
    setCameraError(false);
    if (!navigator.mediaDevices?.getUserMedia) {
      cameraProblem(window.isSecureContext ? 'This browser cannot use the camera. Type the code below instead.' : 'The camera needs HTTPS (or localhost). Type the code below instead.');
      return;
    }
    setScannerStatus('Starting camera…');
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: { ideal: 'environment' }, width: { ideal: 1280 }, height: { ideal: 720 } }, audio: false });
      streamRef.current = stream;
      const video = videoRef.current!;
      video.srcObject = stream;
      await video.play();
      pausedRef.current = false;
      setPaused(false);
      setCameraOn(true);
      setScannerStatus('Point the camera at a ticket QR code');
    } catch (err) {
      stopCamera();
      const name = err instanceof DOMException ? err.name : '';
      cameraProblem(
        name === 'NotAllowedError'
          ? 'Camera access was blocked. Allow it in the browser’s site settings, or type the code below.'
          : `Could not start the camera${name ? ` (${name})` : ''}. Type the code below instead.`
      );
    }
  }, [stopCamera]);

  // Decode frames while the camera is on (~8 per second is plenty).
  useEffect(() => {
    if (!cameraOn) return;
    const canvas = document.createElement('canvas');
    const ctx = canvas.getContext('2d', { willReadFrequently: true })!;
    let frame = 0;
    const tick = (now: number) => {
      frame = requestAnimationFrame(tick);
      const video = videoRef.current;
      const last = lastRef.current;
      if (now - last.frameAt < 120) return;
      last.frameAt = now;
      if (!video || pausedRef.current || busyRef.current || video.readyState < 2 || !video.videoWidth) return;

      const scale = Math.min(1, 720 / Math.max(video.videoWidth, video.videoHeight));
      canvas.width = Math.round(video.videoWidth * scale);
      canvas.height = Math.round(video.videoHeight * scale);
      ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
      const image = ctx.getImageData(0, 0, canvas.width, canvas.height);
      const found = jsQR(image.data, image.width, image.height, { inversionAttempts: 'dontInvert' });
      if (!found?.data) return;

      const code = found.data.trim();
      if (code === last.code && now - last.seenAt < SAME_CODE_GAP_MS) {
        last.seenAt = now; // same ticket still held up: don't scan it again
        return;
      }
      last.code = code;
      last.seenAt = now;
      pausedRef.current = true;
      setPaused(true);
      setScannerStatus(`Checking ${code}…`);
      void submitCode(code, 'camera');
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [cameraOn, submitCode]);

  // Save battery: stop the camera when the tab is hidden, resume when it's visible again.
  useEffect(() => {
    const onVisibility = () => {
      if (document.hidden && streamRef.current) stopCamera(true);
      else if (!document.hidden && wantCameraRef.current && !streamRef.current) void startCamera();
    };
    document.addEventListener('visibilitychange', onVisibility);
    return () => {
      document.removeEventListener('visibilitychange', onVisibility);
      stopCamera();
      if (resetTimer.current) clearTimeout(resetTimer.current);
    };
  }, [startCamera, stopCamera]);

  // Live counter.
  useEffect(() => {
    const id = setInterval(async () => {
      if (document.hidden || busyRef.current) return;
      try {
        const res = await fetch(`/staff/api/events/${event.id}/stats`, { cache: 'no-store', headers: { Accept: 'application/json' } });
        if (res.status === 401) return signedOut();
        if (!res.ok) return;
        const data = await res.json();
        setStats(data.stats);
        setRecent(data.recent);
      } catch {
        /* the next poll will retry */
      }
    }, POLL_MS);
    return () => clearInterval(id);
  }, [event.id, signedOut]);

  const scannerVisible = cameraOn || cameraError || scannerStatus === 'Starting camera…';

  return (
    <div className="checkin">
      <div className="checkin-head">
        <div>
          <Link className="back-link" href="/staff/checkin">
            ← Change event
          </Link>
          <h1 className="checkin-title">{event.title}</h1>
          <p className="meta">
            {event.dateLabel} · {event.timeLabel} · {event.venue}
          </p>
        </div>
        <div className="counter" aria-live="polite">
          <span className="counter-num">
            {stats.checkedIn} / {stats.registered}
          </span>
          <span className="counter-label">checked in</span>
          <progress max={Math.max(stats.registered, 1)} value={stats.checkedIn}>
            {stats.checkedIn} of {stats.registered}
          </progress>
        </div>
      </div>

      {!event.isEventDay && (
        <div className="notice notice-warning">
          <strong>Not the event day.</strong> Tickets can only be checked in on {event.dateLabel}. Scans today will show the ticket status but won&apos;t check
          anyone in.
        </div>
      )}

      <div className={`result result-${display.tone}`} role="status" aria-live="assertive" aria-atomic="true">
        <span className="result-icon" aria-hidden="true">
          {display.icon}
        </span>
        <div className="result-text">
          <p className="result-title">{display.title}</p>
          {display.name && <p className="result-name">{display.name}</p>}
          {display.message && <p className="result-msg">{display.message}</p>}
          {display.code && <p className="result-code mono">{display.code}</p>}
        </div>
        {display.undoId && (
          <div className="result-undo">
            <button className="btn btn-small btn-ghost" type="button" onClick={() => undo(display.undoId!, display.name)}>
              Undo
            </button>
          </div>
        )}
      </div>
      <div className={`result-timer${timerKey ? ' run' : ''}`} hidden={!timerKey} key={timerKey}>
        <span />
      </div>

      <section className={`scanner${paused ? ' paused' : ''}${cameraError ? ' scanner-error' : ''}`} hidden={!scannerVisible}>
        <div className="scanner-view">
          <video ref={videoRef} playsInline muted />
          <div className="scanner-frame" aria-hidden="true" />
        </div>
        <p className="scanner-status">{scannerStatus}</p>
      </section>

      <div className="scanner-controls">
        <button
          type="button"
          className="btn btn-primary btn-big"
          onClick={() => {
            unlockAudio();
            if (cameraOn || wantCameraRef.current) {
              stopCamera();
              setScannerStatus('');
              setCameraError(false);
            } else void startCamera();
          }}
        >
          {cameraOn ? 'Stop camera' : '📷 Scan with camera'}
        </button>
      </div>

      <form
        className="manual"
        autoComplete="off"
        onSubmit={(e) => {
          e.preventDefault();
          unlockAudio();
          const input = inputRef.current!;
          const code = input.value.trim();
          if (!code) return input.focus();
          void submitCode(code, 'manual');
          input.value = '';
          input.focus();
        }}
      >
        <label htmlFor="code-input">Ticket code</label>
        <div className="manual-row">
          <input
            ref={inputRef}
            id="code-input"
            name="code"
            type="text"
            placeholder="e.g. CDM-7K3P9QXM"
            autoCapitalize="characters"
            spellCheck={false}
            autoComplete="off"
            enterKeyHint="go"
            maxLength={32}
            autoFocus
            required
          />
          <button className="btn btn-primary" type="submit">
            Check in
          </button>
        </div>
        <p className="hint">A USB or Bluetooth QR scanner that types the code and presses Enter works here too.</p>
      </form>

      <section className="recent">
        <h2 className="section-title">Recent check-ins</h2>
        <ul className="recent-list">
          {recent.length === 0 && <li className="muted">No one checked in yet.</li>}
          {recent.map((r) => (
            <li key={r.id}>
              <span>
                <strong>{r.name}</strong> <span className="mono muted">{r.code}</span>
              </span>
              <span className="recent-side">
                <span className="muted">{r.time}</span>
                <button className="link-button" type="button" onClick={() => undo(r.id, r.name)}>
                  Undo
                </button>
              </span>
            </li>
          ))}
        </ul>
      </section>
    </div>
  );
}
