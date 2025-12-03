import Renderer from './renderer/renderer.js';

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

const overlay = document.getElementById('overlay');

let renderer = null;
let frames = [];
let idx = 0;
let playing = false;
let paused = false;
let timer = null;

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
