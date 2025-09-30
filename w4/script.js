// 3D Data Visualization with Three.js

class DataVisualization3D {
    constructor() {
        this.scene = null;
        this.camera = null;
        this.renderer = null;
        this.controls = null;
        this.is2DMode = false;
        this.orthoCamera = null;
        this.textSprites = [];
        this.circles = [];
        this.connections = [];
        this.selectedNodeId = null;

        // Mouse interaction variables
        this.mouse = new THREE.Vector2();
        this.raycaster = new THREE.Raycaster();
        this.lastMouseX = 0;
        this.lastMouseY = 0;
        this.rotationSpeed = 0.01;
        this.zoomSpeed = 0.05;
        this.panSpeed = 0.05;

        // Drag state to control interactions
        this.isDragging = false;

        // Inertia for smoother movement
        this.velocityX = 0;
        this.velocityY = 0;
        this.friction = 0.95;

        // Camera movement variables
        this.isMovingToTarget = false;
        this.targetPosition = null;
        this.targetLookAt = null;
        this.movementSpeed = 0.05;
        this.isInFocusView = false;

        // Test data - 10 words with relationships
        this.testData = [
            { id: 1, text: "Artificial Intelligence", category: "Technology", color: 0x00ff88 },
            { id: 2, text: "Machine Learning", category: "Technology", color: 0x0088ff },
            { id: 3, text: "Data Science", category: "Technology", color: 0xff8800 },
            { id: 4, text: "Neural Networks", category: "Technology", color: 0xff0088 },
            { id: 5, text: "Deep Learning", category: "Technology", color: 0x8800ff },
            { id: 6, text: "Algorithm", category: "Technology", color: 0x88ff00 },
            { id: 7, text: "Big Data", category: "Technology", color: 0x00ffff },
            { id: 8, text: "Analytics", category: "Technology", color: 0xff4444 },
            { id: 9, text: "Innovation", category: "Concept", color: 0x44ff44 },
            { id: 10, text: "Research", category: "Concept", color: 0x4444ff }
        ];

        // Define relationships between words
        this.relationships = [
            { from: 1, to: 2, strength: 0.9 }, // AI -> ML
            { from: 1, to: 4, strength: 0.8 }, // AI -> Neural Networks
            { from: 2, to: 5, strength: 0.9 }, // ML -> Deep Learning
            { from: 2, to: 3, strength: 0.7 }, // ML -> Data Science
            { from: 3, to: 7, strength: 0.8 }, // Data Science -> Big Data
            { from: 3, to: 8, strength: 0.9 }, // Data Science -> Analytics
            { from: 4, to: 5, strength: 0.8 }, // Neural Networks -> Deep Learning
            { from: 5, to: 6, strength: 0.6 }, // Deep Learning -> Algorithm
            { from: 6, to: 1, strength: 0.7 }, // Algorithm -> AI
            { from: 7, to: 8, strength: 0.8 }, // Big Data -> Analytics
            { from: 1, to: 9, strength: 0.6 }, // AI -> Innovation
            { from: 3, to: 10, strength: 0.7 }, // Data Science -> Research
            { from: 9, to: 10, strength: 0.8 }, // Innovation -> Research
            { from: 2, to: 9, strength: 0.5 }, // ML -> Innovation
            { from: 8, to: 9, strength: 0.6 }  // Analytics -> Innovation
        ];

        // Configurable visualization parameters
        this.maxWords = 100; // maximum words to visualize
        this.maxEdgesPerNode = 5; // cap edges among related words per node
        this.secondaryFetchLimit = 20; // how many related words to fetch per related term
        this.secondaryFetchConcurrency = 5; // concurrent fetches to Datamuse
        this.fullViewMargin3D = 1.5 // margin multiplier for 3D full view framing
        this.fullViewMargin2D = 1.2; // margin multiplier for 2D full view framing
        this.nodeSpacingFactor = 0.5; // >1 spreads nodes farther apart globally
        this.verticalSpreadFactor = 1.0; // >1 increases vertical spread (Y), <1 compresses
        this.horizontalSpreadFactor = 2.0; // >1 increases horizontal spread (X), <1 compresses

        // Force-directed layout parameters
        this.layoutIterations = 500;
        this.layoutAreaRadius = 30; // initial placement radius
        this.layoutRepulsion = 2000; // higher spreads nodes apart
        this.layoutSpringStrength = 0.02; // pull along edges
        this.layoutSpringBaseLength = 8; // base target length for edges
        this.layoutCenterPull = 0.005; // slight pull to center
        this.layoutMaxVelocity = 1.0; // clamp velocity per step
        this.layoutTimeStep = 0.02;
        this.layoutZJitter = 0.2; // small z jitter for 2D to avoid z-fighting

        // Will be filled by computeLayoutPositions
        this.nodePositions = null; // Map<id, THREE.Vector3>
        this.clusterAssignments = new Map(); // id -> array of cluster indices
        this.activeClusterFilter = null; // null => show all
        this.clustersDirty = false; // flag to update filter/appearance lazily
        this.panSpeed2D = 1.0; // drag-to-pan speed multiplier for 2D mode
        this.useUMAPClustering = true; // color clusters by original embedding proximity when available
        this.numUMAPClusters = 7;
        this.lockCameraPosition = false; // when true, don't overwrite 3D camera each frame
        // Morph animation state (for transitioning to UMAP positions)
        this.isMorphing = false;
        this.morphSpeed = 0.05; // 0..1 per frame
        this.morphProgress = 0;
        this.morphStartPositions = new Map(); // id -> Vector3
        this.morphTargetPositions = new Map(); // id -> Vector3
        this.morphTextStart = new Map(); // id -> Vector3
        this.morphTextTarget = new Map(); // id -> Vector3
        this.rebuildConnectionsAfterMorph = false; // flag to rebuild lines after morph ends

        // Cluster palette and labels (index -> meaning)
        this.clusterPalette = [0xff4d4d, 0xffa64d, 0xffee4d, 0x66ff66, 0x4dd2ff, 0x7a66ff, 0xff66d9];
        this.clusterLabels = [
            'Actions (Verbs)',
            'Attributes (Adjectives)',
            'Modifiers (Adverbs)',
            'Entities/Concepts (Nouns)',
            'Proper/Named Entities',
            'Multi-category',
            'Other/Unknown'
        ];

        this.init();
    }

    init() {
        console.log('Initializing 3D visualization...');

        this.setupScene();
        console.log('Scene setup complete');

        this.setupCamera();
        console.log('Camera setup complete');

        this.setupRenderer();
        console.log('Renderer setup complete');

        this.setupControls();
        console.log('Controls setup complete');

        // Compute initial layout positions (start in 3D)
        try {
            this.computeLayoutPositions(false);
        } catch (e) {
            console.warn('Layout computation failed for initial data, using fallback placement.', e);
        }

        // Assign demo clusters for initial data if none present
        this.ensureClustersAssigned();
        this.createDataObjects();
        console.log('Data objects created');

        this.createConnections();
        console.log('Connections created');

        this.setupEventListeners();
        console.log('Event listeners setup complete');

        console.log('Starting animation loop...');
        // Ensure ortho camera exists for later 2D mode and apply initial cluster appearance
        if (!this.orthoCamera) this.createOrthoCamera();
        this.clustersDirty = true;
        this.animate();

        // After first frame, frame full view in 3D
        setTimeout(() => {
            if (!this.is2DMode) {
                this.zoomToFullView();
            }
        }, 0);
    }

    setupScene() {
        this.scene = new THREE.Scene();
        this.scene.background = new THREE.Color(0xffffff);

        // Root group to rotate entire content as a unit
        this.rootGroup = new THREE.Group();
        this.scene.add(this.rootGroup);

        // Basic brighter lighting setup
        const ambientLight = new THREE.AmbientLight(0xffffff, 0.7);
        this.scene.add(ambientLight);

        const hemiLight = new THREE.HemisphereLight(0xffffff, 0xb0b0b0, 0.9);
        this.scene.add(hemiLight);

        const directionalLight = new THREE.DirectionalLight(0xffffff, 1.2);
        directionalLight.position.set(10, 10, 10);
        directionalLight.castShadow = true;
        directionalLight.shadow.mapSize.width = 2048;
        directionalLight.shadow.mapSize.height = 2048;
        directionalLight.shadow.camera.near = 0.5;
        directionalLight.shadow.camera.far = 100;
        directionalLight.shadow.camera.left = -20;
        directionalLight.shadow.camera.right = 20;
        directionalLight.shadow.camera.top = 20;
        directionalLight.shadow.camera.bottom = -20;
        this.scene.add(directionalLight);
    }

    setupCamera() {
        const canvas = document.getElementById('threeCanvas');
        this.camera = new THREE.PerspectiveCamera(
            75,
            canvas.clientWidth / canvas.clientHeight,
            0.1,
            1000
        );
        this.camera.position.set(0, 0, 8);
        this.camera.lookAt(0, 0, 0);
        console.log('Camera setup complete');
    }

    setupRenderer() {
        const canvas = document.getElementById('threeCanvas');
        this.renderer = new THREE.WebGLRenderer({
            canvas: canvas,
            antialias: true,
            alpha: false
        });
        this.renderer.setSize(canvas.clientWidth, canvas.clientHeight);
        this.renderer.setPixelRatio(window.devicePixelRatio);
        this.renderer.setClearColor(0xffffff, 1);

        // Enable shadow rendering
        this.renderer.shadowMap.enabled = true;
        this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;

        console.log('Renderer setup complete');
    }

    setupControls() {
        // Controls for rotation and zoom
        this.controls = {
            rotationX: 0,
            rotationY: 0,
            zoom: 0.8,
            panX: 0,
            panY: 0
        };
    }

    createDataObjects() {
        console.log('Creating text sprites and circles...');

        // Create text sprites and circles for each data point
        this.testData.forEach((data, index) => {
            console.log(`Creating text sprite ${index + 1}: ${data.text}`);

            // Position from layout if available, else fallback to sphere
            let position = null;
            if (this.nodePositions && this.nodePositions.has(data.id)) {
                position = this.nodePositions.get(data.id).clone();
            } else {
                const phi = Math.acos(1 - 2 * index / this.testData.length);
                const theta = Math.PI * (1 + Math.sqrt(5)) * index;
                const radius = 5;
                position = new THREE.Vector3(
                    Math.cos(theta) * Math.sin(phi) * radius,
                    Math.cos(phi) * radius,
                    Math.sin(theta) * Math.sin(phi) * radius
                );
            }

            // Create text sprite
            const textSprite = this.createTextSprite(data.text, position, data.color);
            textSprite.userData.id = data.id;
            textSprite.userData.category = data.category;
            this.textSprites.push(textSprite);

            // Create circle below text
            const circle = this.createCircle(position, data.color);
            circle.userData.id = data.id;
            circle.userData.connectedText = textSprite;
            textSprite.userData.connectedCircle = circle;
            this.circles.push(circle);
        });

        console.log(`Created ${this.textSprites.length} text sprites and ${this.circles.length} circles`);
    }

    createTextSprite(text, position, color) {
        const canvas = document.createElement('canvas');
        const context = canvas.getContext('2d');
        canvas.width = 512;
        canvas.height = 128;

        // Clear canvas with transparent background
        context.clearRect(0, 0, canvas.width, canvas.height);

        // Set font and style
        context.font = 'Bold 24px Arial';
        context.fillStyle = '#000000';
        context.strokeStyle = '#000000';
        context.lineWidth = 2;
        context.textAlign = 'center';
        context.textBaseline = 'middle';

        // Draw text with outline
        context.strokeText(text, 256, 64);
        context.fillText(text, 256, 64);

        // Create texture
        const texture = new THREE.CanvasTexture(canvas);
        texture.needsUpdate = true;

        // Create sprite material
        const spriteMaterial = new THREE.SpriteMaterial({
            map: texture,
            transparent: true,
            opacity: 0.9,
            alphaTest: 0.1
        });

        // Create sprite
        const sprite = new THREE.Sprite(spriteMaterial);
        sprite.position.copy(position);

        // Position text slightly away from sphere center
        let direction = position.clone().normalize();
        if (direction.length() < 0.0001) {
            direction = new THREE.Vector3(0, 1, 0);
        }
        sprite.position.add(direction.multiplyScalar(0.8));

        sprite.scale.set(4, 1, 1);

        // Store reference for later use
        sprite.userData = {
            text: text,
            originalPosition: position.clone()
        };

        this.rootGroup.add(sprite);
        return sprite;
    }

    createCircle(position, color) {
        // Create sphere geometry
        const geometry = new THREE.SphereGeometry(0.2, 32, 32);

        // White opaque glass-like material (bright, minimal transparency)
        const material = new THREE.MeshPhysicalMaterial({
            color: 0xffffff,
            roughness: 0.15,
            metalness: 0.0,
            transmission: 0.0, // opaque glass feel
            ior: 1.45,
            thickness: 0.5,
            clearcoat: 1.0,
            clearcoatRoughness: 0.05,
            reflectivity: 0.4,
            envMapIntensity: 1.0,
            transparent: true,
            opacity: 0.95
        });

        // Create mesh
        const sphere = new THREE.Mesh(geometry, material);
        sphere.position.copy(position);

        // Enable shadows
        sphere.castShadow = true;
        sphere.receiveShadow = true;

        // Store reference for later use
        sphere.userData = {
            originalPosition: position.clone(),
            connectedText: null // Will be set later
        };

        this.rootGroup.add(sphere);
        return sphere;
    }

    createConnections() {
        // Remove existing lines
        if (this.connections && this.connections.length) {
            this.connections.forEach(line => {
                this.rootGroup.remove(line);
                if (line.geometry) line.geometry.dispose?.();
                if (line.material) line.material.dispose?.();
            });
        }
        this.connections = [];

        // Build cluster-based star connections (center -> others) using current positions
        // Only proceed if cluster assignments and positions exist
        if (!this.clusterAssignments || this.clusterAssignments.size === 0) return;

        const idToPosition = new Map();
        // Prefer computed nodePositions, fallback to current circle positions
        if (this.nodePositions && this.nodePositions.size > 0) {
            this.testData.forEach(d => {
                const p = this.nodePositions.get(d.id);
                if (p) idToPosition.set(d.id, p.clone());
            });
        } else {
            this.circles.forEach(c => idToPosition.set(c.userData.id, c.position.clone()));
        }
        if (idToPosition.size === 0) return;

        // Group ids by their primary cluster (first assignment)
        const clusterToIds = new Map();
        this.testData.forEach(d => {
            const clusters = this.clusterAssignments.get(d.id);
            if (!clusters || clusters.length === 0) return;
            const cId = clusters[0];
            if (!clusterToIds.has(cId)) clusterToIds.set(cId, []);
            clusterToIds.get(cId).push(d.id);
        });

        clusterToIds.forEach((ids, cId) => {
            if (!ids || ids.length < 2) return;
            // Compute centroid and find center id
            const centroid = new THREE.Vector3();
            let count = 0;
            ids.forEach(id => {
                const p = idToPosition.get(id);
                if (p) { centroid.add(p); count++; }
            });
            if (count === 0) return;
            centroid.multiplyScalar(1 / count);
            let centerId = ids[0];
            let bestD2 = Infinity;
            ids.forEach(id => {
                const p = idToPosition.get(id);
                if (!p) return;
                const d2 = centroid.distanceToSquared(p);
                if (d2 < bestD2) { bestD2 = d2; centerId = id; }
            });

            // Material color by cluster palette
            const colorHex = this.clusterPalette ? this.clusterPalette[cId % this.clusterPalette.length] : 0xffffff;
            const lineMat = new THREE.LineBasicMaterial({ color: colorHex, transparent: true, opacity: 0.5 });

            const centerPos = idToPosition.get(centerId);
            if (!centerPos) return;
            ids.forEach(id => {
                if (id === centerId) return;
                const p = idToPosition.get(id);
                if (!p) return;
                const geom = new THREE.BufferGeometry().setFromPoints([centerPos, p]);
                const line = new THREE.Line(geom, lineMat.clone());
                line.userData = { from: centerId, to: id, cluster: cId, baseOpacity: 0.5 };
                this.rootGroup.add(line);
                this.connections.push(line);
            });
        });
    }

    setupEventListeners() {
        const canvas = document.getElementById('threeCanvas');

        // Mouse events
        canvas.addEventListener('mousedown', (event) => this.onMouseDown(event));
        canvas.addEventListener('mousemove', (event) => this.onMouseMove(event));
        canvas.addEventListener('mouseup', (event) => this.onMouseUp(event));
        canvas.addEventListener('mouseleave', () => { this.isDragging = false; });
        canvas.addEventListener('wheel', (event) => this.onMouseWheel(event));
        canvas.addEventListener('click', (event) => this.onMouseClick(event));

        // Prevent context menu on right click
        canvas.addEventListener('contextmenu', (event) => event.preventDefault());

        // Window resize
        window.addEventListener('resize', () => {
            this.onWindowResize();
        });

        // View toggle buttons
        const btn2D = document.getElementById('view2DBtn');
        const btn3D = document.getElementById('view3DBtn');
        const btnFull = document.getElementById('viewFullBtn');
        const btnZoomIn2D = document.getElementById('zoomIn2D');
        const btnZoomOut2D = document.getElementById('zoomOut2D');
        const setMode = (use2D) => {
            this.is2DMode = use2D;
            if (btn2D && btn3D) {
                btn2D.classList.toggle('active', use2D);
                btn2D.setAttribute('aria-pressed', use2D ? 'true' : 'false');
                btn3D.classList.toggle('active', !use2D);
                btn3D.setAttribute('aria-pressed', !use2D ? 'true' : 'false');
            }
            // Reset focus when switching modes
            this.isInFocusView = false;
            this.isMovingToTarget = false;
            this.targetPosition = null;
            this.targetLookAt = null;
            // Reset rotation for a clean 2D front view
            if (this.is2DMode && this.rootGroup) {
                this.rootGroup.quaternion.identity();
            }
            // Initialize or update orthographic camera
            if (this.is2DMode && !this.orthoCamera) {
                this.createOrthoCamera();
            }
            this.onWindowResize();

            // When switching to 3D, recompute layout/positions for 3D and rebuild
            if (!use2D) {
                this.lockCameraPosition = false; // allow animate() to manage camera unless user zooms/full
                const rebuildWithPositions = (positions3d) => {
                    if (positions3d && positions3d.length === this.testData.length) {
                        const scale = this.layoutAreaRadius * 0.8;
                        this.nodePositions = new Map();
                        for (let i = 0; i < this.testData.length; i++) {
                            const p = positions3d[i];
                            this.nodePositions.set(this.testData[i].id, new THREE.Vector3(p.x * scale, p.y * scale, (p.z ?? 0) * scale));
                        }
                    } else {
                        // fallback to force layout in 3D
                        this.computeLayoutPositions(false);
                    }
                    this.resetSceneObjects();
                    this.createDataObjects();
                    this.createConnections();
                    this.ensureClustersAssigned();
                    this.clustersDirty = true;
                };

                if (window.UMAPProjector && window.ProxyAI && Array.isArray(this.testData) && this.testData.length > 0) {
                    const texts = this.testData.map(d => d.text);
                    Promise.resolve()
                        .then(() => window.UMAPProjector.projectTextsUMAP3D(texts, { nNeighbors: (this.advOptions?.neighbors ?? 15), minDist: (this.advOptions?.minDist ?? 0.1) }))
                        .then(points3d => rebuildWithPositions(points3d))
                        .catch(() => { rebuildWithPositions(null); });
                } else {
                    rebuildWithPositions(null);
                }
            }
        };
        if (btn2D) btn2D.addEventListener('click', () => setMode(true));
        if (btn3D) btn3D.addEventListener('click', () => setMode(false));
        // Initialize toggle visual state for default 3D
        if (btn2D && btn3D) {
            btn2D.classList.toggle('active', false);
            btn2D.setAttribute('aria-pressed', 'false');
            btn3D.classList.toggle('active', true);
            btn3D.setAttribute('aria-pressed', 'true');
        }
        if (btnFull) btnFull.addEventListener('click', () => this.zoomToFullView());
        if (btnZoomIn2D) btnZoomIn2D.addEventListener('click', () => {
            if (this.is2DMode) {
                this.zoom2D(1.2);
            } else {
                this.zoom3D(1.2); // zoom in
            }
        });
        if (btnZoomOut2D) btnZoomOut2D.addEventListener('click', () => {
            if (this.is2DMode) {
                this.zoom2D(1 / 1.2);
            } else {
                this.zoom3D(1 / 1.2); // zoom out (factor < 1 increases distance)
            }
        });

        // Cluster filter events
        const clusterFilter = document.getElementById('clusterFilter');
        if (clusterFilter) {
            const chips = clusterFilter.querySelectorAll('.cluster-chip');
            chips.forEach(chip => {
                chip.addEventListener('click', () => {
                    const idx = parseInt(chip.getAttribute('data-cluster'));
                    this.activeClusterFilter = Number.isNaN(idx) ? null : idx;
                    this.clustersDirty = true;
                });
            });
            const clearBtn = document.getElementById('clusterClearBtn');
            if (clearBtn) {
                clearBtn.addEventListener('click', () => {
                    this.activeClusterFilter = null;
                    this.clustersDirty = true;
                });
            }
        }


        const advApply = document.getElementById('advApply');
        const advQuery = document.getElementById('advQuery');
        const advSimilarity = document.getElementById('advSimilarity');

        const advValence = document.getElementById('advValence');
        const advArousal = document.getElementById('advArousal');
        const senseVision = document.getElementById('senseVision');
        const senseAudition = document.getElementById('senseAudition');
        const senseTouch = document.getElementById('senseTouch');
        const senseTaste = document.getElementById('senseTaste');
        const senseSmell = document.getElementById('senseSmell');

        if (advApply) {
            advApply.addEventListener('click', async () => {
                const term = (advQuery?.value || '').trim();
                if (!term) return;
                const statusEl = document.getElementById('advStatus');
                const setStatus = (msg) => { if (statusEl) statusEl.textContent = msg || ''; };
                try {
                    // Option examples: tune neighbors/minDist from Similar/Novel; language flags unused placeholder
                    const neighbors = 5 + Math.floor(((advSimilarity?.valueAsNumber ?? 50) / 100) * 45); // 5..50
                    const minDist = 0.05 + ((100 - (advSimilarity?.valueAsNumber ?? 50)) / 100) * 0.45; // 0.05..0.5
                    // Store options for later (could bias fetch or clustering)
                    this.advOptions = {
                        valence: advValence?.valueAsNumber ?? 50,
                        arousal: advArousal?.valueAsNumber ?? 50,
                        hemisphereRight: false,
                        senses: {
                            vision: senseVision?.valueAsNumber ?? 50,
                            audition: senseAudition?.valueAsNumber ?? 50,
                            touch: senseTouch?.valueAsNumber ?? 50,
                            taste: senseTaste?.valueAsNumber ?? 50,
                            smell: senseSmell?.valueAsNumber ?? 50,
                        },
                        similarity: advSimilarity?.valueAsNumber ?? 50,
                        neighbors,
                        minDist,
                    };

                    // Run visualize and then UMAP with tuned params
                    if (window.UMAPProjector && window.ProxyAI) {
                        setStatus('fetching data...');
                        await this.visualizeForQuery(term, this.advOptions);
                        const texts = this.testData.map(d => d.text);
                        const scale = this.layoutAreaRadius * 0.8;
                        let points2d = null;
                        let points3d = null;
                        setStatus('embedding...');
                        if (this.is2DMode) {
                            points2d = await window.UMAPProjector.projectTextsUMAP(texts, { nNeighbors: neighbors, minDist });
                        } else {
                            points3d = await window.UMAPProjector.projectTextsUMAP3D(texts, { nNeighbors: neighbors, minDist });
                        }
                        const ok2d = Array.isArray(points2d) && points2d.length === this.testData.length;
                        const ok3d = Array.isArray(points3d) && points3d.length === this.testData.length;
                        if (ok2d || ok3d) {
                            // Prepare morph from current positions to UMAP targets
                            this.morphStartPositions = new Map();
                            this.morphTargetPositions = new Map();
                            this.morphTextStart = new Map();
                            this.morphTextTarget = new Map();
                            for (let i = 0; i < this.testData.length; i++) {
                                const id = this.testData[i].id;
                                const circle = this.circles.find(c => c.userData.id === id);
                                const text = this.textSprites.find(t => t.userData.id === id);
                                if (circle) this.morphStartPositions.set(id, circle.position.clone());
                                if (text) this.morphTextStart.set(id, text.position.clone());
                                const p = ok2d ? points2d[i] : points3d[i];
                                const target = new THREE.Vector3(p.x * scale, p.y * scale, (p.z || 0) * scale);
                                this.morphTargetPositions.set(id, target.clone());
                                if (text) this.morphTextTarget.set(id, target.clone());
                            }
                            // Keep canonical nodePositions in sync with UMAP targets
                            this.nodePositions = new Map();
                            for (const [id, vec] of this.morphTargetPositions.entries()) {
                                this.nodePositions.set(id, vec.clone());
                            }
                            this.isMorphing = true;
                            this.morphProgress = 0;
                            this.rebuildConnectionsAfterMorph = true; // refresh lines at final positions
                            if (this.useUMAPClustering) {
                                const vectors = window.__lastEmbeddingVectors;
                                const coords = Array.isArray(vectors) && vectors.length === this.testData.length ? vectors : null;
                                const labels = coords ? this.kMeansCluster(coords, this.numUMAPClusters, 25) : null;
                                this.clusterAssignments = new Map();
                                if (labels) {
                                    for (let i = 0; i < this.testData.length; i++) {
                                        this.clusterAssignments.set(this.testData[i].id, [labels[i]]);
                                    }
                                }
                            }
                            // trigger colors/visibility update without rebuilding scene
                            this.ensureClustersAssigned();
                            this.clustersDirty = true;
                        }
                    } else {
                        setStatus('fetching data...');
                        await this.visualizeForQuery(term, this.advOptions);
                    }
                    setStatus('');
                } catch (e) {
                    console.error(e);
                    const statusEl2 = document.getElementById('advStatus');
                    if (statusEl2) statusEl2.textContent = 'Error';
                }
            });
        }
    }

    async visualizeForQuery(term, adv = null) {
        // Fetch related words via LLM generator (replaces Datamuse)
        try {
            const llmOk = !!(window.ProxyAI && window.ProxyAI.generateRelatedWordsLLM);
            const llm = llmOk ? await window.ProxyAI.generateRelatedWordsLLM({
                keyword: term,
                maxWords: this.maxWords,
                similarity: adv?.similarity ?? 50,
                valence: adv?.valence ?? 50,
                arousal: adv?.arousal ?? 50,
                senses: adv?.senses || {},
            }) : { words: [] };

            const related = Array.isArray(llm.words) ? llm.words : [];

            // Build data and relationships: term at center, related words connected
            const baseColor = 0x00ff88;
            const relatedColor = 0xffffff;

            this.testData = [{ id: 1, text: term, category: 'Query', color: baseColor }];
            let idCounter = 2;
            this.relationships = [];
            const textToId = new Map();
            textToId.set(term, 1);
            related.forEach((word) => {
                const text = String(word || '').trim();
                if (!text) return;
                const id = idCounter++;
                this.testData.push({ id, text, category: 'Related', color: relatedColor });
                textToId.set(text, id);
                // Link each word to the query term
                this.relationships.push({ from: 1, to: id, strength: 0.5 });
                // Initial placeholder cluster (k-means will refine later)
                const seed = (text.charCodeAt(0) + text.length) % 7;
                this.clusterAssignments.set(id, [seed]);
            });
            // Root term cluster
            this.clusterAssignments.set(1, [0]);

            // Compute layout (2D or 3D depending on current mode)
            this.computeLayoutPositions(this.is2DMode);

            // Rebuild scene objects
            this.resetSceneObjects();
            this.createDataObjects();
            this.createConnections();
            // Apply cluster colors/visibility now for new data
            this.ensureClustersAssigned();
            this.clustersDirty = true;

            // Clear selection/focus
            this.selectedNodeId = null;
            this.isInFocusView = false;
            this.isMovingToTarget = false;
            this.targetPosition = null;
            this.targetLookAt = null;
        } catch (err) {
            console.error('Failed to visualize term', err);
        }
    }

    updateClusterFilterAppearance() {
        const clusters = [0xff4d4d, 0xffa64d, 0xffee4d, 0x66ff66, 0x4dd2ff, 0x7a66ff, 0xff66d9];
        // Update spheres
        let visibleCount = 0;
        this.circles.forEach(sphere => {
            const id = sphere.userData.id;
            const assigned = this.clusterAssignments.get(id) || [];
            const hasAssignment = assigned.length > 0;
            const colors = hasAssignment ? assigned.map(i => clusters[i % clusters.length]) : [0xffffff];
            this.applyGlassGradientMaterial(sphere, colors);
            // If filtering is active, only hide nodes that have assignments and do not match.
            const matches = (this.activeClusterFilter == null) || (hasAssignment && assigned.includes(this.activeClusterFilter));
            sphere.visible = matches || !hasAssignment;
            if (sphere.userData.connectedText) sphere.userData.connectedText.visible = sphere.visible;
            if (sphere.visible) visibleCount++;
        });

        // If filter produced no visible nodes, clear filter to avoid empty screen
        if (this.activeClusterFilter != null && visibleCount === 0) {
            this.activeClusterFilter = null;
            this.circles.forEach(sphere => {
                sphere.visible = true;
                if (sphere.userData.connectedText) sphere.userData.connectedText.visible = true;
            });
        }
        // Update lines
        const visibleById = new Map(this.circles.map(c => [c.userData.id, c.visible !== false]));
        this.connections.forEach(line => {
            const fromV = visibleById.get(line.userData.from);
            const toV = visibleById.get(line.userData.to);
            // If filtering inactive, keep original visibility; when active, hide if any endpoint hidden
            line.visible = (this.activeClusterFilter == null) ? true : (!!fromV && !!toV);
        });
    }

    applyGlassGradientMaterial(sphere, colorHexes) {
        const desiredSegments = 32;
        if (!sphere.geometry || !sphere.geometry.attributes) return;
        const geo = sphere.geometry;
        if (geo.parameters && geo.parameters.widthSegments < desiredSegments) {
            const newGeo = new THREE.SphereGeometry(0.2, desiredSegments, desiredSegments);
            sphere.geometry.dispose?.();
            sphere.geometry = newGeo;
        }
        const g = sphere.geometry;
        const pos = g.attributes.position;
        const count = pos.count;
        const colors = new Float32Array(count * 3);
        const stops = colorHexes.slice(0, 3);
        while (stops.length < 3) stops.push(stops[stops.length - 1]);
        const stopCols = stops.map(h => new THREE.Color(h));
        for (let i = 0; i < count; i++) {
            const y = pos.getY(i);
            const range = 0.2;
            const t = THREE.MathUtils.clamp((y + range) / (2 * range), 0, 1);
            let col;
            if (t < 0.5) {
                col = stopCols[0].clone().lerp(stopCols[1], t / 0.5);
            } else {
                col = stopCols[1].clone().lerp(stopCols[2], (t - 0.5) / 0.5);
            }
            colors[i * 3] = col.r;
            colors[i * 3 + 1] = col.g;
            colors[i * 3 + 2] = col.b;
        }
        g.setAttribute('color', new THREE.BufferAttribute(colors, 3));
        const mat = new THREE.MeshPhysicalMaterial({
            vertexColors: true,
            roughness: 0.15,
            metalness: 0.0,
            transmission: 0.0, // opaque look
            ior: 1.45,
            thickness: 0.5,
            clearcoat: 1.0,
            clearcoatRoughness: 0.05,
            reflectivity: 0.4,
            envMapIntensity: 1.0,
            transparent: true,
            opacity: 0.95
        });
        sphere.material.dispose?.();
        sphere.material = mat;
    }

    async fetchRelatedWords(term, limit) {
        // Request meanings and part-of-speech tags to derive clusters
        const url = `https://api.datamuse.com/words?ml=${encodeURIComponent(term)}&md=p&max=${encodeURIComponent(limit)}`;
        const res = await fetch(url, { method: 'GET' });
        if (!res.ok) throw new Error(`Datamuse error ${res.status}`);
        const data = await res.json();
        return Array.isArray(data) ? data : [];
    }

    async fetchRelatedMap(terms, perTermLimit, concurrency) {
        // Fetch related words for each term with limited concurrency
        const results = new Map(); // term -> Map(relatedWord -> score)
        const queue = [...terms];
        const workers = new Array(Math.max(1, Math.min(concurrency || 1, queue.length))).fill(null).map(() => (async () => {
            while (queue.length > 0) {
                const t = queue.shift();
                try {
                    const arr = await this.fetchRelatedWords(t, perTermLimit);
                    const m = new Map();
                    for (const item of arr) {
                        if (item && item.word) {
                            m.set(item.word, item.score || 50);
                        }
                    }
                    results.set(t, m);
                } catch (e) {
                    console.warn('Failed fetching related for', t, e);
                    results.set(t, new Map());
                }
            }
        })());
        await Promise.all(workers);
        return results;
    }

    resetSceneObjects() {
        // Remove existing sprites, spheres, and lines from rootGroup
        this.textSprites.forEach(obj => this.rootGroup.remove(obj));
        this.circles.forEach(obj => this.rootGroup.remove(obj));
        this.connections.forEach(obj => this.rootGroup.remove(obj));
        this.textSprites = [];
        this.circles = [];
        this.connections = [];
    }

    ensureClustersAssigned() {
        if (!this.clusterAssignments) this.clusterAssignments = new Map();
        for (const d of this.testData) {
            if (!this.clusterAssignments.has(d.id)) {
                // simple deterministic assignment for initial data
                const idx = (d.id - 1) % this.clusterPalette.length;
                this.clusterAssignments.set(d.id, [idx]);
            }
        }
    }

    mapTagsToClusters(tags) {
        const clusters = new Set();
        for (const t of tags) {
            const tag = String(t).toLowerCase();
            if (tag === 'v') clusters.add(0); // verbs
            else if (tag === 'adj') clusters.add(1); // adjectives
            else if (tag === 'adv') clusters.add(2); // adverbs
            else if (tag === 'n') clusters.add(3); // nouns
            else if (tag === 'prop') clusters.add(4); // proper nouns
        }
        if (clusters.size > 1) clusters.add(5); // multi-category
        if (clusters.size === 0) clusters.add(6); // other/unknown
        return Array.from(clusters).slice(0, 3); // limit to 3 for gradient
    }

    // Simple k-means clustering for small N (<= 100)
    kMeansCluster(points, k, iters = 20) {
        const n = points.length;
        if (k <= 1 || n === 0) return new Array(n).fill(0);
        // initialize centroids by sampling k points
        const centroids = [];
        const used = new Set();
        while (centroids.length < k && centroids.length < n) {
            const idx = Math.floor(Math.random() * n);
            if (!used.has(idx)) { used.add(idx); centroids.push(points[idx].slice()); }
        }
        let labels = new Array(n).fill(0);
        for (let iter = 0; iter < iters; iter++) {
            // assign
            for (let i = 0; i < n; i++) {
                let best = 0, bestD = Infinity;
                for (let c = 0; c < centroids.length; c++) {
                    const d = this.euclid2(points[i], centroids[c]);
                    if (d < bestD) { bestD = d; best = c; }
                }
                labels[i] = best;
            }
            // update
            const sums = new Array(centroids.length).fill(null).map(() => ({ sum: [], count: 0 }));
            for (let c = 0; c < centroids.length; c++) sums[c].sum = new Array(points[0].length).fill(0);
            for (let i = 0; i < n; i++) {
                const c = labels[i];
                const p = points[i];
                for (let d = 0; d < p.length; d++) sums[c].sum[d] += p[d];
                sums[c].count += 1;
            }
            for (let c = 0; c < centroids.length; c++) {
                if (sums[c].count > 0) {
                    for (let d = 0; d < centroids[c].length; d++) centroids[c][d] = sums[c].sum[d] / sums[c].count;
                }
            }
        }
        return labels;
    }

    euclid2(a, b) {
        let s = 0; for (let i = 0; i < a.length; i++) { const v = a[i] - b[i]; s += v * v; } return s;
    }

    computeLayoutPositions(force2D) {
        const nodes = this.testData.map(d => ({ id: d.id }));
        const idToIndex = new Map(nodes.map((n, i) => [n.id, i]));
        const N = nodes.length;
        const positions = new Array(N);
        const velocities = new Array(N);

        // Initialize random positions in a sphere/circle
        for (let i = 0; i < N; i++) {
            const r = this.layoutAreaRadius * (0.5 + Math.random() * 0.5);
            const theta = Math.random() * Math.PI * 2;
            const phi = Math.acos(2 * Math.random() - 1);
            const x = r * Math.sin(phi) * Math.cos(theta);
            const y = r * Math.sin(phi) * Math.sin(theta);
            const z = force2D ? (Math.random() - 0.5) * this.layoutZJitter : r * Math.cos(phi);
            positions[i] = new THREE.Vector3(x, y, z);
            velocities[i] = new THREE.Vector3();
        }

        // Precompute edge list with target lengths based on strength
        const edges = this.relationships.map(rel => {
            const a = idToIndex.get(rel.from);
            const b = idToIndex.get(rel.to);
            if (a == null || b == null) return null;
            const strength = Math.max(0.01, Math.min(1, rel.strength || 0.5));
            const target = (this.layoutSpringBaseLength * this.nodeSpacingFactor) / Math.pow(strength, 0.5);
            return { a, b, k: this.layoutSpringStrength, target };
        }).filter(Boolean);

        // Simple force-directed iterations
        for (let iter = 0; iter < this.layoutIterations; iter++) {
            // Repulsion (O(N^2) for simplicity; acceptable for <= 100 nodes)
            for (let i = 0; i < N; i++) {
                for (let j = i + 1; j < N; j++) {
                    const pi = positions[i];
                    const pj = positions[j];
                    const delta = pi.clone().sub(pj);
                    const distSq = Math.max(0.01, delta.lengthSq());
                    const forceMag = this.layoutRepulsion / distSq;
                    delta.normalize().multiplyScalar(forceMag);
                    velocities[i].add(delta);
                    velocities[j].sub(delta);
                }
            }

            // Springs along edges
            for (const e of edges) {
                const pi = positions[e.a];
                const pj = positions[e.b];
                const delta = pj.clone().sub(pi);
                const dist = Math.max(0.001, delta.length());
                const diff = dist - e.target;
                const dir = delta.multiplyScalar(1 / dist);
                const f = dir.multiplyScalar(e.k * diff);
                velocities[e.a].add(f);
                velocities[e.b].sub(f);
            }

            // Pull to center slightly and apply velocities
            for (let i = 0; i < N; i++) {
                const p = positions[i];
                const v = velocities[i];
                // Centering
                v.add(p.clone().multiplyScalar(-this.layoutCenterPull));
                // Clamp velocity
                if (v.length() > this.layoutMaxVelocity) {
                    v.setLength(this.layoutMaxVelocity);
                }
                // Update position
                p.add(v.clone().multiplyScalar(this.layoutTimeStep));
                // In 2D, damp Z
                if (force2D) {
                    p.z = Math.max(-this.layoutZJitter, Math.min(this.layoutZJitter, p.z));
                }
                // Damping
                v.multiplyScalar(0.85);
            }
        }

        // Normalize positions to a comfortable radius
        let maxR = 1;
        for (const p of positions) {
            maxR = Math.max(maxR, p.length());
        }
        const scale = (this.layoutAreaRadius * 0.8 * this.nodeSpacingFactor) / maxR;
        const map = new Map();
        for (let i = 0; i < N; i++) {
            const id = nodes[i].id;
            const scaled = positions[i].clone().multiplyScalar(scale);
            // Apply independent vertical and horizontal scaling
            scaled.x *= this.horizontalSpreadFactor;
            scaled.y *= this.verticalSpreadFactor;
            map.set(id, scaled);
        }
        this.nodePositions = map;
    }

    createOrthoCamera() {
        const canvas = document.getElementById('threeCanvas');
        const width = canvas.clientWidth;
        const height = canvas.clientHeight;
        const frustumSize = 20; // world units visible vertically
        const aspect = width / height;
        const halfHeight = frustumSize / 2;
        const halfWidth = halfHeight * aspect;
        this.orthoCamera = new THREE.OrthographicCamera(
            -halfWidth, halfWidth, halfHeight, -halfHeight, -1000, 1000
        );
        this.orthoCamera.position.set(0, 0, 100);
        this.orthoCamera.lookAt(0, 0, 0);
        this.orthoZoom = 1.0;
    }

    getActiveCamera() {
        return this.is2DMode && this.orthoCamera ? this.orthoCamera : this.camera;
    }

    // Zoom 2D orthographic view via changing frustum bounds
    zoom2D(factor) {
        if (!this.is2DMode || !this.orthoCamera) return;
        const minZoom = 0.3;
        const maxZoom = 5.0;
        this.orthoZoom = Math.max(minZoom, Math.min(maxZoom, (this.orthoZoom || 1) * factor));
        this.onWindowResize();
    }

    // Zoom 3D by dollying the camera along its view direction
    zoom3D(factor) {
        if (this.is2DMode) return;
        // unlock camera when user explicitly zooms
        this.lockCameraPosition = true;
        const camDir = new THREE.Vector3();
        this.camera.getWorldDirection(camDir);
        const camPos = this.camera.position.clone();
        const target = new THREE.Vector3(0, 0, 0);
        if (this.isInFocusView && this.targetLookAt) target.copy(this.targetLookAt);
        const toTarget = target.clone().sub(camPos);
        const distance = toTarget.length();
        const newDist = Math.max(1.0, distance / factor);
        const newPos = target.clone().sub(camDir.normalize().multiplyScalar(newDist));
        this.camera.position.copy(newPos);
        this.camera.lookAt(target);
        this.camera.updateProjectionMatrix();
    }

    zoomToFullView() {
        // Compute bounding box of all objects in rootGroup
        const box = new THREE.Box3();
        const temp = new THREE.Box3();
        this.rootGroup.children.forEach(obj => {
            obj.updateWorldMatrix(true, false);
            temp.setFromObject(obj);
            if (!temp.isEmpty()) {
                box.union(temp);
            }
        });

        if (!box.isEmpty()) {
            const size = new THREE.Vector3();
            const center = new THREE.Vector3();
            box.getSize(size);
            box.getCenter(center);

            if (this.is2DMode && this.orthoCamera) {
                // Fit box into orthographic frustum while preserving aspect ratio (no stretching)
                const margin = this.fullViewMargin2D;
                const canvas = document.getElementById('threeCanvas');
                const aspect = Math.max(0.0001, canvas.clientWidth / canvas.clientHeight);
                // Expand the smaller dimension to match aspect
                let width = size.x * margin;
                let height = size.y * margin;
                const boxAspect = Math.max(0.0001, width / height);
                if (boxAspect > aspect) {
                    // Box wider than viewport: expand height
                    height = width / aspect;
                } else {
                    // Box taller than viewport: expand width
                    width = height * aspect;
                }
                const halfW = width / 2;
                const halfH = height / 2;
                this.orthoZoom = 1.0; // reset zoom for full view
                this.orthoCamera.left = -halfW;
                this.orthoCamera.right = halfW;
                this.orthoCamera.top = halfH;
                this.orthoCamera.bottom = -halfH;
                this.orthoCamera.position.set(center.x, center.y, 100);
                this.orthoCamera.lookAt(center.x, center.y, 0);
                this.orthoCamera.updateProjectionMatrix();
            } else {
                // Perspective: place camera back so box fits both vertically and horizontally
                const canvas = document.getElementById('threeCanvas');
                const aspect = Math.max(0.0001, canvas.clientWidth / canvas.clientHeight);
                const vfov = this.camera.fov * (Math.PI / 180);
                const hfov = 2 * Math.atan(Math.tan(vfov / 2) * aspect);
                const margin = this.fullViewMargin3D;
                const halfW = (size.x * margin) / 2;
                const halfH = (size.y * margin) / 2;
                const distV = halfH / Math.tan(vfov / 2);
                const distH = halfW / Math.tan(hfov / 2);
                const dist = Math.max(distV, distH);
                // Position along current view direction so orientation is preserved
                const camDir = new THREE.Vector3();
                this.camera.getWorldDirection(camDir); // points from camera to scene
                const newPos = center.clone().sub(camDir.normalize().multiplyScalar(dist));
                this.camera.position.copy(newPos);
                this.camera.lookAt(center);
                // Adjust clipping planes to contain the box comfortably
                const diag = size.length() * margin;
                this.camera.near = Math.max(0.1, dist - diag);
                this.camera.far = dist + diag;
                this.camera.updateProjectionMatrix();
                // Lock camera so animate() doesn't overwrite full-framed position
                this.lockCameraPosition = true;
            }
        }
        // Exit focus/select state
        this.isInFocusView = false;
        this.isMovingToTarget = false;
        this.targetPosition = null;
        this.targetLookAt = null;
        this.selectedNodeId = null;
    }

    // Rotate entire scene group using camera-relative axes for natural dragging
    rotateRoot(yawAngle, pitchAngle) {
        if (!this.rootGroup) return;

        // Yaw around world up (Y) axis
        if (yawAngle !== 0) {
            const yawAxis = new THREE.Vector3(0, 1, 0);
            const yawQ = new THREE.Quaternion().setFromAxisAngle(yawAxis, yawAngle);
            this.rootGroup.quaternion.premultiply(yawQ);
        }

        // Pitch around camera's right axis
        if (pitchAngle !== 0) {
            const cameraDir = new THREE.Vector3();
            this.camera.getWorldDirection(cameraDir);
            const rightAxis = new THREE.Vector3().crossVectors(cameraDir, this.camera.up).normalize();
            const pitchQ = new THREE.Quaternion().setFromAxisAngle(rightAxis, pitchAngle);
            this.rootGroup.quaternion.premultiply(pitchQ);
        }
    }

    onMouseDown(event) {
        // Start dragging only on left mouse button
        this.isDragging = (event.button === 0);
        this.lastMouseX = event.clientX;
        this.lastMouseY = event.clientY;

        // Update mouse position for raycaster
        const rect = event.target.getBoundingClientRect();
        this.mouse.x = ((event.clientX - rect.left) / rect.width) * 2 - 1;
        this.mouse.y = -((event.clientY - rect.top) / rect.height) * 2 + 1;
    }

    onMouseMove(event) {
        const deltaX = event.clientX - this.lastMouseX;
        const deltaY = event.clientY - this.lastMouseY;

        // Update velocity only while dragging
        if (this.isDragging) {
            if (!this.is2DMode) {
                this.velocityX = deltaX;
                this.velocityY = deltaY;
            }
        }

        // Keep focus view during mouse movement; exit happens on click only

        // Rotate only while dragging (left button held)
        if (this.isDragging) {
            if (!this.is2DMode && !this.isInFocusView) {
                const yawDelta = deltaX * this.rotationSpeed * 0.5;
                const pitchDelta = deltaY * this.rotationSpeed * 0.5;
                this.rotateRoot(yawDelta, pitchDelta);
            } else if (this.orthoCamera) {
                // 2D drag-to-pan: move ortho camera position in world units
                const scaleX = (this.orthoCamera.right - this.orthoCamera.left) / (event.target.clientWidth || 1);
                const scaleY = (this.orthoCamera.top - this.orthoCamera.bottom) / (event.target.clientHeight || 1);
                this.orthoCamera.position.x -= deltaX * scaleX * this.panSpeed2D;
                this.orthoCamera.position.y += deltaY * scaleY * this.panSpeed2D;
            }
        }

        this.lastMouseX = event.clientX;
        this.lastMouseY = event.clientY;
    }

    onMouseUp(event) {
        // Reset velocity when mouse is released
        this.velocityX = 0;
        this.velocityY = 0;
        this.isDragging = false;
    }

    onMouseClick(event) {
        // Only handle left click
        if (event.button !== 0) return;

        const rect = event.target.getBoundingClientRect();
        this.mouse.x = ((event.clientX - rect.left) / rect.width) * 2 - 1;
        this.mouse.y = -((event.clientY - rect.top) / rect.height) * 2 + 1;

        this.raycaster.setFromCamera(this.mouse, this.getActiveCamera());

        // Check intersections with spheres and text sprites
        const allObjects = [...this.circles, ...this.textSprites];
        const intersects = this.raycaster.intersectObjects(allObjects);

        if (intersects.length > 0) {
            const clickedObject = intersects[0].object;
            let targetSphere = null;

            // If clicked on text sprite, find its connected sphere
            if (clickedObject.userData.connectedCircle) {
                targetSphere = clickedObject.userData.connectedCircle;
            } else if (clickedObject.userData.id) {
                // If clicked on sphere directly
                targetSphere = clickedObject;
            }

            if (targetSphere) {
                // Update selected id for highlighting
                this.selectedNodeId = targetSphere.userData.id;
                // In 2D mode, do not move camera; only select/highlight
                if (!this.is2DMode) {
                    this.moveToTarget(targetSphere);
                }
            }
        } else {
            if (this.isInFocusView) {
                this.isInFocusView = false;
                console.log('Exiting focus view due to empty canvas click');
            }
            // Clear selection when clicking empty space
            this.selectedNodeId = null;
        }
    }

    onMouseWheel(event) {
        event.preventDefault();

        // Wheel no longer exits focus view; zoom is disabled
    }

    moveToTarget(targetSphere) {
        // Calculate camera position just in front of the target sphere and look at it
        // Use world position to account for rootGroup rotation
        const sphereWorldPosition = new THREE.Vector3();
        targetSphere.getWorldPosition(sphereWorldPosition);

        const camPosition = this.getActiveCamera().position.clone();
        const viewDir = camPosition.clone().sub(sphereWorldPosition).normalize(); // from sphere -> camera

        // Position camera slightly in front of the sphere along current view direction, and look at the sphere
        const distance = 3.5;
        this.targetPosition = sphereWorldPosition.clone().add(viewDir.multiplyScalar(distance));
        this.targetLookAt = sphereWorldPosition.clone();

        // Stop any rotational inertia while focusing
        this.velocityX = 0;
        this.velocityY = 0;

        // Start camera movement
        this.isMovingToTarget = true;
        this.isInFocusView = true; // Mark that we're in focus view

        console.log('Moving to focus view for sphere:', targetSphere.userData.id);
    }

    animate() {
        requestAnimationFrame(() => this.animate());

        // Morph animation from initial layout to UMAP targets
        if (this.isMorphing) {
            this.morphProgress = Math.min(1, this.morphProgress + this.morphSpeed);
            const t = this.morphProgress;
            this.circles.forEach(sphere => {
                const id = sphere.userData.id;
                const start = this.morphStartPositions.get(id);
                const target = this.morphTargetPositions.get(id);
                if (start && target) {
                    sphere.position.set(
                        start.x + (target.x - start.x) * t,
                        start.y + (target.y - start.y) * t,
                        start.z + (target.z - start.z) * t
                    );
                }
            });
            this.textSprites.forEach(sprite => {
                const id = sprite.userData.id;
                const start = this.morphTextStart.get(id);
                const target = this.morphTextTarget.get(id);
                if (start && target) {
                    sprite.position.set(
                        start.x + (target.x - start.x) * t,
                        start.y + (target.y - start.y) * t,
                        start.z + (target.z - start.z) * t
                    );
                }
            });
            if (this.morphProgress >= 1) {
                this.isMorphing = false;
                this.morphStartPositions.clear();
                this.morphTargetPositions.clear();
                this.morphTextStart.clear();
                this.morphTextTarget.clear();
                if (this.rebuildConnectionsAfterMorph) {
                    // Rebuild connections to use final UMAP positions and updated clusters
                    this.createConnections();
                    this.rebuildConnectionsAfterMorph = false;
                }
            }
        }

        // Auto rotate disabled in 2D mode
        if (!this.is2DMode && !this.isInFocusView && !this.isMovingToTarget) {
            // Auto rotate - slower and smoother (yaw only)
            this.rotateRoot(0.002, 0);
        }

        // Apply inertia for smoother movement
        if (!this.is2DMode && !this.isInFocusView && (Math.abs(this.velocityX) > 0.1 || Math.abs(this.velocityY) > 0.1)) {
            this.rotateRoot(
                this.velocityX * this.rotationSpeed * 0.3,
                this.velocityY * this.rotationSpeed * 0.3
            );

            // Apply friction
            this.velocityX *= this.friction;
            this.velocityY *= this.friction;
        }

        // Rotation applied via quaternions in handlers/inertia above

        // Update text sprites to face active camera, and ensure text always renders on top
        const activeCam = this.getActiveCamera();
        this.textSprites.forEach(sprite => {
            sprite.lookAt(activeCam.position);
            // Make text render above spheres in both 2D and 3D
            sprite.renderOrder = 2;
            const mat = sprite.material;
            mat.depthTest = false;
            mat.transparent = true;
            mat.needsUpdate = true;
        });

        // Apply cluster filter visibility when dirty
        if (this.clustersDirty) {
            this.updateClusterFilterAppearance();
            this.clustersDirty = false;
        }

        // Handle camera movement to target
        if (this.isMovingToTarget) {
            // Smoothly move camera to target position
            this.camera.position.lerp(this.targetPosition, this.movementSpeed);

            // Check if we're close enough to target
            const distanceToTarget = this.camera.position.distanceTo(this.targetPosition);
            if (distanceToTarget < 0.1) {
                this.isMovingToTarget = false;
                this.targetPosition = null;
            }

            // Look at target during movement
            if (this.targetLookAt) {
                this.getActiveCamera().lookAt(this.targetLookAt);
            }
        } else if (this.isInFocusView) {
            // In focus view - maintain position and keep looking at target if available
            if (this.targetLookAt) {
                this.getActiveCamera().lookAt(this.targetLookAt);
            } else {
                this.getActiveCamera().lookAt(0, 0, 0);
            }
        } else {
            // Normal camera controls - fixed camera (no pan/zoom)
            if (this.is2DMode) {
                // 2D: preserve current ortho camera position (allow pan) and keep looking at its XY
                if (!this.orthoCamera) this.createOrthoCamera();
                const camX = this.orthoCamera.position.x;
                const camY = this.orthoCamera.position.y;
                this.orthoCamera.lookAt(camX, camY, 0);
                this.circles.forEach(sphere => {
                    sphere.renderOrder = 1; // behind text
                    const mat = sphere.material;
                    mat.depthTest = true; // still depth-tested among spheres
                    mat.needsUpdate = true;
                });
            } else {
                // 3D: if not locked, maintain a default framing; when locked (after Full), preserve position
                if (!this.lockCameraPosition) {
                    const distance = 25;
                    this.camera.position.set(0, 0, distance);
                    this.camera.lookAt(0, 0, 0);
                }
                this.circles.forEach(sphere => {
                    sphere.renderOrder = 1; // behind text
                });
            }
        }

        this.renderer.render(this.scene, this.getActiveCamera());
    }

    onWindowResize() {
        const canvas = document.getElementById('threeCanvas');
        const width = canvas.clientWidth;
        const height = canvas.clientHeight;

        this.camera.aspect = width / height;
        this.camera.updateProjectionMatrix();

        if (this.orthoCamera) {
            const frustumSize = 20;
            const aspect = width / height;
            const halfHeight = frustumSize / 2;
            const halfWidth = halfHeight * aspect;
            this.orthoCamera.left = -halfWidth * (1 / (this.orthoZoom || 1));
            this.orthoCamera.right = halfWidth * (1 / (this.orthoZoom || 1));
            this.orthoCamera.top = halfHeight * (1 / (this.orthoZoom || 1));
            this.orthoCamera.bottom = -halfHeight * (1 / (this.orthoZoom || 1));
            this.orthoCamera.updateProjectionMatrix();
        }

        this.renderer.setSize(width, height);
    }
}

// Initialize the visualization when the page loads
document.addEventListener('DOMContentLoaded', () => {
    console.log('Starting 3D visualization...');

    // Check if THREE.js is available
    if (typeof THREE === 'undefined') {
        console.error('THREE.js is not loaded!');
        document.body.innerHTML = '<div style="color: white; text-align: center; padding: 50px; font-size: 18px;">THREE.js 라이브러리가 로드되지 않았습니다.<br>인터넷 연결을 확인하고 페이지를 새로고침해주세요.</div>';
        return;
    }

    console.log('THREE.js is available:', THREE);

    try {
        new DataVisualization3D();
        console.log('3D visualization initialized successfully');
    } catch (error) {
        console.error('Error initializing 3D visualization:', error);
        document.body.innerHTML = '<div style="color: white; text-align: center; padding: 50px; font-size: 18px;">3D 시각화 초기화 오류:<br>' + error.message + '</div>';
    }
});
