-- 06_voice.sql — Voice sessions, final transcripts, and clarification turns.
-- Supports: FR1 (initiate a voice order), FR2 (transcription — only FINAL
-- transcripts are persisted; partials are display-only, design §3/§5), FR4 (a
-- later session attaches to the same cart_id), and the clarification loop (§6).
-- Menu/table references are Odoo integer ids; session/cart/request ids are ours.

CREATE TABLE IF NOT EXISTS voice_sessions (
    session_id          text PRIMARY KEY,                 -- e.g. "voice_session_123"
    cart_id             text NOT NULL,                    -- cart this session edits (soft ref)
    pos_config_id       integer NOT NULL,                 -- soft ref → Odoo pos_config.id
    restaurant_table_id integer,                          -- soft ref → Odoo restaurant_table.id
    status              text NOT NULL DEFAULT 'idle'
                            CHECK (status IN ('idle', 'listening', 'interrupted', 'ended', 'failed')),
    spoken_language     text,                             -- detected/declared res.lang code (may be unsupported, §15)
    started_at          timestamptz,
    ended_at            timestamptz,
    created_at          timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_voice_sessions_cart ON voice_sessions (cart_id);

-- Final transcripts only. request_id is the idempotency key that flows to the Cart
-- Module (design §9, §11). Partial transcripts never reach here.
CREATE TABLE IF NOT EXISTS transcripts (
    request_id    text PRIMARY KEY,                       -- e.g. "voice_final_abc123"
    session_id    text NOT NULL REFERENCES voice_sessions (session_id) ON DELETE CASCADE,
    cart_id       text NOT NULL,
    pos_config_id integer NOT NULL,
    text          text NOT NULL,
    language      text,                                   -- res.lang code as recognised
    created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_transcripts_cart ON transcripts (cart_id, created_at);

-- Clarification turns raised by Order Understanding (design §6). The thread is the
-- cart, so at most one clarification may be open per cart at a time (partial unique
-- index). A timeout expires a stalled turn so the cart never freezes (design §9).
CREATE TABLE IF NOT EXISTS clarifications (
    clarification_id bigserial PRIMARY KEY,
    cart_id          text NOT NULL,
    session_id       text REFERENCES voice_sessions (session_id) ON DELETE SET NULL,
    request_id       text,                                -- the turn that raised it
    question         text NOT NULL,
    options          jsonb,                               -- e.g. ["one without mayo","both without mayo"]
    answer           text,
    status           text NOT NULL DEFAULT 'pending'
                        CHECK (status IN ('pending', 'answered', 'expired', 'cancelled')),
    created_at       timestamptz NOT NULL DEFAULT now(),
    answered_at      timestamptz
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_clarifications_one_open_per_cart
    ON clarifications (cart_id) WHERE status = 'pending';
