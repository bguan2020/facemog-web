// FaceMog Web Share Viewer — Before/After split viewport
// Two synchronized renderers: before (original) and after (looksmaxxed).

const API_BASE = 'https://c969ue4f2j.execute-api.us-east-1.amazonaws.com/prod';

// ── State ──
let beforeRenderer, afterRenderer, beforeScene, afterScene, camera;
let beforeMesh, afterMesh, beforeGeometry, afterGeometry;
let origPositions, deformedPositions, beforeDisplay, afterDisplay, vertexNormals;
let numVerts, transformDefs, landmarks, frame;
let precomputed = [];
let boundaryTaper;
let sliderValues = {};
let selectedCategory = '';

// View mapping
let viewMap = [];
let meshCenter = [0, 0, 0];

// ChadMaxx
let chadmaxxIntensity = 1.0;
let manualOverrides = new Set();
let hasChadmaxx = false;

// Camera — yaw only
let yawAngle = 0.3;
let camDist = 0;
let autoRotate = true;
let lastTime = 0;

// Input
let pointerDown = false, lastX = 0;
let pinchDist = 0;

// ── Entry ──
(async function main() {
    const shareId = getShareId();
    if (!shareId) { showError(); return; }
    try {
        console.log('[FaceMog] Fetching share:', shareId);
        const res = await fetch(`${API_BASE}/v1/share/${shareId}`);
        if (!res.ok) throw new Error(`Share API returned ${res.status}`);
        const shareData = await res.json();
        const jsonRes = await fetch(shareData.jsonUrl);
        if (!jsonRes.ok) throw new Error(`Result JSON returned ${jsonRes.status}`);
        const data = await jsonRes.json();
        console.log('[FaceMog] Result loaded, verts:', data.mesh?.n_verts, 'transforms:', data.transformDefs?.length);
        initViewer(data);
    } catch (e) {
        console.error('[FaceMog] Failed to load share:', e);
        showError();
    }
})();

function getShareId() {
    const path = window.location.pathname;
    const match = path.match(/\/s\/([a-zA-Z0-9]+)/);
    if (match) return match[1];
    return new URLSearchParams(window.location.search).get('id');
}

function showError() {
    document.getElementById('loading').style.display = 'none';
    document.getElementById('error').style.display = 'flex';
}

// ── Init ──
function initViewer(data) {
    const positions = decodeFloat32(data.mesh.vertices);
    const faces = decodeUint32(data.mesh.faces);
    const normals = decodeFloat32(data.normals_b64);
    numVerts = data.mesh.n_verts;
    transformDefs = data.transformDefs || [];
    landmarks = data.landmarks || {};
    frame = data.frame || [2, 0, 1, 1, -1];

    if (!positions || !faces || numVerts === 0) { showError(); return; }

    origPositions = new Float32Array(positions);
    deformedPositions = new Float32Array(positions);
    beforeDisplay = new Float32Array(numVerts * 3);
    afterDisplay = new Float32Array(numVerts * 3);
    vertexNormals = normals ? new Float32Array(normals) : null;

    // Frame mapping
    const fwdAxis = Math.round(frame[0]), hAxis = Math.round(frame[1]), vAxis = Math.round(frame[2]);
    const fwdSign = frame[3], vSign = frame.length > 4 ? frame[4] : 1.0;
    viewMap = [
        { src: hAxis, scale: 1 },
        { src: vAxis, scale: vSign },
        { src: fwdAxis, scale: -fwdSign }
    ];

    boundaryTaper = computeBoundaryTaper(faces, numVerts);
    meshCenter = computeCenter(origPositions, numVerts);

    // Decode UVs
    let uvs = null;
    if (data.uvs_b64) {
        const raw = decodeFloat32(data.uvs_b64);
        if (raw && raw.length === numVerts * 2) {
            uvs = new Float32Array(raw);
            for (let i = 1; i < uvs.length; i += 2) uvs[i] = 1.0 - uvs[i];
        }
    }

    // Show app first for real dimensions
    document.getElementById('loading').style.display = 'none';
    document.getElementById('app').style.display = 'flex';

    const beforeCanvas = document.getElementById('canvas-before');
    const afterCanvas = document.getElementById('canvas-after');
    const beforeHalf = document.getElementById('before-half');
    const afterHalf = document.getElementById('after-half');

    // Shared camera
    const bw = beforeHalf.clientWidth, bh = beforeHalf.clientHeight;
    camera = new THREE.PerspectiveCamera(35, bw / bh, 0.01, 100);

    const pixelRatio = Math.min(window.devicePixelRatio, 2);

    // ── Before scene + renderer ──
    beforeScene = new THREE.Scene();
    beforeScene.background = new THREE.Color(0x0a0a0f);
    addLights(beforeScene);

    beforeRenderer = new THREE.WebGLRenderer({ canvas: beforeCanvas, antialias: true });
    beforeRenderer.setSize(bw, bh);
    beforeRenderer.setPixelRatio(pixelRatio);

    beforeGeometry = new THREE.BufferGeometry();
    beforeGeometry.setAttribute('position', new THREE.BufferAttribute(beforeDisplay, 3));
    beforeGeometry.setIndex(new THREE.BufferAttribute(new Uint32Array(faces), 1));
    if (uvs) beforeGeometry.setAttribute('uv', new THREE.BufferAttribute(new Float32Array(uvs), 2));

    // ── After scene + renderer ──
    afterScene = new THREE.Scene();
    afterScene.background = new THREE.Color(0x0a0a0f);
    addLights(afterScene);

    const aw = afterHalf.clientWidth, ah = afterHalf.clientHeight;
    afterRenderer = new THREE.WebGLRenderer({ canvas: afterCanvas, antialias: true });
    afterRenderer.setSize(aw, ah);
    afterRenderer.setPixelRatio(pixelRatio);

    afterGeometry = new THREE.BufferGeometry();
    afterGeometry.setAttribute('position', new THREE.BufferAttribute(afterDisplay, 3));
    afterGeometry.setIndex(new THREE.BufferAttribute(new Uint32Array(faces), 1));
    if (uvs) afterGeometry.setAttribute('uv', new THREE.BufferAttribute(new Float32Array(uvs), 2));

    // Material — shared texture, separate material instances
    const matOpts = { shininess: 20, specular: 0x111111, flatShading: false, side: THREE.DoubleSide };
    let beforeMat, afterMat;

    if (data.texture_b64 && uvs) {
        beforeMat = new THREE.MeshPhongMaterial(matOpts);
        afterMat = new THREE.MeshPhongMaterial(matOpts);
        const texImg = new Image();
        texImg.onload = function() {
            const tex = new THREE.Texture(texImg);
            tex.needsUpdate = true;
            tex.flipY = false;
            beforeMat.map = tex;
            beforeMat.needsUpdate = true;
            // Clone texture for after
            const tex2 = tex.clone();
            tex2.needsUpdate = true;
            afterMat.map = tex2;
            afterMat.needsUpdate = true;
        };
        texImg.src = `data:${data.textureMime || 'image/jpeg'};base64,${data.texture_b64}`;
    } else {
        const solidOpts = { ...matOpts, color: 0xd1b8a0, shininess: 40, specular: 0x222233 };
        beforeMat = new THREE.MeshPhongMaterial(solidOpts);
        afterMat = new THREE.MeshPhongMaterial(solidOpts);
    }

    beforeMesh = new THREE.Mesh(beforeGeometry, beforeMat);
    beforeScene.add(beforeMesh);

    afterMesh = new THREE.Mesh(afterGeometry, afterMat);
    afterScene.add(afterMesh);

    // Bounding sphere for camera
    let maxR = 0;
    for (let i = 0; i < numVerts; i++) {
        const dx = origPositions[i * 3] - meshCenter[0];
        const dy = origPositions[i * 3 + 1] - meshCenter[1];
        const dz = origPositions[i * 3 + 2] - meshCenter[2];
        const r = Math.sqrt(dx * dx + dy * dy + dz * dz);
        if (r > maxR) maxR = r;
    }
    camDist = maxR * 3.2;

    // Remap original positions → before display (never changes)
    remapToView(origPositions, beforeDisplay);
    beforeGeometry.attributes.position.needsUpdate = true;
    beforeGeometry.computeVertexNormals();

    // Precompute + apply deformations
    precomputeTransforms();
    hasChadmaxx = transformDefs.some(d => d.chadmaxx_tag);

    for (const def of transformDefs) {
        if (def.chadmaxx_tag) {
            sliderValues[def.id] = def.chadmaxx_target != null ? def.chadmaxx_target : 1.0;
        } else {
            sliderValues[def.id] = def.default || 0;
        }
    }
    applyDeformations();

    buildUI();
    setupControls(document.getElementById('viewport'));
    window.addEventListener('resize', onResize);
    updateCamera();
    requestAnimationFrame(animate);
}

function addLights(scene) {
    scene.add(new THREE.AmbientLight(0xffffff, 0.7));
    const key = new THREE.DirectionalLight(0xffffff, 0.8);
    key.position.set(1, 1, 2); scene.add(key);
    const fill = new THREE.DirectionalLight(0xccccdd, 0.4);
    fill.position.set(-1, 0.5, 1); scene.add(fill);
    const back = new THREE.DirectionalLight(0x8888aa, 0.25);
    back.position.set(0, -1, -1); scene.add(back);
}

// ── Remap positions from mesh space → Three.js view space ──
function remapToView(src, dst) {
    const cx = meshCenter[0], cy = meshCenter[1], cz = meshCenter[2];
    const m0 = viewMap[0], m1 = viewMap[1], m2 = viewMap[2];
    for (let i = 0; i < numVerts; i++) {
        const i3 = i * 3;
        const c = [src[i3] - cx, src[i3+1] - cy, src[i3+2] - cz];
        dst[i3]   = c[m0.src] * m0.scale;
        dst[i3+1] = c[m1.src] * m1.scale;
        dst[i3+2] = c[m2.src] * m2.scale;
    }
}

// ── Base64 decode ──
function decodeFloat32(b64) {
    if (!b64) return null;
    try {
        const bin = atob(b64);
        const buf = new Uint8Array(bin.length);
        for (let i = 0; i < bin.length; i++) buf[i] = bin.charCodeAt(i);
        return new Float32Array(buf.buffer);
    } catch { return null; }
}
function decodeUint32(b64) {
    if (!b64) return null;
    try {
        const bin = atob(b64);
        const buf = new Uint8Array(bin.length);
        for (let i = 0; i < bin.length; i++) buf[i] = bin.charCodeAt(i);
        return new Uint32Array(buf.buffer);
    } catch { return null; }
}
function computeCenter(positions, n) {
    let cx = 0, cy = 0, cz = 0;
    for (let i = 0; i < n; i++) { cx += positions[i*3]; cy += positions[i*3+1]; cz += positions[i*3+2]; }
    return [cx/n, cy/n, cz/n];
}

// ── Boundary taper ──
function computeBoundaryTaper(faces, nVerts) {
    const taper = new Float32Array(nVerts); taper.fill(1.0);
    const adj = new Array(nVerts);
    for (let i = 0; i < nVerts; i++) adj[i] = new Set();
    const edgeFaceCount = new Map();
    const nFaces = faces.length / 3;
    for (let f = 0; f < nFaces; f++) {
        const f3 = f * 3;
        const a = faces[f3], b = faces[f3+1], c = faces[f3+2];
        adj[a].add(b); adj[a].add(c); adj[b].add(a); adj[b].add(c); adj[c].add(a); adj[c].add(b);
        for (const [u, v] of [[a,b],[b,c],[c,a]]) {
            const key = u < v ? (u * 100000 + v) : (v * 100000 + u);
            edgeFaceCount.set(key, (edgeFaceCount.get(key) || 0) + 1);
        }
    }
    const isBoundary = new Uint8Array(nVerts);
    for (const [key, count] of edgeFaceCount) {
        if (count === 1) { isBoundary[Math.floor(key/100000)] = 1; isBoundary[key%100000] = 1; }
    }
    let currentRing = new Set();
    for (let i = 0; i < nVerts; i++) { if (isBoundary[i]) { taper[i] = 0.0; currentRing.add(i); } }
    const visited = new Set(currentRing);
    for (const ringTaper of [0.3, 0.6, 0.85]) {
        const nextRing = new Set();
        for (const vi of currentRing) for (const ni of adj[vi]) {
            if (!visited.has(ni)) { taper[ni] = Math.min(taper[ni], ringTaper); nextRing.add(ni); visited.add(ni); }
        }
        currentRing = nextRing;
    }
    return taper;
}

// ── Camera ──
function updateCamera() {
    camera.position.set(camDist * Math.sin(yawAngle), 0, camDist * Math.cos(yawAngle));
    camera.lookAt(0, 0, 0);
}

// ── Coordinate frame ──
function canonToScan(canonDir) {
    const fwdAxis = Math.round(frame[0]), hAxis = Math.round(frame[1]), vAxis = Math.round(frame[2]);
    const scan = [0,0,0];
    scan[hAxis] = canonDir[0]; scan[vAxis] = canonDir[1]; scan[fwdAxis] = canonDir[2] * frame[3];
    return scan;
}

// ── Falloff ──
function gaussianFalloff(d, r) { const s = r/2; return Math.exp(-0.5*(d/s)**2); }
function cosineFalloff(d, r) { return d >= r ? 0 : 0.5*(1+Math.cos(Math.PI*d/r)); }
function linearFalloff(d, r) { return Math.max(0, 1-d/r); }
const FALLOFF = { gaussian: gaussianFalloff, cosine: cosineFalloff, linear: linearFalloff };

// ── Precompute ──
function precomputeTransforms() {
    precomputed = [];
    for (const def of transformDefs) {
        const subPre = [];
        for (const sub of def.transforms) {
            if (sub.vert_indices_b64 && sub.weights_b64 && sub.displacements_b64) {
                subPre.push({
                    vertIndices: decodeUint32(sub.vert_indices_b64),
                    weights: decodeFloat32(sub.weights_b64),
                    displacements: decodeFloat32(sub.displacements_b64),
                    operation: sub.operation, magnitudeScale: sub.magnitude_scale,
                    scanDir: sub.operation === 'translate' && sub.direction ? canonToScan(sub.direction) : null,
                    useDisplacements: true,
                });
                continue;
            }
            const lmPos = landmarks[sub.landmark];
            if (!lmPos) { subPre.push(null); continue; }
            const ax = lmPos[0], ay = lmPos[1], az = lmPos[2];
            const radius = sub.radius, cutoff = radius * 2.5;
            const falloffFn = FALLOFF[sub.falloff] || gaussianFalloff;
            const idx = [], w = [];
            for (let i = 0; i < numVerts; i++) {
                const i3 = i*3;
                const dist = Math.sqrt((origPositions[i3]-ax)**2 + (origPositions[i3+1]-ay)**2 + (origPositions[i3+2]-az)**2);
                if (dist < cutoff) { idx.push(i); w.push(falloffFn(dist, radius)); }
            }
            subPre.push({
                vertIndices: new Uint32Array(idx), weights: new Float32Array(w),
                scanDir: sub.operation === 'translate' && sub.direction ? canonToScan(sub.direction) : null,
                operation: sub.operation, magnitudeScale: sub.magnitude_scale, useDisplacements: false,
            });
        }
        precomputed.push(subPre);
    }
}

// ── Deformation ──
function getEffectiveMaxMM(def) {
    if (!def.chadmaxx_tag) return def.max_mm;
    const n = def.max_mm, c = def.chadmaxx_max_mm != null ? def.chadmaxx_max_mm : n;
    return n + (c - n) * chadmaxxIntensity;
}
function getEffectiveMaxOriginal(def) {
    if (!def.chadmaxx_tag) return def.max_mm_original || def.max_mm;
    const n = def.max_mm_original || def.max_mm;
    const c = def.chadmaxx_max_mm_original || def.chadmaxx_max_mm || n;
    return n + (c - n) * chadmaxxIntensity;
}

function applyDeformations() {
    deformedPositions.set(origPositions);
    for (let di = 0; di < transformDefs.length; di++) {
        const def = transformDefs[di];
        const sv = sliderValues[def.id] || 0;
        if (sv < 0.001) continue;
        const mag = sv * getEffectiveMaxMM(def);
        for (let si = 0; si < def.transforms.length; si++) {
            const pre = precomputed[di] && precomputed[di][si];
            if (!pre || !pre.vertIndices || pre.vertIndices.length === 0) continue;
            const subMag = mag * pre.magnitudeScale;
            const { vertIndices, weights, operation } = pre;
            if (pre.useDisplacements && pre.displacements) {
                for (let k = 0; k < vertIndices.length; k++) {
                    const vi = vertIndices[k], i3 = vi*3, k3 = k*3, w = weights[k]*boundaryTaper[vi];
                    deformedPositions[i3] += pre.displacements[k3]*subMag*w;
                    deformedPositions[i3+1] += pre.displacements[k3+1]*subMag*w;
                    deformedPositions[i3+2] += pre.displacements[k3+2]*subMag*w;
                }
            } else if (operation === 'translate' && pre.scanDir) {
                const dx = pre.scanDir[0]*subMag, dy = pre.scanDir[1]*subMag, dz = pre.scanDir[2]*subMag;
                for (let k = 0; k < vertIndices.length; k++) {
                    const vi = vertIndices[k], i3 = vi*3, w = weights[k]*boundaryTaper[vi];
                    deformedPositions[i3] += dx*w; deformedPositions[i3+1] += dy*w; deformedPositions[i3+2] += dz*w;
                }
            } else if (operation === 'inflate' || operation === 'deflate') {
                const sign = operation === 'inflate' ? 1 : -1;
                if (!vertexNormals) continue;
                for (let k = 0; k < vertIndices.length; k++) {
                    const vi = vertIndices[k], i3 = vi*3, w = weights[k]*boundaryTaper[vi];
                    deformedPositions[i3] += vertexNormals[i3]*sign*subMag*w;
                    deformedPositions[i3+1] += vertexNormals[i3+1]*sign*subMag*w;
                    deformedPositions[i3+2] += vertexNormals[i3+2]*sign*subMag*w;
                }
            }
        }
    }
    // Update after display
    remapToView(deformedPositions, afterDisplay);
    afterGeometry.attributes.position.needsUpdate = true;
    afterGeometry.computeVertexNormals();
}

// ── UI ──
function buildUI() {
    const catContainer = document.getElementById('categories');
    const sliderContainer = document.getElementById('sliders');
    const categories = []; const seen = new Set();
    for (const def of transformDefs) { if (!seen.has(def.category)) { seen.add(def.category); categories.push(def.category); } }
    if (categories.length === 0) return;
    selectedCategory = categories[0];

    if (hasChadmaxx) buildChadmaxxSlider();

    for (const cat of categories) {
        const pill = document.createElement('div');
        pill.className = 'cat-pill' + (cat === selectedCategory ? ' active' : '');
        pill.textContent = cat;
        pill.onclick = () => {
            selectedCategory = cat;
            catContainer.querySelectorAll('.cat-pill').forEach(p => p.classList.remove('active'));
            pill.classList.add('active');
            renderSliders();
        };
        catContainer.appendChild(pill);
    }
    renderSliders();

    function renderSliders() {
        sliderContainer.innerHTML = '';
        for (const def of transformDefs.filter(d => d.category === selectedCategory)) {
            const card = document.createElement('div');
            card.className = 'slider-card';
            const val = sliderValues[def.id] || 0;
            const mm = (val * getEffectiveMaxOriginal(def)).toFixed(1);
            card.innerHTML = `
                <div class="slider-header">
                    <span class="slider-name">${def.name}</span>
                    <span class="slider-value" id="val-${def.id}">${mm}mm</span>
                </div>
                ${def.procedure ? `<div class="slider-procedure">${def.procedure}</div>` : ''}
                <input type="range" min="0" max="1" step="0.01" value="${val}" id="slider-${def.id}">
            `;
            const input = card.querySelector('input');
            input.addEventListener('input', () => {
                const v = parseFloat(input.value);
                sliderValues[def.id] = v;
                if (def.chadmaxx_tag) manualOverrides.add(def.id);
                document.getElementById(`val-${def.id}`).textContent = `${(v * getEffectiveMaxOriginal(def)).toFixed(1)}mm`;
                autoRotate = false;
                applyDeformations();
            });
            sliderContainer.appendChild(card);
        }
    }
}

function buildChadmaxxSlider() {
    const el = document.getElementById('chadmaxx');
    if (!el) return;
    el.style.display = 'block';
    const pct = document.getElementById('chadmaxx-pct');
    const input = document.getElementById('chadmaxx-slider');
    input.value = chadmaxxIntensity;
    pct.textContent = `${Math.round(chadmaxxIntensity * 100)}%`;
    input.addEventListener('input', () => {
        chadmaxxIntensity = parseFloat(input.value);
        pct.textContent = `${Math.round(chadmaxxIntensity * 100)}%`;
        for (const def of transformDefs) {
            if (!def.chadmaxx_tag || manualOverrides.has(def.id)) continue;
            const target = def.chadmaxx_target != null ? def.chadmaxx_target : 1.0;
            sliderValues[def.id] = chadmaxxIntensity * target;
            const slEl = document.getElementById(`slider-${def.id}`);
            if (slEl) slEl.value = sliderValues[def.id];
            const valEl = document.getElementById(`val-${def.id}`);
            if (valEl) valEl.textContent = `${(sliderValues[def.id] * getEffectiveMaxOriginal(def)).toFixed(1)}mm`;
        }
        autoRotate = false;
        applyDeformations();
    });
}

// ── Controls ──
function setupControls(el) {
    el.addEventListener('pointerdown', e => { pointerDown = true; lastX = e.clientX; autoRotate = false; });
    el.addEventListener('pointermove', e => {
        if (!pointerDown) return;
        yawAngle -= (e.clientX - lastX) * 0.008;
        lastX = e.clientX;
        updateCamera();
    });
    el.addEventListener('pointerup', () => { pointerDown = false; });
    el.addEventListener('pointerleave', () => { pointerDown = false; });
    el.addEventListener('wheel', e => {
        e.preventDefault();
        camDist *= e.deltaY > 0 ? 1.05 : 0.95;
        camDist = Math.max(0.05, camDist);
        updateCamera();
    }, { passive: false });
    el.addEventListener('touchstart', e => {
        if (e.touches.length === 2) {
            const dx = e.touches[0].clientX - e.touches[1].clientX;
            const dy = e.touches[0].clientY - e.touches[1].clientY;
            pinchDist = Math.sqrt(dx*dx + dy*dy);
        }
    }, { passive: true });
    el.addEventListener('touchmove', e => {
        if (e.touches.length === 2) {
            const dx = e.touches[0].clientX - e.touches[1].clientX;
            const dy = e.touches[0].clientY - e.touches[1].clientY;
            const nd = Math.sqrt(dx*dx + dy*dy);
            if (pinchDist > 0) { camDist *= pinchDist/nd; camDist = Math.max(0.05, camDist); updateCamera(); }
            pinchDist = nd;
        }
    }, { passive: true });
}

// ── Render loop — renders both viewports with shared camera ──
function animate(time) {
    requestAnimationFrame(animate);
    if (autoRotate) {
        const dt = lastTime ? (time - lastTime) / 1000 : 0;
        yawAngle += dt * 0.2;
        updateCamera();
    }
    lastTime = time;
    beforeRenderer.render(beforeScene, camera);
    afterRenderer.render(afterScene, camera);
}

function onResize() {
    const bh = document.getElementById('before-half');
    const ah = document.getElementById('after-half');
    if (!bh || !ah) return;
    const bw = bh.clientWidth, bhh = bh.clientHeight;
    const aw = ah.clientWidth, ahh = ah.clientHeight;
    if (bw === 0 || bhh === 0) return;
    camera.aspect = bw / bhh;
    camera.updateProjectionMatrix();
    beforeRenderer.setSize(bw, bhh);
    afterRenderer.setSize(aw, ahh);
}
