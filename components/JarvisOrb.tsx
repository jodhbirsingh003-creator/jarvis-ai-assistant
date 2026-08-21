"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { createOrbScene, type OrbSceneApi } from "@/lib/orbScene";
import { HandTracker, type TrackerStatus } from "@/lib/handTracker";
import {
  VoiceInput,
  speak,
  stopSpeaking,
  warmVoices,
  isSpeechRecognitionSupported,
  isSpeechSynthesisSupported,
} from "@/lib/speech";

type CameraState = "off" | "starting" | "on" | "error";
type VoiceState = "idle" | "listening" | "thinking" | "speaking" | "error";

interface ChatTurn {
  role: "user" | "assistant";
  content: string;
}

const MODE_LABEL: Record<TrackerStatus["mode"], string> = {
  idle: "STANDBY",
  spin: "SPIN",
  zoom: "ZOOM",
};

const VOICE_LABEL: Record<VoiceState, string> = {
  idle: "TALK",
  listening: "LISTENING…",
  thinking: "THINKING…",
  speaking: "SPEAKING…",
  error: "VOICE ERROR",
};

export default function JarvisOrb() {
  const containerRef = useRef<HTMLDivElement>(null);
  const videoRef = useRef<HTMLVideoElement>(null);
  const overlayRef = useRef<HTMLCanvasElement>(null);
  const sceneRef = useRef<OrbSceneApi | null>(null);
  const trackerRef = useRef<HandTracker | null>(null);

  const [camera, setCamera] = useState<CameraState>("off");
  const [status, setStatus] = useState<TrackerStatus>({ hands: 0, mode: "idle" });
  const [error, setError] = useState<string | null>(null);

  const voiceRef = useRef<VoiceInput | null>(null);
  const historyRef = useRef<ChatTurn[]>([]);
  const [voiceState, setVoiceState] = useState<VoiceState>("idle");
  const [voiceError, setVoiceError] = useState<string | null>(null);
  const [transcript, setTranscript] = useState("");
  const [caption, setCaption] = useState("");

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    const scene = createOrbScene(container);
    sceneRef.current = scene;
    warmVoices();
    return () => {
      trackerRef.current?.stop();
      trackerRef.current = null;
      voiceRef.current?.abort();
      voiceRef.current = null;
      stopSpeaking();
      scene.dispose();
      sceneRef.current = null;
    };
  }, []);

  const stopGestures = useCallback(() => {
    trackerRef.current?.stop();
    trackerRef.current = null;
    setCamera("off");
    setStatus({ hands: 0, mode: "idle" });
  }, []);

  const startGestures = useCallback(async () => {
    const video = videoRef.current;
    const overlay = overlayRef.current;
    if (!video || !overlay || trackerRef.current) return;

    setCamera("starting");
    setError(null);

    const tracker = new HandTracker(video, overlay, {
      onRotate: (dt, dp) => sceneRef.current?.rotateBy(dt, dp),
      onZoom: (factor) => sceneRef.current?.zoomBy(factor),
      onStatus: setStatus,
    });
    trackerRef.current = tracker;

    try {
      await tracker.start();
      setCamera("on");
    } catch (err) {
      trackerRef.current = null;
      tracker.stop();
      setCamera("error");
      setError(
        err instanceof DOMException && err.name === "NotAllowedError"
          ? "CAMERA ACCESS DENIED"
          : "TRACKING INIT FAILED",
      );
    }
  }, []);

  const toggleGestures = useCallback(() => {
    if (trackerRef.current) stopGestures();
    else void startGestures();
  }, [startGestures, stopGestures]);

  const sendToJarvis = useCallback(async (text: string) => {
    setVoiceState("thinking");
    setVoiceError(null);
    setCaption(`YOU: ${text}`);
    try {
      const res = await fetch("/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ message: text, history: historyRef.current }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? `HTTP ${res.status}`);
      const reply: string = data.reply ?? "";

      const userTurn: ChatTurn = { role: "user", content: text };
      const assistantTurn: ChatTurn = { role: "assistant", content: reply };
      historyRef.current = [...historyRef.current, userTurn, assistantTurn].slice(-10);

      setCaption(`JARVIS: ${reply}`);
      setVoiceState("speaking");
      speak(reply, {
        onEnd: () => setVoiceState((s) => (s === "speaking" ? "idle" : s)),
        onError: () => setVoiceState((s) => (s === "speaking" ? "idle" : s)),
      });
    } catch (err) {
      setVoiceState("error");
      setVoiceError(err instanceof Error ? err.message.toUpperCase() : "REQUEST FAILED");
    }
  }, []);

  const startListening = useCallback(() => {
    if (!isSpeechRecognitionSupported()) {
      setVoiceState("error");
      setVoiceError("SPEECH RECOGNITION NOT SUPPORTED (TRY CHROME OR EDGE)");
      return;
    }
    stopSpeaking();
    setVoiceError(null);
    setTranscript("");
    setCaption("");
    setVoiceState("listening");

    const voice = new VoiceInput({
      onInterim: (text) => setTranscript(text),
      onFinal: (text) => {
        setTranscript("");
        void sendToJarvis(text);
      },
      onError: (err) => {
        if (err === "no-speech" || err === "aborted") {
          setVoiceState("idle");
          return;
        }
        setVoiceState("error");
        setVoiceError(
          err === "not-allowed" || err === "permission-denied"
            ? "MICROPHONE ACCESS DENIED"
            : err === "unsupported"
              ? "SPEECH RECOGNITION NOT SUPPORTED"
              : `MIC ERROR: ${err.toUpperCase()}`,
        );
      },
      onEnd: () => {
        voiceRef.current = null;
        setVoiceState((s) => (s === "listening" ? "idle" : s));
      },
    });
    voiceRef.current = voice;
    voice.start();
  }, [sendToJarvis]);

  const toggleVoice = useCallback(() => {
    if (voiceState === "listening") {
      voiceRef.current?.stop();
      return;
    }
    if (voiceState === "speaking") {
      stopSpeaking();
      setVoiceState("idle");
      return;
    }
    if (voiceState === "thinking") return;
    startListening();
  }, [voiceState, startListening]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      switch (e.key) {
        case "+":
        case "=":
          sceneRef.current?.zoomIn();
          break;
        case "-":
        case "_":
          sceneRef.current?.zoomOut();
          break;
        case "r":
        case "R":
          sceneRef.current?.resetView();
          break;
        case "g":
        case "G":
          toggleGestures();
          break;
        case "v":
        case "V":
          toggleVoice();
          break;
        case "Escape":
          stopSpeaking();
          voiceRef.current?.stop();
          setVoiceState("idle");
          break;
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [toggleGestures, toggleVoice]);

  const cameraOn = camera === "on";
  const voiceActive = voiceState !== "idle";
  const captionText = transcript ? `YOU: ${transcript}` : caption;

  return (
    <>
      <div ref={containerRef} className="orb-root" />

      <div className="overlay-vignette" />
      <div className="overlay-grain" />
      <div className="overlay-scanlines" />

      <div className="hud hud-title">U.L.T.R.O.N.</div>

      <div className="hud hud-hint">
        <div>
          <span className="key">DRAG</span> spin&nbsp;&nbsp;
          <span className="key">SCROLL</span> zoom
        </div>
        {cameraOn ? (
          <div>
            <span className="key">PINCH + MOVE</span> spin&nbsp;&nbsp;
            <span className="key">PINCH BOTH HANDS ± SPREAD</span> zoom
          </div>
        ) : (
          <div>
            <span className="key">G</span> hand gestures&nbsp;&nbsp;
            <span className="key">V</span> talk&nbsp;&nbsp;
            <span className="key">R</span> reset&nbsp;&nbsp;
            <span className="key">+/−</span> zoom
          </div>
        )}
      </div>

      {captionText && (
        <div className="hud hud-caption">
          <span className={`caption-badge caption-${voiceState}`}>{VOICE_LABEL[voiceState]}</span>
          {captionText}
        </div>
      )}

      <div className="hud hud-controls">
        <div className={`camera-panel${cameraOn ? " visible" : ""}`}>
          {/* Mirrored preview so it behaves like a mirror */}
          <video ref={videoRef} muted playsInline className="camera-video" />
          <canvas ref={overlayRef} width={208} height={156} className="camera-overlay" />
          <div className="camera-status">
            {status.hands > 0
              ? `${status.hands} HAND${status.hands > 1 ? "S" : ""} · ${MODE_LABEL[status.mode]}`
              : "SHOW HANDS"}
          </div>
        </div>

        {error && <div className="hud-error">{error}</div>}
        {voiceError && <div className="hud-error">{voiceError}</div>}

        <div className="hud-row">
          <button
            type="button"
            className={`hud-btn${voiceState === "speaking" ? " pulsing" : ""}`}
            aria-pressed={voiceActive}
            onClick={toggleVoice}
            disabled={voiceState === "thinking"}
            title={
              isSpeechRecognitionSupported() && isSpeechSynthesisSupported()
                ? undefined
                : "Voice needs Chrome or Edge"
            }
          >
            {VOICE_LABEL[voiceState]}
          </button>
        </div>
        <div className="hud-row">
          <button
            type="button"
            className="hud-btn"
            aria-pressed={cameraOn}
            onClick={toggleGestures}
            disabled={camera === "starting"}
          >
            {camera === "starting" ? "INITIALIZING…" : cameraOn ? "GESTURES ON" : "GESTURES OFF"}
          </button>
        </div>
        <div className="hud-row">
          <button type="button" className="hud-btn" onClick={() => sceneRef.current?.zoomIn()} aria-label="Zoom in">
            +
          </button>
          <button type="button" className="hud-btn" onClick={() => sceneRef.current?.zoomOut()} aria-label="Zoom out">
            −
          </button>
          <button type="button" className="hud-btn" onClick={() => sceneRef.current?.resetView()}>
            RESET
          </button>
        </div>
      </div>
    </>
  );
}
