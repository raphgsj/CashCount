CREATE VIEW "v_financial_transaction_effective" AS
SELECT
	ft.*,
	CASE
		WHEN tus.category_override_enabled THEN tus.category_id_override
		ELSE ft.system_category_id
	END AS effective_category_id,
	CASE
		WHEN tus.category_override_enabled THEN 'USER'
		ELSE ft.system_category_source
	END AS effective_category_source,
	CASE
		WHEN tus.category_override_enabled THEN NULL::numeric(5, 4)
		ELSE ft.system_category_confidence
	END AS effective_category_confidence,
	CASE
		WHEN tus.merchant_override_enabled THEN tus.merchant_id_override
		ELSE ft.system_merchant_id
	END AS effective_merchant_id,
	CASE
		WHEN tus.merchant_override_enabled THEN 'USER'
		ELSE ft.system_merchant_source
	END AS effective_merchant_source,
	CASE
		WHEN tus.merchant_override_enabled THEN NULL::numeric(5, 4)
		ELSE ft.system_merchant_confidence
	END AS effective_merchant_confidence,
	CASE
		WHEN tus.financial_role_override_enabled THEN tus.financial_role_override
		ELSE ft.system_financial_role
	END AS effective_financial_role,
	CASE
		WHEN tus.financial_role_override_enabled THEN 'USER'
		ELSE ft.system_financial_role_source
	END AS effective_financial_role_source,
	CASE
		WHEN tus.financial_role_override_enabled THEN NULL::numeric(5, 4)
		ELSE ft.system_financial_role_confidence
	END AS effective_financial_role_confidence,
	coalesce(tus.excluded_from_spend_override, ft.system_is_excluded_from_spend)
		AS effective_is_excluded_from_spend,
	CASE
		WHEN tus.excluded_from_spend_override IS NOT NULL THEN 'USER'
		ELSE ft.system_exclusion_source
	END AS effective_exclusion_source,
	CASE
		WHEN ft.account_currency_amount_signed IS NOT NULL
			THEN ft.account_currency_amount_signed
		WHEN ft.provider_currency = ft.account_currency THEN ft.provider_amount_signed
		ELSE NULL::numeric(20, 6)
	END AS analytics_amount_signed,
	ft.account_currency AS analytics_currency,
	(
		ft.account_currency_amount_signed IS NULL
		AND ft.provider_currency <> ft.account_currency
	) AS has_unconverted_currency,
	coalesce(tus.review_status, 'UNREVIEWED') AS user_review_status,
	tus.notes AS user_notes,
	coalesce(tus.version, 0) AS user_state_version,
	coalesce(tus.category_override_enabled, false) AS category_override_enabled,
	coalesce(tus.merchant_override_enabled, false) AS merchant_override_enabled,
	coalesce(tus.financial_role_override_enabled, false) AS financial_role_override_enabled
FROM financial_transaction ft
LEFT JOIN transaction_user_state tus
	ON tus.workspace_id = ft.workspace_id
	AND tus.financial_transaction_id = ft.id;
--> statement-breakpoint
CREATE VIEW "v_transaction_spend_effect" AS
SELECT
	e.*,
	CASE
		WHEN e.deleted_at IS NOT NULL OR e.status = 'DELETED'
			OR e.duplicate_review_status = 'CONFIRMED_DUPLICATE'
			OR e.effective_is_excluded_from_spend THEN 0::numeric(20, 6)
		WHEN e.effective_financial_role IN ('PURCHASE', 'FEE', 'TAX')
			THEN abs(e.analytics_amount_signed)
		WHEN e.effective_financial_role IN ('REFUND', 'CREDIT')
			THEN -abs(e.analytics_amount_signed)
		ELSE 0::numeric(20, 6)
	END AS spend_effect_amount
FROM v_financial_transaction_effective e;
--> statement-breakpoint
CREATE VIEW "v_transaction_cashflow_effect" AS
SELECT
	e.*,
	fa.account_type,
	CASE
		WHEN e.deleted_at IS NOT NULL OR e.status = 'DELETED'
			OR e.duplicate_review_status = 'CONFIRMED_DUPLICATE'
			OR fa.account_type NOT IN ('CHECKING', 'SAVINGS')
			OR e.effective_financial_role = 'TRANSFER' THEN 0::numeric(20, 6)
		WHEN e.system_direction = 'INFLOW' THEN abs(e.analytics_amount_signed)
		WHEN e.system_direction = 'OUTFLOW' THEN -abs(e.analytics_amount_signed)
		ELSE 0::numeric(20, 6)
	END AS cashflow_effect_amount
FROM v_financial_transaction_effective e
JOIN financial_account fa
	ON fa.workspace_id = e.workspace_id
	AND fa.id = e.financial_account_id;
--> statement-breakpoint
CREATE VIEW "v_credit_card_bill_reconciliation" AS
WITH linked_transactions AS (
	SELECT
		e.workspace_id,
		e.credit_card_bill_id,
		e.analytics_currency AS currency,
		sum(abs(e.analytics_amount_signed)) FILTER (
			WHERE e.analytics_amount_signed IS NOT NULL
				AND e.status <> 'DELETED'
				AND e.deleted_at IS NULL
				AND e.duplicate_review_status <> 'CONFIRMED_DUPLICATE'
		) AS linked_transaction_total,
		count(*) FILTER (WHERE e.has_unconverted_currency) AS unconverted_transaction_count
	FROM v_financial_transaction_effective e
	WHERE e.credit_card_bill_id IS NOT NULL
	GROUP BY e.workspace_id, e.credit_card_bill_id, e.analytics_currency
), normalized_payments AS (
	SELECT
		workspace_id,
		credit_card_bill_id,
		currency,
		sum(amount) AS normalized_payment_total,
		count(*) AS normalized_payment_count
	FROM credit_card_bill_payment
	GROUP BY workspace_id, credit_card_bill_id, currency
), normalized_charges AS (
	SELECT
		workspace_id,
		credit_card_bill_id,
		currency,
		sum(amount) AS normalized_finance_charge_total,
		count(*) AS normalized_finance_charge_count,
		count(*) FILTER (WHERE matched_transaction_id IS NULL) AS unresolved_finance_charge_count
	FROM credit_card_bill_finance_charge
	GROUP BY workspace_id, credit_card_bill_id, currency
), confirmed_bank_payments AS (
	SELECT
		p.workspace_id,
		p.credit_card_bill_id,
		p.currency,
		sum(p.amount) AS confirmed_bank_payment_total,
		count(DISTINCT p.id) AS confirmed_bank_payment_count
	FROM credit_card_bill_payment p
	JOIN bill_payment_reconciliation r
		ON r.workspace_id = p.workspace_id
		AND r.credit_card_bill_payment_id = p.id
		AND r.match_status IN ('AUTO_MATCHED', 'USER_CONFIRMED')
	JOIN v_financial_transaction_effective e
		ON e.workspace_id = r.workspace_id
		AND e.id = r.financial_transaction_id
		AND e.effective_financial_role = 'CARD_BILL_PAYMENT'
		AND e.analytics_currency = p.currency
		AND abs(e.analytics_amount_signed) = p.amount
	JOIN financial_account fa
		ON fa.workspace_id = e.workspace_id
		AND fa.id = e.financial_account_id
		AND fa.account_type IN ('CHECKING', 'SAVINGS')
	GROUP BY p.workspace_id, p.credit_card_bill_id, p.currency
), reconciliation AS (
	SELECT
		b.id AS credit_card_bill_id,
		b.workspace_id,
		b.financial_account_id,
		b.status AS bill_status,
		b.due_date,
		b.close_date,
		b.currency,
		b.total_amount AS bill_total,
		coalesce(lt.linked_transaction_total, 0::numeric) AS linked_transaction_total,
		coalesce(np.normalized_payment_total, 0::numeric) AS normalized_payment_total,
		coalesce(nc.normalized_finance_charge_total, 0::numeric)
			AS normalized_finance_charge_total,
		coalesce(cbp.confirmed_bank_payment_total, 0::numeric)
			AS confirmed_bank_payment_total,
		coalesce(np.normalized_payment_count, 0::bigint) AS normalized_payment_count,
		coalesce(nc.normalized_finance_charge_count, 0::bigint)
			AS normalized_finance_charge_count,
		coalesce(cbp.confirmed_bank_payment_count, 0::bigint)
			AS confirmed_bank_payment_count,
		coalesce(lt.unconverted_transaction_count, 0::bigint)
			AS unconverted_transaction_count,
		coalesce(nc.unresolved_finance_charge_count, 0::bigint)
			+ greatest(
				coalesce(np.normalized_payment_count, 0::bigint)
					- coalesce(cbp.confirmed_bank_payment_count, 0::bigint),
				0::bigint
			)
			+ coalesce(lt.unconverted_transaction_count, 0::bigint) AS unresolved_item_count,
		CASE WHEN b.currency = 'BRL' THEN 0.01::numeric(20, 6) END AS tolerance_amount,
		CASE
			WHEN b.total_amount IS NULL THEN NULL::numeric
			ELSE b.total_amount - coalesce(lt.linked_transaction_total, 0::numeric)
		END AS difference_amount
	FROM credit_card_bill b
	LEFT JOIN linked_transactions lt
		ON lt.workspace_id = b.workspace_id
		AND lt.credit_card_bill_id = b.id
		AND lt.currency = b.currency
	LEFT JOIN normalized_payments np
		ON np.workspace_id = b.workspace_id
		AND np.credit_card_bill_id = b.id
		AND np.currency = b.currency
	LEFT JOIN normalized_charges nc
		ON nc.workspace_id = b.workspace_id
		AND nc.credit_card_bill_id = b.id
		AND nc.currency = b.currency
	LEFT JOIN confirmed_bank_payments cbp
		ON cbp.workspace_id = b.workspace_id
		AND cbp.credit_card_bill_id = b.id
		AND cbp.currency = b.currency
)
SELECT
	r.*,
	CASE
		WHEN r.bill_total IS NULL THEN 'UNKNOWN'
		WHEN r.unconverted_transaction_count > 0 OR r.unresolved_item_count > 0
			THEN 'NEEDS_REVIEW'
		WHEN r.tolerance_amount IS NULL THEN 'TOLERANCE_REQUIRED'
		WHEN abs(r.difference_amount) <= r.tolerance_amount THEN 'RECONCILED'
		ELSE 'NEEDS_REVIEW'
	END AS reconciliation_status
FROM reconciliation r;
--> statement-breakpoint
CREATE VIEW "v_account_history_coverage" AS
SELECT
	fa.workspace_id,
	fa.id AS financial_account_id,
	fa.provider_connection_id,
	fa.account_type,
	fa.currency,
	fa.provider_history_earliest_date,
	fa.provider_history_latest_date,
	fa.initial_import_completed_at,
	fa.history_coverage_status,
	fa.history_coverage_note,
	(fa.history_coverage_status IN ('UNKNOWN', 'PARTIAL')) AS has_incomplete_history,
	(fa.initial_import_completed_at IS NOT NULL) AS initial_import_completed
FROM financial_account fa
WHERE fa.deleted_at IS NULL;
--> statement-breakpoint
CREATE VIEW "v_transactions_needing_review" AS
SELECT e.*
FROM v_financial_transaction_effective e
WHERE e.deleted_at IS NULL
	AND e.status <> 'DELETED'
	AND (
		e.user_review_status = 'NEEDS_REVIEW'
		OR e.duplicate_review_status = 'POSSIBLE'
		OR e.effective_financial_role IN ('UNKNOWN_CREDIT', 'UNKNOWN')
		OR e.effective_category_id IS NULL
		OR e.has_unconverted_currency
	);
--> statement-breakpoint
CREATE VIEW "v_transaction_replacement_review" AS
SELECT
	l.id AS transaction_identity_link_id,
	l.workspace_id,
	l.predecessor_transaction_id,
	p.provider_transaction_id AS predecessor_provider_transaction_id,
	p.transaction_local_date AS predecessor_transaction_local_date,
	l.successor_transaction_id,
	s.provider_transaction_id AS successor_provider_transaction_id,
	s.transaction_local_date AS successor_transaction_local_date,
	l.link_type,
	l.status,
	l.confidence,
	l.evidence,
	l.detected_at
FROM transaction_identity_link l
JOIN v_financial_transaction_effective p
	ON p.workspace_id = l.workspace_id
	AND p.id = l.predecessor_transaction_id
JOIN v_financial_transaction_effective s
	ON s.workspace_id = l.workspace_id
	AND s.id = l.successor_transaction_id
WHERE l.status = 'NEEDS_REVIEW';
--> statement-breakpoint
CREATE VIEW "v_monthly_spend_by_category" AS
SELECT
	e.workspace_id,
	date_trunc('month', e.transaction_local_date)::date AS month,
	e.analytics_currency AS currency,
	e.effective_category_id AS category_id,
	sum(e.spend_effect_amount) FILTER (WHERE e.spend_effect_amount IS NOT NULL)
		AS spend_amount,
	count(*) FILTER (WHERE e.spend_effect_amount IS NOT NULL) AS transaction_count,
	count(*) FILTER (WHERE e.has_unconverted_currency) AS unconverted_transaction_count
FROM v_transaction_spend_effect e
WHERE e.status = 'POSTED'
	AND e.deleted_at IS NULL
GROUP BY
	e.workspace_id,
	date_trunc('month', e.transaction_local_date)::date,
	e.analytics_currency,
	e.effective_category_id;
--> statement-breakpoint
CREATE VIEW "v_monthly_spend_by_merchant" AS
SELECT
	e.workspace_id,
	date_trunc('month', e.transaction_local_date)::date AS month,
	e.analytics_currency AS currency,
	e.effective_merchant_id AS merchant_id,
	sum(e.spend_effect_amount) FILTER (WHERE e.spend_effect_amount IS NOT NULL)
		AS spend_amount,
	count(*) FILTER (WHERE e.spend_effect_amount IS NOT NULL) AS transaction_count,
	count(*) FILTER (WHERE e.has_unconverted_currency) AS unconverted_transaction_count
FROM v_transaction_spend_effect e
WHERE e.status = 'POSTED'
	AND e.deleted_at IS NULL
GROUP BY
	e.workspace_id,
	date_trunc('month', e.transaction_local_date)::date,
	e.analytics_currency,
	e.effective_merchant_id;
--> statement-breakpoint
CREATE VIEW "v_installment_commitments" AS
WITH posted_installments AS (
	SELECT
		e.workspace_id,
		e.installment_series_id,
		count(*) FILTER (
			WHERE e.status = 'POSTED' AND e.deleted_at IS NULL
		) AS posted_transaction_count,
		sum(abs(e.analytics_amount_signed)) FILTER (
			WHERE e.status = 'POSTED'
				AND e.deleted_at IS NULL
				AND e.analytics_amount_signed IS NOT NULL
		) AS posted_amount,
		count(*) FILTER (
			WHERE e.status = 'POSTED'
				AND e.deleted_at IS NULL
				AND e.has_unconverted_currency
		) AS unconverted_transaction_count
	FROM v_financial_transaction_effective e
	WHERE e.installment_series_id IS NOT NULL
	GROUP BY e.workspace_id, e.installment_series_id
)
SELECT
	s.id AS installment_series_id,
	s.workspace_id,
	s.financial_account_id,
	s.merchant_id,
	s.currency,
	s.total_installments,
	s.highest_confirmed_installment,
	greatest(s.total_installments - s.highest_confirmed_installment, 0)
		AS remaining_installments,
	s.estimated_installment_amount,
	s.original_total_amount,
	s.purchase_date,
	s.status,
	coalesce(p.posted_transaction_count, 0::bigint) AS posted_transaction_count,
	coalesce(p.posted_amount, 0::numeric) AS posted_amount,
	coalesce(p.unconverted_transaction_count, 0::bigint) AS unconverted_transaction_count,
	CASE
		WHEN s.estimated_installment_amount IS NULL THEN NULL::numeric
		ELSE greatest(s.total_installments - s.highest_confirmed_installment, 0)
			* s.estimated_installment_amount
	END AS estimated_remaining_commitment
FROM installment_series s
LEFT JOIN posted_installments p
	ON p.workspace_id = s.workspace_id
	AND p.installment_series_id = s.id;
--> statement-breakpoint
CREATE VIEW "v_account_data_freshness" AS
SELECT
	fa.workspace_id,
	fa.id AS financial_account_id,
	fa.provider_connection_id,
	fa.account_type,
	fa.currency,
	pc.local_status AS connection_status,
	pc.last_attempt_at AS connection_last_attempt_at,
	pc.last_successful_sync_at AS connection_last_successful_sync_at,
	fa.last_successful_sync_at AS account_last_successful_sync_at,
	greatest(pc.last_successful_sync_at, fa.last_successful_sync_at)
		AS effective_last_successful_sync_at,
	CASE
		WHEN greatest(pc.last_successful_sync_at, fa.last_successful_sync_at) IS NULL THEN NULL
		ELSE extract(
			epoch FROM (
				current_timestamp - greatest(pc.last_successful_sync_at, fa.last_successful_sync_at)
			)
		)::bigint
	END AS age_seconds,
	(
		greatest(pc.last_successful_sync_at, fa.last_successful_sync_at) IS NULL
		OR greatest(pc.last_successful_sync_at, fa.last_successful_sync_at)
			< current_timestamp - interval '24 hours'
	) AS is_stale,
	(pc.local_status NOT IN ('ACTIVE', 'SYNCING')) AS requires_connection_attention
FROM financial_account fa
JOIN provider_connection pc
	ON pc.workspace_id = fa.workspace_id
	AND pc.id = fa.provider_connection_id
WHERE fa.deleted_at IS NULL
	AND pc.deleted_at IS NULL;
--> statement-breakpoint
CREATE VIEW "v_unclassified_transactions" AS
SELECT e.*
FROM v_financial_transaction_effective e
WHERE e.deleted_at IS NULL
	AND e.status <> 'DELETED'
	AND e.effective_category_id IS NULL;
--> statement-breakpoint
CREATE INDEX "transaction_user_state_workspace_review_idx"
	ON "transaction_user_state" ("workspace_id", "review_status", "updated_at" DESC);
--> statement-breakpoint
CREATE INDEX "transaction_identity_link_workspace_review_idx"
	ON "transaction_identity_link" ("workspace_id", "status", "detected_at" DESC);
--> statement-breakpoint
CREATE INDEX "bill_payment_reconciliation_workspace_status_idx"
	ON "bill_payment_reconciliation" (
		"workspace_id", "credit_card_bill_payment_id", "match_status"
	);
--> statement-breakpoint
CREATE INDEX "installment_series_workspace_status_idx"
	ON "installment_series" ("workspace_id", "status", "purchase_date");
--> statement-breakpoint
CREATE INDEX "recurring_series_workspace_status_next_idx"
	ON "recurring_series" ("workspace_id", "status", "next_expected_date");
