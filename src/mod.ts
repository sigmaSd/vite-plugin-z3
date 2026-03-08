import type { Plugin, ResolvedConfig } from "vite";
import { build as esbuild } from "esbuild";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
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

  /**
   * Path to the worker registry file to generate, relative to project root.
   * This file exports your worker handles with full type safety for Deno LSP.
   * @default "src/z3-workers.ts"
   */
  registryPath?: string;

  /**
   * List of worker scripts to bundle.
   * Can be an array of source paths (e.g. ["src/solver.ts"])
   * or a mapping of output names to source paths (e.g. { "my-solver": "src/solver.ts" }).
   * Bundled workers will be placed in the public directory.
   */
  workers?: string[] | Record<string, string>;
}

const Z3_FILES = ["z3-built.js", "z3-built.wasm"];
const OPTIONAL_Z3_FILES = ["z3-built.worker.js"];

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
    registryPath = "src/z3-workers.ts",
  } = options;

  let config: ResolvedConfig;
  let z3BuildDir: string;

  function resolveZ3BuildDir(root: string): string {
    // Strategy 1: Standard node_modules
    try {
      const buildDir = join(root, "node_modules", "z3-solver", "build");
      if (existsSync(join(buildDir, "z3-built.js"))) {
        return buildDir;
      }
    } catch { /* fall through */ }

    // Strategy 2: createRequire (Node.js)
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
        for (const file of [...Z3_FILES, ...OPTIONAL_Z3_FILES]) {
          const isOptional = OPTIONAL_Z3_FILES.includes(file);
          const src = join(z3BuildDir, file);
          const target = join(dest, file);
          if (!existsSync(src)) {
            if (!isOptional) {
              console.warn(`[vite-plugin-z3] Missing required file: ${src}`);
            }
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

        // 3. Bundle custom workers
        const workersMap = options.workers
          ? (Array.isArray(options.workers)
            ? Object.fromEntries(
              options.workers.map((src) => [
                src.split("/").pop()?.replace(/\.(ts|js)$/, "") || "worker",
                src,
              ]),
            )
            : options.workers)
          : {};

        for (const [name, srcPath] of Object.entries(workersMap)) {
          const fullSrcPath = join(root, srcPath);
          const workerDest = join(dest, `${name}.js`);

          if (!existsSync(fullSrcPath)) {
            if (generateExample) {
              const srcDir = dirname(fullSrcPath);
              if (!existsSync(srcDir)) {
                mkdirSync(srcDir, { recursive: true });
              }
              const isTS = fullSrcPath.endsWith(".ts");
              writeFileSync(fullSrcPath, generateExampleWorkerSource(isTS));
              console.log(
                `[vite-plugin-z3] Generated ${srcPath} — edit this with your own Z3 constraints!`,
              );
            } else {
              console.warn(
                `[vite-plugin-z3] Worker source not found: ${fullSrcPath}`,
              );
              continue;
            }
          }

          if (
            !existsSync(workerDest) || needsUpdate(fullSrcPath, workerDest)
          ) {
            await bundleWorker(fullSrcPath, workerDest, base);
          }
        }

        // 3.5 Generate registry file (replaces virtual module for better LSP support)
        if (Object.keys(workersMap).length > 0) {
          const fullRegistryPath = join(root, registryPath);
          const registryDir = dirname(fullRegistryPath);
          if (!existsSync(registryDir)) {
            mkdirSync(registryDir, { recursive: true });
          }

          const registryContent = generateVirtualModule(
            base,
            Object.keys(workersMap),
          );

          if (
            !existsSync(fullRegistryPath) ||
            statSync(fullRegistryPath).size !== registryContent.length
          ) {
            writeFileSync(fullRegistryPath, registryContent);
            console.log(
              `[vite-plugin-z3] Generated worker registry: ${registryPath}`,
            );
          }
        }

        // 4. Generate example solver worker (if no workers were specified)
        if (generateExample && Object.keys(workersMap).length === 0) {
          const srcDir = join(root, "src");
          const tsExamplePath = join(srcDir, "z3-worker.ts");
          if (existsSync(srcDir) && !existsSync(tsExamplePath)) {
            writeFileSync(tsExamplePath, generateExampleWorkerSource(true));
            console.log(
              "[vite-plugin-z3] Generated src/z3-worker.ts — add this to your z3Plugin workers option!",
            );
          }
        }
      },
    },

    // Plugin 3: Virtual modules for workers
    {
      name: "vite-plugin-z3:workers",

      resolveId(id) {
        if (id === "z3:workers") return "\0z3:workers";
      },

      load(id) {
        if (id === "\0z3:workers") {
          const workers = options.workers
            ? (Array.isArray(options.workers)
              ? options.workers.map((src) =>
                src.split("/").pop()?.replace(/\.(ts|js)$/, "") || "worker"
              )
              : Object.keys(options.workers))
            : [];

          return generateVirtualModule(base, workers);
        }
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
 * Bundle a user's Z3 worker (TS or JS) into a single script.
 * Injects Z3 initialization boilerplate automatically.
 */
async function bundleWorker(
  srcPath: string,
  outputPath: string,
  base: string,
): Promise<void> {
  const b = base.endsWith("/") ? base : base + "/";
  // The boilerplate loads Z3 and sets up the bridge to the user's solve function.
  // Using an IIFE format so it's a valid script file for new Worker().
  const entryCode = `
    globalThis.__filename = new URL("${b}z3-built.js", self.location.href).href;
    importScripts("${b}z3-built.js");
    globalThis.global = globalThis;
    globalThis.global.initZ3 = globalThis.initZ3;
    importScripts("${b}z3-wrapper.js");

    let _z3 = null;
    async function getZ3() {
      if (_z3) return _z3;
      _z3 = await globalThis.z3Init();
      return _z3;
    }

    self.postMessage({ type: "z3:ready" });

    import * as UserSolver from "${srcPath.replace(/\\/g, "/")}";

    self.onmessage = async (e) => {
      try {
        const z3 = await getZ3();
        // Support both default export and named 'solve' export
        const solveFn = UserSolver.solve;
        if (typeof solveFn !== "function") {
          throw new Error("Worker must export a 'solve' function or have a default export.");
        }
        const result = await solveFn(z3, e.data);
        self.postMessage({ ok: true, result });
      } catch (err) {
        self.postMessage({ ok: false, error: String(err) });
      }
    };
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
    console.log(`[vite-plugin-z3] Bundled worker: ${outputPath}`);
  } catch (err) {
    console.error(`[vite-plugin-z3] Failed to bundle worker ${srcPath}:`, err);
  } finally {
    try {
      unlinkSync(entryPath);
    } catch { /* ignore */ }
  }
}

/**
 * Generate an example worker source (to be bundled).
 */
function generateExampleWorkerSource(isTS: boolean): string {
  const comment = isTS ? " (TypeScript)" : "";
  const typesImport = isTS
    ? `\n// Use 'import type' so we don't bundle the whole library (the plugin provides it via the 'z3' argument)\nimport type { Z3HighLevel } from "z3-solver";\n`
    : "";
  const z3Type = isTS ? ": Z3HighLevel" : "";
  const dataType = isTS ? ": any" : "";

  return `/**
 * Z3 Solver Worker${comment}
 *
 * This file is bundled by vite-plugin-z3.
 * ${
    isTS
      ? "We import types from 'z3-solver' for full autocompletion."
      : "The 'z3' argument provides the initialized high-level API."
  }
 */
${typesImport}
/**
 * Your solver logic.
 * @param z3 - The initialized Z3 high-level API instance.
 * @param data - The data sent from the main thread via z3.run(data).
 */
// deno-lint-ignore no-explicit-any
export async function solve(z3${z3Type}, _data${dataType}) {
  const { Solver, Int } = new z3.Context("main");
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
`;
}

/**
 * Generate the virtual:z3 module code.
 */
function generateVirtualModule(base: string, workerNames: string[]): string {
  const b = base.endsWith("/") ? base : base + "/";

  let exports = "";
  for (const name of workerNames) {
    const camelName = toCamelCase(name);
    exports += `
/**
 * Worker handle for '${name}.js'.
 */
export const ${camelName} = {
  /** Public URL to the bundled worker */
  url: "${b}${name}.js",
  /** Run a solve task and terminate immediately */
  run: <T = any>(data: any): Promise<T> => solveWith("${b}${name}.js", data),
  /** Create a long-lived worker instance. Don't forget to .terminate()! */
  create: () => createZ3Worker("${b}${name}.js")
};
`;
  }

  return `/**
 * Generated by vite-plugin-z3.
 * This file provides type-safe handles to your Z3 workers.
 */
import { createZ3Worker, solveWith } from "@sigmasd/vite-plugin-z3/runtime";

${exports.trim()}
`;
}

function toCamelCase(str: string): string {
  return str
    .replace(/[^a-zA-Z0-9]+(.)/g, (_m, chr) => chr.toUpperCase())
    .replace(/^([A-Z])/, (m) => m.toLowerCase());
}

export default z3Plugin;
