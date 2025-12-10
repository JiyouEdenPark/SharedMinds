import Renderer from 'renderer';
import { schedule, anchorFromK, makeStreamingChain, createBlendFramesScaled, robustScaleRatio } from './util/segments-utils.js';
import { PoseWebSocketClient, updateImageElement } from './util/pose-websocket.js';

// State
let renderer = null;
let overlay = null;
let bgImageEl = null;  // WebSocket 이미지용
let stageW = 0;
let stageH = 0;
let bgVisible = true;
let poseWsClient = null;

// Segments playback state
let segments = null;        // parsed JSON of segments_final.json (expects {segments:[...]} or list)
let windowsIndex = null;    // windows index for accurate frame stitching
let jsonlMap = {};          // map basename -> frames array
let playbackFrames = [];    // synthesized frames from segments (items with {width,height,kpts})
let playIdx = 0;
let playing = false;
let playTimer = null;
// Streaming controller
let streamCtrl = null;

// Current normalized poses
let currentSegNorm = null;
let currentLiveNorm = null;
let neutralPose = null;  // 중립포즈 (서 있는 기본 자세)

// Recording state
let isRecording = false;  // 현재 녹화 중인지 추적

// Mode: neutral -> live -> segments
// neutral: 사람이 없을 때 중립포즈 표시
// live: 사람이 감지되면 라이브 포즈 표시
// segments: 일정 시간 후 세그먼트 재생 시작
let mode = 'neutral'; // 'neutral' | 'live' | 'segments'
let lastToggleTs = 0;
// Auto-segments playback state
let personDetectedTs = null; // timestamp when person was first detected
let personLeftTs = null; // timestamp when person left (for grace period)
let segmentsStarted = false; // whether segments playback has started
const PERSON_DETECTION_DELAY_MS = 20000; // 20 seconds delay before starting segments
const PERSON_LEFT_GRACE_PERIOD_MS = 3000; // 3 seconds grace period before stopping
let autoCheckTimer = null; // timer for checking person presence
// Streaming buffer configuration
const BLEND_N = 8;
const BUFFER_LOW = 60;//240;       // frames; when remaining drops below this, append more
const BUFFER_TARGET = 120;//720;    // frames; target buffer size after topping up
const COMPACT_THRESHOLD = 1000; // frames consumed before compacting memory
const COMPACT_KEEP_PREV = 2;    // keep a couple of previous frames for timing
// Scale range and seg->live sampling config
const SCALE_MIN = 0.5;
const SCALE_MAX = 2.0;
const LIVE_SCALE_SAMPLE_N = 5;  // number of initial measurements
let liveScaleRefKpts = null;    // segment pose at switch time
let liveScaleSamples = [];      // collected ratios
let liveScaleFixed = null;      // fixed average after N samples

const statusEl = document.getElementById('status');
const toggleBtn = document.getElementById('toggleBtn');
const bgToggleBtn = document.getElementById('bgToggleBtn');

function setStatus(msg) { if (statusEl) statusEl.textContent = msg; }

// Recording functions
async function startRecording() {
    if (isRecording) return; // Already recording

    try {
        const response = await fetch('/websocket/toggle-recording', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({})
        });

        const result = await response.json();

        if (result.status === 'ok' && result.is_recording) {
            isRecording = true;
            console.log('Auto-recording started');
        }
    } catch (error) {
        console.error('Recording start error:', error);
    }
}

async function stopRecording() {
    if (!isRecording) return; // Not recording

    try {
        const response = await fetch('/websocket/toggle-recording', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({})
        });

        const result = await response.json();

        if (result.status === 'ok' && !result.is_recording) {
            isRecording = false;
            console.log('Auto-recording stopped');
        }
    } catch (error) {
        console.error('Recording stop error:', error);
    }
}

async function checkRecordingStatus() {
    try {
        const response = await fetch('/websocket/recording-status');
        const result = await response.json();

        if (result.status === 'ok') {
            isRecording = result.is_recording || false;
        }
    } catch (error) {
        console.error('Recording status check error:', error);
    }
}

function createNeutralPose() {
    return [
        [0.5, 0.23, 1.0],   // 0: nose (중앙 상단)
        [0.51, 0.20, 1.0],  // 1: left_eye (반전: right_eye 위치)
        [0.49, 0.20, 1.0],  // 2: right_eye (반전: left_eye 위치)
        [0.525, 0.23, 1.0],  // 3: left_ear (반전: right_ear 위치)
        [0.475, 0.23, 1.0],  // 4: right_ear (반전: left_ear 위치)
        [0.54, 0.33, 1.0],  // 5: left_shoulder (반전: right_shoulder 위치)
        [0.46, 0.33, 1.0],  // 6: right_shoulder (반전: left_shoulder 위치)
        [0.55, 0.45, 1.0],  // 7: left_elbow (반전: right_elbow 위치)
        [0.455, 0.50, 1.0],  // 8: right_elbow (반전: left_elbow 위치)
        [0.53, 0.58, 1.0],  // 9: left_wrist (반전: right_wrist 위치)
        [0.485, 0.54, 1.0],  // 10: right_wrist (반전: left_wrist 위치)
        [0.525, 0.55, 1.0],  // 11: left_hip (반전: right_hip 위치)
        [0.475, 0.55, 1.0],  // 12: right_hip (반전: left_hip 위치)
        [0.565, 0.63, 1.0],  // 13: left_knee (반전: right_knee 위치)
        [0.435, 0.63, 1.0],  // 14: right_knee (반전: left_knee 위치)
        [0.48, 0.60, 1.0],  // 15: left_ankle (반전: right_ankle 위치)
        [0.52, 0.60, 1.0],  // 16: right_ankle (반전: left_ankle 위치)
    ];
}

// 초기화 시 중립포즈 생성
function initializeNeutralPose() {
    neutralPose = createNeutralPose();
}

function checkPoseValidForPlayback(normKpts) {
    if (!normKpts || !Array.isArray(normKpts) || normKpts.length === 0) return false;

    const cw = overlay?.width || stageW || 1280;
    const ch = overlay?.height || stageH || 720;
    const MAX_HEIGHT_RATIO = 0.8; // 80% of screen height
    const MIN_CONFIDENCE = 0.2; // minimum confidence score for a keypoint to be considered valid

    // First pass: Check if ALL keypoints have sufficient confidence
    for (let i = 0; i < normKpts.length; i++) {
        const kpt = normKpts[i];
        if (!kpt || !Array.isArray(kpt) || kpt.length < 2) return false;

        const conf = kpt.length > 2 ? Number(kpt[2]) : 1.0;

        // All keypoints must have sufficient confidence
        if (conf < MIN_CONFIDENCE) {
            return false;
        }
    }

    // Second pass: Calculate y values and check bounds (only if all passed confidence check)
    let minY = Infinity;
    let maxY = -Infinity;
    let allInBounds = true;

    for (let i = 0; i < normKpts.length; i++) {
        const kpt = normKpts[i];
        const x = Number(kpt[0]);
        const y = Number(kpt[1]);

        // Check if keypoint is within normalized bounds (0-1)
        if (x < 0 || x > 1 || y < 0 || y > 1) {
            allInBounds = false;
        }

        // Convert to screen coordinates for height calculation
        const screenY = y * ch;
        minY = Math.min(minY, screenY);
        maxY = Math.max(maxY, screenY);
    }

    // Check if all keypoints are within bounds
    if (!allInBounds) return false;

    // Calculate pose height
    const poseHeight = maxY - minY;
    const maxAllowedHeight = ch * MAX_HEIGHT_RATIO;

    // Check if pose height is less than 80% of screen height
    return poseHeight < maxAllowedHeight;
}

function maybeStartAfterReady() {
    // Start playback if not already playing
    if (!playing) {
        startSegments();
    }
    // 상태 전환은 checkPersonAndControlPlayback에서 처리됨
}

function resizeRenderer() {
    const rect = document.body.getBoundingClientRect();
    stageW = Math.floor(rect.width);
    stageH = Math.floor(rect.height);
    if (!renderer) {
        renderer = new Renderer(overlay);
        renderer.initialize(stageW, stageH);
        renderer.setRenderOptions({ showKeypoints: true, showSkeleton: true, smoothing: false, interpolation: false });
    } else {
        renderer.resize(stageW, stageH);
    }
}

function normalizeKeypoints(kptsPx, sourceW, sourceH) {
    const out = new Array(17);
    for (let i = 0; i < 17; i++) {
        const p = kptsPx[i] || [0, 0, 0];
        const x = sourceW > 0 ? Number(p[0]) / sourceW : 0;
        const y = sourceH > 0 ? Number(p[1]) / sourceH : 0;
        const s = p.length > 2 ? Number(p[2]) : 1.0;
        out[i] = [x, y, s];
    }
    return out;
}


function transform(normKpts, canvasW, canvasH, scale, offsetX) {
    const targetCy = 0.5;
    const outPx = new Array(17);
    const a = anchorFromK(normKpts);
    for (let i = 0; i < 17; i++) {
        const p = normKpts[i] || [0.5, 0.5, 0];
        const nx = Math.max(0, Math.min(1, (Number(p[0]) - a[0]) + a[0]));
        const ny = Math.max(0, Math.min(1, (Number(p[1]) - a[1]) + a[1]));
        outPx[i] = [Math.round(nx * canvasW * scale) + offsetX, Math.round(ny * canvasH * scale) + targetCy, p[2]];
    }
    return outPx;
}


function renderSingle(normKpts, id = 'default') {
    if (!renderer) return;
    const cw = overlay?.width || stageW || 1280;
    const ch = overlay?.height || stageH || 720;
    const px = transform(normKpts, cw, ch, 1, 0);
    renderer.render({ id: id, kpts: px, W: cw, H: ch });
}

function renderComposite() {
    if (!renderer) return;
    if (!currentSegNorm || !currentLiveNorm) return;
    const cw = overlay?.width || stageW || 1280;
    const ch = overlay?.height || stageH || 720;
    const leftPx = transform(currentSegNorm, cw, ch, 1, 0.18);
    const rightPx = transform(currentLiveNorm, cw, ch, 1, 0);
    renderer.render({ multi: [{ id: 'seg', kpts: leftPx }, { id: 'live', kpts: rightPx }], W: cw, H: ch });
}

async function fetchSegmentsFinal() {
    // Prefer segments_final.json via auto-load endpoint for consistency
    try {
        const auto = await fetch('/segments/auto-load');
        if (!auto.ok) throw new Error('auto-load failed');
        const data = await auto.json();
        const loaded = data.loaded_files || {};
        // Build JSONL map if present
        if (loaded.jsonl && loaded.jsonl.content) {
            try {
                const content = loaded.jsonl.content;
                const lines = content.trim().split('\n');
                jsonlMap = {};
                for (const line of lines) {
                    if (!line.trim()) continue;
                    try {
                        const item = JSON.parse(line);
                        const basename = item.seq_id || 'unknown';
                        if (!jsonlMap[basename]) jsonlMap[basename] = [];
                        jsonlMap[basename].push(item);
                    } catch (e) { /* ignore */ }
                }
            } catch (e) { console.warn('JSONL parse failed', e); }
        }
        // Windows index if present
        if (loaded.windows && loaded.windows.content) {
            try { windowsIndex = JSON.parse(loaded.windows.content); }
            catch (e) { console.warn('windows_index parse failed', e); }
        }
        if (loaded.segments_final) {
            const seg = JSON.parse(loaded.segments_final.content);
            segments = seg.segments || seg;
            setStatus(`segments_final loaded (${segments.length} segments)`);
            return true;
        }
        // fallback: try representative or original
        if (loaded.segments) {
            const seg = JSON.parse(loaded.segments.content);
            segments = seg.segments || seg;
            setStatus(`segments loaded (${segments.length} segments)`);
            return true;
        }
        setStatus('segments_final not found.');
        return false;
    } catch (e) {
        console.error(e);
        setStatus('Failed to load segments');
        return false;
    }
}

function buildPlaybackFramesFromSegments() {
    // Initialize streaming buffer and controller
    playbackFrames = [];
    playIdx = 0;
    if (!Array.isArray(segments) || segments.length === 0) return;

    // Add current live pose as starting point so segments align to it
    if (currentLiveNorm && Array.isArray(currentLiveNorm) && currentLiveNorm.length === 17) {
        const w = stageW || 1280;
        const h = stageH || 720;
        playbackFrames.push({ width: w, height: h, kpts: currentLiveNorm, fps: 30 });
    }

    streamCtrl = makeStreamingChain(windowsIndex, jsonlMap, segments, {
        blendN: BLEND_N,
        bufferLow: BUFFER_LOW,
        bufferTarget: BUFFER_TARGET,
        compactThreshold: COMPACT_THRESHOLD,
        compactKeepPrev: COMPACT_KEEP_PREV,
        reorder: true,
        checkBounds: true, // Enable bounds checking for segment selection
        canvasW: stageW || 1280,
        canvasH: stageH || 720,
        maxHeightRatio: 0.8, // Same as checkPoseValidForPlayback
        minConfidence: 0.2, // Same as checkPoseValidForPlayback
    });
    streamCtrl.seed(playbackFrames);
}

function ensurePlaybackBuffer() {
    if (mode === 'live') { ensureLiveBuffer(); return; }
    if (!streamCtrl) return;

    // If playbackFrames is empty or we're transitioning from live, add current live pose as reference
    if (playbackFrames.length === 0 && currentLiveNorm && Array.isArray(currentLiveNorm) && currentLiveNorm.length === 17) {
        const w = stageW || 1280;
        const h = stageH || 720;
        playbackFrames.push({ width: w, height: h, kpts: currentLiveNorm, fps: 30 });
    }

    streamCtrl.ensureBuffer(playbackFrames, playIdx, stageW || 1280, stageH || 720);
}

function resetLiveScaleSampling() { liveScaleRefKpts = null; liveScaleSamples = []; liveScaleFixed = null; }

function getLiveScale(curLiveNorm, refSegKptsMaybe) {
    if (liveScaleFixed !== null) return liveScaleFixed;
    if (!liveScaleRefKpts && refSegKptsMaybe && Array.isArray(refSegKptsMaybe)) liveScaleRefKpts = refSegKptsMaybe;
    if (!liveScaleRefKpts || !Array.isArray(liveScaleRefKpts)) return 1.0;
    const r = robustScaleRatio(liveScaleRefKpts, curLiveNorm) || 1.0;
    const cr = Math.max(SCALE_MIN, Math.min(SCALE_MAX, r));
    liveScaleSamples.push(cr);
    const count = liveScaleSamples.length;
    const avg = liveScaleSamples.reduce((s, v) => s + v, 0) / count;
    if (count >= LIVE_SCALE_SAMPLE_N) liveScaleFixed = avg;
    return avg;
}


function ensureLiveBuffer() {
    const remaining = playbackFrames.length - playIdx;
    const MAX_LIVE_QUEUE = 1;
    if (remaining >= MAX_LIVE_QUEUE) return;
    if (!currentLiveNorm) return;
    const w = stageW || 1280;
    const h = stageH || 720;
    const last = playbackFrames.length ? playbackFrames[playbackFrames.length - 1] : null;
    const liveItem = { width: w, height: h, kpts: currentLiveNorm, fps: 30, live: true, ts: Date.now() };

    if (last && Array.isArray(last.kpts)) {
        // const blends = createBlendFramesScaled(last, 1.0, [0,0], liveItem, 1.0, [0,0], MAX_LIVE_QUEUE);
        // if (Array.isArray(blends) && blends.length) playbackFrames.push(...blends);
    }
    playbackFrames.push(liveItem);
}

function compactPlaybackFrames() {
    if (!streamCtrl) return;
    const res = streamCtrl.compact(playbackFrames, playIdx);
    playbackFrames = res.frames;
    playIdx = res.playIdx;
}

function stepPlayback() {
    if (!playing) return;

    // Neutral mode: 중립포즈만 표시
    // 상태 전환은 checkPersonAndControlPlayback()에서 처리됨
    if (mode === 'neutral') {
        // 블렌딩 중인지 확인 (playbackFrames에 블렌드 프레임이 있는 경우)
        if (playbackFrames.length > 0 && playIdx < playbackFrames.length) {
            // 블렌딩 중이면 playbackFrames에서 렌더링
            const cur = playbackFrames[playIdx++];
            if (cur && cur.kpts) {
                renderSingle(cur.kpts, 'neutral');
                // 블렌드 완료 확인
                if (cur.switchToNeutral === true) {
                    // 블렌드 완료, 이제 중립포즈로 전환
                    playbackFrames.length = 0;
                    playIdx = 0;
                }
            }
        } else {
            // 블렌딩 완료 후 또는 블렌딩 없이 중립포즈 렌더링
            if (neutralPose) {
                renderSingle(neutralPose, 'neutral');
            }
        }
        playTimer = setTimeout(stepPlayback, 33); // ~30fps
        return;
    }

    // Live mode: 라이브 포즈 표시
    // 상태 전환은 checkPersonAndControlPlayback()에서 처리됨
    if (mode === 'live') {
        // 블렌딩 중인지 확인 (playbackFrames에 블렌드 프레임이 있는 경우)
        if (playbackFrames.length > 0 && playIdx < playbackFrames.length) {
            // 블렌딩 중이면 playbackFrames에서 렌더링
            const cur = playbackFrames[playIdx++];
            if (cur && cur.kpts) {
                renderSingle(cur.kpts, 'live');
                // 블렌드 완료 확인
                if (cur.switchToLive === true) {
                    // 블렌드 완료, 이제 라이브 포즈로 전환
                    playbackFrames.length = 0;
                    playIdx = 0;
                } else if (cur.switchToNeutral === true) {
                    // 중립으로 전환하는 블렌드 완료
                    playbackFrames.length = 0;
                    playIdx = 0;
                }
            }
        } else {
            // 블렌딩 완료 후 또는 블렌딩 없이 라이브 포즈 렌더링
            if (currentLiveNorm) {
                renderSingle(currentLiveNorm, 'live');
            } else if (neutralPose) {
                // 포즈 데이터가 없으면 중립포즈 표시 (임시)
                renderSingle(neutralPose, 'neutral');
            }
        }
        // In Live mode, render quickly with low latency
        playTimer = setTimeout(stepPlayback, 33); // ~30fps
        return;
    }

    // Segments mode: 세그먼트 재생
    // 상태 전환은 checkPersonAndControlPlayback()에서 처리됨
    if (mode === 'segments') {
        // If no segments, fallback to live/neutral
        if (!Array.isArray(segments) || segments.length === 0) {
            if (currentLiveNorm) {
                renderSingle(currentLiveNorm, 'live');
            } else if (neutralPose) {
                renderSingle(neutralPose, 'neutral');
            }
            playTimer = setTimeout(stepPlayback, 33); // ~30fps
            return;
        }

        // Segments mode: read frames from playbackFrames and render
        if (!playbackFrames.length) {
            buildPlaybackFramesFromSegments();
            // Retry if no frames after buildPlaybackFramesFromSegments
            if (!playbackFrames.length) {
                ensurePlaybackBuffer();
            }
        }
        // Top-up buffer proactively
        ensurePlaybackBuffer();
        if (!playbackFrames.length) {
            setStatus('No segment frames to play. Please check segments.');
            playTimer = setTimeout(stepPlayback, 100); // Retry after a moment
            return;
        }
        if (playIdx >= playbackFrames.length) {
            // If we ever catch up to the buffer end, try topping up again
            ensurePlaybackBuffer();
            if (playIdx >= playbackFrames.length) {
                // Still no frames; pause briefly and retry
                playTimer = setTimeout(stepPlayback, 16);
                return;
            }
        }
        const cur = playbackFrames[playIdx++];
        // update current segment normalized pose
        currentSegNorm = cur.kpts || null;
        renderSingle(cur.kpts, 'seg');

        // Check if this frame marks the switch to live mode (after blend completes)
        // 상태 전환은 checkPersonAndControlPlayback()에서 처리되지만,
        // 블렌드 완료 시점은 여기서 확인
        if (cur && cur.switchToLive === true) {
            // 블렌드 완료 후 상태는 checkPersonAndControlPlayback()이 처리함
            // 여기서는 단순히 상태만 업데이트
            mode = 'live';
            setStatus(`Mode: ${mode}`);
        }

        // Check if this frame marks the switch to neutral mode (after blend completes)
        if (cur && cur.switchToNeutral === true) {
            // 블렌드 완료 후 neutral 모드로 전환
            mode = 'neutral';
            stopSegments();
            setStatus(`Mode: ${mode}`);
        }

        const prev = playIdx > 1 ? playbackFrames[playIdx - 2] : null; // since playIdx was incremented
        let delay = schedule(prev, cur, 1.0);
        if (cur && cur.live === true) delay = 0; // minimize latency for live frames
        compactPlaybackFrames();
        playTimer = setTimeout(stepPlayback, Math.max(0, Math.floor(delay * 1000)));
        return;
    }

    // If no segments, render only live pose (fallback)
    if (!Array.isArray(segments) || segments.length === 0) {
        if (mode === 'live' && currentLiveNorm) {
            renderSingle(currentLiveNorm, 'live');
        } else if (neutralPose) {
            renderSingle(neutralPose, 'neutral');
        }
        playTimer = setTimeout(stepPlayback, 33); // ~30fps
        return;
    }
}

function startSegments() {
    if (playing) return;
    playing = true;
    stepPlayback();
}

function stopSegments() {
    playing = false;
    if (playTimer) { clearTimeout(playTimer); playTimer = null; }
}

function toggleMode() {
    const now = Date.now();
    if (now - lastToggleTs < 500) return;
    lastToggleTs = now;

    if (mode === 'neutral') {
        // Neutral -> Live: 사람이 있으면 live로, 없으면 그대로
        if (currentLiveNorm && checkPoseValidForPlayback(currentLiveNorm)) {
            mode = 'live';
            personDetectedTs = Date.now();
            segmentsStarted = false;
            // Start recording when manually switching to live mode
            startRecording();
            if (!playing) {
                startSegments();
            }
            setStatus('Mode: live - Manual switch');
        } else {
            setStatus('No valid person detected. Cannot switch to live mode.');
        }
    } else if (mode === 'live') {
        // Live -> Segments: 수동으로 segments 모드로 전환
        if (!currentLiveNorm) {
            setStatus('No live pose available. Cannot switch to segments mode.');
            return;
        }

        const isValid = checkPoseValidForPlayback(currentLiveNorm);
        if (!isValid) {
            setStatus('Pose invalid - cannot start segments playback (height must be < 80% of screen, all keypoints visible)');
            return;
        }

        // Pose is valid, switch to segments mode
        mode = 'segments';
        // Reset sampling so the next seg->live will recompute
        resetLiveScaleSampling();
        if (streamCtrl) {
            streamCtrl.resetPrev();
        }

        // Stop recording when manually switching to segments mode
        stopRecording();

        // Blend smoothly from live to segments
        blendToSegmentsNow();

        // Start segments playback if not already playing
        if (!playing) {
            startSegments();
        }

        setStatus(`Mode: ${mode} - Manual switch to segments`);
    } else if (mode === 'segments') {
        // Segments -> Live: 라이브 모드로 전환
        blendToLiveNow();
        mode = 'live';
        // Start recording when switching back to live mode
        startRecording();
        setStatus('Mode: live - Manual switch from segments');
    }
}

let autoToggleTimer = null;
function autoToggleLoop() {
    // Clear old timer if exists
    if (autoToggleTimer) { clearInterval(autoToggleTimer); autoToggleTimer = null; }
    if (autoCheckTimer) { clearInterval(autoCheckTimer); autoCheckTimer = null; }

    // Check person presence periodically (every 500ms)
    autoCheckTimer = setInterval(() => {
        checkPersonAndControlPlayback();
    }, 500);
}

function checkPersonAndControlPlayback() {
    const hasValidPerson = currentLiveNorm && checkPoseValidForPlayback(currentLiveNorm);

    if (hasValidPerson) {
        // Person is present and valid - reset grace period if it was active
        if (personLeftTs !== null) {
            personLeftTs = null; // Cancel grace period
        }

        // Neutral -> Live: 사람이 감지되면 live 모드로 전환
        if (mode === 'neutral') {
            // Blend from neutral to live
            blendToLiveFromNeutral();
            mode = 'live';
            personDetectedTs = Date.now();
            segmentsStarted = false;
            setStatus('Mode: live - Person detected (blending...)');
            // Start recording when entering live mode
            startRecording();
            if (!playing) {
                startSegments(); // 재생 시작 (live 모드로 렌더링)
            }
            return;
        }

        // Live -> Segments: 일정 시간 후 segments 모드로 전환
        if (mode === 'live') {
            if (personDetectedTs === null) {
                personDetectedTs = Date.now();
                segmentsStarted = false;
            } else {
                const elapsed = Date.now() - personDetectedTs;
                if (!segmentsStarted && elapsed >= PERSON_DETECTION_DELAY_MS) {
                    // 2초 후 segments 모드로 전환
                    mode = 'segments';
                    resetLiveScaleSampling();
                    if (streamCtrl) {
                        streamCtrl.resetPrev();
                    }
                    // Stop recording when switching to segments mode
                    stopRecording();
                    // Blend smoothly from live to segments
                    blendToSegmentsNow();
                    if (!playing) {
                        startSegments();
                    }
                    segmentsStarted = true;
                    setStatus('Mode: segments - Playback started');
                }
            }
            return;
        }

        // Segments 모드: 사람이 있으면 계속 재생
        if (mode === 'segments') {
            if (!playing) {
                startSegments();
            }
            return;
        }
    } else {
        // Person is not present or invalid
        // Segments -> Neutral: 사람이 사라지면 중립으로 전환
        if (mode === 'segments') {
            if (personLeftTs === null) {
                personLeftTs = Date.now();
                setStatus('Person left. Stopping in 3 seconds...');
            } else {
                // Check if grace period has passed
                const elapsed = Date.now() - personLeftTs;
                if (elapsed >= PERSON_LEFT_GRACE_PERIOD_MS) {
                    // Grace period passed, blend to neutral
                    blendToNeutralFromSegments();
                    personDetectedTs = null;
                    personLeftTs = null;
                    segmentsStarted = false;
                    // Don't stop segments immediately - let blend complete
                    mode = 'neutral';
                    // Stop recording when leaving segments mode (going to neutral)
                    stopRecording();
                    setStatus('Mode: neutral - Person left (blending...)');
                }
            }
            return;
        }

        // Live -> Neutral: 사람이 사라지면 중립으로 전환
        if (mode === 'live') {
            // Blend from live to neutral
            blendToNeutralFromLive();
            mode = 'neutral';
            personDetectedTs = null;
            personLeftTs = null;
            segmentsStarted = false;
            // Stop recording when leaving live mode
            stopRecording();
            setStatus('Mode: neutral - Person left (blending...)');
            return;
        }

        // Neutral 모드: 이미 중립이면 그대로 유지
        if (mode === 'neutral') {
            // Reset timers
            personDetectedTs = null;
            personLeftTs = null;
            segmentsStarted = false;
            return;
        }
    }
}

function blendToLiveNow() {
    try {
        if (!currentLiveNorm) return;
        // Determine current on-screen pose (prefer last rendered segment pose)
        const curKpts = (currentSegNorm && Array.isArray(currentSegNorm))
            ? currentSegNorm
            : (playIdx > 0 && playbackFrames[playIdx - 1] && Array.isArray(playbackFrames[playIdx - 1].kpts))
                ? playbackFrames[playIdx - 1].kpts
                : null;
        if (!curKpts) return;

        // Validate keypoints
        if (!Array.isArray(curKpts) || curKpts.length !== 17) return;
        if (!Array.isArray(currentLiveNorm) || currentLiveNorm.length !== 17) return;

        // Start a new sampling session and set reference pose
        resetLiveScaleSampling();
        liveScaleRefKpts = curKpts;
        const w = stageW || 1280;
        const h = stageH || 720;
        const prevItem = { width: w, height: h, kpts: curKpts, fps: 30 };
        const liveItem = { width: w, height: h, kpts: currentLiveNorm, fps: 30, switchToLive: true }; // Mark to switch to live after this frame
        const blends = createBlendFramesScaled(prevItem, 1.0, [0, 0], liveItem, 1.0, [0, 0], BLEND_N) || [];
        const removedCount = playbackFrames.length - playIdx;
        playbackFrames.splice(playIdx, removedCount, ...blends, liveItem);
    } catch (e) { /* ignore */ }
}

function blendToLiveFromNeutral() {
    try {
        if (!currentLiveNorm || !neutralPose) return;

        // Validate keypoints
        if (!Array.isArray(neutralPose) || neutralPose.length !== 17) return;
        if (!Array.isArray(currentLiveNorm) || currentLiveNorm.length !== 17) return;

        const w = stageW || 1280;
        const h = stageH || 720;
        const neutralItem = { width: w, height: h, kpts: neutralPose, fps: 30 };
        const liveItem = { width: w, height: h, kpts: currentLiveNorm, fps: 30, switchToLive: true };
        const blends = createBlendFramesScaled(neutralItem, 1.0, [0, 0], liveItem, 1.0, [0, 0], BLEND_N * 2) || [];

        // Clear playbackFrames and add blend frames
        playbackFrames.length = 0;
        playIdx = 0;
        playbackFrames.push(...blends, liveItem);
    } catch (e) { /* ignore */ }
}

function blendToNeutralFromSegments() {
    try {
        if (!neutralPose) return;

        // Determine current on-screen pose (prefer last rendered segment pose)
        const curKpts = (currentSegNorm && Array.isArray(currentSegNorm))
            ? currentSegNorm
            : (playIdx > 0 && playbackFrames[playIdx - 1] && Array.isArray(playbackFrames[playIdx - 1].kpts))
                ? playbackFrames[playIdx - 1].kpts
                : null;
        if (!curKpts) return;

        // Validate keypoints
        if (!Array.isArray(curKpts) || curKpts.length !== 17) return;
        if (!Array.isArray(neutralPose) || neutralPose.length !== 17) return;

        const w = stageW || 1280;
        const h = stageH || 720;
        const segItem = { width: w, height: h, kpts: curKpts, fps: 30 };
        const neutralItem = { width: w, height: h, kpts: neutralPose, fps: 30, switchToNeutral: true };
        const blends = createBlendFramesScaled(segItem, 1.0, [0, 0], neutralItem, 1.0, [0, 0], BLEND_N * 2) || [];

        // Insert blend frames at current position
        const removedCount = playbackFrames.length - playIdx;
        playbackFrames.splice(playIdx, removedCount, ...blends, neutralItem);
    } catch (e) { /* ignore */ }
}

function blendToNeutralFromLive() {
    try {
        if (!currentLiveNorm || !neutralPose) return;

        // Validate keypoints
        if (!Array.isArray(currentLiveNorm) || currentLiveNorm.length !== 17) return;
        if (!Array.isArray(neutralPose) || neutralPose.length !== 17) return;

        const w = stageW || 1280;
        const h = stageH || 720;
        const liveItem = { width: w, height: h, kpts: currentLiveNorm, fps: 30 };
        const neutralItem = { width: w, height: h, kpts: neutralPose, fps: 30, switchToNeutral: true };
        const blends = createBlendFramesScaled(liveItem, 1.0, [0, 0], neutralItem, 1.0, [0, 0], BLEND_N) || [];

        // Clear playbackFrames and add blend frames
        playbackFrames.length = 0;
        playIdx = 0;
        playbackFrames.push(...blends, neutralItem);
    } catch (e) { /* ignore */ }
}

function blendToSegmentsNow() {
    try {
        if (!currentLiveNorm) return;
        // Get current live pose as starting point
        const liveKpts = currentLiveNorm;

        // Get the first segment frame to blend to
        if (!playbackFrames.length) {
            buildPlaybackFramesFromSegments();
            if (!playbackFrames.length) {
                ensurePlaybackBuffer();
            }
        }

        if (!playbackFrames.length) return;

        // Get the first segment frame
        const firstSegFrame = playbackFrames[0];
        if (!firstSegFrame || !Array.isArray(firstSegFrame.kpts)) return;

        const w = stageW || 1280;
        const h = stageH || 720;
        const liveItem = { width: w, height: h, kpts: liveKpts, fps: 30 };
        const segItem = { width: w, height: h, kpts: firstSegFrame.kpts, fps: 30 };

        // Create blend frames from live to first segment
        const blends = createBlendFramesScaled(liveItem, 1.0, [0, 0], segItem, 1.0, [0, 0], BLEND_N) || [];

        // Insert blend frames at the beginning of playbackFrames
        playbackFrames.unshift(...blends);
        playIdx = 0; // Reset play index to start from blends
    } catch (e) { /* ignore */ }
}

function initPoseWebSocket() {
    if (poseWsClient) return;

    // Initialize bgImageEl
    if (!bgImageEl) {
        bgImageEl = document.getElementById('bgImage');
    }

    poseWsClient = new PoseWebSocketClient({
        onOpen: () => {
            console.log('Pose data WebSocket connected');
        },
        onFrame: (data) => {
            // Process video frame reception
            if (bgImageEl && data.frame) {
                updateImageElement(data, bgImageEl, bgVisible);
            }
        },
        onKpts: (data) => {
            // Process pose data reception
            if (data.kpts) {
                currentLiveNorm = normalizeKeypoints(data.kpts, data.W, data.H);
                // In WebSocket mode, render immediately even without segments
                if (!playing && currentLiveNorm) {
                    if (Array.isArray(segments) && segments.length > 0) {
                        // Start playback if segments are available
                        maybeStartAfterReady();
                    } else {
                        // Render immediately if no segments
                        if (!playing) {
                            startSegments();
                        }
                        // Render current pose immediately if valid, otherwise show neutral pose
                        if (currentLiveNorm && renderer) {
                            if (checkPoseValidForPlayback(currentLiveNorm)) {
                                renderSingle(currentLiveNorm, 'live');
                            } else if (neutralPose) {
                                renderSingle(neutralPose, 'neutral');
                            }
                        }
                    }
                }
                // If playing is true and mode is live, it will be automatically rendered in stepPlayback
            } else {
                // 포즈 데이터가 없으면 중립포즈로 설정 (사람이 없음)
                currentLiveNorm = null;
            }
        },
        onMessage: (data) => {
            // Case where only frame exists (no pose data)
            if (data.type === 'frame' && !data.kpts) {
                maybeStartAfterReady();
            } else if (data.type !== 'frame' && data.type !== 'frame_kpts' && data.type !== 'kpts') {
                console.log('Message received from pose WebSocket:', data);
            }
        }
    });

    poseWsClient.connect();
}

async function startAll() {
    overlay = document.getElementById('overlay');
    bgImageEl = document.getElementById('bgImage');  // WebSocket 이미지용
    resizeRenderer();
    window.addEventListener('resize', resizeRenderer);

    // Initialize neutral pose
    initializeNeutralPose();

    // Load segments (required for segments mode)
    await fetchSegmentsFinal();

    // WebSocket mode: pose data only (no video)
    console.log('Starting in WebSocket mode');
    initPoseWebSocket();

    // Check initial recording status
    checkRecordingStatus();

    // Ensure overlay background matches bg visibility
    if (renderer) renderer.setRenderOptions({ drawBackground: !bgVisible });

    // WebSocket mode: use image element
    if (bgImageEl) bgImageEl.style.display = bgVisible ? 'block' : 'none';

    // Start playback in neutral mode (will transition to live/segments automatically)
    startSegments();
    setStatus(`Mode: ${mode} - Ready`);

    // Start auto-toggle loop
    autoToggleLoop();
}

toggleBtn?.addEventListener('click', toggleMode);
bgToggleBtn?.addEventListener('click', () => {
    bgVisible = !bgVisible;
    // WebSocket mode: use image element
    if (bgImageEl) {
        bgImageEl.style.display = bgVisible ? 'block' : 'none';
    }
    if (renderer) {
        // Hide canvas background when showing video/image
        renderer.setRenderOptions({ drawBackground: !bgVisible });
    }
    setStatus(`Background: ${bgVisible ? 'Visible' : 'Hidden'} / Mode: ${mode}`);
});
// Auto-start when DOM is ready
if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', startAll);
} else {
    startAll();
}

window.addEventListener('keydown', (e) => {
    if (e.key === 'b' || e.key === 'B') {
        bgVisible = !bgVisible;
        // WebSocket mode: use image element
        if (bgImageEl) {
            bgImageEl.style.display = bgVisible ? 'block' : 'none';
        }
        if (renderer) {
            // Hide canvas background when showing video/image
            renderer.setRenderOptions({ drawBackground: !bgVisible });
        }
    }
});




