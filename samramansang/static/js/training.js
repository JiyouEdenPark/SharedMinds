// Training System JavaScript
class TrainingSystem {
    constructor() {
        this.isTraining = false;
        this.trainingStartTime = null;
        this.currentStep = '';
        this.progress = 0;
        this.stats = {
            currentEpoch: 0,
            totalEpochs: 0,
            currentLoss: 0,
            bestLoss: Infinity,
            elapsedTime: 0
        };
        
        // Set to prevent duplicate logs
        this.processedLogs = new Set();
        
        this.initializeElements();
        this.initializeEventListeners();
        this.loadDatasetInfo();
        
        // Initialize algorithm-specific UI
        this.onAlgorithmChange();
        
        // Initialize training mode UI
        this.onTrainingModeChange();
    }
    
    initializeElements() {
        // Buttons
        this.startButton = document.getElementById('startButton');
        this.stopButton = document.getElementById('stopButton');
        
        // Status and progress
        this.statusDiv = document.getElementById('status');
        this.progressFill = document.getElementById('progressFill');
        this.progressText = document.getElementById('progressText');
        
        // Stats
        this.currentEpochSpan = document.getElementById('currentEpoch');
        this.currentLossSpan = document.getElementById('currentLoss');
        this.bestLossSpan = document.getElementById('bestLoss');
        this.elapsedTimeSpan = document.getElementById('elapsedTime');
        
        // Dataset info
        this.totalFilesSpan = document.getElementById('totalFiles');
        this.totalSizeSpan = document.getElementById('totalSize');
        this.datasetFilesDiv = document.getElementById('datasetFiles');
        
        // Log container
        this.logContainer = document.getElementById('logContainer');
    }
    
    initializeEventListeners() {
        this.startButton.addEventListener('click', () => this.startTraining());
        this.stopButton.addEventListener('click', () => this.stopTraining());
        
        // Algorithm change listener
        const algorithmSelect = document.getElementById('algorithm');
        algorithmSelect.addEventListener('change', () => this.onAlgorithmChange());
        
        // Training mode change listener
        const trainingModeSelect = document.getElementById('trainingMode');
        trainingModeSelect.addEventListener('change', () => this.onTrainingModeChange());
        
        // Auto-refresh dataset info every 30 seconds
        setInterval(() => this.loadDatasetInfo(), 30000);
    }
    
    async loadDatasetInfo() {
        try {
            const response = await fetch('/training/dataset-info');
            const data = await response.json();
            
            if (data.status === 'ok') {
                this.totalFilesSpan.textContent = data.total_files;
                this.totalSizeSpan.textContent = `${(data.total_size / 1024 / 1024).toFixed(1)} MB`;
                
                // Update dataset files list
                this.datasetFilesDiv.innerHTML = '';
                data.files.forEach(file => {
                    const fileDiv = document.createElement('div');
                    fileDiv.className = 'dataset-file';
                    fileDiv.textContent = `${file.name} (${(file.size / 1024 / 1024).toFixed(1)} MB)`;
                    this.datasetFilesDiv.appendChild(fileDiv);
                });
            }
        } catch (error) {
            console.error('Failed to load dataset info:', error);
        }
    }
    
    getTrainingConfig() {
        const algorithm = document.getElementById('algorithm').value;
        const trainingMode = document.getElementById('trainingMode').value;
        
        const config = {
            training_mode: trainingMode,
            data_glob: document.getElementById('dataGlob').value,
            window: parseInt(document.getElementById('window').value),
            stride: parseInt(document.getElementById('stride').value),
            algorithm: algorithm,
            clusters: parseInt(document.getElementById('clusters').value),
            min_length: parseInt(document.getElementById('minLength').value),
            merge_gap: parseInt(document.getElementById('mergeGap').value),
            split_criterion: document.getElementById('splitCriterion').value,
            max_len_windows: parseInt(document.getElementById('maxLenWindows').value),
            trim_edges: document.getElementById('trimEdges').value === 'on',
            edge_radius: parseInt(document.getElementById('edgeRadius').value),
            rep_method: document.getElementById('repMethod').value,
            rep_k: parseInt(document.getElementById('repK').value),
            rep_thr: parseFloat(document.getElementById('repThr').value)
        };

        // Training mode specific parameters
        if (trainingMode === 'full') {
            // Full pipeline: include training parameters
            config.epochs = parseInt(document.getElementById('epochs').value);
            config.batch_size = parseInt(document.getElementById('batchSize').value);
            config.lr = parseFloat(document.getElementById('learningRate').value);
            config.weight_decay = parseFloat(document.getElementById('weightDecay').value);
            config.temperature = parseFloat(document.getElementById('temperature').value);
            config.workers = parseInt(document.getElementById('workers').value);
        } else if (trainingMode === 'clustering') {
            // Clustering only: include existing file paths
            config.embeddings_path = document.getElementById('embeddingsPath').value;
            config.model_path = document.getElementById('modelPath').value;
        }

        // Algorithm-specific parameters
        if (algorithm === 'hdbscan') {
            config.hdb_min_cluster = parseInt(document.getElementById('hdbMinCluster').value);
            config.hdb_min_samples = parseInt(document.getElementById('hdbMinSamples').value);
        } else if (algorithm === 'kmeans') {
            config.kmeans_init = document.getElementById('kmeansInit').value;
            config.kmeans_n_init = parseInt(document.getElementById('kmeansNInit').value);
        }

        return config;
    }
    
    onAlgorithmChange() {
        const algorithm = document.getElementById('algorithm').value;
        const hdbscanSettings = document.getElementById('hdbscanSettings');
        const kmeansSettings = document.getElementById('kmeansSettings');
        const clustersGroup = document.getElementById('clustersGroup');
        
        if (algorithm === 'hdbscan') {
            // Show HDBSCAN settings
            hdbscanSettings.style.display = 'flex';
            kmeansSettings.style.display = 'none';
            
            // Hide cluster count as it's automatically determined in HDBSCAN
            clustersGroup.style.display = 'none';
            
            // Set default values suitable for HDBSCAN
            document.getElementById('hdbMinCluster').value = 5;
            document.getElementById('hdbMinSamples').value = 3;
            
        } else if (algorithm === 'kmeans') {
            // Show K-means settings
            hdbscanSettings.style.display = 'none';
            kmeansSettings.style.display = 'flex';
            
            // Show cluster count as it's required for K-means
            clustersGroup.style.display = 'block';
            
            // Update cluster count label
            const clustersLabel = clustersGroup.querySelector('label');
            clustersLabel.textContent = 'Number of Clusters (K):';
            
            // Set default values suitable for K-means
            document.getElementById('clusters').value = 8;
            document.getElementById('kmeansInit').value = 'k-means++';
            document.getElementById('kmeansNInit').value = 10;
        }
        
        this.log(`Algorithm changed to ${algorithm.toUpperCase()}.`, 'info');
    }
    
    onTrainingModeChange() {
        const trainingMode = document.getElementById('trainingMode').value;
        const trainingParamsSection = document.getElementById('trainingParamsSection');
        const clusteringOnlySection = document.getElementById('clusteringOnlySection');
        
        if (trainingMode === 'full') {
            // Full pipeline: show training parameters
            trainingParamsSection.style.display = 'block';
            clusteringOnlySection.style.display = 'none';
            this.log('Full pipeline mode: Starting from training.', 'info');
        } else if (trainingMode === 'clustering') {
            // Clustering only: show embedding settings
            trainingParamsSection.style.display = 'none';
            clusteringOnlySection.style.display = 'block';
            this.log('Clustering only mode: Using existing embeddings.', 'info');
        }
    }
    
    async startTraining() {
        if (this.isTraining) return;
        
        const config = this.getTrainingConfig();
        
        // Validate config
        if (!this.validateConfig(config)) {
            return;
        }
        
        try {
            this.isTraining = true;
            this.trainingStartTime = Date.now();
            this.processedLogs.clear(); // Initialize Set to prevent duplicate logs
            this.updateUI();
            this.log('🚀 Starting training...', 'info');
            
            const response = await fetch('/training/start', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify(config)
            });
            
            const result = await response.json();
            
            if (result.status === 'ok') {
                this.log('✅ Training started successfully.', 'success');
                this.startProgressMonitoring();
            } else {
                this.log(`❌ Failed to start training: ${result.error}`, 'error');
                this.isTraining = false;
                this.updateUI();
            }
        } catch (error) {
            this.log(`❌ Error while starting training: ${error.message}`, 'error');
            this.isTraining = false;
            this.updateUI();
        }
    }
    
    async stopTraining() {
        if (!this.isTraining) return;
        
        try {
            this.log('⏹️ Stopping training...', 'warning');
            
            const response = await fetch('/training/stop', {
                method: 'POST'
            });
            
            const result = await response.json();
            
            if (result.status === 'ok') {
                this.log('✅ Training stopped.', 'success');
            } else {
                this.log(`❌ Failed to stop training: ${result.error}`, 'error');
            }
        } catch (error) {
            this.log(`❌ Error while stopping training: ${error.message}`, 'error');
        }
        
        this.isTraining = false;
        this.updateUI();
    }
    
    validateConfig(config) {
        if (!config.data_glob || config.data_glob.trim() === '') {
            this.log('❌ Please enter data path.', 'error');
            return false;
        }
        
        // Validation based on training mode
        if (config.training_mode === 'full') {
            // Full pipeline: validate training parameters
            if (config.epochs < 1 || config.epochs > 1000) {
                this.log('❌ Number of epochs must be between 1-1000.', 'error');
                return false;
            }
            
            if (config.batch_size < 1 || config.batch_size > 512) {
                this.log('❌ Batch size must be between 1-512.', 'error');
                return false;
            }
            
            if (config.lr <= 0 || config.lr > 0.1) {
                this.log('❌ Learning rate must be greater than 0 and less than or equal to 0.1.', 'error');
                return false;
            }
        } else if (config.training_mode === 'clustering') {
            // Clustering only: validate embedding file path
            if (!config.embeddings_path || config.embeddings_path.trim() === '') {
                this.log('❌ Please enter embedding file path.', 'error');
                return false;
            }
        }
        
        return true;
    }
    
    async startProgressMonitoring() {
        const monitorInterval = setInterval(async () => {
            if (!this.isTraining) {
                clearInterval(monitorInterval);
                return;
            }
            
            try {
                const response = await fetch('/training/status');
                const data = await response.json();
                
                if (data.status === 'ok') {
                    this.updateProgress(data);
                }
            } catch (error) {
                console.error('Failed to get training status:', error);
            }
        }, 2000); // Check every 2 seconds
    }
    
    updateProgress(data) {
        this.currentStep = data.current_step || '';
        this.progress = data.progress || 0;
        this.stats = {
            currentEpoch: data.current_epoch || 0,
            totalEpochs: data.total_epochs || 0,
            currentLoss: data.current_loss || 0,
            bestLoss: data.best_loss || Infinity,
            elapsedTime: data.elapsed_time || 0
        };
        
        // Update progress bar
        this.progressFill.style.width = `${this.progress}%`;
        this.progressText.textContent = `${this.currentStep} (${this.progress.toFixed(1)}%)`;
        
        // Update stats
        this.currentEpochSpan.textContent = `${this.stats.currentEpoch}/${this.stats.totalEpochs}`;
        this.currentLossSpan.textContent = this.stats.currentLoss.toFixed(4);
        this.bestLossSpan.textContent = (this.stats.bestLoss === null || this.stats.bestLoss === Infinity) ? 'N/A' : this.stats.bestLoss.toFixed(4);
        this.elapsedTimeSpan.textContent = this.formatTime(this.stats.elapsedTime);
        
        // Update status
        if (this.currentStep) {
            this.statusDiv.textContent = `${this.currentStep} - ${this.progress.toFixed(1)}%`;
        }
        
        // Add log entries for important events (prevent duplicates)
        if (data.log_entries) {
            data.log_entries.forEach(entry => {
                // Check if log is already displayed (prevent duplicates by timestamp)
                const logKey = `${entry.timestamp}_${entry.message}`;
                if (!this.processedLogs) {
                    this.processedLogs = new Set();
                }
                
                if (!this.processedLogs.has(logKey)) {
                    this.processedLogs.add(logKey);
                    this.log(entry.message, entry.level);
                }
            });
        }
        
        // Check state for completion/termination
        const state = data.state || (data.is_complete ? 'completed' : (data.is_running ? 'running' : 'idle'));
        if (state === 'completed' || state === 'failed' || state === 'stopped') {
            if (this.isTraining) {
                if (state === 'completed') this.log('🎉 Training completed!', 'success');
                if (state === 'failed') this.log('❌ Training failed.', 'error');
                if (state === 'stopped') this.log('⏹️ Training stopped.', 'warning');
            }
            this.isTraining = false;
            this.updateUI();
        }
    }
    
    updateUI() {
        this.startButton.disabled = this.isTraining;
        this.stopButton.disabled = !this.isTraining;
        
        if (this.isTraining) {
            this.statusDiv.textContent = 'Training in progress...';
            this.statusDiv.style.background = 'rgba(81, 207, 102, 0.2)';
        } else {
            this.statusDiv.textContent = 'Ready for training...';
            this.statusDiv.style.background = 'rgba(255, 255, 255, 0.1)';
        }
    }
    
    log(message, level = 'info') {
        const timestamp = new Date().toLocaleTimeString();
        const logEntry = document.createElement('div');
        logEntry.className = `log-entry log-${level}`;
        logEntry.textContent = `[${timestamp}] ${message}`;
        
        this.logContainer.appendChild(logEntry);
        this.logContainer.scrollTop = this.logContainer.scrollHeight;
        
        // Keep only last 100 log entries
        while (this.logContainer.children.length > 100) {
            this.logContainer.removeChild(this.logContainer.firstChild);
        }
    }
    
    formatTime(seconds) {
        const hours = Math.floor(seconds / 3600);
        const minutes = Math.floor((seconds % 3600) / 60);
        const secs = Math.floor(seconds % 60);
        
        if (hours > 0) {
            return `${hours.toString().padStart(2, '0')}:${minutes.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}`;
        } else {
            return `${minutes.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}`;
        }
    }
}

// Initialize training system when page loads
document.addEventListener('DOMContentLoaded', () => {
    window.trainingSystem = new TrainingSystem();
});

// Export for global access
window.TrainingSystem = TrainingSystem;
