# Point details and segment recommendations

Run `npm run init:recommendation-tables` against the intended database before deploying the updated hot-point crawler. The script requires existing `hot_points`, `strava_segments` and `strava_segment_details` tables. It creates the two tables and seeds existing records; re-running it preserves existing details and recommendation values. MySQL DDL commits separately from the transactional backfill.

`amap_poi_details` stores the existing AMap search response with `source_type = 'search'`; it does not claim to contain a full POI detail response. The crawler refreshes search records but does not overwrite records marked with another source type. Basic location and classification remain in `hot_points`.

`strava_segment_recommendations` initially contains rows for segments that already have details. Its four nullable scores and model metadata remain empty until scoring models are designed and calculated. New segments can be added by re-running the initializer or by a future scoring job. The table does not change `strava_segments.raw_score` or existing rankings.
