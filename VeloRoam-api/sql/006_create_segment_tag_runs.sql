CREATE TABLE IF NOT EXISTS strava_segment_tag_runs (
  run_id CHAR(36) NOT NULL PRIMARY KEY,
  algorithm_version VARCHAR(64) NOT NULL,
  reference_version CHAR(64) NOT NULL,
  source_snapshot_hash CHAR(64) NOT NULL,
  source_count INT UNSIGNED NOT NULL,
  target_count INT UNSIGNED NOT NULL,
  changed_count INT UNSIGNED NOT NULL,
  reference_snapshot JSON NOT NULL,
  summary JSON NOT NULL,
  started_at DATETIME(3) NOT NULL,
  completed_at DATETIME(3) NOT NULL,
  INDEX idx_segment_tag_runs_completed (completed_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
