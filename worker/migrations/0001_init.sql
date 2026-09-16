-- Eynap 评价与下载计数
-- 字段与本地 store.json 的 reviews 保持一致，迁移时零转换

CREATE TABLE IF NOT EXISTS reviews (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  author     TEXT    NOT NULL DEFAULT '匿名',
  text       TEXT    NOT NULL,
  feature    INTEGER NOT NULL CHECK (feature   BETWEEN 1 AND 5),
  effect     INTEGER NOT NULL CHECK (effect    BETWEEN 1 AND 5),
  stability  INTEGER NOT NULL CHECK (stability BETWEEN 1 AND 5),
  version    TEXT,                       -- 评价针对哪个版本，便于看版本间变化
  created_at TEXT    NOT NULL DEFAULT (datetime('now')),
  -- 审核：默认直接可见；出现垃圾内容时可改为默认 0 转为先审后发
  visible    INTEGER NOT NULL DEFAULT 1,
  -- 反垃圾用，不对外暴露
  ip_hash    TEXT
);

CREATE INDEX IF NOT EXISTS idx_reviews_visible ON reviews (visible, id DESC);
CREATE INDEX IF NOT EXISTS idx_reviews_iphash  ON reviews (ip_hash, created_at);

-- 计数器：下载量等
CREATE TABLE IF NOT EXISTS counters (
  key   TEXT PRIMARY KEY,
  value INTEGER NOT NULL DEFAULT 0
);

INSERT OR IGNORE INTO counters (key, value) VALUES ('downloads', 0);
