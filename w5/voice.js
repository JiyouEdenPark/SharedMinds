class VoiceInput {
  constructor(options) {
    this.micBtn = options.micBtn;
    this.onAppendText = options.onAppendText || function () { };
    this.realtime = !!options.realtime;
    // Choose between local worker ASR and remote proxy ASR
    this.useProxyASR = !!options.useProxyASR;

    this.isRecording = false;
    this.mediaRecorder = null;
    this.audioChunks = [];
    this.audioStream = null;
    this.audioContext = null;
    // ASR runs in a Web Worker; no main-thread model required
    this.streamingAccumText = "";

    // streaming state
    this.streamingWindowSec = 3; // transcribe last 3s
    this.streamingBusy = false;

    // PCM capture state for realtime
    this.pcmChunks = [];
    this.inputSampleRate = null;
    this.processor = null;
    this.sourceNode = null;
    this.levelPct = 0;
    // Visual pulse state
    this._lastPulseTs = 0;
    // Pulse gating (to avoid pulses on silence)
    this.pulseHighThresholdPct = 10; // arm when level surpasses this
    this.pulseLowThresholdPct = 1; // disarm when level drops below this
    this.pulseArmed = false; // hysteresis state
    this.pulseMinIntervalMs = 120; // throttle pulse rate
    this._lastZcr = null; // last zero-crossing rate
    // Safety caps for overly long hypotheses
    this.maxResultChars = 40; // ignore if full hypothesis is too long
    this.maxAppendChars = 40; // ignore if delta is too long

    // Silence-triggered processing config
    this.silenceRmsThreshold = 10; // when level falls below this...
    this.silenceHoldMs = 500; // ...for this duration, trigger ASR
    this.silenceCooldownMs = 1000; // minimum distance between triggers
    this._lastVoiceTs = 0;
    this._lastSilenceFireTs = 0;
    this._sawVoiceSinceLastFire = false;

    if (this.micBtn) {
      this.micBtn.addEventListener("click", () => this.toggleMic());
      this.micDefaultLabel = this.micBtn.textContent;
    }

    // Worker offload for ASR
    this.worker = null;
    this.workerReqId = 0;
  }

  // No ensureTranscriber needed; worker loads model

  async toggleMic() {
    if (this.isRecording) {
      await this.stopMic();
    } else {
      await this.startMic();
    }
  }

  async startMic() {
    // Worker handles model loading lazily
    try {
      this.audioStream = await navigator.mediaDevices.getUserMedia({
        audio: true,
      });
    } catch (e) {
      console.error("Microphone permission denied or unavailable:", e);
      return;
    }

    this.audioChunks = [];
    let mimeType = "";
    const mimeTypeCandidates = [
      "audio/webm;codecs=opus",
      "audio/webm",
      "audio/ogg;codecs=opus",
      "audio/ogg",
    ];
    for (const mt of mimeTypeCandidates) {
      if (MediaRecorder.isTypeSupported(mt)) {
        mimeType = mt;
        break;
      }
    }
    try {
      this.mediaRecorder = new MediaRecorder(
        this.audioStream,
        mimeType ? { mimeType } : undefined
      );
    } catch (e) {
      console.error("MediaRecorder init failed:", e);
      this.audioStream.getTracks().forEach((t) => t.stop());
      this.audioStream = null;
      return;
    }

    this.mediaRecorder.ondataavailable = async (ev) => {
      if (!ev.data || ev.data.size === 0) return;
      if (!this.realtime) {
        this.audioChunks.push(ev.data);
      }
    };

    this.mediaRecorder.onstop = async () => {
      try {
        if (this.realtime) {
          // no-op; realtime loop already handled updates
        } else {
          const blob = new Blob(this.audioChunks, {
            type: mimeType || "audio/webm",
          });
          const float32 = await this.decodeAndResampleToMono16k(blob);
          await this.handleTranscriptionFromFloat32(float32);
        }
      } finally {
        this.audioChunks = [];
      }
    };

    this.mediaRecorder.start(this.realtime ? 0 : 1000);
    this.isRecording = true;
    if (this.micBtn) this.micBtn.classList.add("recording");
    this.showRecordingUI(true);
    if (this.realtime) {
      this.startRealtimePcmCapture();
    }
  }

  async stopMic() {
    if (!this.isRecording) return;
    try {
      if (this.mediaRecorder && this.mediaRecorder.state !== "inactive") {
        this.mediaRecorder.stop();
      }
    } catch { }
    if (this.audioStream) {
      this.audioStream.getTracks().forEach((t) => t.stop());
      this.audioStream = null;
    }
    this.isRecording = false;
    if (this.micBtn) this.micBtn.classList.remove("recording");
    if (this.realtime) this.stopRealtimePcmCapture();
    this.showRecordingUI(false);
  }

  async handleTranscriptionFromFloat32(float32) {
    if (!float32 || float32.length < 1600) return null;

    const filtered = await this.filterToSpeechBand(float32, 16000);
    const isVoice = await this.isLikelyVoice(filtered, 16000);
    if (!isVoice) return null;
    let resultText = null;
    if (
      this.useProxyASR &&
      window.ProxyASR &&
      window.ProxyASR.askVoiceThenWord
    ) {
      try {
        const wavBlob = this.float32ToWavBlob(filtered, 16000);
        resultText = await window.ProxyASR.askVoiceThenWord(wavBlob);
      } catch (_) {
        resultText = null;
      }
    } else {
      const local = await this.runAsrOffMain(filtered);
      // Normalize to string whether worker returns string or { text }
      if (typeof local === "string") resultText = local;
      else if (local && typeof local.text === "string") resultText = local.text;
      else resultText = null;
    }
    if (typeof resultText === "string" && resultText) {
      const newText = resultText.trim();
      // Ignore abnormally long hypotheses
      if (newText.length > this.maxResultChars) {
        this.streamingAccumText = newText; // consume to avoid re-adding
        return;
      }
      let appendPart = newText;
      if (
        this.streamingAccumText &&
        newText.startsWith(this.streamingAccumText)
      ) {
        appendPart = newText.slice(this.streamingAccumText.length);
      }
      // Ignore if delta is too large at once
      if (appendPart && appendPart.length > this.maxAppendChars) {
        this.streamingAccumText = newText; // consume without appending
        return;
      }
      if (appendPart) {
        const trimmed = appendPart.trim();
        // Avoid creating thoughts from very short streaming deltas
        if (trimmed.length >= 2 || /[\s.!?]$/.test(appendPart)) {
          this.onAppendText(trimmed);
        }
      }
      this.streamingAccumText = newText;
    }
  }

  // --- Realtime PCM capture path ---
  startRealtimePcmCapture() {
    try {
      if (!this.audioContext) {
        try {
          this.audioContext = new (window.AudioContext ||
            window.webkitAudioContext)({
              sampleRate: 16000,
              latencyHint: "interactive",
            });
        } catch (_) {
          this.audioContext = new (window.AudioContext ||
            window.webkitAudioContext)();
        }
      }
      this.sourceNode = this.audioContext.createMediaStreamSource(
        this.audioStream
      );
      this.processor = this.audioContext.createScriptProcessor(2048, 1, 1);
      this.inputSampleRate = this.audioContext.sampleRate;
      this.sourceNode.connect(this.processor);
      this.processor.connect(this.audioContext.destination);
      this.processor.onaudioprocess = (e) => {
        try {
          const input = e.inputBuffer.getChannelData(0);
          // live level + zcr update
          const rms = this.computeRMS(input);
          const zcr = this.computeZCR(input);
          this.updateLevelUI(rms, zcr);
          // arm/disarm silence trigger
          const now = performance.now ? performance.now() : Date.now();

          if (this.levelPct >= this.silenceRmsThreshold) {
            // when speaking, keep refreshing last voice time
            this._lastVoiceTs = now;
            this._sawVoiceSinceLastFire = true;
          } else {
            this.maybeTriggerSilenceASR(now).catch(() => { });
          }
          if (this.realtime) {
            const copy = new Float32Array(input.length);
            copy.set(input);
            this.pcmChunks.push(copy);
          }
        } catch { }
      };
    } catch { }
  }

  stopRealtimePcmCapture() {
    // no streaming timer to clear
    this.streamingBusy = false;
    try {
      if (this.processor) this.processor.disconnect();
      if (this.sourceNode) this.sourceNode.disconnect();
    } catch { }
    this.processor = null;
    this.sourceNode = null;
  }

  async processRealtimePcm() {
    if (this.streamingBusy) return;
    if (!this.pcmChunks || this.pcmChunks.length === 0 || !this.inputSampleRate)
      return;
    this.streamingBusy = true;
    try {
      const merged = this.mergeFloat32Chunks(this.pcmChunks);
      const keepSamples = Math.floor(
        this.streamingWindowSec * this.inputSampleRate
      );
      const slice = merged.slice(Math.max(0, merged.length - keepSamples));
      const float16k = await this.resampleFloat32(
        slice,
        this.inputSampleRate,
        16000
      );
      this.setUIProcessing(true);
      await this.handleTranscriptionFromFloat32(float16k);
      this.setUIProcessing(false);
      this.trimPcmChunksToSamples(keepSamples * 2);
    } finally {
      this.streamingBusy = false;
    }
  }

  async maybeTriggerSilenceASR(nowTs) {
    // cooldown check
    if (nowTs - this._lastSilenceFireTs < this.silenceCooldownMs) return;
    // require sustained silence after last voice
    if (nowTs - this._lastVoiceTs < this.silenceHoldMs) return;
    // require that there was voice since last fire
    if (!this._sawVoiceSinceLastFire) return;
    // run one processing tick (non-blocking)
    if (this.streamingBusy) return;
    this.processRealtimePcm().catch(() => { });
    this._lastSilenceFireTs = nowTs;
    this._sawVoiceSinceLastFire = false;
  }

  mergeFloat32Chunks(chunks) {
    const total = chunks.reduce((s, a) => s + a.length, 0);
    const merged = new Float32Array(total);
    let off = 0;
    for (const arr of chunks) {
      merged.set(arr, off);
      off += arr.length;
    }
    return merged;
  }

  async resampleFloat32(float32, fromRate, toRate) {
    if (fromRate === toRate) return float32;
    const duration = float32.length / fromRate;
    const length = Math.max(1, Math.ceil(duration * toRate));
    const offline = new OfflineAudioContext(1, length, toRate);
    const buffer = offline.createBuffer(1, float32.length, fromRate);
    buffer.copyToChannel(float32, 0);
    const src = offline.createBufferSource();
    src.buffer = buffer;
    src.connect(offline.destination);
    src.start(0);
    const rendered = await offline.startRendering();
    return rendered.getChannelData(0);
  }

  trimPcmChunksToSamples(targetSamples) {
    if (!this.pcmChunks || this.pcmChunks.length === 0) return;
    let total = this.pcmChunks.reduce((s, a) => s + a.length, 0);
    while (total > targetSamples && this.pcmChunks.length > 1) {
      const first = this.pcmChunks.shift();
      total -= first.length;
    }
  }

  // --- Simple speech-band filtering and VAD ---
  async filterToSpeechBand(float32, sampleRate = 16000) {
    if (!float32 || float32.length === 0) return float32;
    try {
      const offline = new OfflineAudioContext(1, float32.length, sampleRate);
      const buffer = offline.createBuffer(1, float32.length, sampleRate);
      buffer.copyToChannel(float32, 0);
      const src = offline.createBufferSource();
      src.buffer = buffer;
      const hp = offline.createBiquadFilter();
      hp.type = "highpass";
      hp.frequency.value = 85; // remove very low rumbles
      hp.Q.value = 0.707;
      const lp = offline.createBiquadFilter();
      lp.type = "lowpass";
      lp.frequency.value = 4000; // remove high-frequency hiss/music
      lp.Q.value = 0.707;
      src.connect(hp);
      hp.connect(lp);
      lp.connect(offline.destination);
      src.start(0);
      const rendered = await offline.startRendering();
      return rendered.getChannelData(0);
    } catch {
      return float32;
    }
  }

  computeRMS(float32) {
    if (!float32 || float32.length === 0) return 0;
    let sum = 0;
    for (let i = 0; i < float32.length; i++) {
      const v = float32[i];
      sum += v * v;
    }
    return Math.sqrt(sum / float32.length);
  }

  computeZCR(float32) {
    if (!float32 || float32.length < 2) return 0;
    let zc = 0;
    let prev = float32[0];
    for (let i = 1; i < float32.length; i++) {
      const cur = float32[i];
      if ((prev >= 0 && cur < 0) || (prev < 0 && cur >= 0)) zc++;
      prev = cur;
    }
    return zc / float32.length;
  }

  async isLikelyVoice(float32, sampleRate = 16000) {
    const rms = this.computeRMS(float32);
    if (rms < 0.012) return false; // too quiet
    const zcr = this.computeZCR(float32);
    // Heuristic: human speech zcr not extremely low or high
    if (zcr < 0.002 || zcr > 0.25) return false;
    return true;
  }

  async decodeAndResampleToMono16k(blob) {
    const arrayBuffer = await blob.arrayBuffer();
    if (!this.audioContext) {
      this.audioContext = new (window.AudioContext ||
        window.webkitAudioContext)();
    }
    const decoded = await this.audioContext.decodeAudioData(
      arrayBuffer.slice(0)
    );
    const targetRate = 16000;
    if (decoded.sampleRate === targetRate && decoded.numberOfChannels === 1) {
      return decoded.getChannelData(0);
    }
    const length = Math.ceil(decoded.duration * targetRate);
    const offline = new OfflineAudioContext(1, length, targetRate);
    const src = offline.createBufferSource();
    src.buffer = decoded;
    src.connect(offline.destination);
    src.start(0);
    const rendered = await offline.startRendering();
    return rendered.getChannelData(0);
  }

  // --- ASR worker offload ---
  ensureWorker() {
    if (this.worker) return;
    try {
      this.worker = new Worker("asrWorker.js", { type: "module" });
      const initId = ++this.workerReqId;
      this.worker.postMessage({
        id: initId,
        type: "init",
        modelId: "Xenova/whisper-base",
      });
    } catch { }
  }

  runAsrOffMain(float32) {
    return new Promise((resolve) => {
      try {
        this.ensureWorker();
        const id = ++this.workerReqId;
        const onMsg = (e) => {
          const msg = e.data || {};
          if (msg.id !== id) return;
          if (msg.type === "result") {
            this.worker.removeEventListener("message", onMsg);
            resolve(msg.result);
          } else if (msg.type === "error") {
            this.worker.removeEventListener("message", onMsg);
            resolve(null);
          }
        };
        this.worker.addEventListener("message", onMsg);
        // Transferable to avoid copying
        const buf = float32.buffer.slice(0);
        this.worker.postMessage(
          { id, type: "asr", float32: new Float32Array(buf) },
          [buf]
        );
      } catch {
        resolve(null);
      }
    });
  }

  // --- UI helpers ---
  showRecordingUI(show) {
    try {
      const ui = document.getElementById("recordingUI");
      if (!ui) return;
      if (show) {
        ui.classList.add("active");
      } else {
        ui.classList.remove("active");
        ui.classList.remove("processing");
        this.updateLevelBar(0);
      }
    } catch { }
  }

  setUIProcessing(on) {
    try {
      const ui = document.getElementById("recordingUI");
      if (!ui) return;
      if (on) ui.classList.add("processing");
      else ui.classList.remove("processing");
    } catch { }
  }

  updateLevelUI(rms, zcr = null) {
    const pct = Math.min(100, Math.max(0, Math.round(rms * 140 * 100) / 100));
    this._lastZcr = zcr;
    // hysteresis: arm/disarm pulse emission based on level
    if (!this.pulseArmed && pct >= this.pulseHighThresholdPct) {
      this.pulseArmed = true;
    } else if (this.pulseArmed && pct <= this.pulseLowThresholdPct) {
      this.pulseArmed = false;
    }
    if (pct !== this.levelPct) {
      this.levelPct = pct;
      this.updateLevelBar(pct);
      // Only emit pulse when armed and zcr looks speech-like
      const zcrOk = zcr == null || (zcr >= 0.002 && zcr <= 0.25);
      if (this.pulseArmed && zcrOk) this.emitMicPulse(pct);
    }
  }

  updateLevelBar(pct) {
    try {
      // legacy bar no longer shown; keep safe no-op if present
      const fill = document.querySelector("#recordingUI .level .level-fill");
      if (fill) fill.style.width = pct + "%";
    } catch { }
  }

  // --- Mic pulse rings ---
  emitMicPulse(pct) {
    try {
      const container = document.getElementById("micPulse");
      if (!container) return;
      const now = performance.now ? performance.now() : Date.now();
      // throttle pulses to avoid overdraw
      const minInterval = this.pulseMinIntervalMs; // ms
      if (now - this._lastPulseTs < minInterval) return;
      this._lastPulseTs = now;

      // map level to visual params
      const clamped = Math.max(0, Math.min(100, pct));
      const toScale = (1.2 + (clamped / 100) * 1.6) * 2; // doubled: 2.4 ~ 5.6
      const duration = 500 + (1 - clamped / 100) * 500; // 500ms ~ 1000ms
      const startOpacity = 0.25 + (clamped / 100) * 0.35; // 0.25 ~ 0.6

      const ring = document.createElement("div");
      ring.className = "ring";
      ring.style.setProperty("--to-scale", String(toScale));
      ring.style.setProperty("--pulse-duration", `${duration}ms`);
      ring.style.setProperty("--start-opacity", String(startOpacity));
      container.appendChild(ring);
      // cleanup after animation
      ring.addEventListener("animationend", () => {
        if (ring.parentNode) ring.parentNode.removeChild(ring);
      });
    } catch { }
  }

  // --- Utility: Encode Float32 PCM to 16-bit WAV Blob ---
  float32ToWavBlob(float32, sampleRate = 16000) {
    const numChannels = 1;
    const bytesPerSample = 2; // 16-bit
    const blockAlign = numChannels * bytesPerSample;
    const byteRate = sampleRate * blockAlign;
    const dataLength = float32.length * bytesPerSample;
    const buffer = new ArrayBuffer(44 + dataLength);
    const view = new DataView(buffer);

    // RIFF header
    this._writeString(view, 0, "RIFF");
    view.setUint32(4, 36 + dataLength, true);
    this._writeString(view, 8, "WAVE");

    // fmt chunk
    this._writeString(view, 12, "fmt ");
    view.setUint32(16, 16, true); // PCM chunk size
    view.setUint16(20, 1, true); // audio format: PCM
    view.setUint16(22, numChannels, true);
    view.setUint32(24, sampleRate, true);
    view.setUint32(28, byteRate, true);
    view.setUint16(32, blockAlign, true);
    view.setUint16(34, 16, true); // bits per sample

    // data chunk
    this._writeString(view, 36, "data");
    view.setUint32(40, dataLength, true);

    // PCM samples
    let offset = 44;
    for (let i = 0; i < float32.length; i++) {
      let s = Math.max(-1, Math.min(1, float32[i]));
      view.setInt16(offset, s < 0 ? s * 0x8000 : s * 0x7fff, true);
      offset += 2;
    }
    return new Blob([view], { type: "audio/wav" });
  }

  _writeString(view, offset, string) {
    for (let i = 0; i < string.length; i++) {
      view.setUint8(offset + i, string.charCodeAt(i));
    }
  }
}

window.VoiceInput = VoiceInput;
