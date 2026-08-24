CREATE OR REPLACE FUNCTION cashcount_validate_classification_rule_category_action()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
	action jsonb;
	category_code text;
	category_reference uuid;
BEGIN
	-- Preserve validation for any pre-versioned rules written before PF-052.
	IF NEW.actions ? 'setCategoryCode' THEN
		IF jsonb_typeof(NEW.actions -> 'setCategoryCode') <> 'string' THEN
			RAISE EXCEPTION 'classification rule setCategoryCode must be a string'
				USING ERRCODE = 'check_violation';
		END IF;

		category_code := nullif(trim(NEW.actions ->> 'setCategoryCode'), '');
		IF category_code IS NULL OR NOT EXISTS (
			SELECT 1
			FROM category c
			WHERE c.code = category_code
				AND c.is_active
				AND (c.workspace_id IS NULL OR c.workspace_id = NEW.workspace_id)
		) THEN
			RAISE EXCEPTION 'classification rule category is not visible in its workspace'
				USING ERRCODE = 'check_violation';
		END IF;
	END IF;

	IF NEW.actions ? 'operations' THEN
		IF jsonb_typeof(NEW.actions -> 'operations') <> 'array' THEN
			RAISE EXCEPTION 'classification rule operations must be an array'
				USING ERRCODE = 'check_violation';
		END IF;

		FOR action IN SELECT value FROM jsonb_array_elements(NEW.actions -> 'operations')
		LOOP
			IF action ->> 'type' = 'SET_CATEGORY' THEN
				IF jsonb_typeof(action -> 'categoryId') <> 'string' THEN
					RAISE EXCEPTION 'classification rule SET_CATEGORY categoryId must be a UUID string'
						USING ERRCODE = 'check_violation';
				END IF;

				BEGIN
					category_reference := (action ->> 'categoryId')::uuid;
				EXCEPTION WHEN invalid_text_representation THEN
					RAISE EXCEPTION 'classification rule SET_CATEGORY categoryId must be a UUID string'
						USING ERRCODE = 'check_violation';
				END;

				IF NOT EXISTS (
					SELECT 1
					FROM category c
					WHERE c.id = category_reference
						AND c.is_active
						AND (c.workspace_id IS NULL OR c.workspace_id = NEW.workspace_id)
				) THEN
					RAISE EXCEPTION 'classification rule category is not visible in its workspace'
						USING ERRCODE = 'check_violation';
				END IF;
			END IF;
		END LOOP;
	END IF;

	RETURN NEW;
END;
$$;
