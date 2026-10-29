-- Persist Strava's native popularity signals from GET /segments/{id}.
-- `raw_score` remains the VeloRoam custom score for backwards compatibility.

ALTER TABLE strava_segments
  ADD COLUMN star_count INT UNSIGNED NULL AFTER raw_score,
  ADD COLUMN athlete_count INT UNSIGNED NULL AFTER star_count,
  ADD COLUMN effort_count BIGINT UNSIGNED NULL AFTER athlete_count,
  ADD COLUMN strava_stats_updated_at TIMESTAMP NULL DEFAULT NULL AFTER effort_count,
  ADD INDEX idx_strava_native_popularity (star_count DESC, athlete_count DESC);
