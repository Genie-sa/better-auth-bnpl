type OpenApiPathKey<TPaths> = Extract<keyof TPaths, string>;
type OpenApiPathParamValue = string | number | boolean;
export type OpenApiPathParamNames<Path extends string> =
	Path extends `${string}{${infer Param}}${infer Rest}`
		? Param | OpenApiPathParamNames<Rest>
		: never;
type ExactOpenApiPathParams<
	Path extends string,
	Params extends Record<string, OpenApiPathParamValue>,
> = Exclude<keyof Params, OpenApiPathParamNames<Path>> extends never
	? Exclude<OpenApiPathParamNames<Path>, keyof Params> extends never
		? Params
		: never
	: never;
function renderOpenApiPath(path: string, params?: Record<string, OpenApiPathParamValue>): string {
	let rendered = path;
	if (params === undefined) return rendered;
	for (const [name, value] of Object.entries(params)) {
		rendered = rendered.replace(`{${name}}`, encodeProviderResourceId(value));
	}
	return rendered;
}
export function encodeProviderResourceId(value: OpenApiPathParamValue): string {
	const id = String(value);
	if (!id.trim() || id === "." || id === "..") {
		throw new Error("bnpl: provider resource ID must be nonempty and cannot be a dot segment");
	}
	return encodeURIComponent(id);
}
export function createOpenApiPathBuilder<TPaths>() {
	return <
		const Path extends OpenApiPathKey<TPaths>,
		const Params extends Record<string, OpenApiPathParamValue>,
	>(
		path: Path,
		...args: [OpenApiPathParamNames<Path>] extends [never]
			? []
			: [params: ExactOpenApiPathParams<Path, Params>]
	): string => renderOpenApiPath(path, args[0]);
}
