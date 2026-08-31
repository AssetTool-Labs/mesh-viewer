let sourcePromise: Promise<string> | null = null;

export function fetchStepWorkerSource(
  workerUri: string,
  fetcher: typeof globalThis.fetch = globalThis.fetch,
): Promise<string> {
  sourcePromise ??= fetcher(workerUri).then((response) => {
    if (!response.ok) throw new Error(`Could not load the STEP worker (${response.status}).`);
    return response.text();
  }).catch((error) => {
    sourcePromise = null;
    throw error;
  });
  return sourcePromise;
}