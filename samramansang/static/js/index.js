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

// Mode toggle: live vs segments
// Start in segments mode; every 10 seconds toggle if the alternate source is available
let mode = 'live'; // 'segments' | 'live'
let lastToggleTs = 0;
const TOGGLE_INTERVAL_MS = 10000;
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

function maybeStartAfterReady() {
    // Start playback only when segments are loaded and first live keypoints arrived
    if (!playing && currentLiveNorm) {
        if (Array.isArray(segments) && segments.length > 0) {
            startSegments();
            setStatus('Live pose received. Starting playback');
        } else {
            // Render immediately if pose is available even without segments
            startSegments();
            setStatus('Live pose received');
        }
    }
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
    streamCtrl = makeStreamingChain(windowsIndex, jsonlMap, segments, {
        blendN: BLEND_N,
        bufferLow: BUFFER_LOW,
        bufferTarget: BUFFER_TARGET,
        compactThreshold: COMPACT_THRESHOLD,
        compactKeepPrev: COMPACT_KEEP_PREV,
        reorder: true,
    });
    streamCtrl.seed(playbackFrames);
}

function ensurePlaybackBuffer() {
    if (mode === 'live') { ensureLiveBuffer(); return; }
    if (!streamCtrl) return;
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

    // In Live mode, render currentLiveNorm directly
    if (mode === 'live') {
        if (currentLiveNorm) {
            renderSingle(currentLiveNorm, 'live');
        }
        // In Live mode, render quickly with low latency
        playTimer = setTimeout(stepPlayback, 33); // ~30fps
        return;
    }

    // If no segments, render only live pose
    if (!Array.isArray(segments) || segments.length === 0) {
        if (currentLiveNorm) {
            renderSingle(currentLiveNorm, 'live');
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
        // In segments mode, stop playback and don't switch to live mode
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
    const prev = playIdx > 1 ? playbackFrames[playIdx - 2] : null; // since playIdx was incremented
    let delay = schedule(prev, cur, 1.0);
    if (cur && cur.live === true) delay = 0; // minimize latency for live frames
    compactPlaybackFrames();
    playTimer = setTimeout(stepPlayback, Math.max(0, Math.floor(delay * 1000)));
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
    if (mode === 'segments') {
        mode = 'live';
        // Blend immediately from current segment pose to live at the current screen position
        blendToLiveNow();
    } else {
        mode = 'segments';
        // Reset sampling so the next seg->live will recompute
        resetLiveScaleSampling();
        streamCtrl.resetPrev();
    }
    setStatus(`Mode: ${mode}`);
}

let autoToggleTimer = null;
function autoToggleLoop() {
    if (autoToggleTimer) { clearInterval(autoToggleTimer); autoToggleTimer = null; }
    autoToggleTimer = setInterval(() => {
        // toggleMode();
    }, TOGGLE_INTERVAL_MS);
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
        // Start a new sampling session and set reference pose
        resetLiveScaleSampling();
        liveScaleRefKpts = curKpts;
        const w = stageW || 1280;
        const h = stageH || 720;
        const prevItem = { width: w, height: h, kpts: curKpts, fps: 30 };
        const liveItem = { width: w, height: h, kpts: currentLiveNorm, fps: 30 };
        const blends = createBlendFramesScaled(prevItem, 1.0, [0, 0], liveItem, 1.0, [0, 0], BLEND_N) || [];
        playbackFrames.splice(playIdx, playbackFrames.length - playIdx, ...blends, liveItem);
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
                        // Render current pose immediately
                        if (currentLiveNorm && renderer) {
                            renderSingle(currentLiveNorm, 'live');
                        }
                    }
                }
                // If playing is true and mode is live, it will be automatically rendered in stepPlayback
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

    // Load segments (required for segments mode)
    await fetchSegmentsFinal();

    // WebSocket mode: pose data only (no video)
    console.log('Starting in WebSocket mode');
    initPoseWebSocket();

    // Ensure overlay background matches bg visibility
    if (renderer) renderer.setRenderOptions({ drawBackground: !bgVisible });

    // WebSocket mode: use image element
    if (bgImageEl) bgImageEl.style.display = bgVisible ? 'block' : 'none';

    // In segments mode, start playback immediately when segments are loaded
    if (mode === 'segments' && Array.isArray(segments) && segments.length > 0) {
        startSegments();
        setStatus(`Segments mode: Starting playback of ${segments.length} segments`);
    } else {
        // In Live mode or if no segments, wait for live pose
        maybeStartAfterReady();
    }
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




