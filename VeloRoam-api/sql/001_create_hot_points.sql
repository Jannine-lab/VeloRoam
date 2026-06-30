-- VeloRoam HotPoint schema for MySQL 8.x
-- Run this on the remote development database before enabling the AMap HotPoint crawler.
-- Requires the existing strava_segments table because hot_point_segment_links references it.

CREATE TABLE IF NOT EXISTS hot_points (
  id BIGINT AUTO_INCREMENT PRIMARY KEY,
  amap_poi_id VARCHAR(64) NOT NULL,
  name VARCHAR(255) NOT NULL,
  category ENUM('scenic', 'supply', 'rest', 'service', 'start_end') NOT NULL,
  amap_type VARCHAR(255),
  amap_type_code VARCHAR(64),
  lat DOUBLE NOT NULL,
  lng DOUBLE NOT NULL,
  gcj_lat DOUBLE NOT NULL,
  gcj_lng DOUBLE NOT NULL,
  geom POINT NOT NULL,
  address VARCHAR(512),
  district_adcode VARCHAR(16),
  district_name VARCHAR(64),
  business_area VARCHAR(255),
  tags JSON,
  photos JSON,
  raw_payload JSON,
  popularity_score DECIMAL(6, 2) NOT NULL DEFAULT 0,
  cyclist_score DECIMAL(6, 2) NOT NULL DEFAULT 0,
  route_relevance_score DECIMAL(6, 2) NOT NULL DEFAULT 0,
  confidence_score DECIMAL(6, 2) NOT NULL DEFAULT 0,
  nearby_segment_count INT NOT NULL DEFAULT 0,
  nearest_segment_distance_m DECIMAL(8, 2),
  best_nearby_segment_score DECIMAL(6, 2),
  avg_nearby_segment_score DECIMAL(6, 2),
  source VARCHAR(32) NOT NULL DEFAULT 'amap',
  status ENUM('active', 'hidden', 'needs_review') NOT NULL DEFAULT 'active',
  source_updated_at TIMESTAMP NULL DEFAULT NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE KEY uniq_amap_poi_id (amap_poi_id),
  SPATIAL INDEX idx_hot_points_geom (geom),
  INDEX idx_hot_points_category_score (category, cyclist_score DESC),
  INDEX idx_hot_points_district (district_adcode),
  INDEX idx_hot_points_status_score (status, cyclist_score DESC)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS hot_point_segment_links (
  id BIGINT AUTO_INCREMENT PRIMARY KEY,
  hot_point_id BIGINT NOT NULL,
  strava_segment_id BIGINT NOT NULL,
  distance_m DECIMAL(8, 2) NOT NULL,
  segment_score DECIMAL(6, 2) NOT NULL,
  relation_type ENUM('nearby_start', 'nearby_end') NOT NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE KEY uniq_hot_point_segment (hot_point_id, strava_segment_id),
  INDEX idx_hot_point_links_point (hot_point_id, distance_m),
  INDEX idx_hot_point_links_segment (strava_segment_id),
  CONSTRAINT fk_hot_point_links_point
    FOREIGN KEY (hot_point_id) REFERENCES hot_points(id)
    ON DELETE CASCADE,
  CONSTRAINT fk_hot_point_links_segment
    FOREIGN KEY (strava_segment_id) REFERENCES strava_segments(id)
    ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
