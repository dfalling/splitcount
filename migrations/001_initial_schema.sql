-- SplitCount initial schema

CREATE TABLE groups (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name       TEXT NOT NULL,
  join_code  CHAR(6) NOT NULL,
  currency   TEXT NOT NULL DEFAULT 'USD',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT chk_join_code_format CHECK (join_code ~ '^[A-Z0-9]{6}$'),
  CONSTRAINT uq_groups_join_code UNIQUE (join_code)
);

CREATE INDEX idx_groups_join_code ON groups(join_code);

CREATE TABLE members (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  group_id     UUID NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
  display_name TEXT NOT NULL,
  joined_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT uq_members_group_name UNIQUE (group_id, display_name)
);

CREATE INDEX idx_members_group_id ON members(group_id);

CREATE TABLE expenses (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  group_id     UUID NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
  paid_by      UUID NOT NULL REFERENCES members(id),
  created_by   UUID NOT NULL REFERENCES members(id),
  description  TEXT NOT NULL,
  amount       NUMERIC(12, 2) NOT NULL CHECK (amount > 0),
  currency     TEXT NOT NULL DEFAULT 'USD',
  receipt_note TEXT,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  deleted_at   TIMESTAMPTZ
);

CREATE INDEX idx_expenses_group_id ON expenses(group_id);
CREATE INDEX idx_expenses_active ON expenses(group_id, created_at DESC)
  WHERE deleted_at IS NULL;

CREATE TABLE expense_splits (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  expense_id UUID NOT NULL REFERENCES expenses(id) ON DELETE CASCADE,
  member_id  UUID NOT NULL REFERENCES members(id),
  amount     NUMERIC(12, 2) NOT NULL CHECK (amount > 0),
  CONSTRAINT uq_splits_expense_member UNIQUE (expense_id, member_id)
);

CREATE INDEX idx_splits_expense_id ON expense_splits(expense_id);
CREATE INDEX idx_splits_member_id ON expense_splits(member_id);

CREATE TABLE settlements (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  group_id   UUID NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
  paid_by    UUID NOT NULL REFERENCES members(id),
  paid_to    UUID NOT NULL REFERENCES members(id),
  amount     NUMERIC(12, 2) NOT NULL CHECK (amount > 0),
  note       TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT chk_settlements_different_members CHECK (paid_by <> paid_to)
);

CREATE INDEX idx_settlements_group_id ON settlements(group_id);

-- Atomic expense + splits creation
CREATE OR REPLACE FUNCTION create_expense_with_splits(
  p_group_id     UUID,
  p_paid_by      UUID,
  p_created_by   UUID,
  p_description  TEXT,
  p_amount       NUMERIC,
  p_currency     TEXT,
  p_receipt_note TEXT,
  p_splits       JSONB  -- [{ member_id: uuid, amount: numeric }]
) RETURNS UUID AS $$
DECLARE
  v_expense_id UUID;
  v_split      JSONB;
BEGIN
  INSERT INTO expenses (group_id, paid_by, created_by, description, amount, currency, receipt_note)
  VALUES (p_group_id, p_paid_by, p_created_by, p_description, p_amount, p_currency, p_receipt_note)
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
