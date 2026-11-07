CREATE TABLE IF NOT EXISTS strava_segment_tag_evaluations (
  segment_id BIGINT NOT NULL,
  tag VARCHAR(32) NOT NULL,
  status ENUM('matched','not_matched','unknown') NOT NULL,
  reason_codes JSON NOT NULL,
  evidence JSON NOT NULL,
  algorithm_version VARCHAR(64) NOT NULL,
  reference_version CHAR(64) NULL,
  source_fingerprint CHAR(64) NOT NULL,
  evaluation_fingerprint CHAR(64) NOT NULL,
  source_fetched_at DATETIME NULL,
  calculated_at DATETIME(3) NOT NULL,
  run_id CHAR(36) NOT NULL,
  PRIMARY KEY (segment_id, tag),
  INDEX idx_segment_tag_lookup (tag, status, segment_id),
  INDEX idx_segment_tag_run (run_id),
  CONSTRAINT fk_segment_tag_segment FOREIGN KEY (segment_id) REFERENCES strava_segments(id) ON DELETE CASCADE,
  CONSTRAINT fk_segment_tag_run FOREIGN KEY (run_id) REFERENCES strava_segment_tag_runs(run_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
