# vite-plugin-z3

A Vite plugin that sets up [Z3-solver](https://github.com/Z3Prover/z3) for
browser use with zero manual configuration.

Z3 is a powerful SMT solver. Running it in the browser requires WASM files,
special HTTP headers, and Web Workers. This plugin handles all of that.

## Install

```sh
# Deno
deno add jsr:@sigmasd/vite-plugin-z3
deno add npm:z3-solver

# npm
npx jsr add @sigmasd/vite-plugin-z3
npm install z3-solver
```

## Quick Start

### 1. Add the plugin to `vite.config.ts`

```ts
import { defineConfig } from "vite";
import { z3Plugin } from "@sigmasd/vite-plugin-z3";

export default defineConfig({
  plugins: [
    z3Plugin({
      // Tell the plugin to bundle your worker
      workers: ["src/z3-worker.ts"],
    }),
  ],
});
```

### 2. Start your dev server

```sh
deno task dev   # or: dx vite, npx vite
```

On first run the plugin will:

- Copy Z3 WASM files to your public directory
- **Bundle `z3-wrapper.js`** (the high-level API) via esbuild
- **Generate your worker source** (e.g., `src/z3-worker.ts`) — an example solver
  you can edit
- **Bundle your worker** (e.g., `public/z3-worker.js`) automatically from your
  source
- Inject COOP/COEP headers so `SharedArrayBuffer` works

### 3. Edit your solver

The plugin generates a template for any missing worker source you specify in the
`workers` option. It provides the initialized `z3` instance to your `solve`
function. You get full autocompletion if you import types from `z3-solver`:

```ts
import type { Z3HighLevel } from "z3-solver";

export async function solve(z3: Z3HighLevel, data: any) {
  const { Solver, Int } = new z3.Context("main");
  const solver = new Solver();

  // Your constraints here
  const x = Int.const("x");
  solver.add(x.gt(0));
  solver.add(x.lt(100));

  const status = await solver.check();
  if (status === "sat") {
    return { x: Number(solver.model().eval(x).toString()) };
  }
  throw new Error("unsat");
}
```

### 4. Use from your app

The plugin makes it easy to use your workers without remembering file paths. Use
the `z3:workers` namespace to get pre-configured handles:

```ts
import { isZ3Supported } from "@sigmasd/vite-plugin-z3/runtime";
import { z3Worker } from "z3:workers";

if (!isZ3Supported()) {
  alert("Your browser doesn't support Z3 (needs SharedArrayBuffer)");
}

// Option A: One-shot solve (creates worker, runs, terminates)
const result = await z3Worker.run(myData);

// Option B: Long-lived worker (keep Z3 in memory for multiple calls)
const handle = await z3Worker.create();
const r1 = await handle.run(d1);
const r2 = await handle.run(d2);
handle.terminate();
```

## Options

```ts
z3Plugin({
  // List of worker scripts to bundle.
  // Can be an array ["src/solver.ts"] or a map { "my-solver": "src/solver.ts" }.
  workers: ["src/z3-worker.ts"],

  // Directory for Z3 static files (default: auto-detected — "static" or "public")
  publicDir: "public",

  // URL base path (default: "/")
  base: "/",

  // COEP header mode (default: "credentialless")
  // "credentialless" - allows cross-origin resources (images, fonts)
  // "require-corp" - stricter, blocks cross-origin without CORS
  coep: "credentialless",

  // Auto-inject COOP/COEP headers in dev server (default: true)
  // Set to false if your reverse proxy handles this
  crossOriginIsolation: true,

  // Generate example solver worker on first run (default: true)
  generateExample: true,
});
```

## How It Works

### Architecture

```
Main Thread                          Web Worker (Bundled)
───────────                          ────────────────────
new Worker("/z3-worker.js")
  │                                  ├─ importScripts("z3-built.js")
  │                                  ├─ importScripts("z3-wrapper.js")
  │                                  ├─ User's TS/JS logic (bundled)
  │                                  └─ postMessage({ type: "z3:ready" })
  │
  ├── postMessage(data) ──────────►  self.onmessage = async (e) => {
  │                                    const result = await solve(z3, e.data);
  │   ◄── result ◄────────────────     self.postMessage({ ok: true, result });
  │                                  }
  └── worker.terminate()
```

### Why a Web Worker?

Z3's WASM build uses **pthreads** (implemented as sub-workers). On the main
thread, this deadlocks because:

1. Main thread calls `solver.check()` and blocks
2. Z3's pthread sub-workers try to synchronize back to the main thread
3. Deadlock — main thread is blocked, can't process sub-worker messages

In a dedicated Worker, this works because the Worker's event loop is free to
process pthread messages while the solver runs.

### Static Files

| File                 | Size    | Purpose                                                 |
| -------------------- | ------- | ------------------------------------------------------- |
| `z3-built.wasm`      | ~33 MB  | Z3 solver compiled to WebAssembly                       |
| `z3-built.js`        | ~345 KB | Emscripten glue code, sets `globalThis.initZ3`          |
| `z3-built.worker.js` | ~8 KB   | (Legacy) Emscripten pthread worker template             |
| `z3-wrapper.js`      | ~266 KB | Bundled z3-solver high-level API (auto-built by plugin) |
| `[your-worker].js`   | ~2 KB   | Your bundled worker (generated from your TS/JS source)  |

### Required HTTP Headers

SharedArrayBuffer requires cross-origin isolation:

```
Cross-Origin-Opener-Policy: same-origin
Cross-Origin-Embedder-Policy: credentialless
```

The plugin injects these automatically in the Vite dev server. For
**production**, configure your web server/CDN:

**Nginx:**

```nginx
add_header Cross-Origin-Opener-Policy "same-origin" always;
add_header Cross-Origin-Embedder-Policy "credentialless" always;
```

**Cloudflare Pages (`_headers`):**

```
/*
  Cross-Origin-Opener-Policy: same-origin
  Cross-Origin-Embedder-Policy: credentialless
```

**Vercel (`vercel.json`):**

```json
{
  "headers": [
    {
      "source": "/(.*)",
      "headers": [
        { "key": "Cross-Origin-Opener-Policy", "value": "same-origin" },
        { "key": "Cross-Origin-Embedder-Policy", "value": "credentialless" }
      ]
    }
  ]
}
```

## License

MIT
