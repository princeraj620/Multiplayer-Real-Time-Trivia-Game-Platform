-- BuzzArena schema. PostgreSQL is the durable source of truth:
-- users and sessions, the question bank (answers encrypted), games and final results.
-- Live game state (the current question, answers, the leaderboard) lives in Redis during a game.

CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TYPE user_role AS ENUM ('player', 'host', 'admin');
CREATE TYPE refresh_status AS ENUM ('ACTIVE', 'USED', 'REVOKED');
CREATE TYPE game_status AS ENUM ('SCHEDULED', 'LIVE', 'FINISHED', 'CANCELLED');

CREATE TABLE users (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email         text NOT NULL,
  name          text NOT NULL,
  password_hash text,                          -- argon2id; NULL for load-test bots (they cannot log in)
  role          user_role NOT NULL DEFAULT 'player',
  is_bot        boolean NOT NULL DEFAULT false,
  created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX uq_users_email ON users (lower(email));

-- Refresh tokens: only a SHA-256 hash is stored. Each use rotates the token; all tokens from one
-- login share a family. Using an already-used token means it was stolen: the whole family is revoked.
CREATE TABLE refresh_tokens (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  family_id   uuid NOT NULL,
  token_hash  text NOT NULL UNIQUE,
  status      refresh_status NOT NULL DEFAULT 'ACTIVE',
  expires_at  timestamptz NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  used_at     timestamptz,
  user_agent  text
);
CREATE INDEX idx_refresh_family ON refresh_tokens (family_id);
CREATE INDEX idx_refresh_user_active ON refresh_tokens (user_id) WHERE status = 'ACTIVE';

-- JWT signing keys (Ed25519). The private key is encrypted at rest (AES-256-GCM).
CREATE TABLE signing_keys (
  kid         text PRIMARY KEY,
  public_jwk  jsonb NOT NULL,
  private_enc text NOT NULL,
  active      boolean NOT NULL DEFAULT true,
  created_at  timestamptz NOT NULL DEFAULT now(),
  retired_at  timestamptz
);
CREATE UNIQUE INDEX uq_signing_keys_one_active ON signing_keys (active) WHERE active;

CREATE TABLE question_packs (
  id          serial PRIMARY KEY,
  slug        text NOT NULL UNIQUE,
  title       text NOT NULL,
  category    text NOT NULL,
  description text NOT NULL,
  emoji       text NOT NULL DEFAULT '❓'
);

-- The correct answer is encrypted with a data key and bound to the question id (AAD), so a copied
-- ciphertext cannot be moved to another question. Clients never receive it before the deadline.
CREATE TABLE questions (
  id          serial PRIMARY KEY,
  pack_id     int NOT NULL REFERENCES question_packs(id) ON DELETE CASCADE,
  text        text NOT NULL,
  options     text[] NOT NULL CHECK (array_length(options, 1) BETWEEN 2 AND 4),
  correct_enc text NOT NULL,
  fact        text,
  difficulty  smallint NOT NULL DEFAULT 2 CHECK (difficulty BETWEEN 1 AND 3),
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_questions_pack ON questions (pack_id);

CREATE TABLE games (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  title          text NOT NULL,
  host_id        uuid NOT NULL REFERENCES users(id),
  pack_id        int NOT NULL REFERENCES question_packs(id),
  status         game_status NOT NULL DEFAULT 'SCHEDULED',
  question_ids   int[] NOT NULL,
  question_sec   int NOT NULL DEFAULT 10 CHECK (question_sec BETWEEN 5 AND 60),
  scheduled_at   timestamptz NOT NULL DEFAULT now(),
  started_at     timestamptz,
  finished_at    timestamptz,
  -- Fencing on the database too: final results are only accepted from a leader whose token is
  -- at least the highest token that has written here.
  leader_token   bigint NOT NULL DEFAULT 0,
  finished_by    text,
  player_count   int NOT NULL DEFAULT 0,
  survivor_count int NOT NULL DEFAULT 0,
  created_at     timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_games_status ON games (status, scheduled_at);
CREATE INDEX idx_games_host ON games (host_id, created_at DESC);

CREATE TABLE game_results (
  game_id        uuid NOT NULL REFERENCES games(id) ON DELETE CASCADE,
  user_id        uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  score          int NOT NULL,
  rank           int NOT NULL,
  correct_count  int NOT NULL,
  survived       boolean NOT NULL,
  PRIMARY KEY (game_id, user_id)
);
CREATE INDEX idx_results_user ON game_results (user_id);
CREATE INDEX idx_results_rank ON game_results (game_id, rank);

-- Security audit log: role changes, key rotations, stolen refresh tokens, game starts.
CREATE TABLE audit_log (
  id        bigserial PRIMARY KEY,
  at        timestamptz NOT NULL DEFAULT now(),
  actor_id  uuid,
  action    text NOT NULL,
  target    text,
  detail    jsonb NOT NULL DEFAULT '{}'
);
CREATE INDEX idx_audit_at ON audit_log (at DESC);
