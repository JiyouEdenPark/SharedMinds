class RippleThinking {
    constructor() {
        this.canvas = document.getElementById('rippleCanvas');
        this.ctx = this.canvas.getContext('2d');
        this.textInput = document.getElementById('textInput');
        this.submitBtn = document.getElementById('submitBtn');

        this.thoughts = [];
        this.animationId = null;

        // Fade and layout timing configuration
        this.baseRadius = 30;
        this.ringGap = 22;
        this.elementFadeMs = 500;      // each element fades over 0.5s
        this.elementFadeInMs = 500;    // fade-in duration per element
        this.ringDelayMs = 250;         // delay between rings starting fade
        this.charDelayMs = 12;          // stagger characters within a ring

        // Translation cache for input text -> { ko, ja, en }
        this.translationCache = new Map();

        this.setupCanvas();
        this.setupEventListeners();
        this.startAnimation();
    }

    detectLanguage(text) {
        const hasHangul = /[\uAC00-\uD7AF]/.test(text);
        if (hasHangul) return 'ko';
        const hasHiragana = /[\u3040-\u309F]/.test(text);
        const hasKatakana = /[\u30A0-\u30FF\uFF66-\uFF9F]/.test(text);
        if (hasHiragana || hasKatakana) return 'ja';
        const hasHan = /[\u4E00-\u9FFF]/.test(text);
        if (hasHan) return 'ja';
        const hasLatin = /[A-Za-z]/.test(text);
        if (hasLatin) return 'en';
        return 'en';
    }

    async fetchTranslations(thought) {
        const text = thought.text;
        if (this.translationCache.has(text)) {
            const cached = this.translationCache.get(text);
            if (cached && typeof cached.then === 'function') {
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
                const url = `https://api.mymemory.translated.net/get?q=${encodeURIComponent(q)}&langpair=${encodeURIComponent(source)}|${encodeURIComponent(target)}`;
                const resp = await fetch(url, { method: 'GET' });
                if (!resp.ok) throw new Error('bad status');
                const data = await resp.json();
                console.log(data);
                if (data && data.responseData && data.responseData.translatedText) {
                    return data.responseData.translatedText;
                }
                if (Array.isArray(data.matches) && data.matches.length > 0) {
                    const best = data.matches.sort((a, b) => (b.quality || 0) - (a.quality || 0))[0];
                    if (best && best.translation) return best.translation;
                }
            } catch (e) { }
            return q; // graceful fallback
        };

        const promise = (async () => {
            const [ko, ja, en] = await Promise.all([
                translate(text, 'ko'),
                translate(text, 'ja'),
                translate(text, 'en')
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
        window.addEventListener('resize', () => this.resizeCanvas());
    }

    resizeCanvas() {
        this.canvas.width = window.innerWidth;
        this.canvas.height = window.innerHeight;
    }

    setupEventListeners() {
        this.submitBtn.addEventListener('click', () => this.addThought());
        this.textInput.addEventListener('keypress', (e) => {
            if (e.key === 'Enter') {
                this.addThought();
            }
        });

        // Canvas 클릭으로도 생각 추가 가능
        this.canvas.addEventListener('click', (e) => {
            if (this.textInput.value.trim()) {
                this.addThought(e.clientX, e.clientY);
            }
        });
    }

    addThought(x = null, y = null) {
        const text = this.textInput.value.trim();
        if (!text) return;

        // 랜덤 위치 생성 (입력창 영역 제외)
        const margin = 100;
        const thoughtX = x || Math.random() * (this.canvas.width - 2 * margin) + margin;
        const thoughtY = y || Math.random() * (this.canvas.height - 2 * margin) + margin;

        const thought = {
            id: Date.now(),
            text: text,
            x: thoughtX,
            y: thoughtY,
            mainText: {
                text: text,
                size: 20,
                opacity: 0,
                created: Date.now()
            },
            ripples: [],
            lastRippleTime: Date.now(),
            fadeStartTime: Date.now() + 10000, // 약 10초 후 페이드 시작
            ringCount: 0,
            translations: { ko: null, ja: null, en: null }
        };

        this.thoughts.push(thought);
        this.textInput.value = '';

        // Start async translations
        this.fetchTranslations(thought).catch(() => { });
    }

    createRipple(thought) {
        const now = Date.now();
        if (now - thought.lastRippleTime < 1000) return; // 1초마다만 생성

        thought.lastRippleTime = now;

        // 언어를 링별로 ko -> ja -> en 순서로 선택, 번역이 없으면 원문 사용
        const ringIndex = thought.ringCount;
        const langs = ['ko', 'ja', 'en'];
        const lang = langs[ringIndex % langs.length];
        const word = (thought.translations && thought.translations[lang]) || thought.text;
        const pattern = (word + ' ').split('');
        const rippleRadius = this.baseRadius + ringIndex * this.ringGap; // 링마다 간격
        const fontSize = 10;

        // 원둘레와 글자 폭을 기준으로 필요한 슬롯 수 계산
        this.ctx.save();
        this.ctx.font = `${fontSize}px Arial`;
        const charWidth = this.ctx.measureText('M').width; // 대략적 폭
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
                slotIndex: i
            });
        }
        thought.ringCount += 1;
    }

    updateThoughts() {
        const now = Date.now();

        this.thoughts.forEach(thought => {
            // 페이드 시작 전까지만 새로운 ripple 생성
            if (now < thought.fadeStartTime) {
                this.createRipple(thought);
            }

            // 페이드 인 처리: 생성 직후 0.5초 동안
            const mainBorn = thought.mainText.created;
            if (now < mainBorn + this.elementFadeInMs) {
                const t = Math.min(1, Math.max(0, (now - mainBorn) / this.elementFadeInMs));
                thought.mainText.opacity = t;
            }

            thought.ripples.forEach(ch => {
                const born = ch.created;
                if (now < born + this.elementFadeInMs) {
                    const t = Math.min(1, Math.max(0, (now - born) / this.elementFadeInMs));
                    ch.opacity = Math.max(ch.opacity, t);
                }
            });

            // 페이드 아웃 처리: 메인 텍스트부터 시작해서 안쪽 링부터 바깥 링 순서로, 각 요소별 지연을 두고 0.5초간 개별 페이드
            if (now > thought.fadeStartTime) {
                // 메인 텍스트 페이드
                const mainStart = thought.fadeStartTime;
                const mainEnd = mainStart + this.elementFadeMs;
                if (now >= mainStart) {
                    const t = Math.min(1, Math.max(0, (now - mainStart) / (mainEnd - mainStart)));
                    thought.mainText.opacity = 1 - t;
                }

                // 링/문자 단위 계단식 페이드
                const rings = thought.ringCount;
                for (let r = 0; r < rings; r++) {
                    // 각 링의 시작 시간은 메인 이후 + ringDelay * r
                    const ringStart = thought.fadeStartTime + this.elementFadeMs + r * this.ringDelayMs;
                    // 해당 링의 문자들만 추려서 슬롯 인덱스 기준으로 내부 지연 적용
                    const ringChars = thought.ripples.filter(ch => ch.ringIndex === r);
                    ringChars.forEach((ch, idx) => {
                        const charStart = ringStart + idx * this.charDelayMs;
                        const charEnd = charStart + this.elementFadeMs;
                        if (now >= charStart) {
                            const t = Math.min(1, Math.max(0, (now - charStart) / (charEnd - charStart)));
                            ch.opacity = 1 - t;
                        }
                    });
                }
            }
        });

        // 완전히 사라진 생각들 제거
        this.thoughts = this.thoughts.filter(thought =>
            thought.mainText.opacity > 0 || thought.ripples.some(ripple => ripple.opacity > 0)
        );
    }

    drawThought(thought) {
        this.ctx.save();

        // 메인 텍스트 그리기 (흰 배경 대비 어두운 색)
        this.ctx.font = `${thought.mainText.size}px Arial`;
        this.ctx.fillStyle = `rgba(0, 0, 0, ${thought.mainText.opacity})`;
        this.ctx.textAlign = 'center';
        this.ctx.textBaseline = 'middle';
        this.ctx.fillText(thought.mainText.text, thought.x, thought.y);

        // Ripple 텍스트들 그리기 (흰 배경 대비 중간 톤)
        thought.ripples.forEach(ripple => {
            this.ctx.font = `${ripple.size}px Arial`;
            this.ctx.fillStyle = `rgba(0, 0, 0, ${ripple.opacity * 0.6})`;
            this.ctx.textAlign = 'center';
            this.ctx.textBaseline = 'middle';
            this.ctx.fillText(ripple.text, ripple.x, ripple.y);
        });

        this.ctx.restore();
    }

    draw() {
        // Canvas 클리어
        this.ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);

        // 모든 생각들 그리기
        this.thoughts.forEach(thought => this.drawThought(thought));
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
document.addEventListener('DOMContentLoaded', () => {
    new RippleThinking();
});
