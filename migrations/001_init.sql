CREATE TABLE users (
  id            BIGSERIAL PRIMARY KEY,
  email         TEXT NOT NULL,
  password_hash TEXT NOT NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Case-insensitive uniqueness: A@x.com and a@x.com are the same user
CREATE UNIQUE INDEX users_email_unique ON users (lower(email));

CREATE TABLE links (
  id          BIGSERIAL PRIMARY KEY,
  code        VARCHAR(16) NOT NULL UNIQUE,
  long_url    TEXT NOT NULL,
  user_id     BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at  TIMESTAMPTZ,
  click_count BIGINT NOT NULL DEFAULT 0
);

-- "List my links"
CREATE INDEX links_user_id_idx ON links (user_id);

CREATE TABLE clicks (
  id         BIGSERIAL PRIMARY KEY,
  link_id    BIGINT NOT NULL REFERENCES links(id) ON DELETE CASCADE,
  clicked_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  referrer   TEXT,
  user_agent TEXT,
  device     TEXT
);

-- Stats queries: filter by link, then by time range
CREATE INDEX clicks_link_time_idx ON clicks (link_id, clicked_at);