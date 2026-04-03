-- Store original amount/currency when an expense is logged in a foreign currency.
-- `amount` + `currency` always hold the group-currency value used for balance math.
-- `original_amount` + `original_currency` hold the raw values from the receipt.

ALTER TABLE expenses
  ADD COLUMN original_amount   NUMERIC(12, 2),
  ADD COLUMN original_currency TEXT,
  ADD CONSTRAINT chk_original_currency_paired
    CHECK (
      (original_amount IS NULL) = (original_currency IS NULL)
    );

-- Replace the atomic insert function to accept the two new optional params
CREATE OR REPLACE FUNCTION create_expense_with_splits(
  p_group_id          UUID,
  p_paid_by           UUID,
  p_created_by        UUID,
  p_description       TEXT,
  p_amount            NUMERIC,
  p_currency          TEXT,
  p_receipt_note      TEXT,
  p_splits            JSONB,  -- [{ member_id: uuid, amount: numeric }]
  p_original_amount   NUMERIC DEFAULT NULL,
  p_original_currency TEXT    DEFAULT NULL
) RETURNS UUID AS $$
DECLARE
  v_expense_id UUID;
  v_split      JSONB;
BEGIN
  INSERT INTO expenses (
    group_id, paid_by, created_by, description,
    amount, currency, receipt_note,
    original_amount, original_currency
  )
  VALUES (
    p_group_id, p_paid_by, p_created_by, p_description,
    p_amount, p_currency, p_receipt_note,
    p_original_amount, p_original_currency
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
