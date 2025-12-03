import Renderer from './renderer/renderer.js';

const fileInput = document.getElementById('fileInput');
const datasetSelect = document.getElementById('datasetSelect');
const loadDatasetBtn = document.getElementById('loadDatasetBtn');
const refreshDatasetBtn = document.getElementById('refreshDatasetBtn');
const playBtn = document.getElementById('playBtn');
const pauseBtn = document.getElementById('pauseBtn');
const stopBtn = document.getElementById('stopBtn');
const speedSelect = document.getElementById('speedSelect');
const loopCheck = document.getElementById('loopCheck');
const statusDiv = document.getElementById('status');
const fileInfoDiv = document.getElementById('fileInfo');
const fileInfoText = document.getElementById('fileInfoText');
const stageCard = document.getElementById('stageCard');
const loadSegments = document.getElementById('loadSegments');
const autoSegBtn = document.getElementById('autoSegBtn');
const stopAutoBtn = document.getElementById('stopAutoBtn');
const smartOrder = document.getElementById('smartOrder');
const smoothBoundary = document.getElementById('smoothBoundary');
const blendFramesInput = document.getElementById('blendFrames');

const overlay = document.getElementById('overlay');

let renderer = null;
let frames = [];
let idx = 0;
let playing = false;
let paused = false;
let timer = null;
let segments = null; // optional [{start,end,label}]
let autoTimer = null;
let autoIdx = 0;

function setStatus(msg) {
    statusDiv.textContent = msg;
}

function showFileInfo(info) {
    if (info) {
        fileInfoText.innerHTML = `
            <strong>File Info:</strong> 
            Frame count: ${info.frame_count} | 
            Resolution: ${info.metadata.width}x${info.metadata.height} | 
            FPS: ${info.metadata.fps} | 
            Keypoints: ${info.metadata.keypoint_count}
        `;
        fileInfoDiv.style.display = 'block';
    } else {
        fileInfoDiv.style.display = 'none';
    }
}

async function loadDatasetFiles() {
    try {
        setStatus('Loading dataset file list...');

        const response = await fetch('/playback/dataset-files');
        const data = await response.json();

        if (data.status === 'ok') {
            // Remove existing options (except first option)
            while (datasetSelect.children.length > 1) {
                datasetSelect.removeChild(datasetSelect.lastChild);
            }

            // Add file list
            data.files.forEach(file => {
                const option = document.createElement('option');
                option.value = file.path;
                option.textContent = `${file.name} (${formatFileSize(file.size)})`;
                datasetSelect.appendChild(option);
            });

            setStatus(`Found ${data.count} files in dataset.`);
        } else {
            setStatus('Cannot load dataset file list.');
        }
    } catch (error) {
        console.error('Dataset file list load error:', error);
        setStatus('An error occurred while loading dataset file list.');
    }
}

function formatFileSize(bytes) {
    if (bytes === 0) return '0 Bytes';
    const k = 1024;
    const sizes = ['Bytes', 'KB', 'MB', 'GB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
}

async function loadDatasetFile(filePath) {
    try {
        setStatus('Loading dataset file...');

        // Query file info first
        const infoResponse = await fetch(`/playback/dataset-file-info?path=${encodeURIComponent(filePath)}`);
        const infoData = await infoResponse.json();

        if (infoData.status === 'ok') {
            showFileInfo(infoData);
        }

        // Load file content
        const response = await fetch(`/playback/dataset-file?path=${encodeURIComponent(filePath)}`);

        if (response.ok) {
            const content = await response.text();
            frames = parseJsonl(content);

            if (!frames.length) {
                setStatus('No valid frames. Please check JSONL format.');
                enableControls(false);
                return;
            }

            const w = parseInt(frames[0].width || 820, 10);
            const h = parseInt(frames[0].height || 616, 10);
            stageCard.style.display = '';

            if (!renderer) {
                renderer = new Renderer(overlay);
            }
            renderer.initialize(w, h);
            renderer.setRenderOptions({ showKeypoints: true, showSkeleton: true, smoothing: true, interpolation: true });

            idx = 0;
            enableControls(true);
            setStatus(`${frames.length} frames loaded · ${w}x${h}`);
        } else {
            const errorData = await response.json();
            setStatus(`File load failed: ${errorData.error || 'Unknown error'}`);
        }
    } catch (error) {
        console.error('Dataset file load error:', error);
        setStatus('An error occurred while loading dataset file.');
    }
}

function enableControls(loaded) {
    playBtn.disabled = !loaded;
    pauseBtn.disabled = true;
    stopBtn.disabled = true;
}

function denormalizeKpts(item) {
    const w = parseInt(item.width || 0, 10);
    const h = parseInt(item.height || 0, 10);
    const k = item.kpts || [];
    if (Array.isArray(k) && k.length > 0 && w > 0 && h > 0) {
        if (k[0] && typeof k[0][0] === 'number' && k[0][0] <= 1.0 && k[0][1] <= 1.0) {
            return k.map(p => [Math.round(p[0] * w), Math.round(p[1] * h), p.length > 2 ? Number(p[2]) : 1.0]);
        }
        return k.map(p => [Math.round(p[0]), Math.round(p[1]), p.length > 2 ? Number(p[2]) : 1.0]);
    }
    return [];
}

function scheduleNext(prev, next, speed) {
    // Prefer fps, fallback to ts delta, else default 1/30s
    let dt = null;
    if (next && typeof next.fps === 'number' && next.fps > 0) {
        dt = 1.0 / next.fps;
    } else if (prev && next && typeof prev.ts === 'number' && typeof next.ts === 'number') {
        dt = Math.max(0, (next.ts - prev.ts) / 1000);
    } else {
        dt = 1.0 / 30.0;
    }
    dt = dt / Math.max(1e-6, speed);
    return dt;
}

async function playLoop() {
    if (!playing || paused) return;
    if (idx >= frames.length) {
        if (loopCheck.checked) {
            idx = 0;
        } else {
            stopPlayback();
            return;
        }
    }

    const speed = Number(speedSelect.value || 1);
    const item = frames[idx];
    const prev = idx > 0 ? frames[idx - 1] : null;
    const kpts = denormalizeKpts(item);

    if (renderer) {
        renderer.render({ kpts, W: item.width, H: item.height });
    }

    const delay = scheduleNext(prev, item, speed);
    idx += 1;
    timer = setTimeout(playLoop, Math.max(0, delay * 1000));
}

function startPlayback() {
    if (!frames.length) return;
    playing = true;
    paused = false;
    playBtn.disabled = true;
    pauseBtn.disabled = false;
    stopBtn.disabled = false;
    playLoop();
}

function pausePlayback() {
    if (!playing) return;
    paused = true;
    if (timer) clearTimeout(timer);
    playBtn.disabled = false;
    pauseBtn.disabled = true;
}

function stopPlayback() {
    playing = false;
    paused = false;
    if (timer) clearTimeout(timer);
    idx = 0;
    playBtn.disabled = false;
    pauseBtn.disabled = true;
    stopBtn.disabled = true;
}

function playSegmentRange(startIdx, endIdx) {
    if (!frames.length) return;
    idx = Math.max(0, Math.min(frames.length - 1, startIdx));
    const end = Math.max(0, Math.min(frames.length - 1, endIdx));
    playing = true; paused = false;
    playBtn.disabled = true; pauseBtn.disabled = false; stopBtn.disabled = false;

    const step = () => {
        if (!playing || paused) return;
        if (idx > end) { stopPlayback(); return; }
        const speed = Number(speedSelect.value || 1);
        const item = frames[idx];
        const prev = idx > 0 ? frames[idx - 1] : null;
        let kpts = denormalizeKpts(item);
        // boundary blending within this segment (applies when we inject a synthetic blend phase before start)
        if (currentBlend && currentBlend.active) {
            const alpha = currentBlend.nextAlpha();
            if (alpha >= 0) {
                kpts = blendKeypoints(currentBlend.prev, kpts, alpha);
            } else {
                currentBlend = null;
            }
        }
        if (renderer) renderer.render({ kpts, W: item.width, H: item.height });
        const delay = scheduleNext(prev, item, speed);
        idx += 1;
        timer = setTimeout(step, Math.max(0, delay * 1000));
    };
    step();
}

function startAutoSegments() {
    if (!segments || !Array.isArray(segments) || segments.length === 0) return;
    autoIdx = 0;
    autoSegBtn.disabled = true; stopAutoBtn.disabled = false;
    let order = segments.slice();
    if (smartOrder.checked) {
        order = reorderSegmentsBySimilarity(order);
    }
    const next = () => {
        if (autoIdx >= order.length) { autoSegBtn.disabled = false; stopAutoBtn.disabled = true; return; }
        const seg = order[autoIdx++];
        stopPlayback();
        // setup boundary blend from previous seg end to new seg start
        if (smoothBoundary.checked && typeof lastFrameIdx === 'number') {
            prepareBoundaryBlend(lastFrameIdx, seg.start, Number(blendFramesInput.value || 8));
        } else {
            currentBlend = null;
        }
        playSegmentRange(seg.start, seg.end);
        const segFrames = Math.max(1, seg.end - seg.start + 1);
        const approxMs = (1000 * segFrames / 30);
        // remember last frame index for next boundary
        lastFrameIdx = seg.end;
        autoTimer = setTimeout(next, approxMs / Math.max(0.1, Number(speedSelect.value || 1)));
    };
    next();
}

function stopAutoSegments() {
    if (autoTimer) clearTimeout(autoTimer);
    stopPlayback();
    autoSegBtn.disabled = false; stopAutoBtn.disabled = true;
}

function parseJsonl(text) {
    const out = [];
    const lines = text.split(/\r?\n/);
    for (const line of lines) {
        const s = line.trim();
        if (!s) continue;
        try {
            const obj = JSON.parse(s);
            if (obj && (obj.kpts || obj.keypoints)) {
                if (!obj.kpts && obj.keypoints) obj.kpts = obj.keypoints;
                out.push(obj);
            }
        } catch (e) {
            // skip invalid lines
        }
    }
    return out;
}

fileInput.addEventListener('change', async (e) => {
    const file = e.target.files && e.target.files[0];
    if (!file) return;
    setStatus(`Loading: ${file.name}`);
    const text = await file.text();
    frames = parseJsonl(text);
    if (!frames.length) {
        setStatus('No valid frames. Please check JSONL format.');
        enableControls(false);
        return;
    }
    const w = parseInt(frames[0].width || 820, 10);
    const h = parseInt(frames[0].height || 616, 10);
    stageCard.style.display = '';
    if (!renderer) {
        renderer = new Renderer(overlay);
    }
    renderer.initialize(w, h);
    renderer.setRenderOptions({ showKeypoints: true, showSkeleton: true, smoothing: true, interpolation: true });
    idx = 0;
    enableControls(true);
    setStatus(`${frames.length} frames loaded · ${w}x${h}`);
});

// Dataset-related event listeners
datasetSelect.addEventListener('change', (e) => {
    loadDatasetBtn.disabled = !e.target.value;
});

loadDatasetBtn.addEventListener('click', () => {
    const selectedPath = datasetSelect.value;
    if (selectedPath) {
        loadDatasetFile(selectedPath);
    }
});

refreshDatasetBtn.addEventListener('click', () => {
    loadDatasetFiles();
});

playBtn.addEventListener('click', startPlayback);
pauseBtn.addEventListener('click', pausePlayback);
stopBtn.addEventListener('click', stopPlayback);

// Load dataset file list on page load
loadDatasetFiles();
setStatus('Please select a file or choose from dataset.');

// load segments json and draw overlay ranges (simple status text)
loadSegments.addEventListener('click', async (e) => {
    e.preventDefault();
    try {
        const [fileHandle] = await window.showOpenFilePicker({ types: [{ description: 'JSON', accept: { 'application/json': ['.json'] } }] });
        const file = await fileHandle.getFile();
        const text = await file.text();
        const obj = JSON.parse(text);
        if (obj && Array.isArray(obj.segments)) {
            segments = obj.segments;
            setStatus(`${segments.length} segments loaded`);
            autoSegBtn.disabled = false; stopAutoBtn.disabled = true;
        } else {
            setStatus('Segment format is invalid.');
        }
    } catch (err) {
        console.log(err);
    }
});

autoSegBtn.addEventListener('click', startAutoSegments);
stopAutoBtn.addEventListener('click', stopAutoSegments);

// --- Similarity ordering & boundary blending helpers ---
let lastFrameIdx = null;
let currentBlend = null;

function segmentCentroid(seg) {
    // average keypoints over first and last few frames for robustness (here use endpoints)
    const a = denormalizeKpts(frames[seg.start]);
    const b = denormalizeKpts(frames[seg.end]);
    const avg = [];
    for (let i = 0; i < 17; i++) {
        const x = (a[i][0] + b[i][0]) * 0.5;
        const y = (a[i][1] + b[i][1]) * 0.5;
        avg.push([x, y]);
    }
    return avg; // (17,2)
}

function distanceCentroid(c1, c2) {
    let s = 0;
    for (let i = 0; i < 17; i++) {
        const dx = c1[i][0] - c2[i][0]; const dy = c1[i][1] - c2[i][1]; s += dx * dx + dy * dy;
    }
    return Math.sqrt(s / 17);
}

function reorderSegmentsBySimilarity(segs) {
    if (!segs || segs.length === 0) return segs;
    const cents = segs.map(segmentCentroid);
    const used = new Array(segs.length).fill(false);
    const order = [];
    let cur = 0; used[0] = true; order.push(segs[0]);
    for (let k = 1; k < segs.length; k++) {
        let best = -1, bestd = Infinity;
        for (let i = 0; i < segs.length; i++) if (!used[i]) {
            const d = distanceCentroid(cents[cur], cents[i]);
            if (d < bestd) { bestd = d; best = i; }
        }
        used[best] = true; order.push(segs[best]); cur = best;
    }
    return order;
}

function getFrameKpts(idx) {
    const item = frames[idx];
    return denormalizeKpts(item);
}

function blendKeypoints(k1, k2, alpha) {
    // alpha in [0,1]: 0->k1, 1->k2
    const out = [];
    for (let i = 0; i < 17; i++) {
        const x = (1 - alpha) * k1[i][0] + alpha * k2[i][0];
        const y = (1 - alpha) * k1[i][1] + alpha * k2[i][1];
        const s = (1 - alpha) * (k1[i][2] || 1) + alpha * (k2[i][2] || 1);
        out.push([x, y, s]);
    }
    return out;
}

function prepareBoundaryBlend(prevEndIdx, nextStartIdx, blendFrames) {
    const k1 = getFrameKpts(prevEndIdx);
    const k2 = getFrameKpts(nextStartIdx);
    const total = Math.max(0, Math.floor(blendFrames));
    if (total <= 0) { currentBlend = null; return; }
    let i = 0;
    currentBlend = {
        active: true,
        nextAlpha: () => {
            if (i >= total) return -1;
            const a = (i + 1) / total; i += 1; return a;
        },
        prev: k1
    };
}

