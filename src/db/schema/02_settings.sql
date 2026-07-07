-- 02_settings.sql — Voice-ordering configuration Odoo does not track.
-- Keyed by the Odoo pos_config (the "restaurant"). Supports FR5 (which languages
-- voice ordering accepts) and per-POS feature toggles.

CREATE TABLE IF NOT EXISTS voice_restaurant_settings (
    pos_config_id       integer PRIMARY KEY,              -- soft ref → Odoo pos_config.id
    -- Odoo res.lang codes the voice pipeline accepts, e.g. {'en_US','zh_CN'}.
    -- A customer may still speak a language outside this set (lower accuracy, §15).
    supported_languages text[]   NOT NULL DEFAULT '{}',
    default_language    text     NOT NULL DEFAULT 'en_US',
    voice_enabled       boolean  NOT NULL DEFAULT true,
    server_call_enabled boolean  NOT NULL DEFAULT true,   -- FR7 toggle
    created_at          timestamptz NOT NULL DEFAULT now(),
    updated_at          timestamptz NOT NULL DEFAULT now()
);
