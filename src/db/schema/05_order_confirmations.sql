-- 05_order_confirmations.sql — Bridge from a confirmed voice cart to the Odoo POS
-- order that is the system of record. On customer confirmation (design §9, step 11)
-- the Cart Module writes a pos_order / pos_order_line in Odoo; this table records
-- that hand-off for traceability and idempotency (never submit the same cart twice).
--
-- The confirmed line items themselves live in Odoo pos_order_line and in the final
-- cart_snapshots row — they are NOT re-normalized here (Odoo owns order history).

CREATE TABLE IF NOT EXISTS voice_order_confirmations (
    confirmation_id bigserial PRIMARY KEY,
    cart_id         text    NOT NULL,                     -- our cart (soft ref → carts.cart_id)
    pos_config_id   integer NOT NULL,                     -- soft ref → Odoo pos_config.id
    restaurant_table_id integer,                          -- soft ref → Odoo restaurant_table.id
    cart_version    integer NOT NULL,                     -- cart version that was confirmed
    request_id      text    NOT NULL,                     -- idempotency key for the confirm action
    pos_order_id    integer,                              -- soft ref → Odoo pos_order.id (once created)
    status          text    NOT NULL DEFAULT 'pending'
                        CHECK (status IN ('pending', 'submitted', 'failed')),
    detail          jsonb,                                -- error/context if submission failed
    created_at      timestamptz NOT NULL DEFAULT now(),
    submitted_at    timestamptz,
    UNIQUE (request_id)                                   -- confirm-once per request
);
CREATE INDEX IF NOT EXISTS idx_order_confirmations_cart
    ON voice_order_confirmations (cart_id);
CREATE INDEX IF NOT EXISTS idx_order_confirmations_pos_order
    ON voice_order_confirmations (pos_order_id);
