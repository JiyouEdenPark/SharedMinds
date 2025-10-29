class ThreeJSThinkingSpace {
  constructor() {
    this.canvas = document.getElementById("threeCanvas");
    this.scene = null;
    this.camera = null;
    this.renderer = null;
    
    // 카메라 컨트롤 변수들
    this.isMouseDown = false;
    this.mouseX = 0;
    this.mouseY = 0;
    this.cameraAngleX = Math.PI/2; // 좌우 회전 (Y축 기준)
    this.cameraDistance = 6; // 중심으로부터의 거리
    this.cameraSpeed = 0.01; // 회전 속도
    
    this.animationId = null;
    
    // 물결 효과 관련 변수들
    this.ripples = [];
    // TextGeometry를 위한 폰트 로더
    this.fontLoader = new THREE.FontLoader();
    this.font = null;
    
    // 메시 풀링 시스템
    this.meshPool = {
      mainTexts: [], // 메인 텍스트 메시들
      rippleChars: [], // 물결 문자 메시들
      availableMainTexts: [], // 사용 가능한 메인 텍스트 메시들
      availableRippleChars: [] // 사용 가능한 물결 문자 메시들
    };
    
    // 렌더링 최적화
    this.lastRenderTime = 0;
    this.renderInterval = 100; // 100ms마다 렌더링 (10fps)
    
    // 웹캠 관련 변수들
    this.videoElement = null;
    this.videoTexture = null;
    this.videoPlane = null;
    this.isWebcamActive = false;
    
    // 물 굴곡 효과를 위한 변수들
    this.waterTime = 0;
    this.renderTarget = null;
    this.waterPlane = null;
    
    this.init();
  }

  init() {
    this.setupScene();
    this.setupCamera();
    this.setupRenderer();
    this.setupLighting();
    this.setupControls();
    this.loadFont();
    this.createBasicObjects();
    this.setupWebcam();
    this.startAnimation();
  }

  setupScene() {
    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color(0xFFFFFF); // 흰색 배경
  }

  setupCamera() {
    const aspect = window.innerWidth / window.innerHeight;
    this.camera = new THREE.PerspectiveCamera(75, aspect, 0.01, 1000); // near를 0.01로 줄임
    this.updateCameraPosition();
  }

  setupRenderer() {
    this.renderer = new THREE.WebGLRenderer({ 
      canvas: this.canvas,
      antialias: true 
    });
    this.renderer.setSize(window.innerWidth, window.innerHeight);
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  }

  setupLighting() {
    // 환경광
    const ambientLight = new THREE.AmbientLight(0x404040, 0.6);
    this.scene.add(ambientLight);

    // 방향광 (태양광)
    const directionalLight = new THREE.DirectionalLight(0xffffff, 0.8);
    directionalLight.position.set(10, 10, 5);
    directionalLight.castShadow = true;
    directionalLight.shadow.mapSize.width = 2048;
    directionalLight.shadow.mapSize.height = 2048;
    directionalLight.shadow.camera.near = 0.5;
    directionalLight.shadow.camera.far = 50;
    directionalLight.shadow.camera.left = -20;
    directionalLight.shadow.camera.right = 20;
    directionalLight.shadow.camera.top = 20;
    directionalLight.shadow.camera.bottom = -20;
    this.scene.add(directionalLight);
  }

  loadFont() {
    // 한글 지원 폰트 로드 시도
    this.fontLoader.load('https://threejs.org/examples/fonts/helvetiker_regular.typeface.json', (font) => {
      this.font = font;
      console.log('폰트가 로드되었습니다.');
    }, undefined, (error) => {
      console.log('폰트 로드 실패:', error);
      // 폰트 로드 실패 시 기본 폰트 사용
      this.fontLoader.load('https://threejs.org/examples/fonts/helvetiker_regular.typeface.json', (font) => {
        this.font = font;
        console.log('기본 폰트가 로드되었습니다.');
      });
    });
  }

  setupControls() {
    // 마우스 이벤트 리스너
    this.canvas.addEventListener('mousedown', (e) => this.onMouseDown(e));
    this.canvas.addEventListener('mousemove', (e) => this.onMouseMove(e));
    this.canvas.addEventListener('mouseup', (e) => this.onMouseUp(e));
    this.canvas.addEventListener('wheel', (e) => this.onMouseWheel(e));
    
    // 터치 이벤트 리스너 (모바일 지원)
    this.canvas.addEventListener('touchstart', (e) => this.onTouchStart(e));
    this.canvas.addEventListener('touchmove', (e) => this.onTouchMove(e));
    this.canvas.addEventListener('touchend', (e) => this.onTouchEnd(e));
    
    // 윈도우 리사이즈 이벤트
    window.addEventListener('resize', () => this.onWindowResize());
  }

  onMouseDown(event) {
    this.isMouseDown = true;
    this.mouseX = event.clientX;
    this.mouseY = event.clientY;
    this.canvas.style.cursor = 'grabbing';
  }

  onMouseMove(event) {
    if (!this.isMouseDown) return;
    
    const deltaX = event.clientX - this.mouseX;
    this.mouseX = event.clientX;
    
    // 좌우 회전만 적용 (Y축 기준 회전)
    this.cameraAngleX -= deltaX * this.cameraSpeed;
    this.updateCameraPosition();
  }

  onMouseUp(event) {
    this.isMouseDown = false;
    this.canvas.style.cursor = 'grab';
  }

  onMouseWheel(event) {
    // 줌 인/아웃
    const zoomSpeed = 0.1;
    this.cameraDistance += event.deltaY * zoomSpeed * 0.01;
    this.cameraDistance = Math.max(1, Math.min(20, this.cameraDistance)); // 최소/최대 거리 제한 (더 가까이서 볼 수 있도록)
    this.updateCameraPosition();
  }

  onTouchStart(event) {
    event.preventDefault();
    if (event.touches.length === 1) {
      this.isMouseDown = true;
      this.mouseX = event.touches[0].clientX;
      this.mouseY = event.touches[0].clientY;
    }
  }

  onTouchMove(event) {
    event.preventDefault();
    if (event.touches.length === 1 && this.isMouseDown) {
      const deltaX = event.touches[0].clientX - this.mouseX;
      this.mouseX = event.touches[0].clientX;
      
      this.cameraAngleX -= deltaX * this.cameraSpeed;
      this.updateCameraPosition();
    }
  }

  onTouchEnd(event) {
    event.preventDefault();
    this.isMouseDown = false;
  }

  updateCameraPosition() {
    // 중심점을 기준으로 원형 궤도로 카메라 배치
    const centerX = 0;
    const centerY = 0;
    const centerZ = 0;
    
    // Y축은 고정하고 X축만 회전
    const x = centerX + this.cameraDistance * Math.cos(this.cameraAngleX);
    const y = centerY;
    const z = centerZ + this.cameraDistance * Math.sin(this.cameraAngleX);
    
    this.camera.position.set(x, y, z);
    this.camera.lookAt(centerX, centerY, centerZ);
  }

  onWindowResize() {
    const width = window.innerWidth;
    const height = window.innerHeight;
    
    this.camera.aspect = width / height;
    this.camera.updateProjectionMatrix();
    this.renderer.setSize(width, height);
    
    // 렌더 타겟과 해상도 업데이트
    if (this.renderTarget) {
      this.renderTarget.setSize(width, height);
    }
    if (this.waterPlane) {
      this.waterPlane.material.uniforms.resolution.value.set(width, height);
    }
  }

  setupWebcam() {
    // 웹캠 비디오 엘리먼트 생성
    this.videoElement = document.createElement('video');
    this.videoElement.width = 640;
    this.videoElement.height = 480;
    this.videoElement.autoplay = true;
    this.videoElement.muted = true;
    this.videoElement.playsInline = true;
    
    // 웹캠 스트림 요청
    navigator.mediaDevices.getUserMedia({ 
      video: { 
        width: 640, 
        height: 480,
        facingMode: 'user' // 전면 카메라 사용
      } 
    })
    .then(stream => {
      this.videoElement.srcObject = stream;
      this.isWebcamActive = true;
      
      // 비디오가 로드된 후 텍스처 적용
      this.videoElement.addEventListener('loadeddata', () => {
        // 비디오 텍스처 생성
        this.videoTexture = new THREE.VideoTexture(this.videoElement);
        this.videoTexture.minFilter = THREE.LinearFilter;
        this.videoTexture.magFilter = THREE.LinearFilter;
        
        // 웹캠 plane 생성
        this.createWebcamPlane();
      });
      
      // 비디오 재생 시작
      this.videoElement.play();
    })
      .catch(error => {
        console.error('웹캠 접근 실패:', error);
      });
  }

  createWebcamPlane() {
    // 웹캠 plane 새로 생성
    if (this.videoTexture) {
      const planeGeometry = new THREE.PlaneGeometry(4, 3);
      const webcamMaterial = new THREE.MeshBasicMaterial({ 
        map: this.videoTexture,
        side: THREE.BackSide, // 앞면만 보이게
        transparent: false,
        opacity: 1
      });
      
      this.videoPlane = new THREE.Mesh(planeGeometry, webcamMaterial);
      this.videoPlane.position.set(0, 0, 2);
      this.videoPlane.castShadow = true;
      this.videoPlane.receiveShadow = true;
      this.scene.add(this.videoPlane);
    } else {
      console.log('videoTexture가 없습니다.');
    }
  }


  createBasicObjects() {
    this.createWaterEffect();
    this.createRipple("Hello", 0, 0);
    // setTimeout(() => this.createRipple("3D Text", -1, 1), 2000);
    // setTimeout(() => this.createRipple("Three.js", 1, -1), 4000);
  }

  createWaterEffect() {
    // 렌더 타겟 생성
    this.renderTarget = new THREE.WebGLRenderTarget(window.innerWidth, window.innerHeight, {
      minFilter: THREE.LinearFilter,
      magFilter: THREE.LinearFilter
    });

    // 물 표면 geometry (크기 축소)
    const waterGeometry = new THREE.PlaneGeometry(8, 8, 1, 1);
    
    // 물 굴곡 셰이더 머티리얼
    const waterMaterial = new THREE.ShaderMaterial({
      transparent: true,
      uniforms: {
        tScene: { value: this.renderTarget.texture },
        time: { value: 0 },
        strength: { value: 0.0 }, // 초기값 0으로 설정
        blurRadius: { value: 0.0 }, // 초기값 0으로 설정
        tint: { value: new THREE.Color(0x1a6fa0) },
        tintAmount: { value: 0.0 }, // 초기값 0으로 설정
        resolution: { value: new THREE.Vector2(window.innerWidth, window.innerHeight) },
        waterDepth: { value: 0.0 } // 물에 잠긴 정도를 나타내는 변수 추가
      },
      vertexShader: `
        varying vec2 vUv;
        varying vec4 vClipPos;
        void main() {
          vUv = uv;
          vClipPos = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
          gl_Position = vClipPos;
        }
      `,
      fragmentShader: `
        precision highp float;
        varying vec2 vUv;
        varying vec4 vClipPos;

        uniform sampler2D tScene;
        uniform float time;
        uniform float strength;
        uniform float blurRadius;
        uniform vec3  tint;
        uniform float tintAmount;
        uniform vec2  resolution;
        uniform float waterDepth;

        vec2 screenUV(vec4 clip){
          vec3 ndc = clip.xyz / clip.w;
          return ndc.xy * 0.5 + 0.5;
        }

        float hash(vec2 p){ 
          return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453123); 
        }
        
        float noise(vec2 p){
          vec2 i = floor(p), f = fract(p);
          float a = hash(i);
          float b = hash(i + vec2(1.,0.));
          float c = hash(i + vec2(0.,1.));
          float d = hash(i + vec2(1.,1.));
          vec2 u = f*f*(3.0-2.0*f);
          return mix(mix(a,b,u.x), mix(c,d,u.x), u.y);
        }
        
        float fbm(vec2 p){
          float v = 0.0;
          float a = 0.5;
          for(int i=0;i<4;i++){
            v += a * noise(p);
            p *= 2.07;
            a *= 0.5;
          }
          return v;
        }

        vec2 refractOffset(vec2 suv){
          vec2 nUV = suv * 2.0 + vec2(time*0.03, -time*0.02); // 더 부드러운 파도
          float n1 = fbm(nUV);
          float n2 = fbm(nUV + 13.7);
          vec2 d = normalize(vec2(n1 - 0.5, n2 - 0.5));
          return d * strength * 0.5; // 굴곡 강도를 절반으로 감소
        }

        vec4 sampleBlur(sampler2D tex, vec2 uv, float radius){
          vec2 px = radius / resolution;
          vec4 c  = texture2D(tex, uv);
          c += texture2D(tex, uv + vec2( px.x, 0.0));
          c += texture2D(tex, uv + vec2(-px.x, 0.0));
          c += texture2D(tex, uv + vec2(0.0,  px.y));
          c += texture2D(tex, uv + vec2(0.0, -px.y));
          return c / 5.0;
        }

        void main(){
          vec2 suv = screenUV(vClipPos);
          
          // 물에 잠긴 정도에 따라 굴곡 효과 적용
          if (waterDepth > 0.0) {
            vec2 offset = refractOffset(suv) * waterDepth;
            vec2 uv = clamp(suv + offset, vec2(0.001), vec2(0.999));
            vec4 col = sampleBlur(tScene, uv, blurRadius * waterDepth);
            vec3 mixed = mix(col.rgb, tint, tintAmount * waterDepth);
            mixed = mixed * (0.98 + waterDepth * 0.02); // 더 살짝만 어둡게
            gl_FragColor = vec4(mixed, 0.95 * waterDepth); // 투명도도 더 살짝만
          } else {
            // 물 밖에 있을 때는 원본 그대로
            gl_FragColor = texture2D(tScene, suv);
          }
        }
      `
    });

    // 물 표면 mesh 생성
    this.waterPlane = new THREE.Mesh(waterGeometry, waterMaterial);
    this.waterPlane.position.set(0, 0, -2.5); // 글자가 가라앉는 위치
    this.scene.add(this.waterPlane);
  }

  // 메시 풀링 헬퍼 함수들
  getMainTextMesh() {
    if (this.meshPool.availableMainTexts.length > 0) {
      return this.meshPool.availableMainTexts.pop();
    }
    return null;
  }

  returnMainTextMesh(mesh) {
    if (mesh) {
      mesh.visible = false;
      this.meshPool.availableMainTexts.push(mesh);
    }
  }

  getRippleCharMesh() {
    if (this.meshPool.availableRippleChars.length > 0) {
      return this.meshPool.availableRippleChars.pop();
    }
    return null;
  }

  returnRippleCharMesh(mesh) {
    if (mesh) {
      mesh.visible = false;
      this.meshPool.availableRippleChars.push(mesh);
    }
  }

  createMainTextMesh(text, font) {
    const textGeometry = new THREE.TextGeometry(text, {
      font: font,
      size: 0.3,
      height: 0.1,
      curveSegments: 12,
      bevelEnabled: true,
      bevelThickness: 0.02,
      bevelSize: 0.01,
      bevelOffset: 0,
      bevelSegments: 5
    });
    
    textGeometry.computeBoundingBox();
    textGeometry.translate(
      -textGeometry.boundingBox.max.x * 0.5,
      -textGeometry.boundingBox.max.y * 0.5,
      -textGeometry.boundingBox.max.z * 0.5
    );
    
    const material = new THREE.MeshLambertMaterial({ 
      color: new THREE.Color(0x0066CC),
      transparent: true,
      opacity: 1
    });
    
    const mesh = new THREE.Mesh(textGeometry, material);
    mesh.userData.isRippleText = true;
    mesh.userData.isMainText = true;
    
    return mesh;
  }

  createRippleCharMesh(text, font) {
    const charGeometry = new THREE.TextGeometry(text, {
      font: font,
      size: 0.08,
      height: 0.05,
      curveSegments: 8,
      bevelEnabled: true,
      bevelThickness: 0.01,
      bevelSize: 0.005,
      bevelOffset: 0,
      bevelSegments: 3
    });
    
    charGeometry.computeBoundingBox();
    charGeometry.translate(
      -charGeometry.boundingBox.max.x * 0.5,
      -charGeometry.boundingBox.max.y * 0.5,
      -charGeometry.boundingBox.max.z * 0.5
    );
    
    const charMaterial = new THREE.MeshLambertMaterial({ 
      color: new THREE.Color(0x0066CC),
      transparent: true,
      opacity: 1
    });
    
    const mesh = new THREE.Mesh(charGeometry, charMaterial);
    mesh.userData.isRippleText = true;
    mesh.userData.isRippleChar = true;
    
    return mesh;
  }

  createRipple(text, x, y) {
    const ripple = {
      text: text,
      x: x,
      y: y,
      z: -2, // ripple plane의 z 위치
      ripples: [], // 문자별 물결 배열
      ringCount: 0,
      lastRippleTime: Date.now(),
      fadeStartTime: Date.now() + 8000, // 8초 후 페이드 시작 (더 빠르게)
      sinkStartTime: Date.now() + 10000, // 10초 후 가라앉기 시작
      isSinking: false,
      sinkProgress: 0,
      opacity: 1,
      water: {
        isUnder: false,
        animStart: 0,
        animFrom: 0,
        animTo: 0,
        progress: 0
      },
      // 메시 참조 추가
      mainTextMesh: null,
      rippleCharMeshes: []
    };

    this.ripples.push(ripple);
    
    this.createRippleRing(ripple);
  }

  createRippleRing(ripple) {
    const now = Date.now();
    if (now - ripple.lastRippleTime < 1500) return; // 1.5초마다 생성 (간격 좁힘)

    ripple.lastRippleTime = now;
    const ringIndex = ripple.ringCount;
    
    // 텍스트를 문자 배열로 변환
    const pattern = (ripple.text + " ").split("");
    const rippleRadius = 0.7 + ringIndex * 0.3;
    const fontSize = 0.1;

    // 원둘레와 글자 폭을 기준으로 필요한 슬롯 수 계산
    const circumference = 2 * Math.PI * rippleRadius;
    const slots = Math.max(6, Math.floor(circumference / fontSize * 0.7));

    for (let i = 0; i < slots; i++) {
      const ch = pattern[i % pattern.length];
      const angle = -(i / slots) * Math.PI * 2;
      const charX = ripple.x + Math.cos(angle) * rippleRadius;
      const charY = ripple.y + Math.sin(angle) * rippleRadius;
      
      ripple.ripples.push({
        text: ch,
        x: charX,
        y: charY,
        z: ripple.z,
        size: fontSize,
        opacity: 0,
        created: now,
        angle: angle,
        radius: rippleRadius,
        ringIndex: ringIndex,
        slotIndex: i,
      });
    }
    ripple.ringCount += 1;
  }

  updateRipples() {
    const now = Date.now();
    
    this.ripples.forEach((ripple, index) => {
      // 페이드 시작 전까지만 새로운 ripple 생성
      if (now < ripple.fadeStartTime) {
        this.createRippleRing(ripple);
      }

      // 페이드 인 처리: 생성 직후 0.5초 동안
      const elementFadeInMs = 500;
      ripple.ripples.forEach((ch) => {
        const born = ch.created;
        if (now < born + elementFadeInMs) {
          const t = Math.min(1, Math.max(0, (now - born) / elementFadeInMs));
          ch.opacity = Math.max(ch.opacity, t);
        }
      });

      // 페이드 아웃 처리: 물결만 페이드되고 메인 텍스트는 생성 위치에 유지
      if (now > ripple.fadeStartTime) {
        // 링/문자 단위 계단식 페이드
        const rings = ripple.ringCount;
        const ringDelayMs = 500; // 링 간 지연
        const elementFadeMs = 500; // 각 요소 페이드 시간
        const charDelayMs = 50; // 문자 간 지연
        
        for (let r = 0; r < rings; r++) {
          // 각 링의 시작 시간은 페이드 시작 시간 + ringDelay * r
          const ringStart = ripple.fadeStartTime + r * ringDelayMs;
          // 해당 링의 문자들만 추려서 슬롯 인덱스 기준으로 내부 지연 적용
          const ringChars = ripple.ripples.filter((ch) => ch.ringIndex === r);
          ringChars.forEach((ch, idx) => {
            const charStart = ringStart + ch.slotIndex * charDelayMs;
            const charEnd = charStart + elementFadeMs;
            if (now >= charStart) {
              const t = Math.min(1, Math.max(0, (now - charStart) / (charEnd - charStart)));
              ch.opacity = 1 - t;
            }
          });
        }

        // 완전히 사라진 rippleChar들 제거 (메모리 최적화)
        ripple.ripples = ripple.ripples.filter(char => char.opacity > 0);

        // 모든 물결 텍스트가 완전히 사라진 뒤에만 최초 가라앉기 시작
        if (!ripple.water.initialSinkStarted) {
          const allRipplesGone = ripple.ripples.length === 0; // 배열이 비어있으면 모든 물결이 사라진 것
          const waterAppearDelayMs = 500;
          if (allRipplesGone && now > ripple.fadeStartTime + waterAppearDelayMs) {
            ripple.water.initialSinkStarted = true;
            this.startSink(ripple, now);
          }
        }
      }
      
      // 물 상태 업데이트 (애니메이션 진행, 자동 가라앉기)
      this.updateWater(ripple, now);
    });

    // 완전히 사라진 물결 제거
    this.ripples = this.ripples.filter(ripple => {
      const keepForRipples = ripple.ripples.some((r) => r.opacity > 0);
      const keepForVisibleText = ripple.opacity > 0;
      return keepForRipples || keepForVisibleText;
    });
  }

  startSink(ripple, now) {
    const w = ripple.water;
    if (!w) return;
    w.animStart = now;
    w.animFrom = w.progress || 0;
    w.animTo = 1;
  }

  updateWater(ripple, now) {
    const w = ripple.water;
    if (!w) return;
    if (w.animStart) {
      // Sink uses slower easing (ease-in-out cubic); rise uses faster duration
      const waterSinkMs = 1800; // 느린 가라앉기
      const waterRiseMs = 500; // 빠른 떠오르기
      const duration = w.animTo > w.animFrom ? waterSinkMs : waterRiseMs;
      const t = Math.min(1, (now - w.animStart) / duration);
      // cubic ease-in-out: 3t^2 - 2t^3
      const eased = (3 * t * t) - (2 * t * t * t);
      w.progress = w.animFrom + (w.animTo - w.animFrom) * eased;
      if (t >= 1) {
        w.animStart = 0;
        w.isUnder = w.animTo >= 1;
      }
    }
  }

  renderRipples() {
    // 기존 메시들을 풀로 반환
    this.ripples.forEach(ripple => {
      if (ripple.mainTextMesh) {
        this.returnMainTextMesh(ripple.mainTextMesh);
        ripple.mainTextMesh = null;
      }
      
      ripple.rippleCharMeshes.forEach(mesh => {
        this.returnRippleCharMesh(mesh);
      });
      ripple.rippleCharMeshes = [];
    });

    // 폰트가 로드되지 않았으면 렌더링하지 않음
    if (!this.font) return;

    // TextGeometry를 사용한 3D 텍스트 렌더링
    this.ripples.forEach(ripple => {
      // 메인 텍스트 렌더링
      if (ripple.opacity > 0) {
        const wp = ripple.water.progress || 0;
        
        // 메시 풀에서 가져오거나 새로 생성
        let textMesh = this.getMainTextMesh();
        if (!textMesh) {
          textMesh = this.createMainTextMesh(ripple.text, this.font);
          this.meshPool.mainTexts.push(textMesh);
          this.scene.add(textMesh);
        } else {
          // 기존 메시 재사용 - 텍스트가 다르면 새로 생성
          if (textMesh.userData.text !== ripple.text) {
            this.returnMainTextMesh(textMesh);
            textMesh = this.createMainTextMesh(ripple.text, this.font);
            this.meshPool.mainTexts.push(textMesh);
            this.scene.add(textMesh);
          }
        }
        
        // 메시 속성 업데이트
        textMesh.userData.text = ripple.text;
        textMesh.material.opacity = ripple.opacity;
        textMesh.visible = true;
        
        // Z축으로 가라앉는 효과
        const sinkZ = ripple.z - wp * 3;
        textMesh.position.set(ripple.x, ripple.y, sinkZ);
        
        ripple.mainTextMesh = textMesh;
      }

      // 물결 문자들 렌더링
      ripple.ripples.forEach((rippleChar) => {
        if (rippleChar.opacity > 0) {
          // 메시 풀에서 가져오거나 새로 생성
          let charMesh = this.getRippleCharMesh();
          if (!charMesh) {
            charMesh = this.createRippleCharMesh(rippleChar.text, this.font);
            this.meshPool.rippleChars.push(charMesh);
            this.scene.add(charMesh);
          } else {
            // 기존 메시 재사용 - 텍스트가 다르면 새로 생성
            if (charMesh.userData.text !== rippleChar.text) {
              this.returnRippleCharMesh(charMesh);
              charMesh = this.createRippleCharMesh(rippleChar.text, this.font);
              this.meshPool.rippleChars.push(charMesh);
              this.scene.add(charMesh);
            }
          }
          
          // 메시 속성 업데이트
          charMesh.userData.text = rippleChar.text;
          charMesh.material.opacity = rippleChar.opacity;
          charMesh.visible = true;
          charMesh.position.set(rippleChar.x, rippleChar.y, rippleChar.z);
          
          ripple.rippleCharMeshes.push(charMesh);
        }
      });
    });
  }

  animate() {
    this.animationId = requestAnimationFrame(() => this.animate());
    
    const now = Date.now();
    
    // 물결 애니메이션 업데이트 (항상 실행)
    this.updateRipples();
    
    // 물 굴곡 효과 시간 업데이트
    this.waterTime += 0.01;
    if (this.waterPlane) {
      this.waterPlane.material.uniforms.time.value = this.waterTime;
      
      // 물에 잠긴 정도 계산 (가장 깊이 잠긴 텍스트 기준)
      let maxWaterDepth = 0;
      this.ripples.forEach(ripple => {
        const wp = ripple.water.progress || 0;
        if (wp > maxWaterDepth) {
          maxWaterDepth = wp;
        }
      });
      
      // 물 굴곡 효과 파라미터 업데이트 (더 살짝만)
      this.waterPlane.material.uniforms.waterDepth.value = maxWaterDepth;
      this.waterPlane.material.uniforms.strength.value = maxWaterDepth * 0.03; // 0.08 → 0.03으로 감소
      this.waterPlane.material.uniforms.blurRadius.value = maxWaterDepth * 1.5; // 1.0 → 0.5로 감소
      this.waterPlane.material.uniforms.tintAmount.value = maxWaterDepth * 0.1; // 0.2 → 0.1로 감소
      
      // 카메라 각도에 따라 물 표면 투명도 조절
      this.waterPlane.material.transparent = true;
      
      // 카메라가 물 표면을 정면에서 볼 때는 투명하게, 옆에서 볼 때는 보이게
      // 카메라의 Z축 방향을 기준으로 판단
      const cameraDirection = this.camera.getWorldDirection(new THREE.Vector3());
      const sideAngle = Math.abs(cameraDirection.x);
      const sideOpacity = Math.min(sideAngle * 2, 1.0); // 0~1 범위로 정규화
      
      if (maxWaterDepth > 0) {
        // 물에 잠겼을 때: 정면에서는 굴곡 효과만, 옆에서는 메쉬도 보이게
        this.waterPlane.material.opacity = sideOpacity * 0.4; // 최대 0.4 투명도
      } else {
        // 물에 잠기지 않았을 때: 완전히 투명
        this.waterPlane.material.opacity = 0;
      }
    }
    
    // 렌더링은 간격을 두고 실행 (성능 최적화)
    if (now - this.lastRenderTime > this.renderInterval) {
      this.renderRipples();
      this.lastRenderTime = now;
    }
    
    // 웹캠 텍스처 업데이트
    if (this.isWebcamActive && this.videoTexture) {
      this.videoTexture.needsUpdate = true;
    }
    
    // 물 굴곡 효과를 위한 렌더링
    if (this.waterPlane && this.renderTarget) {
      // 물 표면을 일시적으로 숨기고 씬을 렌더 타겟에 렌더링
      this.waterPlane.visible = false;
      this.renderer.setRenderTarget(this.renderTarget);
      this.renderer.render(this.scene, this.camera);
      
      // 물 표면을 다시 보이게 하고 일반 렌더링
      this.waterPlane.visible = true;
      this.renderer.setRenderTarget(null);
    }
    
    // 씬 렌더링 (항상 실행)
    this.renderer.render(this.scene, this.camera);
  }

  startAnimation() {
    this.animate();
  }

}

// 페이지 로드 시 초기화
document.addEventListener("DOMContentLoaded", () => {
  new ThreeJSThinkingSpace();
});