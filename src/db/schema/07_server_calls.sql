-- 07_server_calls.sql — "Call server to the table" requests (FR7). A customer can
-- raise this by voice or UI; staff acknowledge and resolve. Table/POS are Odoo
-- integer ids; cart/session are our optional context (a call can happen without an
-- active order).

CREATE TABLE IF NOT EXISTS server_calls (
    call_id             bigserial PRIMARY KEY,
    pos_config_id       integer NOT NULL,                 -- soft ref → Odoo pos_config.id
    restaurant_table_id integer NOT NULL,                 -- soft ref → Odoo restaurant_table.id
    cart_id             text,
    session_id          text,
    status              text NOT NULL DEFAULT 'open'
                            CHECK (status IN ('open', 'acknowledged', 'resolved', 'cancelled')),
    note                text,                             -- optional free text, e.g. "needs water"
    created_at          timestamptz NOT NULL DEFAULT now(),
    acknowledged_at     timestamptz,
    resolved_at         timestamptz
);

-- Staff dashboards poll open calls per POS; a table has at most one active call.
CREATE INDEX IF NOT EXISTS idx_server_calls_pos_config_status
    ON server_calls (pos_config_id, status);
CREATE UNIQUE INDEX IF NOT EXISTS uq_server_calls_one_open_per_table
    ON server_calls (restaurant_table_id) WHERE status IN ('open', 'acknowledged');
