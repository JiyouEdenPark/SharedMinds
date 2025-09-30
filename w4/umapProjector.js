(function () {
    /**
     * Compute 2D UMAP embeddings for an array of texts using ProxyAI.embedTexts.
     * Returns an array of { x, y } coordinates in [-1,1] range suitable for 2D mode.
     * @param {string[]} texts
     * @param {Object} opts
     * @returns {Promise<{x:number,y:number}[]>}
     */
    async function projectTextsUMAP(texts, opts = {}) {
        if (!Array.isArray(texts) || texts.length === 0) return [];
        try {
            const vectors = await (window.ProxyAI?.embedTexts ? window.ProxyAI.embedTexts(texts) : Promise.resolve([]));
            // expose original vectors for clustering if caller needs it
            window.__lastEmbeddingVectors = vectors;
            if (!Array.isArray(vectors) || vectors.length === 0) return [];

            // Configure UMAP
            // Try multiple globals depending on UMD build
            const UMAPCtor =
                (window.UMAP && (window.UMAP.UMAP || window.UMAP)) ||
                (window.umap && (window.umap.UMAP || window.umap)) ||
                (window.umapjs && (window.umapjs.UMAP || window.umapjs)) ||
                window.Umap ||
                null;
            if (!UMAPCtor) throw new Error('UMAP library not loaded');
            const umap = new UMAPCtor({
                nComponents: 2,
                nNeighbors: opts.nNeighbors || 15,
                minDist: opts.minDist || 0.1,
                spread: opts.spread || 1.0,
            });
            const embedding = umap.fit(vectors);
            // Normalize to [-1,1]
            let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
            embedding.forEach(([x, y]) => {
                if (x < minX) minX = x; if (x > maxX) maxX = x;
                if (y < minY) minY = y; if (y > maxY) maxY = y;
            });
            const rangeX = Math.max(1e-6, maxX - minX);
            const rangeY = Math.max(1e-6, maxY - minY);
            const points = embedding.map(([x, y]) => {
                const nx = ((x - minX) / rangeX) * 2 - 1;
                const ny = ((y - minY) / rangeY) * 2 - 1;
                return { x: nx, y: ny };
            });
            return points;
        } catch (err) {
            console.error("UMAP projection failed:", err);
            return [];
        }
    }

    /**
     * Compute 3D UMAP embeddings for an array of texts using ProxyAI.embedTexts.
     * Returns an array of { x, y, z } coordinates in [-1,1] range suitable for 3D mode.
     * @param {string[]} texts
     * @param {Object} opts
     * @returns {Promise<{x:number,y:number,z:number}[]>}
     */
    async function projectTextsUMAP3D(texts, opts = {}) {
        if (!Array.isArray(texts) || texts.length === 0) return [];
        try {
            const vectors = await (window.ProxyAI?.embedTexts ? window.ProxyAI.embedTexts(texts) : Promise.resolve([]));
            window.__lastEmbeddingVectors = vectors;
            if (!Array.isArray(vectors) || vectors.length === 0) return [];

            const UMAPCtor =
                (window.UMAP && (window.UMAP.UMAP || window.UMAP)) ||
                (window.umap && (window.umap.UMAP || window.umap)) ||
                (window.umapjs && (window.umapjs.UMAP || window.umapjs)) ||
                window.Umap ||
                null;
            if (!UMAPCtor) throw new Error('UMAP library not loaded');
            const umap = new UMAPCtor({
                nComponents: 3,
                nNeighbors: opts.nNeighbors || 15,
                minDist: opts.minDist || 0.1,
                spread: opts.spread || 1.0,
            });
            const embedding = umap.fit(vectors);

            let minX = Infinity, minY = Infinity, minZ = Infinity;
            let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
            embedding.forEach(([x, y, z]) => {
                if (x < minX) minX = x; if (x > maxX) maxX = x;
                if (y < minY) minY = y; if (y > maxY) maxY = y;
                if (z < minZ) minZ = z; if (z > maxZ) maxZ = z;
            });
            const rangeX = Math.max(1e-6, maxX - minX);
            const rangeY = Math.max(1e-6, maxY - minY);
            const rangeZ = Math.max(1e-6, maxZ - minZ);
            const points = embedding.map(([x, y, z]) => {
                const nx = ((x - minX) / rangeX) * 2 - 1;
                const ny = ((y - minY) / rangeY) * 2 - 1;
                const nz = ((z - minZ) / rangeZ) * 2 - 1;
                return { x: nx, y: ny, z: nz };
            });
            return points;
        } catch (err) {
            console.error("UMAP projection failed:", err);
            return [];
        }
    }

    window.UMAPProjector = {
        projectTextsUMAP,
        projectTextsUMAP3D,
    };
})();


