import type { Plugin, ResolvedConfig } from "vite";
import { build as esbuild } from "esbuild";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { createRequire } from "node:module";
import process from "node:process";

export interface Z3PluginOptions {
  /**
   * Directory to copy Z3 static assets into, relative to project root.
   * @default "public"  (or "static" if it exists — auto-detected)
   */
  publicDir?: string;

  /**
   * URL prefix where the Z3 static files will be served from.
   * @default "/"
   */
  base?: string;

  /**
   * Cross-Origin-Embedder-Policy header value.
   * "credentialless" is more permissive (allows cross-origin images/fonts).
   * "require-corp" is stricter but more widely supported.
   * @default "credentialless"
   */
  coep?: "credentialless" | "require-corp";

  /**
   * Whether to inject COOP/COEP headers in the dev server.
   * Disable if you're setting them elsewhere (e.g., reverse proxy).
   * @default true
   */
  crossOriginIsolation?: boolean;

  /**
   * Generate an example solver worker file if none exists.
   * @default true
   */
  generateExample?: boolean;
}

const Z3_FILES = ["z3-built.js", "z3-built.wasm", "z3-built.worker.js"];

/**
 * Vite plugin that sets up Z3-solver for browser use.
 *
 * Handles:
 * - Copying z3 WASM/JS/worker files to public directory
 * - Bundling the z3-solver high-level API wrapper via esbuild
 * - Injecting COOP/COEP headers for SharedArrayBuffer support
 * - Generating an example solver worker
 * - Providing a virtual module for easy Z3 worker creation
 */
export function z3Plugin(options: Z3PluginOptions = {}): Plugin[] {
  const {
    base = "/",
    coep = "credentialless",
    crossOriginIsolation = true,
    generateExample = true,
  } = options;

  let config: ResolvedConfig;
  let z3BuildDir: string;

  function resolveZ3BuildDir(root: string): string {
    // Strategy 1: Deno's node_modules/.deno directory
    try {
      const denoDir = join(root, "node_modules", ".deno");
      if (existsSync(denoDir)) {
        for (const entry of readdirSync(denoDir, { withFileTypes: true })) {
          if (entry.name.startsWith("z3-solver@") && entry.isDirectory()) {
            const buildDir = join(
              denoDir,
              entry.name,
              "node_modules",
              "z3-solver",
              "build",
            );
            if (existsSync(join(buildDir, "z3-built.js"))) {
              return buildDir;
            }
          }
        }
      }
    } catch { /* fall through */ }

    // Strategy 2: Standard node_modules
    try {
      const buildDir = join(root, "node_modules", "z3-solver", "build");
      if (existsSync(join(buildDir, "z3-built.js"))) {
        return buildDir;
      }
    } catch { /* fall through */ }

    // Strategy 3: createRequire (Node.js)
    try {
      const require = createRequire(import.meta.url);
      const browserJs = require.resolve("z3-solver/build/browser.js");
      return dirname(browserJs);
    } catch { /* fall through */ }

    throw new Error(
      "[vite-plugin-z3] z3-solver not found. Install it:\n" +
        "  deno add npm:z3-solver    # Deno\n" +
        "  npm install z3-solver     # npm",
    );
  }

  function getPublicDir(root: string): string {
    if (config?.publicDir) return config.publicDir;
    if (options.publicDir) return join(root, options.publicDir);
    // Auto-detect: prefer "static" if it exists (Fresh convention), else "public"
    const staticDir = join(root, "static");
    if (existsSync(staticDir)) return staticDir;
    return join(root, "public");
  }

  function needsUpdate(src: string, dest: string): boolean {
    try {
      const srcStat = statSync(src);
      const destStat = statSync(dest);
      return (srcStat.mtimeMs ?? 0) > (destStat.mtimeMs ?? 0);
    } catch {
      return true;
    }
  }

  return [
    // Plugin 1: Cross-origin isolation headers
    {
      name: "vite-plugin-z3:headers",
      enforce: "pre",

      configResolved(resolvedConfig) {
        config = resolvedConfig;
      },

      configureServer(server) {
        if (!crossOriginIsolation) return;
        server.middlewares.use((_req, res, next) => {
          res.setHeader("Cross-Origin-Opener-Policy", "same-origin");
          res.setHeader("Cross-Origin-Embedder-Policy", coep);
          next();
        });
      },
    },

    // Plugin 2: Asset copying + wrapper bundling + example generation
    {
      name: "vite-plugin-z3:assets",

      configResolved(resolvedConfig) {
        config = resolvedConfig;
        try {
          const root = config?.root ?? process.cwd();
          z3BuildDir = resolveZ3BuildDir(root);
        } catch (e) {
          console.warn(String(e));
        }
      },

      async buildStart() {
        if (!z3BuildDir) return;

        const root = config?.root ?? process.cwd();
        const dest = getPublicDir(root);
        if (!existsSync(dest)) {
          mkdirSync(dest, { recursive: true });
        }

        // 1. Copy Z3 WASM files
        for (const file of Z3_FILES) {
          const src = join(z3BuildDir, file);
          const target = join(dest, file);
          if (!existsSync(src)) {
            console.warn(`[vite-plugin-z3] Missing file: ${src}`);
            continue;
          }
          if (!existsSync(target) || needsUpdate(src, target)) {
            copyFileSync(src, target);
            console.log(`[vite-plugin-z3] Copied ${file}`);
          }
        }

        // 2. Bundle z3-wrapper.js via esbuild
        const wrapperDest = join(dest, "z3-wrapper.js");
        const browserJs = join(z3BuildDir, "browser.js");
        if (!existsSync(wrapperDest) || needsUpdate(browserJs, wrapperDest)) {
          await bundleWrapper(z3BuildDir, wrapperDest);
        }

        // 3. Generate example solver worker
        if (generateExample) {
          const exampleDest = join(dest, "z3-solver-worker.js");
          if (!existsSync(exampleDest)) {
            writeFileSync(exampleDest, generateExampleWorker(base));
            console.log(
              "[vite-plugin-z3] Generated z3-solver-worker.js — edit this with your own Z3 constraints!",
            );
          }
        }
      },
    },

    // Plugin 3: Virtual module
    {
      name: "vite-plugin-z3:virtual",

      resolveId(id) {
        if (id === "virtual:z3") return "\0virtual:z3";
      },

      load(id) {
        if (id === "\0virtual:z3") return generateVirtualModule(base);
      },
    },
  ];
}

/**
 * Bundle z3-solver's browser.js + all its require() deps into a single IIFE
 * that exposes globalThis.z3Init.
 */
async function bundleWrapper(
  z3BuildDir: string,
  outputPath: string,
): Promise<void> {
  // Create a temporary entry that imports browser.js and exposes init
  const entryCode = `
    const { init } = require("${
    join(z3BuildDir, "browser.js").replace(/\\/g, "/")
  }");
    globalThis.z3Init = init;
  `;

  const entryPath = outputPath + ".entry.tmp.js";
  writeFileSync(entryPath, entryCode);

  try {
    await esbuild({
      entryPoints: [entryPath],
      bundle: true,
      format: "iife",
      platform: "browser",
      outfile: outputPath,
      logLevel: "warning",
    });
    console.log("[vite-plugin-z3] Bundled z3-wrapper.js via esbuild");
  } catch (err) {
    console.error("[vite-plugin-z3] Failed to bundle z3-wrapper.js:", err);
    // Write a fallback that at least makes the error clear
    writeFileSync(
      outputPath,
      `
(function() {
  globalThis.z3Init = function() {
    throw new Error("[vite-plugin-z3] z3-wrapper.js failed to bundle. Check the build logs.");
  };
})();
`.trim(),
    );
  } finally {
    try {
      unlinkSync(entryPath);
    } catch { /* ignore */ }
  }
}

/**
 * Generate an example solver worker with full boilerplate + a working example.
 */
function generateExampleWorker(base: string): string {
  const b = base.endsWith("/") ? base : base + "/";
  return `// Z3 Solver Web Worker
// Generated by vite-plugin-z3 — edit this file with your own constraints!
//
// This worker runs Z3 in a dedicated thread so:
//   1. The UI doesn't freeze during solving
//   2. Z3's internal pthreads (sub-workers) work correctly

// ─── Z3 Loading Boilerplate ───────────────────────────────────────────
// Fix URL resolution (document.currentScript doesn't exist in workers)
globalThis.__filename = new URL("${b}z3-built.js", self.location.href).href;

// Load Z3 WASM engine
importScripts("${b}z3-built.js");

// Bridge: z3-solver's API reads global.initZ3
globalThis.global = globalThis;
globalThis.global.initZ3 = globalThis.initZ3;

// Load the bundled high-level API wrapper
importScripts("${b}z3-wrapper.js");

// Cache Z3 context (first call loads WASM, subsequent calls are instant)
let _z3 = null;
async function getZ3() {
  if (_z3) return _z3;
  console.log("[z3-worker] Initializing Z3...");
  _z3 = await globalThis.z3Init();
  console.log("[z3-worker] Z3 ready!");
  return _z3;
}

// ─── Your Solver Logic ────────────────────────────────────────────────
// Modify this function with your own constraints!
async function solve(data) {
  const z3 = await getZ3();
  const { Solver, Int, Sum, If } = new z3.Context("main");

  const solver = new Solver();

  // ── Example: Find x and y where x + y = 10, both positive, x <= y ──
  const x = Int.const("x");
  const y = Int.const("y");

  solver.add(x.ge(1));        // x >= 1
  solver.add(y.ge(1));        // y >= 1
  solver.add(x.add(y).eq(10)); // x + y = 10
  solver.add(x.le(y));        // x <= y

  const status = await solver.check();

  if (status === "sat") {
    const model = solver.model();
    return {
      x: Number(model.eval(x).toString()),
      y: Number(model.eval(y).toString()),
    };
  } else {
    throw new Error("No solution found (status: " + status + ")");
  }
}

// ─── Message Handler ──────────────────────────────────────────────────
self.onmessage = async (e) => {
  try {
    const result = await solve(e.data);
    self.postMessage({ ok: true, result });
  } catch (err) {
    self.postMessage({ ok: false, error: String(err) });
  }
};
`;
}

/**
 * Generate the virtual:z3 module code.
 */
function generateVirtualModule(base: string): string {
  const b = base.endsWith("/") ? base : base + "/";
  return `
/**
 * Create a Z3 worker, send it data, and get the result.
 *
 * @param {string} workerUrl - URL to your solver worker
 * @param {any} data - Data to send to the worker
 * @returns {Promise<any>} The solver result
 *
 * @example
 * import { solveWith } from "virtual:z3";
 * const result = await solveWith("${b}z3-solver-worker.js", { n: 10 });
 */
export function solveWith(workerUrl, data) {
  return new Promise((resolve, reject) => {
    const worker = new Worker(workerUrl);
    worker.onmessage = (e) => {
      worker.terminate();
      if (e.data.ok) resolve(e.data.result);
      else reject(new Error(e.data.error));
    };
    worker.onerror = (err) => {
      worker.terminate();
      reject(err);
    };
    worker.postMessage(data);
  });
}

/**
 * Check if the current environment supports Z3 (SharedArrayBuffer + Workers).
 */
export function isZ3Supported() {
  return typeof SharedArrayBuffer !== "undefined" && typeof Worker !== "undefined";
}

/**
 * Check if cross-origin isolation is active (required for SharedArrayBuffer).
 */
export function isCrossOriginIsolated() {
  return typeof crossOriginIsolated !== "undefined" && crossOriginIsolated;
}
`.trim();
}

export default z3Plugin;
