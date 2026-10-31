import React, { useState, useRef, useEffect } from 'react';
import {
  Mic,
  Settings,
  Copy,
  Check,
  X,
  AudioLines,
  History,
  Trash2,
  Clock,
  AlertCircle
} from 'lucide-react';

// Helper to convert AudioBuffer / Blob to Base64
const blobToBase64 = (blob) => {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onloadend = () => {
      const base64String = reader.result.split(',')[1];
      resolve(base64String);
    };
    reader.onerror = reject;
    reader.readAsDataURL(blob);
  });
};

// Helper to encode Float32Array PCM to 16-bit PCM Base64 (for Live API WebSocket)
const float32ToBase64Pcm16 = (float32Array) => {
  const int16Array = new Int16Array(float32Array.length);
  for (let i = 0; i < float32Array.length; i++) {
    const s = Math.max(-1, Math.min(1, float32Array[i]));
    int16Array[i] = s < 0 ? s * 0x8000 : s * 0x7FFF;
  }
  const bytes = new Uint8Array(int16Array.buffer);
  let binary = '';
  for (let i = 0; i < bytes.byteLength; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary);
};

export default function App() {
  // Voice & API States (Directly opens on Main Voice Screen)
  const [status, setStatus] = useState('idle'); // 'idle' | 'listening' | 'processing'
  const [outputText, setOutputText] = useState('');
  const [errorMsg, setErrorMsg] = useState('');
  const [copied, setCopied] = useState(false);

  // History / Saved Drafts in Phone Storage (localStorage)
  const [showHistory, setShowHistory] = useState(false);
  const [historyCopiedId, setHistoryCopiedId] = useState(null);
  const [draftHistory, setDraftHistory] = useState(() => {
    try {
      const saved = localStorage.getItem('smart_voice_drafts');
      return saved ? JSON.parse(saved) : [];
    } catch (e) {
      return [];
    }
  });

  // Settings States (Overlay Toggle + API Key + Mode)
  const [showSettings, setShowSettings] = useState(false);
  const [overlayEnabled, setOverlayEnabled] = useState(() => {
    return localStorage.getItem('smart_voice_overlay_enabled') === 'true';
  });
  const [overlayPos, setOverlayPos] = useState({ x: 24, y: 120 });
  const [customApiKey, setCustomApiKey] = useState(() => {
    return localStorage.getItem('smart_voice_api_key') || '';
  });
  const [mode, setMode] = useState('auto'); // 'auto' | 'live_ws'

  // Refs for audio & dragging
  const mediaRecorderRef = useRef(null);
  const audioChunksRef = useRef([]);
  const wsRef = useRef(null);
  const audioContextRef = useRef(null);
  const processorRef = useRef(null);
  const streamRef = useRef(null);
  const waveCanvasRef = useRef(null);
  const analyserRef = useRef(null);
  const audioLevelRef = useRef(0);
  const draggingRef = useRef(false);
  const dragOffsetRef = useRef({ x: 0, y: 0 });
  const movedRef = useRef(false);

  const SYSTEM_INSTRUCTION = `You are a smart voice-to-text dictation engine.
Listen carefully to the user's entire audio input before writing.
Rules:
1. DO NOT translate the user's speech into another language. Write in the EXACT same language/style spoken by the user (if spoken in Hinglish, write in Hinglish; if spoken in Hindi, write in Hindi; if spoken in English, write in English).
2. DO NOT answer questions or converse. Output ONLY the clean text the user spoke.
3. Remove unintentional filler sounds ("umm", "uh", "aa") and apply any self-corrections if the user changed their mind mid-sentence, while keeping their exact words and meaning intact with clean punctuation.`;

  // Save new dictated text to History & Phone Storage (localStorage)
  const saveDraftToHistory = (text) => {
    if (!text || !text.trim()) return;
    const now = new Date();
    const formattedTime = now.toLocaleString('en-IN', {
      day: '2-digit',
      month: 'short',
      hour: '2-digit',
      minute: '2-digit',
      hour12: true
    });
    const newEntry = {
      id: Date.now(),
      text: text.trim(),
      timestamp: formattedTime
    };
    setDraftHistory((prev) => {
      const updated = [newEntry, ...prev].slice(0, 50); // Keep last 50 drafts
      try {
        localStorage.setItem('smart_voice_drafts', JSON.stringify(updated));
      } catch (e) {}
      return updated;
    });
  };

  const deleteHistoryItem = (id) => {
    setDraftHistory((prev) => {
      const updated = prev.filter((item) => item.id !== id);
      try {
        localStorage.setItem('smart_voice_drafts', JSON.stringify(updated));
      } catch (e) {}
      return updated;
    });
  };

  const clearAllHistory = () => {
    setDraftHistory([]);
    try {
      localStorage.removeItem('smart_voice_drafts');
    } catch (e) {}
  };

  // Persist Settings in Phone Storage
  useEffect(() => {
    try {
      localStorage.setItem('smart_voice_overlay_enabled', String(overlayEnabled));
    } catch (e) {}
  }, [overlayEnabled]);

  useEffect(() => {
    try {
      localStorage.setItem('smart_voice_api_key', customApiKey);
    } catch (e) {}
  }, [customApiKey]);

  // Copy output text helper
  const handleCopy = () => {
    if (!outputText) return;
    navigator.clipboard.writeText(outputText);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  // Attach microphone stream to Web Audio Analyser for real-time promotional wave dynamics
  const setupAudioVisualizer = (stream) => {
    try {
      const AudioCtx = window.AudioContext || window.webkitAudioContext;
      const ctx = new AudioCtx();
      const source = ctx.createMediaStreamSource(stream);
      const analyser = ctx.createAnalyser();
      analyser.fftSize = 256;
      analyser.smoothingTimeConstant = 0.85;
      source.connect(analyser);
      analyserRef.current = { ctx, analyser, dataArray: new Uint8Array(analyser.frequencyBinCount) };
    } catch (e) {}
  };

  const cleanupVisualizer = () => {
    try {
      analyserRef.current?.ctx?.close();
    } catch (e) {}
    analyserRef.current = null;
    audioLevelRef.current = 0;
  };

  // Smooth 60FPS Promotional Multi-Layer Ribbon Wave Canvas Animation
  useEffect(() => {
    const canvas = waveCanvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    let animationFrameId;
    let phase = 0;

    const renderWave = () => {
      const dpr = window.devicePixelRatio || 1;
      const rect = canvas.getBoundingClientRect();
      if (canvas.width !== rect.width * dpr || canvas.height !== rect.height * dpr) {
        canvas.width = rect.width * dpr;
        canvas.height = rect.height * dpr;
      }
      ctx.save();
      ctx.scale(dpr, dpr);

      const width = rect.width;
      const height = rect.height;
      const centerY = height / 2;

      ctx.clearRect(0, 0, width, height);

      // Calculate smooth live audio amplitude if listening
      let targetLevel = 0.18;
      if (status === 'listening' && analyserRef.current) {
        const { analyser, dataArray } = analyserRef.current;
        analyser.getByteFrequencyData(dataArray);
        let sum = 0;
        for (let i = 0; i < 40; i++) sum += dataArray[i];
        const avg = sum / 40 / 255;
        targetLevel = 0.35 + Math.min(1.1, avg * 2.4);
      } else if (status === 'processing') {
        targetLevel = 0.45 + Math.sin(phase * 3) * 0.15;
      }

      // Smooth interpolation for silky promotional motion
      audioLevelRef.current += (targetLevel - audioLevelRef.current) * 0.08;
      const ampScale = audioLevelRef.current;

      const speed = status === 'listening' ? 0.055 : status === 'processing' ? 0.08 : 0.022;
      phase += speed;

      // Ambient horizontal center glow
      const glowGrad = ctx.createRadialGradient(
        width / 2,
        centerY,
        4,
        width / 2,
        centerY,
        width * 0.52
      );
      glowGrad.addColorStop(0, `rgba(94, 234, 219, ${0.22 + ampScale * 0.25})`);
      glowGrad.addColorStop(0.5, `rgba(56, 178, 166, ${0.08 + ampScale * 0.12})`);
      glowGrad.addColorStop(1, 'rgba(22, 26, 29, 0)');
      ctx.fillStyle = glowGrad;
      ctx.fillRect(0, 0, width, height);

      // Promotional layered fluid ribbons
      const layers = [
        { amp: 34, freq: 0.015, speedMult: 1.0, alpha: 0.35, color1: '#1d635d', color2: '#48c7ba', blur: 10 },
        { amp: 26, freq: 0.021, speedMult: -1.3, alpha: 0.5, color1: '#2a857c', color2: '#68ebe0', blur: 4 },
        { amp: 18, freq: 0.027, speedMult: 1.7, alpha: 0.75, color1: '#3eb8ac', color2: '#a5fff7', blur: 0 },
        { amp: 11, freq: 0.035, speedMult: -2.1, alpha: 0.9, color1: '#5eeadb', color2: '#ffffff', blur: 0 }
      ];

      ctx.globalCompositeOperation = 'screen';

      layers.forEach((layer, idx) => {
        const grad = ctx.createLinearGradient(0, centerY, width, centerY);
        grad.addColorStop(0, 'rgba(38, 110, 103, 0)');
        grad.addColorStop(0.2, layer.color1);
        grad.addColorStop(0.5, layer.color2);
        grad.addColorStop(0.8, layer.color1);
        grad.addColorStop(1, 'rgba(38, 110, 103, 0)');

        ctx.beginPath();
        for (let x = 0; x <= width; x += 3) {
          const normX = x / width;
          // Bell-curve envelope so edges pinch smoothly like the reference artwork
          const envelope = Math.pow(Math.sin(normX * Math.PI), 1.6);
          const wave1 = Math.sin(x * layer.freq + phase * layer.speedMult);
          const wave2 = Math.cos(x * layer.freq * 0.65 - phase * 0.8 + idx);
          const yOffset = (wave1 * 0.65 + wave2 * 0.35) * layer.amp * ampScale * envelope;
          const y = centerY + yOffset;
          if (x === 0) ctx.moveTo(x, y);
          else ctx.lineTo(x, y);
        }

        // Mirror bottom curve to create an organic glowing 3D ribbon
        for (let x = width; x >= 0; x -= 3) {
          const normX = x / width;
          const envelope = Math.pow(Math.sin(normX * Math.PI), 1.6);
          const wave1 = Math.sin(x * layer.freq - phase * layer.speedMult * 0.7 + 1.2);
          const wave2 = Math.sin(x * layer.freq * 0.5 + phase * 1.1);
          const yOffset = (wave1 * 0.6 + wave2 * 0.4) * (layer.amp * 0.75) * ampScale * envelope;
          const y = centerY - yOffset;
          ctx.lineTo(x, y);
        }
        ctx.closePath();

        ctx.fillStyle = grad;
        ctx.globalAlpha = layer.alpha;
        ctx.fill();

        if (idx >= 2) {
          ctx.strokeStyle = grad;
          ctx.lineWidth = idx === 3 ? 1.8 : 1.1;
          ctx.stroke();
        }
      });

      ctx.restore();
      animationFrameId = requestAnimationFrame(renderWave);
    };

    renderWave();
    return () => cancelAnimationFrame(animationFrameId);
  }, [status]);

  // ============================================================================
  // METHOD 1: Gemini Live API (WebSocket 16kHz PCM Streaming)
  // ============================================================================
  const startLiveWebSocketListening = async () => {
    try {
      setErrorMsg('');
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: { sampleRate: 16000, channelCount: 1, echoCancellation: true, noiseSuppression: true }
      });
      streamRef.current = stream;
      setupAudioVisualizer(stream);

      const wsUrl = `wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent?key=${customApiKey.trim()}`;
      const ws = new WebSocket(wsUrl);
      wsRef.current = ws;

      let accumulatedOutput = '';

      ws.onopen = () => {
        const setupMsg = {
          setup: {
            model: 'models/gemini-2.0-flash-exp',
            generationConfig: {
              responseModalities: ['TEXT'],
              temperature: 0.1
            },
            systemInstruction: {
              parts: [{ text: SYSTEM_INSTRUCTION }]
            }
          }
        };
        ws.send(JSON.stringify(setupMsg));
      };

      ws.onmessage = async (event) => {
        let rawText = event.data;
        if (rawText instanceof Blob) {
          rawText = await rawText.text();
        }
        const data = JSON.parse(rawText);

        if (data.setupComplete) {
          setStatus('listening');
          const audioCtx = new (window.AudioContext || window.webkitAudioContext)({ sampleRate: 16000 });
          audioContextRef.current = audioCtx;
          const source = audioCtx.createMediaStreamSource(stream);
          const processor = audioCtx.createScriptProcessor(4096, 1, 1);
          processorRef.current = processor;

          processor.onaudioprocess = (e) => {
            if (ws.readyState === WebSocket.OPEN) {
              const inputData = e.inputBuffer.getChannelData(0);
              const base64Pcm = float32ToBase64Pcm16(inputData);
              ws.send(
                JSON.stringify({
                  realtimeInput: {
                    mediaChunks: [{ mimeType: 'audio/pcm;rate=16000', data: base64Pcm }]
                  }
                })
              );
            }
          };

          source.connect(processor);
          processor.connect(audioCtx.destination);
          return;
        }

        const parts = data?.serverContent?.modelTurn?.parts;
        if (parts) {
          for (const part of parts) {
            if (part.text) accumulatedOutput += part.text;
          }
        }

        if (data?.serverContent?.turnComplete) {
          const finalCleanText = accumulatedOutput.trim();
          if (finalCleanText) {
            setOutputText(finalCleanText);
            saveDraftToHistory(finalCleanText);
            navigator.clipboard?.writeText(finalCleanText).catch(() => {});
          }
          cleanupLiveWebSocket();
          setStatus('idle');
        }
      };

      ws.onerror = () => {
        cleanupLiveWebSocket();
        setErrorMsg('Live WebSocket error. Falling back to built-in Gemini Audio.');
        setStatus('idle');
      };
    } catch (err) {
      setErrorMsg('Microphone permission allow karein.');
      setStatus('idle');
    }
  };

  const stopLiveWebSocketAndWrite = () => {
    setStatus('processing');
    if (processorRef.current) processorRef.current.disconnect();
    if (streamRef.current) streamRef.current.getTracks().forEach((t) => t.stop());

    if (wsRef.current && wsRef.current.readyState === WebSocket.OPEN) {
      wsRef.current.send(
        JSON.stringify({
          clientContent: {
            turns: [
              {
                role: 'user',
                parts: [{ text: 'Now output ONLY the final cleaned text from my spoken audio.' }]
              }
            ],
            turnComplete: true
          }
        })
      );
    } else {
      cleanupLiveWebSocket();
      setStatus('idle');
    }
  };

  const cleanupLiveWebSocket = () => {
    try {
      processorRef.current?.disconnect();
      audioContextRef.current?.close();
      streamRef.current?.getTracks().forEach((t) => t.stop());
      wsRef.current?.close();
    } catch (e) {}
    cleanupVisualizer();
  };

  // ============================================================================
  // METHOD 2: Built-in Zero-Config Gemini Audio Engine
  // ============================================================================
  const startStandardListening = async () => {
    try {
      setErrorMsg('');
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      streamRef.current = stream;
      setupAudioVisualizer(stream);
      audioChunksRef.current = [];

      const mediaRecorder = new MediaRecorder(stream);
      mediaRecorderRef.current = mediaRecorder;

      mediaRecorder.ondataavailable = (e) => {
        if (e.data.size > 0) {
          audioChunksRef.current.push(e.data);
        }
      };

      mediaRecorder.onstop = async () => {
        setStatus('processing');
        cleanupVisualizer();
        const audioBlob = new Blob(audioChunksRef.current, { type: mediaRecorder.mimeType || 'audio/webm' });
        stream.getTracks().forEach((track) => track.stop());

        try {
          const base64Audio = await blobToBase64(audioBlob);
          const apiKey = customApiKey.trim();
          if (!apiKey) throw new Error('Settings me apni Gemini API Key daalein.');
          const apiUrl = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${apiKey}`;

          const payload = {
            systemInstruction: {
              parts: [{ text: SYSTEM_INSTRUCTION }]
            },
            contents: [
              {
                role: 'user',
                parts: [
                  {
                    text: 'Listen to this complete audio recording, apply all self-corrections, remove filler words, and return ONLY the clean text to be typed:'
                  },
                  {
                    inlineData: {
                      mimeType: mediaRecorder.mimeType || 'audio/webm',
                      data: base64Audio
                    }
                  }
                ]
              }
            ],
            generationConfig: {
              temperature: 0.1
            }
          };

          const response = await fetch(apiUrl, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload)
          });

          const result = await response.json();
          if (result?.error) throw new Error(result.error.message || 'API error');
          const finalCleanText = result?.candidates?.[0]?.content?.parts?.[0]?.text?.trim();

          if (finalCleanText) {
            setOutputText(finalCleanText);
            saveDraftToHistory(finalCleanText);
            navigator.clipboard?.writeText(finalCleanText).catch(() => {});
          } else {
            setErrorMsg('Audio samajh nahi aaya, dobara bolein.');
          }
        } catch (err) {
          setErrorMsg(err?.message ? err.message : 'Gemini API connection error.');
        } finally {
          setStatus('idle');
        }
      };

      mediaRecorder.start();
      setStatus('listening');
    } catch (err) {
      setErrorMsg('Microphone permission allow karein.');
      setStatus('idle');
    }
  };

  const stopStandardListening = () => {
    if (mediaRecorderRef.current && mediaRecorderRef.current.state !== 'inactive') {
      mediaRecorderRef.current.stop();
    }
  };

  // Unified Toggle for Mic / Action
  const toggleVoiceAction = () => {
    if (status === 'processing') return;
    const useLiveWs = mode === 'live_ws' && customApiKey.trim().length > 0;

    if (status === 'idle') {
      if (useLiveWs) startLiveWebSocketListening();
      else startStandardListening();
    } else if (status === 'listening') {
      if (useLiveWs) stopLiveWebSocketAndWrite();
      else stopStandardListening();
    }
  };

  // Floating Overlay Dragging Handlers
  const handleOverlayPointerDown = (e) => {
    draggingRef.current = true;
    movedRef.current = false;
    const clientX = e.touches ? e.touches[0].clientX : e.clientX;
    const clientY = e.touches ? e.touches[0].clientY : e.clientY;
    dragOffsetRef.current = {
      x: clientX - overlayPos.x,
      y: clientY - overlayPos.y
    };
  };

  useEffect(() => {
    const handlePointerMove = (e) => {
      if (!draggingRef.current) return;
      const clientX = e.touches ? e.touches[0].clientX : e.clientX;
      const clientY = e.touches ? e.touches[0].clientY : e.clientY;
      const newX = Math.max(12, Math.min(window.innerWidth - 72, clientX - dragOffsetRef.current.x));
      const newY = Math.max(12, Math.min(window.innerHeight - 72, clientY - dragOffsetRef.current.y));

      if (Math.abs(newX - overlayPos.x) > 5 || Math.abs(newY - overlayPos.y) > 5) {
        movedRef.current = true;
      }
      setOverlayPos({ x: newX, y: newY });
    };

    const handlePointerUp = () => {
      draggingRef.current = false;
    };

    window.addEventListener('mousemove', handlePointerMove);
    window.addEventListener('mouseup', handlePointerUp);
    window.addEventListener('touchmove', handlePointerMove);
    window.addEventListener('touchend', handlePointerUp);

    return () => {
      window.removeEventListener('mousemove', handlePointerMove);
      window.removeEventListener('mouseup', handlePointerUp);
      window.removeEventListener('touchmove', handlePointerMove);
      window.removeEventListener('touchend', handlePointerUp);
    };
  }, [overlayPos]);

  return (
    <div className="h-screen w-screen bg-[#161a1d] flex items-center justify-center font-sans select-none relative overflow-hidden">
      {/* Main Dark Phone Container - Directly opens on Main Voice Screen */}
      <div className="w-full h-full bg-[#161a1d] flex flex-col justify-between relative overflow-hidden px-7 pt-12 pb-9 text-white">
        
        {/* Top Bar: App Title */}
        <div className="flex items-center justify-center relative z-20 pt-1">
          <span className="text-[13px] font-normal tracking-wider text-white/75">Voice Input</span>
        </div>

        {/* Top Status Heading */}
        <div className="text-center mt-4 space-y-1.5 relative z-10">
          <h2 className="text-[22px] font-normal text-white/95 tracking-wide transition-all duration-300">
            {status === 'listening'
              ? 'Listening...'
              : status === 'processing'
              ? 'Writing smartly...'
              : 'Please speak'}
          </h2>
          <p className="text-xs text-white/30 font-light tracking-wider">
            {status === 'listening'
              ? 'Tap button below when finished'
              : status === 'processing'
              ? 'Preparing clean text...'
              : 'We are writing...'}
          </p>
        </div>

        {/* Center Smooth 60FPS Promotional Dynamic Voice Flow Animation */}
        <div className="relative flex items-center justify-center h-56 -mx-7 my-auto overflow-hidden">
          {/* Outer atmospheric halo */}
          <div
            className={`absolute w-64 h-28 rounded-full bg-[#45bfb3]/20 blur-3xl transition-all duration-700 pointer-events-none ${
              status === 'listening' ? 'scale-125 opacity-95' : 'scale-95 opacity-55'
            }`}
          />

          {/* High-FPS Multi-Ribbon Fluid Waveform Canvas */}
          <canvas
            ref={waveCanvasRef}
            onClick={toggleVoiceAction}
            className="w-full h-48 cursor-pointer relative z-10"
            title={status === 'listening' ? 'Tap to Stop & Write' : 'Tap to Speak'}
          />
        </div>

        {/* Transcribed Clean Text Area */}
        <div className="min-h-[130px] flex flex-col items-center justify-center text-center px-2 relative z-10">
          {errorMsg ? (
            <div className="flex items-center gap-1.5 text-red-400/90 text-xs bg-red-950/40 px-3 py-2 rounded-xl border border-red-800/40">
              <AlertCircle className="w-3.5 h-3.5 shrink-0" />
              <span>{errorMsg}</span>
            </div>
          ) : outputText ? (
            <div className="space-y-3 max-h-[140px] overflow-y-auto px-1">
              <p className="text-[14.5px] leading-relaxed text-white/90 font-light tracking-wide">
                {outputText}
              </p>
              <button
                onClick={handleCopy}
                className="inline-flex items-center gap-1.5 text-[11px] text-[#5ad2c6] bg-[#5ad2c6]/10 hover:bg-[#5ad2c6]/20 px-3.5 py-1 rounded-full transition"
              >
                {copied ? <Check className="w-3 h-3" /> : <Copy className="w-3 h-3" />}
                <span>{copied ? 'Copied to clipboard' : 'Copy text'}</span>
              </button>
            </div>
          ) : (
            <p className="text-[14px] leading-relaxed text-white/45 font-light max-w-[260px]">
              Mic par click karke apni poori baat bolein. Jab aap stop karenge, woh bilkul waise hi yahan likh dega{' '}
              <span className="text-white/20">smartly...</span>
            </p>
          )}
        </div>

        {/* Bottom Controls Bar (Left: History Button, Center: Glowing Teal Mic Orb, Right: Settings Icon) */}
        <div className="flex items-center justify-between px-3 pt-4 relative z-10">
          <button
            onClick={() => setShowHistory(true)}
            title="Saved Drafts History"
            className="relative w-10 h-10 rounded-full flex items-center justify-center text-white/55 hover:text-white hover:bg-white/5 transition"
          >
            <History className="w-5 h-5 stroke-[1.5]" />
            {draftHistory.length > 0 && (
              <span className="absolute top-1.5 right-1.5 w-2 h-2 rounded-full bg-[#5ad2c6]" />
            )}
          </button>

          {/* Center Glowing Teal Action Button */}
          <div className="relative flex items-center justify-center">
            <div
              className={`absolute w-16 h-16 rounded-full bg-[#4bc7b9]/45 blur-xl transition-all duration-500 ${
                status === 'listening' ? 'scale-150 opacity-100' : 'scale-100 opacity-75'
              }`}
            />
            <button
              onClick={toggleVoiceAction}
              className={`relative z-10 w-14 h-14 rounded-full flex items-center justify-center transition-all duration-300 shadow-[0_0_35px_rgba(75,199,185,0.65)] ${
                status === 'listening'
                  ? 'bg-[#63e6d7] text-[#112624] scale-110'
                  : status === 'processing'
                  ? 'bg-[#3ca196] text-white animate-pulse'
                  : 'bg-gradient-to-tr from-[#2c7a73] to-[#5ad2c6] text-white hover:scale-105'
              }`}
            >
              <AudioLines className="w-6 h-6 stroke-[2]" />
            </button>
          </div>

          <button
            onClick={() => setShowSettings(true)}
            title="Settings"
            className="w-10 h-10 rounded-full flex items-center justify-center text-white/55 hover:text-white hover:bg-white/5 transition"
          >
            <Settings className="w-5 h-5 stroke-[1.5]" />
          </button>
        </div>

        {/* ================================================================= */}
        {/* HISTORY DRAWER (Last Written Drafts with Timestamp in Storage)    */}
        {/* ================================================================= */}
        {showHistory && (
          <div className="absolute inset-0 bg-[#111417]/95 backdrop-blur-md z-50 p-6 flex flex-col justify-between animate-fadeIn">
            <div className="flex items-center justify-between border-b border-white/10 pb-4">
              <div className="flex items-center gap-2.5">
                <History className="w-5 h-5 text-[#5ad2c6]" />
                <div>
                  <h3 className="text-base font-medium text-white">Saved Drafts</h3>
                  <p className="text-[10px] text-white/40">Saved in device storage</p>
                </div>
              </div>
              <div className="flex items-center gap-2">
                {draftHistory.length > 0 && (
                  <button
                    onClick={clearAllHistory}
                    className="text-[11px] text-red-400/80 hover:text-red-400 px-2 py-1 rounded-lg bg-red-500/10 transition"
                  >
                    Clear All
                  </button>
                )}
                <button
                  onClick={() => setShowHistory(false)}
                  className="w-8 h-8 rounded-full bg-white/5 flex items-center justify-center text-white/60 hover:text-white"
                >
                  <X className="w-4 h-4" />
                </button>
              </div>
            </div>

            {/* Drafts List */}
            <div className="flex-1 overflow-y-auto my-4 space-y-3 pr-1">
              {draftHistory.length === 0 ? (
                <div className="h-full flex flex-col items-center justify-center text-center text-white/35 space-y-2">
                  <Clock className="w-8 h-8 stroke-[1.2] text-white/20" />
                  <p className="text-xs">Abhi tak koi voice draft save nahi hua hai.</p>
                </div>
              ) : (
                draftHistory.map((item) => (
                  <div
                    key={item.id}
                    onClick={() => {
                      setOutputText(item.text);
                      setShowHistory(false);
                    }}
                    className="bg-white/5 hover:bg-white/10 border border-white/10 rounded-2xl p-3.5 space-y-2 transition cursor-pointer"
                  >
                    <div className="flex items-center justify-between text-[10px] text-white/40">
                      <span className="flex items-center gap-1 text-[#5ad2c6]/80">
                        <Clock className="w-3 h-3" />
                        {item.timestamp}
                      </span>
                      <div className="flex items-center gap-2" onClick={(e) => e.stopPropagation()}>
                        <button
                          onClick={() => {
                            navigator.clipboard.writeText(item.text);
                            setHistoryCopiedId(item.id);
                            setTimeout(() => setHistoryCopiedId(null), 1500);
                          }}
                          className="text-white/50 hover:text-[#5ad2c6] transition"
                          title="Copy draft"
                        >
                          {historyCopiedId === item.id ? (
                            <Check className="w-3.5 h-3.5 text-[#5ad2c6]" />
                          ) : (
                            <Copy className="w-3.5 h-3.5" />
                          )}
                        </button>
                        <button
                          onClick={() => deleteHistoryItem(item.id)}
                          className="text-white/40 hover:text-red-400 transition"
                          title="Delete draft"
                        >
                          <Trash2 className="w-3.5 h-3.5" />
                        </button>
                      </div>
                    </div>
                    <p className="text-xs text-white/85 leading-relaxed line-clamp-3">
                      {item.text}
                    </p>
                  </div>
                ))
              )}
            </div>

            <button
              onClick={() => setShowHistory(false)}
              className="w-full py-3 rounded-2xl bg-white/10 text-white font-medium text-xs hover:bg-white/15 transition"
            >
              Close History
            </button>
          </div>
        )}

        {/* ================================================================= */}
        {/* SETTINGS MODAL (Overlay On/Off + API Key)                         */}
        {/* ================================================================= */}
        {showSettings && (
          <div className="absolute inset-0 bg-[#111417]/95 backdrop-blur-md z-50 p-6 flex flex-col justify-between animate-fadeIn">
            <div className="space-y-6">
              <div className="flex items-center justify-between border-b border-white/10 pb-4">
                <div className="flex items-center gap-2.5">
                  <Settings className="w-5 h-5 text-[#5ad2c6]" />
                  <h3 className="text-base font-medium text-white">Settings</h3>
                </div>
                <button
                  onClick={() => setShowSettings(false)}
                  className="w-8 h-8 rounded-full bg-white/5 flex items-center justify-center text-white/60 hover:text-white"
                >
                  <X className="w-4 h-4" />
                </button>
              </div>

              {/* 1. Floating Overlay On / Off Toggle */}
              <div className="bg-white/5 border border-white/10 rounded-2xl p-4 flex items-center justify-between">
                <div>
                  <p className="text-sm font-medium text-white">Floating Voice Overlay</p>
                  <p className="text-[11px] text-white/45 mt-0.5">
                    Screen par floating Mic button On/Off karein
                  </p>
                </div>
                <button
                  onClick={() => setOverlayEnabled(!overlayEnabled)}
                  className={`w-12 h-6 rounded-full transition-colors p-0.5 flex items-center ${
                    overlayEnabled ? 'bg-[#4bc7b9] justify-end' : 'bg-white/15 justify-start'
                  }`}
                >
                  <span className="w-5 h-5 rounded-full bg-white shadow-md" />
                </button>
              </div>

              {/* 2. Engine Selection */}
              <div className="bg-white/5 border border-white/10 rounded-2xl p-4 space-y-3">
                <p className="text-xs font-medium text-white/70">Voice Engine Mode</p>
                <div className="grid grid-cols-2 gap-2 text-xs">
                  <button
                    onClick={() => setMode('auto')}
                    className={`py-2.5 px-3 rounded-xl border text-center transition ${
                      mode === 'auto'
                        ? 'bg-[#4bc7b9]/20 border-[#4bc7b9] text-[#63e6d7]'
                        : 'border-white/10 text-white/50'
                    }`}
                  >
                    Smart Audio (Default)
                  </button>
                  <button
                    onClick={() => setMode('live_ws')}
                    className={`py-2.5 px-3 rounded-xl border text-center transition ${
                      mode === 'live_ws'
                        ? 'bg-[#4bc7b9]/20 border-[#4bc7b9] text-[#63e6d7]'
                        : 'border-white/10 text-white/50'
                    }`}
                  >
                    Live API (16kHz WSS)
                  </button>
                </div>
              </div>

              {/* 3. Gemini API Key Input */}
              <div className="bg-white/5 border border-white/10 rounded-2xl p-4 space-y-2.5">
                <label className="text-xs font-medium text-white/70 block">
                  Gemini API Key
                </label>
                <input
                  type="password"
                  value={customApiKey}
                  onChange={(e) => setCustomApiKey(e.target.value)}
                  placeholder="Enter your Gemini API Key..."
                  className="w-full bg-[#161a1d] border border-white/15 rounded-xl px-3.5 py-2.5 text-xs text-white placeholder-white/30 focus:outline-none focus:border-[#4bc7b9]"
                />
                <p className="text-[11px] text-white/40 leading-relaxed">
                  Zaroori: aistudio.google.com se free Gemini API key banakar yahan daalein. Default mode (Smart Audio) recommended hai.
                </p>
              </div>
            </div>

            <button
              onClick={() => setShowSettings(false)}
              className="w-full py-3.5 rounded-2xl bg-[#4bc7b9] text-[#112624] font-medium text-sm shadow-lg shadow-[#4bc7b9]/25 hover:opacity-95 transition"
            >
              Save & Close
            </button>
          </div>
        )}
      </div>

      {/* ================================================================= */}
      {/* FLOATING OVERLAY MIC BUTTON (When toggled ON in Settings)         */}
      {/* ================================================================= */}
      {overlayEnabled && (
        <div
          style={{
            position: 'fixed',
            left: `${overlayPos.x}px`,
            top: `${overlayPos.y}px`,
            zIndex: 9999,
            touchAction: 'none'
          }}
          onMouseDown={handleOverlayPointerDown}
          onTouchStart={handleOverlayPointerDown}
        >
          <button
            onClick={() => {
              if (!movedRef.current) toggleVoiceAction();
            }}
            title={status === 'listening' ? 'Tap to Stop & Write' : 'Tap to Speak'}
            className={`w-14 h-14 rounded-full flex items-center justify-center shadow-[0_0_30px_rgba(75,199,185,0.7)] border-2 border-white/80 transition-transform active:scale-90 ${
              status === 'listening'
                ? 'bg-red-500 text-white animate-pulse scale-110'
                : status === 'processing'
                ? 'bg-[#3ca196] text-white animate-spin'
                : 'bg-gradient-to-tr from-[#1f5c56] to-[#5ad2c6] text-white'
            }`}
          >
            {status === 'listening' ? (
              <AudioLines className="w-6 h-6" />
            ) : (
              <Mic className="w-6 h-6" />
            )}
          </button>
        </div>
      )}
    </div>
  );
}