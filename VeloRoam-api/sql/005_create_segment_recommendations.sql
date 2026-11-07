-- Scores are nullable until each scoring model has been defined and calculated.
CREATE TABLE IF NOT EXISTS strava_segment_recommendations (
  segment_id BIGINT NOT NULL PRIMARY KEY,
  loop_score DECIMAL(5,2) NULL,
  climbing_score DECIMAL(5,2) NULL,
  long_distance_score DECIMAL(5,2) NULL,
  leisure_score DECIMAL(5,2) NULL,
  model_version VARCHAR(64) NULL,
  calculated_at TIMESTAMP NULL DEFAULT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  INDEX idx_segment_recommendations_loop (loop_score),
  INDEX idx_segment_recommendations_climbing (climbing_score),
  INDEX idx_segment_recommendations_distance (long_distance_score),
  INDEX idx_segment_recommendations_leisure (leisure_score),
  CONSTRAINT fk_segment_recommendations_segment FOREIGN KEY (segment_id)
    REFERENCES strava_segments(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
