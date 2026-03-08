// Example: How to use vite-plugin-z3 with worker handles
//
// vite.config.ts:
//
//   import { z3Plugin } from "@sigmasd/vite-plugin-z3";
//   import { defineConfig } from "vite";
//   export default defineConfig({
//     plugins: [
//       z3Plugin({
//         workers: ["src/z3-worker.ts"]
//       })
//     ],
//   });
//
// App Code:
//
//   import { z3Worker } from "z3:workers";
//
//   // One-shot: creates worker, runs solver once, and terminates worker.
//   // Best for single computations.
//   const result = await z3Worker.run({ some: "data" });
//   console.log("Result:", result);
//
//   // Long-lived: keeps Z3 in memory for multiple calls.
//   // Best for interactive solvers.
//   const handle = await z3Worker.create();
//   const r1 = await handle.run(data1);
//   const r2 = await handle.run(data2);
//   handle.terminate(); // Don't forget to terminate when finished!
