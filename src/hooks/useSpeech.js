import { useCallback, useEffect, useRef, useState } from 'react';

/* =============================================================================
 * Robust browser speech recognition (Web Speech API) — desktop-proof edition.
 *
 * Why voice capture used to die on laptops/PCs, and what this hook does now:
 *
 *  1. Chrome/Edge END continuous recognition after a few seconds of silence
 *     (`onend`). The old hook just stopped listening. → We auto-restart
 *     transparently for as long as the user intends to record, carrying the
 *     accumulated transcript across restarts so no words are lost.
 *  2. Calling `recognition.start()` without microphone permission could fail
 *     silently or with a vague error. → We first run `getUserMedia` with
 *     echo-cancellation / noise-suppression / auto-gain (quiet built-in
 *     laptop mics get boosted), which both secures permission and yields
 *     precise errors: blocked, no device, device busy, insecure page.
 *  3. Recoverable errors (`no-speech`, transient `network`) killed capture.
 *     → They now retry with backoff; only hard failures stop the session.
 *  4. There was no way to tell whether the mic heard anything. → A live
 *     input-level meter (WebAudio analyser) is exposed as `level` (0..1).
 *  5. Starting twice threw `InvalidStateError`; orphaned instances could hold
 *     the microphone. → Single-instance lifecycle management with guards.
 *  6. If the app is embedded in an iframe without microphone delegation, the
 *     browser blocks capture. → We detect that and tell the user to open the
 *     app in its own tab (see `embedded` + the error message).
 * ========================================================================== */

const isEmbedded = () => {
  try { return typeof window !== 'undefined' && window.self !== window.top; } catch { return true; }
};

const MIC_MESSAGES = {
  unsupported: 'Speech recognition is not supported in this browser. Use Chrome or Edge on desktop/Android, or type your answer.',
  insecure: 'Voice input needs a secure page. Open InterviewHub over HTTPS (or on localhost) to use the microphone.',
  denied: 'Microphone access is blocked. Click the lock / tune icon in the address bar → Site settings → allow Microphone, then tap the mic again.',
  deniedEmbedded: 'Microphone is blocked because this page is embedded in another site. Open InterviewHub in its own browser tab, allow the microphone, and try again.',
  missing: 'No microphone was found. Plug in a headset or enable your laptop microphone in your OS sound settings, then retry.',
  busy: 'Your microphone is being used by another app (Zoom, Meet, Teams…). Close that app and tap the mic again.',
  network: 'The speech service could not be reached — desktop Chrome transcribes online. Check your internet connection, or type your answer.',
  capture: 'Your browser could not capture audio from the microphone. Check the device in your OS/browser sound settings, or type your answer.',
  generic: 'Voice input hit a snag. Tap the mic to retry, or type your answer.',
};

export function useSpeechRecognition({ lang = 'en-US' } = {}) {
  const supported = typeof window !== 'undefined' && Boolean(window.SpeechRecognition || window.webkitSpeechRecognition);
  const [listening, setListening] = useState(false);
  const [liveText, setLiveText] = useState('');
  const [error, setError] = useState('');
  const [errorCode, setErrorCode] = useState('');
  const [micState, setMicState] = useState('idle'); // idle|requesting|live|denied|missing|busy|insecure|unsupported|error
  const [level, setLevel] = useState(0);

  const recRef = useRef(null);
  const wantRef = useRef(false);        // user intent — drives auto-restart
  const runningRef = useRef(false);     // recognition instance actually live
  const baseFinalRef = useRef('');      // finals from previous SR instances (this start)
  const sessionFinalRef = useRef('');   // finals within the current SR instance
  const restartTimerRef = useRef(null);
  const networkFailsRef = useRef(0);
  const streamRef = useRef(null);       // getUserMedia stream (permission + level meter)
  const audioCtxRef = useRef(null);
  const rafRef = useRef(null);

  /* ------------------------- live input-level meter ------------------------- */
  const startLevelMeter = useCallback((stream) => {
    try {
      const AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) return;
      const ctx = new AC();
      audioCtxRef.current = ctx;
      if (ctx.state === 'suspended') ctx.resume().catch(() => {});
      const analyser = ctx.createAnalyser();
      analyser.fftSize = 512;
      ctx.createMediaStreamSource(stream).connect(analyser);
      const data = new Uint8Array(analyser.fftSize);
      const tick = () => {
        analyser.getByteTimeDomainData(data);
        let sum = 0;
        for (let i = 0; i < data.length; i++) {
          const v = (data[i] - 128) / 128;
          sum += v * v;
        }
        const rms = Math.sqrt(sum / data.length);
        setLevel((prev) => Math.min(1, Math.max(rms * 2.4, prev * 0.82))); // smooth decay
        rafRef.current = requestAnimationFrame(tick);
      };
      tick();
    } catch { /* meter is best-effort; recognition still works without it */ }
  }, []);

  const stopLevelMeter = useCallback(() => {
    if (rafRef.current) cancelAnimationFrame(rafRef.current);
    rafRef.current = null;
    setLevel(0);
    try { audioCtxRef.current?.close(); } catch { /* noop */ }
    audioCtxRef.current = null;
  }, []);

  const releaseMicStream = useCallback(() => {
    stopLevelMeter();
    try { streamRef.current?.getTracks().forEach((t) => t.stop()); } catch { /* noop */ }
    streamRef.current = null;
  }, [stopLevelMeter]);

  /* -------- permission pre-flight: precise errors, better laptop audio -------- */
  const ensureMic = useCallback(async () => {
    if (streamRef.current) return true;
    if (typeof window !== 'undefined' && window.isSecureContext === false) {
      throw Object.assign(new Error(MIC_MESSAGES.insecure), { code: 'insecure' });
    }
    if (!navigator.mediaDevices?.getUserMedia) {
      throw Object.assign(new Error(MIC_MESSAGES.insecure), { code: 'insecure' });
    }
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
      });
      streamRef.current = stream;
      startLevelMeter(stream);
      return true;
    } catch (e) {
      const name = e?.name || '';
      if (name === 'NotAllowedError' || name === 'SecurityError') {
        throw Object.assign(new Error(isEmbedded() ? MIC_MESSAGES.deniedEmbedded : MIC_MESSAGES.denied), { code: 'denied' });
      }
      if (name === 'NotFoundError' || name === 'OverconstrainedError' || name === 'DevicesNotFoundError') {
        throw Object.assign(new Error(MIC_MESSAGES.missing), { code: 'missing' });
      }
      if (name === 'NotReadableError' || name === 'TrackStartError' || name === 'AbortError') {
        throw Object.assign(new Error(MIC_MESSAGES.busy), { code: 'busy' });
      }
      throw Object.assign(new Error(MIC_MESSAGES.capture), { code: 'capture' });
    }
  }, [startLevelMeter]);

  /* --------------------------- recognition lifecycle --------------------------- */
  const spawnRecognition = useCallback(() => {
    const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
    const rec = new SR();
    rec.lang = lang;
    rec.interimResults = true;
    rec.continuous = true;
    rec.maxAlternatives = 1;
    sessionFinalRef.current = '';
    recRef.current = rec;

    rec.onresult = (e) => {
      // Chromium can report the same utterance as multiple segments — rebuild
      // from the current result list and suppress exact duplicate neighbours.
      const finalParts = [];
      const interimParts = [];
      let previousFinal = '';
      let previousInterim = '';
      for (let i = 0; i < e.results.length; i++) {
        const result = e.results[i];
        const transcript = result[0]?.transcript?.trim() || '';
        if (!transcript) continue;
        const normalized = transcript.toLowerCase().replace(/\s+/g, ' ');
        if (result.isFinal) {
          if (normalized !== previousFinal) { finalParts.push(transcript); previousFinal = normalized; }
        } else if (normalized !== previousInterim) {
          interimParts.push(transcript);
          previousInterim = normalized;
        }
      }
      sessionFinalRef.current = finalParts.join(' ');
      const sessionText = `${sessionFinalRef.current} ${interimParts.join(' ')}`.trim();
      setLiveText(`${baseFinalRef.current} ${sessionText}`.trim());
      networkFailsRef.current = 0;
    };

    rec.onerror = (e) => {
      const code = e?.error || '';
      if (code === 'no-speech' || code === 'aborted') return; // benign — onend handles restart
      if (code === 'network') {
        networkFailsRef.current += 1;
        if (networkFailsRef.current >= 5) {
          wantRef.current = false;
          setError(MIC_MESSAGES.network);
          setErrorCode('network');
          setMicState('error');
        }
        return; // transient — auto-restart with backoff
      }
      if (code === 'not-allowed' || code === 'service-not-allowed') {
        wantRef.current = false;
        setError(isEmbedded() ? MIC_MESSAGES.deniedEmbedded : MIC_MESSAGES.denied);
        setErrorCode('denied');
        setMicState('denied');
        releaseMicStream();
        return;
      }
      if (code === 'audio-capture') {
        wantRef.current = false;
        setError(MIC_MESSAGES.missing);
        setErrorCode('missing');
        setMicState('missing');
        releaseMicStream();
      }
    };

    rec.onstart = () => {
      runningRef.current = true;
      setListening(true);
      setMicState('live');
    };

    rec.onend = () => {
      runningRef.current = false;
      // Carry this instance's finals into the base so restarts lose nothing.
      if (sessionFinalRef.current) {
        baseFinalRef.current = `${baseFinalRef.current} ${sessionFinalRef.current}`.trim();
        sessionFinalRef.current = '';
        setLiveText(baseFinalRef.current);
      }
      if (wantRef.current) {
        const backoff = Math.min(1600, 150 + networkFailsRef.current * 350);
        clearTimeout(restartTimerRef.current);
        restartTimerRef.current = setTimeout(() => {
          if (!wantRef.current || runningRef.current) return;
          const next = spawnRecognition();
          try { next.start(); } catch { /* next onend/error cycle will retry */ }
        }, backoff);
      } else {
        setListening(false);
        setMicState((s) => (['denied', 'missing', 'error'].includes(s) ? s : 'idle'));
      }
    };

    return rec;
  }, [lang, releaseMicStream]);

  /** Start capturing. Async: resolves true once the mic + recognizer are live. */
  const start = useCallback(async () => {
    setError('');
    setErrorCode('');
    if (!supported) {
      setError(MIC_MESSAGES.unsupported);
      setErrorCode('unsupported');
      setMicState('unsupported');
      return false;
    }
    if (wantRef.current) return true; // already capturing — guard double-start
    stopSpeaking(); // never transcribe our own text-to-speech
    wantRef.current = true;
    networkFailsRef.current = 0;
    baseFinalRef.current = '';
    sessionFinalRef.current = '';
    setLiveText('');
    setMicState('requesting');
    try {
      await ensureMic();
    } catch (e) {
      wantRef.current = false;
      setError(e.message || MIC_MESSAGES.generic);
      setErrorCode(e.code || 'error');
      setMicState(e.code === 'denied' ? 'denied' : e.code === 'missing' ? 'missing' : e.code === 'busy' ? 'busy' : e.code === 'insecure' ? 'insecure' : 'error');
      return false;
    }
    if (!wantRef.current) return false; // user stopped during the permission prompt
    try { recRef.current?.abort(); } catch { /* noop */ }
    const rec = spawnRecognition();
    try {
      rec.start();
      setListening(true);
      return true;
    } catch {
      // InvalidStateError etc. — the restart loop will pick it up via onend.
      return true;
    }
  }, [supported, ensureMic, spawnRecognition]);

  const stop = useCallback(() => {
    wantRef.current = false;
    clearTimeout(restartTimerRef.current);
    try { recRef.current?.stop(); } catch { /* already stopped */ }
    releaseMicStream();
    setListening(false);
    setMicState((s) => (['denied', 'missing', 'error'].includes(s) ? s : 'idle'));
  }, [releaseMicStream]);

  useEffect(() => () => {
    wantRef.current = false;
    clearTimeout(restartTimerRef.current);
    try { recRef.current?.abort(); } catch { /* noop */ }
    releaseMicStream();
  }, [releaseMicStream]);

  return {
    supported, listening, liveText, error, errorCode, micState, level,
    embedded: isEmbedded(), start, stop,
  };
}

/* Real text-to-speech. */
export function speak(text, { rate = 1, voiceURI = null } = {}) {
  if (typeof window === 'undefined' || !window.speechSynthesis) return false;
  try {
    window.speechSynthesis.cancel();
    const utter = new SpeechSynthesisUtterance(text);
    utter.rate = rate;
    if (voiceURI) {
      const v = window.speechSynthesis.getVoices().find((x) => x.voiceURI === voiceURI);
      if (v) utter.voice = v;
    }
    window.speechSynthesis.speak(utter);
    return true;
  } catch {
    return false;
  }
}

export function stopSpeaking() {
  try { window.speechSynthesis?.cancel(); } catch { /* noop */ }
}

export const ttsSupported = () => typeof window !== 'undefined' && Boolean(window.speechSynthesis);
