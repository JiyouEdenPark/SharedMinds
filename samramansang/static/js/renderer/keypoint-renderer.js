// 키포인트 렌더링 관련 기능
export class KeypointRenderer {
    constructor(overlayElement) {
        this.overlay = overlayElement;
        this.ctx = overlayElement.getContext('2d');
        this.isInitialized = false;
    }

    // 캔버스 초기화
    initialize(width, height) {
        this.overlay.width = width;
        this.overlay.height = height;
        this.overlay.style.position = "absolute";
        this.overlay.style.top = "0";
        this.overlay.style.left = "0";
        this.overlay.style.pointerEvents = "none"; // 클릭 방해 X
        this.isInitialized = true;
    }

    // 키포인트 점 그리기
    drawKeypoints(keypoints) {
        for (let i = 0; i < keypoints.length; i++) {
            const [x, y] = keypoints[i];

            // 유효한 좌표이고 점수가 충분히 높은 경우만 그리기
            if (x > 0 && y > 0) {
                // 검정색 키포인트 원
                this.ctx.fillStyle = "rgba(0,0,0,0.8)";
                this.ctx.beginPath();
                this.ctx.arc(x, y, 5, 0, 2 * Math.PI);
                this.ctx.fill();

                // 흰색 윤곽선
                this.ctx.strokeStyle = "rgba(255,255,255,0.9)";
                this.ctx.lineWidth = 1;
                this.ctx.beginPath();
                this.ctx.arc(x, y, 5, 0, 2 * Math.PI);
                this.ctx.stroke();

                // 키포인트 번호 (흰색)
                // this.ctx.fillStyle = "rgba(255,255,255,0.9)";
                // this.ctx.font = "12px Arial";
                // this.ctx.textAlign = "left";
                // this.ctx.fillText(i.toString(), x + 6, y - 6);
            }
        }
    }

    // 스켈레톤 연결선 그리기
    drawSkeleton(keypoints) {
        // COCO 키포인트 연결 관계 정의 (골격)
        const connections = [
            // 머리
            [0, 1], [0, 2], [1, 3], [2, 4],  // 코-왼쪽눈-오른쪽눈-왼쪽귀-오른쪽귀
            // 몸통
            [5, 6], [6, 12], [12, 11], [11, 5],  // 어깨-엉덩이 연결
            // 왼쪽 팔
            [5, 7], [7, 9],  // 왼쪽어깨-왼쪽팔꿈치-왼쪽손목
            // 오른쪽 팔
            [6, 8], [8, 10],  // 오른쪽어깨-오른쪽팔꿈치-오른쪽손목
            // 왼쪽 다리
            [11, 13], [13, 15],  // 왼쪽엉덩이-왼쪽무릎-왼쪽발목
            // 오른쪽 다리
            [12, 14], [14, 16],  // 오른쪽엉덩이-오른쪽무릎-오른쪽발목
        ];

        for (const [startIdx, endIdx] of connections) {
            if (startIdx < keypoints.length && endIdx < keypoints.length) {
                const [x1, y1] = keypoints[startIdx];
                const [x2, y2] = keypoints[endIdx];

                // 유효한 좌표이고 점수가 충분히 높은 경우만 그리기
                if (x1 > 0 && y1 > 0 && x2 > 0 && y2 > 0) {
                    // 검정색 골격 선 (두꺼운 선)
                    this.ctx.strokeStyle = "rgba(0,0,0,0.8)";
                    this.ctx.lineWidth = 3;
                    this.ctx.beginPath();
                    this.ctx.moveTo(x1, y1);
                    this.ctx.lineTo(x2, y2);
                    this.ctx.stroke();

                    // 흰색 윤곽선 (얇은 선)
                    this.ctx.strokeStyle = "rgba(255,255,255,0.9)";
                    this.ctx.lineWidth = 1;
                    this.ctx.beginPath();
                    this.ctx.moveTo(x1, y1);
                    this.ctx.lineTo(x2, y2);
                    this.ctx.stroke();
                }
            }
        }
    }

    // 캔버스 클리어
    clear() {
        if (this.isInitialized) {
            this.ctx.clearRect(0, 0, this.overlay.width, this.overlay.height);
        }
    }

    // 캔버스 크기 업데이트
    resize(width, height) {
        this.overlay.width = width;
        this.overlay.height = height;
    }
}
