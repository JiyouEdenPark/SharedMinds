(function () {
  async function blobToBase64(blob) {
    return new Promise((resolve, reject) => {
      try {
        const reader = new FileReader();
        reader.onloadend = () => resolve(reader.result);
        reader.onerror = (e) => reject(e);
        reader.readAsDataURL(blob);
      } catch (e) {
        reject(e);
      }
    });
  }

  /**
   * Calls the ITP-IMA Replicate proxy to transcribe provided audio blob.
   * @param {Blob} audioBlob - Microphone recording (webm/ogg/wav). Will be base64 encoded.
   * @returns {Promise<string>} Recognized text.
   */
  async function askVoiceThenWord(audioBlob) {
    const b64DataUrl = await blobToBase64(audioBlob);
    // If the API expects raw base64 only, strip the data URL prefix
    const base64 = b64DataUrl.split(",")[1] || b64DataUrl;

    const url = "https://itp-ima-replicate-proxy.web.app/api/create_n_get";
    let authToken = "";
    if (!authToken) {
      try {
        authToken = localStorage.getItem("itp-ima-replicate-proxy-ok") || "";
      } catch (_) {}
    }

    const version =
      "vaibhavs10/incredibly-fast-whisper:3ab86df6c8f54c11309d4d1f930ac292bad43ace52d10c80d87eb258b3c9f79c";
    const fileFormat = "wav";

    const payload = {
      fieldToConvertBase64ToURL: "audio",
      fileFormat,
      version,
      input: {
        audio: base64,
      },
    };

    const options = {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
        ...(authToken ? { Authorization: `Bearer ${authToken}` } : {}),
      },
      body: JSON.stringify(payload),
    };

    const resp = await fetch(url, options);
    if (!resp.ok) {
      throw new Error(
        `Proxy ASR request failed: ${resp.status} ${resp.statusText}`
      );
    }
    const respJson = await resp.json();
    const text = respJson && respJson.output && respJson.output.text;
    if (typeof text !== "string") {
      throw new Error("Proxy ASR response missing output.text");
    }
    return text;
  }

  window.ProxyASR = { askVoiceThenWord };
})();
