-- 04_carts.sql — Active-cart registry, recovery snapshots, and the idempotency
-- ledger. Redis is the hot store for active carts (design §9); these tables give
-- durability so a dropped connection or process loss never loses cart state, and
-- so a *later* voice session can re-attach to the same cart_id (FR4).
--
-- cart_id / session_id are OUR text identities (not Odoo's). Menu/table references
-- are Odoo integer ids (soft refs). Redis/DB hold no FK into Odoo.

CREATE TABLE IF NOT EXISTS carts (
    cart_id            text PRIMARY KEY,                  -- e.g. "cart_456"
    pos_config_id      integer NOT NULL,                  -- soft ref → Odoo pos_config.id
    restaurant_table_id integer,                          -- soft ref → Odoo restaurant_table.id
    status             text NOT NULL DEFAULT 'active'
                            CHECK (status IN ('active', 'confirmed', 'abandoned')),
    version            integer NOT NULL DEFAULT 0,        -- optimistic version (design §9)
    subtotal_cents     bigint  NOT NULL DEFAULT 0,
    tax_cents          bigint  NOT NULL DEFAULT 0,
    total_cents        bigint  NOT NULL DEFAULT 0,
    currency           text    NOT NULL DEFAULT 'USD',
    created_at         timestamptz NOT NULL DEFAULT now(),
    last_updated       timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_carts_pos_config_status
    ON carts (pos_config_id, status);

-- Periodic full-state snapshots of an active cart (design §9). Mirrors the Redis
-- value shape; a cart line references Odoo ids and carries a stable line_id the
-- Cart Module assigned:
--   { items: [ { line_id, product_tmpl_id, product_id, quantity,
--                modifiers: [ { ptav_id } ],        -- product_template_attribute_value ids
--                combo_id, combo_choices: [ product_id ] } ],
--     subtotal_cents, tax_cents, total_cents }
CREATE TABLE IF NOT EXISTS cart_snapshots (
    cart_id    text    NOT NULL REFERENCES carts (cart_id) ON DELETE CASCADE,
    version    integer NOT NULL,
    snapshot   jsonb   NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (cart_id, version)
);

-- Idempotency ledger for the Cart Module. Every final transcript carries a
-- request_id; the same request is never applied twice (design §9, §11).
CREATE TABLE IF NOT EXISTS processed_requests (
    request_id     text PRIMARY KEY,                      -- e.g. "voice_final_abc123"
    cart_id        text NOT NULL,
    outcome        text NOT NULL
                        CHECK (outcome IN ('applied', 'rejected', 'duplicate', 'superseded')),
    result_version integer,                               -- cart version after applying
    detail         jsonb,                                 -- rejected ops / reason (line_gone, stale_edit…)
    created_at     timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_processed_requests_cart
    ON processed_requests (cart_id, created_at);
