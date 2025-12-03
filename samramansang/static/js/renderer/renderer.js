import { KeypointRenderer } from './keypoint-renderer.js';

export default class Renderer {
    constructor(overlayElement) {
        this.overlay = overlayElement;
        this.ctx = overlayElement.getContext('2d');
        this.isInitialized = false;

        // 기본 키포인트 렌더러
        this.keypointRenderer = new KeypointRenderer(overlayElement);

        // 렌더링 옵션
        this.renderOptions = {
            showKeypoints: true,      // 키포인트 점 표시
            showSkeleton: true,       // 스켈레톤 선 표시
            smoothing: false,          // 스무딩 적용
            interpolation: false       // 보간 적용
        };

        // 캘리브레이션 마스크
        this.calibrationMaskImage = null;
        this.calibrationMaskAlpha = 0.35;
        this.calibrationContours = null; // Array of [[x,y], ...]

        // id별 KeypointRenderer (스무딩 상태 포함)
        this.kprById = {}; // id -> KeypointRenderer
    }

    // 캔버스 초기화
    initialize(width, height) {
        this.overlay.width = width;
        this.overlay.height = height;
        this.overlay.style.position = "absolute";
        this.overlay.style.top = "0";
        this.overlay.style.left = "0";
        this.overlay.style.pointerEvents = "none";
        this.isInitialized = true;

        // 키포인트 렌더러 초기화
        this.keypointRenderer.initialize(width, height);
    }

    // 메인 렌더링 함수
    render(data) {
        if (!this.isInitialized || !this.overlay.width || !this.overlay.height) {
            console.warn('렌더러가 초기화되지 않았습니다.');
            return;
        }

        // 캔버스 클리어
        this.ctx.clearRect(0, 0, this.overlay.width, this.overlay.height);

        // 다중 포즈 지원: data.multi = [{id, kpts}, {id, kpts}, ...]
        if (Array.isArray(data.multi)) {
            for (let i = 0; i < data.multi.length; i++) {
                const entry = data.multi[i] || {};
                if (!entry.kpts) continue;
                const trackId = typeof entry.id === 'string' ? entry.id : `track_${i}`;
                let keypoints = entry.kpts;
                // 각 포즈를 순차적으로 그린다
                this.draw(keypoints, null);
            }
            return;
        }

        if (data.kpts) {
            let keypoints = data.kpts;
            this.draw(keypoints);
        }
    }

    _getKeypointRendererForId(id) {
        if (!id) id = 'default';
        if (!this.kprById[id]) {
            this.kprById[id] = new KeypointRenderer(this.overlay);
        }
        return this.kprById[id];
    }

    draw(keypoints) {
        // 캘리브레이션 마스크/윤곽선 그리기 (배경)
        if (this.calibrationMaskImage) {
            this.ctx.save();
            this.ctx.globalAlpha = this.calibrationMaskAlpha;
            this.ctx.drawImage(this.calibrationMaskImage, 0, 0, this.overlay.width, this.overlay.height);
            this.ctx.restore();
        }
        if (this.calibrationContours && Array.isArray(this.calibrationContours) && this.calibrationContours.length > 0) {
            this.ctx.save();
            this.ctx.fillStyle = 'rgba(0,0,0,1.0)';
            for (const contour of this.calibrationContours) {
                if (!Array.isArray(contour) || contour.length < 3) continue;
                this.ctx.beginPath();
                for (let i = 0; i < contour.length; i++) {
                    const [x, y] = contour[i];
                    if (i === 0) this.ctx.moveTo(x, y); else this.ctx.lineTo(x, y);
                }
                this.ctx.closePath();
                this.ctx.fill();
            }
            this.ctx.restore();
        }

        // 스켈레톤 그리기
        if (this.renderOptions.showSkeleton) {
            this.keypointRenderer.drawSkeleton(keypoints);
        }

        // 키포인트 그리기
        if (this.renderOptions.showKeypoints) {
            this.keypointRenderer.drawKeypoints(keypoints);
        }
    }

    // 렌더링 옵션 설정
    setRenderOptions(options) {
        this.renderOptions = { ...this.renderOptions, ...options };
    }

    // 캘리브레이션 마스크 설정
    setCalibrationMask(image) {
        this.calibrationMaskImage = image;
    }

    // 캘리브레이션 윤곽선 설정
    setCalibrationContours(contours) {
        this.calibrationContours = contours;
    }

    // 캔버스 크기 업데이트
    resize(width, height) {
        this.overlay.width = width;
        this.overlay.height = height;
        this.keypointRenderer.resize(width, height);
    }

    // 캔버스 클리어
    clear() {
        if (this.isInitialized) {
            this.ctx.clearRect(0, 0, this.overlay.width, this.overlay.height);
        }
    }

    // 스무딩 설정
    setSmoothingEnabled(enabled) {
        this.renderOptions.smoothing = enabled;
        this.keypointRenderer.setNoiseFilterEnabled(enabled);
    }

    // 보간 설정
    setInterpolationEnabled(enabled) {
        this.renderOptions.interpolation = enabled;
        this.keypointRenderer.setInterpolationEnabled(enabled);
    }

    // 노이즈 필터 파라미터 설정
    setNoiseFilterParameters(params) {
        this.keypointRenderer.setNoiseFilterParameters(params);
    }

    // 히스토리 초기화
    resetHistory() {
        this.keypointRenderer.resetInterpolationHistory();
        this.keypointRenderer.resetNoiseFilterHistory();
    }
}

// 전역 함수로 사용할 수 있도록
export function createRenderer(overlayElement) {
    return new Renderer(overlayElement);
}

// 기존 호환성을 위한 함수
export function updateRenderer(data) {
    if (window.renderer) {
        window.renderer.render(data);
    } else {
        console.warn('Renderer가 초기화되지 않았습니다.');
    }
}
