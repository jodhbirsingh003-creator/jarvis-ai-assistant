// Thin wrapper around the two browser voice APIs:
//  - SpeechRecognition (webkitSpeechRecognition in Chrome/Edge) for speech-to-text
//  - speechSynthesis for text-to-speech
//
// Both are built into the browser — no API key, no cost. Support varies:
// Chrome/Edge support both well. Safari has partial/prefixed support.
// Firefox does not support SpeechRecognition as of this writing.

export interface SpeechRecognitionLike {
  continuous: boolean;
  interimResults: boolean;
  lang: string;
  start(): void;
  stop(): void;
  abort(): void;
  onresult: ((event: SpeechRecognitionEventLike) => void) | null;
  onerror: ((event: { error: string }) => void) | null;
  onend: (() => void) | null;
}

interface SpeechRecognitionEventLike {
  resultIndex: number;
  results: ArrayLike<{
    isFinal: boolean;
    0: { transcript: string };
  }>;
}

type SpeechRecognitionCtor = new () => SpeechRecognitionLike;

function getRecognitionCtor(): SpeechRecognitionCtor | null {
  if (typeof window === "undefined") return null;
  const w = window as unknown as {
    SpeechRecognition?: SpeechRecognitionCtor;
    webkitSpeechRecognition?: SpeechRecognitionCtor;
  };
  return w.SpeechRecognition ?? w.webkitSpeechRecognition ?? null;
}

export function isSpeechRecognitionSupported(): boolean {
  return getRecognitionCtor() !== null;
}

export function isSpeechSynthesisSupported(): boolean {
  return typeof window !== "undefined" && "speechSynthesis" in window;
}

export interface VoiceInputCallbacks {
  /** Fired repeatedly with the live (not-yet-final) transcript while the user talks. */
  onInterim(text: string): void;
  /** Fired once with the finished utterance. The recognizer stops itself after this. */
  onFinal(text: string): void;
  /** Fired on any recognition error (e.g. "not-allowed", "no-speech", "network"). */
  onError(error: string): void;
  /** Fired when the recognizer stops, whether from silence, error, or manual stop(). */
  onEnd(): void;
}

/**
 * Push-to-talk style single-utterance listener: start() begins listening,
 * it auto-stops after the user pauses, and onFinal fires with what it heard.
 */
export class VoiceInput {
  private recognition: SpeechRecognitionLike | null = null;
  private callbacks: VoiceInputCallbacks;
  private active = false;

  constructor(callbacks: VoiceInputCallbacks) {
    this.callbacks = callbacks;
  }

  start(): void {
    const Ctor = getRecognitionCtor();
    if (!Ctor) {
      this.callbacks.onError("unsupported");
      return;
    }
    if (this.active) return;

    const recognition = new Ctor();
    recognition.continuous = false;
    recognition.interimResults = true;
    recognition.lang = "en-US";

    recognition.onresult = (event) => {
      let finalText = "";
      let interimText = "";
      for (let i = event.resultIndex; i < event.results.length; i++) {
        const result = event.results[i];
        if (result.isFinal) finalText += result[0].transcript;
        else interimText += result[0].transcript;
      }
      if (interimText) this.callbacks.onInterim(interimText);
      if (finalText.trim()) this.callbacks.onFinal(finalText.trim());
    };

    recognition.onerror = (event) => {
      this.callbacks.onError(event.error);
    };

    recognition.onend = () => {
      this.active = false;
      this.recognition = null;
      this.callbacks.onEnd();
    };

    this.recognition = recognition;
    this.active = true;
    recognition.start();
  }

  stop(): void {
    this.recognition?.stop();
  }

  abort(): void {
    this.recognition?.abort();
    this.recognition = null;
    this.active = false;
  }

  get isActive(): boolean {
    return this.active;
  }
}

export interface SpeakOptions {
  onStart?: () => void;
  onEnd?: () => void;
  onError?: (error: string) => void;
}

let preferredVoice: SpeechSynthesisVoice | null = null;

function pickVoice(): SpeechSynthesisVoice | null {
  if (!isSpeechSynthesisSupported()) return null;
  const voices = window.speechSynthesis.getVoices();
  if (voices.length === 0) return null;
  // Prefer a clear en-US/en-GB voice; fall back to whatever's first.
  return (
    voices.find((v) => /en-(US|GB)/i.test(v.lang) && /male|david|daniel|google/i.test(v.name)) ??
    voices.find((v) => /^en/i.test(v.lang)) ??
    voices[0]
  );
}

/** Speaks text aloud via the browser's built-in TTS. Cancels any speech in progress first. */
export function speak(text: string, opts: SpeakOptions = {}): void {
  if (!isSpeechSynthesisSupported()) {
    opts.onError?.("unsupported");
    return;
  }
  const synth = window.speechSynthesis;
  synth.cancel(); // stop anything currently speaking/queued

  const utterance = new SpeechSynthesisUtterance(text);
  utterance.rate = 1.0;
  utterance.pitch = 0.9;
  utterance.volume = 1.0;

  const voice = preferredVoice ?? pickVoice();
  if (voice) utterance.voice = voice;

  utterance.onstart = () => opts.onStart?.();
  utterance.onend = () => opts.onEnd?.();
  utterance.onerror = (e) => opts.onError?.(e.error);

  synth.speak(utterance);
}

export function stopSpeaking(): void {
  if (isSpeechSynthesisSupported()) window.speechSynthesis.cancel();
}

/** Voice lists load async in some browsers; call once on mount to warm the cache. */
export function warmVoices(): void {
  if (!isSpeechSynthesisSupported()) return;
  preferredVoice = pickVoice();
  window.speechSynthesis.onvoiceschanged = () => {
    preferredVoice = pickVoice();
  };
}
