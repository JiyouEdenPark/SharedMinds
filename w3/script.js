class SharedRippleThinking {
  constructor() {
    this.canvas = document.getElementById("rippleCanvas");
    this.ctx = this.canvas.getContext("2d");
    this.micBtn = document.getElementById("micBtn");

    this.thoughts = [];
    this.animationId = null;
    this.socketManager = null;

    // Fade and layout timing configuration
    this.baseRadius = 30;
    this.ringGap = 22;
    this.elementFadeMs = 500; // each element fades over 0.5s
    this.elementFadeInMs = 500; // fade-in duration per element
    this.ringDelayMs = 250; // delay between rings starting fade
    this.charDelayMs = 12; // stagger characters within a ring

    // Floating animation configuration
    this.globalFloatSpeedMultiplier = 2;

    // Translation cache for input text -> { ko, ja, en }
    this.translationCache = new Map();

    // Track sent message IDs to prevent showing own messages
    this.sentMessageIds = new Set();

    this.voiceInput = new VoiceInput({
      micBtn: this.micBtn,
      realtime: true,
      useProxyASR: true,
      onAppendText: (text) => this.sendThoughtToServer(text),
    });

    this.setupCanvas();
    this.setupEventListeners();
    this.setupSocketManager();
    this.startAnimation();
  }

  setupSocketManager() {
    this.socketManager = new SocketManager();

    this.socketManager.onConnect = () => {
      this.updateConnectionStatus("Connected", true);
    };

    this.socketManager.onDisconnect = () => {
      this.updateConnectionStatus("Disconnected", false);
    };

    this.socketManager.onInitialTexts = (texts) => {
      texts.forEach((textObj) => {
        this.showThought(textObj.text, textObj.x, textObj.y, textObj.id, textObj.translations);
      });
    };

    this.socketManager.onTextReceived = (textObj) => {
      // 자신이 보낸 메시지는 표시하지 않음
      if (!this.sentMessageIds.has(textObj.id)) {
        this.showThought(textObj.text, textObj.x, textObj.y, textObj.id, textObj.translations);
      }
    };

    this.socketManager.onUserCountUpdate = (count) => {
      this.updateUserCount(count);
    };

    this.socketManager.connect();
  }

  sendThoughtToServer(text) {
    const margin = 100;
    const x = Math.random() * (this.canvas.width - 2 * margin) + margin;
    const y = Math.random() * (this.canvas.height - 2 * margin) + margin;

    // 먼저 화면에 표시
    const thought = this.showThought(text, x, y);

    // 번역이 완료되면 서버로 전송
    this.waitForTranslationAndSend(thought);
  }

  async waitForTranslationAndSend(thought) {
    // 번역이 완료될 때까지 대기
    const checkTranslation = () => {
      if (thought.translations && thought.translations.ko !== null) {
        // 번역이 완료되면 서버로 전송
        this.socketManager.sendText(thought.text, thought.x, thought.y, thought.translations, thought.id);
        // 보낸 메시지 ID를 추적
        this.sentMessageIds.add(thought.id);
      } else {
        // 100ms 후 다시 확인
        setTimeout(checkTranslation, 100);
      }
    };
    checkTranslation();
  }

  updateConnectionStatus(status, connected) {
    const statusElement = document.getElementById("statusText");
    const statusContainer = document.getElementById("connectionStatus");

    if (statusElement) {
      statusElement.textContent = status;
    }

    if (statusContainer) {
      statusContainer.className = connected
        ? "connection-status connected"
        : "connection-status disconnected";
    }
  }

  updateUserCount(count) {
    const userCountElement = document.getElementById("userCount");
    if (userCountElement) {
      userCountElement.textContent = `${count} users online`;
    }
  }

  detectLanguage(text) {
    const hasHangul = /[\uAC00-\uD7AF]/.test(text);
    if (hasHangul) return "ko";
    const hasHiragana = /[\u3040-\u309F]/.test(text);
    const hasKatakana = /[\u30A0-\u30FF\uFF66-\uFF9F]/.test(text);
    if (hasHiragana || hasKatakana) return "ja";
    const hasHan = /[\u4E00-\u9FFF]/.test(text);
    if (hasHan) return "ja";
    const hasLatin = /[A-Za-z]/.test(text);
    if (hasLatin) return "en";
    return "en";
  }

  async fetchTranslations(thought) {
    const text = thought.text;
    if (this.translationCache.has(text)) {
      const cached = this.translationCache.get(text);
      if (cached && typeof cached.then === "function") {
        try {
          const res = await cached;
          thought.translations = res;
        } catch (e) { }
        return;
      } else {
        thought.translations = cached;
        return;
      }
    }

    const translate = async (q, target) => {
      const source = this.detectLanguage(q);
      if (source === target) return q;
      try {
        const url = `https://api.mymemory.translated.net/get?q=${encodeURIComponent(
          q
        )}&langpair=${encodeURIComponent(source)}|${encodeURIComponent(
          target
        )}`;
        const resp = await fetch(url, { method: "GET" });
        if (!resp.ok) throw new Error("bad status");
        const data = await resp.json();
        if (data && data.responseData && data.responseData.translatedText) {
          return data.responseData.translatedText;
        }
        if (Array.isArray(data.matches) && data.matches.length > 0) {
          const best = data.matches.sort(
            (a, b) => (b.quality || 0) - (a.quality || 0)
          )[0];
          if (best && best.translation) return best.translation;
        }
      } catch (e) { }
      return q; // graceful fallback
    };

    const promise = (async () => {
      const [ko, ja, en] = await Promise.all([
        translate(text, "ko"),
        translate(text, "ja"),
        translate(text, "en"),
      ]);
      const result = { ko, ja, en };
      this.translationCache.set(text, result);
      return result;
    })();

    this.translationCache.set(text, promise);
    try {
      const res = await promise;
      thought.translations = res;
    } catch (e) { }
  }

  setupCanvas() {
    this.resizeCanvas();
    window.addEventListener("resize", () => this.resizeCanvas());
  }

  resizeCanvas() {
    this.canvas.width = window.innerWidth;
    this.canvas.height = window.innerHeight;
  }

  setupEventListeners() {
    // Mic-only mode: no text input or submit handlers
    this.canvas.addEventListener('click', (e) => this.handleCanvasClick(e));
  }

  handleCanvasClick(e) {
    const rect = this.canvas.getBoundingClientRect();
    const clickX = e.clientX - rect.left;
    const clickY = e.clientY - rect.top;

    // 클릭된 텍스트 찾기
    for (let thought of this.thoughts) {
      if (!thought.mainText.clickable || thought.mainText.opacity < 0.5) continue;

      // 텍스트 크기 측정
      this.ctx.save();
      this.ctx.font = `${thought.mainText.size}px Arial`;
      const textWidth = this.ctx.measureText(thought.mainText.text).width;
      this.ctx.restore();

      const textHeight = thought.mainText.size;

      // 클릭 영역을 텍스트 박스 크기로 확장 (패딩 추가)
      const padding = 20; // 클릭 영역 확장을 위한 패딩
      const clickWidth = textWidth + padding * 2;
      const clickHeight = textHeight + padding * 2;

      // 확장된 텍스트 영역 내 클릭인지 확인
      if (clickX >= thought.x - clickWidth / 2 &&
        clickX <= thought.x + clickWidth / 2 &&
        clickY >= thought.y - clickHeight / 2 &&
        clickY <= thought.y + clickHeight / 2) {

        this.changeTextLanguage(thought);
        break;
      }
    }
  }

  changeTextLanguage(thought) {
    if (!thought.translations || !thought.mainText.clickable) return;

    const languages = ['original', 'ko', 'ja', 'en'];
    const availableLanguages = ['original'];

    // 번역이 준비된 언어들만 추가
    if (thought.translations.ko) availableLanguages.push('ko');
    if (thought.translations.ja) availableLanguages.push('ja');
    if (thought.translations.en) availableLanguages.push('en');

    // 현재 언어 인덱스 증가
    thought.mainText.languageIndex = (thought.mainText.languageIndex + 1) % availableLanguages.length;
    const newLanguage = availableLanguages[thought.mainText.languageIndex];

    // 텍스트 변경
    if (newLanguage === 'original') {
      thought.mainText.text = thought.text;
    } else {
      thought.mainText.text = thought.translations[newLanguage] || thought.text;
    }

    thought.mainText.currentLanguage = newLanguage;
  }

  showThought(text, x = null, y = null, id = null, existingTranslations = null) {
    // 랜덤 위치 생성 (입력창 영역 제외)
    const margin = 100;
    const thoughtX =
      x || Math.random() * (this.canvas.width - 2 * margin) + margin;
    const thoughtY =
      y || Math.random() * (this.canvas.height - 2 * margin) + margin;

    const thought = {
      id: id || Date.now() + Math.random(),
      text: text,
      x: thoughtX,
      y: thoughtY,
      mainText: {
        text: text,
        size: 20,
        opacity: 0,
        created: Date.now(),
        currentLanguage: 'original', // 현재 표시되는 언어
        languageIndex: 0, // 현재 언어 인덱스
        isFloating: false, // 떠다니는 상태인지
        floatStartTime: null, // 떠다니기 시작한 시간
        floatDirection: { x: 0, y: 0 }, // 정규화된 떠다니는 방향 (단위벡터)
        floatSpeed: Math.random() * 0.3 + 0.1, // 떠다니는 속도 (0.1~0.4)
        clickable: true, // 클릭 가능한지
      },
      ripples: [],
      lastRippleTime: Date.now(),
      fadeStartTime: Date.now() + 10000, // 약 10초 후 페이드 시작
      ringCount: 0,
      translations: existingTranslations || { ko: null, ja: null, en: null },
    };

    this.thoughts.push(thought);

    // 번역이 이미 있으면 번역하지 않음
    if (!existingTranslations) {
      // Start async translations
      this.fetchTranslations(thought).catch(() => { });
    }

    return thought;
  }

  createRipple(thought) {
    const now = Date.now();
    if (now - thought.lastRippleTime < 1000) return; // 1초마다만 생성

    thought.lastRippleTime = now;

    // 언어를 링별로 ko -> ja -> en 순서로 선택, 번역이 없으면 원문 사용
    const ringIndex = thought.ringCount;
    const langs = ["ko", "ja", "en"];
    const lang = langs[ringIndex % langs.length];
    const word =
      (thought.translations && thought.translations[lang]) || thought.text;
    const pattern = (word + " ").split("");
    const rippleRadius = this.baseRadius + ringIndex * this.ringGap; // 링마다 간격
    const fontSize = 10;

    // 원둘레와 글자 폭을 기준으로 필요한 슬롯 수 계산
    this.ctx.save();
    this.ctx.font = `${fontSize}px Arial`;
    const charWidth = this.ctx.measureText("M").width; // 대략적 폭
    this.ctx.restore();

    const circumference = 2 * Math.PI * rippleRadius;
    const slots = Math.max(8, Math.floor(circumference / charWidth));

    for (let i = 0; i < slots; i++) {
      const ch = pattern[i % pattern.length];
      const angle = (i / slots) * Math.PI * 2;
      const x = thought.x + Math.cos(angle) * rippleRadius;
      const y = thought.y + Math.sin(angle) * rippleRadius;
      thought.ripples.push({
        text: ch,
        x: x,
        y: y,
        size: fontSize,
        opacity: 0,
        created: now,
        angle: angle,
        radius: rippleRadius,
        ringIndex: ringIndex,
        slotIndex: i,
      });
    }
    thought.ringCount += 1;
  }

  updateThoughts() {
    const now = Date.now();

    this.thoughts.forEach((thought) => {
      // 페이드 시작 전까지만 새로운 ripple 생성
      if (now < thought.fadeStartTime) {
        this.createRipple(thought);
      }

      // 페이드 인 처리: 생성 직후 0.5초 동안
      const mainBorn = thought.mainText.created;
      if (now < mainBorn + this.elementFadeInMs) {
        const t = Math.min(
          1,
          Math.max(0, (now - mainBorn) / this.elementFadeInMs)
        );
        thought.mainText.opacity = t;
      }

      thought.ripples.forEach((ch) => {
        const born = ch.created;
        if (now < born + this.elementFadeInMs) {
          const t = Math.min(
            1,
            Math.max(0, (now - born) / this.elementFadeInMs)
          );
          ch.opacity = Math.max(ch.opacity, t);
        }
      });

      // 페이드 아웃 처리: 물결만 페이드되고 메인 텍스트는 떠다니기 시작
      if (now > thought.fadeStartTime) {
        // 메인 텍스트는 페이드되지 않고 떠다니기 시작
        if (!thought.mainText.isFloating) {
          thought.mainText.isFloating = true;
          thought.mainText.floatStartTime = now;
          thought.mainText.clickable = true; // 떠다니는 동안 클릭 가능
          thought.mainText.opacity = 1; // 떠다니기 시작할 때 완전히 보이게

          // 랜덤 방향 생성 및 정규화
          const randomX = (Math.random() - 0.5) * 2; // -1 ~ 1
          const randomY = (Math.random() - 0.5) * 2; // -1 ~ 1
          const magnitude = Math.sqrt(randomX * randomX + randomY * randomY);

          // 정규화 (단위벡터로 만들기)
          thought.mainText.floatDirection.x = randomX / magnitude;
          thought.mainText.floatDirection.y = randomY / magnitude;
        }

        // 떠다니는 애니메이션
        if (thought.mainText.isFloating) {
          const floatTime = (now - thought.mainText.floatStartTime) / 1000; // 초 단위
          const floatDuration = now - thought.mainText.floatStartTime;

          // 30초에 가까워지면 페이드 아웃 시작 (마지막 3초 동안)
          if (floatDuration > 27000) { // 27초 후부터 페이드 시작
            const fadeProgress = (floatDuration - 27000) / 3000; // 0~1
            thought.mainText.opacity = Math.max(0, 1 - fadeProgress);
          }

          // 화면 경계 체크 및 반사
          if (thought.x < 50 || thought.x > this.canvas.width - 50) {
            thought.mainText.floatDirection.x *= -1;
          }
          if (thought.y < 50 || thought.y > this.canvas.height - 50) {
            thought.mainText.floatDirection.y *= -1;
          }

          // 정규화된 방향 × 속도 × 전체 속도 배수 = 다음 좌표
          thought.x += thought.mainText.floatDirection.x * thought.mainText.floatSpeed * this.globalFloatSpeedMultiplier;
          thought.y += thought.mainText.floatDirection.y * thought.mainText.floatSpeed * this.globalFloatSpeedMultiplier;
        }

        // 링/문자 단위 계단식 페이드 (물결만)
        const rings = thought.ringCount;
        for (let r = 0; r < rings; r++) {
          // 각 링의 시작 시간은 페이드 시작 시간 + ringDelay * r
          const ringStart = thought.fadeStartTime + r * this.ringDelayMs;
          // 해당 링의 문자들만 추려서 슬롯 인덱스 기준으로 내부 지연 적용
          const ringChars = thought.ripples.filter((ch) => ch.ringIndex === r);
          ringChars.forEach((ch, idx) => {
            const charStart = ringStart + idx * this.charDelayMs;
            const charEnd = charStart + this.elementFadeMs;
            if (now >= charStart) {
              const t = Math.min(
                1,
                Math.max(0, (now - charStart) / (charEnd - charStart))
              );
              ch.opacity = 1 - t;
            }
          });
        }
      }
    });

    // 완전히 사라진 생각들 제거 (떠다니는 텍스트는 30초 후 제거)
    this.thoughts = this.thoughts.filter((thought) => {
      // 떠다니는 텍스트가 30초 이상 지났으면 제거
      if (thought.mainText.isFloating && thought.mainText.floatStartTime) {
        const floatDuration = now - thought.mainText.floatStartTime;
        if (floatDuration > 30000) { // 30초 = 30000ms
          // 보낸 메시지 ID에서도 제거 (메모리 정리)
          this.sentMessageIds.delete(thought.id);
          return false; // 제거
        }
      }

      // 일반적인 제거 조건들
      return (
        thought.mainText.isFloating || // 떠다니는 텍스트는 30초 이내에만 유지
        thought.mainText.opacity > 0 ||
        thought.ripples.some((ripple) => ripple.opacity > 0)
      );
    });
  }

  drawThought(thought) {
    this.ctx.save();

    // 메인 텍스트 그리기
    this.ctx.font = `${thought.mainText.size}px Arial`;
    this.ctx.textAlign = "center";
    this.ctx.textBaseline = "middle";

    // 떠다니는 텍스트는 다른 스타일 적용
    if (thought.mainText.isFloating) {
      // 떠다니는 텍스트: 그림자와 테두리 효과
      this.ctx.shadowColor = 'rgba(0, 0, 0, 0.3)';
      this.ctx.shadowBlur = 4;
      this.ctx.shadowOffsetX = 2;
      this.ctx.shadowOffsetY = 2;
      this.ctx.fillStyle = `rgba(0, 0, 0, ${thought.mainText.opacity})`;
      this.ctx.fillText(thought.mainText.text, thought.x, thought.y);

      // 테두리 효과
      this.ctx.shadowColor = 'transparent';
      this.ctx.strokeStyle = `rgba(255, 255, 255, ${thought.mainText.opacity * 0.3})`;
      this.ctx.lineWidth = 1;
      this.ctx.strokeText(thought.mainText.text, thought.x, thought.y);
    } else {
      // 일반 텍스트 (흰 배경 대비 어두운 색)
      this.ctx.fillStyle = `rgba(0, 0, 0, ${thought.mainText.opacity})`;
      this.ctx.fillText(thought.mainText.text, thought.x, thought.y);
    }

    // Ripple 텍스트들 그리기 (흰 배경 대비 중간 톤)
    thought.ripples.forEach((ripple) => {
      this.ctx.font = `${ripple.size}px Arial`;
      this.ctx.fillStyle = `rgba(0, 0, 0, ${ripple.opacity * 0.6})`;
      this.ctx.textAlign = "center";
      this.ctx.textBaseline = "middle";
      this.ctx.fillText(ripple.text, ripple.x, ripple.y);
    });

    this.ctx.restore();
  }

  draw() {
    // Canvas 클리어
    this.ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);

    // 모든 생각들 그리기
    this.thoughts.forEach((thought) => this.drawThought(thought));
  }

  animate() {
    this.updateThoughts();
    this.draw();
    this.animationId = requestAnimationFrame(() => this.animate());
  }

  startAnimation() {
    this.animate();
  }

  stopAnimation() {
    if (this.animationId) {
      cancelAnimationFrame(this.animationId);
    }
  }
}

// 페이지 로드 시 초기화
document.addEventListener("DOMContentLoaded", () => {
  new SharedRippleThinking();
});
