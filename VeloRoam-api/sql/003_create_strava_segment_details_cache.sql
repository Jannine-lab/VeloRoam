-- Transient segment details only. Application must purge expired rows and honor
-- Strava's retention and access requirements; the table does not expire itself.
CREATE TABLE IF NOT EXISTS strava_segment_details_cache (
  segment_id BIGINT NOT NULL PRIMARY KEY,
  detail_json JSON NOT NULL,
  star_count INT UNSIGNED NULL,
  athlete_count INT UNSIGNED NULL,
  effort_count BIGINT UNSIGNED NULL,
  fetched_at DATETIME NOT NULL,
  expires_at DATETIME NOT NULL,
  INDEX idx_segment_details_expiry (expires_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
