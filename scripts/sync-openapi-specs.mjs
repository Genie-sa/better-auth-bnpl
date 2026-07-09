import { mkdir, writeFile } from "node:fs/promises";

const SPEC_DIR = new URL("../openapi/", import.meta.url);

const TABBY_SPEC_URL = "https://docs.tabby.ai/openapi.yaml";

const TAMARA_REFERENCE_PAGES = [
	"createcheckoutsession",
	"getorderdetails",
	"authoriseorder",
	"captureorder",
	"cancelorder",
	"simplifiedrefund",
	"voidcheckoutsession",
	"updateorderreferenceid",
	"pre-checkout-eligibility",
].map((slug) => `https://docs.tamara.co/reference/${slug}.md`);

async function fetchText(url) {
	const response = await fetch(url);
	if (!response.ok) {
		throw new Error(`Failed to fetch ${url}: ${response.status} ${response.statusText}`);
	}
	return response.text();
}

function extractOpenApiJson(markdown, url) {
	const match = markdown.match(/# OpenAPI definition[\s\S]*?```json\s*([\s\S]*?)\s*```/);
	if (!match?.[1]) {
		throw new Error(`Could not find OpenAPI JSON block in ${url}`);
	}
	return JSON.parse(match[1]);
}

function mergeComponents(target, source) {
	if (!source) return;
	for (const [sectionName, sectionValue] of Object.entries(source)) {
		if (!sectionValue || typeof sectionValue !== "object" || Array.isArray(sectionValue)) continue;
		const targetSection = target[sectionName] ?? {};
		target[sectionName] = targetSection;
		for (const [key, value] of Object.entries(sectionValue)) {
			targetSection[key] = value;
		}
	}
}

function mergeTamaraSpecs(specs) {
	const first = specs[0];
	if (!first) throw new Error("Tamara spec list is empty");

	const merged = {
		openapi: "3.0.3",
		info: first.info,
		servers: first.servers,
		components: {},
		security: first.security,
		paths: {},
		tags: [],
	};

	const tagsByName = new Map();
	for (const spec of specs) {
		mergeComponents(merged.components, spec.components);
		for (const [path, pathItem] of Object.entries(spec.paths ?? {})) {
			if (merged.paths[path] !== undefined) {
				throw new Error(`Duplicate Tamara path while merging OpenAPI specs: ${path}`);
			}
			merged.paths[path] = pathItem;
		}
		for (const tag of spec.tags ?? []) {
			if (tag?.name && !tagsByName.has(tag.name)) {
				tagsByName.set(tag.name, tag);
			}
		}
	}

	merged.tags = [...tagsByName.values()];
	return merged;
}

await mkdir(SPEC_DIR, { recursive: true });

const tabbySpec = await fetchText(TABBY_SPEC_URL);
await writeFile(new URL("tabby.openapi.yaml", SPEC_DIR), tabbySpec);

const tamaraSpecs = await Promise.all(
	TAMARA_REFERENCE_PAGES.map(async (url) => extractOpenApiJson(await fetchText(url), url)),
);
const tamaraSpec = mergeTamaraSpecs(tamaraSpecs);
await writeFile(
	new URL("tamara.openapi.json", SPEC_DIR),
	`${JSON.stringify(tamaraSpec, null, 2)}\n`,
);

console.log(
	`Synced OpenAPI specs: Tabby (${TABBY_SPEC_URL}), Tamara (${TAMARA_REFERENCE_PAGES.length} endpoint pages)`,
);
