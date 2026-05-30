import { planRouteService } from './services/googleMapsService';

async function testMockRoute() {
  console.log('🚀 Starting local verification of planRouteService (Mock mode)...');
  
  const origin = { lat: 30.2741, lng: 120.1551 }; // West Lake, Hangzhou
  const destination = { lat: 30.5962, lng: 119.8543 }; // Moganshan, Huzhou
  const waypoints = [
    { lat: 30.4567, lng: 120.0123 } // Midpoint
  ];

  try {
    const routes = await planRouteService(origin, destination, waypoints);
    
    console.log(`✅ Service completed successfully! Generated ${routes.length} alternative routes.`);
    
    routes.forEach((route, idx) => {
      console.log(`\n--- 🌟 Alternative Route [${idx + 1}] ---`);
      console.log(`📏 Total Distance: ${route.distanceKm} km`);
      console.log(`⏱️ Estimated Duration: ${route.durationMin} mins`);
      console.log(`⛰️ Total Ascent: ${route.totalAscentM} meters`);
      console.log(`📉 Total Descent: ${route.totalDescentM} meters`);
      console.log(`📈 Max Slope: ${route.maxSlopePercent}%`);
      console.log(`💎 VeloRoam Comfort Score: ${route.comfortScore}%`);
      console.log(`🌸 VeloRoam Scenic Rating: ${route.scenicRating} / 5.0`);
      console.log(`🚥 VeloRoam Traffic Lights count: ${route.trafficLightsCount} signals`);
      console.log(`🔄 VeloRoam Continuity Index: ${route.continuityScore}%`);
      console.log(`📍 Encoded Polyline string length: ${route.polyline.length}`);
    });

    const primaryRoute = routes[0];
    console.log('\n🔍 Primary Route Sample Elevation Data Points (First 5):');
    console.table(primaryRoute.elevationPoints.slice(0, 5));
    
    console.log('🔍 Primary Route Sample Elevation Data Points (Last 5):');
    console.table(primaryRoute.elevationPoints.slice(-5));
    
  } catch (error) {
    console.error('❌ Service failed with error:', error);
  }
}

testMockRoute();
