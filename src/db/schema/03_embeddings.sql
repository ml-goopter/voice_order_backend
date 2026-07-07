-- 03_embeddings.sql — OPTIONAL persistent vector store for the Candidate Matcher.
-- The matcher starts in-memory (design §7); this is the "Postgres + pgvector"
-- upgrade path. One row per embedded string, so a product has many vectors: its
-- name per Odoo language (from product_template.name jsonb), alternative_name,
-- public_description, plus a vector per attribute value / combo (design §7, §15).
-- References Odoo rows by integer id (soft ref). Requires 00's `vector` extension.

CREATE TABLE IF NOT EXISTS menu_embeddings (
    id                        bigserial PRIMARY KEY,
    pos_config_id             integer NOT NULL,           -- soft ref → Odoo pos_config.id
    source_type               text NOT NULL CHECK (source_type IN (
                                  'product_name', 'product_alt_name', 'product_description',
                                  'attribute_value_name', 'combo_name')),
    product_tmpl_id           integer,                    -- set for product_* sources
    product_attribute_value_id integer,                   -- set for attribute_value_name
    combo_id                  integer,                    -- set for combo_name
    language                  text,                       -- Odoo res.lang code; NULL if non-translatable
    content                   text NOT NULL,              -- exact text that was embedded
    model                     text NOT NULL,              -- embedding model id (re-embed on change, §7)
    embedding                 vector(1536) NOT NULL,      -- match your model's dimension
    created_at                timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_menu_embeddings_pos_config
    ON menu_embeddings (pos_config_id);
CREATE INDEX IF NOT EXISTS idx_menu_embeddings_product
    ON menu_embeddings (product_tmpl_id);

-- Approximate nearest-neighbour index for cosine similarity search.
CREATE INDEX IF NOT EXISTS idx_menu_embeddings_vector
    ON menu_embeddings USING ivfflat (embedding vector_cosine_ops) WITH (lists = 100);
