import { defineConfig } from "vitest/config";
import ts from "typescript";

// Vitest 4 uses rolldown's parser, which treats `.cts` files as plain
// JavaScript and does not strip TypeScript syntax (e.g. `import type`,
// `type X = ...`, `as Foo`). The preload is authored as `.cts` because
// Electron's sandboxed preload runtime cannot load ES modules. To let
// the preload spec dynamic-import the source while keeping the
// authored syntax, transpile `.cts` files through the installed
// `typescript` package before rolldown sees them.
export default defineConfig({
  plugins: [
    {
      name: "nimbus-cts-transform",
      enforce: "pre",
      transform(code, id) {
        if (!id.endsWith(".cts")) return null;
        const out = ts.transpileModule(code, {
          compilerOptions: {
            module: ts.ModuleKind.CommonJS,
            target: ts.ScriptTarget.ES2022,
            esModuleInterop: true,
            sourceMap: true,
          },
          fileName: id,
        });
        return { code: out.outputText, map: out.sourceMapText ?? null };
      },
    },
  ],
  test: {
    include: ["src/**/*.spec.ts", "tests/**/*.spec.ts"],
    exclude: ["node_modules/**", "dist/**", "tests/e2e/**"],
    environment: "node",
    // Multiple spec files import the `electron` package, which on
    // first require triggers `node_modules/electron/install.js` to
    // unpack the platform binary. Running specs in parallel forks
    // races that extract step and surfaces as
    // `EEXIST: file already exists, symlink ...
    // Versions/Current/Electron Framework` on macOS CI. Pin a single
    // file at a time so the extract happens at most once per run.
    // Vitest 4 lifted `fileParallelism` to a top-level option (see
    // its migration guide); the prior `poolOptions.forks.singleFork`
    // shape was removed.
    fileParallelism: false,
  },
});
