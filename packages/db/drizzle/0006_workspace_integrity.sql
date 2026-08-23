CREATE FUNCTION cashcount_validate_classification_rule_category_action()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
	category_code text;
BEGIN
	IF NOT (NEW.actions ? 'setCategoryCode') THEN
		RETURN NEW;
	END IF;

	IF jsonb_typeof(NEW.actions -> 'setCategoryCode') <> 'string' THEN
		RAISE EXCEPTION 'classification rule setCategoryCode must be a string'
			USING ERRCODE = 'check_violation';
	END IF;

	category_code := nullif(trim(NEW.actions ->> 'setCategoryCode'), '');
	IF category_code IS NULL THEN
		RAISE EXCEPTION 'classification rule setCategoryCode must not be empty'
			USING ERRCODE = 'check_violation';
	END IF;

	IF NOT EXISTS (
		SELECT 1
		FROM category c
		WHERE c.code = category_code
			AND c.is_active
			AND (c.workspace_id IS NULL OR c.workspace_id = NEW.workspace_id)
	) THEN
		RAISE EXCEPTION 'classification rule category is not visible in its workspace'
			USING ERRCODE = 'check_violation';
	END IF;

	RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER classification_rule_category_action_visibility_trg
BEFORE INSERT OR UPDATE OF workspace_id, actions
ON classification_rule
FOR EACH ROW
EXECUTE FUNCTION cashcount_validate_classification_rule_category_action();
