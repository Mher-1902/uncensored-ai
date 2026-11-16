// Read-only probes can retry a transport failure; chat requests never use this.
export function createHealthFetch(fetchImpl, {attemptTimeoutMs = 6500} = {}) {
  return async (url, options) => {
    if (options.method !== 'GET' || new URL(url).pathname !== '/api/health') {
      throw Error('Only readiness probes can use connection retries.');
    }
    for (let attempt = 0; attempt < 2; attempt++) {
      options.signal.throwIfAborted();
      const signal = AbortSignal.any([options.signal, AbortSignal.timeout(attemptTimeoutMs)]);
      try {
        // Preserve the caller's cancellation through response-body consumption.
        return await fetchImpl(url, {...options, signal});
      } catch (error) {
        if (options.signal.aborted || attempt === 1) throw error;
      }
    }
  };
}
