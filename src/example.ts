// Example: How to use vite-plugin-z3 in your project
//
// vite.config.ts:
//
//   import { z3Plugin } from "@sigmasd/vite-plugin-z3";
//   export default defineConfig({
//     plugins: [z3Plugin(), fresh(), tailwindcss()],
//   });
//
// public/my-solver.js:
//
//   importScripts("/z3-worker-bootstrap.js");
//
//   self.onmessage = async (e) => {
//     const z3 = await getZ3();
//     const { Solver, Int } = new z3.Context("main");
//     // ... your constraints ...
//     self.postMessage({ ok: true, result });
//   };
//
// Your app code:
//
//   import { createZ3Worker } from "@sigmasd/vite-plugin-z3/runtime";
//   const z3 = await createZ3Worker("/my-solver.js");
//   const result = await z3.run(data);
