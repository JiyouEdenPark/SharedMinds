const autoLoadBtn = document.getElementById('autoLoadBtn');
const ptSize = document.getElementById('ptSize');
const ptAlpha = document.getElementById('ptAlpha');
const resetBtn = document.getElementById('resetBtn');
const statusDiv = document.getElementById('status');
const fileInfoDiv = document.getElementById('fileInfo');
const fileInfoText = document.getElementById('fileInfoText');
const canvas = document.getElementById('vizCanvas');
const ctx = canvas.getContext('2d');
const poseCanvas = document.getElementById('poseCanvas');
const poseCtx = poseCanvas.getContext('2d');
const hoverInfo = document.getElementById('hoverInfo');
const legend = document.getElementById('legend');
const legendItems = document.getElementById('legendItems');

let points = null; // Float32Array [N,2]
let labels = null; // Int32Array [N]
let bbox = null;   // [minx, maxx, miny, maxy]
let previews = null; // [{w,h,kpts}]

function setStatus(msg) { statusDiv.textContent = msg; }

function updateLegend() {
    if (!labels) {
        legend.style.display = 'none';
        return;
    }

    // Find unique labels
    const uniqueLabels = [...new Set(labels)].sort((a, b) => a - b);

    if (uniqueLabels.length === 0) {
        legend.style.display = 'none';
        return;
    }

    // Color palette (same as draw)
    const colorPalette = [
        '#ef4444', '#3b82f6', '#10b981', '#f59e0b', '#8b5cf6', '#06b6d4',
        '#84cc16', '#f97316', '#ec4899', '#6366f1', '#14b8a6', '#eab308'
    ];

    let legendHTML = '';
    for (const label of uniqueLabels) {
        const color = label === -1 ? '#6b7280' : colorPalette[label % colorPalette.length];
        const labelText = label === -1 ? 'Noise' : `Cluster ${label}`;
        const count = labels.filter(l => l === label).length;

        legendHTML += `
            <div style="display:flex; align-items:center; margin-bottom:4px;">
                <div style="width:12px; height:12px; background:${color}; border-radius:50%; margin-right:8px;"></div>
                <span>${labelText} (${count})</span>
            </div>
        `;
    }

    legendItems.innerHTML = legendHTML;
    legend.style.display = 'block';
}

function showFileInfo(loadedFiles) {
    if (loadedFiles && Object.keys(loadedFiles).length > 0) {
        const info = [];
        if (loadedFiles.embeddings) info.push(`Embeddings: ${loadedFiles.embeddings.info.name}`);
        if (loadedFiles.segments) info.push(`Segments: ${loadedFiles.segments.info.name}`);
        if (loadedFiles.preview) info.push(`Preview: ${loadedFiles.preview.info.name}`);

        fileInfoText.innerHTML = `<strong>Loaded files:</strong> ${info.join(' | ')}`;
        fileInfoDiv.style.display = 'block';
    } else {
        fileInfoDiv.style.display = 'none';
    }
}

function computeBBox(P) {
    let minx = Infinity, maxx = -Infinity, miny = Infinity, maxy = -Infinity;
    for (let i = 0; i < P.length; i++) {
        const x = P[i][0], y = P[i][1];
        if (x < minx) minx = x; if (x > maxx) maxx = x; if (y < miny) miny = y; if (y > maxy) maxy = y;
    }
    return [minx, maxx, miny, maxy];
}

function toCanvas(x, y) {
    const [minx, maxx, miny, maxy] = bbox;
    const w = canvas.width, h = canvas.height;
    const nx = (x - minx) / Math.max(1e-6, (maxx - minx));
    const ny = (y - miny) / Math.max(1e-6, (maxy - miny));
    // flip Y to match screen coord
    return [nx * w, (1 - ny) * h];
}

function draw() {
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    if (!points) return;
    const size = 3;
    const alpha = 0.9;
    ctx.globalAlpha = alpha;

    // 색상 팔레트 정의 (더 구분하기 쉬운 색상들)
    const colorPalette = [
        '#ef4444', // 빨강
        '#3b82f6', // 파랑
        '#10b981', // 초록
        '#f59e0b', // 주황
        '#8b5cf6', // 보라
        '#06b6d4', // 청록
        '#84cc16', // 라임
        '#f97316', // 오렌지
        '#ec4899', // 핑크
        '#6366f1', // 인디고
        '#14b8a6', // 틸
        '#eab308', // 노랑
    ];

    for (let i = 0; i < points.length; i++) {
        const [x, y] = toCanvas(points[i][0], points[i][1]);
        if (labels) {
            const label = labels[i];
            if (label === -1) {
                // 노이즈 포인트는 회색으로 표시
                ctx.fillStyle = '#6b7280';
            } else {
                // 클러스터 라벨에 따라 색상 할당
                const colorIndex = label % colorPalette.length;
                ctx.fillStyle = colorPalette[colorIndex];
            }
        } else {
            ctx.fillStyle = '#60a5fa';
        }
        ctx.beginPath();
        ctx.arc(x, y, size, 0, Math.PI * 2);
        ctx.fill();
    }
    ctx.globalAlpha = 1.0;
}

function parseNpy(buffer) {
    const u8 = new Uint8Array(buffer);
    // magic: \x93NUMPY
    if (!(u8[0] === 0x93 && u8[1] === 0x4e && u8[2] === 0x55 && u8[3] === 0x4d && u8[4] === 0x50 && u8[5] === 0x59)) {
        return null;
    }
    const dv = new DataView(buffer);
    const vMajor = dv.getUint8(6);
    const vMinor = dv.getUint8(7);
    let headerLen, headerStart;
    if (vMajor === 1) {
        headerLen = dv.getUint16(8, true);
        headerStart = 10;
    } else { // v2,v3
        headerLen = dv.getUint32(8, true);
        headerStart = 12;
    }
    const header = new TextDecoder('ascii').decode(new Uint8Array(buffer, headerStart, headerLen));
    // parse shape
    const m = header.match(/shape\s*:\s*\(([^\)]*)\)/);
    let shape = null;
    if (m && m[1]) {
        const nums = m[1].split(',').map(s => s.trim()).filter(s => s.length > 0).map(s => parseInt(s, 10));
        shape = nums;
    }
    // descr
    const dm = header.match(/descr\s*:\s*'([^']+)'/);
    const descr = dm ? dm[1] : '<f4';
    // fortran
    const fm = header.match(/fortran_order\s*:\s*(True|False)/);
    const fortran = fm ? (fm[1] === 'True') : false;
    const dataOffset = headerStart + headerLen;
    let data = null;
    if (descr === '<f4' || descr === '|f4') {
        data = new Float32Array(buffer, dataOffset);
    } else if (descr === '<f8' || descr === '|f8') {
        data = new Float64Array(buffer, dataOffset);
    } else {
        // unsupported type; attempt float32
        data = new Float32Array(buffer, dataOffset);
    }
    return { data, shape, fortran };
}

async function loadNpyFromBuffer(buffer) {
    const arr = parseNpy(buffer);
    if (!arr) {
        setStatus('Not a valid NPY format (magic mismatch)');
        return false;
    }
    const data = arr.data;
    const shape = arr.shape;
    if (shape && shape.length === 2 && shape[1] === 2) {
        const N = shape[0];
        const P = new Array(N);
        for (let i = 0; i < N; i++) P[i] = [data[i * 2], data[i * 2 + 1]];
        points = P;
    } else {
        const N = Math.floor(data.length / 2);
        const P = new Array(N);
        for (let i = 0; i < N; i++) P[i] = [data[2 * i], data[2 * i + 1]];
        points = P;
    }
    bbox = computeBBox(points);
    setStatus(`Loaded embeddings: ${points.length}`);
    draw();
    return true;
}

async function loadNpy(file) {
    const buf = await file.arrayBuffer();
    return await loadNpyFromBuffer(buf);
}

async function loadSegFromText(text) {
    const obj = JSON.parse(text);
    if (obj && Array.isArray(obj.labels)) {
        labels = new Int32Array(obj.labels);
        setStatus(`Loaded labels: ${labels.length}`);
        updateLegend();
        draw();
        return true;
    } else if (obj && obj.segments) {
        // Build per-window labels from segments.json
        let numWindows = obj.num_windows || 0;

        // segments.json should always have num_windows
        if (numWindows === 0) {
            console.warn('num_windows is 0. Please check segments.json.');
            return false;
        }

        if (numWindows > 0) {
            labels = new Int32Array(numWindows);
            labels.fill(-1); // default -1

            // Assign each segment label to per-window labels
            for (const segment of obj.segments) {
                const start = segment.start;
                const end = segment.end;
                const label = segment.label;
                for (let i = start; i <= end && i < numWindows; i++) {
                    labels[i] = label;
                }
            }
            setStatus(`Generated ${labels.length} labels (from ${obj.segments.length} segments)`);
            updateLegend();
            draw();
            return true;
        }
    }
    setStatus('segments.json format error - missing labels array or segments info');
    return false;
}

async function loadSeg(file) {
    const text = await file.text();
    return await loadSegFromText(text);
}

async function autoLoadFiles() {
    try {
        setStatus('Loading files...');
        const response = await fetch('/embeddings/auto-load');
        if (response.ok) {
            const data = await response.json();
            if (data.status === 'ok') {
                const loadedFiles = data.loaded_files;
                // showFileInfo(loadedFiles);

                // Load embeddings
                if (loadedFiles.embeddings) {
                    const hexContent = loadedFiles.embeddings.content;
                    const buffer = new Uint8Array(hexContent.match(/.{1,2}/g).map(byte => parseInt(byte, 16)));
                    await loadNpyFromBuffer(buffer.buffer);
                }

                // Load segments
                if (loadedFiles.segments) {
                    await loadSegFromText(loadedFiles.segments.content);
                }

                // Load preview
                if (loadedFiles.preview) {
                    try {
                        const arr = JSON.parse(loadedFiles.preview.content);
                        if (Array.isArray(arr)) {
                            previews = arr;
                            setStatus(`Loaded previews: ${arr.length}`);
                        }
                    } catch (err) {
                        console.warn('Failed to parse preview file:', err);
                    }
                }

                setStatus(`Load complete`);
            } else {
                setStatus('Load failed');
            }
        } else {
            setStatus('Load request failed');
        }
    } catch (error) {
        console.error('Load error:', error);
        setStatus('An error occurred during load.');
    }
}

autoLoadBtn.addEventListener('click', autoLoadFiles);

// Hover preview
function findNearestPoint(mx, my, tol = 6) {
    if (!points) return -1;
    let best = -1, bestd = tol * tol;
    for (let i = 0; i < points.length; i++) {
        const [cx, cy] = toCanvas(points[i][0], points[i][1]);
        const dx = mx - cx, dy = my - cy;
        const d2 = dx * dx + dy * dy;
        if (d2 <= bestd) { bestd = d2; best = i; }
    }
    return best;
}

function drawPosePreview(idx) {
    poseCtx.clearRect(0, 0, poseCanvas.width, poseCanvas.height);
    if (!previews || idx < 0 || idx >= previews.length) return;
    const p = previews[idx];
    const w = p.w || 820, h = p.h || 616;
    const k = p.kpts || [];
    // scale to canvas
    const sx = poseCanvas.width / w; const sy = poseCanvas.height / h;
    // detect normalized vs pixel coordinates
    let normalized = false;
    for (let i = 0; i < k.length; i++) {
        const x = k[i][0], y = k[i][1];
        if (x <= 1.1 && y <= 1.1) { normalized = true; break; }
    }
    // skeleton pairs (COCO)
    const edges = [
        [5, 7], [7, 9], [6, 8], [8, 10], [5, 6], [5, 11], [6, 12], [11, 13], [13, 15], [12, 14], [14, 16]
    ];
    // draw lines
    poseCtx.strokeStyle = '#60a5fa'; poseCtx.lineWidth = 2;
    poseCtx.beginPath();
    for (const [a, b] of edges) {
        if (!k[a] || !k[b]) continue;
        const axp = normalized ? k[a][0] * w : k[a][0];
        const ayp = normalized ? k[a][1] * h : k[a][1];
        const bxp = normalized ? k[b][0] * w : k[b][0];
        const byp = normalized ? k[b][1] * h : k[b][1];
        const ax = axp * sx, ay = ayp * sy;
        const bx = bxp * sx, by = byp * sy;
        poseCtx.moveTo(ax, ay); poseCtx.lineTo(bx, by);
    }
    poseCtx.stroke();
    // draw keypoints
    poseCtx.fillStyle = '#f59e0b';
    for (let i = 0; i < k.length; i++) {
        const xp = normalized ? k[i][0] * w : k[i][0];
        const yp = normalized ? k[i][1] * h : k[i][1];
        const x = xp * sx, y = yp * sy;
        poseCtx.beginPath(); poseCtx.arc(x, y, 3, 0, Math.PI * 2); poseCtx.fill();
    }
}

canvas.addEventListener('mousemove', (e) => {
    const rect = canvas.getBoundingClientRect();
    const mx = e.clientX - rect.left;
    const my = e.clientY - rect.top;
    const idx = findNearestPoint(mx, my, 8);
    if (idx >= 0) {
        const label = labels ? labels[idx] : "-";
        const labelText = label === -1 ? "Noise" : `Cluster ${label}`;
        // hoverInfo.textContent = `Window ${idx} | ${labelText}`;
        hoverInfo.textContent = `${labelText}`;
        drawPosePreview(idx);
    } else {
        hoverInfo.textContent = "Hover a point.";
    }
});

setStatus('Click "Load" to start.');


