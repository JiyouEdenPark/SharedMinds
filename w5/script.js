class SharedRippleThinking {
  constructor() {
    this.canvas = document.getElementById("rippleCanvas");
    this.ctx = this.canvas.getContext("2d");
    this.micBtn = document.getElementById("micBtn");
    this.textInput = document.getElementById("textInput");
    this.submitBtn = document.getElementById("submitBtn");
    this._isComposing = false;

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

    // Water (underwater blur) interaction configuration
    this.waterAppearDelayMs = 500; // delay after ripple fade start
    this.waterSinkMs = 1800; // slow, natural sink
    this.waterRiseMs = 500; // faster, snappier rise
    this.waterAutoSinkMs = 10000; // time to auto-sink after resurfacing
    this.maxBlurPx = 6; // maximum blur in pixels when fully submerged
    this.sinkOffsetPx = 10; // downward offset when submerged

    // Per-thought lifecycle defaults (can be overridden per item)
    this.defaultLifecycle = {
      ripplePhaseMs: 10000, // time before ripples start fading
      surfaceHoldMs: 6000, // time to stay surfaced after click
      totalLifetimeMs: 60000, // total lifetime since creation (0 = never)
      removalFadeMs: 1200, // fade-out duration on removal
      submergedRemoveMs: 120000, // remove after this long underwater (0 = never)
    };

    // Translation cache for input text -> { ko, ja, en }
    this.translationCache = new Map();

    // Track sent message IDs to prevent showing own messages
    this.sentMessageIds = new Set();
    this.displayedDocIds = new Set(); // Firestore-rendered IDs to avoid duplicates
    this.firestoreStartMs = Date.now(); // only show docs created after listener starts
    this.firestoreInitialLoaded = false; // render all existing on first snapshot

    this.voiceInput = new VoiceInput({
      micBtn: this.micBtn,
      realtime: true,
      useProxyASR: true,
      onAppendText: (text) => this.sendThoughtToServer(text),
    });

    this.setupCanvas();
    this.setupEventListeners();
    // serverless: skip socket setup
    this.startFirestoreListener();
    this.startAnimation();
  }

  // setupSocketManager removed in serverless mode

  sendThoughtToServer(text) {
    const margin = 100;
    const x = Math.random() * (this.canvas.width - 2 * margin) + margin;
    const y = Math.random() * (this.canvas.height - 2 * margin) + margin;

    // 먼저 화면에 표시
    const thought = this.showThought(text, x, y);
    thought.createdByMe = true;


    // 번역 완료 시 서버로 전송/저장 (반구 분석 제외)
    this.waitForTranslationAndSend(thought);
  }

  async waitForAnalysisAndSend(thought) {
    // 뇌 반구 분석 수행
    try {
      const hemisphereResult = await ProxyAI.analyzeTextHemisphere(thought.text);
      thought.hemisphere = hemisphereResult;
      console.log("Brain hemisphere analysis result:", hemisphereResult);
    } catch (error) {
      console.error("Brain hemisphere analysis failed:", error);
      // fallback 값 설정
      thought.hemisphere = { hemisphere: 'right', confidence: 50 };
    }

    // 번역이 완료될 때까지 대기
    const checkTranslation = () => {
      if (thought.translations && thought.translations.ko !== null) {
        // 번역과 뇌 반구 분석이 모두 완료되면 서버로 전송
        this.socketManager.sendText(thought.text, thought.x, thought.y, thought.translations, thought.id, thought.hemisphere);
        // 보낸 메시지 ID를 추적
        this.sentMessageIds.add(thought.id);
      } else {
        // 100ms 후 다시 확인
        setTimeout(checkTranslation, 100);
      }
    };
    checkTranslation();
  }

  // --- Firestore integration ---
  async saveThoughtToFirestore(thought) {
    try {
      const mod = await import('./firebaseClient.js');
      const { db, collection, addDoc, serverTimestamp } = mod;
      await addDoc(collection(db, 'shared_thoughts'), {
        id: thought.id,
        text: thought.text,
        x: thought.x,
        y: thought.y,
        createdAt: serverTimestamp(),
        updatedAt: serverTimestamp(),
        translations: thought.translations || null,
      });
    } catch (_) { }
  }

  startFirestoreListener() {
    (async () => {
      try {
        const mod = await import('./firebaseClient.js');
        const { db, collection, onSnapshot, query, orderBy, doc, updateDoc, serverTimestamp } = mod;
        const q = query(collection(db, 'shared_thoughts'), orderBy('createdAt', 'asc'));
        onSnapshot(q, (snap) => {
          // 첫 스냅샷: 기존 문서 전부 렌더
          if (!this.firestoreInitialLoaded) {
            const docs = [];
            snap.forEach((d) => docs.push(d));
            docs.forEach((doc) => {
              const data = doc && typeof doc.data === 'function' ? (doc.data() || {}) : {};
              const id = (data && data.id) || (doc && doc.id) || undefined;
              if (!id) return;
              if (this.displayedDocIds.has(id)) return;
              let createdAtMs = Date.now();
              try {
                const ca = data.createdAt;
                if (ca && typeof ca.toMillis === 'function') createdAtMs = ca.toMillis();
                else if (typeof ca === 'number') createdAtMs = ca;
              } catch { createdAtMs = Date.now(); }
              // Skip expired items on refresh (past total lifetime)
              const totalLife = (this.defaultLifecycle && this.defaultLifecycle.totalLifetimeMs) || 0;
              if (totalLife > 0 && (Date.now() - createdAtMs) > totalLife) return;
              const t = this.showThought(data.text, data.x, data.y, id, data.translations || null, null, createdAtMs);
              try {
                const up = data.updatedAt;
                const updatedAtMs = up && typeof up.toMillis === 'function' ? up.toMillis() : 0;
                if (t) t._updatedAtMs = updatedAtMs || 0;
              } catch { }
              this.displayedDocIds.add(id);
            });
            this.firestoreInitialLoaded = true;
            this.firestoreStartMs = Date.now();
            return;
          }

          // 이후 스냅샷: 새로 추가된 것만 렌더
          const changes = typeof snap.docChanges === 'function' ? snap.docChanges() : [];
          changes.forEach((change) => {
            if (!change || change.type !== 'added') return;
            const doc = change.doc;
            const data = doc && typeof doc.data === 'function' ? (doc.data() || {}) : {};
            const id = (data && data.id) || (doc && doc.id) || undefined;
            if (!id) return;
            if (this.sentMessageIds.has(id) || this.displayedDocIds.has(id)) return;
            let createdAtMs = Date.now();
            try {
              const ca = data.createdAt;
              if (ca && typeof ca.toMillis === 'function') createdAtMs = ca.toMillis();
              else if (typeof ca === 'number') createdAtMs = ca;
            } catch { createdAtMs = Date.now(); }
            // Skip if already expired by the time we receive it
            const totalLife = (this.defaultLifecycle && this.defaultLifecycle.totalLifetimeMs) || 0;
            if (totalLife > 0 && (Date.now() - createdAtMs) > totalLife) return;
            const t = this.showThought(data.text, data.x, data.y, id, data.translations || null, null, createdAtMs);
            try {
              const up = data.updatedAt;
              const updatedAtMs = up && typeof up.toMillis === 'function' ? up.toMillis() : 0;
              if (t) t._updatedAtMs = updatedAtMs || 0;
            } catch { }
            this.displayedDocIds.add(id);
          });

          // updatedAt 변경 시 라이프사이클 리셋/떠오르기 반영
          changes.forEach((change) => {
            if (!change || change.type !== 'modified') return;
            const doc = change.doc;
            try { if (doc && doc.metadata && doc.metadata.hasPendingWrites) return; } catch { }
            const data = doc && typeof doc.data === 'function' ? (doc.data() || {}) : {};
            const id = (data && data.id) || (doc && doc.id) || undefined;
            if (!id) return;
            const found = this.thoughts.find(t => String(t.id) === String(id));
            if (!found) return;
            try {
              const up = data.updatedAt;
              const updatedAtMs = up && typeof up.toMillis === 'function' ? up.toMillis() : 0;
              if (!updatedAtMs) return;
              const prev = found._updatedAtMs || 0;
              // If the item was created by me, skip only when updatedAt is not newer than what I already saw
              if (found.createdByMe && updatedAtMs <= prev) return;
              // If this update was initiated by this client (awaiting flag), just record and skip triggering
              if (found._awaitingUpdatedAt) {
                found._updatedAtMs = updatedAtMs;
                found._awaitingUpdatedAt = false;
                return;
              }
              if (prev !== 0 && updatedAtMs > prev) {
                console.log('found', found, updatedAtMs, prev);
                found._updatedAtMs = updatedAtMs;
                const nowTs = Date.now();
                this.resetThoughtLifecycle(found, nowTs);
                this.startResurface(found, nowTs);
              }
            } catch { }
          });
        });
      } catch (_) { }
    })();
  }

  async waitForTranslationAndSend(thought) {
    // 번역이 완료될 때까지 대기
    const checkTranslation = () => {
      if (thought.translations && thought.translations.ko !== null) {
        // 번역 완료: 서버(있다면) 전송 + Firestore 저장
        if (this.socketManager && this.socketManager.sendText) {
          this.socketManager.sendText(thought.text, thought.x, thought.y, thought.translations, thought.id);
        }
        this.saveThoughtToFirestore(thought).catch(() => { });
        this.sentMessageIds.add(thought.id);
      } else {
        // 100ms 후 다시 확인
        setTimeout(checkTranslation, 100);
      }
    };
    checkTranslation();
  }

  // Connection status UI removed in serverless mode

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
    // Canvas interactions
    this.canvas.addEventListener('click', (e) => this.handleCanvasClick(e));

    // Text submit via button
    if (this.submitBtn) {
      this.submitBtn.addEventListener('click', () => this.handleTextSubmit());
    }

    // Text submit via Enter key
    if (this.textInput) {
      this.textInput.addEventListener('compositionstart', () => {
        this._isComposing = true;
      });
      this.textInput.addEventListener('compositionend', () => {
        this._isComposing = false;
      });
      this.textInput.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' && !e.shiftKey && !e.isComposing && !this._isComposing) {
          e.preventDefault();
          this.handleTextSubmit();
        }
      });
    }
  }

  handleTextSubmit() {
    if (!this.textInput) return;
    const value = (this.textInput.value || "").trim();
    if (!value) return;
    this.sendThoughtToServer(value);
    this.textInput.value = "";
  }

  handleCanvasClick(e) {
    const rect = this.canvas.getBoundingClientRect();
    const clickX = e.clientX - rect.left;
    const clickY = e.clientY - rect.top;

    // 물 속/수면 토글: 텍스트 영역 클릭 시 수면으로 올라오게
    for (let thought of this.thoughts) {
      // 텍스트 박스 근방 클릭 시 반응
      this.ctx.save();
      this.ctx.font = `${thought.mainText.size}px Arial`;
      const textWidth = this.ctx.measureText(thought.mainText.text).width;
      this.ctx.restore();
      const textHeight = thought.mainText.size;
      const padding = 20;
      const clickWidth = textWidth + padding * 2;
      const clickHeight = textHeight + padding * 2;
      if (clickX >= thought.x - clickWidth / 2 &&
        clickX <= thought.x + clickWidth / 2 &&
        clickY >= thought.y - clickHeight / 2 &&
        clickY <= thought.y + clickHeight / 2) {
        const now = Date.now();
        this.resetThoughtLifecycle(thought, now);
        this.startResurface(thought, now);
        this.persistUpdatedAt(thought);
        return;
      }
    }

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
        const now = Date.now();
        this.resetThoughtLifecycle(thought, now);
        this.startResurface(thought, now);
        this.persistUpdatedAt(thought);
        this.changeTextLanguage(thought);
        break;
      }
    }
  }

  changeTextLanguage(thought) {
    if (!thought.translations || !thought.mainText.clickable) return;

    // 원본 텍스트의 언어 감지
    const originalLanguage = this.detectLanguage(thought.text);

    const availableLanguages = ['original'];

    // 번역이 준비된 언어들만 추가하되, 원본 언어와 같은 것은 제외
    if (thought.translations.ko && originalLanguage !== 'ko') {
      availableLanguages.push('ko');
    }
    if (thought.translations.ja && originalLanguage !== 'ja') {
      availableLanguages.push('ja');
    }
    if (thought.translations.en && originalLanguage !== 'en') {
      availableLanguages.push('en');
    }

    // 사용 가능한 언어가 1개(original만)면 전환하지 않음
    if (availableLanguages.length <= 1) return;

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

  showThought(text, x = null, y = null, id = null, existingTranslations = null, existingHemisphere = null, createdAtMs = null, lifecycle = null) {
    // 랜덤 위치 생성 (입력창 영역 제외)
    const margin = 100;
    const thoughtX =
      x || Math.random() * (this.canvas.width - 2 * margin) + margin;
    const thoughtY =
      y || Math.random() * (this.canvas.height - 2 * margin) + margin;

    const lifecycleCfg = lifecycle || this.defaultLifecycle;
    const thought = {
      id: id || Date.now() + Math.random(),
      text: text,
      x: thoughtX,
      y: thoughtY,
      lifecycle: { ...this.defaultLifecycle, ...(lifecycle || {}) },
      mainText: {
        text: text,
        size: 20,
        opacity: 0,
        created: createdAtMs || Date.now(),
        currentLanguage: 'original', // 현재 표시되는 언어
        languageIndex: 0, // 현재 언어 인덱스
        isFloating: false, // 사용 안 함 (호환)
        clickable: true, // 클릭 가능한지
      },
      ripples: [],
      lastRippleTime: Date.now(),
      fadeStartTime: (createdAtMs || Date.now()) + (lifecycleCfg.ripplePhaseMs ?? this.defaultLifecycle.ripplePhaseMs),
      ringCount: 0,
      translations: existingTranslations || { ko: null, ja: null, en: null },
      hemisphere: existingHemisphere || { hemisphere: 'right', confidence: 50 }, // 호환 필드 (미사용)
      water: {
        isUnder: false, // fully submerged
        animStart: 0,
        animFrom: 0, // 0 ~ 1 progress (0: surfaced, 1: submerged)
        animTo: 0,
        progress: 0,
        resurfacedAt: 0, // last time surfaced (legacy)
        initialSinkStarted: false,
        nextAutoSinkAt: 0,
      },
    };

    this.thoughts.push(thought);

    // 초기 표시 상태 조정 (리프레시로 과거 항목을 불러온 경우)
    const now = Date.now();
    // 페이드 인이 이미 끝났다면 불투명도 1로 고정
    if (now >= thought.mainText.created + this.elementFadeInMs) {
      thought.mainText.opacity = 1;
    }
    // 모든 물결이 이미 종료되고 가라앉아 있어야 할 시간이 지났다면 즉시 수면 밑 상태로 설정
    const shouldBeUnderFromTime = now >= (thought.fadeStartTime + this.waterAppearDelayMs);
    if (shouldBeUnderFromTime) {
      thought.water.progress = 1;
      thought.water.isUnder = true;
      thought.water.animStart = 0;
      thought.water.animFrom = 1;
      thought.water.animTo = 1;
      thought.water.initialSinkStarted = true;
      // 리플은 생성하지 않음
      thought.ripples = [];
      thought.ringCount = 0;
    }

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

      // 페이드 아웃 처리: 물결만 페이드되고 메인 텍스트는 생성 위치에 유지
      if (now > thought.fadeStartTime) {
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

        // 모든 물결 텍스트가 완전히 사라진 뒤에만 최초 가라앉기 시작
        if (thought.water && !thought.water.initialSinkStarted) {
          const allRipplesGone = thought.ripples.every(r => r.opacity <= 0);
          if (allRipplesGone && now > thought.fadeStartTime + this.waterAppearDelayMs) {
            thought.water.initialSinkStarted = true;
            this.startSink(thought, now);
          }
        }
      }
      // 물 상태 업데이트 (애니메이션 진행, 자동 가라앉기)
      if (thought.water) {
        this.updateWater(thought, now);
      }
    });

    // 유지/제거 조건 + 자연스러운 페이드아웃 (총 생애 1분 기본)
    this.thoughts = this.thoughts.filter((thought) => {
      const keepForRipples = thought.ripples.some((r) => r.opacity > 0);
      const keepForVisibleText = thought.mainText.opacity > 0;
      const totalLife = (thought.lifecycle && thought.lifecycle.totalLifetimeMs) || this.defaultLifecycle.totalLifetimeMs;
      const removalFade = (thought.lifecycle && thought.lifecycle.removalFadeMs) || this.defaultLifecycle.removalFadeMs;
      const bornAt = thought.mainText.created;
      const lifeElapsed = now - bornAt;

      // time-based removal after totalLifetimeMs
      const overLife = totalLife > 0 && lifeElapsed > totalLife;
      if (overLife && removalFade > 0) {
        if (!thought._removal) thought._removal = { start: now };
        const t = Math.min(1, (now - thought._removal.start) / removalFade);
        const eased = t * t * (3 - 2 * t);
        thought.mainText.opacity = Math.max(0, 1 - eased);
        thought.ripples.forEach((r) => { r.opacity = Math.max(0, r.opacity * (1 - t)); });
        return thought.mainText.opacity > 0 || thought.ripples.some((r) => r.opacity > 0);
      }

      // optional: also support removal after staying underwater for a while
      const subRemove = (thought.lifecycle && thought.lifecycle.submergedRemoveMs) || 0;
      const shouldRemoveByUnder = subRemove > 0 && thought.water && thought.water.isUnder && (now - (thought.water.resurfacedAt || bornAt)) > subRemove;
      return (keepForRipples || keepForVisibleText) && !shouldRemoveByUnder;
    });
  }

  drawThought(thought) {
    this.ctx.save();

    // 메인 텍스트 그리기 (물속 상태에 따라 블러/오프셋 적용)
    this.ctx.font = `${thought.mainText.size}px Arial`;
    this.ctx.textAlign = "center";
    this.ctx.textBaseline = "middle";
    const wp = (thought.water && typeof thought.water.progress === 'number') ? thought.water.progress : 0;
    const blurPx = Math.max(0, Math.min(this.maxBlurPx, this.maxBlurPx * wp));
    const offsetY = (this.sinkOffsetPx || 0) * wp;
    const prevFilter = this.ctx.filter || 'none';
    this.ctx.filter = blurPx > 0 ? `blur(${blurPx}px)` : 'none';
    this.ctx.fillStyle = `rgba(0, 0, 0, ${thought.mainText.opacity})`;
    this.ctx.fillText(thought.mainText.text, thought.x, thought.y + offsetY);
    this.ctx.filter = prevFilter;

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

  // --- Water sink/resurface animation helpers ---
  startSink(thought, now) {
    const w = thought.water;
    if (!w) return;
    w.animStart = now;
    w.animFrom = w.progress || 0;
    w.animTo = 1;
  }

  startResurface(thought, now) {
    const w = thought.water;
    if (!w) return;
    w.animStart = now;
    w.animFrom = w.progress || 0;
    w.animTo = 0;
    // 유지 시간을 명확하게 타임스탬프로 예약
    w.resurfacedAt = now;
    const hold = (thought.lifecycle && typeof thought.lifecycle.surfaceHoldMs === 'number') ? thought.lifecycle.surfaceHoldMs : this.defaultLifecycle.surfaceHoldMs;
    // Start sinking early so that total time until fully underwater ≈ hold
    const startSinkAt = Math.max(now, now + hold - this.waterSinkMs);
    w.nextAutoSinkAt = startSinkAt;
  }

  updateWater(thought, now) {
    const w = thought.water;
    if (!w) return;
    if (w.animStart) {
      // Sink uses slower easing (ease-in-out cubic); rise uses faster duration
      const duration = w.animTo > w.animFrom ? this.waterSinkMs : this.waterRiseMs;
      const t = Math.min(1, (now - w.animStart) / duration);
      // cubic ease-in-out: 3t^2 - 2t^3
      const eased = (3 * t * t) - (2 * t * t * t);
      w.progress = w.animFrom + (w.animTo - w.animFrom) * eased;
      if (t >= 1) {
        w.animStart = 0;
        w.isUnder = w.animTo >= 1;
      }
    }
    // Auto sink after a while on surface
    if (!w.isUnder && !w.animStart && w.nextAutoSinkAt && now >= w.nextAutoSinkAt) {
      this.startSink(thought, now);
      w.nextAutoSinkAt = 0;
    }
  }

  // Restart lifecycle (ripples, timers, removal) from a given time
  resetThoughtLifecycle(thought, now) {
    const rp = (thought.lifecycle && typeof thought.lifecycle.ripplePhaseMs === 'number')
      ? thought.lifecycle.ripplePhaseMs
      : this.defaultLifecycle.ripplePhaseMs;
    // Preserve visual continuity: avoid sudden fade-out on click
    const currentOpacity = thought.mainText.opacity;
    thought.mainText.created = now - this.elementFadeInMs; // ensures opacity calc = 1
    thought.fadeStartTime = now + rp;
    thought._removal = null;
    thought.ripples = [];
    thought.ringCount = 0;
    thought.lastRippleTime = now - 1000; // allow immediate ripple creation
    thought.mainText.opacity = Math.max(1, currentOpacity || 0);
    if (thought.water) {
      thought.water.initialSinkStarted = false;
      // keep progress; startResurface will animate to surface
    }
  }

  // Persist updatedAt to Firestore so all clients can reflect the reset
  async persistUpdatedAt(thought) {
    try {
      const mod = await import('./firebaseClient.js');
      const { db, collection, query, where, limit, getDocs, doc, updateDoc, serverTimestamp } = mod;
      if (thought._updatedPending) return; // debounce
      thought._awaitingUpdatedAt = true; // mark self-initiated update
      // Resolve Firestore doc id by querying on custom id field if we don't have docId yet
      let targetDocId = thought.docId || null;
      if (!targetDocId) {
        const q = query(collection(db, 'shared_thoughts'), where('id', '==', thought.id), limit(1));
        const snap = await getDocs(q);
        snap.forEach(d => { if (!targetDocId) targetDocId = d.id; });
        thought.docId = targetDocId || thought.docId;
      }
      if (!targetDocId) return; // still not found; skip
      const targetDoc = doc(db, 'shared_thoughts', String(targetDocId));
      thought._updatedPending = true;
      await updateDoc(targetDoc, { updatedAt: serverTimestamp() });
    } catch { }
    finally {
      thought._updatedPending = false;
    }
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
