type OpenApiJsonContent<T> = T extends {
	content: {
		"application/json": infer Body;
	};
}
	? Body
	: never;
export type OpenApiJsonRequestBody<Operation> = Operation extends {
	requestBody?: infer RequestBody;
}
	? OpenApiJsonContent<NonNullable<RequestBody>>
	: never;
export type OpenApiJsonResponseBody<Operation, Status extends number = 200> = Operation extends {
	responses: infer Responses;
}
	? Status extends keyof Responses
		? OpenApiJsonContent<Responses[Status]>
		: never
	: never;
