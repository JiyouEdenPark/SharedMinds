(function () {
  /**
   * Calls the ITP-IMA Replicate proxy to analyze brain hemisphere thinking style of text.
   * @param {string} text - The text to analyze for brain hemisphere thinking style.
   * @returns {Promise<Object>} Analysis result with brain hemisphere category and confidence.
   */
  async function analyzeTextHemisphere(text) {
    const url = "https://itp-ima-replicate-proxy.web.app/api/create_n_get";
    let authToken = "";
    if (!authToken) {
      try {
        authToken = localStorage.getItem("itp-ima-replicate-proxy-ok") || "";
      } catch (_) { }
    }

    const prompt = `Analyze the thinking style of the text "${text}" based on brain hemisphere characteristics.

    LEFT BRAIN (logical, analytical, numerical, linguistic, sequential, objective):
    - Logical reasoning, analysis, cause-effect relationships
    - Numbers, calculations, statistics, data, measurements
    - Step-by-step processes, procedures, methods, rules
    - Facts, objectivity, accuracy, precision, reality
    - Language processing, verbal communication
    - Linear, sequential thinking

    RIGHT BRAIN (creative, intuitive, emotional, visual, holistic, subjective):
    - Creative expression, art, design, imagination, ideas
    - Emotions, feelings, mood, heart, love, happiness, sadness
    - Intuition, inspiration, hunches, sixth sense, atmosphere
    - Visual patterns, shapes, forms, spatial relationships
    - Holistic, comprehensive, integrated thinking
    - Non-linear, associative thinking

    Return a JSON object with:
    - "hemisphere": one of ["left", "right"] (representing left brain or right brain thinking)
    - "confidence": number from 0-100
    
    Example: {"hemisphere": "right", "confidence": 85}`;

    const data = {
      model: "openai/gpt-5",
      input: {
        prompt: prompt,
      },
    };

    console.log("Making brain hemisphere analysis request for text:", text);

    const options = {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
        ...(authToken ? { Authorization: `Bearer ${authToken}` } : {}),
      },
      body: JSON.stringify(data),
    };

    try {
      const raw_response = await fetch(url, options);

      if (!raw_response.ok) {
        throw new Error(
          `Brain hemisphere analysis request failed: ${raw_response.status} ${raw_response.statusText}`
        );
      }

      const json_response = await raw_response.json();
      console.log("Brain hemisphere analysis response:", json_response);

      // Parse the response
      let analysisResult;
      if (json_response.output && Array.isArray(json_response.output)) {
        const responseText = json_response.output.join("");
        analysisResult = JSON.parse(responseText);
      } else if (
        json_response.output &&
        typeof json_response.output === "string"
      ) {
        analysisResult = JSON.parse(json_response.output);
      } else {
        throw new Error("Unexpected response format");
      }

      // Validate the response structure
      if (
        !analysisResult.hemisphere ||
        typeof analysisResult.confidence !== "number"
      ) {
        throw new Error("Invalid analysis result format");
      }

      return {
        text: text,
        hemisphere: analysisResult.hemisphere,
        confidence: Math.max(0, Math.min(100, analysisResult.confidence)),
      };
    } catch (error) {
      console.error("Error in brain hemisphere analysis:", error);

      return fallbackHemisphereAnalysis(text);
    }
  }

  /**
   * Get multilingual sentence embeddings via Replicate (beautyyuyanli/multilingual-e5-large).
   * Accepts a single string or an array of strings. Returns an array of embedding vectors.
   * @param {string|string[]} inputTexts
   * @returns {Promise<number[][]>} embeddings
   */
  async function embedTexts(inputTexts) {
    const texts = Array.isArray(inputTexts) ? inputTexts : [String(inputTexts || "")];
    const url = "https://itp-ima-replicate-proxy.web.app/api/create_n_get";

    let authToken = "";
    if (!authToken) {
      try {
        authToken = localStorage.getItem("itp-ima-replicate-proxy-ok") || "";
      } catch (_) { }
    }

    // Replicate model ref from user's example
    const modelRef = "beautyyuyanli/multilingual-e5-large:a06276a89f1a902d5fc225a9ca32b6e8e6292b7f3b136518878da97c458e2bad";

    const data = {
      version: modelRef,
      input: {
        // Server expects a JSON-stringified array
        texts: JSON.stringify(texts),
      },
    };

    const options = {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
        ...(authToken ? { Authorization: `Bearer ${authToken}` } : {}),
      },
      body: JSON.stringify(data),
    };

    try {
      console.log("Requesting embeddings for", texts.length, "text(s)");
      const raw = await fetch(url, options);
      if (!raw.ok) {
        throw new Error(`Embeddings request failed: ${raw.status} ${raw.statusText}`);
      }
      const json = await raw.json();
      // Expecting output to be an array of embedding vectors ([[...],[...],...])
      const output = json.output;
      if (!output || !Array.isArray(output)) {
        throw new Error("Unexpected embeddings response format");
      }
      return output;
    } catch (err) {
      console.error("Error fetching embeddings:", err);
      // Fallback to zero vectors with small dimension if something fails
      const dim = 8;
      return texts.map(() => Array(dim).fill(0));
    }
  }

  /**
   * Convenience: single text to single embedding
   * @param {string} text
   * @returns {Promise<number[]>}
   */
  async function embedText(text) {
    const arr = await embedTexts([text]);
    return Array.isArray(arr) && Array.isArray(arr[0]) ? arr[0] : [];
  }

  /**
   * Fallback brain hemisphere analysis using keyword matching
   * @param {string} text - The text to analyze
   * @returns {Object} Basic brain hemisphere analysis result
   */
  function fallbackHemisphereAnalysis(text) {
    return {
      text: text,
      hemisphere: "right", // Default to right brain (creative thinking)
      confidence: 50,
    };
  }

  window.ProxyAI = {
    analyzeTextHemisphere,
    fallbackHemisphereAnalysis,
    embedTexts,
    embedText,
  };
})();
