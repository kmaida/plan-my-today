import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["src/index.ts"],
  outDir: "dist",
  format: ["cjs"],
  target: "es2020",
  platform: "node",

  // Tree-shake dead code, minify for production
  treeshake: true,
  minify: true,

  // No declarations or source maps in production
  dts: false,
  sourcemap: false,

  // Clean dist/ before building
  clean: true,

  // Keep these as external require() calls (not bundled):
  // - express: middleware chaining relies on module identity
  // - @keycardlabs/mcp-oauth: local tgz with dual CJS/ESM exports
  // - @modelcontextprotocol/sdk: deep path imports (/server/mcp.js etc.)
  // - dotenv: reads .env files at runtime relative to cwd
  // - zod: runtime schema builders, large but necessary
  external: [
    "express",
    /^@keycardlabs\/.*/,
    /^@modelcontextprotocol\/.*/,
    "dotenv",
    "zod",
  ],

  // Resolve @/* path aliases so tsconfig-paths isn't needed at runtime
  esbuildOptions(options) {
    options.alias = {
      "@": "./src",
    };
  },
});
