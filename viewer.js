// FaceMog Web Share Viewer
// Fetches result.json via share API, renders 3D face with Three.js, supports slider deformation.

const API_BASE = 'https://c969ue4f2j.execute-api.us-east-1.amazonaws.com/prod';

// ── State ──
let scene, camera, renderer, mesh, geometry;
let origPositions, deformedPositions, vertexNormals;
let numVerts, transformDefs, landmarks, frame;
let precomputed = [];
let sliderValues = {};
let selectedCategory = '';

// Camera orbit
let camTheta = 0, camPhi = 0.1, camDist = 0;
let camCenter = new THREE.Vector3();
let autoRotate = true;
let lastTime = 0;

// Touch/mouse state
let pointerDown = false, lastX = 0, lastY = 0;
let pinchDist = 0;

// ── Entry point ──
(async function main() {
    const shareId = getShareId();
    if (!shareId) { showError(); return; }

    try {
        // Resolve share → get presigned URL
        console.log('[FaceMog] Fetching share:', shareId);
        const res = await fetch(`${API_BASE}/v1/share/${shareId}`);
        if (!res.ok) throw new Error(`Share API returned ${res.status}`);
        const shareData = await res.json();
        console.log('[FaceMog] Share resolved, fetching result.json...');

        // Fetch result.json
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
    // URL format: /s/{shareId} or ?id={shareId}
    const path = window.location.pathname;
    const match = path.match(/\/s\/([a-zA-Z0-9]+)/);
    if (match) return match[1];
    return new URLSearchParams(window.location.search).get('id');
}

function showError() {
    document.getElementById('loading').style.display = 'none';
    document.getElementById('error').style.display = 'flex';
}

function setMetaTag(property, content) {
    let tag = document.querySelector(`meta[property="${property}"]`);
    if (tag) tag.setAttribute('content', content);
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

    if (!positions || !faces) { showError(); return; }

    origPositions = new Float32Array(positions);
    deformedPositions = new Float32Array(positions);
    vertexNormals = normals ? new Float32Array(normals) : null;

    // Decode UVs
    let uvs = null;
    if (data.uvs_b64) {
        const raw = decodeFloat32(data.uvs_b64);
        if (raw && raw.length === numVerts * 2) {
            // Flip V for Three.js (bottom-left origin)
            uvs = new Float32Array(raw);
            for (let i = 1; i < uvs.length; i += 2) {
                uvs[i] = 1.0 - uvs[i];
            }
        }
    }

    // Setup Three.js
    const canvas = document.getElementById('canvas');
    const viewport = document.getElementById('viewport');

    scene = new THREE.Scene();
    scene.background = new THREE.Color(0x0a0a0f);

    camera = new THREE.PerspectiveCamera(35, viewport.clientWidth / viewport.clientHeight, 0.01, 1000);
    renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
    renderer.setSize(viewport.clientWidth, viewport.clientHeight);
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));

    // Lights — bright studio rig
    scene.add(new THREE.AmbientLight(0xffffff, 0.7));
    const key = new THREE.DirectionalLight(0xffffff, 0.8);
    key.position.set(1, 1, 2); scene.add(key);
    const fill = new THREE.DirectionalLight(0xccccdd, 0.4);
    fill.position.set(-1, 0.5, 1); scene.add(fill);
    const back = new THREE.DirectionalLight(0x8888aa, 0.25);
    back.position.set(0, -1, -1); scene.add(back);

    // Geometry
    geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.BufferAttribute(deformedPositions, 3));
    geometry.setIndex(new THREE.BufferAttribute(new Uint32Array(faces), 1));
    if (uvs) geometry.setAttribute('uv', new THREE.BufferAttribute(uvs, 2));
    geometry.computeVertexNormals();

    // Center mesh
    const center = computeCenter(origPositions, numVerts);
    const meshOffset = new THREE.Vector3(-center[0], -center[1], -center[2]);

    // Material
    let mat;
    if (data.texture_b64 && uvs) {
        const texImg = new Image();
        texImg.onload = function() {
            const tex = new THREE.Texture(texImg);
            tex.needsUpdate = true;
            tex.flipY = false;
            mat.map = tex;
            mat.needsUpdate = true;
        };
        texImg.src = `data:${data.textureMime || 'image/jpeg'};base64,${data.texture_b64}`;
        mat = new THREE.MeshPhongMaterial({ shininess: 20, specular: 0x111111, flatShading: false });
    } else {
        mat = new THREE.MeshPhongMaterial({ color: 0xd1b8a0, shininess: 40, specular: 0x222233, flatShading: false });
    }

    mesh = new THREE.Mesh(geometry, mat);
    mesh.position.copy(meshOffset);
    scene.add(mesh);

    // Camera setup — orient for face viewing
    setupCamera(origPositions, numVerts, center);

    // Precompute deformation data
    precomputeTransforms();

    // Apply default slider values (shows looksmaxxed version)
    for (const def of transformDefs) {
        sliderValues[def.id] = def.default || 0;
    }
    applyDeformations();

    // Build UI
    buildUI();

    // Events
    setupControls(viewport);
    window.addEventListener('resize', onResize);

    // Show app
    document.getElementById('loading').style.display = 'none';
    document.getElementById('app').style.display = 'flex';

    // Render loop
    requestAnimationFrame(animate);
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
    for (let i = 0; i < n; i++) {
        cx += positions[i * 3];
        cy += positions[i * 3 + 1];
        cz += positions[i * 3 + 2];
    }
    return [cx / n, cy / n, cz / n];
}

// ── Camera ──
function setupCamera(positions, n, center) {
    // Compute bounding sphere
    let maxR = 0;
    for (let i = 0; i < n; i++) {
        const dx = positions[i * 3] - center[0];
        const dy = positions[i * 3 + 1] - center[1];
        const dz = positions[i * 3 + 2] - center[2];
        const r = Math.sqrt(dx * dx + dy * dy + dz * dz);
        if (r > maxR) maxR = r;
    }

    camDist = maxR * 3.2;

    // Orient camera using frame: face should look at camera
    const fwdAxis = frame[0], fwdSign = frame[3];
    // Start with slight angle (like the preview image)
    camTheta = 0.3; // ~17 degrees
    camPhi = 0.1;

    updateCamera();
}

function updateCamera() {
    const x = camDist * Math.sin(camTheta) * Math.cos(camPhi);
    const y = camDist * Math.sin(camPhi);
    const z = camDist * Math.cos(camTheta) * Math.cos(camPhi);
    camera.position.set(x, y, z);
    camera.lookAt(0, 0, 0);
}

// ── Coordinate frame ──
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
            // Use precomputed geodesic fields if available
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

            // Fallback: compute from landmarks
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

// ── Deformation engine ──
function applyDeformations() {
    deformedPositions.set(origPositions);

    for (let di = 0; di < transformDefs.length; di++) {
        const def = transformDefs[di];
        const sliderVal = sliderValues[def.id] || 0;
        if (sliderVal < 0.001) continue;

        const magnitude = sliderVal * def.max_mm;

        for (let si = 0; si < def.transforms.length; si++) {
            const pre = precomputed[di] && precomputed[di][si];
            if (!pre) continue;

            const subMag = magnitude * pre.magnitudeScale;
            const { vertIndices, weights, operation } = pre;

            if (pre.useDisplacements && pre.displacements) {
                // Use precomputed per-vertex displacement directions
                for (let k = 0; k < vertIndices.length; k++) {
                    const i3 = vertIndices[k] * 3;
                    const k3 = k * 3;
                    const w = weights[k];
                    deformedPositions[i3] += pre.displacements[k3] * subMag * w;
                    deformedPositions[i3 + 1] += pre.displacements[k3 + 1] * subMag * w;
                    deformedPositions[i3 + 2] += pre.displacements[k3 + 2] * subMag * w;
                }
            } else if (operation === 'translate' && pre.scanDir) {
                const dx = pre.scanDir[0] * subMag;
                const dy = pre.scanDir[1] * subMag;
                const dz = pre.scanDir[2] * subMag;
                for (let k = 0; k < vertIndices.length; k++) {
                    const i3 = vertIndices[k] * 3;
                    const w = weights[k];
                    deformedPositions[i3] += dx * w;
                    deformedPositions[i3 + 1] += dy * w;
                    deformedPositions[i3 + 2] += dz * w;
                }
            } else if (operation === 'inflate' || operation === 'deflate') {
                const sign = operation === 'inflate' ? 1 : -1;
                if (!vertexNormals) continue;
                for (let k = 0; k < vertIndices.length; k++) {
                    const idx = vertIndices[k];
                    const i3 = idx * 3;
                    const w = weights[k];
                    deformedPositions[i3] += vertexNormals[i3] * sign * subMag * w;
                    deformedPositions[i3 + 1] += vertexNormals[i3 + 1] * sign * subMag * w;
                    deformedPositions[i3 + 2] += vertexNormals[i3 + 2] * sign * subMag * w;
                }
            }
        }
    }

    // Update geometry
    geometry.attributes.position.needsUpdate = true;
    geometry.computeVertexNormals();
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
            const mm = (val * (def.max_mm_original || def.max_mm)).toFixed(1);

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
                const newMm = (v * (def.max_mm_original || def.max_mm)).toFixed(1);
                document.getElementById(`val-${def.id}`).textContent = `${newMm}mm`;
                autoRotate = false;
                applyDeformations();
            });

            sliderContainer.appendChild(card);
        }
    }
}

// ── Camera controls ──
function setupControls(el) {
    el.addEventListener('pointerdown', e => {
        pointerDown = true;
        lastX = e.clientX;
        lastY = e.clientY;
        autoRotate = false;
    });

    el.addEventListener('pointermove', e => {
        if (!pointerDown) return;
        const dx = e.clientX - lastX;
        const dy = e.clientY - lastY;
        lastX = e.clientX;
        lastY = e.clientY;

        camTheta -= dx * 0.008;
        camPhi = Math.max(-Math.PI / 3, Math.min(Math.PI / 3, camPhi + dy * 0.008));
        updateCamera();
    });

    el.addEventListener('pointerup', () => { pointerDown = false; });
    el.addEventListener('pointerleave', () => { pointerDown = false; });

    // Pinch zoom
    el.addEventListener('wheel', e => {
        e.preventDefault();
        camDist *= e.deltaY > 0 ? 1.05 : 0.95;
        camDist = Math.max(0.1, camDist);
        updateCamera();
    }, { passive: false });

    // Touch pinch
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
                camDist = Math.max(0.1, camDist);
                updateCamera();
            }
            pinchDist = newDist;
        }
    }, { passive: true });
}

// ── Render loop ──
function animate(time) {
    requestAnimationFrame(animate);

    // Auto-rotate slowly
    if (autoRotate) {
        const dt = lastTime ? (time - lastTime) / 1000 : 0;
        camTheta += dt * 0.2; // ~12 deg/sec
        updateCamera();
    }
    lastTime = time;

    renderer.render(scene, camera);
}

function onResize() {
    const viewport = document.getElementById('viewport');
    const w = viewport.clientWidth;
    const h = viewport.clientHeight;
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
    renderer.setSize(w, h);
}
