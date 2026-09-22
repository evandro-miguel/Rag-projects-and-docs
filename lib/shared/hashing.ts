/**
 * @module hashing
 * @description Shared hashing utilities for RAG-v1.
 * Provides consistent SHA-256 fingerprinting using Web Crypto API.
 */

/**
 * Generate a consistent SHA-256 hash for the given content using Web Crypto API.
 *
 * Works in browser and Node.js environments.
 *
 * @param content - The string content to hash
 * @returns Hexadecimal hash string (64 characters)
 */
export async function calculateHashAsync(content: string): Promise<string> {
  const msgUint8 = new TextEncoder().encode(content);
  const cryptoAPI = typeof crypto !== 'undefined' ? crypto : (globalThis as any).crypto;

  if (!cryptoAPI?.subtle?.digest) {
    throw new Error('Web Crypto API (subtle.digest) is not available');
  }

  const hashBuffer = await cryptoAPI.subtle.digest('SHA-256', msgUint8);
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  return hashArray.map((b) => b.toString(16).padStart(2, '0')).join('');
}

/**
 * Alias for calculateHashAsync - kept for backward compatibility.
 * Use calculateHashAsync for new code.
 */
export const calculateHash = calculateHashAsync;
