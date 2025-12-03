/**
 * 포즈 데이터 WebSocket 클라이언트 라이브러리
 * 공통 WebSocket 연결 및 메시지 처리 로직
 */

export class PoseWebSocketClient {
    constructor(options = {}) {
        this.ws = null;
        this.wsUrl = options.wsUrl || `ws://${window.location.hostname}:${window.location.port || 8081}/ws`;
        this.reconnectDelay = options.reconnectDelay || 3000;
        this.autoReconnect = options.autoReconnect !== false;
        
        // 콜백 함수들
        this.onOpen = options.onOpen || null;
        this.onClose = options.onClose || null;
        this.onError = options.onError || null;
        this.onFrame = options.onFrame || null;  // 프레임 데이터 수신 시
        this.onKpts = options.onKpts || null;    // 포즈 데이터 수신 시
        this.onMessage = options.onMessage || null; // 모든 메시지 수신 시
    }
    
    connect() {
        if (this.ws && this.ws.readyState === WebSocket.OPEN) {
            console.log('WebSocket이 이미 연결되어 있습니다.');
            return;
        }
        
        if (this.ws) {
            this.disconnect();
        }
        
        console.log('포즈 데이터 WebSocket 연결 시도:', this.wsUrl);
        this.ws = new WebSocket(this.wsUrl);
        
        this.ws.onopen = () => {
            console.log('포즈 데이터 WebSocket 연결됨:', this.wsUrl);
            if (this.onOpen) {
                this.onOpen();
            }
        };
        
        this.ws.onmessage = (event) => {
            try {
                const data = JSON.parse(event.data);
                
                // 모든 메시지에 대한 콜백
                if (this.onMessage) {
                    this.onMessage(data);
                }
                
                // 프레임 데이터 처리
                if (data.type === 'frame' || data.type === 'frame_kpts') {
                    if (this.onFrame) {
                        this.onFrame(data);
                    }
                }
                
                // 포즈 데이터 처리
                if (data.type === 'kpts' || data.type === 'frame_kpts') {
                    if (this.onKpts) {
                        this.onKpts(data);
                    }
                }
            } catch (e) {
                console.log('포즈 WebSocket에서 받은 raw 데이터:', event.data);
            }
        };
        
        this.ws.onerror = (error) => {
            console.error('포즈 데이터 WebSocket 오류:', error);
            if (this.onError) {
                this.onError(error);
            }
        };
        
        this.ws.onclose = () => {
            console.log('포즈 데이터 WebSocket 연결 끊어짐');
            this.ws = null;
            
            if (this.onClose) {
                this.onClose();
            }
            
            // 자동 재연결
            if (this.autoReconnect) {
                setTimeout(() => {
                    if (!this.ws) {
                        console.log('WebSocket 재연결 시도...');
                        this.connect();
                    }
                }, this.reconnectDelay);
            }
        };
    }
    
    disconnect() {
        this.autoReconnect = false;
        if (this.ws) {
            this.ws.close();
            this.ws = null;
        }
    }
    
    isConnected() {
        return this.ws && this.ws.readyState === WebSocket.OPEN;
    }
    
    send(data) {
        if (this.isConnected()) {
            this.ws.send(typeof data === 'string' ? data : JSON.stringify(data));
        } else {
            console.warn('WebSocket이 연결되지 않았습니다.');
        }
    }
}

/**
 * 프레임 데이터를 이미지 엘리먼트에 표시하는 헬퍼 함수
 */
export function updateImageElement(data, imageElement, bgVisible = true) {
    if (!data.frame || !imageElement) return;
    
    const dataUrl = 'data:image/jpeg;base64,' + data.frame;
    imageElement.src = dataUrl;
    
    if (bgVisible) {
        imageElement.style.display = 'block';
    }
}

