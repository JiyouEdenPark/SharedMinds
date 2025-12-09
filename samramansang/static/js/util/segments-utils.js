// Shared utilities for segment stitching, blending, ordering, and timing

export function getNormKpts(item){
    const w = Number(item?.width||0), h = Number(item?.height||0);
    const k = (item?.kpts || item?.keypoints || []);
    if (!Array.isArray(k) || k.length===0) return [];
    const norm = (Array.isArray(k[0]) && k[0].length>=2 && k[0][0] <= 1.1 && k[0][1] <= 1.1);
    const out = new Array(17);
    for (let i=0;i<17;i++){
        const ki = k[i] || [0,0,0];
        const x = norm ? Number(ki[0]) : (w>0 ? Number(ki[0])/w : 0);
        const y = norm ? Number(ki[1]) : (h>0 ? Number(ki[1])/h : 0);
        const s = ki.length>2 ? Number(ki[2]) : 1.0;
        out[i] = [x,y,s];
    }
    return out;
}

function measureHipWidthFromK(k){
    const L=11, R=12; if (!k || !k[L] || !k[R]) return 0;
    const ax=Number(k[L][0]||0), ay=Number(k[L][1]||0);
    const bx=Number(k[R][0]||0), by=Number(k[R][1]||0);
    return Math.hypot(ax-bx, ay-by);
}

function measureShoulderWidthFromK(k){
    const L=5, R=6; if (!k || k.length<7) return 0;
    const ax=Number(k[L]?.[0]||0), ay=Number(k[L]?.[1]||0);
    const bx=Number(k[R]?.[0]||0), by=Number(k[R]?.[1]||0);
    return Math.hypot(ax-bx, ay-by);
}

function measureTorsoHeightFromK(k){
    const NECK=1, HIP=11; if (!k || k.length<12) return 0;
    const ax=Number(k[NECK]?.[0]||0), ay=Number(k[NECK]?.[1]||0);
    const bx=Number(k[HIP]?.[0]||0), by=Number(k[HIP]?.[1]||0);
    return Math.hypot(ax-bx, ay-by);
}

function measureSpreadFromK(k){
    const LA=15, RA=16; if (!k || k.length<17) return 0;
    const ax=Number(k[LA]?.[0]||0), ay=Number(k[LA]?.[1]||0);
    const bx=Number(k[RA]?.[0]||0), by=Number(k[RA]?.[1]||0);
    return Math.hypot(ax-bx, ay-by);
}

export function robustScaleRatio(prevK0, nextK0){
    const eps=1e-6; const ratios=[];
    const swP = measureShoulderWidthFromK(prevK0), swN = measureShoulderWidthFromK(nextK0); if (swP>eps && swN>eps) ratios.push(swP/swN);
    const hwP = measureHipWidthFromK(prevK0), hwN = measureHipWidthFromK(nextK0); if (hwP>eps && hwN>eps) ratios.push(hwP/hwN);
    const thP = measureTorsoHeightFromK(prevK0), thN = measureTorsoHeightFromK(nextK0); if (thP>eps && thN>eps) ratios.push(thP/thN);
    const spP = measureSpreadFromK(prevK0), spN = measureSpreadFromK(nextK0); if (spP>eps && spN>eps) ratios.push(spP/spN);
    if (ratios.length===0) return 1.0;
    let best = ratios[0]; let bestCost = Math.abs(Math.log(Math.max(eps, best)));
    for (let i=1;i<ratios.length;i++){
        const r = ratios[i]; const c = Math.abs(Math.log(Math.max(eps, r)));
        if (c < bestCost) { best = r; bestCost = c; }
    }
    return Math.max(0.5, Math.min(2.0, best));
}

export function anchorFromK(k){
    const L_SHO=5, R_SHO=6, L_HIP=11, R_HIP=12;
    const pts=[]; [L_SHO,R_SHO,L_HIP,R_HIP].forEach(i=>{ if (k[i]) pts.push(k[i]); });
    if (!pts.length) return [0.5,0.5];
    const ax = pts.reduce((s,p)=>s+Number(p[0]||0),0)/pts.length;
    const ay = pts.reduce((s,p)=>s+Number(p[1]||0),0)/pts.length;
    return [ax, ay];
}

export function getWindowEdgeFrame(windowsIndex, jsonlMap, windowIndex, fromEnd){
    if (!windowsIndex || !windowsIndex.windows || windowIndex<0 || windowIndex>=windowsIndex.windows.length) return null;
    const T = windowsIndex.window || 32;
    const wrec = windowsIndex.windows[windowIndex];
    if (!wrec) return null;
    const base = (wrec.file || '').replace(/\.jsonl$/, ''); const start = Number(wrec.start||0);
    const arr = jsonlMap[base];
    if (!arr || !arr.length) return null;
    const fi = fromEnd ? (start + T - 1) : start;
    if (fi < 0 || fi >= arr.length) return null;
    return arr[fi];
}

export function createBlendFramesScaled(prevItem, prevScale, prevOffset, nextItem, nextScale, nextOffset, n){
    if (!prevItem || !nextItem || n<=0) return [];
    const w = Number(nextItem?.width||prevItem?.width||1280);
    const h = Number(nextItem?.height||prevItem?.height||720);
    const a0 = getNormKpts(prevItem);
    const b0 = getNormKpts(nextItem);
    if (a0.length===0 || b0.length===0) return [];
    const px = (prevOffset && prevOffset.length===2) ? Number(prevOffset[0]) : 0;
    const py = (prevOffset && prevOffset.length===2) ? Number(prevOffset[1]) : 0;
    const a = a0.map(p => [ Math.max(0, Math.min(1, Number(p[0])*prevScale + px)), Math.max(0, Math.min(1, Number(p[1])*prevScale + py)), p.length>2?Number(p[2]):1.0 ]);
    const dx = (nextOffset && nextOffset.length===2) ? Number(nextOffset[0]) : 0;
    const dy = (nextOffset && nextOffset.length===2) ? Number(nextOffset[1]) : 0;
    const b = b0.map(p => [ Math.max(0, Math.min(1, Number(p[0])*nextScale + dx)), Math.max(0, Math.min(1, Number(p[1])*nextScale + dy)), p.length>2?Number(p[2]):1.0 ]);
    const out = [];
    for (let i=1;i<=n;i++){
        const t = i/(n+1); const k = new Array(17);
        for (let j=0;j<17;j++){
            const ax=a[j]||[0,0,1], bx=b[j]||[0,0,1];
            const x=(1-t)*ax[0]+t*bx[0], y=(1-t)*ax[1]+t*bx[1], s=(1-t)*(ax[2]||1)+t*(bx[2]||1);
            k[j] = [x,y,s];
        }
        out.push({ width:w, height:h, kpts:k, fps: nextItem.fps||prevItem.fps||30 });
    }
    return out;
}

export function denorm(item){
    if (!item) return [];
    const w = Number(item.width||0), h=Number(item.height||0);
    const k = (item.kpts || item.keypoints || []);
    if (!Array.isArray(k) || k.length===0) return [];
    const norm = (Array.isArray(k[0]) && k[0].length>=2 && k[0][0] <= 1.1 && k[0][1] <= 1.1);
    const out = new Array(17);
    for (let i=0;i<17;i++){
        const ki = k[i] || [0,0,0];
        const x = norm ? Math.round(Number(ki[0])*w) : Math.round(Number(ki[0]));
        const y = norm ? Math.round(Number(ki[1])*h) : Math.round(Number(ki[1]));
        const s = ki.length>2 ? Number(ki[2]) : 1.0;
        out[i] = [x,y,s];
    }
    return out;
}

export function centroid(windowsIndex, jsonlMap, seg){
    const itemA = getWindowEdgeFrame(windowsIndex, jsonlMap, seg.start, false);
    const itemB = getWindowEdgeFrame(windowsIndex, jsonlMap, seg.end, true);
    const a = denorm(itemA), b = denorm(itemB);
    const c = new Array(17);
    for (let i=0;i<17;i++){
        const ax = (a[i] && a[i].length>=2) ? a[i][0] : 0;
        const ay = (a[i] && a[i].length>=2) ? a[i][1] : 0;
        const bx = (b[i] && b[i].length>=2) ? b[i][0] : 0;
        const by = (b[i] && b[i].length>=2) ? b[i][1] : 0;
        c[i] = [ (ax+bx)*0.5, (ay+by)*0.5 ];
    }
    return c;
}

function distCentroid(c1,c2){ let s=0; for (let i=0;i<17;i++){ const p1=c1[i]||[0,0], p2=c2[i]||[0,0]; const dx=p1[0]-p2[0], dy=p1[1]-p2[1]; s+=dx*dx+dy*dy; } return Math.sqrt(s/17); }

export function reorder(segs, windowsIndex, jsonlMap){
    if(!segs.length) return segs;
    const cents=segs.map(s => centroid(windowsIndex, jsonlMap, s));
    const used=new Array(segs.length).fill(false);
    const out=[]; let cur=0; used[0]=true; out.push(segs[0]);
    for(let k=1;k<segs.length;k++){
        let best=-1,b=Infinity;
        for(let i=0;i<segs.length;i++) if(!used[i]){
            const d=distCentroid(cents[cur],cents[i]); if(d<b){b=d; best=i;}
        }
        used[best]=true; out.push(segs[best]); cur=best;
    }
    return out;
}

export function schedule(prev, cur, speed, fallbackFps=30){
    let dt = null;
    if (cur && typeof cur.fps === 'number' && cur.fps > 0) {
        dt = 1.0/cur.fps;
    } else if (prev && typeof prev.ts==='number' && typeof cur.ts==='number') {
        dt = Math.max(0,(cur.ts-prev.ts)/1000);
    } else {
        dt = 1.0/Math.max(1.0, fallbackFps);
    }
    return dt/Math.max(1e-6, speed||1.0);
}

// Append frames of a segment into a combined array, stitching windows and applying scale/offset
export function appendSegmentFrames(windowsIndex, jsonlMap, seg, segScale, segOffset, combined, fallbackW=1280, fallbackH=720){
    if (!windowsIndex || !windowsIndex.windows || !jsonlMap || !seg) return;
    const T = windowsIndex.window || 32;
    const ws = Number(seg.start||0), we = Number(seg.end||ws);
    if (ws>we) return;
    let prevBase = null; let prevEnd = -1;
    for (let wi = ws; wi <= we; wi++){
        const wrec = windowsIndex.windows[wi]; if (!wrec) continue;
        const base = (wrec.file ? wrec.file.replace(/\.jsonl$/, '') : '');
        const arr = jsonlMap[base]; if (!arr) { prevBase = null; prevEnd = -1; continue; }
        const startFrame = Number(wrec.start||0);
        const endFrame = startFrame + T - 1;
        let sfi = startFrame;
        if (prevBase === base && prevEnd >= 0) sfi = Math.max(sfi, prevEnd + 1);
        for (let fi = sfi; fi <= endFrame && fi < arr.length; fi++){
            const item = arr[fi];
            const k = getNormKpts(item);
            const sk = new Array(17);
            const dx = (segOffset && segOffset.length===2) ? Number(segOffset[0]) : 0;
            const dy = (segOffset && segOffset.length===2) ? Number(segOffset[1]) : 0;
            for (let j=0;j<17;j++){
                const p = k[j] || [0,0,1];
                const x = Math.max(0, Math.min(1, Number(p[0]) * segScale + dx));
                const y = Math.max(0, Math.min(1, Number(p[1]) * segScale + dy));
                const s = p.length>2 ? Number(p[2]) : 1.0;
                sk[j] = [x,y,s];
            }
            const W = Number(item.width||fallbackW), H = Number(item.height||fallbackH);
            combined.push({ width: W, height: H, kpts: sk, fps: item.fps, ts: item.ts });
        }
        prevBase = base; prevEnd = endFrame;
    }
}

// Build a combined frames array by chaining segments with boundary scaling, anchor alignment, and optional blending
export function chainSegments(windowsIndex, jsonlMap, list, blendN=8, fallbackW=1280, fallbackH=720){
    const combined = [];
    if (!Array.isArray(list) || list.length === 0) return combined;
    let prevScale = 1.0;
    let prevOffset = [0,0];
    for (let i=0;i<list.length;i++){
        const seg = list[i];
        let segScale = prevScale;
        let segOffset = [0,0];
        if (i>0){
            const prevSeg = list[i-1];
            const prevEndItem = getWindowEdgeFrame(windowsIndex, jsonlMap, prevSeg.end, true);
            const nextStartItem = getWindowEdgeFrame(windowsIndex, jsonlMap, seg.start, false);
            const prevK0 = getNormKpts(prevEndItem);
            const nextK0 = getNormKpts(nextStartItem);
            const sBoundary = robustScaleRatio(prevK0, nextK0);
            segScale = prevScale * sBoundary;
            const prevScaledK = prevK0.map(p => [Number(p[0])*prevScale + (prevOffset?.[0]||0), Number(p[1])*prevScale + (prevOffset?.[1]||0), p.length>2?Number(p[2]):1.0]);
            const nextScaledK = nextK0.map(p => [Number(p[0])*segScale, Number(p[1])*segScale, p.length>2?Number(p[2]):1.0]);
            const aPrev = anchorFromK(prevScaledK);
            const aNext = anchorFromK(nextScaledK);
            segOffset = [ aPrev[0] - aNext[0], aPrev[1] - aNext[1] ];
            if (blendN && blendN>0){
                const blends = createBlendFramesScaled(prevEndItem, prevScale, prevOffset, nextStartItem, segScale, segOffset, blendN);
                combined.push(...blends);
            }
        }
        appendSegmentFrames(windowsIndex, jsonlMap, seg, segScale, segOffset, combined, fallbackW, fallbackH);
        prevScale = segScale;
        prevOffset = segOffset;
    }
    return combined;
}

// Check if normalized pose would be out of bounds when rendered
export function checkPoseInBounds(normKpts, canvasW=1280, canvasH=720, maxHeightRatio=0.8, minConfidence=0.2){
    if (!normKpts || !Array.isArray(normKpts) || normKpts.length === 0) return false;

    // First pass: Check if ALL keypoints have sufficient confidence
    for (let i = 0; i < normKpts.length; i++) {
        const kpt = normKpts[i];
        if (!kpt || !Array.isArray(kpt) || kpt.length < 2) return false;

        const conf = kpt.length > 2 ? Number(kpt[2]) : 1.0;

        // All keypoints must have sufficient confidence
        if (conf < minConfidence) {
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
        const screenY = y * canvasH;
        minY = Math.min(minY, screenY);
        maxY = Math.max(maxY, screenY);
    }

    // Check if all keypoints are within bounds
    if (!allInBounds) return false;

    // Calculate pose height
    const poseHeight = maxY - minY;
    const maxAllowedHeight = canvasH * maxHeightRatio;

    // Check if pose height is less than maxHeightRatio of screen height
    return poseHeight < maxAllowedHeight;
}

// Streaming chain controller: incrementally appends next segment frames with proper boundary blending
export function makeStreamingChain(windowsIndex, jsonlMap, segments, options = {}){
    const cfg = {
        blendN: typeof options.blendN === 'number' ? options.blendN : 8,
        bufferLow: typeof options.bufferLow === 'number' ? options.bufferLow : 240,
        bufferTarget: typeof options.bufferTarget === 'number' ? options.bufferTarget : 720,
        compactThreshold: typeof options.compactThreshold === 'number' ? options.compactThreshold : 1000,
        compactKeepPrev: typeof options.compactKeepPrev === 'number' ? options.compactKeepPrev : 2,
        reorder: (typeof options.reorder === 'boolean') ? options.reorder : true,
        preferEmbeddedNext: (typeof options.preferEmbeddedNext === 'boolean') ? options.preferEmbeddedNext : true,
        candidatePick: (options.candidatePick === 'random' || options.candidatePick === 'best') ? options.candidatePick : 'random',
        checkBounds: typeof options.checkBounds === 'boolean' ? options.checkBounds : false,
        canvasW: typeof options.canvasW === 'number' ? options.canvasW : 1280,
        canvasH: typeof options.canvasH === 'number' ? options.canvasH : 720,
        maxHeightRatio: typeof options.maxHeightRatio === 'number' ? options.maxHeightRatio : 0.8,
        minConfidence: typeof options.minConfidence === 'number' ? options.minConfidence : 0.2,
        checkBoundsSampleRate: typeof options.checkBoundsSampleRate === 'number' ? options.checkBoundsSampleRate : 1, // Check every Nth frame (1 = all frames)
    };

    let orderedSegments = [];
    let nextSegIdx = 0;
    let prevSeg = null;
    let prevSegIdx = -1; // index in original segments array
    let prevScale = 1.0;
    let prevOffset = [0,0];

    function hasWindows(){ return !!(windowsIndex && windowsIndex.windows && windowsIndex.files); }

    function ensureOrder(){
        if (!Array.isArray(segments) || segments.length===0){ orderedSegments = []; return; }
        orderedSegments = [...segments];
        if (cfg.reorder && orderedSegments.length>1 && hasWindows()) orderedSegments = reorder(orderedSegments, windowsIndex, jsonlMap);
        nextSegIdx = 0;
    }

    function checkSegmentInBounds(seg){
        if (!cfg.checkBounds || !hasWindows()) return true; // Skip check if disabled or no windows
        if (!seg) return false;
        
        // Calculate scale and offset that would be applied to this segment
        let segScale = prevScale;
        let segOffset = [0,0];
        
        if (prevSeg){
            const prevEndItem = getWindowEdgeFrame(windowsIndex, jsonlMap, prevSeg.end, true);
            const nextStartItem = getWindowEdgeFrame(windowsIndex, jsonlMap, seg.start, false);
            if (prevEndItem && nextStartItem){
                const prevK0 = getNormKpts(prevEndItem);
                const nextK0 = getNormKpts(nextStartItem);
                const sBoundary = robustScaleRatio(prevK0, nextK0);
                segScale = prevScale * sBoundary;
                const prevScaledK = prevK0.map(p => [Number(p[0])*prevScale + (prevOffset?.[0]||0), Number(p[1])*prevScale + (prevOffset?.[1]||0), p.length>2?Number(p[2]):1.0]);
                const nextScaledK = nextK0.map(p => [Number(p[0])*segScale, Number(p[1])*segScale, p.length>2?Number(p[2]):1.0]);
                const aPrev = anchorFromK(prevScaledK);
                const aNext = anchorFromK(nextScaledK);
                segOffset = [ aPrev[0] - aNext[0], aPrev[1] - aNext[1] ];
            }
        }
        
        // Check all frames in the segment (or sample them based on checkBoundsSampleRate)
        const T = windowsIndex.window || 32;
        const ws = Number(seg.start||0), we = Number(seg.end||ws);
        if (ws > we) return true; // Invalid segment
        
        let prevBase = null;
        let prevEnd = -1;
        let frameCount = 0;
        
        for (let wi = ws; wi <= we; wi++){
            const wrec = windowsIndex.windows[wi];
            if (!wrec) continue;
            
            const base = (wrec.file ? wrec.file.replace(/\.jsonl$/, '') : '');
            const arr = jsonlMap[base];
            if (!arr) {
                prevBase = null;
                prevEnd = -1;
                continue;
            }
            
            const startFrame = Number(wrec.start||0);
            const endFrame = startFrame + T - 1;
            let sfi = startFrame;
            if (prevBase === base && prevEnd >= 0) {
                sfi = Math.max(sfi, prevEnd + 1);
            }
            
            for (let fi = sfi; fi <= endFrame && fi < arr.length; fi++){
                // Sample frames based on checkBoundsSampleRate
                if (frameCount % cfg.checkBoundsSampleRate !== 0) {
                    frameCount++;
                    continue;
                }
                frameCount++;
                
                const item = arr[fi];
                if (!item) continue;
                
                // Get normalized keypoints
                const normKpts = getNormKpts(item);
                if (!normKpts || normKpts.length === 0) continue; // Skip if no keypoints
                
                // Apply scale and offset to normalized keypoints (same as in appendSegmentFrames)
                const scaledKpts = normKpts.map(p => {
                    const dx = (segOffset && segOffset.length===2) ? Number(segOffset[0]) : 0;
                    const dy = (segOffset && segOffset.length===2) ? Number(segOffset[1]) : 0;
                    const x = Math.max(0, Math.min(1, Number(p[0]) * segScale + dx));
                    const y = Math.max(0, Math.min(1, Number(p[1]) * segScale + dy));
                    const s = p.length>2 ? Number(p[2]) : 1.0;
                    return [x, y, s];
                });
                
                // Check if this frame would be out of bounds
                if (!checkPoseInBounds(scaledKpts, cfg.canvasW, cfg.canvasH, cfg.maxHeightRatio, cfg.minConfidence)){
                    return false; // Found a frame that would be out of bounds
                }
            }
            
            prevBase = base;
            prevEnd = endFrame;
        }
        
        // All checked frames are in bounds
        return true;
    }

    function chooseNextSegment(){
        // If we have embedded next_candidates on the previous segment, prefer them
        if (cfg.preferEmbeddedNext && prevSeg && Array.isArray(prevSeg.next_candidates) && prevSeg.next_candidates.length>0){
            const indices = prevSeg.next_candidates
                .map(n => ({ idx: Number(n.segment_index), distance: Number(n.distance||0) }))
                .filter(n => Number.isFinite(n.idx) && n.idx>=0 && n.idx < (segments?.length||0));
            if (indices.length){
                // Filter out segments that would be out of bounds
                const validIndices = indices.filter(n => {
                    const seg = segments[n.idx];
                    return checkSegmentInBounds(seg);
                });
                
                // If we have valid candidates, pick from them
                if (validIndices.length > 0){
                    if (cfg.candidatePick === 'random'){
                        const c = validIndices[Math.floor(Math.random()*validIndices.length)];
                        return segments[c.idx];
                    } else {
                        const sorted = validIndices.slice().sort((a,b) => a.distance - b.distance);
                        return segments[sorted[0].idx];
                    }
                }
                // If no valid candidates, try without bounds check (fallback)
                if (cfg.candidatePick === 'random'){
                    const c = indices[Math.floor(Math.random()*indices.length)];
                    return segments[c.idx];
                } else {
                    const sorted = indices.slice().sort((a,b) => a.distance - b.distance);
                    return segments[sorted[0].idx];
                }
            }
        }
        // Fallback to ordered list progression
        if (!orderedSegments || !orderedSegments.length) ensureOrder();
        
        // Try to find a valid segment from the ordered list
        if (cfg.checkBounds && orderedSegments && orderedSegments.length > 0){
            let searchIdx = nextSegIdx;
            let attempts = 0;
            const maxAttempts = orderedSegments.length;
            while (attempts < maxAttempts){
                const seg = orderedSegments[searchIdx];
                if (checkSegmentInBounds(seg)){
                    // Found valid segment, but don't update nextSegIdx here (it will be updated in appendNext)
                    return seg;
                }
                // Move to next segment for search (but don't update nextSegIdx)
                searchIdx++;
                if (searchIdx >= orderedSegments.length) searchIdx = 0;
                attempts++;
            }
            // If no valid segment found after checking all, return current one anyway
            return orderedSegments[nextSegIdx];
        }
        
        return orderedSegments[nextSegIdx];
    }

    function appendNext(frames, fallbackW=1280, fallbackH=720){
        if (!Array.isArray(segments) || segments.length===0) return;
        const seg = chooseNextSegment();
        if (!seg) return;
        if (!hasWindows()){
            // fallback: approximate segment by repeating endpoints
            const framesPerSeg = 30;
            for (let i=0;i<framesPerSeg;i++) frames.push({ width:fallbackW, height:fallbackH, kpts: [] });
        } else {
            let segScale = prevScale;
            let segOffset = [0,0];
            // If this is the first append (no prevSeg) and there is a last frame in frames,
            // align the first segment start to that last frame using scale/offset and optional blend
            if (!prevSeg && Array.isArray(frames) && frames.length > 0){
                const lastFrame = frames[frames.length - 1];
                const nextStartItem = getWindowEdgeFrame(windowsIndex, jsonlMap, seg.start, false);
                if (lastFrame && nextStartItem){
                    const prevK0 = getNormKpts(lastFrame);
                    const nextK0 = getNormKpts(nextStartItem);
                    const sBoundary = robustScaleRatio(prevK0, nextK0) || 1.0;
                    segScale = sBoundary;
                    const nextScaledK = nextK0.map(p => [ Number(p[0]) * segScale, Number(p[1]) * segScale, p.length>2?Number(p[2]):1.0 ]);
                    const aPrev = anchorFromK(prevK0);
                    const aNext = anchorFromK(nextScaledK);
                    segOffset = [ aPrev[0] - aNext[0], aPrev[1] - aNext[1] ];
                    if (cfg.blendN && cfg.blendN>0){
                        const blends = createBlendFramesScaled(lastFrame, 1.0, [0,0], nextStartItem, segScale, segOffset, cfg.blendN);
                        if (blends && blends.length) frames.push(...blends);
                    }
                }
            } else if (prevSeg){
                const prevEndItem = getWindowEdgeFrame(windowsIndex, jsonlMap, prevSeg.end, true);
                const nextStartItem = getWindowEdgeFrame(windowsIndex, jsonlMap, seg.start, false);
                if (prevEndItem && nextStartItem){
                    const prevK0 = getNormKpts(prevEndItem);
                    const nextK0 = getNormKpts(nextStartItem);
                    const sBoundary = robustScaleRatio(prevK0, nextK0);
                    segScale = prevScale * sBoundary;
                    const prevScaledK = prevK0.map(p => [Number(p[0])*prevScale + (prevOffset?.[0]||0), Number(p[1])*prevScale + (prevOffset?.[1]||0), p.length>2?Number(p[2]):1.0]);
                    const nextScaledK = nextK0.map(p => [Number(p[0])*segScale, Number(p[1])*segScale, p.length>2?Number(p[2]):1.0]);
                    const aPrev = anchorFromK(prevScaledK);
                    const aNext = anchorFromK(nextScaledK);
                    segOffset = [ aPrev[0] - aNext[0], aPrev[1] - aNext[1] ];
                    if (cfg.blendN && cfg.blendN>0){
                        const blends = createBlendFramesScaled(prevEndItem, prevScale, prevOffset, nextStartItem, segScale, segOffset, cfg.blendN);
                        if (blends && blends.length) frames.push(...blends);
                    }
                }
            }
            appendSegmentFrames(windowsIndex, jsonlMap, seg, segScale, segOffset, frames, fallbackW, fallbackH);
            prevScale = segScale; prevOffset = segOffset;
        }
        prevSeg = seg;
        prevSegIdx = Array.isArray(segments) ? segments.indexOf(seg) : -1;
        // Advance fallback pointer only when we used ordered sequence
        if (!cfg.preferEmbeddedNext || !prevSeg || !Array.isArray(prevSeg.next_candidates) || !prevSeg.next_candidates.length){
            nextSegIdx++;
            if (orderedSegments && nextSegIdx >= orderedSegments.length) nextSegIdx = 0; // loop
        }
    }

    function seed(frames){
        frames.length = 0; // clear
        ensureOrder();
    }

    function ensureBuffer(frames, playIdx, fallbackW=1280, fallbackH=720){
        const remaining = frames.length - playIdx;
        if (remaining < cfg.bufferLow){
            let guard = 0;
            const maxGuard = (orderedSegments?.length||1) * 2;
            while ((frames.length - playIdx) < cfg.bufferTarget && guard < maxGuard){
                appendNext(frames, fallbackW, fallbackH);
                guard++;
            }
        }
    }

    function compact(frames, playIdx){
        if (playIdx > cfg.compactThreshold){
            const keepFrom = Math.max(0, playIdx - cfg.compactKeepPrev);
            const newFrames = frames.slice(keepFrom);
            const newPlayIdx = Math.min(cfg.compactKeepPrev, newFrames.length);
            return { frames: newFrames, playIdx: newPlayIdx };
        }
        return { frames, playIdx };
    }

    function resetPrev(){ prevSeg = null; prevSegIdx = -1; prevScale = 1.0; prevOffset = [0,0]; }

    return { seed, ensureBuffer, compact, resetPrev };
}


