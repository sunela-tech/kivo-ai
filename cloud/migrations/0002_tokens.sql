-- Plans are metered in tokens: every generation costs tokens according to
-- the computation it takes (configs/plans.yaml), against a daily allowance.
ALTER TABLE usage ADD COLUMN tokens INTEGER NOT NULL DEFAULT 0;
