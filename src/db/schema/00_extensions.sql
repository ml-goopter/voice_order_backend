-- Voice-Based Ordering — Data Schema
-- 00_extensions.sql
--
-- Run schema files in numeric order (00 → 07). Targets PostgreSQL 14+.
-- gen_random_uuid() is in core since PG13, so no pgcrypto is required.

-- pgvector: OPTIONAL. The Menu Candidate Matcher starts in-memory (design §7);
-- enable this only when moving to Postgres + pgvector (larger menus, multi-tenant
-- search, persistent indexing). Comment it out if the extension is unavailable.
CREATE EXTENSION IF NOT EXISTS vector;
