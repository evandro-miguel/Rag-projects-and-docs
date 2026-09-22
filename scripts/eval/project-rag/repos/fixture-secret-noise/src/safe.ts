/**
 * Get the public API configuration.
 */
export function getPublicApiConfig() {
  return {
    apiBaseUrl: 'https://example.test',
    requestTimeoutMs: 1500,
  };
}

/**
 * Get the configured API base URL for making requests.
 */
export function getApiBaseUrl(): string {
  return getPublicApiConfig().apiBaseUrl;
}
