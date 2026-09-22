#!/usr/bin/env bun
/**
 * @module generate-topic-clusters
 * @description Experimental script to generate Spectral/K-Means Clusters for Semantic Navigation.
 */

// Simple K-Means implementation since full Spectral Clustering requires an adjacency matrix
// and laplacian eigenvalues, which is heavy for a quick exploratory script.
function kMeans(embeddings: number[][], numClusters: number, maxIters = 50) {
  // Initialize centroids randomly
  let centroids = Array.from({ length: numClusters }, () => {
    const randomIdx = Math.floor(Math.random() * embeddings.length);
    return [...embeddings[randomIdx]];
  });

  const clusters: number[] = new Array(embeddings.length).fill(0);

  for (let iter = 0; iter < maxIters; iter++) {
    // Assign to closest centroid
    let changed = false;
    for (let i = 0; i < embeddings.length; i++) {
      let minD = Infinity;
      let bestC = 0;
      for (let c = 0; c < numClusters; c++) {
        const d = cosineDistance(embeddings[i], centroids[c]);
        if (d < minD) {
          minD = d;
          bestC = c;
        }
      }
      if (clusters[i] !== bestC) {
        clusters[i] = bestC;
        changed = true;
      }
    }

    if (!changed) break;

    // Recompute centroids
    const newCentroids = Array.from({ length: numClusters }, () =>
      new Array(embeddings[0].length).fill(0)
    );
    const counts = new Array(numClusters).fill(0);

    for (let i = 0; i < embeddings.length; i++) {
      const c = clusters[i];
      counts[c]++;
      for (let d = 0; d < embeddings[0].length; d++) {
        newCentroids[c][d] += embeddings[i][d];
      }
    }

    for (let c = 0; c < numClusters; c++) {
      if (counts[c] > 0) {
        for (let d = 0; d < embeddings[0].length; d++) {
          newCentroids[c][d] /= counts[c];
        }
      }
    }
    centroids = newCentroids;
  }
  return clusters;
}

function cosineDistance(a: number[], b: number[]) {
  let dot = 0,
    normA = 0,
    normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    normA += a[i] ** 2;
    normB += b[i] ** 2;
  }
  const sim = dot / (Math.sqrt(normA) * Math.sqrt(normB) || 1);
  return 1 - sim;
}

async function main() {
  console.log('🔍 Fetching chunk embeddings for clustering...');
  // Note: in a real environment this might require pagination
  try {
    const chunks: any[] = [];
    if (chunks.length === 0) {
      console.log('🚧 Placeholder: no chunks fetched. Wire this to Project RAG Postgres chunks.');
      console.log('✅ Semantic Navigation Spectral/K-Means structure ready for implementation.');
      process.exit(0);
    }

    // Sample vector structure: [ [0.1, ...], [0.2, ...] ]
    const vectors = chunks.map((c) => c.embedding);
    const numClusters = Math.min(10, Math.floor(vectors.length / 5));

    console.log(`🧠 Clustering ${vectors.length} chunks into ${numClusters} topics...`);
    const clusters = kMeans(vectors, numClusters);

    console.log('📊 Cluster Distribution:');
    const distribution = Array(numClusters).fill(0);
    clusters.forEach((c) => {
      distribution[c]++;
    });
    console.table(distribution);
  } catch (e) {
    console.error(e);
  }
}

main();

export {};
