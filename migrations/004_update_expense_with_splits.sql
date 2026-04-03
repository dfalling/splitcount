-- Atomic expense + splits update
CREATE OR REPLACE FUNCTION update_expense_with_splits(
  p_expense_id        UUID,
  p_description       TEXT    DEFAULT NULL,
  p_amount            NUMERIC DEFAULT NULL,
  p_currency          TEXT    DEFAULT NULL,
  p_paid_by           UUID    DEFAULT NULL,
  p_date              DATE    DEFAULT NULL,
  p_receipt_note      TEXT    DEFAULT NULL,
  p_original_amount   NUMERIC DEFAULT NULL,
  p_original_currency TEXT    DEFAULT NULL,
  p_clear_original    BOOLEAN DEFAULT FALSE,
  p_splits            JSONB   DEFAULT NULL  -- [{ member_id: uuid, amount: numeric }]
) RETURNS UUID AS $$
DECLARE
  v_split JSONB;
  v_existing expenses%ROWTYPE;
BEGIN
  SELECT * INTO v_existing
  FROM expenses
  WHERE id = p_expense_id AND deleted_at IS NULL;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Expense % not found or already deleted', p_expense_id;
  END IF;

  UPDATE expenses SET
    description       = COALESCE(p_description, description),
    amount            = COALESCE(p_amount, amount),
    currency          = COALESCE(p_currency, currency),
    paid_by           = COALESCE(p_paid_by, paid_by),
    date              = COALESCE(p_date, date),
    receipt_note      = COALESCE(p_receipt_note, receipt_note),
    original_amount   = CASE
                          WHEN p_clear_original THEN NULL
                          ELSE COALESCE(p_original_amount, original_amount)
                        END,
    original_currency = CASE
                          WHEN p_clear_original THEN NULL
                          ELSE COALESCE(p_original_currency, original_currency)
                        END
  WHERE id = p_expense_id;

  IF p_splits IS NOT NULL THEN
    DELETE FROM expense_splits WHERE expense_id = p_expense_id;

    FOR v_split IN SELECT * FROM jsonb_array_elements(p_splits) LOOP
      INSERT INTO expense_splits (expense_id, member_id, amount)
      VALUES (
        p_expense_id,
        (v_split->>'member_id')::UUID,
        (v_split->>'amount')::NUMERIC
      );
    END LOOP;
  END IF;

  RETURN p_expense_id;
END;
$$ LANGUAGE plpgsql;
