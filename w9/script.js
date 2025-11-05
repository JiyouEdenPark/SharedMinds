let video;
let bodyPose;
let poses = [];
let handPoseModel;
let hands = [];
let prayerFrames = 0;
let prayerDetected = false;
let lastHandBySide = { left: null, right: null };
let bowFrames = 0;
let bowDetected = false;
const normalizeName = (n) => (n || '').replace(/_/g, '').toLowerCase();

function setup() {
  pixelDensity(1);
  createCanvas(windowWidth, windowHeight);
  video = createCapture({ video: { facingMode: 'user' }, audio: false });
  video.size(width, height);
  video.hide();

  bodyPose = ml5.bodyPose(video, { flipHorizontal: true }, () => {
    // BodyPose ready
    if (bodyPose && typeof bodyPose.detectStart === 'function') {
      bodyPose.detectStart(video, (results) => {
        poses = results || [];
      });
    }
  });

  // Initialize HandPose (supports both ml5.handpose and ml5.handPose naming)
  const initHandPose = (readyCb) => {
    if (ml5.handpose) return ml5.handpose(video, { flipHorizontal: true }, readyCb);
    if (ml5.handPose) return ml5.handPose(video, { flipHorizontal: true }, readyCb);
    return null;
  };

  handPoseModel = initHandPose(() => {
    // HandPose ready
    if (handPoseModel && typeof handPoseModel.detectStart === 'function') {
      handPoseModel.detectStart(video, (results) => {
        hands = results || [];
      });
    } 
  });

  frameRate(30);
}

function draw() {
  background(0);
  drawWebcam();
  drawSkeleton();
  drawHands();
  drawPrayerIndicator();
  updateHeadDown();
  drawHeadDownIndicator();
}

function drawSkeleton() {
  if (!poses || poses.length === 0) return;
  stroke(255);
  strokeWeight(4);
  noFill();

  const connections = [
    ['left_shoulder','right_shoulder'],
    ['left_shoulder','left_elbow'],
    ['left_elbow','left_wrist'],
    ['right_shoulder','right_elbow'],
    ['right_elbow','right_wrist'],
    ['left_hip','right_hip'],
    ['left_shoulder','left_hip'],
    ['right_shoulder','right_hip'],
    ['left_hip','left_knee'],
    ['left_knee','left_ankle'],
    ['right_hip','right_knee'],
    ['right_knee','right_ankle'],
    ['nose','left_eye'],
    ['nose','right_eye'],
    ['left_eye','left_ear'],
    ['right_eye','right_ear']
  ].map(([a,b]) => [normalizeName(a), normalizeName(b)]);

  for (let i = 0; i < poses.length; i++) {
    const kpList = poses[i].keypoints || [];
    const map = {};
    for (let k = 0; k < kpList.length; k++) {
      const kp = kpList[k];
      const raw = (kp.name || kp.part || '');
      const key = normalizeName(raw);
      const x = kp.x != null ? kp.x : (kp.position ? kp.position.x : null);
      const y = kp.y != null ? kp.y : (kp.position ? kp.position.y : null);
      const s = kp.confidence != null ? kp.confidence : (kp.score != null ? kp.score : 1);
      if (x == null || y == null) continue;
      map[key] = { x, y, confidence: s };
    }
    for (let c = 0; c < connections.length; c++) {
      const a = map[normalizeName(connections[c][0])];
      const b = map[normalizeName(connections[c][1])];
      if (!a || !b) continue;
      const sa = a.score != null ? a.score : a.confidence;
      const sb = b.score != null ? b.score : b.confidence;
      if ((sa != null && sa < 0.2) || (sb != null && sb < 0.2)) continue;
      line(a.x, a.y, b.x, b.y);
    }
  }
}

function drawWebcam() {
  if (!video) return;
  push();
  translate(width, 0);
  scale(-1, 1);
  image(video, 0, 0, width, height);
  pop();
}

function windowResized() {
  resizeCanvas(windowWidth, windowHeight);
  if (video) {
    video.size(width, height);
  }
}

function drawHands() {
  const pair = selectTopTwoHands(hands || []);
  const maps = [];
  if (pair) {
    maps.push(pair[0]);
    maps.push(pair[1]);
  } else {
    // Try to draw a single best hand
    const entries = [];
    for (let i = 0; i < (hands ? hands.length : 0); i++) {
      const map = getHandMap(hands[i]);
      let sum = 0, cnt = 0;
      for (const k in map) { sum += map[k].confidence || 0; cnt++; }
      const score = cnt > 0 ? sum / cnt : 0;
      entries.push({ score, map });
    }
    entries.sort((a, b) => b.score - a.score);
    if (entries.length > 0) {
      maps.push(entries[0].map);
    } else {
      // Fallback to recent memory (most recent side)
      const now = Date.now();
      const PERSIST_MS = 400;
      let cand = null; let t = -1;
      if (lastHandBySide.left && (now - lastHandBySide.left.time) <= PERSIST_MS) { cand = lastHandBySide.left.map; t = lastHandBySide.left.time; }
      if (lastHandBySide.right && (now - lastHandBySide.right.time) <= PERSIST_MS && lastHandBySide.right.time > t) { cand = lastHandBySide.right.map; }
      if (cand) maps.push(cand);
    }
    if (maps.length === 0) return;
  }
  stroke(255);
  strokeWeight(2);
  noFill();

  const fingerChains = [
    ['wrist','thumb_cmc','thumb_mcp','thumb_ip','thumb_tip'],
    ['wrist','index_finger_mcp','index_finger_pip','index_finger_dip','index_finger_tip'],
    ['wrist','middle_finger_mcp','middle_finger_pip','middle_finger_dip','middle_finger_tip'],
    ['wrist','ring_finger_mcp','ring_finger_pip','ring_finger_dip','ring_finger_tip'],
    ['wrist','pinky_finger_mcp','pinky_finger_pip','pinky_finger_dip','pinky_finger_tip']
  ];
  const palmChain = ['thumb_cmc','index_finger_mcp','middle_finger_mcp','ring_finger_mcp','pinky_finger_mcp'];

  for (let m = 0; m < maps.length; m++) {
    const map = maps[m] || {};
    // draw finger chains
    for (let f = 0; f < fingerChains.length; f++) {
      const chain = fingerChains[f];
      for (let j = 0; j < chain.length - 1; j++) {
        const a = map[normalizeName(chain[j])];
        const b = map[normalizeName(chain[j + 1])];
        if (!a || !b) continue;
        const sa = a.confidence != null ? a.confidence : 1;
        const sb = b.confidence != null ? b.confidence : 1;
        if (sa < 0.2 || sb < 0.2) continue;
        line(a.x, a.y, b.x, b.y);
      }
    }
    // draw palm chain
    for (let j = 0; j < palmChain.length - 1; j++) {
      const a = map[normalizeName(palmChain[j])];
      const b = map[normalizeName(palmChain[j + 1])];
      if (!a || !b) continue;
      const sa = a.confidence != null ? a.confidence : 1;
      const sb = b.confidence != null ? b.confidence : 1;
      if (sa < 0.2 || sb < 0.2) continue;
      line(a.x, a.y, b.x, b.y);
    }
  }
}

// Prayer pose detection (hands together)
function getHandMap(hand) {
  const keypoints = Array.isArray(hand && hand.keypoints) ? hand.keypoints : [];
  const map = {};
  for (let i = 0; i < keypoints.length; i++) {
    const kp = keypoints[i];
    const key = normalizeName(kp.name || '');
    if (!key) continue;
    const s = kp.confidence != null ? kp.confidence : 1;
    map[key] = { x: kp.x, y: kp.y, confidence: s };
  }
  return map;
}

function computePalmCenter(map) {
  const names = ['wrist','thumb_cmc','index_finger_mcp','middle_finger_mcp','ring_finger_mcp','pinky_finger_mcp'];
  let sumX = 0, sumY = 0, n = 0;
  for (let i = 0; i < names.length; i++) {
    const p = map[normalizeName(names[i])];
    if (p && p.confidence >= 0.2) { sumX += p.x; sumY += p.y; n++; }
  }
  if (n === 0) return null;
  return { x: sumX / n, y: sumY / n };
}

function areMapsClose(leftMap, rightMap) {
  if (!leftMap || !rightMap) return false;
  const ca = computePalmCenter(leftMap);
  const cb = computePalmCenter(rightMap);
  if (!ca || !cb) return false;
  const dx = ca.x - cb.x;
  const dy = ca.y - cb.y;
  const dist = Math.sqrt(dx*dx + dy*dy);
  const threshold = Math.min(width, height) * 0.10;
  return dist < threshold;
}

function selectTopTwoHands(allHands) {
  const now = Date.now();
  const entries = [];
  for (let i = 0; i < allHands.length; i++) {
    const hand = allHands[i];
    const map = getHandMap(hand);
    let sum = 0, cnt = 0;
    for (const k in map) { sum += map[k].confidence || 0; cnt++; }
    const score = cnt > 0 ? sum / cnt : 0;
    const sideRaw = (hand.handedness || hand.handednessLabel || '').toString().toLowerCase();
    const side = sideRaw === 'left' || sideRaw === 'right' ? sideRaw : null;
    entries.push({ score, map, side });
  }
  entries.sort((a, b) => b.score - a.score);

  // Update memory per side
  for (let i = 0; i < entries.length; i++) {
    const e = entries[i];
    if (e.side === 'left') lastHandBySide.left = { map: e.map, time: now };
    if (e.side === 'right') lastHandBySide.right = { map: e.map, time: now };
  }

  const PERSIST_MS = 400;
  const result = { left: null, right: null };

  // Prefer current detections by side
  for (let i = 0; i < entries.length; i++) {
    const e = entries[i];
    if (e.side === 'left' && !result.left) result.left = e.map;
    if (e.side === 'right' && !result.right) result.right = e.map;
  }

  // If both last hands are close, allow indefinite persistence while close
  const closePersist = lastHandBySide.left && lastHandBySide.right && areMapsClose(lastHandBySide.left.map, lastHandBySide.right.map);
  if (closePersist) {
    if (!result.left && lastHandBySide.left) result.left = lastHandBySide.left.map;
    if (!result.right && lastHandBySide.right) result.right = lastHandBySide.right.map;
  }

  // Backfill missing side from memory (time-limited unless closePersist)
  if (!result.left && lastHandBySide.left && (closePersist || (now - lastHandBySide.left.time <= PERSIST_MS))) {
    result.left = lastHandBySide.left.map;
  }
  if (!result.right && lastHandBySide.right && (closePersist || (now - lastHandBySide.right.time <= PERSIST_MS))) {
    result.right = lastHandBySide.right.map;
  }

  // If still missing any side, we cannot confidently supply; return null
  if (!result.left || !result.right) return null;
  return [result.left, result.right];
}

function isPrayerPose() {
  const pair = selectTopTwoHands(hands || []);
  if (pair) {
    const a = pair[0];
    const b = pair[1];
    const ca = computePalmCenter(a);
    const cb = computePalmCenter(b);
    if (ca && cb) {
      const comps = ['wrist','thumb_cmc','index_finger_mcp','middle_finger_mcp','ring_finger_mcp','pinky_finger_mcp'];
      let sum = 0, n = 0;
      for (let i = 0; i < comps.length; i++) {
        const pa = a[normalizeName(comps[i])];
        const pb = b[normalizeName(comps[i])];
        if (pa && pb) {
          const dx = pa.x - pb.x;
          const dy = pa.y - pb.y;
          sum += Math.sqrt(dx*dx + dy*dy);
          n++;
        }
      }
      if (n >= 3) {
        const avgDist = sum / n;
        const threshold = Math.min(width, height) * 0.10;
        const centerDy = Math.abs(ca.y - cb.y);
        const verticalThreshold = Math.min(width, height) * 0.08;
        if ((avgDist < threshold) && (centerDy < verticalThreshold)) return true;
      }
    }
  }
  const wrists = getBodyWrists();
  if (wrists && wrists.left && wrists.right) {
    const dx = wrists.left.x - wrists.right.x;
    const dy = wrists.left.y - wrists.right.y;
    const dist = Math.sqrt(dx*dx + dy*dy);
    const wristThresh = Math.min(width, height) * 0.08;
    return dist < wristThresh;
  }
  return false;
}

function getBodyWrists() {
  if (!poses || poses.length === 0) return null;
  const kp = poses[0].keypoints || [];
  const map = {};
  for (let i = 0; i < kp.length; i++) {
    const k = kp[i];
    const name = normalizeName(k.name || k.part || '');
    const x = k.x != null ? k.x : (k.position ? k.position.x : null);
    const y = k.y != null ? k.y : (k.position ? k.position.y : null);
    const s = k.confidence != null ? k.confidence : (k.score != null ? k.score : 1);
    if (x == null || y == null) continue;
    map[name] = { x, y, confidence: s };
  }
  return { left: map['leftwrist'], right: map['rightwrist'] };
}

function isHeadDown() {
  const map = getBodyMap();
  if (!map) return false;
  const ls = map['leftshoulder'];
  const rs = map['rightshoulder'];
  const lh = map['lefthip'];
  const rh = map['righthip'];
  const nose = map['nose'];
  if (!ls || !rs || !nose) return false;
  const sCx = (ls.x + rs.x) / 2;
  const sCy = (ls.y + rs.y) / 2;
  let torsoLen = 0;
  if (lh && rh) {
    const hCx = (lh.x + rh.x) / 2;
    const hCy = (lh.y + rh.y) / 2;
    const dx = sCx - hCx;
    const dy = sCy - hCy;
    torsoLen = Math.sqrt(dx*dx + dy*dy);
  } else {
    torsoLen = Math.min(width, height) * 0.3;
  }
  const verticalDelta = nose.y - sCy;
  const threshold = torsoLen * 0.25;
  const lateralOffset = Math.abs(nose.x - sCx);
  const lateralLimit = Math.abs(rs.x - ls.x) * 0.6;
  return (verticalDelta > threshold) && (lateralOffset < lateralLimit);
}

function updateHeadDown() {
  if (isHeadDown()) {
    bowFrames = Math.min(bowFrames + 1, 20);
  } else {
    bowFrames = Math.max(bowFrames - 1, 0);
  }
  bowDetected = bowFrames >= 5;
}

function drawHeadDownIndicator() {
  if (!bowDetected) return;
  console.log("bow detected");
  push();
  noFill();
  stroke(0, 150, 255);
  strokeWeight(3);
  const x0 = width - 80;
  const y0 = 16;
  line(x0, y0, x0 + 40, y0);
  line(x0 + 40, y0, x0 + 40, y0 + 40);
  noStroke();
  fill(0, 150, 255);
  textSize(16);
  text('BOW', x0 - 4, y0 + 28);
  pop();
}

function getBodyMap() {
  if (!poses || poses.length === 0) return null;
  const kp = poses[0].keypoints || [];
  const map = {};
  for (let i = 0; i < kp.length; i++) {
    const k = kp[i];
    const name = normalizeName(k.name || k.part || '');
    const x = k.x != null ? k.x : (k.position ? k.position.x : null);
    const y = k.y != null ? k.y : (k.position ? k.position.y : null);
    const s = k.confidence != null ? k.confidence : (k.score != null ? k.score : 1);
    if (x == null || y == null) continue;
    map[name] = { x, y, confidence: s };
  }
  return map;
}

function drawPrayerIndicator() {
  if (!isPrayerPose()) return;
  console.log('prayer pose detected');
  push();
  noFill();
  stroke(0, 255, 0);
  strokeWeight(3);
  // small indicator at top-left
  line(16, 16, 56, 16);
  line(16, 16, 16, 56);
  // label
  noStroke();
  fill(0, 255, 0);
  textSize(16);
  text('PRAYER', 24, 40);
  pop();
}