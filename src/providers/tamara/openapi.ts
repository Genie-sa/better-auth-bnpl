export interface paths {
	"/checkout": {
		parameters: {
			query?: never;
			header?: never;
			path?: never;
			cookie?: never;
		};
		get?: never;
		put?: never;
		post: operations["createCheckoutSession"];
		delete?: never;
		options?: never;
		head?: never;
		patch?: never;
		trace?: never;
	};
	"/orders/{order_id}": {
		parameters: {
			query?: never;
			header?: never;
			path: {
				order_id: string;
			};
			cookie?: never;
		};
		get: operations["getOrderDetails"];
		put?: never;
		post?: never;
		delete?: never;
		options?: never;
		head?: never;
		patch?: never;
		trace?: never;
	};
	"/orders/{order_id}/authorise": {
		parameters: {
			query?: never;
			header?: never;
			path: {
				order_id: string;
			};
			cookie?: never;
		};
		get?: never;
		put?: never;
		post: operations["authoriseOrder"];
		delete?: never;
		options?: never;
		head?: never;
		patch?: never;
		trace?: never;
	};
	"/payments/capture": {
		parameters: {
			query?: never;
			header?: never;
			path?: never;
			cookie?: never;
		};
		get?: never;
		put?: never;
		post: operations["captureOrder"];
		delete?: never;
		options?: never;
		head?: never;
		patch?: never;
		trace?: never;
	};
	"/orders/{order_id}/cancel": {
		parameters: {
			query?: never;
			header?: never;
			path: {
				order_id: string;
			};
			cookie?: never;
		};
		get?: never;
		put?: never;
		post: operations["cancelOrder"];
		delete?: never;
		options?: never;
		head?: never;
		patch?: never;
		trace?: never;
	};
	"/payments/simplified-refund/{order_id}": {
		parameters: {
			query?: never;
			header?: never;
			path: {
				order_id: string;
			};
			cookie?: never;
		};
		get?: never;
		put?: never;
		post: operations["simplifiedRefund"];
		delete?: never;
		options?: never;
		head?: never;
		patch?: never;
		trace?: never;
	};
	"/checkout/{checkout_id}/void": {
		parameters: {
			query?: never;
			header?: never;
			path: {
				checkout_id: string;
			};
			cookie?: never;
		};
		get?: never;
		put?: never;
		post: operations["voidCheckoutSession"];
		delete?: never;
		options?: never;
		head?: never;
		patch?: never;
		trace?: never;
	};
	"/orders/{order_id}/reference-id": {
		parameters: {
			query?: never;
			header?: never;
			path: {
				order_id: string;
			};
			cookie?: never;
		};
		get?: never;
		put: operations["updateOrderReferenceId"];
		post?: never;
		delete?: never;
		options?: never;
		head?: never;
		patch?: never;
		trace?: never;
	};
	"/pre-checkout/v1/eligibility": {
		parameters: {
			query?: never;
			header?: never;
			path?: never;
			cookie?: never;
		};
		get?: never;
		put?: never;
		post: operations["post_pre-checkout-v1-eligibility"];
		delete?: never;
		options?: never;
		head?: never;
		patch?: never;
		trace?: never;
	};
}
export type webhooks = Record<string, never>;
export interface components {
	schemas: never;
	responses: never;
	parameters: never;
	requestBodies: never;
	headers: never;
	pathItems: never;
}
export type $defs = Record<string, never>;
export interface operations {
	createCheckoutSession: {
		parameters: {
			query?: never;
			header?: never;
			path?: never;
			cookie?: never;
		};
		requestBody?: {
			content: {
				"application/json": {
					total_amount: {
						amount?: number;
						currency?: "SAR" | "AED" | "BHD" | "KWD" | "OMR";
					};
					shipping_amount: {
						amount?: string;
						currency?: "SAR" | "AED" | "BHD" | "KWD" | "OMR";
					};
					tax_amount: {
						amount?: string;
						currency?: "SAR" | "AED" | "BHD" | "KWD" | "OMR";
					};
					order_reference_id: string;
					order_number?: string;
					discount?: {
						name: string;
						amount: {
							amount?: number;
							currency?: "SAR" | "AED" | "BHD" | "KWD" | "OMR";
						};
					};
					items: {
						name: string;
						quantity: number;
						reference_id: string;
						type: string;
						sku: string;
						item_url?: string;
						image_url?: string;
						unit_price?: {
							amount?: number;
							currency?: "SAR" | "AED" | "BHD" | "KWD" | "OMR";
						};
						tax_amount?: {
							amount?: number;
							currency?: "SAR" | "AED" | "BHD" | "KWD" | "OMR";
						};
						discount_amount?: {
							amount?: number;
							currency?: "SAR" | "AED" | "BHD" | "KWD" | "OMR";
						};
						total_amount: {
							amount?: string;
							currency?: "SAR" | "AED" | "BHD" | "KWD" | "OMR";
						};
					}[];
					consumer: {
						email?: string;
						first_name: string;
						last_name: string;
						phone_number: string;
					};
					country_code: "SA" | "AE" | "BH" | "KW" | "OM";
					description: string;
					merchant_url: {
						cancel: string;
						failure: string;
						success: string;
					};
					billing_address?: {
						city?: string;
						country_code?: "SA" | "AE" | "BH" | "KW" | "OM";
						first_name?: string;
						last_name?: string;
						line1?: string;
						line2?: string;
						phone_number?: string;
						region?: string;
					};
					shipping_address: {
						city: string;
						country_code: "SA" | "AE" | "BH" | "KW" | "OM";
						first_name: string;
						last_name: string;
						line1: string;
						line2?: string;
						phone_number?: string;
						region?: string;
					};
					platform?: string;
					is_mobile?: boolean;
					locale?: "ar_SA" | "en_US";
					risk_assessment?: {
						customer_age?: number;
						customer_dob?: string;
						customer_gender?: "Male" | "Female";
						customer_nationality?: string;
						is_premium_customer?: boolean;
						is_existing_customer?: boolean;
						is_guest_user?: boolean;
						account_creation_date?: string;
						platform_account_creation_date?: string;
						date_of_first_transaction?: string;
						is_card_on_file?: boolean;
						is_COD_customer?: boolean;
						has_delivered_order?: boolean;
						is_phone_verified?: boolean;
						is_fraudulent_customer?: boolean;
						total_ltv?: number;
						total_order_count?: number;
						order_amount_last3months?: number;
						order_count_last3months?: number;
						last_order_date?: string;
						last_order_amount?: number;
						reward_program_enrolled?: boolean;
						reward_program_points?: number;
					};
					expires_in_minutes?: number;
					additional_data?: {
						delivery_method?: string;
						pickup_store?: string;
						store_code?: string;
						vendor_amount?: number;
						merchant_settlement_amount?: number;
						vendor_reference_code?: string;
					};
				};
			};
		};
		responses: {
			200: {
				headers: {
					[name: string]: unknown;
				};
				content: {
					"application/json": {
						checkout_id?: string;
						order_id?: string;
						status?: string;
						checkout_url?: string;
					};
				};
			};
			400: {
				headers: {
					[name: string]: unknown;
				};
				content: {
					"application/json": unknown;
				};
			};
		};
	};
	getOrderDetails: {
		parameters: {
			query?: never;
			header?: never;
			path: {
				order_id: string;
			};
			cookie?: never;
		};
		requestBody?: never;
		responses: {
			200: {
				headers: {
					[name: string]: unknown;
				};
				content: {
					"application/json": unknown;
				};
			};
		};
	};
	authoriseOrder: {
		parameters: {
			query?: never;
			header?: never;
			path: {
				order_id: string;
			};
			cookie?: never;
		};
		requestBody?: never;
		responses: {
			200: {
				headers: {
					[name: string]: unknown;
				};
				content: {
					"application/json": {
						order_id?: string;
						status?: string;
						order_expiry_time?: string;
						payment_type?: "PAY_BY_INSTALMENTS" | "PAY_NOW";
						auto_captured?: boolean;
						authorized_amount?: {
							amount?: number;
							currency?: "SAR" | "AED" | "KWD" | "BHD" | "OMR";
						}[];
						capture_id?: string;
					};
				};
			};
		};
	};
	captureOrder: {
		parameters: {
			query?: never;
			header?: never;
			path?: never;
			cookie?: never;
		};
		requestBody?: {
			content: {
				"application/json": {
					order_id: string;
					total_amount: {
						amount?: number;
						currency?: "SAR" | "AED" | "BHD" | "KWD" | "OMR";
					};
					shipping_info: {
						shipped_at: string;
						shipping_company: string;
						tracking_number?: string;
						tracking_url?: string;
					};
					items?: {
						name: string;
						quantity: number;
						reference_id: string;
						sku: string;
						item_url?: string;
						image_url?: string;
						unit_price?: {
							amount?: number;
							currency?: "SAR" | "AED" | "BHD" | "KWD" | "OMR";
						};
						tax_amount?: {
							amount?: number;
							currency?: "SAR" | "AED" | "BHD" | "KWD" | "OMR";
						};
						discount_amount?: {
							amount?: number;
							currency?: "SAR" | "AED" | "BHD" | "KWD" | "OMR";
						};
						total_amount: {
							amount?: string;
							currency?: "SAR" | "AED" | "BHD" | "KWD" | "OMR";
						};
						type: string;
					}[];
					discount_amount?: {
						amount?: string;
						currency?: "SAR" | "AED" | "BHD" | "KWD" | "OMR";
					};
					shipping_amount?: {
						amount?: number;
						currency?: "SAR" | "AED" | "BHD" | "KWD" | "OMR";
					};
					tax_amount?: {
						amount?: number;
						currency?: "SAR" | "AED" | "BHD" | "KWD" | "OMR";
					};
				};
			};
		};
		responses: {
			200: {
				headers: {
					[name: string]: unknown;
				};
				content: {
					"application/json": {
						capture_id?: string;
						order_id?: string;
						status?: "fully_captured" | "partially_captured";
						captured_amount?: unknown;
					};
				};
			};
		};
	};
	cancelOrder: {
		parameters: {
			query?: never;
			header?: never;
			path: {
				order_id: string;
			};
			cookie?: never;
		};
		requestBody?: {
			content: {
				"application/json": {
					total_amount: {
						amount?: number;
						currency?: "SAR" | "AED" | "BHD" | "KWD" | "OMR";
					};
					shipping_amount?: {
						amount?: number;
						currency?: "SAR" | "AED" | "BHD" | "KWD" | "OMR";
					};
					tax_amount?: {
						amount?: number;
						currency?: "SAR" | "AED" | "BHD" | "KWD" | "OMR";
					};
					discount_amount?: {
						amount?: number;
						currency?: "SAR" | "AED" | "BHD" | "KWD" | "OMR";
					};
					items?: {
						name: string;
						quantity: number;
						reference_id: string;
						sku: string;
						item_url?: string;
						image_url?: string;
						unit_price?: {
							amount?: number;
							currency?: "SAR" | "AED" | "BHD" | "KWD" | "OMR";
						};
						tax_amount?: {
							amount?: number;
							currency?: "SAR" | "AED" | "BHD" | "KWD" | "OMR";
						};
						discount_amount?: {
							amount?: number;
							currency?: "SAR" | "AED" | "BHD" | "KWD" | "OMR";
						};
						total_amount: {
							amount?: string;
							currency?: "SAR" | "AED" | "BHD" | "KWD" | "OMR";
						};
						type: string;
					}[];
				};
			};
		};
		responses: {
			200: {
				headers: {
					[name: string]: unknown;
				};
				content: {
					"application/json": {
						cancel_id?: string;
						order_id?: string;
						status?: "updated" | "canceled";
						canceled_amount?: unknown;
					};
				};
			};
			409: {
				headers: {
					[name: string]: unknown;
				};
				content: {
					"application/json": unknown;
				};
			};
		};
	};
	simplifiedRefund: {
		parameters: {
			query?: never;
			header?: never;
			path: {
				order_id: string;
			};
			cookie?: never;
		};
		requestBody?: {
			content: {
				"application/json": {
					total_amount: {
						amount?: number;
						currency?: "SAR" | "AED" | "BHD" | "KWD" | "OMR";
					};
					comment: string;
					merchant_refund_id?: string;
				};
			};
		};
		responses: {
			200: {
				headers: {
					[name: string]: unknown;
				};
				content: {
					"application/json": {
						order_id?: string;
						comment?: string;
						refund_id?: string;
						capture_id?: string;
						status?: "fully_refunded" | "partially_refunded";
						refunded_amount?: unknown;
					};
				};
			};
		};
	};
	voidCheckoutSession: {
		parameters: {
			query: {
				order_id: string;
				store_code?: string;
			};
			header?: never;
			path: {
				checkout_id: string;
			};
			cookie?: never;
		};
		requestBody?: never;
		responses: {
			200: {
				headers: {
					[name: string]: unknown;
				};
				content: {
					"application/json": {
						order_was_voided?: boolean;
						captured_amount?: {
							amount?: number;
							currency?: "SAR" | "AED" | "KWD" | "BHD" | "OMR";
							message?: string;
							store_code?: string;
						}[];
					};
				};
			};
		};
	};
	updateOrderReferenceId: {
		parameters: {
			query?: never;
			header?: never;
			path: {
				order_id: string;
			};
			cookie?: never;
		};
		requestBody?: {
			content: {
				"application/json": {
					order_reference_id: string;
				};
			};
		};
		responses: {
			200: {
				headers: {
					[name: string]: unknown;
				};
				content: {
					"application/json": {
						message?: string;
					};
				};
			};
		};
	};
	"post_pre-checkout-v1-eligibility": {
		parameters: {
			query?: never;
			header?: never;
			path?: never;
			cookie?: never;
		};
		requestBody?: {
			content: {
				"application/json": {
					order: {
						amount?: number;
						currency?: "SAR" | "AED" | "BHD" | "KWD" | "OMR";
					};
					customer: {
						phone?: string;
					};
				};
			};
		};
		responses: {
			200: {
				headers: {
					[name: string]: unknown;
				};
				content: {
					"application/json": {
						is_eligible: boolean;
					};
				};
			};
			400: {
				headers: {
					[name: string]: unknown;
				};
				content: {
					"application/json": {
						message: string;
					};
				};
			};
		};
	};
}
