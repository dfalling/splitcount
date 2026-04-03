ALTER TABLE expenses
  ADD COLUMN date DATE NOT NULL DEFAULT CURRENT_DATE;

CREATE OR REPLACE FUNCTION create_expense_with_splits(
  p_group_id          UUID,
  p_paid_by           UUID,
  p_created_by        UUID,
  p_description       TEXT,
  p_amount            NUMERIC,
  p_currency          TEXT,
  p_receipt_note      TEXT,
  p_splits            JSONB,
  p_original_amount   NUMERIC DEFAULT NULL,
  p_original_currency TEXT    DEFAULT NULL,
  p_date              DATE    DEFAULT NULL  -- NULL means use CURRENT_DATE
) RETURNS UUID AS $$
DECLARE
  v_expense_id UUID;
  v_split      JSONB;
BEGIN
  INSERT INTO expenses (
    group_id, paid_by, created_by, description,
    amount, currency, receipt_note,
    original_amount, original_currency,
    date
  )
  VALUES (
    p_group_id, p_paid_by, p_created_by, p_description,
    p_amount, p_currency, p_receipt_note,
    p_original_amount, p_original_currency,
    COALESCE(p_date, CURRENT_DATE)
  )
  RETURNING id INTO v_expense_id;

  FOR v_split IN SELECT * FROM jsonb_array_elements(p_splits) LOOP
    INSERT INTO expense_splits (expense_id, member_id, amount)
    VALUES (
      v_expense_id,
      (v_split->>'member_id')::UUID,
      (v_split->>'amount')::NUMERIC
    );
  END LOOP;

  RETURN v_expense_id;
END;
$$ LANGUAGE plpgsql;
