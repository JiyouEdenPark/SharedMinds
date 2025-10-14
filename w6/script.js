// --- Deterministic nickname generator (adjective + animal/object) ---
const NICK_ADJECTIVES = [
  "Brave", "Calm", "Bright", "Swift", "Gentle", "Merry", "Quiet", "Nimble", "Bold", "Clever",
  "Lucky", "Sunny", "Kind", "Neat", "Sharp", "Witty", "Warm", "Solid", "Rapid", "Steady",
  "Chill", "Cosmic", "Fuzzy", "Icy", "Lively", "Magic", "Rustic", "Shiny", "Silent", "Wild"
];
const NICK_NOUNS = [
  "Fox", "Panda", "Tiger", "Otter", "Dolphin", "Eagle", "Hedgehog", "Koala", "Lynx", "Raven",
  "Wolf", "Falcon", "Bear", "Moose", "Seal", "Whale", "Orca", "Heron", "Robin", "Swan",
  "Acorn", "Pebble", "Comet", "Aurora", "Bamboo", "Cedar", "Driftwood", "Quartz", "Moss", "River",
  "Canyon", "Breeze", "Thunder", "Rain", "Snow", "Starlight", "Meadow", "Sunbeam", "Cloud", "Leaf"
];
function hashStringToInt(str) {
  let h = 0;
  for (let i = 0; i < str.length; i++) {
    h = ((h << 5) - h) + str.charCodeAt(i);
    h |= 0;
  }
  return Math.abs(h);
}
function generateDeterministicNickname(uid) {
  if (!uid || typeof uid !== 'string') return "Guest";
  const h = hashStringToInt(uid);
  const adj = NICK_ADJECTIVES[h % NICK_ADJECTIVES.length];
  const noun = NICK_NOUNS[Math.floor(h / NICK_ADJECTIVES.length) % NICK_NOUNS.length];
  return `${adj} ${noun}`;
}

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
    this.userAvatar = null; // { x, y, radius, bobPhase, bobAmp }
    this.avatarBubble = null; // { text, created, fadeInMs, holdMs, fadeOutMs, opacity }
    this.renderRipples = false; // disable ripple text rendering
    this.otherUsers = new Map(); // uid -> { x,y,radius,nickname,updatedAt,bubble? }
    this._presenceTimer = null;
    this._avatarMove = null; // { fromX, fromY, toX, toY, start, durationMs }
    this.presenceStaleMs = 10 * 60 * 1000; // 10 minutes

    this.setupCanvas();
    this.setupEventListeners();
    // serverless: skip socket setup
    this.startAuthAndFirestore();
    this.startAnimation();
  }
  async startAuthAndFirestore() {
    try {
      const mod = await import('./firebaseClient.js');
      const { auth, onAuthStateChanged, signInAnonymously, signInWithPopup, GoogleAuthProvider, signOut, signInWithRedirect, getRedirectResult } = mod;

      // UI elements
      const userLabel = document.getElementById('userLabel');
      const googleBtn = document.getElementById('googleSignInBtn');
      const signOutBtn = document.getElementById('signOutBtn');

      // Anonymous sign-in as default (non-blocking)
      try { if (auth && !auth.currentUser) await signInAnonymously(auth); } catch { }

      // Wire buttons
      if (googleBtn) {
        googleBtn.addEventListener('click', async () => {
          try {
            try { sessionStorage.setItem('w6-resetOnSignin', '1'); } catch { }
            const provider = new GoogleAuthProvider();
            await signInWithPopup(auth, provider);
          } catch (e) {
            // Popup blocked or disallowed: fall back to redirect
            try {
              try { sessionStorage.setItem('w6-resetOnSignin', '1'); } catch { }
              const provider = new GoogleAuthProvider();
              await signInWithRedirect(auth, provider);
            } catch (_) { }
          }
        });
      }
      if (signOutBtn) {
        signOutBtn.addEventListener('click', async () => {
          try { await signOut(auth); } catch { }
        });
      }

      // Observe auth state and update UI
      if (onAuthStateChanged && auth) {
        // complete redirect result if coming back
        try { await getRedirectResult(auth); } catch { }
        onAuthStateChanged(auth, async (user) => {
          this.currentUser = user || null;
          this.currentNickname = user && user.uid ? generateDeterministicNickname(user.uid) : null;
          const display = this.currentNickname || (user ? `Guest ${String(user.uid).slice(0, 6)}` : 'Not signed in');
          if (userLabel) userLabel.textContent = display;
          if (googleBtn) googleBtn.style.display = user && user.isAnonymous ? '' : (user ? 'none' : '');
          if (signOutBtn) signOutBtn.style.display = user ? '' : 'none';
          // ensure avatar exists/updated
          if (user) {
            let shouldReset = false;
            try {
              const prevUid = sessionStorage.getItem('w6-session-uid');
              const resetFlag = sessionStorage.getItem('w6-resetOnSignin') === '1';
              shouldReset = !!resetFlag || (!!prevUid && prevUid !== user.uid);
            } catch { shouldReset = false; }
            if (shouldReset) {
              this.resetAvatarToRandom(true);
            } else {
              this.ensureUserAvatar();
            }
            await this.upsertSelfPresence();
            this.startPresence();
            this.subscribeUsers();
            try { sessionStorage.setItem('w6-session-uid', user.uid); } catch { }
            try { sessionStorage.removeItem('w6-resetOnSignin'); } catch { }
          } else {
            this.stopPresence();
            this.unsubscribeUsers();
            this.otherUsers.clear();
            try { sessionStorage.removeItem('w6-session-uid'); } catch { }
          }
        });
      }
    } catch { }
    // Start Firestore listener only when ripple rendering is enabled
    if (this.renderRipples) this.startFirestoreListener();
  }

  ensureUserAvatar() {
    if (!this.userAvatar) {
      const radius = 15; // 2/3 of previous 22px
      const margin = 100;
      const minX = radius + margin;
      const maxX = Math.max(minX, this.canvas.width - radius - margin);
      const minY = radius + margin;
      const maxY = Math.max(minY, this.canvas.height - radius - margin);

      // Try load persisted coordinates per-user
      const uid = this.currentUser && this.currentUser.uid ? this.currentUser.uid : null;
      let saved = null;
      if (uid) {
        try {
          const raw = localStorage.getItem(`w6-avatar-${uid}`);
          if (raw) saved = JSON.parse(raw);
        } catch { saved = null; }
      }

      let x, y;
      if (saved && typeof saved.x === 'number' && typeof saved.y === 'number') {
        x = Math.min(maxX, Math.max(minX, saved.x));
        y = Math.min(maxY, Math.max(minY, saved.y));
      } else {
        x = Math.random() * (maxX - minX) + minX;
        y = Math.random() * (maxY - minY) + minY;
        if (uid) {
          try { localStorage.setItem(`w6-avatar-${uid}`, JSON.stringify({ x, y, radius })); } catch { }
        }
      }
      this.userAvatar = {
        x,
        y,
        radius,
        bobPhase: Math.random() * Math.PI * 2,
        bobAmp: 3,
      };
    }
  }

  resetAvatarToRandom(persist = false) {
    const radius = 15;
    const margin = 100;
    const minX = radius + margin;
    const maxX = Math.max(minX, this.canvas.width - radius - margin);
    const minY = radius + margin;
    const maxY = Math.max(minY, this.canvas.height - radius - margin);
    const x = Math.random() * (maxX - minX) + minX;
    const y = Math.random() * (maxY - minY) + minY;
    this.userAvatar = {
      x,
      y,
      radius,
      bobPhase: Math.random() * Math.PI * 2,
      bobAmp: 3,
    };
    if (persist) {
      const uid = this.currentUser && this.currentUser.uid ? this.currentUser.uid : null;
      if (uid) {
        try { localStorage.setItem(`w6-avatar-${uid}`, JSON.stringify({ x, y, radius })); } catch { }
      }
    }
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

    // Update presence on visibility change and before unload
    try {
      document.addEventListener('visibilitychange', () => {
        if (this.currentUser) this.upsertSelfPresence && this.upsertSelfPresence();
      });
      window.addEventListener('beforeunload', () => {
        if (this.currentUser) this.upsertSelfPresence && this.upsertSelfPresence();
      });
    } catch { }
  }

  handleTextSubmit() {
    if (!this.textInput) return;
    const value = (this.textInput.value || "").trim();
    if (!value) return;
    // Create/refresh bubble above avatar for typed input
    this.showAvatarBubble(value);
    this.textInput.value = "";
  }

  showAvatarBubble(text) {
    if (!text) return;
    const now = Date.now();
    this.avatarBubble = {
      text: text,
      created: now,
      fadeInMs: 150,
      holdMs: Infinity,
      fadeOutMs: 0,
      opacity: 0,
    };
  }

  handleCanvasClick(e) {
    const rect = this.canvas.getBoundingClientRect();
    const clickX = e.clientX - rect.left;
    const clickY = e.clientY - rect.top;

    // 이동: 다른 사용자 아바타 클릭 시 내 아바타를 근처로 이동
    const targetUser = this.findOtherUserAt(clickX, clickY);
    if (targetUser) {
      this.moveAvatarNear(targetUser.x, targetUser.y, targetUser.radius || 15);
      return;
    }
  }

  findOtherUserAt(x, y) {
    if (!this.otherUsers || this.otherUsers.size === 0) return null;
    let found = null;
    let minDist = Infinity;
    // prepare metrics
    this.ctx.save();
    this.ctx.font = '12px Arial';
    for (const [, u] of this.otherUsers) {
      const r = u.radius || 15;
      // hit on circle
      const dx = x - u.x;
      const dy = y - u.y;
      const d = Math.hypot(dx, dy);
      const hitR = r + 8; // small padding
      let hit = d <= hitR;

      // hit on nickname label below
      if (!hit) {
        const label = u.nickname || 'Guest';
        const paddingX = 4;
        const textW = this.ctx.measureText(label).width;
        const boxW = Math.max(24, textW + paddingX * 2);
        const boxH = 16; // approx line height
        const bx = u.x - boxW / 2;
        const by = u.y + r + 8;
        if (x >= bx && x <= bx + boxW && y >= by && y <= by + boxH) hit = true;
      }

      // hit on bubble (if any)
      if (!hit && u.bubble) {
        const paddingX = 10;
        const paddingY = 6;
        const maxWidth = 240;
        let display = String(u.bubble);
        let metrics = this.ctx.measureText(display);
        while (metrics.width > (maxWidth - paddingX * 2) && display.length > 1) {
          display = display.slice(0, -1);
          metrics = this.ctx.measureText(display + '…');
          if (metrics.width <= (maxWidth - paddingX * 2)) { display = display + '…'; break; }
        }
        const boxW = Math.min(maxWidth, Math.max(32, metrics.width + paddingX * 2));
        const boxH = Math.max(22, 12 + paddingY * 2);
        const bx = u.x - boxW / 2;
        const by = u.y - r - 10 - boxH;
        if (x >= bx && x <= bx + boxW && y >= by && y <= by + boxH) hit = true;
      }

      if (hit && d < minDist) {
        minDist = d;
        found = u;
      }
    }
    this.ctx.restore();
    return found;
  }

  moveAvatarNear(tx, ty, tr = 15) {
    this.ensureUserAvatar();
    const a = this.userAvatar;
    if (!a) return;
    // Choose an offset around target at a comfortable distance
    const angle = Math.random() * Math.PI * 2;
    const dist = Math.max(24, (a.radius || 15) + tr + 10);
    const margin = 100;
    const minX = (a.radius || 15) + margin;
    const maxX = Math.max(minX, this.canvas.width - (a.radius || 15) - margin);
    const minY = (a.radius || 15) + margin;
    const maxY = Math.max(minY, this.canvas.height - (a.radius || 15) - margin);
    let dx = Math.cos(angle) * dist;
    let dy = Math.sin(angle) * dist;
    let nx = tx + dx;
    let ny = ty + dy;
    // Clamp into bounds
    nx = Math.min(maxX, Math.max(minX, nx));
    ny = Math.min(maxY, Math.max(minY, ny));
    // Animate movement
    this._avatarMove = {
      fromX: a.x,
      fromY: a.y,
      toX: nx,
      toY: ny,
      start: performance.now ? performance.now() : Date.now(),
      durationMs: 600,
    };
  }

  updateThoughts() {
    const now = Date.now();

    // Update avatar bubble lifecycle
    if (this.avatarBubble) {
      const b = this.avatarBubble;
      const t = now - (b.created || 0);
      const fi = b.fadeInMs || 0;
      const ho = Number.isFinite(b.holdMs) ? b.holdMs : Infinity;
      const fo = b.fadeOutMs || 0;
      if (t < fi) {
        b.opacity = Math.max(0, Math.min(1, t / fi));
      } else if (t < fi + ho) {
        b.opacity = 1;
      } else if (Number.isFinite(ho) && t < fi + ho + fo) {
        b.opacity = Math.max(0, 1 - (t - fi - ho) / fo);
      } else if (Number.isFinite(ho)) {
        this.avatarBubble = null;
      }
    }
  }

  updateAvatarMovement() {
    if (!(this._avatarMove && this.userAvatar)) return;
    const nowPerf = performance.now ? performance.now() : Date.now();
    const mv = this._avatarMove;
    const t = Math.min(1, (nowPerf - mv.start) / mv.durationMs);
    const eased = (3 * t * t) - (2 * t * t * t);
    this.userAvatar.x = mv.fromX + (mv.toX - mv.fromX) * eased;
    this.userAvatar.y = mv.fromY + (mv.toY - mv.fromY) * eased;
    if (t >= 1) {
      this._avatarMove = null;
      const uid = this.currentUser && this.currentUser.uid ? this.currentUser.uid : null;
      if (uid) {
        try {
          localStorage.setItem(`w6-avatar-${uid}`, JSON.stringify({ x: this.userAvatar.x, y: this.userAvatar.y, radius: this.userAvatar.radius }));
        } catch { }
      }
      this.upsertSelfPresence && this.upsertSelfPresence();
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
    // 다른 사용자 먼저
    this.drawOtherUsers();
    // 내 캐릭터
    this.drawUserAvatar();
    this.drawAvatarBubble();
  }

  async upsertSelfPresence() {
    try {
      const mod = await import('./firebaseClient.js');
      const { db, doc, setDoc, serverTimestamp, auth } = mod;
      const user = auth && auth.currentUser ? auth.currentUser : null;
      if (!user || !this.userAvatar) return;
      const ref = doc(db, 'users', user.uid);
      await setDoc(ref, {
        uid: user.uid,
        nickname: this.currentNickname || null,
        x: this.userAvatar.x,
        y: this.userAvatar.y,
        radius: this.userAvatar.radius,
        bubble: this.avatarBubble ? { text: this.avatarBubble.text } : null,
        updatedAt: serverTimestamp(),
      }, { merge: true });
    } catch { }
  }

  startPresence() {
    if (this._presenceTimer) return;
    this._presenceTimer = setInterval(() => {
      this.upsertSelfPresence().catch(() => { });
    }, 5000); // heartbeat every 5s
  }

  stopPresence() {
    if (this._presenceTimer) {
      clearInterval(this._presenceTimer);
      this._presenceTimer = null;
    }
  }

  async subscribeUsers() {
    if (this._usersUnsub) return;
    try {
      const mod = await import('./firebaseClient.js');
      const { db, collection, onSnapshot, serverTimestamp } = mod;
      const col = collection(db, 'users');
      this._usersUnsub = onSnapshot(col, (snap) => {
        const now = Date.now();
        this.otherUsers.clear();
        snap.forEach((doc) => {
          const d = typeof doc.data === 'function' ? doc.data() : null;
          if (!d || !d.uid) return;
          if (this.currentUser && d.uid === this.currentUser.uid) return;
          // derive updatedAt ms
          let updatedAtMs = 0;
          try {
            const up = d.updatedAt;
            if (up && typeof up.toMillis === 'function') updatedAtMs = up.toMillis();
            else if (typeof up === 'number') updatedAtMs = up;
          } catch { updatedAtMs = 0; }
          const isStale = updatedAtMs && (now - updatedAtMs > this.presenceStaleMs);
          if (isStale) return; // hide stale users (>10m)
          this.otherUsers.set(d.uid, {
            uid: d.uid,
            x: typeof d.x === 'number' ? d.x : 0,
            y: typeof d.y === 'number' ? d.y : 0,
            radius: typeof d.radius === 'number' ? d.radius : 15,
            nickname: d.nickname || 'Guest',
            bubble: d.bubble && d.bubble.text ? String(d.bubble.text) : null,
          });
        });
      });
    } catch { }
  }

  unsubscribeUsers() {
    try { if (this._usersUnsub) this._usersUnsub(); } catch { }
    this._usersUnsub = null;
  }

  drawOtherUsers() {
    if (!this.otherUsers || this.otherUsers.size === 0) return;
    for (const [, u] of this.otherUsers) {
      this.drawOneAvatar(u.x, u.y, u.radius, u.nickname, u.bubble);
    }
  }

  drawOneAvatar(cx, cy, r, label, bubbleText = null) {
    this.ctx.save();
    const grad = this.ctx.createLinearGradient(0, cy + r, 0, cy - r);
    grad.addColorStop(0.0, '#ffffff');
    grad.addColorStop(1.0, '#000000');
    this.ctx.beginPath();
    this.ctx.arc(cx, cy, r, 0, Math.PI * 2);
    this.ctx.closePath();
    this.ctx.fillStyle = grad;
    this.ctx.fill();
    this.ctx.save();
    this.ctx.beginPath();
    this.ctx.arc(cx, cy, r, 0, Math.PI, false);
    this.ctx.closePath();
    this.ctx.clip();
    const prevFilter = this.ctx.filter || 'none';
    this.ctx.filter = 'blur(2px)';
    this.ctx.beginPath();
    this.ctx.arc(cx, cy, r, 0, Math.PI * 2);
    this.ctx.closePath();
    this.ctx.fillStyle = grad;
    this.ctx.fill();
    this.ctx.filter = prevFilter;
    this.ctx.restore();
    this.ctx.font = '12px Arial';
    this.ctx.textAlign = 'center';
    this.ctx.textBaseline = 'top';
    this.ctx.fillStyle = 'rgba(0,0,0,0.85)';
    this.ctx.fillText(label || 'Guest', cx, cy + r + 8);

    if (bubbleText) {
      const paddingX = 10;
      const paddingY = 6;
      const maxWidth = 240;
      const font = '12px Arial';
      this.ctx.save();
      this.ctx.font = font;
      this.ctx.textAlign = 'center';
      this.ctx.textBaseline = 'middle';
      let display = String(bubbleText);
      let metrics = this.ctx.measureText(display);
      while (metrics.width > (maxWidth - paddingX * 2) && display.length > 1) {
        display = display.slice(0, -1);
        metrics = this.ctx.measureText(display + '…');
        if (metrics.width <= (maxWidth - paddingX * 2)) { display = display + '…'; break; }
      }
      const boxW = Math.min(maxWidth, Math.max(32, metrics.width + paddingX * 2));
      const boxH = Math.max(22, 12 + paddingY * 2);
      const bx = cx - boxW / 2;
      const by = cy - r - 10 - boxH;
      const radius = 8;
      this.ctx.beginPath();
      this.roundRectPath(bx, by, boxW, boxH, radius);
      this.ctx.fillStyle = 'rgba(255,255,255,0.92)';
      this.ctx.fill();
      this.ctx.lineWidth = 1;
      this.ctx.strokeStyle = 'rgba(0,0,0,0.2)';
      this.ctx.stroke();
      this.ctx.fillStyle = 'rgba(0,0,0,0.9)';
      this.ctx.fillText(display, cx, by + boxH / 2);
      this.ctx.restore();
    }
    this.ctx.restore();
  }

  drawUserAvatar() {
    const a = this.userAvatar;
    if (!a) return;
    const t = (performance.now ? performance.now() : Date.now()) / 1000;
    const bob = Math.sin(t * 2 + (a.bobPhase || 0)) * (a.bobAmp || 0);
    const cx = a.x;
    const cy = a.y + bob;
    const r = a.radius;

    this.ctx.save();
    // Base gradient fill (white at bottom -> black at top)
    const grad = this.ctx.createLinearGradient(0, cy + r, 0, cy - r);
    grad.addColorStop(0.0, '#ffffff');
    grad.addColorStop(1.0, '#000000');

    // Draw full ball
    this.ctx.beginPath();
    this.ctx.arc(cx, cy, r, 0, Math.PI * 2);
    this.ctx.closePath();
    this.ctx.fillStyle = grad;
    this.ctx.fill();

    // Underwater half: subtle blur on lower semicircle to suggest submersion
    this.ctx.save();
    this.ctx.beginPath();
    this.ctx.arc(cx, cy, r, 0, Math.PI, false); // bottom half (0 to π)
    this.ctx.closePath();
    this.ctx.clip();
    const prevFilter = this.ctx.filter || 'none';
    this.ctx.filter = 'blur(2px)';
    // redraw gradient within clipped region
    this.ctx.beginPath();
    this.ctx.arc(cx, cy, r, 0, Math.PI * 2);
    this.ctx.closePath();
    this.ctx.fillStyle = grad;
    this.ctx.fill();
    this.ctx.filter = prevFilter;
    this.ctx.restore();

    // Username below the ball
    const label = this.currentNickname || 'Guest';
    this.ctx.font = '12px Arial';
    this.ctx.textAlign = 'center';
    this.ctx.textBaseline = 'top';
    this.ctx.fillStyle = 'rgba(0,0,0,0.85)';
    this.ctx.fillText(label, cx, cy + r + 8);

    this.ctx.restore();
  }

  drawAvatarBubble() {
    if (!this.userAvatar || !this.avatarBubble) return;
    const a = this.userAvatar;
    const b = this.avatarBubble;
    if (!b.opacity || b.opacity <= 0) return;
    const tsec = (performance.now ? performance.now() : Date.now()) / 1000;
    const bob = Math.sin(tsec * 2 + (a.bobPhase || 0)) * (a.bobAmp || 0);
    const cx = a.x;
    const cy = a.y + bob;
    const r = a.radius;

    const paddingX = 10;
    const paddingY = 6;
    const maxWidth = 240;
    const font = '12px Arial';
    this.ctx.save();
    this.ctx.globalAlpha = Math.max(0, Math.min(1, b.opacity));
    this.ctx.font = font;
    this.ctx.textAlign = 'center';
    this.ctx.textBaseline = 'middle';
    let text = String(b.text || '');
    // simple clamp: if too wide, truncate with ellipsis
    let display = text;
    let metrics = this.ctx.measureText(display);
    while (metrics.width > (maxWidth - paddingX * 2) && display.length > 1) {
      display = display.slice(0, -1);
      metrics = this.ctx.measureText(display + '…');
      if (metrics.width <= (maxWidth - paddingX * 2)) { display = display + '…'; break; }
    }
    const boxW = Math.min(maxWidth, Math.max(32, metrics.width + paddingX * 2));
    const boxH = Math.max(22, 12 + paddingY * 2);

    const bx = cx - boxW / 2;
    const by = cy - r - 10 - boxH; // above the ball
    const radius = 8;

    // rounded rect
    this.ctx.beginPath();
    this.roundRectPath(bx, by, boxW, boxH, radius);
    this.ctx.fillStyle = 'rgba(255,255,255,0.92)';
    this.ctx.fill();
    this.ctx.lineWidth = 1;
    this.ctx.strokeStyle = 'rgba(0,0,0,0.2)';
    this.ctx.stroke();

    // text
    this.ctx.fillStyle = 'rgba(0,0,0,0.9)';
    this.ctx.fillText(display, cx, by + boxH / 2);

    this.ctx.restore();
  }

  roundRectPath(x, y, w, h, r) {
    const rr = Math.min(r, w / 2, h / 2);
    this.ctx.moveTo(x + rr, y);
    this.ctx.lineTo(x + w - rr, y);
    this.ctx.quadraticCurveTo(x + w, y, x + w, y + rr);
    this.ctx.lineTo(x + w, y + h - rr);
    this.ctx.quadraticCurveTo(x + w, y + h, x + w - rr, y + h);
    this.ctx.lineTo(x + rr, y + h);
    this.ctx.quadraticCurveTo(x, y + h, x, y + h - rr);
    this.ctx.lineTo(x, y + rr);
    this.ctx.quadraticCurveTo(x, y, x + rr, y);
  }

  animate() {
    this.updateThoughts();
    this.updateAvatarMovement();
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
