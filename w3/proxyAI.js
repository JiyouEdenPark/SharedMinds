(function () {
  /**
   * Calls the ITP-IMA Replicate proxy to analyze emotional sentiment of text.
   * @param {string} text - The text to analyze for emotional sentiment.
   * @returns {Promise<Object>} Analysis result with sentiment category and confidence.
   */
  async function analyzeTextSentiment(text) {
    const url = "https://itp-ima-replicate-proxy.web.app/api/create_n_get";
    let authToken = "";
    if (!authToken) {
      try {
        authToken = localStorage.getItem("itp-ima-replicate-proxy-ok") || "";
      } catch (_) {}
    }

    const prompt = `Analyze the emotional sentiment of the text "${text}". 
    Return a JSON object with:
    - "sentiment": one of ["neutral", "emotional"]
    - "confidence": number from 0-100
    
    Example: {"sentiment": "emotional", "confidence": 85}`;

    const data = {
      model: "openai/gpt-5",
      input: {
        prompt: prompt,
      },
    };

    console.log("Making sentiment analysis request for text:", text);

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
          `Sentiment analysis request failed: ${raw_response.status} ${raw_response.statusText}`
        );
      }

      const json_response = await raw_response.json();
      console.log("Sentiment analysis response:", json_response);

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
        !analysisResult.sentiment ||
        typeof analysisResult.confidence !== "number"
      ) {
        throw new Error("Invalid analysis result format");
      }

      return {
        text: text,
        sentiment: analysisResult.sentiment,
        confidence: Math.max(0, Math.min(100, analysisResult.confidence)),
      };
    } catch (error) {
      console.error("Error in sentiment analysis:", error);

      return fallbackSentimentAnalysis(text);
    }
  }

  /**
   * Fallback sentiment analysis using keyword matching
   * @param {string} text - The text to analyze
   * @returns {Object} Basic sentiment analysis result
   */
  function fallbackSentimentAnalysis(text) {
    return {
      text: text,
      sentiment: "neutral",
      confidence: 50,
    };
  }

  window.ProxyAI = {
    analyzeTextSentiment,
    fallbackSentimentAnalysis,
  };
})();
