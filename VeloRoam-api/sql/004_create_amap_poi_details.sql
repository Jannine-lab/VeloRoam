-- Search responses already stored in hot_points are not necessarily full POI details.
CREATE TABLE IF NOT EXISTS amap_poi_details (
  hot_point_id BIGINT NOT NULL PRIMARY KEY,
  source_type VARCHAR(32) NOT NULL DEFAULT 'search',
  raw_detail JSON NOT NULL,
  fetched_at TIMESTAMP NULL DEFAULT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  INDEX idx_amap_poi_details_fetched_at (fetched_at),
  CONSTRAINT fk_amap_poi_details_point FOREIGN KEY (hot_point_id)
    REFERENCES hot_points(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
