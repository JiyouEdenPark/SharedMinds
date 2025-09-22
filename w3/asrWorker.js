// Module Worker: ESM import of Transformers.js
import * as transformers from "https://cdn.jsdelivr.net/npm/@xenova/transformers";

let transcriberPromise = null;
let transcriber = null;

async function ensurePipeline(modelId) {
  if (transcriber) return transcriber;
  if (!transcriberPromise) {
    transcriberPromise = transformers.pipeline(
      "automatic-speech-recognition",
      modelId || "Xenova/whisper-base"
    );
  }
  transcriber = await transcriberPromise;
  return transcriber;
}

function toFloat32(data) {
  if (data instanceof Float32Array) return data;
  if (data && data.buffer) return new Float32Array(data.buffer);
  return null;
}

self.onmessage = async (e) => {
  const msg = e.data || {};
  const { id, type } = msg;
  try {
    if (type === "init") {
      await ensurePipeline(msg.modelId);
      self.postMessage({ id, type: "ready" });
      return;
    }
    if (type === "asr") {
      const input = toFloat32(msg.float32);
      if (!input) throw new Error("Invalid input array");
      await ensurePipeline(msg.modelId);
      const result = await transcriber(input, {
        return_timestamps: false,
      });
      self.postMessage({ id, type: "result", result });
      return;
    }
    throw new Error("Unknown message type");
  } catch (err) {
    self.postMessage({
      id,
      type: "error",
      error: String((err && err.message) || err),
    });
  }
};
