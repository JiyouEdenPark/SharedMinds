import Renderer from './renderer/renderer.js';
import { denorm, reorder, schedule, chainSegments } from './util/segments-utils.js';

const autoLoadBtn = document.getElementById('autoLoadBtn');
const speedSelect = document.getElementById('speedSelect');
const playSegBtn = document.getElementById('playSegBtn');
const stopSegBtn = document.getElementById('stopSegBtn');
const smartOrder = document.getElementById('smartOrder');
const smoothBoundary = document.getElementById('smoothBoundary');
const blendFramesInput = document.getElementById('blendFrames');
const statusDiv = document.getElementById('status');
const fileInfoDiv = document.getElementById('fileInfo');
const fileInfoText = document.getElementById('fileInfoText');
const segBadge = document.getElementById('segBadge');
const segList = document.getElementById('segList');
const frameSlider = document.getElementById('frameSlider');
const frameLabel = document.getElementById('frameLabel');

// Distance information related elements
const distanceSection = document.getElementById('distanceSection');
const calculateDistancesBtn = document.getElementById('calculateDistancesBtn');
const loadDistancesBtn = document.getElementById('loadDistancesBtn');
const topK = document.getElementById('topK');
const distanceStatus = document.getElementById('distanceStatus');
const distanceInfo = document.getElementById('distanceInfo');
const distanceInfoText = document.getElementById('distanceInfoText');
const segmentSource = document.getElementById('segmentSource');

const overlay = document.getElementById('overlay');

// Label filtering related elements
const showAllLabels = document.getElementById('showAllLabels');
const labelFilters = document.getElementById('labelFilters');

const playSelectedBtn = document.getElementById('playSelectedBtn');
const saveFinalBtn = document.getElementById('saveFinalBtn');
const playRandomBtn = document.getElementById('playRandomBtn');
let selectedSegIndices = new Set();

let renderer = null;
let frames = [];
let segments = null;
let finalSegments = null;
let usingFinal = false;
window.loadedSegmentsPath = null;
window.loadedFinalSegmentsPath = null;
let jsonlMap = {}; // { basename: [items parsed] }

// Label filtering related variables
let labelCounts = {}; // { label: count }
let selectedLabels = new Set(); // Selected labels
let filteredSegments = []; // Filtered segments
let windowsIndex = null; // { window,stride,files,windows }
let idx = 0;
let playing = false;
let paused = false;
let timer = null;
let autoTimer = null;
let autoIdx = 0;
let lastFrameIdx = null;
let currentBlend = null;
let currentSegText = '';

// Distance information related variables
let distanceData = null;
let nearestSegments = null;

// 내장된 next_candidates 사용 여부
function getEmbeddedNearestFor(index) {
    if (!segments || index < 0 || index >= segments.length) return null;
    const seg = segments[index];
    if (seg && Array.isArray(seg.next_candidates)) {
        // map to { segment_index, distance }
        return seg.next_candidates.map(n => ({ segment_index: Number(n.segment_index), distance: Number(n.distance || 0) }));
    }
    return null;
}

function setStatus(m) { statusDiv.textContent = m; }

function setDistanceStatus(m) { distanceStatus.textContent = m; }

// Distance calculation function
async function calculateDistances() {
    try {
        setDistanceStatus('Calculating distances...');
        calculateDistancesBtn.disabled = true;

        const segPath = usingFinal && window.loadedFinalSegmentsPath ? window.loadedFinalSegmentsPath : (window.loadedSegmentsPath || 'training/runs/segments.json');
        const config = {
            embeddings_path: 'training/runs/embeddings.npy',
            segments_path: segPath,
            output_path: 'training/runs/segment_distances.json',
            top_k: parseInt(topK.value)
        };

        const response = await fetch('/segments/calculate-distances', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json'
            },
            body: JSON.stringify(config)
        });

        const result = await response.json();

        if (response.ok) {
            setDistanceStatus('Distance calculation complete! Please load distance information.');
            loadDistancesBtn.disabled = false;
            console.log('Distance calculation complete:', result);
        } else {
            setDistanceStatus(`Distance calculation failed: ${result.error}`);
        }
    } catch (error) {
        console.error('Distance calculation error:', error);
        setDistanceStatus('An error occurred while calculating distances.');
    } finally {
        calculateDistancesBtn.disabled = false;
    }
}

// Load distance information function
async function loadDistances() {
    try {
        setDistanceStatus('Loading distance information...');
        loadDistancesBtn.disabled = true;

        const response = await fetch('/segments/distances');
        const result = await response.json();

        if (response.ok) {
            distanceData = result.data;
            nearestSegments = distanceData.nearest_segments;

            // Display distance information
            const metadata = distanceData.metadata;
            const infoText = `
                <strong>Distance Information:</strong> 
                ${metadata.num_segments} segments | 
                Cosine distance | 
                Transition representation (reference: last, target: first) | 
                Top ${metadata.top_k}
            `;
            distanceInfoText.innerHTML = infoText;
            distanceInfo.style.display = 'block';

            setDistanceStatus('Distance information loaded!');

            // Update segment list
            updateSegmentList();
        } else {
            setDistanceStatus(`Failed to load distance information: ${result.error}`);
        }
    } catch (error) {
        console.error('Distance information load error:', error);
        setDistanceStatus('An error occurred while loading distance information.');
    } finally {
        loadDistancesBtn.disabled = false;
    }
}

// Update segment list function (includes distance information)
function updateSegmentList() {
    renderSegList();
}

// Label filtering related functions
function updateLabelCounts() {
    labelCounts = {};
    if (!segments) return;

    segments.forEach(seg => {
        const label = seg.label !== undefined ? String(seg.label) : 'noise';
        labelCounts[label] = (labelCounts[label] || 0) + 1;
    });
}

function renderLabelFilters() {
    labelFilters.innerHTML = '';

    if (Object.keys(labelCounts).length === 0) {
        return;
    }

    Object.entries(labelCounts).forEach(([label, count]) => {
        const labelDiv = document.createElement('div');
        labelDiv.style.display = 'flex';
        labelDiv.style.alignItems = 'center';
        labelDiv.style.gap = '6px';
        labelDiv.style.fontSize = '13px';

        const checkbox = document.createElement('input');
        checkbox.type = 'checkbox';
        checkbox.id = `label-${label}`;
        checkbox.checked = selectedLabels.has(label);
        checkbox.addEventListener('change', () => {
            if (checkbox.checked) {
                selectedLabels.add(label);
            } else {
                selectedLabels.delete(label);
            }
            updateFilteredSegments();
            renderSegList();
        });

        const labelSpan = document.createElement('span');
        labelSpan.textContent = `${label} (${count})`;
        labelSpan.style.color = getLabelColor(label);

        labelDiv.appendChild(checkbox);
        labelDiv.appendChild(labelSpan);
        labelFilters.appendChild(labelDiv);
    });
}

function getLabelColor(label) {
    // Color mapping by label
    const colors = {
        'noise': '#6b7280',
        '0': '#ef4444',
        '1': '#f97316',
        '2': '#eab308',
        '3': '#22c55e',
        '4': '#06b6d4',
        '5': '#3b82f6',
        '6': '#8b5cf6',
        '7': '#ec4899'
    };
    return colors[label] || '#9ca3af';
}

function updateFilteredSegments() {
    if (!segments) {
        filteredSegments = [];
        return;
    }

    if (showAllLabels.checked || selectedLabels.size === 0) {
        filteredSegments = [...segments];
    } else {
        filteredSegments = segments.filter(seg => {
            const label = seg.label !== undefined ? String(seg.label) : 'noise';
            return selectedLabels.has(label);
        });
    }
}

function showFileInfo(loadedFiles) {
    if (loadedFiles && Object.keys(loadedFiles).length > 0) {
        const info = [];
        if (loadedFiles.jsonl) info.push(`JSONL: ${loadedFiles.jsonl.info.name}`);
        if (loadedFiles.windows) info.push(`Windows: ${loadedFiles.windows.info.name}`);
        if (loadedFiles.segments) info.push(`Segments: ${loadedFiles.segments.info.name}`);

        fileInfoText.innerHTML = `<strong>Loaded Files:</strong> ${info.join(' | ')}`;
        fileInfoDiv.style.display = 'block';
    } else {
        fileInfoDiv.style.display = 'none';
    }
}

async function autoLoadFiles() {
    try {
        setStatus('Loading required files...');

        const response = await fetch('/segments/auto-load');
        const data = await response.json();

        if (data.status === 'ok') {
            const loadedFiles = data.loaded_files;
            // showFileInfo(loadedFiles);

            // Process JSONL file
            if (loadedFiles.jsonl) {
                const content = loadedFiles.jsonl.content;
                const lines = content.trim().split('\n');
                jsonlMap = {};

                for (const line of lines) {
                    if (line.trim()) {
                        try {
                            const item = JSON.parse(line);
                            const basename = item.seq_id || 'unknown';
                            if (!jsonlMap[basename]) {
                                jsonlMap[basename] = [];
                            }
                            jsonlMap[basename].push(item);
                        } catch (e) {
                            console.warn('JSON parsing error:', e, line);
                        }
                    }
                }

                // Merge all items into frames array
                frames = [];
                Object.values(jsonlMap).forEach(items => {
                    frames.push(...items);
                });

                setStatus(`JSONL file loaded: ${frames.length} frames`);
            }

            // Process Windows file
            if (loadedFiles.windows) {
                try {
                    windowsIndex = JSON.parse(loadedFiles.windows.content);
                    setStatus(`Windows file loaded: ${windowsIndex.num_windows || 0} windows`);
                } catch (e) {
                    setStatus('Windows file parsing error');
                    return;
                }
            }

            // Process Segments file (original)
            if (loadedFiles.segments) {
                try {
                    const segmentsData = JSON.parse(loadedFiles.segments.content);
                    segments = segmentsData.segments || segmentsData;
                    window.loadedSegmentsPath = loadedFiles.segments.info?.path || null;
                    setStatus(`Segments file loaded: ${segments.length} segments`);

                    // Initialize label filtering
                    updateLabelCounts();
                    // Select all labels by default
                    selectedLabels.clear();
                    Object.keys(labelCounts).forEach(label => selectedLabels.add(label));
                    renderLabelFilters();
                    updateFilteredSegments();

                    // Update segment list
                    renderSegList();

                    // Show distance section
                    distanceSection.style.display = 'block';
                } catch (e) {
                    setStatus('Segments file parsing error');
                    return;
                }
            }
            // Process Segments Final file (optional)
            if (loadedFiles.segments_final) {
                try {
                    const segmentsData = JSON.parse(loadedFiles.segments_final.content);
                    finalSegments = segmentsData.segments || segmentsData;
                    window.loadedFinalSegmentsPath = loadedFiles.segments_final.info?.path || null;
                } catch (e) {
                    console.warn('Segments Final file parsing error');
                }
            }

            // Initialize renderer (when JSONL is loaded)
            if (loadedFiles.jsonl && frames.length > 0) {
                if (!renderer) {
                    renderer = new Renderer(overlay);
                }

                const w = parseInt(frames[0].width || 820, 10);
                const h = parseInt(frames[0].height || 616, 10);
                renderer.initialize(w, h);
                renderer.setRenderOptions({ showKeypoints: true, showSkeleton: true, smoothing: true, interpolation: true });

                frameSlider.max = frames.length - 1;
                frameSlider.value = 0;
                updateFrameLabel();

                playSegBtn.disabled = false;
                const segCount = usingFinal ? (finalSegments?.length || 0) : (segments ? segments.length : 0);
                setStatus(`All files loaded! Frames: ${frames.length}, Segments: ${segCount}`);
            } else {
                setStatus('JSONL file not found.');
            }

        } else {
            setStatus('Load failed');
        }
    } catch (error) {
        console.error('Load error:', error);
        setStatus('An error occurred while loading files.');
    }
}

// Source switch handler
if (segmentSource) {
    segmentSource.addEventListener('change', () => {
        usingFinal = (segmentSource.value === 'final');
        // Selection mode: only allowed in original, disabled in final
        if (playSelectedBtn) playSelectedBtn.disabled = usingFinal || selectedSegIndices.size === 0;
        // Replace segments
        if (usingFinal && finalSegments) {
            segments = finalSegments;
        } else if (!usingFinal && Array.isArray(finalSegments)) {
            // switch back to original if available
            // original already in segments
        }
        // Re-render list and UI
        selectedSegIndices.clear();
        updateLabelCounts();
        renderLabelFilters();
        updateFilteredSegments();
        renderSegList();
        setStatus(`Source switched: ${usingFinal ? 'Final' : 'Original/Representative'} segments`);
    });
}

// Helpers: timers/reset/init
function clearTimers() {
    if (timer) { clearTimeout(timer); timer = null; }
    if (autoTimer) { clearTimeout(autoTimer); autoTimer = null; }
}

function resetPlaybackState() {
    clearTimers();
    playing = false;
    paused = true;
    idx = 0;
    currentBlend = null;
    lastFrameIdx = null;
    if (frameSlider) { frameSlider.min = '0'; frameSlider.max = '0'; frameSlider.value = '0'; }
    if (frameLabel) { frameLabel.textContent = '0/0'; }
}

function ensureRendererInitialized() {
    if (renderer) return;
    let item = null;
    const files = Object.values(jsonlMap);
    for (let i = 0; i < files.length; i++) {
        const arr = files[i];
        if (arr && arr.length) { item = arr[0]; break; }
    }
    const w = parseInt(item?.width || overlay.width || 820, 10);
    const h = parseInt(item?.height || overlay.height || 616, 10);

    renderer = new Renderer(overlay);
    renderer.initialize(w, h);
    renderer.setRenderOptions({ showKeypoints: true, showSkeleton: true, smoothing: true, interpolation: true });
}

function blendKeypoints(k1, k2, a) {
    const out = new Array(17);
    for (let i = 0; i < 17; i++) out[i] = [(1 - a) * k1[i][0] + a * k2[i][0], (1 - a) * k1[i][1] + a * k2[i][1], (1 - a) * (k1[i][2] || 1) + a * (k2[i][2] || 1)];
    return out;
}

function renderFrame(item) {
    // 안전성 검사
    if (!item) {
        console.warn('renderFrame: item이 undefined입니다.');
        return;
    }

    let k = denorm(item);
    if (currentBlend && currentBlend.active) {
        const a = currentBlend.nextAlpha();
        if (a >= 0) k = blendKeypoints(currentBlend.prev, k, a);
        else currentBlend = null;
    }
    const W = (item && typeof item.width !== 'undefined') ? item.width : overlay.width;
    const H = (item && typeof item.height !== 'undefined') ? item.height : overlay.height;
    if (renderer) {
        if (typeof renderer.resize === 'function') renderer.resize(W, H);
        renderer.render({ kpts: k, W, H });
    }
}

function playRange(s, e, onComplete) {
    idx = s; playing = true; paused = false;
    if (frameSlider) { frameSlider.min = '0'; frameSlider.max = String(e - s); frameSlider.value = '0'; }
    if (frameLabel) frameLabel.textContent = `1/${e - s + 1}`;
    const step = () => {
        if (!playing || paused) return;
        if (idx > e) {
            playing = false;
            if (onComplete) onComplete();
            return;
        }
        const speed = Number(speedSelect.value || 1);
        const prev = idx > 0 ? frames[idx - 1] : null;
        const cur = frames[idx];

        // 안전성 검사
        if (!cur) {
            console.warn(`Frame ${idx} does not exist. Stopping playback.`);
            playing = false;
            return;
        }

        renderFrame(cur);
        const delay = schedule(prev, cur, speed);
        // update frame progress badge
        if (segBadge) {
            const curFrame = (idx - s + 1);
            const totalFrames = (e - s + 1);
            segBadge.textContent = `${currentSegText} | Frame: ${curFrame}/${totalFrames}`;
        }
        if (frameSlider) frameSlider.value = String(idx - s);
        if (frameLabel) frameLabel.textContent = `${idx - s + 1}/${e - s + 1}`;
        idx += 1;
        timer = setTimeout(step, Math.max(0, delay * 1000));
    };
    step();
}

function startAuto() {
    if (!segments || !segments.length) return;
    if (!windowsIndex || !windowsIndex.windows || !windowsIndex.files) { setStatus('Please load windows_index.json first'); return; }
    clearTimers(); currentBlend = null; lastFrameIdx = null;
    // Original/Final common: use filtered list if filter exists
    let list = (filteredSegments && filteredSegments.length) ? [...filteredSegments] : [...segments];
    if (!list.length) { setStatus('No segments available.'); return; }
    if (smartOrder && smartOrder.checked) list = reorder(list, windowsIndex, jsonlMap); else list.sort((a, b) => a.start - b.start);
    // Use same chain/blending logic as selected playback (remove duplicate frames)
    playSegmentsList(list);
}

function stopAuto() { if (autoTimer) clearTimeout(autoTimer); playing = false; playSegBtn.disabled = false; stopSegBtn.disabled = true; }

function updateFrameLabel() {
    if (frameLabel && frames.length > 0) {
        frameLabel.textContent = `${idx + 1}/${frames.length}`;
    }
}

// Auto-load event listener
autoLoadBtn.addEventListener('click', () => {
    autoLoadFiles();
});

// Distance calculation related event listeners
calculateDistancesBtn.addEventListener('click', calculateDistances);
loadDistancesBtn.addEventListener('click', loadDistances);

playSegBtn.addEventListener('click', startAuto);
stopSegBtn.addEventListener('click', stopAuto);
if (typeof playSelectedBtn !== 'undefined' && playSelectedBtn) {
    playSelectedBtn.addEventListener('click', playSelectedSegments);
    playSelectedBtn.disabled = true;
}
if (typeof playRandomBtn !== 'undefined' && playRandomBtn) {
    playRandomBtn.addEventListener('click', playRandomNearestSegments);
}

// Label filtering event listener
showAllLabels.addEventListener('change', () => {
    if (showAllLabels.checked) {
        // Select all labels
        selectedLabels.clear();
        Object.keys(labelCounts).forEach(label => selectedLabels.add(label));
    } else {
        // Deselect all
        selectedLabels.clear();
    }
    updateFilteredSegments();
    renderSegList();
    renderLabelFilters(); // Update checkbox state
});

function renderSegList() {
    if (!segList) return;
    segList.innerHTML = '';
    if (!segments || !segments.length) { segList.textContent = 'No segments'; return; }

    // Use filtered segments
    const segmentsToShow = filteredSegments;
    if (!segmentsToShow.length) {
        segList.textContent = 'No segments for selected labels';
        return;
    }

    const ul = document.createElement('ul'); ul.style.listStyle = 'none'; ul.style.padding = '0'; ul.style.margin = '0';
    segmentsToShow.forEach((seg, i) => {
        // Find original segment index
        const originalIndex = segments.indexOf(seg);
        const li = document.createElement('li');
        li.style.margin = '6px 0';
        li.style.display = 'flex';
        li.style.flexDirection = 'column';
        li.style.gap = '4px';

        // Top row: checkbox + button
        const topRow = document.createElement('div');
        topRow.style.display = 'flex';
        topRow.style.alignItems = 'center';
        topRow.style.gap = '6px';

        const checkbox = document.createElement('input');
        checkbox.type = 'checkbox';
        checkbox.id = `seg-checkbox-${i}`;
        checkbox.checked = selectedSegIndices.has(originalIndex);
        checkbox.addEventListener('change', () => {
            if (checkbox.checked) {
                selectedSegIndices.add(originalIndex);
            } else {
                selectedSegIndices.delete(originalIndex);
            }
            if (playSelectedBtn) playSelectedBtn.disabled = selectedSegIndices.size === 0;
        });

        const btn = document.createElement('button');
        btn.textContent = `#${i + 1} [${seg.start}-${seg.end}] L=${typeof seg.label !== 'undefined' ? seg.label : '-'}`;
        btn.style.textAlign = 'left';
        btn.style.fontSize = '12px';
        btn.style.flex = '1';
        btn.style.minWidth = '0';
        btn.onclick = () => playSingleSegment(originalIndex);

        if (!usingFinal) topRow.appendChild(checkbox);
        topRow.appendChild(btn);
        li.appendChild(topRow);

        // Bottom row: nearest segment badges (only when available)
        const embedded = getEmbeddedNearestFor(originalIndex);
        const nearest = embedded || (nearestSegments ? nearestSegments[originalIndex] : null);
        if (nearest && nearest.length) {
            const distanceRow = document.createElement('div');
            distanceRow.style.display = 'flex';
            distanceRow.style.alignItems = 'center';
            distanceRow.style.gap = '6px';
            distanceRow.style.flexWrap = 'wrap';
            distanceRow.style.fontSize = '10px';
            distanceRow.style.color = '#9ca3af';

            const label = document.createElement('span');
            label.textContent = 'Nearest segments:';
            distanceRow.appendChild(label);

            // Display nicely with badge style
            nearest.slice(0, 6).forEach(n => {
                const badge = document.createElement('span');
                badge.textContent = `#${n.segment_index + 1} (${Number(n.distance).toFixed(3)})`;
                badge.style.background = '#111827';
                badge.style.border = '1px solid #1f2937';
                badge.style.borderRadius = '9999px';
                badge.style.padding = '2px 6px';
                badge.style.color = '#9ca3af';
                distanceRow.appendChild(badge);
            });

            li.appendChild(distanceRow);
        }

        ul.appendChild(li);
    });
    segList.appendChild(ul);
}

function playSingleSegment(index) {
    if (!segments || index < 0 || index >= segments.length) return;
    clearTimers();
    const seg = segments[index];
    currentSegText = `Segment: ${index + 1}/${segments.length} [${seg.start}-${seg.end}] label=${typeof seg.label !== 'undefined' ? seg.label : '-'}`;
    if (segBadge) segBadge.textContent = currentSegText;
    prepareFramesForSegment(seg);
    ensureRendererInitialized();
    playRange(0, frames.length - 1);
}

function prepareFramesForSegment(seg) {
    if (!windowsIndex || !windowsIndex.windows) return;
    frames = [];
    const ws = seg.start, we = seg.end;

    // Continuously add from first window's start frame to last window's end frame
    if (ws <= we && windowsIndex.windows[ws] && windowsIndex.windows[we]) {
        const firstWindow = windowsIndex.windows[ws];
        const lastWindow = windowsIndex.windows[we];
        const base = firstWindow.file.replace(/\.jsonl$/, '');
        const arr = jsonlMap[base];

        if (arr) {
            const startFrame = firstWindow.start;
            const endFrame = lastWindow.start + (windowsIndex.stride || 8) - 1;

            for (let fi = startFrame; fi <= endFrame && fi < arr.length; fi++) {
                frames.push(arr[fi]);
            }
        }
    }
}

function playSelectedSegments() {
    if (!segments || selectedSegIndices.size === 0) {
        setStatus('No segments selected.');
        return;
    }
    if (!windowsIndex || !windowsIndex.windows || !windowsIndex.files) { setStatus('Please load windows_index.json first'); return; }
    clearTimers(); currentBlend = null; lastFrameIdx = null;
    let list = Array.from(selectedSegIndices).map(i => segments[i]);
    if (smartOrder && smartOrder.checked) list = reorder(list); else list.sort((a, b) => a.start - b.start);
    playSegmentsList(list);
}

// Core chain builder/runner reused by selected/random flows
function playSegmentsList(list) {
    if (!list || !list.length) { setStatus('No segments available.'); return; }

    // 1) Concatenate frames from each segment, 2) Insert blending frames between segments
    const combined = [];
    const T = windowsIndex.window || 32;
    const blendN = Math.max(0, Math.floor(Number(blendFramesInput?.value || 8)));

    // scale-only chaining: match boundary sizes
    const doBlend = (smoothBoundary && smoothBoundary.checked) ? blendN : 0;
    const stitched = chainSegments(windowsIndex, jsonlMap, list, doBlend, overlay.width || 820, overlay.height || 616);
    combined.push(...stitched);

    // Single continuous playback
    frames = combined;
    currentSegText = `Selected playback: ${list.length} segments chained (blending ${blendN} frames)`;
    if (segBadge) segBadge.textContent = currentSegText;
    ensureRendererInitialized();
    playSegBtn.disabled = true; stopSegBtn.disabled = false;
    playRange(0, frames.length - 1, () => { playSegBtn.disabled = false; stopSegBtn.disabled = true; });
}

function playRandomNearestSegments() {
    if (!segments || !segments.length) { setStatus('No segments available.'); return; }
    const source = (filteredSegments && filteredSegments.length) ? filteredSegments : segments;
    // Build allowed original indices set
    const allowed = new Set(source.map(seg => segments.indexOf(seg)).filter(i => i >= 0));
    const maxK = Math.min(10, allowed.size);
    if (maxK === 0) { setStatus('No segments available.'); return; }
    // pick random start
    const allowedArr = Array.from(allowed);
    let cur = allowedArr[Math.floor(Math.random() * allowedArr.length)];
    const visited = new Set([cur]);
    const orderIdx = [cur];
    while (orderIdx.length < maxK) {
        let candidates = [];
        const embedded = getEmbeddedNearestFor(cur);
        if (embedded && embedded.length) {
            candidates = embedded.map(n => n.segment_index)
                .filter(i => allowed.has(i) && !visited.has(i))
                .slice(0, 3);
        } else if (nearestSegments && nearestSegments[cur]) {
            // nearestSegments[cur] = [{segment_index, distance}, ...]
            candidates = nearestSegments[cur]
                .map(n => n.segment_index)
                .filter(i => allowed.has(i) && !visited.has(i))
                .slice(0, 3);
        }
        if (!candidates.length) {
            // fallback: random from remaining allowed
            const remaining = allowedArr.filter(i => !visited.has(i));
            if (!remaining.length) break;
            cur = remaining[Math.floor(Math.random() * remaining.length)];
        } else {
            cur = candidates[Math.floor(Math.random() * candidates.length)];
        }
        visited.add(cur);
        orderIdx.push(cur);
    }
    const list = orderIdx.map(i => segments[i]);
    clearTimers(); currentBlend = null; lastFrameIdx = null;
    playSegmentsList(list);
}

// Save final list
async function saveFinalSegments() {
    try {
        if (!segments) { setStatus('No segments available.'); return; }
        const include = Array.from(selectedSegIndices);
        const payload = {
            base_segments_path: (window.loadedSegmentsPath || 'training/runs/segments_representative.json'),
            embeddings_path: 'training/runs/embeddings.npy',
            output_path: 'training/runs/segments_final.json',
            include_indices: include,
            top_k: parseInt(topK?.value || '3', 10)
        };
        const res = await fetch('/segments/save-final', {
            method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload)
        });
        const j = await res.json();
        if (!res.ok) { setStatus(`Failed to save final segments: ${j.error || res.status}`); return; }
        setStatus(`Final segments saved (${j.num_segments}): ${j.saved_path}`);
    } catch (e) {
        console.error(e); setStatus('Error occurred while saving final segments');
    }
}

if (saveFinalBtn) { saveFinalBtn.addEventListener('click', saveFinalSegments); }

// Slider seek
if (frameSlider) {
    frameSlider.addEventListener('input', () => {
        if (!frames || frames.length === 0) return;
        const pos = parseInt(frameSlider.value || '0', 10);
        if (frameLabel) frameLabel.textContent = `${pos + 1}/${frames.length}`;
        // 실시간 렌더링
        playing = false; paused = true; if (timer) clearTimeout(timer);
        idx = pos;
        const item = frames[idx];
        if (item) renderFrame(item);
    });
    frameSlider.addEventListener('change', () => {
        if (!frames || frames.length === 0) return;
        const pos = parseInt(frameSlider.value || '0', 10);
        // pause and render this frame
        playing = false; paused = true; if (timer) clearTimeout(timer);
        idx = pos;
        const item = frames[idx];
        renderFrame(item);
    });
}
