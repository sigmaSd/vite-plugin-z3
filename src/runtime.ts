/**
 * Runtime utilities for using Z3 in the browser.
 * Import this in your main thread code.
 *
 * @example
 * ```ts
 * import { createZ3Worker, isZ3Supported } from "@sigmasd/vite-plugin-z3/runtime";
 *
 * if (!isZ3Supported()) {
 *   console.error("Z3 not supported in this browser");
 * }
 *
 * const z3 = await createZ3Worker("/my-solver-worker.js");
 * const result = await z3.run({ type: "solve", data: myProblem });
 * z3.terminate();
 * ```
 *
 * @module
 */

export interface Z3WorkerHandle {
  /** The underlying Web Worker instance */
  worker: Worker;

  /**
   * Send a task to the Z3 worker and wait for the result.
   * @param data - Arbitrary data to send to the worker
   * @returns Promise resolving with the worker's response
   */
  run<T = unknown>(data: unknown): Promise<T>;

  /** Terminate the worker */
  terminate(): void;
}

/**
 * Create a Z3 worker, send it data, and get the result.
 * It automatically terminates the worker after completion.
 *
 * @param workerUrl - URL to your worker script
 * @param data - Data to send to the solver
 */
export function solveWith<T = unknown>(
  workerUrl: string,
  data: unknown,
): Promise<T> {
  return new Promise((resolve, reject) => {
    const worker = new Worker(workerUrl);
    const onMessage = (e: MessageEvent) => {
      if (e.data?.type === "z3:ready") return;
      if (e.data?.type !== "z3:result") return;
      worker.terminate();
      if (e.data.ok) resolve(e.data.result);
      else reject(new Error(e.data.error));
    };
    worker.addEventListener("message", onMessage);
    worker.onerror = (err) => {
      worker.terminate();
      reject(err);
    };
    worker.postMessage(data);
  });
}

/**
 * Create a Z3 worker and wait for it to finish loading WASM.
 *
 * @param workerUrl - URL to your worker script
 * @returns A handle to communicate with the Z3 worker
 *
 * @example
 * ```ts
 * const z3 = await createZ3Worker("/scheduler-worker.js");
 * const schedule = await z3.run({ people, year, month });
 * z3.terminate();
 * ```
 */
export function createZ3Worker(workerUrl: string): Promise<Z3WorkerHandle> {
  return new Promise((resolve, reject) => {
    const worker = new Worker(workerUrl);

    const timeout = setTimeout(() => {
      reject(
        new Error("[vite-plugin-z3] Worker initialization timed out (30s)"),
      );
      worker.terminate();
    }, 30_000);

    worker.onerror = (err) => {
      clearTimeout(timeout);
      reject(
        new Error("[vite-plugin-z3] Worker failed: " + (err.message || err)),
      );
    };

    const onReady = (e: MessageEvent) => {
      if (e.data?.type === "z3:ready") {
        clearTimeout(timeout);
        worker.removeEventListener("message", onReady);
        resolve({
          worker,
          run<T = unknown>(data: unknown): Promise<T> {
            return new Promise((res, rej) => {
              const onResult = (e: MessageEvent) => {
                if (e.data?.type !== "z3:result") return;
                worker.removeEventListener("message", onResult);
                if (e.data.ok) res(e.data.result);
                else rej(new Error(e.data.error));
              };
              worker.addEventListener("message", onResult);
              worker.onerror = (err) => {
                worker.removeEventListener("message", onResult);
                rej(err);
              };
              worker.postMessage(data);
            });
          },
          terminate() {
            worker.terminate();
          },
        });
      }
    };
    worker.addEventListener("message", onReady);
  });
}

/**
 * Check if the current environment supports Z3.
 * Requires SharedArrayBuffer (needs COOP/COEP headers) and Web Workers.
 */
export function isZ3Supported(): boolean {
  return (
    typeof SharedArrayBuffer !== "undefined" &&
    typeof Worker !== "undefined"
  );
}

/**
 * Check if cross-origin isolation is active.
 * SharedArrayBuffer requires this — if false, Z3 will fail.
 */
export function isCrossOriginIsolated(): boolean {
  return (
    typeof globalThis.crossOriginIsolated !== "undefined" &&
    globalThis.crossOriginIsolated === true
  );
}
