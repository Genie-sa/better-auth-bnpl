export interface paths {
	"/api/v2/checkout": {
		parameters: {
			query?: never;
			header?: never;
			path?: never;
			cookie?: never;
		};
		get?: never;
		put?: never;
		post: operations["postCheckoutSession"];
		delete?: never;
		options?: never;
		head?: never;
		patch?: never;
		trace?: never;
	};
	"/api/v2/checkout/{id}": {
		parameters: {
			query?: never;
			header?: never;
			path?: never;
			cookie?: never;
		};
		get: operations["getCheckoutSession"];
		put?: never;
		post?: never;
		delete?: never;
		options?: never;
		head?: never;
		patch?: never;
		trace?: never;
	};
	"/api/v2/payments/{id}": {
		parameters: {
			query?: never;
			header?: never;
			path?: never;
			cookie?: never;
		};
		get: operations["getPayment"];
		put: operations["putPayment"];
		post?: never;
		delete?: never;
		options?: never;
		head?: never;
		patch?: never;
		trace?: never;
	};
	"/api/v2/payments/{id}/captures": {
		parameters: {
			query?: never;
			header?: never;
			path?: never;
			cookie?: never;
		};
		get?: never;
		put?: never;
		post: operations["postPaymentCapture"];
		delete?: never;
		options?: never;
		head?: never;
		patch?: never;
		trace?: never;
	};
	"/api/v2/payments/{id}/refunds": {
		parameters: {
			query?: never;
			header?: never;
			path?: never;
			cookie?: never;
		};
		get?: never;
		put?: never;
		post: operations["postPaymentRefund"];
		delete?: never;
		options?: never;
		head?: never;
		patch?: never;
		trace?: never;
	};
	"/api/v2/payments/{id}/close": {
		parameters: {
			query?: never;
			header?: never;
			path?: never;
			cookie?: never;
		};
		get?: never;
		put?: never;
		post: operations["closePayment"];
		delete?: never;
		options?: never;
		head?: never;
		patch?: never;
		trace?: never;
	};
	"/api/v2/payments": {
		parameters: {
			query?: never;
			header?: never;
			path?: never;
			cookie?: never;
		};
		get: operations["getPayments"];
		put?: never;
		post?: never;
		delete?: never;
		options?: never;
		head?: never;
		patch?: never;
		trace?: never;
	};
	"/api/v1/webhooks": {
		parameters: {
			query?: never;
			header?: never;
			path?: never;
			cookie?: never;
		};
		get: operations["getWebhooks"];
		put?: never;
		post: operations["postWebhook"];
		delete?: never;
		options?: never;
		head?: never;
		patch?: never;
		trace?: never;
	};
	"/api/v1/webhooks/{id}": {
		parameters: {
			query?: never;
			header?: never;
			path?: never;
			cookie?: never;
		};
		get: operations["getWebhook"];
		put: operations["putWebhook"];
		post?: never;
		delete: operations["deleteWebhook"];
		options?: never;
		head?: never;
		patch?: never;
		trace?: never;
	};
	"/api/v1/disputes": {
		parameters: {
			query?: never;
			header?: never;
			path?: never;
			cookie?: never;
		};
		get: operations["getDisputes"];
		put?: never;
		post?: never;
		delete?: never;
		options?: never;
		head?: never;
		patch?: never;
		trace?: never;
	};
	"/api/v1/disputes/{disputeId}": {
		parameters: {
			query?: never;
			header?: never;
			path?: never;
			cookie?: never;
		};
		get: operations["getDispute"];
		put?: never;
		post?: never;
		delete?: never;
		options?: never;
		head?: never;
		patch?: never;
		trace?: never;
	};
	"/api/v1/disputes/{disputeId}/provide-evidence": {
		parameters: {
			query?: never;
			header?: never;
			path?: never;
			cookie?: never;
		};
		get?: never;
		put?: never;
		post: operations["postDisputeProvideEvidence"];
		delete?: never;
		options?: never;
		head?: never;
		patch?: never;
		trace?: never;
	};
	"/api/v1/disputes/approve": {
		parameters: {
			query?: never;
			header?: never;
			path?: never;
			cookie?: never;
		};
		get?: never;
		put?: never;
		post: operations["postDisputesApprove"];
		delete?: never;
		options?: never;
		head?: never;
		patch?: never;
		trace?: never;
	};
	"/api/v1/disputes/challenge": {
		parameters: {
			query?: never;
			header?: never;
			path?: never;
			cookie?: never;
		};
		get?: never;
		put?: never;
		post: operations["postDisputesChallenge"];
		delete?: never;
		options?: never;
		head?: never;
		patch?: never;
		trace?: never;
	};
	"/api/v1/disputes/attachments/upload": {
		parameters: {
			query?: never;
			header?: never;
			path?: never;
			cookie?: never;
		};
		get?: never;
		put?: never;
		post: operations["postUploadAttachment"];
		delete?: never;
		options?: never;
		head?: never;
		patch?: never;
		trace?: never;
	};
}
export type webhooks = Record<string, never>;
export interface components {
	schemas: {
		Attachment_V1: {
			body: {
				flight_reservation_details?: components["schemas"]["FlightReservationDetails"];
				hotel_reservation_details?: components["schemas"]["HotelReservationDetails"];
				insurance_details?: components["schemas"]["InsuranceDetails"];
				payment_history_full?: components["schemas"]["AttachmentPaymentHistoryFull"];
				payment_history_simple?: components["schemas"]["AttachmentPaymentHistorySimple"];
				flight_points_simple?: components["schemas"]["FlightPointsSimple"];
				marketplaces?: components["schemas"]["Marketplaces"];
				education_details?: components["schemas"]["EducationDetails"];
			};
			content_type: string;
		} | null;
		AttachmentPaymentHistoryFull: {
			unique_account_identifier?: string;
			payment_option?: "card" | "direct banking" | "cod" | "other";
			number_paid_purchases?: number;
			total_amount_paid_purchases?: number;
			date_of_last_paid_purchase?: string;
			date_of_first_paid_purchase?: string;
			count_paid_purchases_last_month?: number;
			amount_paid_purchases_last_month?: number;
			max_paid_amount_for_1purchase?: number;
		};
		AttachmentPaymentHistorySimple: {
			unique_account_identifier?: string;
			paid_before_flag?: boolean;
			date_of_last_paid_purchase?: string;
			date_of_first_paid_purchase?: string;
		};
		EducationDetails: {
			merchant_subtype: "formal_education" | "courses_training";
			program: {
				payment_tenure_months: number;
				months_to_completion: number;
			};
			student_history: {
				late_payments_count: number;
				avg_overdue_duration_days: number;
				observation_window_months?: number;
			};
		};
		Buyer: {
			name: string;
			email: string;
			phone: string;
			dob?: string;
		};
		BuyerHistory: {
			registered_since: string;
			loyalty_level: number;
			wishlist_count: number;
			is_social_networks_connected?: boolean;
			is_phone_number_verified?: boolean;
			is_email_verified?: boolean;
		};
		BuyerHistoryResponse: {
			registered_since: string;
			loyalty_level: number;
			wishlist_count: number;
			is_social_networks_connected?: boolean | null;
			is_phone_number_verified?: boolean | null;
			is_email_verified?: boolean | null;
		};
		BuyerResponse: {
			name: string | null;
			email: string | null;
			phone: string | null;
			dob?: string | null;
		} | null;
		CaptureRequest: {
			amount: components["schemas"]["PaymentAmount"];
			reference_id: string;
			tax_amount: string;
			shipping_amount: string;
			discount_amount: string;
			items?: components["schemas"]["OrderItem"][];
		};
		CaptureResponse: {
			readonly id?: string;
			created_at?: string;
			amount: components["schemas"]["PaymentAmount"];
			tax_amount: string;
			shipping_amount: string;
			discount_amount: string;
			items?: components["schemas"]["OrderItemResponse"][] | null;
			reference_id: string | null;
		};
		CheckoutConfigurationProduct:
			| {
					readonly web_url?: string | null;
					readonly qr_code?: string | null;
			  }[]
			| null;
		CheckoutCreation: {
			amount: components["schemas"]["PaymentAmount"];
			currency: components["schemas"]["Currency"];
			description?: string;
			buyer: components["schemas"]["Buyer"];
			shipping_address: components["schemas"]["ShippingAddress"];
			order: components["schemas"]["Order"];
			buyer_history: components["schemas"]["BuyerHistory"];
			order_history: components["schemas"]["CheckoutCreationOrderHistory"][];
			meta?: components["schemas"]["Meta"];
			attachment?: components["schemas"]["Attachment_V1"];
		};
		CheckoutCreationOrderHistory: {
			purchased_at: string;
			amount: components["schemas"]["PaymentAmount"];
			payment_method?: "card" | "cod";
			status: "new" | "processing" | "complete" | "refunded" | "canceled" | "unknown";
			buyer: components["schemas"]["Buyer"];
			shipping_address: components["schemas"]["ShippingAddress"];
			items?: components["schemas"]["OrderItemHistoryRequest"][];
		};
		CheckoutProduct: {
			readonly type: "installments";
			readonly is_available: boolean;
			rejection_reason?: components["schemas"]["CheckoutProductRejectionReason"];
		};
		CheckoutProductRejectionReason:
			| "order_amount_too_high"
			| "order_amount_too_low"
			| "not_available"
			| "null"
			| null;
		CheckoutResponsePayment: {
			id?: components["schemas"]["PaymentID"];
			created_at?: components["schemas"]["PaymentCreatedAt"];
			status?: components["schemas"]["PaymentStatus"];
			readonly is_test?: boolean;
			amount: components["schemas"]["PaymentAmount"];
			currency: components["schemas"]["Currency"];
			description?: string | null;
			order: components["schemas"]["OrderResponse"];
			meta?: components["schemas"]["Meta"];
			attachment?: components["schemas"]["Attachment_V1"];
		};
		CheckoutSession: {
			readonly id?: string;
			configuration?: {
				available_products?: {
					installments?: components["schemas"]["CheckoutConfigurationProduct"];
				} | null;
				products?: {
					installments?: components["schemas"]["CheckoutProduct"];
				};
			};
			token?: string | null;
			payment?: components["schemas"]["CheckoutResponsePayment"];
			readonly status?: "created" | "rejected" | "expired" | "approved";
			merchant_urls?: {
				success?: string | null;
				cancel?: string | null;
				failure?: string | null;
			};
		};
		Currency: "AED" | "SAR" | "KWD";
		Dispute: {
			id: components["schemas"]["DisputeID"];
			attachments: components["schemas"]["DisputeAttachments"];
			payment_id: components["schemas"]["PaymentID"];
			amount: string;
			currency: components["schemas"]["Currency"];
			created_at: components["schemas"]["DisputeCreatedAt"];
			expired_at: components["schemas"]["DisputeExpiredAt"];
			status: components["schemas"]["DisputeStatus"];
			reason: components["schemas"]["DisputeReason"];
			days_left: components["schemas"]["DisputeDaysLeft"];
			history: components["schemas"]["DisputeHistoryItem"][];
			items: components["schemas"]["DisputeOrderItem"][];
			order_number: string;
			comment: components["schemas"]["DisputeComment"];
		};
		DisputeAttachments: string[] | null;
		DisputeComment: string;
		Evidence: {
			id: string;
			dispute_id: string;
			content: string;
			created_by: string;
			created_at: string;
			attachment_ids?: string[];
		};
		DisputeCreatedAt: string;
		DisputeDaysLeft: number;
		DisputeExpiredAt: string;
		DisputeHistoryItem: {
			attachments: string[];
			created_at: string;
			created_by: string;
			content: string;
			source: "customer" | "merchant" | "tabby-support";
			event_type:
				| "dispute_created"
				| "dispute_approved"
				| "dispute_declined"
				| "dispute_canceled"
				| "dispute_in_arbitration"
				| "dispute_amount_changed"
				| "dispute_comment_added"
				| "evidence_merchant"
				| "evidence_customer"
				| "evidence_merchant_provided"
				| "evidence_customer_provided"
				| "merchant_14d_unresponsive"
				| "customer_14d_unresponsive";
			note?: string;
		};
		DisputeID: string;
		DisputeNoHistory: {
			id: components["schemas"]["DisputeID"];
			attachments: components["schemas"]["DisputeAttachments"];
			payment_id: components["schemas"]["PaymentID"];
			amount: string;
			currency: components["schemas"]["Currency"];
			created_at: components["schemas"]["DisputeCreatedAt"];
			expired_at: components["schemas"]["DisputeExpiredAt"];
			status: components["schemas"]["DisputeStatus"];
			reason: components["schemas"]["DisputeReason"];
			days_left: components["schemas"]["DisputeDaysLeft"];
			items: components["schemas"]["DisputeOrderItem"][];
			order_number: string;
			comment: components["schemas"]["DisputeComment"];
		};
		DisputeOrderItem: {
			reference_id: string;
			title: string;
			unit_price: string;
		};
		DisputeReason: "unreceived_refund" | "identity_theft" | "product_issue" | "not_delivered";
		DisputeStatus:
			| "new"
			| "declined"
			| "cancelled"
			| "refunded"
			| "in_progress"
			| "evidence_merchant"
			| "evidence_customer";
		FlightPointsSimple: {
			origin: {
				air_code: string;
				city_code: string;
			};
			destination: {
				air_code: string;
				city_code: string;
			};
		};
		FlightReservationDetails: {
			pnr?: string;
			itinerary: {
				departure_city?: string;
				departure_country?: string;
				arrival_city?: string;
				arrival_country?: string;
				carrier?: string;
				departure_date?: string;
				class?: string;
				refundable?: boolean;
			}[];
			insurance: {
				insurance_company?: string;
				insurance_type?: string;
				insurance_price?: number;
			}[];
			passengers: {
				full_name?: string;
				first_name?: string;
				last_name?: string;
				dob?: string;
				document_type?: string;
				document_id?: string;
				expiration_id_date?: string;
				nationality?: string;
				gender?: "F" | "M" | "O";
			}[];
			affiliate_name?: string;
		};
		HotelReservationDetails: {
			pnr?: string;
			hotel_itinerary: {
				hotel_name?: string;
				address?: string;
				hotel_city?: string;
				hotel_country?: string;
				start_date?: string;
				end_date?: string;
				number_of_rooms?: number;
				class?: string;
			}[];
			insurance: {
				insurance_company?: string;
				insurance_type?: string;
				insurance_price?: number;
			}[];
			passengers: {
				full_name?: string;
				first_name?: string;
				last_name?: string;
				dob?: string;
				document_type?: string;
				document_id?: string;
				expiration_id_dt?: string;
				nationality?: string;
				gender?: "F" | "M" | "O";
			}[];
			affiliate_name?: string;
		};
		InsuranceDetails: {
			policy_details: {
				insurance_type: string;
				insurance_start_dt: string;
				insurance_end_dt: string;
				insured_amount: string;
				car_details?: {
					manufacturer: string;
					model: string;
					year: string;
				};
				travel_details?: {
					departure_country: string;
					arrival_country: string;
				};
				refundable?: boolean;
				provider_name?: string;
			};
			client: {
				full_name?: string;
				first_name: string;
				last_name: string;
				dob?: string;
				document_type: string;
				document_id?: string;
				expiration_id_dt?: string;
				nationality?: string;
				gender?: unknown;
			};
			payment_history_simple?: {
				unique_account_identifier?: string;
				paid_before_flag?: boolean;
				date_of_last_paid_purchase: string;
				date_of_first_paid_purchase: string;
			};
		};
		LanguageCode: "ar" | "en";
		Marketplaces: {
			seller_id: string;
			seller_name: string;
			seller_category: string;
			seller_website: string;
			seller_phone: string;
			seller_registration_date: string;
			seller_commercial_registration_number: string;
		};
		MerchantUrls: {
			success?: string;
			cancel?: string;
			failure?: string;
		};
		Meta: {
			customer?: string | null;
			order_id?: string | null;
		} | null;
		Order: {
			reference_id: string;
			updated_at?: string;
			tax_amount: string;
			shipping_amount: string;
			discount_amount: string;
			items: components["schemas"]["OrderItem"][];
		};
		OrderHistory: {
			purchased_at: string;
			amount: components["schemas"]["PaymentAmount"];
			payment_method?: "card" | "cod";
			status: "new" | "processing" | "complete" | "refunded" | "canceled" | "unknown";
			buyer: components["schemas"]["Buyer"];
			shipping_address: components["schemas"]["ShippingAddress"];
			items?: components["schemas"]["OrderItemHistoryResponse"][];
		};
		OrderHistoryResponse: {
			purchased_at: string | null;
			amount: components["schemas"]["PaymentAmountResponse"];
			payment_method?: "card" | "cod" | null;
			status: "new" | "processing" | "complete" | "refunded" | "canceled" | "unknown" | null;
			buyer: components["schemas"]["BuyerResponse"];
			shipping_address: components["schemas"]["ShippingAddressResponse"];
			items?: components["schemas"]["OrderItemHistoryResponse"][] | null;
		};
		OrderItem: {
			reference_id?: string;
			title: string;
			description?: string;
			quantity: number;
			unit_price: string;
			discount_amount: string;
			image_url?: string;
			product_url?: string;
			gender?: "Male" | "Female" | "Kids" | "Other";
			category: string;
			color?: string;
			product_material?: string;
			size_type?: string;
			size?: string;
			brand?: string;
			is_refundable?: boolean;
			barcode?: string;
			ppn?: string;
			seller?: string;
		};
		OrderItemHistoryRequest: {
			reference_id?: string;
			title?: string;
			description?: string;
			quantity: number;
			unit_price: string;
			discount_amount: string;
			image_url?: string;
			product_url?: string;
			gender?: "Male" | "Female" | "Kids" | "Other";
			category?: string;
			color?: string;
			product_material?: string;
			size_type?: string;
			size?: string;
			brand?: string;
			is_refundable?: boolean;
			barcode?: string;
			ppn?: string;
			seller?: string;
		};
		OrderItemHistoryResponse: {
			reference_id?: string | null;
			title: string | null;
			description?: string | null;
			quantity: number;
			unit_price: string;
			image_url?: string | null;
			product_url?: string | null;
			gender?: "Male" | "Female" | "Kids" | "Other" | null;
			category: string | null;
			color?: string | null;
			product_material?: string | null;
			size_type?: string | null;
			size?: string | null;
			brand?: string | null;
			is_refundable?: boolean | null;
			ordered: number;
			captured: number;
			shipped: number;
			refunded: number;
		};
		OrderItemResponse: {
			reference_id?: string | null;
			title: string | null;
			description?: string | null;
			quantity: number;
			unit_price: string;
			image_url?: string | null;
			product_url?: string | null;
			gender?: "Male" | "Female" | "Kids" | "Other" | null;
			category: string | null;
			color?: string | null;
			product_material?: string | null;
			size_type?: string | null;
			size?: string | null;
			brand?: string | null;
			is_refundable?: boolean | null;
		};
		OrderPaymentUpdate: {
			reference_id: string | null;
			updated_at?: string;
			tax_amount: string;
			shipping_amount: string;
			discount_amount: string;
			items: components["schemas"]["OrderItemResponse"][] | null;
		} | null;
		OrderResponse: {
			reference_id: string | null;
			updated_at?: string;
			tax_amount: string;
			shipping_amount: string;
			discount_amount: string;
			items: components["schemas"]["OrderItemResponse"][] | null;
		} | null;
		Pagination: {
			limit?: number;
			offset?: number;
			total_count?: number;
		};
		PaymentAmount: string;
		PaymentAmountResponse: string | null;
		PaymentCaptureResponse: {
			id?: components["schemas"]["PaymentID"];
			created_at?: components["schemas"]["PaymentCreatedAt"];
			expires_at?: components["schemas"]["PaymentExpiresAt"];
			status?: components["schemas"]["PaymentStatus"];
			readonly is_test?: boolean;
			amount: components["schemas"]["PaymentAmount"];
			currency: components["schemas"]["Currency"];
			description?: string | null;
			buyer: components["schemas"]["BuyerResponse"];
			shipping_address: components["schemas"]["ShippingAddressResponse"];
			order: components["schemas"]["OrderResponse"];
			readonly captures?: components["schemas"]["CaptureResponse"][];
			readonly refunds: Record<string, never>[] | null;
			buyer_history: components["schemas"]["BuyerHistoryResponse"];
			order_history: components["schemas"]["OrderHistoryResponse"][] | null;
			meta?: components["schemas"]["Meta"];
			attachment?: components["schemas"]["Attachment_V1"];
		};
		PaymentClose: {
			id?: components["schemas"]["PaymentID"];
			created_at?: components["schemas"]["PaymentCreatedAt"];
			expires_at?: components["schemas"]["PaymentExpiresAt"];
			status?: components["schemas"]["PaymentStatus"];
			readonly is_test?: boolean;
			amount: components["schemas"]["PaymentAmount"];
			currency: components["schemas"]["Currency"];
			description?: string | null;
			buyer: components["schemas"]["BuyerResponse"];
			shipping_address: components["schemas"]["ShippingAddressResponse"];
			order: components["schemas"]["OrderResponse"];
			readonly captures: components["schemas"]["CaptureResponse"][] | null;
			readonly refunds: Record<string, never>[] | null;
			buyer_history: components["schemas"]["BuyerHistoryResponse"];
			order_history: components["schemas"]["OrderHistoryResponse"][] | null;
			meta?: components["schemas"]["Meta"];
			attachment?: components["schemas"]["Attachment_V1"];
		};
		PaymentCreatedAt: string;
		PaymentExpiresAt: string;
		PaymentID: string;
		PaymentRefundResponse: {
			id?: components["schemas"]["PaymentID"];
			created_at?: components["schemas"]["PaymentCreatedAt"];
			expires_at?: components["schemas"]["PaymentExpiresAt"];
			status?: components["schemas"]["PaymentStatus"];
			readonly is_test?: boolean;
			amount: components["schemas"]["PaymentAmount"];
			currency: components["schemas"]["Currency"];
			description?: string | null;
			buyer: components["schemas"]["BuyerResponse"];
			shipping_address: components["schemas"]["ShippingAddressResponse"];
			order: components["schemas"]["OrderResponse"];
			readonly captures?: components["schemas"]["CaptureResponse"][];
			readonly refunds?: components["schemas"]["RefundResponse"][];
			buyer_history: components["schemas"]["BuyerHistoryResponse"];
			order_history: components["schemas"]["OrderHistoryResponse"][] | null;
			meta?: components["schemas"]["Meta"];
			attachment?: components["schemas"]["Attachment_V1"];
		};
		PaymentResponse: {
			id?: components["schemas"]["PaymentID"];
			created_at?: components["schemas"]["PaymentCreatedAt"];
			expires_at?: components["schemas"]["PaymentExpiresAt"];
			status?: components["schemas"]["PaymentStatus"];
			readonly is_test?: boolean;
			amount: components["schemas"]["PaymentAmount"];
			currency: components["schemas"]["Currency"];
			description?: string | null;
			buyer: components["schemas"]["BuyerResponse"];
			shipping_address: components["schemas"]["ShippingAddressResponse"];
			order: components["schemas"]["OrderResponse"];
			readonly captures?: components["schemas"]["CaptureResponse"][] | null;
			readonly refunds?: components["schemas"]["RefundResponse"][] | null;
			buyer_history: components["schemas"]["BuyerHistoryResponse"];
			order_history: components["schemas"]["OrderHistoryResponse"][] | null;
			meta?: components["schemas"]["Meta"];
			attachment?: components["schemas"]["Attachment_V1"];
		};
		PaymentStatus: "CREATED" | "AUTHORIZED" | "CLOSED" | "REJECTED" | "EXPIRED";
		PaymentUpdate: {
			id?: components["schemas"]["PaymentID"];
			created_at?: components["schemas"]["PaymentCreatedAt"];
			expires_at?: components["schemas"]["PaymentExpiresAt"];
			status?: components["schemas"]["PaymentStatus"];
			readonly is_test?: boolean;
			amount: components["schemas"]["PaymentAmount"];
			currency: components["schemas"]["Currency"];
			description?: string | null;
			buyer: components["schemas"]["BuyerResponse"];
			shipping_address: components["schemas"]["ShippingAddressResponse"];
			order: components["schemas"]["OrderPaymentUpdate"];
			readonly captures?: components["schemas"]["CaptureResponse"][] | null;
			readonly refunds?: components["schemas"]["RefundResponse"][] | null;
			buyer_history: components["schemas"]["BuyerHistoryResponse"];
			order_history: components["schemas"]["OrderHistoryResponse"][] | null;
			meta?: components["schemas"]["Meta"];
			attachment?: components["schemas"]["Attachment_V1"];
		};
		RefundRequest: {
			amount: string;
			reference_id: string;
			reason?: string;
			items?: components["schemas"]["OrderItem"][];
		};
		RefundResponse: {
			readonly id?: string;
			created_at?: string;
			amount: string;
			reason?: string | null;
			items?: components["schemas"]["OrderItemResponse"][] | null;
			reference_id: string | null;
		};
		ShippingAddress: {
			city: string;
			address: string;
			zip: string;
		};
		ShippingAddressResponse: {
			city: string | null;
			address: string | null;
			zip: string | null;
		} | null;
		Webhook: {
			header?: {
				title?: string;
				value?: string;
			} | null;
			readonly id: string;
			is_test: boolean;
			url: string;
		};
		WebhookDelete: {
			status?: string;
		};
		WebhookRegistration: {
			url: string;
			header?: {
				title?: string;
				value?: string;
			};
		};
		WebhookRegistrationResponse: {
			header?: {
				title?: string | null;
				value?: string | null;
			} | null;
			readonly id?: string;
			is_test: boolean;
			url: string;
		};
		WebhookResponseAll: components["schemas"]["Webhook"] | unknown;
		WebhookUpdate: {
			header?: {
				title?: string;
				value?: string;
			};
			readonly id: string;
			url: string;
		};
		Error_400: {
			status?: string;
			errorType?: string;
			error?: string;
		};
		Error_400_failed: {
			status?: string;
			errorType?: string;
			error?: string;
		};
		Error_400_bad_request: {
			status?: string;
			errorType?: string;
			error?: string;
		};
		Error_400_CheckoutPost: {
			status?: string;
			errorType?: string;
			error?: string;
		};
		Error_400_PaymentsGet: {
			status?: string;
			errorType?: string;
			error?: string;
		};
		Error_400_PaymentsCapture: {
			status?: string;
			errorType?: string;
			error?: string;
		};
		Error_400_PaymentsRefund: {
			status?: string;
			errorType?: string;
			error?: string;
		};
		Error_400_PaymentsClose: {
			status?: string;
			errorType?: string;
			error?: string;
		};
		Error_401: {
			status?: string;
			errorType?: string;
		};
		Error_401_authorization: {
			status?: string;
			errorType?: string;
			error?: string;
		};
		Error_401_invalid_secret_key: {
			status?: string;
			errorType?: string;
			error?: string;
		};
		Error_401_key_doesnt_exist: {
			status?: string;
			errorType?: string;
			error?: string;
		};
		Error_401_merchantNull: {
			status?: string;
			errorType?: string;
			error?: string;
		};
		Error_401_missingBearer: {
			status?: string;
			errorType?: string;
			error?: string;
		};
		Error_403: {
			status?: string;
			errorType?: string;
		};
		Error_404: string;
		Error_404_dispute_not_found: {
			status?: string;
			errorType?: string;
			error?: string;
		};
		Error_404_no_such_payment: {
			status?: string;
			errorType?: string;
			error?: string;
		};
		Error_404_no_such_webhook: {
			status?: string;
			errorType?: string;
			error?: string;
		};
		Error_409: {
			status?: string;
			errorType?: string;
			error?: string;
		};
		Error_500: string;
	};
	responses: {
		CheckoutSession: {
			headers: {
				[name: string]: unknown;
			};
			content: {
				"application/json": components["schemas"]["CheckoutSession"];
			};
		};
		Dispute: {
			headers: {
				[name: string]: unknown;
			};
			content: {
				"application/json": {
					dispute: components["schemas"]["Dispute"];
				};
			};
		};
		DisputeAttachmentUpload: {
			headers: {
				[name: string]: unknown;
			};
			content: {
				"application/json": {
					id?: string;
				};
			};
		};
		DisputeProvideEvidence: {
			headers: {
				[name: string]: unknown;
			};
			content: {
				"application/json": components["schemas"]["Evidence"];
			};
		};
		DisputeProvideEvidenceConflict: {
			headers: {
				[name: string]: unknown;
			};
			content: {
				"application/json": components["schemas"]["Error_409"];
			};
		};
		Disputes: {
			headers: {
				[name: string]: unknown;
			};
			content: {
				"application/json": {
					disputes: components["schemas"]["DisputeNoHistory"][];
					next_page_token: string;
				};
			};
		};
		DisputesApprove: {
			headers: {
				[name: string]: unknown;
			};
			content: {
				"application/json": {
					disputes?: components["schemas"]["DisputeNoHistory"][];
				};
			};
		};
		DisputesChallenge: {
			headers: {
				[name: string]: unknown;
			};
			content: {
				"application/json": {
					disputes?: components["schemas"]["DisputeNoHistory"][];
				};
			};
		};
		PaymentCaptureResponse: {
			headers: {
				[name: string]: unknown;
			};
			content: {
				"application/json": components["schemas"]["PaymentCaptureResponse"];
			};
		};
		PaymentClose: {
			headers: {
				[name: string]: unknown;
			};
			content: {
				"application/json": components["schemas"]["PaymentClose"];
			};
		};
		PaymentRefundError: {
			headers: {
				[name: string]: unknown;
			};
			content: {
				"application/json": components["schemas"]["Error_409"];
			};
		};
		PaymentRefundResponse: {
			headers: {
				[name: string]: unknown;
			};
			content: {
				"application/json": components["schemas"]["PaymentRefundResponse"];
			};
		};
		PaymentResponse: {
			headers: {
				[name: string]: unknown;
			};
			content: {
				"application/json": components["schemas"]["PaymentResponse"];
			};
		};
		PaymentUpdate: {
			headers: {
				[name: string]: unknown;
			};
			content: {
				"application/json": components["schemas"]["PaymentUpdate"];
			};
		};
		Payments: {
			headers: {
				[name: string]: unknown;
			};
			content: {
				"application/json": {
					payments?: components["schemas"]["PaymentResponse"][] | null;
					pagination?: components["schemas"]["Pagination"];
				};
			};
		};
		Webhook: {
			headers: {
				[name: string]: unknown;
			};
			content: {
				"application/json": components["schemas"]["Webhook"];
			};
		};
		WebhookAll: {
			headers: {
				[name: string]: unknown;
			};
			content: {
				"application/json": components["schemas"]["WebhookResponseAll"];
			};
		};
		WebhookDelete: {
			headers: {
				[name: string]: unknown;
			};
			content: {
				"application/json": components["schemas"]["WebhookDelete"];
			};
		};
		WebhookRegistration: {
			headers: {
				[name: string]: unknown;
			};
			content: {
				"application/json": components["schemas"]["WebhookRegistrationResponse"];
			};
		};
		WebhookUpdate: {
			headers: {
				[name: string]: unknown;
			};
			content: {
				"application/json": components["schemas"]["WebhookUpdate"];
			};
		};
		AuthenticationError: {
			headers: {
				[name: string]: unknown;
			};
			content: {
				"application/json": components["schemas"]["Error_401"];
			};
		};
		AuthenticationError_authorization: {
			headers: {
				[name: string]: unknown;
			};
			content: {
				"application/json": components["schemas"]["Error_401_authorization"];
			};
		};
		AuthenticationError_CheckoutPost: {
			headers: {
				[name: string]: unknown;
			};
			content: {
				"application/json": components["schemas"]["Error_401_merchantNull"];
			};
		};
		AuthenticationError_invalid_secret_key: {
			headers: {
				[name: string]: unknown;
			};
			content: {
				"application/json": components["schemas"]["Error_401_invalid_secret_key"];
			};
		};
		AuthenticationError_key_doesnt_exist: {
			headers: {
				[name: string]: unknown;
			};
			content: {
				"application/json": components["schemas"]["Error_401_key_doesnt_exist"];
			};
		};
		AuthenticationError_PaymentsGet: {
			headers: {
				[name: string]: unknown;
			};
			content: {
				"application/json": components["schemas"]["Error_401_missingBearer"];
			};
		};
		BadRequestError: {
			headers: {
				[name: string]: unknown;
			};
			content: {
				"application/json": components["schemas"]["Error_400"];
			};
		};
		BadRequestError_bad_request: {
			headers: {
				[name: string]: unknown;
			};
			content: {
				"application/json": components["schemas"]["Error_400_bad_request"];
			};
		};
		BadRequestError_CheckoutPost: {
			headers: {
				[name: string]: unknown;
			};
			content: {
				"application/json": components["schemas"]["Error_400_CheckoutPost"];
			};
		};
		BadRequestError_failed: {
			headers: {
				[name: string]: unknown;
			};
			content: {
				"application/json": components["schemas"]["Error_400_failed"];
			};
		};
		BadRequestError_PaymentsCapture: {
			headers: {
				[name: string]: unknown;
			};
			content: {
				"application/json": components["schemas"]["Error_400_PaymentsCapture"];
			};
		};
		BadRequestError_PaymentsClose: {
			headers: {
				[name: string]: unknown;
			};
			content: {
				"application/json": components["schemas"]["Error_400_PaymentsClose"];
			};
		};
		BadRequestError_PaymentsGet: {
			headers: {
				[name: string]: unknown;
			};
			content: {
				"application/json": components["schemas"]["Error_400_PaymentsGet"];
			};
		};
		BadRequestError_PaymentsRefund: {
			headers: {
				[name: string]: unknown;
			};
			content: {
				"application/json": components["schemas"]["Error_400_PaymentsRefund"];
			};
		};
		ForbiddenError: {
			headers: {
				[name: string]: unknown;
			};
			content: {
				"application/json": components["schemas"]["Error_403"];
			};
		};
		NotFoundError: {
			headers: {
				[name: string]: unknown;
			};
			content: {
				"application/json": components["schemas"]["Error_404"];
			};
		};
		NotFoundError_Disputes: {
			headers: {
				[name: string]: unknown;
			};
			content: {
				"application/json": components["schemas"]["Error_404_dispute_not_found"];
			};
		};
		NotFoundError_no_such_payment: {
			headers: {
				[name: string]: unknown;
			};
			content: {
				"application/json": components["schemas"]["Error_404_no_such_payment"];
			};
		};
		NotFoundError_no_such_webhook: {
			headers: {
				[name: string]: unknown;
			};
			content: {
				"application/json": components["schemas"]["Error_404_no_such_webhook"];
			};
		};
		UnexpectedError: {
			headers: {
				[name: string]: unknown;
			};
			content: {
				"application/json": components["schemas"]["Error_500"];
			};
		};
	};
	parameters: {
		paymentIdParam: string;
		webhookIdParam: string;
		refundIdParam: string;
		merchantCodeParam: string;
		sessionIdParam: string;
		disputeIdParam: string;
	};
	requestBodies: never;
	headers: never;
	pathItems: never;
}
export type $defs = Record<string, never>;
export interface operations {
	postCheckoutSession: {
		parameters: {
			query?: never;
			header?: never;
			path?: never;
			cookie?: never;
		};
		requestBody: {
			content: {
				"application/json": {
					payment: components["schemas"]["CheckoutCreation"];
					lang: components["schemas"]["LanguageCode"];
					merchant_code: string;
					merchant_urls?: components["schemas"]["MerchantUrls"];
					token?: string;
				};
			};
		};
		responses: {
			200: components["responses"]["CheckoutSession"];
			400: components["responses"]["BadRequestError_CheckoutPost"];
			401: components["responses"]["AuthenticationError_CheckoutPost"];
			403: components["responses"]["ForbiddenError"];
			404: components["responses"]["NotFoundError"];
			500: components["responses"]["UnexpectedError"];
		};
	};
	getCheckoutSession: {
		parameters: {
			query?: never;
			header?: never;
			path: {
				id: components["parameters"]["sessionIdParam"];
			};
			cookie?: never;
		};
		requestBody?: never;
		responses: {
			200: components["responses"]["CheckoutSession"];
			400: components["responses"]["BadRequestError"];
			401: components["responses"]["AuthenticationError_key_doesnt_exist"];
			403: components["responses"]["ForbiddenError"];
			404: components["responses"]["NotFoundError"];
			500: components["responses"]["UnexpectedError"];
		};
	};
	getPayment: {
		parameters: {
			query?: never;
			header?: never;
			path: {
				id: components["parameters"]["paymentIdParam"];
			};
			cookie?: never;
		};
		requestBody?: never;
		responses: {
			200: components["responses"]["PaymentResponse"];
			400: components["responses"]["BadRequestError_PaymentsGet"];
			401: components["responses"]["AuthenticationError_PaymentsGet"];
			404: components["responses"]["NotFoundError_no_such_payment"];
			500: components["responses"]["UnexpectedError"];
		};
	};
	putPayment: {
		parameters: {
			query?: never;
			header?: never;
			path: {
				id: components["parameters"]["paymentIdParam"];
			};
			cookie?: never;
		};
		requestBody: {
			content: {
				"application/json": {
					order?: {
						reference_id?: string;
					};
				};
			};
		};
		responses: {
			200: components["responses"]["PaymentUpdate"];
			400: components["responses"]["BadRequestError_PaymentsGet"];
			401: components["responses"]["AuthenticationError"];
			403: components["responses"]["ForbiddenError"];
			404: components["responses"]["NotFoundError_no_such_payment"];
			500: components["responses"]["UnexpectedError"];
		};
	};
	postPaymentCapture: {
		parameters: {
			query?: never;
			header?: never;
			path: {
				id: components["parameters"]["paymentIdParam"];
			};
			cookie?: never;
		};
		requestBody: {
			content: {
				"application/json": components["schemas"]["CaptureRequest"];
			};
		};
		responses: {
			200: components["responses"]["PaymentCaptureResponse"];
			400: components["responses"]["BadRequestError_PaymentsCapture"];
			401: components["responses"]["AuthenticationError"];
			403: components["responses"]["ForbiddenError"];
			404: components["responses"]["NotFoundError_no_such_payment"];
			500: components["responses"]["UnexpectedError"];
		};
	};
	postPaymentRefund: {
		parameters: {
			query?: never;
			header?: never;
			path: {
				id: components["parameters"]["paymentIdParam"];
			};
			cookie?: never;
		};
		requestBody: {
			content: {
				"application/json": components["schemas"]["RefundRequest"];
			};
		};
		responses: {
			200: components["responses"]["PaymentRefundResponse"];
			400: components["responses"]["BadRequestError_PaymentsRefund"];
			401: components["responses"]["AuthenticationError"];
			403: components["responses"]["ForbiddenError"];
			404: components["responses"]["NotFoundError_no_such_payment"];
			409: components["responses"]["PaymentRefundError"];
			500: components["responses"]["UnexpectedError"];
		};
	};
	closePayment: {
		parameters: {
			query?: never;
			header?: never;
			path: {
				id: components["parameters"]["paymentIdParam"];
			};
			cookie?: never;
		};
		requestBody?: never;
		responses: {
			200: components["responses"]["PaymentClose"];
			400: components["responses"]["BadRequestError_PaymentsClose"];
			401: components["responses"]["AuthenticationError"];
			403: components["responses"]["ForbiddenError"];
			404: components["responses"]["NotFoundError_no_such_payment"];
			500: components["responses"]["UnexpectedError"];
		};
	};
	getPayments: {
		parameters: {
			query?: {
				created_at__gte?: string;
				created_at__lte?: string;
				limit?: number;
				status?:
					| "authorized"
					| "closed"
					| "rejected"
					| "new"
					| "captured"
					| "refunded"
					| "cancelled";
				offset?: number;
			};
			header?: never;
			path?: never;
			cookie?: never;
		};
		requestBody?: never;
		responses: {
			200: components["responses"]["Payments"];
			400: components["responses"]["BadRequestError_failed"];
			401: components["responses"]["AuthenticationError"];
			500: components["responses"]["UnexpectedError"];
		};
	};
	getWebhooks: {
		parameters: {
			query?: never;
			header: {
				"X-Merchant-Code": components["parameters"]["merchantCodeParam"];
			};
			path?: never;
			cookie?: never;
		};
		requestBody?: never;
		responses: {
			200: components["responses"]["WebhookAll"];
			401: components["responses"]["AuthenticationError_authorization"];
			404: components["responses"]["NotFoundError"];
			500: components["responses"]["UnexpectedError"];
		};
	};
	postWebhook: {
		parameters: {
			query?: never;
			header: {
				"X-Merchant-Code": components["parameters"]["merchantCodeParam"];
			};
			path?: never;
			cookie?: never;
		};
		requestBody: {
			content: {
				"application/json": components["schemas"]["WebhookRegistration"];
			};
		};
		responses: {
			200: components["responses"]["WebhookRegistration"];
			400: components["responses"]["BadRequestError_bad_request"];
			401: components["responses"]["AuthenticationError_authorization"];
			404: components["responses"]["NotFoundError"];
			500: components["responses"]["UnexpectedError"];
		};
	};
	getWebhook: {
		parameters: {
			query?: never;
			header: {
				"X-Merchant-Code": components["parameters"]["merchantCodeParam"];
			};
			path: {
				id: components["parameters"]["webhookIdParam"];
			};
			cookie?: never;
		};
		requestBody?: never;
		responses: {
			200: components["responses"]["Webhook"];
			401: components["responses"]["AuthenticationError_invalid_secret_key"];
			404: components["responses"]["NotFoundError_no_such_webhook"];
			500: components["responses"]["UnexpectedError"];
		};
	};
	putWebhook: {
		parameters: {
			query?: never;
			header: {
				"X-Merchant-Code": components["parameters"]["merchantCodeParam"];
			};
			path: {
				id: components["parameters"]["webhookIdParam"];
			};
			cookie?: never;
		};
		requestBody: {
			content: {
				"application/json": components["schemas"]["WebhookUpdate"];
			};
		};
		responses: {
			200: components["responses"]["WebhookUpdate"];
			400: components["responses"]["BadRequestError_bad_request"];
			401: components["responses"]["AuthenticationError_authorization"];
			403: components["responses"]["ForbiddenError"];
			404: components["responses"]["NotFoundError_no_such_webhook"];
			500: components["responses"]["UnexpectedError"];
		};
	};
	deleteWebhook: {
		parameters: {
			query?: never;
			header: {
				"X-Merchant-Code": components["parameters"]["merchantCodeParam"];
			};
			path: {
				id: components["parameters"]["webhookIdParam"];
			};
			cookie?: never;
		};
		requestBody?: never;
		responses: {
			200: components["responses"]["WebhookDelete"];
			401: components["responses"]["AuthenticationError_invalid_secret_key"];
			404: components["responses"]["NotFoundError_no_such_webhook"];
			500: components["responses"]["UnexpectedError"];
		};
	};
	getDisputes: {
		parameters: {
			query?: {
				statuses?:
					| "new"
					| "declined"
					| "cancelled"
					| "refunded"
					| "in_progress"
					| "evidence_merchant"
					| "evidence_customer";
				created_at_gte?: string;
				created_at_lte?: string;
				page_token?: string;
			};
			header?: never;
			path?: never;
			cookie?: never;
		};
		requestBody?: never;
		responses: {
			200: components["responses"]["Disputes"];
			400: components["responses"]["BadRequestError_bad_request"];
			401: components["responses"]["AuthenticationError_invalid_secret_key"];
			404: components["responses"]["NotFoundError"];
			500: components["responses"]["UnexpectedError"];
		};
	};
	getDispute: {
		parameters: {
			query?: never;
			header?: never;
			path: {
				dispute_id: components["parameters"]["disputeIdParam"];
			};
			cookie?: never;
		};
		requestBody?: never;
		responses: {
			200: components["responses"]["Dispute"];
			400: components["responses"]["BadRequestError_bad_request"];
			401: components["responses"]["AuthenticationError_invalid_secret_key"];
			404: components["responses"]["NotFoundError_Disputes"];
			500: components["responses"]["UnexpectedError"];
		};
	};
	postDisputeProvideEvidence: {
		parameters: {
			query?: never;
			header?: never;
			path: {
				dispute_id: components["parameters"]["disputeIdParam"];
			};
			cookie?: never;
		};
		requestBody: {
			content: {
				"application/json": {
					content: string;
					attachment_ids?: string[];
				};
			};
		};
		responses: {
			200: components["responses"]["DisputeProvideEvidence"];
			400: components["responses"]["BadRequestError_bad_request"];
			401: components["responses"]["AuthenticationError_invalid_secret_key"];
			404: components["responses"]["NotFoundError_Disputes"];
			409: components["responses"]["DisputeProvideEvidenceConflict"];
			500: components["responses"]["UnexpectedError"];
		};
	};
	postDisputesApprove: {
		parameters: {
			query?: never;
			header?: never;
			path?: never;
			cookie?: never;
		};
		requestBody: {
			content: {
				"application/json": {
					dispute_ids: string[];
				};
			};
		};
		responses: {
			200: components["responses"]["DisputesApprove"];
			400: components["responses"]["BadRequestError_bad_request"];
			401: components["responses"]["AuthenticationError_invalid_secret_key"];
			404: components["responses"]["NotFoundError"];
			500: components["responses"]["UnexpectedError"];
		};
	};
	postDisputesChallenge: {
		parameters: {
			query?: never;
			header?: never;
			path?: never;
			cookie?: never;
		};
		requestBody: {
			content: {
				"application/json": {
					dispute_id: string;
					description: string;
					reason:
						| "merchant_reason_other"
						| "merchant_reason_order_on_its_way"
						| "merchant_reason_order_has_been_already_delivered"
						| "merchant_reason_order_amount_should_be_different"
						| "merchant_reason_problem_with_delivery";
					amount?: string;
					attachment_ids?: string[];
				};
			};
		};
		responses: {
			200: components["responses"]["DisputesChallenge"];
			400: components["responses"]["BadRequestError_bad_request"];
			401: components["responses"]["AuthenticationError_invalid_secret_key"];
			404: components["responses"]["NotFoundError"];
			500: components["responses"]["UnexpectedError"];
		};
	};
	postUploadAttachment: {
		parameters: {
			query?: never;
			header?: never;
			path?: never;
			cookie?: never;
		};
		requestBody: {
			content: {
				"multipart/form-data": {
					attachment: string;
				};
			};
		};
		responses: {
			200: components["responses"]["DisputeAttachmentUpload"];
			400: components["responses"]["BadRequestError_bad_request"];
			401: components["responses"]["AuthenticationError_invalid_secret_key"];
			500: components["responses"]["UnexpectedError"];
		};
	};
}
