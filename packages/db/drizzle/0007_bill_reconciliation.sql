CREATE TABLE "reconciliation_currency_tolerance" (
	"currency" char(3) PRIMARY KEY NOT NULL,
	"tolerance_amount" numeric(20, 6) NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "reconciliation_currency_tolerance_currency_ck" CHECK ("reconciliation_currency_tolerance"."currency" ~ '^[A-Z]{3}$'),
	CONSTRAINT "reconciliation_currency_tolerance_amount_ck" CHECK ("reconciliation_currency_tolerance"."tolerance_amount" >= 0)
);
--> statement-breakpoint
CREATE UNIQUE INDEX "bill_payment_reconciliation_active_transaction_uq" ON "bill_payment_reconciliation" USING btree ("workspace_id","financial_transaction_id") WHERE "bill_payment_reconciliation"."match_status" in ('AUTO_MATCHED', 'USER_CONFIRMED');
--> statement-breakpoint
INSERT INTO reconciliation_currency_tolerance (currency, tolerance_amount)
VALUES ('BRL', 0.010000);
--> statement-breakpoint
CREATE FUNCTION cashcount_validate_bill_child_evidence()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
	bill_account_id uuid;
	bill_currency char(3);
	matched_transaction_id uuid;
	transaction_account_id uuid;
	transaction_bill_id uuid;
	transaction_currency char(3);
BEGIN
	SELECT b.financial_account_id, b.currency
	INTO bill_account_id, bill_currency
	FROM credit_card_bill b
	WHERE b.workspace_id = NEW.workspace_id
		AND b.id = NEW.credit_card_bill_id;

	IF FOUND AND NEW.currency <> bill_currency THEN
		RAISE EXCEPTION 'bill child currency must match its bill currency'
			USING ERRCODE = 'check_violation';
	END IF;

	matched_transaction_id := nullif(to_jsonb(NEW) ->> TG_ARGV[0], '')::uuid;
	IF matched_transaction_id IS NULL THEN
		RETURN NEW;
	END IF;

	SELECT
		e.financial_account_id,
		e.credit_card_bill_id,
		e.analytics_currency
	INTO transaction_account_id, transaction_bill_id, transaction_currency
	FROM v_financial_transaction_effective e
	WHERE e.workspace_id = NEW.workspace_id
		AND e.id = matched_transaction_id;

	IF FOUND AND (
		transaction_account_id <> bill_account_id
		OR transaction_currency <> bill_currency
		OR (transaction_bill_id IS NOT NULL AND transaction_bill_id <> NEW.credit_card_bill_id)
	) THEN
		RAISE EXCEPTION 'matched card transaction must belong to the bill account and currency'
			USING ERRCODE = 'check_violation';
	END IF;

	RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER credit_card_bill_payment_evidence_trg
BEFORE INSERT OR UPDATE OF
	workspace_id,
	credit_card_bill_id,
	currency,
	matched_card_transaction_id
ON credit_card_bill_payment
FOR EACH ROW
EXECUTE FUNCTION cashcount_validate_bill_child_evidence('matched_card_transaction_id');
--> statement-breakpoint
CREATE TRIGGER credit_card_bill_finance_charge_evidence_trg
BEFORE INSERT OR UPDATE OF
	workspace_id,
	credit_card_bill_id,
	currency,
	matched_transaction_id
ON credit_card_bill_finance_charge
FOR EACH ROW
EXECUTE FUNCTION cashcount_validate_bill_child_evidence('matched_transaction_id');
--> statement-breakpoint
CREATE FUNCTION cashcount_validate_active_bill_payment_reconciliation()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
	payment_amount numeric(20, 6);
	payment_currency char(3);
	payment_date_value date;
	transaction_amount numeric(20, 6);
	transaction_currency char(3);
	transaction_date_value date;
	transaction_direction text;
	transaction_role text;
	transaction_status text;
	transaction_deleted_at timestamptz;
	tolerance numeric(20, 6);
BEGIN
	IF NEW.match_status NOT IN ('AUTO_MATCHED', 'USER_CONFIRMED') THEN
		RETURN NEW;
	END IF;

	SELECT p.amount, p.currency, p.payment_date
	INTO payment_amount, payment_currency, payment_date_value
	FROM credit_card_bill_payment p
	WHERE p.workspace_id = NEW.workspace_id
		AND p.id = NEW.credit_card_bill_payment_id;

	SELECT
		e.analytics_amount_signed,
		e.analytics_currency,
		e.transaction_local_date,
		e.system_direction,
		e.effective_financial_role,
		e.status,
		e.deleted_at
	INTO
		transaction_amount,
		transaction_currency,
		transaction_date_value,
		transaction_direction,
		transaction_role,
		transaction_status,
		transaction_deleted_at
	FROM v_financial_transaction_effective e
	JOIN financial_account a
		ON a.workspace_id = e.workspace_id
		AND a.id = e.financial_account_id
		AND a.account_type IN ('CHECKING', 'SAVINGS')
	WHERE e.workspace_id = NEW.workspace_id
		AND e.id = NEW.financial_transaction_id;

	IF payment_amount IS NULL OR transaction_amount IS NULL THEN
		RAISE EXCEPTION 'active reconciliation requires compatible payment and transaction amounts'
			USING ERRCODE = 'check_violation';
	END IF;

	IF payment_currency <> transaction_currency THEN
		RAISE EXCEPTION 'active reconciliation currencies must match'
			USING ERRCODE = 'check_violation';
	END IF;

	SELECT configured.tolerance_amount
	INTO tolerance
	FROM reconciliation_currency_tolerance configured
	WHERE configured.currency = payment_currency;

	IF tolerance IS NULL THEN
		RAISE EXCEPTION 'active reconciliation requires an explicit currency tolerance'
			USING ERRCODE = 'check_violation';
	END IF;

	IF abs(abs(transaction_amount) - payment_amount) > tolerance THEN
		RAISE EXCEPTION 'active reconciliation amount is outside currency tolerance'
			USING ERRCODE = 'check_violation';
	END IF;

	IF abs(transaction_date_value - payment_date_value) > 2 THEN
		RAISE EXCEPTION 'active reconciliation date is outside the two-day window'
			USING ERRCODE = 'check_violation';
	END IF;

	IF transaction_direction <> 'OUTFLOW'
		OR transaction_role <> 'CARD_BILL_PAYMENT'
		OR transaction_status = 'DELETED'
		OR transaction_deleted_at IS NOT NULL THEN
		RAISE EXCEPTION 'active reconciliation requires a live deposit-account bill-payment outflow'
			USING ERRCODE = 'check_violation';
	END IF;

	IF NEW.match_status = 'USER_CONFIRMED'
		AND nullif(trim(NEW.confirmed_by), '') IS NULL THEN
		RAISE EXCEPTION 'user-confirmed reconciliation requires a confirming actor'
			USING ERRCODE = 'check_violation';
	END IF;

	RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER bill_payment_reconciliation_evidence_trg
BEFORE INSERT OR UPDATE OF
	workspace_id,
	credit_card_bill_payment_id,
	financial_transaction_id,
	match_status,
	matched_at,
	confirmed_by
ON bill_payment_reconciliation
FOR EACH ROW
EXECUTE FUNCTION cashcount_validate_active_bill_payment_reconciliation();
--> statement-breakpoint
CREATE OR REPLACE VIEW "v_credit_card_bill_reconciliation" AS
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
		sum(abs(e.analytics_amount_signed)) AS confirmed_bank_payment_total,
		count(DISTINCT p.id) AS confirmed_bank_payment_count
	FROM credit_card_bill_payment p
	JOIN bill_payment_reconciliation r
		ON r.workspace_id = p.workspace_id
		AND r.credit_card_bill_payment_id = p.id
		AND r.match_status IN ('AUTO_MATCHED', 'USER_CONFIRMED')
	JOIN reconciliation_currency_tolerance tolerance
		ON tolerance.currency = p.currency
	JOIN v_financial_transaction_effective e
		ON e.workspace_id = r.workspace_id
		AND e.id = r.financial_transaction_id
		AND e.effective_financial_role = 'CARD_BILL_PAYMENT'
		AND e.system_direction = 'OUTFLOW'
		AND e.status <> 'DELETED'
		AND e.deleted_at IS NULL
		AND e.analytics_currency = p.currency
		AND e.analytics_amount_signed IS NOT NULL
		AND abs(abs(e.analytics_amount_signed) - p.amount) <= tolerance.tolerance_amount
		AND abs(e.transaction_local_date - p.payment_date) <= 2
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
		tolerance.tolerance_amount::numeric AS tolerance_amount,
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
	LEFT JOIN reconciliation_currency_tolerance tolerance
		ON tolerance.currency = b.currency
)
SELECT
	r.*,
	CASE
		WHEN r.bill_total IS NULL THEN 'UNKNOWN'
		WHEN r.tolerance_amount IS NULL THEN 'TOLERANCE_REQUIRED'
		WHEN r.unconverted_transaction_count > 0 OR r.unresolved_item_count > 0
			THEN 'NEEDS_REVIEW'
		WHEN abs(r.difference_amount) <= r.tolerance_amount THEN 'RECONCILED'
		ELSE 'NEEDS_REVIEW'
	END AS reconciliation_status
FROM reconciliation r;
