import { defineConfig } from "tsup";

export default defineConfig({
	entry: [
		"src/index.ts",
		"src/client.ts",
		"src/server-client.ts",
		"src/providers/tamara/index.ts",
		"src/providers/tabby/index.ts",
	],
	format: ["esm", "cjs"],
	dts: true,
	clean: true,
	sourcemap: true,
	splitting: false,
	treeshake: true,
	target: "node18",
});
