import Renderer from 'renderer';
import { anchorFromK } from './util/segments-utils.js';
import { PoseWebSocketClient, updateImageElement } from './util/pose-websocket.js';

// State
let renderer = null;
let overlay = null;
let bgImageEl = null;
let stageW = 0;
let stageH = 0;

// WebSocket state
let poseWsClient = null;
let recordingState = {
    isRecording: false,
    seqId: null,
    path: null,
    startTime: null
};

// Recording status check interval
let statusCheckInterval = null;

const statusEl = document.getElementById('status');
const recordBtn = document.getElementById('recordBtn');
const recordInfoEl = document.getElementById('recordInfo');

function setStatus(msg) {
    if (statusEl) statusEl.textContent = msg;
}

function updateRecordInfo() {
    if (!recordInfoEl) return;

    if (recordingState.isRecording) {
        const elapsed = recordingState.startTime
            ? Math.floor((Date.now() - recordingState.startTime) / 1000)
            : 0;
        const minutes = Math.floor(elapsed / 60);
        const seconds = elapsed % 60;
        recordInfoEl.textContent = `Recording (${minutes}:${seconds.toString().padStart(2, '0')})`;
        recordInfoEl.classList.add('recording');
    } else {
        if (recordingState.seqId) {
            recordInfoEl.textContent = `Last: ${recordingState.seqId}`;
        } else {
            recordInfoEl.textContent = '';
        }
        recordInfoEl.classList.remove('recording');
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

function initPoseWebSocket() {
    if (poseWsClient) return;

    // Initialize bgImageEl
    if (!bgImageEl) {
        bgImageEl = document.getElementById('bgImage');
    }

    poseWsClient = new PoseWebSocketClient({
        onOpen: () => {
            console.log('Pose data WebSocket connected');
            setStatus('WebSocket connected');
            checkRecordingStatus();
        },
        onFrame: (data) => {
            // Process video frame reception
            if (bgImageEl && data.frame) {
                updateImageElement(data, bgImageEl, true);
            }
        },
        onKpts: (data) => {
            // Process pose data reception
            if (data.kpts) {
                const currentLiveNorm = normalizeKeypoints(data.kpts, data.W, data.H);
                if (currentLiveNorm && renderer) {
                    renderSingle(currentLiveNorm, 'live');
                }
            }
        },
        onError: (error) => {
            setStatus('WebSocket connection error');
        },
        onClose: () => {
            setStatus('WebSocket disconnected');
        }
    });

    poseWsClient.connect();
}

async function toggleRecording() {
    if (!poseWsClient || !poseWsClient.isConnected()) {
        setStatus('WebSocket connection is required.');
        return;
    }

    try {
        const response = await fetch('/websocket/toggle-recording', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({})
        });

        const result = await response.json();

        if (result.status === 'ok') {
            recordingState.isRecording = result.is_recording;
            recordingState.seqId = result.seq_id || null;
            recordingState.path = result.path || null;

            if (recordingState.isRecording) {
                recordingState.startTime = Date.now();
                recordBtn.textContent = 'Stop Recording';
                recordBtn.classList.add('recording');
                setStatus('Recording started');
            } else {
                recordingState.startTime = null;
                recordBtn.textContent = 'Start Recording';
                recordBtn.classList.remove('recording');
                setStatus('Recording stopped');
            }

            updateRecordInfo();
            console.log(`Recording ${recordingState.isRecording ? 'started' : 'stopped'}: ${result.message}`);
        } else {
            setStatus(`Recording control failed: ${result.error}`);
        }
    } catch (error) {
        console.error('Recording control error:', error);
        setStatus('An error occurred during recording control.');
    }
}

async function checkRecordingStatus() {
    try {
        const response = await fetch('/websocket/recording-status');
        const result = await response.json();

        if (result.status === 'ok') {
            recordingState.isRecording = result.is_recording;
            recordingState.seqId = result.seq_id || null;
            recordingState.path = result.path || null;

            if (recordingState.isRecording) {
                recordBtn.textContent = 'Stop Recording';
                recordBtn.classList.add('recording');
                setStatus('Recording...');
            } else {
                recordBtn.textContent = 'Start Recording';
                recordBtn.classList.remove('recording');
            }

            updateRecordInfo();
        }
    } catch (error) {
        console.error('Recording status query error:', error);
    }
}


async function startAll() {
    overlay = document.getElementById('overlay');
    bgImageEl = document.getElementById('bgImage');
    resizeRenderer();
    window.addEventListener('resize', resizeRenderer);

    // Start WebSocket connection
    initPoseWebSocket();

    // Periodically check recording status (every 1 second)
    statusCheckInterval = setInterval(() => {
        if (recordingState.isRecording) {
            updateRecordInfo();
        }
    }, 1000);
}

// Event listeners
recordBtn?.addEventListener('click', toggleRecording);

// Auto-start when DOM is ready
if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', startAll);
} else {
    startAll();
}

// Cleanup on page exit
window.addEventListener('beforeunload', () => {
    if (statusCheckInterval) {
        clearInterval(statusCheckInterval);
    }
    if (poseWsClient) {
        poseWsClient.disconnect();
    }
});

