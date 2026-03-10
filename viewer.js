// FaceMog Web Share Viewer
// Fetches result.json via share API, renders 3D face with Three.js, supports slider deformation.

const API_BASE = 'https://c969ue4f2j.execute-api.us-east-1.amazonaws.com/prod';

// ── State ──
let scene, camera, renderer, mesh, geometry;
let origPositions, deformedPositions, displayPositions, vertexNormals;
let numVerts, transformDefs, landmarks, frame;
let precomputed = [];
let boundaryTaper; // per-vertex taper weight (0 at boundary → 1 interior)
let sliderValues = {};
let selectedCategory = '';

// View mapping (frame convention → Three.js standard coordinates)
let viewMap = []; // [{src: axisIndex, scale: ±1}, ...] for X, Y, Z
let meshCenter = [0, 0, 0];

// ChadMaxx state
let chadmaxxIntensity = 1.0;
let manualOverrides = new Set();
let hasChadmaxx = false;

// Camera — yaw only (like mobile app)
let yawAngle = 0.3; // ~17 deg starting angle
let camDist = 0;
let autoRotate = true;
let lastTime = 0;

// Touch/mouse state
let pointerDown = false, lastX = 0;
let pinchDist = 0;

// ── Entry point ──
(async function main() {
    const shareId = getShareId();
    if (!shareId) { showError(); return; }

    try {
        console.log('[FaceMog] Fetching share:', shareId);
        const res = await fetch(`${API_BASE}/v1/share/${shareId}`);
        if (!res.ok) throw new Error(`Share API returned ${res.status}`);
        const shareData = await res.json();
        console.log('[FaceMog] Share resolved, fetching result.json...');

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
    // Decode mesh
    const positions = decodeFloat32(data.mesh.vertices);
    const faces = decodeUint32(data.mesh.faces);
    const normals = decodeFloat32(data.normals_b64);
    numVerts = data.mesh.n_verts;
    transformDefs = data.transformDefs || [];
    landmarks = data.landmarks || {};
    frame = data.frame || [2, 0, 1, 1, -1];

    if (!positions || !faces || numVerts === 0) {
        console.error('[FaceMog] Missing mesh data');
        showError();
        return;
    }

    origPositions = new Float32Array(positions);
    deformedPositions = new Float32Array(positions);
    displayPositions = new Float32Array(numVerts * 3);
    vertexNormals = normals ? new Float32Array(normals) : null;

    // Setup frame → view coordinate mapping
    // frame = [forwardAxis, hAxis, vAxis, forwardSign, vSign]
    // In Three.js: X=right, Y=up, Z=toward camera
    // viewX = mesh[hAxis], viewY = mesh[vAxis]*vSign, viewZ = mesh[fwdAxis]*-fwdSign
    const fwdAxis = Math.round(frame[0]);
    const hAxis = Math.round(frame[1]);
    const vAxis = Math.round(frame[2]);
    const fwdSign = frame[3];
    const vSign = frame.length > 4 ? frame[4] : 1.0;
    viewMap = [
        { src: hAxis, scale: 1 },
        { src: vAxis, scale: vSign },
        { src: fwdAxis, scale: -fwdSign }
    ];
    console.log('[FaceMog] Frame:', frame, '→ viewMap:', viewMap.map(v => `axis${v.src}*${v.scale}`));

    // Compute boundary taper (must be before deformation)
    boundaryTaper = computeBoundaryTaper(faces, numVerts);

    // Compute center in original mesh space
    meshCenter = computeCenter(origPositions, numVerts);

    // Decode UVs
    let uvs = null;
    if (data.uvs_b64) {
        const raw = decodeFloat32(data.uvs_b64);
        if (raw && raw.length === numVerts * 2) {
            uvs = new Float32Array(raw);
            for (let i = 1; i < uvs.length; i += 2) {
                uvs[i] = 1.0 - uvs[i];
            }
        }
    }

    // Show app FIRST so viewport has real dimensions
    document.getElementById('loading').style.display = 'none';
    document.getElementById('app').style.display = 'flex';

    // Setup Three.js
    const canvas = document.getElementById('canvas');
    const viewport = document.getElementById('viewport');
    const w = viewport.clientWidth;
    const h = viewport.clientHeight;

    scene = new THREE.Scene();
    scene.background = new THREE.Color(0x0a0a0f);

    camera = new THREE.PerspectiveCamera(35, w / h, 0.01, 100);
    renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
    renderer.setSize(w, h);
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));

    // Lights — bright studio rig
    scene.add(new THREE.AmbientLight(0xffffff, 0.7));
    const key = new THREE.DirectionalLight(0xffffff, 0.8);
    key.position.set(1, 1, 2); scene.add(key);
    const fill = new THREE.DirectionalLight(0xccccdd, 0.4);
    fill.position.set(-1, 0.5, 1); scene.add(fill);
    const back = new THREE.DirectionalLight(0x8888aa, 0.25);
    back.position.set(0, -1, -1); scene.add(back);

    // Geometry — use displayPositions (remapped to view space)
    geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.BufferAttribute(displayPositions, 3));
    geometry.setIndex(new THREE.BufferAttribute(new Uint32Array(faces), 1));
    if (uvs) geometry.setAttribute('uv', new THREE.BufferAttribute(uvs, 2));

    // Material — DoubleSide handles any winding issues from coordinate remap
    let mat;
    if (data.texture_b64 && uvs) {
        mat = new THREE.MeshPhongMaterial({
            shininess: 20, specular: 0x111111, flatShading: false,
            side: THREE.DoubleSide
        });
        const texImg = new Image();
        texImg.onload = function() {
            const tex = new THREE.Texture(texImg);
            tex.needsUpdate = true;
            tex.flipY = false;
            mat.map = tex;
            mat.needsUpdate = true;
            console.log('[FaceMog] Texture loaded');
        };
        texImg.onerror = function() {
            console.error('[FaceMog] Texture failed to load');
            mat.color = new THREE.Color(0xd1b8a0);
            mat.needsUpdate = true;
        };
        texImg.src = `data:${data.textureMime || 'image/jpeg'};base64,${data.texture_b64}`;
    } else {
        mat = new THREE.MeshPhongMaterial({
            color: 0xd1b8a0, shininess: 40, specular: 0x222233,
            flatShading: false, side: THREE.DoubleSide
        });
    }

    mesh = new THREE.Mesh(geometry, mat);
    scene.add(mesh);

    // Compute bounding sphere for camera distance (in original space)
    let maxR = 0;
    for (let i = 0; i < numVerts; i++) {
        const dx = origPositions[i * 3] - meshCenter[0];
        const dy = origPositions[i * 3 + 1] - meshCenter[1];
        const dz = origPositions[i * 3 + 2] - meshCenter[2];
        const r = Math.sqrt(dx * dx + dy * dy + dz * dz);
        if (r > maxR) maxR = r;
    }
    camDist = maxR * 3.2;
    console.log('[FaceMog] Bounding radius:', maxR.toFixed(4), 'camDist:', camDist.toFixed(4));

    // Precompute deformation data
    precomputeTransforms();

    // Check for ChadMaxx transforms
    hasChadmaxx = transformDefs.some(d => d.chadmaxx_tag);

    // Apply default slider values — match iOS: ChadMaxx starts at chadMaxTarget, others at default
    for (const def of transformDefs) {
        if (def.chadmaxx_tag) {
            sliderValues[def.id] = def.chadmaxx_target != null ? def.chadmaxx_target : 1.0;
        } else {
            sliderValues[def.id] = def.default || 0;
        }
    }

    // Apply deformations and remap to view space
    applyDeformations();
    updateDisplayPositions();

    // Build UI
    buildUI();

    // Events
    const vp = document.getElementById('viewport');
    setupControls(vp);
    window.addEventListener('resize', onResize);

    // Initial camera position
    updateCamera();

    // Render loop
    requestAnimationFrame(animate);
    console.log('[FaceMog] Viewer initialized, numVerts:', numVerts, 'transforms:', transformDefs.length, 'chadmaxx:', hasChadmaxx);
}

// ── Remap deformed positions from mesh space → Three.js view space ──
function updateDisplayPositions() {
    const cx = meshCenter[0], cy = meshCenter[1], cz = meshCenter[2];
    const m0 = viewMap[0], m1 = viewMap[1], m2 = viewMap[2];

    for (let i = 0; i < numVerts; i++) {
        const i3 = i * 3;
        // Center in original space
        const dx = deformedPositions[i3] - cx;
        const dy = deformedPositions[i3 + 1] - cy;
        const dz = deformedPositions[i3 + 2] - cz;
        const centered = [dx, dy, dz];

        // Remap axes
        displayPositions[i3]     = centered[m0.src] * m0.scale;
        displayPositions[i3 + 1] = centered[m1.src] * m1.scale;
        displayPositions[i3 + 2] = centered[m2.src] * m2.scale;
    }

    geometry.attributes.position.needsUpdate = true;
    geometry.computeVertexNormals();
}

// ── Base64 decode ──
function decodeFloat32(b64) {
    if (!b64) return null;
    try {
        const bin = atob(b64);
        const buf = new Uint8Array(bin.length);
        for (let i = 0; i < bin.length; i++) buf[i] = bin.charCodeAt(i);
        return new Float32Array(buf.buffer);
    } catch (e) {
        console.error('[FaceMog] Float32 decode failed:', e);
        return null;
    }
}

function decodeUint32(b64) {
    if (!b64) return null;
    try {
        const bin = atob(b64);
        const buf = new Uint8Array(bin.length);
        for (let i = 0; i < bin.length; i++) buf[i] = bin.charCodeAt(i);
        return new Uint32Array(buf.buffer);
    } catch (e) {
        console.error('[FaceMog] Uint32 decode failed:', e);
        return null;
    }
}

function computeCenter(positions, n) {
    let cx = 0, cy = 0, cz = 0;
    for (let i = 0; i < n; i++) {
        cx += positions[i * 3];
        cy += positions[i * 3 + 1];
        cz += positions[i * 3 + 2];
    }
    return [cx / n, cy / n, cz / n];
}

// ── Boundary taper (matching iOS DeformationEngine) ──
// Prevents mesh tearing at open edges by tapering deformation weight to 0 at boundaries.
function computeBoundaryTaper(faces, nVerts) {
    const taper = new Float32Array(nVerts);
    taper.fill(1.0);

    // Build adjacency and count faces per edge
    const adj = new Array(nVerts);
    for (let i = 0; i < nVerts; i++) adj[i] = new Set();
    const edgeFaceCount = new Map();

    const nFaces = faces.length / 3;
    for (let f = 0; f < nFaces; f++) {
        const f3 = f * 3;
        const a = faces[f3], b = faces[f3 + 1], c = faces[f3 + 2];
        adj[a].add(b); adj[a].add(c);
        adj[b].add(a); adj[b].add(c);
        adj[c].add(a); adj[c].add(b);

        // Count each edge (ordered pair as key)
        const edges = [[a, b], [b, c], [c, a]];
        for (const [u, v] of edges) {
            const key = u < v ? (u * 100000 + v) : (v * 100000 + u);
            edgeFaceCount.set(key, (edgeFaceCount.get(key) || 0) + 1);
        }
    }

    // Find boundary vertices (on edges shared by only 1 face)
    const isBoundary = new Uint8Array(nVerts);
    for (const [key, count] of edgeFaceCount) {
        if (count === 1) {
            const u = Math.floor(key / 100000);
            const v = key % 100000;
            isBoundary[u] = 1;
            isBoundary[v] = 1;
        }
    }

    // Ring 0: boundary vertices → taper = 0.0
    let currentRing = new Set();
    for (let i = 0; i < nVerts; i++) {
        if (isBoundary[i]) {
            taper[i] = 0.0;
            currentRing.add(i);
        }
    }

    // Propagate through rings: 0.3, 0.6, 0.85
    const taperValues = [0.3, 0.6, 0.85];
    const visited = new Set(currentRing);

    for (const ringTaper of taperValues) {
        const nextRing = new Set();
        for (const vi of currentRing) {
            for (const ni of adj[vi]) {
                if (!visited.has(ni)) {
                    taper[ni] = Math.min(taper[ni], ringTaper);
                    nextRing.add(ni);
                    visited.add(ni);
                }
            }
        }
        currentRing = nextRing;
    }

    const boundaryCount = Array.from(isBoundary).filter(x => x).length;
    console.log(`[FaceMog] Boundary taper: ${boundaryCount} boundary verts, ${visited.size} total affected`);
    return taper;
}

// ── Camera — yaw-only rotation (matching iOS ViewpointController.yawOnly) ──
function updateCamera() {
    const x = camDist * Math.sin(yawAngle);
    const z = camDist * Math.cos(yawAngle);
    camera.position.set(x, 0, z);
    camera.lookAt(0, 0, 0);
}

// ── Coordinate frame helpers ──
function canonToScan(canonDir) {
    const fwdAxis = Math.round(frame[0]);
    const hAxis = Math.round(frame[1]);
    const vAxis = Math.round(frame[2]);
    const fwdSign = frame[3];
    const scan = [0, 0, 0];
    scan[hAxis] = canonDir[0];
    scan[vAxis] = canonDir[1];
    scan[fwdAxis] = canonDir[2] * fwdSign;
    return scan;
}

// ── Falloff functions ──
function gaussianFalloff(dist, radius) {
    const sigma = radius / 2.0;
    return Math.exp(-0.5 * (dist / sigma) ** 2);
}
function cosineFalloff(dist, radius) {
    if (dist >= radius) return 0;
    return 0.5 * (1 + Math.cos(Math.PI * dist / radius));
}
function linearFalloff(dist, radius) {
    return Math.max(0, 1.0 - dist / radius);
}
const FALLOFF = { gaussian: gaussianFalloff, cosine: cosineFalloff, linear: linearFalloff };

// ── Precompute deformation data ──
function precomputeTransforms() {
    precomputed = [];
    for (const def of transformDefs) {
        const subPre = [];
        for (const sub of def.transforms) {
            if (sub.vert_indices_b64 && sub.weights_b64 && sub.displacements_b64) {
                const vertIndices = decodeUint32(sub.vert_indices_b64);
                const weights = decodeFloat32(sub.weights_b64);
                const displacements = decodeFloat32(sub.displacements_b64);
                subPre.push({
                    vertIndices, weights, displacements,
                    operation: sub.operation,
                    magnitudeScale: sub.magnitude_scale,
                    scanDir: sub.operation === 'translate' && sub.direction ? canonToScan(sub.direction) : null,
                    useDisplacements: true,
                });
                continue;
            }

            const lmPos = landmarks[sub.landmark];
            if (!lmPos) { subPre.push(null); continue; }

            const ax = lmPos[0], ay = lmPos[1], az = lmPos[2];
            const radius = sub.radius;
            const cutoff = radius * 2.5;
            const falloffFn = FALLOFF[sub.falloff] || gaussianFalloff;

            const affectedIdx = [], affectedW = [];
            for (let i = 0; i < numVerts; i++) {
                const i3 = i * 3;
                const dx = origPositions[i3] - ax;
                const dy = origPositions[i3 + 1] - ay;
                const dz = origPositions[i3 + 2] - az;
                const dist = Math.sqrt(dx * dx + dy * dy + dz * dz);
                if (dist < cutoff) {
                    affectedIdx.push(i);
                    affectedW.push(falloffFn(dist, radius));
                }
            }

            subPre.push({
                vertIndices: new Uint32Array(affectedIdx),
                weights: new Float32Array(affectedW),
                scanDir: sub.operation === 'translate' && sub.direction ? canonToScan(sub.direction) : null,
                operation: sub.operation,
                magnitudeScale: sub.magnitude_scale,
                useDisplacements: false,
            });
        }
        precomputed.push(subPre);
    }
}

// ── Deformation engine (matching iOS DeformationEngine + LooksmaxxViewModel) ──

// Get effective max_mm for a transform, interpolated for ChadMaxx
function getEffectiveMaxMM(def) {
    if (!def.chadmaxx_tag) return def.max_mm;
    const normalMax = def.max_mm;
    const chadMax = def.chadmaxx_max_mm != null ? def.chadmaxx_max_mm : def.max_mm;
    return normalMax + (chadMax - normalMax) * chadmaxxIntensity;
}

// Get effective max_mm_original for display (mm text)
function getEffectiveMaxOriginal(def) {
    if (!def.chadmaxx_tag) return def.max_mm_original || def.max_mm;
    const normalMax = def.max_mm_original || def.max_mm;
    const chadMax = def.chadmaxx_max_mm_original || def.chadmaxx_max_mm || normalMax;
    return normalMax + (chadMax - normalMax) * chadmaxxIntensity;
}

function applyDeformations() {
    deformedPositions.set(origPositions);

    for (let di = 0; di < transformDefs.length; di++) {
        const def = transformDefs[di];
        const sliderVal = sliderValues[def.id] || 0;
        if (sliderVal < 0.001) continue;

        const maxMM = getEffectiveMaxMM(def);
        const magnitude = sliderVal * maxMM;

        for (let si = 0; si < def.transforms.length; si++) {
            const pre = precomputed[di] && precomputed[di][si];
            if (!pre || !pre.vertIndices || pre.vertIndices.length === 0) continue;

            const subMag = magnitude * pre.magnitudeScale;
            const { vertIndices, weights, operation } = pre;

            if (pre.useDisplacements && pre.displacements) {
                for (let k = 0; k < vertIndices.length; k++) {
                    const vi = vertIndices[k];
                    const i3 = vi * 3;
                    const k3 = k * 3;
                    const w = weights[k] * boundaryTaper[vi];
                    deformedPositions[i3] += pre.displacements[k3] * subMag * w;
                    deformedPositions[i3 + 1] += pre.displacements[k3 + 1] * subMag * w;
                    deformedPositions[i3 + 2] += pre.displacements[k3 + 2] * subMag * w;
                }
            } else if (operation === 'translate' && pre.scanDir) {
                const dx = pre.scanDir[0] * subMag;
                const dy = pre.scanDir[1] * subMag;
                const dz = pre.scanDir[2] * subMag;
                for (let k = 0; k < vertIndices.length; k++) {
                    const vi = vertIndices[k];
                    const i3 = vi * 3;
                    const w = weights[k] * boundaryTaper[vi];
                    deformedPositions[i3] += dx * w;
                    deformedPositions[i3 + 1] += dy * w;
                    deformedPositions[i3 + 2] += dz * w;
                }
            } else if (operation === 'inflate' || operation === 'deflate') {
                const sign = operation === 'inflate' ? 1 : -1;
                if (!vertexNormals) continue;
                for (let k = 0; k < vertIndices.length; k++) {
                    const vi = vertIndices[k];
                    const i3 = vi * 3;
                    const w = weights[k] * boundaryTaper[vi];
                    deformedPositions[i3] += vertexNormals[i3] * sign * subMag * w;
                    deformedPositions[i3 + 1] += vertexNormals[i3 + 1] * sign * subMag * w;
                    deformedPositions[i3 + 2] += vertexNormals[i3 + 2] * sign * subMag * w;
                }
            }
        }
    }

    // Update display positions (remap to view space)
    updateDisplayPositions();
}

// ── UI ──
function buildUI() {
    const catContainer = document.getElementById('categories');
    const sliderContainer = document.getElementById('sliders');

    // Get unique categories
    const categories = [];
    const seen = new Set();
    for (const def of transformDefs) {
        if (!seen.has(def.category)) {
            seen.add(def.category);
            categories.push(def.category);
        }
    }

    if (categories.length === 0) return;
    selectedCategory = categories[0];

    // ChadMaxx master slider
    if (hasChadmaxx) {
        buildChadmaxxSlider();
    }

    // Category pills
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
        const defs = transformDefs.filter(d => d.category === selectedCategory);

        for (const def of defs) {
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
                <input type="range" min="0" max="1" step="0.01" value="${val}"
                       id="slider-${def.id}">
            `;

            const input = card.querySelector('input');
            input.addEventListener('input', () => {
                const v = parseFloat(input.value);
                sliderValues[def.id] = v;
                // Track manual override for ChadMaxx transforms
                if (def.chadmaxx_tag) manualOverrides.add(def.id);
                const newMm = (v * getEffectiveMaxOriginal(def)).toFixed(1);
                document.getElementById(`val-${def.id}`).textContent = `${newMm}mm`;
                autoRotate = false;
                applyDeformations();
            });

            sliderContainer.appendChild(card);
        }
    }

    // Expose renderSliders for ChadMaxx intensity changes
    window._renderSliders = renderSliders;
}

function buildChadmaxxSlider() {
    const chadEl = document.getElementById('chadmaxx');
    if (!chadEl) return;

    chadEl.style.display = 'block';
    const pctLabel = document.getElementById('chadmaxx-pct');
    const input = document.getElementById('chadmaxx-slider');

    input.value = chadmaxxIntensity;
    pctLabel.textContent = `${Math.round(chadmaxxIntensity * 100)}%`;

    input.addEventListener('input', () => {
        chadmaxxIntensity = parseFloat(input.value);
        pctLabel.textContent = `${Math.round(chadmaxxIntensity * 100)}%`;

        // Match iOS: scale non-overridden ChadMaxx transforms to intensity * target
        for (const def of transformDefs) {
            if (!def.chadmaxx_tag || manualOverrides.has(def.id)) continue;
            const target = def.chadmaxx_target != null ? def.chadmaxx_target : 1.0;
            sliderValues[def.id] = chadmaxxIntensity * target;

            // Update visible individual slider
            const slEl = document.getElementById(`slider-${def.id}`);
            if (slEl) slEl.value = sliderValues[def.id];
            const valEl = document.getElementById(`val-${def.id}`);
            if (valEl) {
                const mm = (sliderValues[def.id] * getEffectiveMaxOriginal(def)).toFixed(1);
                valEl.textContent = `${mm}mm`;
            }
        }

        autoRotate = false;
        applyDeformations();
    });
}

// ── Camera controls — yaw only + zoom (matching iOS yawOnly mode) ──
function setupControls(el) {
    el.addEventListener('pointerdown', e => {
        pointerDown = true;
        lastX = e.clientX;
        autoRotate = false;
    });

    el.addEventListener('pointermove', e => {
        if (!pointerDown) return;
        const dx = e.clientX - lastX;
        lastX = e.clientX;
        // Yaw only — horizontal drag rotates around Y
        yawAngle -= dx * 0.008;
        updateCamera();
    });

    el.addEventListener('pointerup', () => { pointerDown = false; });
    el.addEventListener('pointerleave', () => { pointerDown = false; });

    // Scroll zoom
    el.addEventListener('wheel', e => {
        e.preventDefault();
        camDist *= e.deltaY > 0 ? 1.05 : 0.95;
        camDist = Math.max(0.05, camDist);
        updateCamera();
    }, { passive: false });

    // Touch pinch zoom
    el.addEventListener('touchstart', e => {
        if (e.touches.length === 2) {
            const dx = e.touches[0].clientX - e.touches[1].clientX;
            const dy = e.touches[0].clientY - e.touches[1].clientY;
            pinchDist = Math.sqrt(dx * dx + dy * dy);
        }
    }, { passive: true });

    el.addEventListener('touchmove', e => {
        if (e.touches.length === 2) {
            const dx = e.touches[0].clientX - e.touches[1].clientX;
            const dy = e.touches[0].clientY - e.touches[1].clientY;
            const newDist = Math.sqrt(dx * dx + dy * dy);
            if (pinchDist > 0) {
                camDist *= pinchDist / newDist;
                camDist = Math.max(0.05, camDist);
                updateCamera();
            }
            pinchDist = newDist;
        }
    }, { passive: true });
}

// ── Render loop ──
function animate(time) {
    requestAnimationFrame(animate);

    if (autoRotate) {
        const dt = lastTime ? (time - lastTime) / 1000 : 0;
        yawAngle += dt * 0.2;
        updateCamera();
    }
    lastTime = time;

    renderer.render(scene, camera);
}

function onResize() {
    const viewport = document.getElementById('viewport');
    const w = viewport.clientWidth;
    const h = viewport.clientHeight;
    if (w === 0 || h === 0) return;
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
    renderer.setSize(w, h);
}
