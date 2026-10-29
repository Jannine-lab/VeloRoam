/* ==========================================================================
   VeloRoam 骑行路线规划 - 核心网页脚本 (Apple Maps Style)
   ========================================================================== */

// 自动检测 API 宿主地址：本机开发走 localhost，局域网访问走当前页面 host。
// 如需临时指定，可在 URL 后加 ?apiHost=192.168.x.x:3000
const apiHostOverride = new URLSearchParams(window.location.search).get('apiHost');
const currentHost = window.location.hostname;
const isLocalPage = !currentHost || currentHost === 'localhost' || currentHost === '127.0.0.1';
const detectedApiHost = apiHostOverride || (isLocalPage ? '127.0.0.1:3000' : `${currentHost}:3000`);

const API_BASE_URL = window.location.protocol === 'https:' && !detectedApiHost.includes(':3000')
  ? `https://${detectedApiHost}/api`
  : `http://${detectedApiHost}/api`;

const CARTO_BASEMAP_KEY = 'cb1_48j3_1_41026acd7b8849228daa74f1';
const CARTO_ATTRIBUTION = '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors &copy; <a href="https://carto.com/attributions">CARTO</a>';
const getCartoTileUrl = (style) => `https://{s}.basemaps.cartocdn.com/rastertiles/${style}/{z}/{x}/{y}{r}.png?key=${CARTO_BASEMAP_KEY}`;
const MAP_THEMES = [
  { id: 'dark', tile: 'dark_all', label: '黑底' },
  { id: 'light', tile: 'light_all', label: '白底' },
  { id: 'voyager', tile: 'voyager', label: '彩色' }
];
const MAP_THEME_STORAGE_KEY = 'veloroam-map-theme';

// 热门点位展示暂时关闭。保留完整实现，后续改为 true 即可恢复。
const HOT_POINT_DISPLAY_ENABLED = false;

// 全局状态管理
let map = null;
let mapTileLayer = null;
let currentTheme = 'dark'; // 'dark', 'light' 或 'voyager'
let elevationChart = null;
let routeData = null;
let routeDataList = [];
let activeRouteIndex = 0;

// 地图图层组，方便重绘和清理
let markerGroup = null;
let polylineGroup = null;
let stravaGroup = null;
let hotPointGroup = null;
let hotPointHeatmapLayer = null;
let scrubbedRiderMarker = null;
let locationSearchMarker = null;
let locationSearchResultsCache = [];
let locationSearchRequestId = 0;
let selectedPlace = null;
let placeRouteActive = false;
let placeRouteLayer = null;
let placeRouteRequest = null;
let placeRouteRequestId = 0;
let loadedStravaSegments = new Map(); // 缓存和去重当前渲染在地图上的 Strava 路段 (ID -> Group)
let loadedHotPoints = new Map();      // 缓存当前视口已渲染的热门点位 (ID -> Marker)
let minScoreFilter = 50;              // 评分筛选阈值 (随 Zoom 动态变化)
const allFetchedSegments = new Map(); // 全局记录该会话抓取到的所有 Strava 原始路段数据 (ID -> Segment)
const allFetchedHotPoints = new Map();// 全局记录该会话抓取到的热门点位数据 (ID -> HotPoint)
let selectedSegmentId = null;         // 当前选中正在查看的路段 ID (用于未选路段淡化)
let selectedHotPointId = null;        // 当前选中点位 ID
let hotPointHeatmapEnabled = HOT_POINT_DISPLAY_ENABLED; // 热门点位热力图图层开关
let hotPointHeatmapLegendTimer = null;// 热力图图例短暂提示计时器
let hotPointHeatmapLegendEligible = false;
let hotPointHeatmapLegendInitialDelayTimer = null;
let hotPointHeatmapLegendInitialDelayActive = true;
const HOTPOINT_HEATMAP_LEGEND_INITIAL_DELAY_MS = 5000;
const HOTPOINT_HEATMAP_LEGEND_VISIBLE_MS = 5000;
const HOME_RECOMMENDATIONS_ENABLED = false; // 暂时停用首页推荐路线
const HOME_RECOMMENDATION_MIN_ZOOM = 15;
let homeRecommendationRequestId = 0;
let homeRecommendationSearchOpen = false;
let homeRecommendationSegments = [];
let homeRecommendationSelected = null;
let homeRecommendationRouteLayer = null;
let homeRecommendationRouteRequest = null;
const homeRecommendationRouteCache = new Map();



// 规划坐标状态 (经纬度，不再直接呈现在输入框中)
let origin = null;        // 起点默认空，等待 GPS 定位或手动输入
let originLocationSource = 'unknown';
let originGpsTimestamp = 0;
let ideaGreetingLocation = null;
let resolveIdeaLocationReady;
const ideaLocationReady = new Promise(resolve => { resolveIdeaLocationReady = resolve; });
function setIdeaGreetingLocation(location, source, city = '') {
  ideaGreetingLocation = location ? { location, source, city, recordedAt: Date.now() } : null;
  resolveIdeaLocationReady();
}

let destination = null;   // 终点默认空，默认不要有终点
let waypoints = [];       // 动态途经点对象数组: [{ coord: {lat, lng}, name: "显示名称" }]

// 精选预置优质骑行路线 (推荐目的地环线数据)
const PRESET_LOOPS = {
  1: {
    name: '西湖茶园环线 (32km)',
    originName: '西湖苏堤',
    origin: { lat: 30.2415, lng: 120.1384 },
    destinationName: '龙井茶翁村',
    destination: { lat: 30.2223, lng: 120.1084 },
    waypoints: [
      { name: '九溪烟树', coord: { lat: 30.1982, lng: 120.1185 } }
    ]
  },
  2: {
    name: '青山湖环线 (42km)',
    originName: '青山湖景区大门',
    origin: { lat: 30.2458, lng: 119.7824 },
    destinationName: '八百里半岛',
    destination: { lat: 30.2562, lng: 119.8243 },
    waypoints: [
      { name: '水上森林公园', coord: { lat: 30.2641, lng: 119.7985 } }
    ]
  },
  3: {
    name: '莫干山爬坡线 (68km)',
    originName: '莫干山集镇广场',
    origin: { lat: 30.5962, lng: 119.8543 },
    destinationName: '莫干山主峰',
    destination: { lat: 30.6015, lng: 119.8242 },
    waypoints: [
      { name: '下渚湖湿地公园', coord: { lat: 30.5428, lng: 119.9248 } }
    ]
  },
  4: {
    name: '千岛湖环线 (140km)',
    originName: '千岛湖广场',
    origin: { lat: 29.6052, lng: 119.0425 },
    destinationName: '千岛湖大桥',
    destination: { lat: 29.6241, lng: 119.0125 },
    waypoints: [
      { name: '临岐小镇', coord: { lat: 29.7428, lng: 119.2243 } }
    ]
  }
};

// ==========================================================================
// 1. 初始化应用与地图
// ==========================================================================
document.addEventListener('DOMContentLoaded', () => {
  setTimeout(() => {
    if (startupLocationComplete) return;
    startupVisibleAt = performance.now();
    document.getElementById('startup-location-status')?.classList.add('is-visible');
  }, 1000);
  try {
    const savedTheme = localStorage.getItem(MAP_THEME_STORAGE_KEY);
    if (MAP_THEMES.some(theme => theme.id === savedTheme)) currentTheme = savedTheme;
  } catch (error) {
    console.warn('无法读取地图样式偏好：', error);
  }
  syncMapThemeUI();
  initMap();
  bindEvents();

  console.log(`📡 VeloRoam Web API Endpoint: ${API_BASE_URL}`);


  // 启动定位默认设置
  initializeLocation();
});

function initMap() {
  // 初始化 Leaflet 地图，默认视角设在上海人民广场
  map = L.map('map', {
    zoomControl: false, // 隐藏 Leaflet 默认的 zoom 键，使用我们高颜值的悬浮键
    attributionControl: true
  }).setView([31.2304, 121.4737], 12);
  // Planned routes stay above exploratory map overlays and their click targets.
  map.createPane('plannedRoutes');
  map.getPane('plannedRoutes').style.zIndex = '625';
  map.attributionControl.setPosition('topleft');
  map.attributionControl.setPrefix(false);

  // 加载当前选择的 CARTO 底图
  mapTileLayer = L.tileLayer(getCartoTileUrl(MAP_THEMES.find(theme => theme.id === currentTheme).tile), {
    maxZoom: 19,
    subdomains: 'abcd',
    attribution: CARTO_ATTRIBUTION
  }).addTo(map);

  markerGroup = L.layerGroup().addTo(map);
  polylineGroup = L.layerGroup().addTo(map);
  stravaGroup = L.layerGroup().addTo(map);
  homeRecommendationRouteLayer = L.layerGroup().addTo(map);
  placeRouteLayer = L.layerGroup().addTo(map);
  if (HOT_POINT_DISPLAY_ENABLED) {
    hotPointHeatmapLayer = createHotPointHeatmapLayer().addTo(map);
    hotPointGroup = L.layerGroup().addTo(map);
    scheduleInitialHotPointHeatmapLegendReveal();
  }

  // 绑定地图视口变动事件（平移和缩放结束后，静默刷新 Strava 路段数据）
  map.on('moveend', () => {
    const recommendationRequestId = ++homeRecommendationRequestId;
    homeRecommendationRouteRequest?.abort();
    syncHomeRecommendationVisibility();
    if (placeRouteActive) return;
    if (isHomeRecommendationEligible()) {
      homeRecommendationRouteLayer?.clearLayers();
      renderHomeRecommendationMessage('正在查找附近路段', getHomeOriginLabel());
      if (map.getZoom() > 16) fetchDeepZoomHomeRecommendations(recommendationRequestId);
    } else {
      homeRecommendationRouteLayer?.clearLayers();
    }
    fetchStravaSegmentsSilently(false, recommendationRequestId);
    if (HOT_POINT_DISPLAY_ENABLED) fetchHotPointsSilently();
  });

  map.on('zoomend', () => {
    if (HOT_POINT_DISPLAY_ENABLED) redrawCachedHotPoints();
    syncHomeRecommendationVisibility();
  });
}

/**
 * 启动时获取 HTML5 GPS 当前定位，若在移动端 HTTP 等非安全环境下，则通过 IP 定位或默认上海作为优雅兜底
 */
let startupLocationComplete = false;
let startupVisibleAt = 0;
function finishStartupLocation() {
  if (startupLocationComplete) return;
  startupLocationComplete = true;
  const status = document.getElementById('startup-location-status');
  if (!status) return;
  if (!startupVisibleAt) { status.hidden = true; return; }
  const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  const waitForEntry = reducedMotion ? 0 : Math.max(0, 600 - (performance.now() - startupVisibleAt));
  setTimeout(() => {
    status.classList.remove('is-visible');
    status.classList.add('is-complete');
    status.setAttribute('aria-hidden', 'true');
    setTimeout(() => { status.hidden = true; }, reducedMotion ? 0 : 500);
  }, waitForEntry);
}

async function fetchLocationWithTimeout(url) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 6000);
  try { return await fetch(url, { signal: controller.signal }); }
  finally { clearTimeout(timer); }
}

function initializeLocation() {
  const defaultShanghai = { lat: 31.2304, lng: 121.4737 };
  const defaultName = '上海人民广场';

  // 统一的 IP 定位及上海默认兜底处理函数
  const fallbackToIpOrShanghai = async (reason) => {
    console.warn(`[Location] 无法使用 HTML5 GPS (${reason})，正在尝试高精 IP 定位或默认上海兜底...`);

    try {
      // 使用支持 HTTP/HTTPS 双协议的免费 IP 定位服务
      const protocol = window.location.protocol === 'https:' ? 'https:' : 'http:';
      const ipRes = await fetchLocationWithTimeout(`${protocol}//ip-api.com/json?lang=zh-CN`).catch(() => null);

      if (ipRes && ipRes.ok) {
        const ipData = await ipRes.json();
        if (ipData && ipData.status === 'success' && ipData.lat && ipData.lon) {
          const lat = ipData.lat;
          const lng = ipData.lon;
          origin = { lat, lng };
          originLocationSource = 'ip';

          const cityName = ipData.city || ipData.regionName || '上海市';
          document.getElementById('origin-input').value = cityName;
          setIdeaGreetingLocation({ lat, lng }, 'ip', ipData.city || ipData.regionName || '');

          console.log(`📍 IP 定位解析成功: ${cityName} (${lat}, ${lng})`);
          map.flyTo([lat, lng], 13, { animate: true, duration: 1.5 });
          drawSingleMarker('origin', origin, cityName);
          syncPlaceDetailsVisibility();
          finishStartupLocation();
          return;
        }
      }
    } catch (ipErr) {
      console.warn('⚠️ IP 定位接口请求异常:', ipErr);
    }

    // 终极默认兜底：上海人民广场
    origin = defaultShanghai;
    originLocationSource = 'default';
    setIdeaGreetingLocation(null, 'default');
    document.getElementById('origin-input').value = defaultName;
    map.flyTo([defaultShanghai.lat, defaultShanghai.lng], 13, { animate: true, duration: 1.5 });
    drawSingleMarker('origin', origin, defaultName);
    syncPlaceDetailsVisibility();
    finishStartupLocation();
  };

  // 只有在安全上下文（HTTPS 或 localhost）中才能正常调用 HTML5 GPS Geolocation API
  const isSecure = window.isSecureContext || window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1';

  if (navigator.geolocation && isSecure) {
    navigator.geolocation.getCurrentPosition(
      async (position) => {
        const lat = position.coords.latitude;
        const lng = position.coords.longitude;

        origin = { lat, lng };
        originLocationSource = 'gps';
        originGpsTimestamp = Date.now();
        setIdeaGreetingLocation({ lat, lng }, 'gps');
        map.flyTo([lat, lng], 13, { animate: true, duration: 1.5 });

        // 🚀 使用我们高能的高德地图逆解析后端代理路由，瞬间返回秒级地名
        try {
          const res = await fetchLocationWithTimeout(`${API_BASE_URL}/routes/reverse-geocode?lat=${lat}&lng=${lng}`);
          if (res.ok) {
            const data = await res.json();
            document.getElementById('origin-input').value = data.address;
            console.log(`📍 定位高德逆地理编码成功: ${data.address} (${lat}, ${lng})`);
          } else {
            document.getElementById('origin-input').value = '当前获取的位置';
          }
        } catch (err) {
          document.getElementById('origin-input').value = '我的当前位置';
        }

        // 默认不要有终点，不自动规划，只绘制起点的地图标记
        drawSingleMarker('origin', origin, document.getElementById('origin-input').value);
        syncPlaceDetailsVisibility();
        finishStartupLocation();
      },
      (error) => {
        fallbackToIpOrShanghai(`GPS 获取被拒绝或超时: ${error.message}`);
      },
      { enableHighAccuracy: true, timeout: 4000 }
    );
  } else {
    const reason = !navigator.geolocation ? '浏览器不支持 HTML5 定位' : '局域网非安全上下文（受限 HTTP 访问无法开启 GPS）';
    fallbackToIpOrShanghai(reason);
  }
}

function drawSingleMarker(type, coord, popupText) {
  markerGroup.clearLayers();

  const className = type === 'origin' ? 'origin-pin' : 'destination-pin';
  const html = type === 'origin'
    ? '<div class="pin-inner"><i class="fa-solid fa-circle"></i></div>'
    : '<div class="pin-inner"><i class="fa-solid fa-flag"></i></div>';

  L.marker([coord.lat, coord.lng], {
    icon: L.divIcon({
      className: `custom-map-pin ${className}`,
      html: html,
      iconSize: [24, 24]
    })
  }).bindPopup(popupText).addTo(markerGroup);
}

function bindEvents() {
  bindLocationSearchEvents();
  bindPlaceDetailsEvents();
  bindHomeRecommendationEvents();

  // "生成路线" 按钮
  document.getElementById('btn-calculate').addEventListener('click', () => calculateRoute(true));

  // "添加途经点" 按钮
  document.getElementById('btn-add-waypoint').addEventListener('click', addWaypointInput);

  // "开始导航" 按钮
  document.getElementById('btn-navigate').addEventListener('click', launchExternalNavigation);

  // "导出 GPX" 按钮
  document.getElementById('btn-export').addEventListener('click', exportGPXFile);

  // 右侧悬浮功能键绑定
  document.getElementById('btn-toggle-theme').addEventListener('click', toggleMapTheme);
  document.getElementById('btn-recenter').addEventListener('click', initializeLocation);
  const heatmapToggleBtn = document.getElementById('btn-toggle-hotpoint-heatmap');
  if (HOT_POINT_DISPLAY_ENABLED && heatmapToggleBtn) {
    heatmapToggleBtn.addEventListener('click', toggleHotPointHeatmap);
  }

  // "返回修改" 按钮
  document.getElementById('btn-back-to-planner').addEventListener('click', showPlannerView);

  // 绑定地名实时输入监听事件 (带防抖)
  document.getElementById('origin-input').addEventListener('input', debounce((e) => {
    autocompleteSearch(e.target.value, 'origin');
  }, 300));

  document.getElementById('destination-input').addEventListener('input', debounce((e) => {
    autocompleteSearch(e.target.value, 'destination');
  }, 300));

  // 点击页面空白处隐藏所有下拉弹窗
  document.addEventListener('click', (e) => {
    if (!e.target.closest('.node-wrapper-outer')) {
      document.querySelectorAll('.search-results-dropdown').forEach(el => el.classList.remove('active'));
    }
  });

  const closeHotPointBtn = document.getElementById('btn-close-hotpoint-panel');
  if (closeHotPointBtn) {
    closeHotPointBtn.addEventListener('click', () => {
      closeHotPointDetails();
    });
  }

  // 点击 Leaflet 地图空白处时，自动收起 Strava 底部详情面板并恢复其余路段透明度
  if (map) {
    map.on('click', () => {
      closeStravaSegmentDetails();
      closeHotPointDetails();
    });

    // 缩放完成后，如果存在选中的黄金路段，强制重新应用高亮/淡化覆盖样式以防被 Leaflet 重绘冲掉
    map.on('zoomend', () => {
      if (selectedSegmentId !== null) {
        dimAllOtherSegments(selectedSegmentId);
      }
    });
  }

  // 绑定折叠面板的拖放与点击事件 (苹果地图抽屉机制 - 真实物理阻尼跟手反馈)
  const dragHandle = document.getElementById('drag-handle');
  const panel = document.getElementById('apple-panel');

  if (dragHandle && panel) {
    let isDragging = false;
    let startY = 0;
    let startHeight = 0;

    const startDrag = (clientY) => {
      isDragging = true;
      startY = clientY;
      startHeight = panel.offsetHeight;

      // 拖拽开始时立即移除 transition 动画属性，实现绝对顺滑的零延迟“跟手”拖动
      panel.style.transition = 'none';
    };

    const moveDrag = (clientY) => {
      if (!isDragging) return;

      const isMobile = window.innerWidth <= 1024;
      let newHeight = startHeight;

      if (isMobile) {
        // 移动端卡片靠底：向上拉 (clientY 减小) 高度增加；向下拉高度减小
        const deltaY = startY - clientY;
        newHeight = startHeight + deltaY;

        // 约束高度在 [176px, 80vh] 之间
        const maxMobileHeight = window.innerHeight * 0.8;
        newHeight = Math.max(184, Math.min(newHeight, maxMobileHeight));

        panel.style.height = `${newHeight}px`;
        panel.style.maxHeight = `${newHeight}px`;
      } else {
        // 桌面端卡片顶格：向下拉 (clientY 增大) 高度增加；向上推高度减小
        const deltaY = clientY - startY;
        newHeight = startHeight + deltaY;

        // 约束高度在 [176px, 视窗高度-48px] 之间
        const maxDesktopHeight = window.innerHeight - 48;
        newHeight = Math.max(184, Math.min(newHeight, maxDesktopHeight));

        panel.style.height = `${newHeight}px`;
        panel.style.maxHeight = `${newHeight}px`;
      }
    };

    const endDrag = () => {
      if (!isDragging) return;
      isDragging = false;

      // 拖放结束时重新载入 CSS 弹性曲线动画进行自动吸附
      panel.style.transition = 'var(--transition-smooth)';

      const isMobile = window.innerWidth <= 1024;
      const currentHeight = panel.offsetHeight;
      const collapsedThreshold = 184 + 100; // 自动展开/折叠阈值线

      if (isMobile) {
        if (currentHeight > collapsedThreshold) {
          panel.classList.remove('collapsed');
          panel.classList.add('expanded');
          panel.style.height = '80vh';
          panel.style.maxHeight = '80vh';
        } else {
          panel.classList.remove('expanded');
          panel.classList.add('collapsed');
          panel.style.height = '176px';
          panel.style.maxHeight = '176px';
        }
      } else {
        if (currentHeight > collapsedThreshold) {
          panel.classList.remove('collapsed');
          panel.classList.add('expanded');
          panel.style.height = 'calc(100vh - 48px)';
          panel.style.maxHeight = 'calc(100vh - 48px)';
        } else {
          panel.classList.remove('expanded');
          panel.classList.add('collapsed');
          panel.style.height = '176px';
          panel.style.maxHeight = '176px';
        }
      }

      // 动画吸附完毕后清除拖拽时的临时样式
      setTimeout(() => {
        if (!isDragging) {
          panel.style.transition = '';
        }
      }, 400);
    };

    // 触摸手势事件绑定 (移动端)
    dragHandle.addEventListener('touchstart', (e) => {
      startDrag(e.touches[0].clientY);
    }, { passive: true });

    window.addEventListener('touchmove', (e) => {
      if (isDragging) {
        moveDrag(e.touches[0].clientY);
        if (e.cancelable) e.preventDefault(); // 阻止默认的背景页面滚动
      }
    }, { passive: false });

    window.addEventListener('touchend', endDrag, { passive: true });

    // 鼠标拖拽事件绑定 (大屏桌面端)
    dragHandle.addEventListener('mousedown', (e) => {
      startDrag(e.clientY);
    });

    window.addEventListener('mousemove', (e) => {
      if (isDragging) {
        moveDrag(e.clientY);
        e.preventDefault();
      }
    });

    window.addEventListener('mouseup', endDrag);
  }

  // 🎯 智能骑行个性化定制面板折叠绑定
  const prefHeader = document.getElementById('preferences-header');
  const prefContent = document.getElementById('preferences-content');
  const prefChevron = document.getElementById('preferences-chevron');

  if (prefHeader && prefContent && prefChevron) {
    prefHeader.addEventListener('click', () => {
      prefContent.classList.toggle('active');
      prefChevron.classList.toggle('active');
    });
  }

  // Slider 数字气泡与联动
  const sliderDistance = document.getElementById('pref-distance');
  const valDistance = document.getElementById('val-pref-distance');
  if (sliderDistance && valDistance) {
    sliderDistance.addEventListener('input', (e) => {
      valDistance.textContent = e.target.value;
    });
  }

  const sliderDuration = document.getElementById('pref-duration');
  const valDuration = document.getElementById('val-pref-duration');
  if (sliderDuration && valDuration) {
    sliderDuration.addEventListener('input', (e) => {
      valDuration.textContent = parseFloat(e.target.value).toFixed(1);
    });
  }

  const sliderSupplyDistance = document.getElementById('supply-distance');
  const valSupplyDistance = document.getElementById('val-supply-distance');
  if (sliderSupplyDistance && valSupplyDistance) {
    sliderSupplyDistance.addEventListener('input', (e) => {
      valSupplyDistance.textContent = e.target.value;
    });
  }

  // 补给卡片选择绑定与公里数限制联动
  const supplyCards = document.querySelectorAll('.supply-card');
  const supplyDistanceRow = document.getElementById('supply-distance-row');

  if (supplyCards && supplyDistanceRow && sliderDistance && sliderSupplyDistance && valSupplyDistance) {
    supplyCards.forEach(card => {
      card.addEventListener('click', () => {
        supplyCards.forEach(c => c.classList.remove('active'));
        card.classList.add('active');

        const supplyType = card.dataset.type;
        if (supplyType === 'none') {
          supplyDistanceRow.style.display = 'none';
        } else {
          supplyDistanceRow.style.display = 'flex';
          // 动态调整补给公里上限，不超过目标里程的80%，最少为5km
          const targetDist = parseInt(sliderDistance.value, 10);
          const maxSupplyDist = Math.max(5, Math.round(targetDist * 0.8));
          sliderSupplyDistance.max = maxSupplyDist;

          const currentVal = parseInt(sliderSupplyDistance.value, 10);
          if (currentVal > maxSupplyDist || currentVal === 25) {
            sliderSupplyDistance.value = Math.max(5, Math.round(maxSupplyDist / 2));
            valSupplyDistance.textContent = sliderSupplyDistance.value;
          }
        }
      });
    });

    // 目标里程滑块变动时，自适应调整补给上限
    sliderDistance.addEventListener('change', () => {
      const activeSupplyCard = document.querySelector('.supply-card.active');
      if (activeSupplyCard && activeSupplyCard.dataset.type !== 'none') {
        const targetDist = parseInt(sliderDistance.value, 10);
        const maxSupplyDist = Math.max(5, Math.round(targetDist * 0.8));
        sliderSupplyDistance.max = maxSupplyDist;

        const currentVal = parseInt(sliderSupplyDistance.value, 10);
        if (currentVal > maxSupplyDist) {
          sliderSupplyDistance.value = Math.max(5, Math.round(maxSupplyDist / 2));
          valSupplyDistance.textContent = sliderSupplyDistance.value;
        }
      }
    });
  }
}

/**
 * 按黑底、白底、彩色的顺序切换地图风格
 */
function toggleMapTheme() {
  const nextIndex = (MAP_THEMES.findIndex(theme => theme.id === currentTheme) + 1) % MAP_THEMES.length;
  const theme = MAP_THEMES[nextIndex];
  currentTheme = theme.id;
  mapTileLayer.setUrl(getCartoTileUrl(theme.tile));
  syncMapThemeUI();
  try {
    localStorage.setItem(MAP_THEME_STORAGE_KEY, currentTheme);
  } catch (error) {
    console.warn('无法保存地图样式偏好：', error);
  }

  // 刷新高度图以同步最新的网格线及指示器颜色
  if (elevationChart) {
    renderChart();
  }
}

function syncMapThemeUI() {
  const index = MAP_THEMES.findIndex(theme => theme.id === currentTheme);
  const theme = MAP_THEMES[index];
  document.body.classList.toggle('light-theme', currentTheme !== 'dark');
  const button = document.getElementById('btn-toggle-theme');
  const label = `当前${theme.label}地图，切换到${MAP_THEMES[(index + 1) % MAP_THEMES.length].label}地图`;
  button.title = label;
  button.setAttribute('aria-label', label);
}

function toggleHotPointHeatmap() {
  hotPointHeatmapEnabled = !hotPointHeatmapEnabled;
  updateHotPointHeatmapButton();

  if (!hotPointHeatmapEnabled && hotPointHeatmapLayer) {
    hotPointHeatmapLayer.clear();
  }

  redrawCachedHotPoints();
  if (hotPointHeatmapEnabled) {
    syncHotPointHeatmapLegend({ reveal: true });
  }
}

function updateHotPointHeatmapButton() {
  const btn = document.getElementById('btn-toggle-hotpoint-heatmap');
  if (!btn) {
    syncHotPointHeatmapLegend();
    return;
  }

  btn.classList.toggle('active', hotPointHeatmapEnabled);
  btn.title = hotPointHeatmapEnabled ? '关闭热门点位热力图' : '开启热门点位热力图';
  btn.setAttribute('aria-pressed', hotPointHeatmapEnabled ? 'true' : 'false');
  btn.setAttribute('aria-label', hotPointHeatmapEnabled ? '关闭热门点位热力图' : '开启热门点位热力图');
  syncHotPointHeatmapLegend();
}

/**
 * 根据地图缩放等级动态返回路段最低筛选评分，减少用户手动操作
 * - Zoom <= 10: 过滤评分 >= 70
 * - Zoom === 11: 过滤评分 >= 50
 * - Zoom === 12: 过滤评分 >= 30
 * - Zoom >= 13: 过滤评分 >= 0 (显示所有路段)
 */
function getMinScoreForZoom(zoom) {
  if (zoom <= 10) return 70;
  if (zoom === 11) return 50;
  if (zoom === 12) return 30;
  return 0;
}

/**
 * 选中高光动效：淡化除当前激活路段外的所有其他路段
 */
function dimAllOtherSegments(activeSegId) {
  selectedSegmentId = Number(activeSegId);
  loadedStravaSegments.forEach((data, id) => {
    const layers = data.layer.getLayers();
    const visiblePolyline = layers[0];
    const startMarker = layers[2];
    const endMarker = layers[3];

    if (Number(id) === selectedSegmentId) {
      // 激活路段保持发光高亮状态
      if (visiblePolyline) visiblePolyline.setStyle({ opacity: 1.0, weight: 7.0 });
      if (startMarker) startMarker.setStyle({ opacity: 1.0 });
      if (endMarker) endMarker.setStyle({ opacity: 1.0 });
      for (let k = 4; k < layers.length; k++) {
        const dirEl = layers[k]?.getElement();
        if (dirEl) {
          const arrow = dirEl.querySelector('.segment-direction-arrow');
          if (arrow) arrow.style.opacity = '1.0';
        }
      }
    } else {
      // 其他路段淡化并变细以突显被选路段
      if (visiblePolyline) visiblePolyline.setStyle({ opacity: 0.15, weight: 3.5 });
      if (startMarker) startMarker.setStyle({ opacity: 0.15 });
      if (endMarker) endMarker.setStyle({ opacity: 0.15 });
      for (let k = 4; k < layers.length; k++) {
        const dirEl = layers[k]?.getElement();
        if (dirEl) {
          const arrow = dirEl.querySelector('.segment-direction-arrow');
          if (arrow) arrow.style.opacity = '0.15';
        }
      }
    }
  });
}

/**
 * 还原动效：将所有路段的透明度与线条宽度恢复至标准默认状态
 */
function restoreAllSegmentsOpacity() {
  selectedSegmentId = null;
  const toRemove = [];

  loadedStravaSegments.forEach((data, id) => {
    const score = data.seg.rawScore;
    // 如果该路段不满足当前缩放门槛评分，则在取消选中时将其从地图和缓存中移除
    if (score === undefined || score < minScoreFilter) {
      toRemove.push(id);
      stravaGroup.removeLayer(data.layer);
    } else {
      const layers = data.layer.getLayers();
      const visiblePolyline = layers[0];
      const startMarker = layers[2];
      const endMarker = layers[3];
      const originalColor = getSegmentColor(score);

      if (visiblePolyline) visiblePolyline.setStyle({ opacity: 0.85, weight: 5.5, color: originalColor });
      if (startMarker) startMarker.setStyle({ opacity: 0.95 });
      if (endMarker) endMarker.setStyle({ opacity: 0.95 });
      for (let k = 4; k < layers.length; k++) {
        const dirEl = layers[k]?.getElement();
        if (dirEl) {
          const arrow = dirEl.querySelector('.segment-direction-arrow');
          if (arrow) arrow.style.opacity = '0.9';
        }
      }
    }
  });

  toRemove.forEach(id => loadedStravaSegments.delete(id));
}

let stravaDetailRequest = null;
let stravaDetailTrigger = null;

function closeStravaSegmentDetails(shouldRestoreSegments = true) {
  stravaDetailRequest?.abort();
  stravaDetailRequest = null;
  const panel = document.getElementById('strava-details-panel');
  const hadSelection = selectedSegmentId !== null;

  if (panel?.classList.contains('active')) {
    panel.classList.remove('active');
    document.dispatchEvent(new CustomEvent('strava-detail-change', { detail: { open: false } }));
  }

  if (shouldRestoreSegments && hadSelection) {
    restoreAllSegmentsOpacity();
  }
  syncHomeRecommendationVisibility();
}

/**
 * 清理地图上所有未选中的路段图层及缓存，保留选中高亮的路段
 */
function clearUnselectedSegments() {
  const toRemove = [];
  loadedStravaSegments.forEach((data, id) => {
    if (selectedSegmentId === null || Number(id) !== Number(selectedSegmentId)) {
      stravaGroup.removeLayer(data.layer);
      toRemove.push(id);
    }
  });
  toRemove.forEach(id => loadedStravaSegments.delete(id));
}

// ==========================================================================
// 2. 防抖与地名实时联想搜索 (Autocomplete geocoder)
// ==========================================================================
function debounce(func, delay) {
  let timer;
  const debounced = function (...args) {
    clearTimeout(timer);
    timer = setTimeout(() => func.apply(this, args), delay);
  };
  debounced.cancel = () => clearTimeout(timer);
  return debounced;
}

async function autocompleteSearch(query, type, index = null) {
  const dropdownId = index !== null ? `waypoint-results-${index}` : `${type}-results`;
  const resultsDropdown = document.getElementById(dropdownId);
  const inputId = index !== null ? `waypoint-input-${index}` : `${type}-input`;
  const inputEl = document.getElementById(inputId);

  query = query.trim();
  if (!query) {
    resultsDropdown.classList.remove('active');
    return;
  }

  try {
    resultsDropdown.innerHTML = '<div class="search-item" style="color: var(--neon-cyan);"><i class="fa-solid fa-spinner fa-spin"></i> 正在搜索位置...</div>';
    resultsDropdown.classList.add('active');

    const url = `${API_BASE_URL}/routes/search-address?q=${encodeURIComponent(query)}`;
    const response = await fetch(url);

    if (!response.ok) throw new Error('Geocoding search failed');
    const results = await response.json();

    if (results.length === 0) {
      resultsDropdown.innerHTML = '<div class="search-item" style="color: var(--neon-red);"><i class="fa-solid fa-circle-exclamation"></i> 未找到匹配的地点</div>';
      return;
    }

    resultsDropdown.innerHTML = '';
    results.forEach((item) => {
      const fullName = `${item.name} (${item.address})`;
      const shortName = item.name;
      const lat = item.lat;
      const lon = item.lon;

      const div = document.createElement('div');
      div.className = 'search-item';
      div.title = fullName;
      div.innerHTML = `<i class="fa-solid fa-location-dot"></i> ${shortName} <span style="font-size: 10px; color: var(--text-grey); display: block; overflow: hidden; text-overflow: ellipsis;">${fullName}</span>`;

      div.addEventListener('click', () => {
        const coord = { lat, lng: lon };

        if (type === 'origin') {
          origin = coord;
          originLocationSource = 'manual';
          inputEl.value = shortName;
          if (isHomeRecommendationEligible()) requestHomeRecommendations(true);
        } else if (type === 'destination') {
          destination = coord;
          inputEl.value = shortName;
        } else if (type === 'waypoint' && index !== null) {
          waypoints[index] = { coord, name: shortName };
          inputEl.value = shortName;
        }

        resultsDropdown.classList.remove('active');
      });

      resultsDropdown.appendChild(div);
    });

  } catch (error) {
    console.error('Autocomplete Geocode Failed:', error);
    resultsDropdown.innerHTML = '<div class="search-item" style="color: var(--neon-red);"><i class="fa-solid fa-triangle-exclamation"></i> 检索网络异常</div>';
  }
}

// ==========================================================================
// 2.1 底部位置搜索（只定位地图，不创建路线或启动导航）
// ==========================================================================
function bindLocationSearchEvents() {
  const input = document.getElementById('location-search-input');
  const clearButton = document.getElementById('location-search-clear');
  const dock = document.getElementById('location-search-dock');
  if (!input || !clearButton || !dock) return;

  const debouncedSearch = debounce((query) => {
    searchLocationAddress(query);
  }, 300);

  input.addEventListener('input', () => {
    if (placeRouteActive) {
      homeRecommendationSearchOpen = true;
      clearSelectedPlace();
    }
    const query = input.value.trim();
    locationSearchRequestId++;
    locationSearchResultsCache = [];
    hideLocationSearchResults();
    clearButton.hidden = query.length === 0;
    debouncedSearch(query);
  });

  input.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') {
      event.preventDefault();
      debouncedSearch.cancel();
      const query = input.value.trim();
      if (locationSearchResultsCache.length > 0) {
        focusMapOnSearchResult(locationSearchResultsCache[0]);
      } else if (query) {
        searchLocationAddress(query, { selectFirst: true });
      }
    } else if (event.key === 'Escape') {
      hideLocationSearchResults();
      input.blur();
      if (homeRecommendationSearchOpen) {
        homeRecommendationSearchOpen = false;
        syncHomeRecommendationVisibility();
      }
    }
  });

  clearButton.addEventListener('click', () => {
    debouncedSearch.cancel();
    locationSearchRequestId++;
    clearSelectedPlace();
    input.value = '';
    clearButton.hidden = true;
    locationSearchResultsCache = [];
    hideLocationSearchResults();
    removeLocationSearchMarker();
    updateLocationSearchStatus('搜索已清空');
    input.focus();
  });

  document.addEventListener('click', (event) => {
    if (!event.target.closest('#location-search-dock')) {
      hideLocationSearchResults();
    }
  });
}

async function searchLocationAddress(query, options = {}) {
  const resultsContainer = document.getElementById('location-search-results');
  const normalizedQuery = query.trim();
  const currentRequestId = ++locationSearchRequestId;

  if (!resultsContainer) return;
  if (!normalizedQuery) {
    locationSearchResultsCache = [];
    hideLocationSearchResults();
    return;
  }

  renderLocationSearchMessage('fa-spinner fa-spin', '正在搜索位置…', 'loading');

  try {
    const response = await fetch(`${API_BASE_URL}/routes/search-address?q=${encodeURIComponent(normalizedQuery)}`);
    if (!response.ok) throw new Error(`Address search failed: ${response.status}`);

    const results = await response.json();
    if (currentRequestId !== locationSearchRequestId) return;

    locationSearchResultsCache = Array.isArray(results)
      ? results.filter(item => Number.isFinite(Number(item.lat)) && Number.isFinite(Number(item.lon)))
      : [];

    if (locationSearchResultsCache.length === 0) {
      renderLocationSearchMessage('fa-circle-exclamation', '没有找到匹配的位置', 'empty');
      updateLocationSearchStatus('没有找到匹配的位置');
      return;
    }

    if (options.selectFirst) {
      focusMapOnSearchResult(locationSearchResultsCache[0]);
      return;
    }

    renderLocationSearchResults(locationSearchResultsCache);
    updateLocationSearchStatus(`找到 ${locationSearchResultsCache.length} 个位置`);
  } catch (error) {
    if (currentRequestId !== locationSearchRequestId) return;
    console.error('[LocationSearch] 地址搜索失败:', error);
    locationSearchResultsCache = [];
    renderLocationSearchMessage('fa-triangle-exclamation', '搜索暂时不可用，请稍后重试', 'error');
    updateLocationSearchStatus('位置搜索失败');
  }
}

function renderLocationSearchResults(results) {
  const resultsContainer = document.getElementById('location-search-results');
  if (!resultsContainer) return;

  resultsContainer.replaceChildren();
  results.forEach((item) => {
    const resultButton = document.createElement('button');
    resultButton.type = 'button';
    resultButton.className = 'location-search-result';
    resultButton.setAttribute('role', 'option');

    const icon = document.createElement('i');
    icon.className = 'fa-solid fa-location-dot';
    icon.setAttribute('aria-hidden', 'true');

    const text = document.createElement('span');
    text.className = 'location-search-result-text';

    const name = document.createElement('strong');
    name.textContent = item.name || '未命名地点';

    const address = document.createElement('small');
    address.textContent = item.address || '暂无详细地址';

    text.append(name, address);
    resultButton.append(icon, text);
    resultButton.addEventListener('click', () => focusMapOnSearchResult(item));
    resultsContainer.appendChild(resultButton);
  });

  resultsContainer.classList.add('active');
}

function renderLocationSearchMessage(iconClass, message, state) {
  const resultsContainer = document.getElementById('location-search-results');
  if (!resultsContainer) return;

  const messageRow = document.createElement('div');
  messageRow.className = `location-search-message ${state}`;

  const icon = document.createElement('i');
  icon.className = `fa-solid ${iconClass}`;
  icon.setAttribute('aria-hidden', 'true');

  const label = document.createElement('span');
  label.textContent = message;

  messageRow.append(icon, label);
  resultsContainer.replaceChildren(messageRow);
  resultsContainer.classList.add('active');
}

function focusMapOnSearchResult(item) {
  const input = document.getElementById('location-search-input');
  const clearButton = document.getElementById('location-search-clear');
  const lat = Number(item.lat);
  const lng = Number(item.lon);
  if (!map || !Number.isFinite(lat) || !Number.isFinite(lng)) return;

  const displayName = item.name || item.address || '搜索位置';
  locationSearchRequestId++;
  clearSelectedPlace();
  selectedPlace = { lat, lng, name: displayName, address: item.address || '' };
  closeStravaSegmentDetails();
  closeHotPointDetails();
  if (input) input.value = displayName;
  if (clearButton) clearButton.hidden = false;

  hideLocationSearchResults();
  removeLocationSearchMarker();

  locationSearchMarker = L.marker([lat, lng], {
    icon: L.divIcon({
      className: 'location-search-map-icon',
      html: '<div class="location-search-pin"><i class="fa-solid fa-location-dot"></i></div>',
      iconSize: [42, 42],
      iconAnchor: [21, 38]
    }),
    zIndexOffset: 800
  }).addTo(map);

  map.flyTo([lat, lng], Math.max(map.getZoom(), 16), {
    animate: true,
    duration: 1.1
  });

  homeRecommendationSearchOpen = false;
  syncHomeRecommendationVisibility();
  syncPlaceDetailsVisibility();
  updateLocationSearchStatus(`已定位到 ${displayName}`);
}

function syncPlaceDetailsVisibility() {
  const panel = document.getElementById('place-details-panel');
  if (!panel) return;
  const visible = Boolean(selectedPlace) && !placeRouteActive;
  panel.hidden = !visible;
  panel.classList.toggle('active', visible);
  document.body.classList.toggle('place-selected-mode', visible);
  if (visible) {
    document.getElementById('place-details-title').textContent = selectedPlace.name;
    document.getElementById('place-details-address').textContent = selectedPlace.address || '上海市';
    const originName = document.getElementById('origin-input')?.value || '当前位置';
    document.getElementById('place-details-origin').textContent = origin
      ? `从${originName}出发${originLocationSource === 'ip' ? ' · IP 定位' : ''}`
      : '正在获取当前位置';
  }
}

function clearSelectedPlace() {
  placeRouteRequestId++;
  placeRouteRequest?.abort();
  placeRouteRequest = null;
  placeRouteActive = false;
  selectedPlace = null;
  placeRouteLayer?.clearLayers();
  const button = document.getElementById('place-details-go');
  if (button) {
    button.disabled = false;
    button.querySelector('span').textContent = '前往';
  }
  const message = document.getElementById('place-details-message');
  if (message) message.hidden = true;
  if (map && stravaGroup && !map.hasLayer(stravaGroup)) stravaGroup.addTo(map);
  if (map && polylineGroup && !map.hasLayer(polylineGroup)) polylineGroup.addTo(map);
  removeLocationSearchMarker();
  syncPlaceDetailsVisibility();
  syncHomeRecommendationVisibility();
}

function bindPlaceDetailsEvents() {
  document.getElementById('place-details-close')?.addEventListener('click', () => {
    clearSelectedPlace();
    document.getElementById('location-search-input').value = '';
    document.getElementById('location-search-clear').hidden = true;
  });
  document.getElementById('place-details-go')?.addEventListener('click', planRouteToSelectedPlace);
}

async function planRouteToSelectedPlace() {
  if (!selectedPlace) return;
  const message = document.getElementById('place-details-message');
  const button = document.getElementById('place-details-go');
  const buttonLabel = button.querySelector('span');
  if (!origin) {
    message.textContent = '正在获取当前位置，请稍后再试';
    message.hidden = false;
    return;
  }

  const requestId = ++placeRouteRequestId;
  placeRouteRequest?.abort();
  const controller = new AbortController();
  placeRouteRequest = controller;
  let timedOut = false;
  const timeout = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, 25000);
  button.disabled = true;
  buttonLabel.textContent = '规划中…';
  message.textContent = '正在寻找红绿灯更少的骑行路线';
  message.hidden = false;

  try {
    const response = await fetch(`${API_BASE_URL}/routes/plan-fewest-signals`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      signal: controller.signal,
      body: JSON.stringify({
        origin: { lat: Number(origin.lat), lng: Number(origin.lng) },
        destination: { lat: selectedPlace.lat, lng: selectedPlace.lng }
      })
    });
    if (!response.ok) throw new Error(`Route planning failed: ${response.status}`);
    const route = await response.json();
    if (requestId !== placeRouteRequestId) return;
    if (!route.polyline || !Number.isFinite(Number(route.distanceKm))) throw new Error('Invalid route');

    const points = decodePolyline(route.polyline);
    if (points.length < 2) throw new Error('Invalid route geometry');
    placeRouteLayer.clearLayers();
    L.polyline(points, {
      color: '#00e676', weight: 6, opacity: 0.96, lineCap: 'round', lineJoin: 'round',
      interactive: false, pane: 'plannedRoutes', className: 'place-navigation-line'
    }).addTo(placeRouteLayer);
    if (map.hasLayer(stravaGroup)) map.removeLayer(stravaGroup);
    if (map.hasLayer(polylineGroup)) map.removeLayer(polylineGroup);
    if (map.hasLayer(homeRecommendationRouteLayer)) map.removeLayer(homeRecommendationRouteLayer);
    placeRouteActive = true;
    syncPlaceDetailsVisibility();
    syncHomeRecommendationVisibility();
    map.fitBounds(L.latLngBounds(points), { paddingTopLeft: [36, 70], paddingBottomRight: [36, 100] });
    updateLocationSearchStatus(`骑行路线已规划，约 ${Number(route.distanceKm).toFixed(1)} 公里`);
  } catch (error) {
    if (requestId !== placeRouteRequestId) return;
    message.textContent = timedOut ? '路线规划超时，请重试' : '路线规划暂不可用，请重试';
    message.hidden = false;
  } finally {
    clearTimeout(timeout);
    if (requestId === placeRouteRequestId) {
      placeRouteRequest = null;
      button.disabled = false;
      buttonLabel.textContent = '前往';
    }
  }
}

function hideLocationSearchResults() {
  document.getElementById('location-search-results')?.classList.remove('active');
}

function removeLocationSearchMarker() {
  if (map && locationSearchMarker) {
    map.removeLayer(locationSearchMarker);
    locationSearchMarker = null;
  }
}

function updateLocationSearchStatus(message) {
  const status = document.getElementById('location-search-status');
  if (status) status.textContent = message;
}

// ==========================================================================
// 3. 地图直接点击交互选点 (已根据要求取消地图选点/Popup功能)
// ==========================================================================

// ==========================================================================
// 4. 推荐目的地环线一键载入逻辑 (Loop Recommendation Charger)
// ==========================================================================
window.selectRecommendedLoop = function (id) {
  const route = PRESET_LOOPS[id];
  if (!route) return;

  console.log(`🌟 一键装载精选骑行环线: ${route.name}`);

  origin = route.origin;
  originLocationSource = 'manual';
  document.getElementById('origin-input').value = route.originName;

  destination = route.destination;
  document.getElementById('destination-input').value = route.destinationName;

  const container = document.getElementById('waypoints-container');
  container.innerHTML = '';
  waypoints = [];
  updateWaypointsContainerVisibility();

  route.waypoints.forEach((wp) => {
    pushWaypoint(wp.coord, wp.name);
  });

  // 不自动规划，等待用户点击【生成最优骑行轨迹】按钮
};

window.addCustomPlace = function () {
  alert('您可以通过在上方输入地名或者在地图上轻轻点击，自由添加任意途经点！');
};

// ==========================================================================
// 5. 途经点列表逻辑处理 (嵌套在起终点之间，支持 Drag & Drop 拖拽排序)
// ==========================================================================
function updateWaypointsContainerVisibility() {
  const container = document.getElementById('waypoints-container');
  if (!container) return;
  if (waypoints.length === 0) {
    container.style.display = 'none';
  } else {
    container.style.display = 'block';
  }
}

function pushWaypoint(coord, displayName) {
  const container = document.getElementById('waypoints-container');
  const index = waypoints.length;

  // 缓存经纬度与地名对象
  waypoints.push({ coord, name: displayName });

  const wrapper = document.createElement('div');
  wrapper.className = 'node-wrapper-outer';
  wrapper.style.position = 'relative';
  wrapper.id = `waypoint-wrapper-${index}`;
  wrapper.setAttribute('data-index', index);
  wrapper.setAttribute('draggable', 'true');

  wrapper.innerHTML = `
    <div class="input-divider"></div>
    <div class="apple-input-row waypoint-row" style="cursor: grab; display: flex; align-items: center; justify-content: space-between; width: 100%;">
      <span class="waypoint-drag-handle" style="color: var(--neon-azure); margin-right: 8px;" title="按住拖拽排序">
        <i class="fa-solid fa-grip-vertical"></i>
      </span>
      <input type="text" id="waypoint-input-${index}" value="${displayName}" placeholder="输入途经点地址 (支持联想搜索)" class="apple-input" style="flex: 1;">
      <div style="display: flex; gap: 8px; align-items: center; flex-shrink: 0;">
        <i class="fa-solid fa-location-crosshairs input-accessory" onclick="simulateCoordinateChange('waypoint', ${index})" title="微调途经点" style="position: static;"></i>
        <i class="fa-solid fa-circle-xmark input-accessory" onclick="removeWaypoint(${index})" title="移除途经点" style="position: static; color: var(--neon-red);"></i>
      </div>
    </div>
    <div class="search-results-dropdown" id="waypoint-results-${index}"></div>
  `;
  container.appendChild(wrapper);

  document.getElementById(`waypoint-input-${index}`).addEventListener('input', debounce((e) => {
    autocompleteSearch(e.target.value, 'waypoint', index);
  }, 300));

  updateWaypointsContainerVisibility();
}

function addWaypointInput() {
  if (waypoints.length >= 3) {
    alert('MVP 阶段最多支持 3 个途经点。');
    return;
  }

  const index = waypoints.length;

  const baseLat = origin ? origin.lat : 30.2741;
  const baseLng = origin ? origin.lng : 120.1551;
  const destLat = destination ? destination.lat : 30.5962;
  const destLng = destination ? destination.lng : 119.8543;

  const lat = baseLat + (destLat - baseLat) * 0.4 + (index + 1) * 0.015;
  const lng = baseLng + (destLng - baseLng) * 0.4 - (index + 1) * 0.015;

  pushWaypoint({ lat, lng }, `已添加途经点 ${index + 1}`);

  // 绑定拖拽事件监听器
  makeWaypointsDraggable();
}

function removeWaypoint(index) {
  waypoints.splice(index, 1);
  reorderWaypoints();
}

function reorderWaypoints() {
  const container = document.getElementById('waypoints-container');
  container.innerHTML = '';

  const oldWaypoints = [...waypoints];
  waypoints = [];

  oldWaypoints.forEach((wp) => {
    pushWaypoint(wp.coord, wp.name);
  });

  makeWaypointsDraggable();
  updateWaypointsContainerVisibility();
}

function makeWaypointsDraggable() {
  const container = document.getElementById('waypoints-container');
  if (!container) return;
  const items = container.querySelectorAll('.node-wrapper-outer');

  let dragSourceEl = null;

  items.forEach((item) => {
    item.addEventListener('dragstart', (e) => {
      dragSourceEl = item;
      e.dataTransfer.effectAllowed = 'move';
      e.dataTransfer.setData('text/plain', item.getAttribute('data-index'));
      item.classList.add('dragging');
    });

    item.addEventListener('dragover', (e) => {
      e.preventDefault();
      e.dataTransfer.dropEffect = 'move';

      const bounding = item.getBoundingClientRect();
      const offset = e.clientY - bounding.top - (bounding.height / 2);
      if (offset > 0) {
        item.style.borderBottom = '2px dashed var(--neon-azure)';
        item.style.borderTop = '';
      } else {
        item.style.borderTop = '2px dashed var(--neon-azure)';
        item.style.borderBottom = '';
      }
    });

    item.addEventListener('dragleave', () => {
      item.style.borderTop = '';
      item.style.borderBottom = '';
    });

    item.addEventListener('drop', (e) => {
      e.stopPropagation();
      e.preventDefault();

      item.style.borderTop = '';
      item.style.borderBottom = '';

      if (dragSourceEl !== item) {
        const fromIndex = parseInt(dragSourceEl.getAttribute('data-index'));
        const toIndex = parseInt(item.getAttribute('data-index'));

        // 重排 waypoints 数组
        const tempWp = waypoints[fromIndex];
        waypoints.splice(fromIndex, 1);
        waypoints.splice(toIndex, 0, tempWp);

        // 重新渲染
        reorderWaypoints();
      }
    });

    item.addEventListener('dragend', () => {
      items.forEach(el => {
        el.classList.remove('dragging');
        el.style.borderTop = '';
        el.style.borderBottom = '';
      });
    });
  });
}

function simulateCoordinateChange(type, index = null) {
  const offset = () => (Math.random() - 0.5) * 0.015;

  if (type === 'origin' && origin) {
    origin.lat += offset();
    origin.lng += offset();
    document.getElementById('origin-input').value = '微调当前起点';
  } else if (type === 'destination' && destination) {
    destination.lat += offset();
    destination.lng += offset();
    document.getElementById('destination-input').value = '微调当前终点';
  } else if (type === 'waypoint' && index !== null) {
    waypoints[index].coord.lat += offset();
    waypoints[index].coord.lng += offset();
    document.getElementById(`waypoint-input-${index}`).value = `微调途经点 ${index + 1}`;
    waypoints[index].name = `微调途经点 ${index + 1}`;
  }
}

// ==========================================================================
// 6. 视图切换逻辑 (Apple Maps Slide Panel State Toggler)
// ==========================================================================
function showDetailsView() {
  document.getElementById('planner-view').classList.remove('active');
  document.getElementById('details-view').classList.add('active');

  // 规划成功后，自动展开面板以展示路线详情和高度剖面
  const panel = document.getElementById('apple-panel');
  if (panel) {
    panel.classList.remove('collapsed');
    panel.classList.add('expanded');

    // 强制赋予展开态的高度行内样式，覆盖先前可能残留的折叠态行内样式
    const isMobile = window.innerWidth <= 1024;
    if (isMobile) {
      panel.style.height = '80vh';
      panel.style.maxHeight = '80vh';
    } else {
      panel.style.height = 'calc(100vh - 48px)';
      panel.style.maxHeight = 'calc(100vh - 48px)';
    }
  }
}

function showPlannerView() {
  document.getElementById('details-view').classList.remove('active');
  document.getElementById('planner-view').classList.add('active');
}

// ==========================================================================
// 7. API 请求与路线规划核心解算
// ==========================================================================
async function calculateRoute(autoShowDetails = false) {
  // 如果起点或终点缺失，只在地图绘制起点标记，不进行连线和展示面板
  if (!origin || !destination) {
    console.log('[RoutePlanner] 缺少起点或终点，回到规划视图');
    showPlannerView();
    return;
  }

  toggleLoading(true);

  try {
    const activeSupplyCard = document.querySelector('.supply-card.active');
    const supplyType = activeSupplyCard ? activeSupplyCard.dataset.type : 'none';
    const supplyDistanceEl = document.getElementById('supply-distance');
    const supplyDistance = supplyDistanceEl ? parseFloat(supplyDistanceEl.value) : 25;
    const toggleLoopbackEl = document.getElementById('toggle-loopback');
    const autoLoopback = toggleLoopbackEl ? toggleLoopbackEl.checked : false;

    const response = await fetch(`${API_BASE_URL}/routes/plan`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        origin,
        destination,
        waypoints: waypoints.map(w => w.coord),
        preferences: {
          supplyType,
          supplyDistance,
          autoLoopback
        }
      })
    });

    if (!response.ok) {
      const err = await response.json();
      throw new Error(err.error || 'Server error');
    }

    const resJson = await response.json();
    routeDataList = Array.isArray(resJson) ? resJson : [resJson];
    activeRouteIndex = 0;
    routeData = routeDataList[0];

    // 渲染备选路线卡片列表
    renderAlternativesList();

    // 更新指标面板
    updateStatsDisplay();

    // 绘制地图元素
    drawMapElements();

    // 绘制高度剖面
    renderChart();

    // 只有点击【生成最优骑行路线】时才进入详情视图，或者如果当前已经是详情视图则保持并刷新
    const detailsActive = document.getElementById('details-view').classList.contains('active');
    if (autoShowDetails || detailsActive) {
      showDetailsView();
    } else {
      showPlannerView();
    }

  } catch (error) {
    console.error('Error planning route:', error);
    showPlannerView();
    alert(`路线规划失败: ${error.message}\n请确保后端 Node.js 服务器已正常启动于端口 3000！`);
  } finally {
    toggleLoading(false);
  }
}

// ==========================================================================
// 8. UI 绑定渲染
// ==========================================================================
function toggleLoading(show) {
  const overlay = document.getElementById('loading-overlay');
  if (show) {
    overlay.classList.add('active');
  } else {
    overlay.classList.remove('active');
  }
}

function updateStatsDisplay() {
  if (!routeData) return;

  document.getElementById('val-distance').innerText = routeData.distanceKm.toFixed(1);
  document.getElementById('val-duration').innerText = routeData.durationMin;
  document.getElementById('val-ascent').innerText = routeData.totalAscentM;
  document.getElementById('val-slope').innerText = routeData.maxSlopePercent.toFixed(1);

  // 更新新指标看板 (风景星级、好骑度、红绿灯数量)
  if (document.getElementById('val-scenic-stars')) {
    document.getElementById('val-scenic-stars').innerHTML = renderScenicStars(routeData.scenicRating || 3.0);
  }
  if (document.getElementById('val-comfort-score')) {
    document.getElementById('val-comfort-score').innerText = Math.round(routeData.comfortScore || 80);
  }
  if (document.getElementById('val-traffic-lights')) {
    document.getElementById('val-traffic-lights').innerText = routeData.trafficLightsCount !== undefined ? routeData.trafficLightsCount : 0;
  }
}

function drawMapElements() {
  if (!routeData) return;

  markerGroup.clearLayers();
  polylineGroup.clearLayers();
  scrubbedRiderMarker = null;

  // 1. 绘制起终点及途经点标记
  L.marker([origin.lat, origin.lng], {
    icon: L.divIcon({
      className: 'custom-map-pin origin-pin',
      html: '<div class="pin-inner"><i class="fa-solid fa-circle"></i></div>',
      iconSize: [24, 24]
    })
  }).bindPopup(document.getElementById('origin-input').value || '起点').addTo(markerGroup);

  L.marker([destination.lat, destination.lng], {
    icon: L.divIcon({
      className: 'custom-map-pin destination-pin',
      html: '<div class="pin-inner"><i class="fa-solid fa-flag"></i></div>',
      iconSize: [24, 24]
    })
  }).bindPopup(document.getElementById('destination-input').value || '终点').addTo(markerGroup);

  waypoints.forEach((wpObj, i) => {
    const wp = wpObj.coord;
    const inputWp = document.getElementById(`waypoint-input-${i}`);
    const wpName = inputWp ? inputWp.value : (wpObj.name || `途经点 ${i + 1}`);

    L.marker([wp.lat, wp.lng], {
      icon: L.divIcon({
        className: 'custom-map-pin waypoint-pin',
        html: `<div class="pin-inner">${i + 1}</div>`,
        iconSize: [24, 24]
      })
    }).bindPopup(wpName).addTo(markerGroup);
  });

  // 2. 绘制非激活的备选路线在背景层 (单条灰色高亮线，高阶 Apple UX)
  routeDataList.forEach((r, idx) => {
    if (idx === activeRouteIndex) return; // 跳过当前激活路线

    if (r.polyline) {
      const decoded = decodePolyline(r.polyline);
      L.polyline(decoded, {
        pane: 'plannedRoutes',
        color: '#5c5e64', // 经典磨砂灰高亮线
        weight: 6,
        opacity: 0.55,
        lineCap: 'round',
        lineJoin: 'round'
      }).addTo(polylineGroup)
        .on('click', (e) => {
          L.DomEvent.stopPropagation(e); // 阻止事件穿透
          selectAlternativeRoute(idx);
        });
    }
  });

  // 3. 绘制坡度彩色分段 Polyline 轨迹 (激活路线，高光渲染)
  const pts = routeData.elevationPoints;
  if (pts && pts.length > 1) {
    const bounds = [];
    for (let i = 1; i < pts.length; i++) {
      const p1 = pts[i - 1];
      const p2 = pts[i];
      const color = getSlopeColor(p2.slopePercent);

      L.polyline([[p1.lat, p1.lng], [p2.lat, p2.lng]], {
        pane: 'plannedRoutes',
        color: color,
        weight: 6, // 略微加粗更加醒目
        opacity: 0.95,
        lineCap: 'round',
        lineJoin: 'round'
      }).addTo(polylineGroup);

      bounds.push([p1.lat, p1.lng]);
    }
    bounds.push([pts[pts.length - 1].lat, pts[pts.length - 1].lng]);

    map.fitBounds(bounds, { padding: [40, 40] });
  }

  // 4. 绘制美食补给黄金驿站标记
  if (routeData.supplyPoint) {
    const sp = routeData.supplyPoint;
    let emoji = '🍜';
    if (sp.type === 'coffee') emoji = '☕';
    if (sp.type === 'convenience') emoji = '🏪';
    if (sp.type === 'farmhouse') emoji = '🥬';
    if (sp.type === 'mutton') emoji = '🐑';

    L.marker([sp.lat, sp.lng], {
      icon: L.divIcon({
        className: 'custom-map-pin supply-pin',
        html: `<div class="pin-inner" style="background: #ffd600; border: 2px solid #ffffff; box-shadow: 0 0 12px rgba(255,214,0,0.65); display: flex; justify-content: center; align-items: center; border-radius: 50%; width: 28px; height: 28px;"><span style="font-size: 14px;">${emoji}</span></div>`,
        iconSize: [28, 28]
      })
    }).bindPopup(`<b>${emoji} 黄金补给驿站</b><br>${sp.name}<br>位于骑行约 <b>${sp.distanceKm.toFixed(1)} km</b> 处`).addTo(markerGroup);
  }
}

function getSlopeColor(slope) {
  const absSlope = Math.abs(slope);
  if (absSlope <= 1.0) return '#00e676';
  if (absSlope <= 5.0) return '#ffd600';
  if (absSlope <= 10.0) return '#ff9100';
  return '#ff1744';
}

// ==========================================================================
// 9. Chart.js 高度图渲染与 Scrubbing 跨界联动
// ==========================================================================
function renderChart() {
  const ctx = document.getElementById('elevationChart').getContext('2d');

  if (elevationChart) {
    elevationChart.destroy();
  }

  const pts = routeData.elevationPoints;
  if (!pts || pts.length === 0) return;

  const labels = pts.map(p => (p.distanceFromStartM / 1000).toFixed(2));
  const elevations = pts.map(p => p.elevationM);

  const gradient = ctx.createLinearGradient(0, 0, 0, 100);
  gradient.addColorStop(0, 'rgba(0, 230, 118, 0.25)');
  gradient.addColorStop(1, 'rgba(156, 39, 176, 0.01)');

  elevationChart = new Chart(ctx, {
    type: 'line',
    data: {
      labels: labels,
      datasets: [{
        label: '海拔高度 (m)',
        data: elevations,
        borderColor: '#00e676',
        borderWidth: 2.5,
        backgroundColor: gradient,
        fill: true,
        tension: 0.15,
        pointRadius: 0,
        pointHoverRadius: 6,
        pointHoverBackgroundColor: currentTheme !== 'dark' ? '#1c1c1e' : '#ffffff',
        pointHoverBorderColor: '#00e676',
        pointHoverBorderWidth: 2
      }]
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      plugins: {
        legend: { display: false },
        tooltip: { enabled: false }
      },
      scales: {
        x: {
          grid: { display: false },
          ticks: {
            color: currentTheme !== 'dark' ? '#68686e' : '#8c8e94',
            font: { size: 9 },
            maxTicksLimit: 6,
            callback: function (val) {
              return this.getLabelForValue(val) + ' km';
            }
          },
          border: { display: false }
        },
        y: {
          grid: {
            color: currentTheme !== 'dark' ? 'rgba(0, 0, 0, 0.06)' : 'rgba(255, 255, 255, 0.04)',
            lineWidth: 1
          },
          ticks: {
            color: currentTheme !== 'dark' ? '#68686e' : '#8c8e94',
            font: { size: 9 },
            maxTicksLimit: 4,
            callback: function (value) {
              return value + 'm';
            }
          },
          border: { display: false }
        }
      },
      interaction: {
        mode: 'index',
        intersect: false
      },
      onHover: (event, activeElements) => {
        handleChartScrub(activeElements);
      }
    },
    plugins: [{
      id: 'supplyLine',
      afterDraw: (chart) => {
        if (routeData && routeData.supplyPoint && routeData.supplyPoint.distanceKm) {
          const supplyDist = routeData.supplyPoint.distanceKm;
          const pts = routeData.elevationPoints;
          if (!pts || pts.length === 0) return;

          let closestIdx = 0;
          let minDiff = Infinity;
          for (let i = 0; i < pts.length; i++) {
            const diff = Math.abs((pts[i].distanceFromStartM / 1000) - supplyDist);
            if (diff < minDiff) {
              minDiff = diff;
              closestIdx = i;
            }
          }

          const meta = chart.getDatasetMeta(0);
          if (meta.data && meta.data[closestIdx]) {
            const x = meta.data[closestIdx].x;
            const topY = chart.chartArea.top;
            const bottomY = chart.chartArea.bottom;

            const ctx = chart.ctx;
            ctx.save();
            ctx.beginPath();
            ctx.strokeStyle = '#ffd600'; // Gold dashed line
            ctx.lineWidth = 1.5;
            ctx.setLineDash([5, 5]);
            ctx.moveTo(x, topY);
            ctx.lineTo(x, bottomY);
            ctx.stroke();

            // Draw label
            ctx.fillStyle = '#ffd600';
            ctx.font = 'bold 9px sans-serif';
            ctx.setLineDash([]);

            const sp = routeData.supplyPoint;
            let emoji = '🍜';
            if (sp.type === 'coffee') emoji = '☕';
            if (sp.type === 'convenience') emoji = '🏪';
            if (sp.type === 'farmhouse') emoji = '🥬';
            if (sp.type === 'mutton') emoji = '🐑';

            ctx.fillText(emoji + ' ' + sp.name.substring(0, 8), x + 5, topY + 12);
            ctx.restore();
          }
        }
      }
    }]
  });
}

function handleChartScrub(activeElements) {
  const scrubInfo = document.getElementById('chart-scrub-info');

  if (!activeElements || activeElements.length === 0) {
    if (scrubbedRiderMarker) {
      map.removeLayer(scrubbedRiderMarker);
      scrubbedRiderMarker = null;
    }
    scrubInfo.innerHTML = '<i class="fa-solid fa-circle-info"></i> 滑动高度曲线查看局部坡度';
    scrubInfo.style.color = '#8c8e94';
    return;
  }

  const index = activeElements[0].index;
  const point = routeData.elevationPoints[index];

  if (!point) return;

  const pos = [point.lat, point.lng];
  const slopeColor = getSlopeColor(point.slopePercent);

  if (!scrubbedRiderMarker) {
    scrubbedRiderMarker = L.marker(pos, {
      icon: L.divIcon({
        className: 'scrubbed-rider-dot',
        html: `<div class="rider-dot-glow" style="background-color: ${slopeColor}; box-shadow: 0 0 14px ${slopeColor}"></div>`,
        iconSize: [16, 16]
      }),
      zIndexOffset: 1000
    }).addTo(map);
  } else {
    scrubbedRiderMarker.setLatLng(pos);
    const el = scrubbedRiderMarker.getElement();
    if (el) {
      const dot = el.querySelector('.rider-dot-glow');
      if (dot) {
        dot.style.backgroundColor = slopeColor;
        dot.style.boxShadow = `0 0 14px ${slopeColor}`;
      }
    }
  }

  map.panTo(pos, { animate: true, duration: 0.1 });

  scrubInfo.innerHTML = `
    <span style="color: #ffffff; font-weight: 600">距离: ${(point.distanceFromStartM / 1000).toFixed(2)} km</span>
    <span style="margin: 0 8px; color: rgba(255,255,255,0.2)">|</span>
    <span style="color: #ffffff; font-weight: 600">高度: ${point.elevationM.toFixed(1)} m</span>
    <span style="margin: 0 8px; color: rgba(255,255,255,0.2)">|</span>
    <span style="color: ${slopeColor}; font-weight: 700">坡度: ${point.slopePercent.toFixed(1)}%</span>
  `;
}

// ==========================================================================
// 10. 外部导航与 GPX 下载
// ==========================================================================
function launchExternalNavigation() {
  if (!routeData) return;

  const isDomestic = origin.lng > 73 && origin.lng < 135 && origin.lat > 18 && origin.lat < 53;

  if (isDomestic) {
    // 唤起高德地图官方骑行导航链接 (支持移动端高德App和网页端无缝响应)
    const originName = encodeURIComponent(document.getElementById('origin-input').value || '我的位置');
    const destName = encodeURIComponent(document.getElementById('destination-input').value || '终点');

    // mode=ride 代表骑行模式
    const url = `https://uri.amap.com/navigation?from=${origin.lng},${origin.lat},${originName}&to=${destination.lng},${destination.lat},${destName}&mode=ride&src=VeloRoam`;
    console.log(`📡 [Navigation] Opening AMap Bicycling Navigation (mode=ride): ${url}`);
    window.open(url, '_blank');
  } else {
    // 唤起谷歌地图官方自行车骑行导航链接
    const originStr = `${origin.lat},${origin.lng}`;
    const destStr = `${destination.lat},${destination.lng}`;
    let waypointsStr = '';
    if (waypoints.length > 0) {
      waypointsStr = `&waypoints=${waypoints.map(w => `${w.coord.lat},${w.coord.lng}`).join('|')}`;
    }
    // travelmode=bicycling 代表自行车骑行模式
    const url = `https://www.google.com/maps/dir/?api=1&origin=${originStr}&destination=${destStr}${waypointsStr}&travelmode=bicycling`;
    console.log(`📡 [Navigation] Opening Google Bicycling Navigation: ${url}`);
    window.open(url, '_blank');
  }
}

function exportGPXFile() {
  if (!routeData || !routeData.elevationPoints || routeData.elevationPoints.length === 0) {
    alert('暂无路线，请先规划！');
    return;
  }

  const filename = `VeloRoam_Route_${routeData.distanceKm.toFixed(1)}km.gpx`;
  const name = `VeloRoam 骑行路线`;
  const desc = `总里程: ${routeData.distanceKm} km | 累计爬升: ${routeData.totalAscentM} m | 最大坡度: ${routeData.maxSlopePercent.toFixed(1)}%`;

  let gpx = `<?xml version="1.0" encoding="UTF-8"?>
<gpx version="1.1" creator="VeloRoam" xmlns="http://www.topografix.com/GPX/1/1">
  <metadata>
    <name>${name}</name>
    <desc>${desc}</desc>
  </metadata>
  <trk>
    <name>${name}</name>
    <trkseg>
`;

  routeData.elevationPoints.forEach((p) => {
    gpx += `      <trkpt lat="${p.lat}" lon="${p.lng}">
        <ele>${p.elevationM}</ele>
      </trkpt>
`;
  });

  gpx += `    </trkseg>
  </trk>
</gpx>`;

  const blob = new Blob([gpx], { type: 'application/gpx+xml;charset=utf-8;' });
  const link = document.createElement('a');
  if (link.download !== undefined) {
    const url = URL.createObjectURL(blob);
    link.setAttribute('href', url);
    link.setAttribute('download', filename);
    link.style.visibility = 'hidden';
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
  }
}

function parseLatLng(val) {
  if (!val) return null;
  const parts = val.split(',');
  if (parts.length !== 2) return null;
  const lat = parseFloat(parts[0].trim());
  const lng = parseFloat(parts[1].trim());
  if (isNaN(lat) || isNaN(lng)) return null;
  return { lat, lng };
}

/* ==========================================================================
   VeloRoam 备选路线卡片与辅助解析辅助函数
   ========================================================================== */

function decodePolyline(encoded) {
  const points = [];
  let index = 0, len = encoded.length;
  let lat = 0, lng = 0;

  while (index < len) {
    let b, shift = 0, result = 0;
    do {
      b = encoded.charCodeAt(index++) - 63;
      result |= (b & 0x1f) << shift;
      shift += 5;
    } while (b >= 0x20);
    const dlat = ((result & 1) ? ~(result >> 1) : (result >> 1));
    lat += dlat;

    shift = 0;
    result = 0;
    do {
      b = encoded.charCodeAt(index++) - 63;
      result |= (b & 0x1f) << shift;
      shift += 5;
    } while (b >= 0x20);
    const dlng = ((result & 1) ? ~(result >> 1) : (result >> 1));
    lng += dlng;

    points.push([lat / 1e5, lng / 1e5]);
  }
  return points;
}

function renderScenicStars(rating) {
  let starsHtml = '';
  const fullStars = Math.floor(rating);
  const hasHalf = rating % 1 >= 0.3 && rating % 1 <= 0.7;
  const halfStar = hasHalf ? 1 : 0;
  const emptyStars = Math.max(0, 5 - fullStars - halfStar);

  for (let i = 0; i < fullStars; i++) {
    starsHtml += '<i class="fa-solid fa-star"></i>';
  }
  if (hasHalf) {
    starsHtml += '<i class="fa-solid fa-star-half-stroke"></i>';
  }
  for (let i = 0; i < emptyStars; i++) {
    starsHtml += '<i class="fa-regular fa-star"></i>';
  }
  return starsHtml + ` <span style="font-size: 11px; font-weight: 600; color: var(--text-grey); margin-left: 4px;">${rating.toFixed(1)}</span>`;
}

function renderAlternativesList() {
  const container = document.getElementById('alternatives-container');
  if (!container) return;

  container.innerHTML = '';

  routeDataList.forEach((route, idx) => {
    const isActive = idx === activeRouteIndex;
    const card = document.createElement('div');
    card.className = `alternative-card ${isActive ? 'active' : ''}`;

    // Choose dynamic label based on index and route data
    const label = getRouteLabel(route, idx);

    card.innerHTML = `
      <span class="alt-title">${label}</span>
      <span class="alt-sub">${route.distanceKm.toFixed(1)} km | ${route.durationMin} min</span>
    `;

    card.addEventListener('click', () => {
      selectAlternativeRoute(idx);
    });

    container.appendChild(card);
  });
}

function getRouteLabel(route, idx) {
  if (idx === 0) return 'VeloRoam 首选';
  if (route.totalAscentM > 250) return '避堵山地爬坡';
  if (route.comfortScore > 85 && route.scenicRating > 4.0) return '优选江景绿道';
  if (route.trafficLightsCount === 0) return '极速连贯干道';
  if (route.maxSlopePercent < 3.0) return '全平省力路线';
  return `备选方案 ${idx + 1}`;
}

function selectAlternativeRoute(idx) {
  if (idx < 0 || idx >= routeDataList.length) return;
  activeRouteIndex = idx;
  routeData = routeDataList[idx];

  renderAlternativesList();
  updateStatsDisplay();
  drawMapElements();
  renderChart();
}

let lastExploreCenter = null;
let lastExploreZoom = null;
let exploreDebounceTimer = null;
let lastHotPointCenter = null;
let lastHotPointZoom = null;
let hotPointDebounceTimer = null;

// 计算两个经纬度之间的球面距离（单位：米）
function getLatLngDistance(lat1, lng1, lat2, lng2) {
  const R = 6371000; // 地球半径，单位：米
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLng = (lng2 - lng1) * Math.PI / 180;
  const a = Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) *
    Math.sin(dLng / 2) * Math.sin(dLng / 2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return R * c;
}

/**
 * 计算两个经纬度坐标之间的航向角 (Bearing，单位为度 0~360)
 */
function getBearing(lat1, lng1, lat2, lng2) {
  const dLng = (lng2 - lng1) * Math.PI / 180;
  const lat1Rad = lat1 * Math.PI / 180;
  const lat2Rad = lat2 * Math.PI / 180;
  const y = Math.sin(dLng) * Math.cos(lat2Rad);
  const x = Math.cos(lat1Rad) * Math.sin(lat2Rad) - Math.sin(lat1Rad) * Math.cos(lat2Rad) * Math.cos(dLng);
  let brng = Math.atan2(y, x) * 180 / Math.PI;
  return (brng + 360) % 360;
}

/**
 * 根据路段评分 (rawScore) 获取高精豪华配色分类（5种颜色）
 * 使用高质感相近暖色系 (金黄 -> 活力橙 -> 经典橙 -> 红橙 -> 烈焰红) 保持视觉极度舒适和谐
 */
function getSegmentColor(score) {
  if (score === undefined || score === null) return '#ffb703';
  if (score < 30) return '#ffb703';  // 10-30: 琥珀金 (Amber Gold)
  if (score < 50) return '#ff9100';  // 30-50: 活力橙 (Bright Orange)
  if (score < 70) return '#ff6d00';  // 50-70: 经典橙 (Strava Orange)
  if (score < 90) return '#ff3d00';  // 70-90: 燃烈红橙 (Red Orange)
  return '#ff1744';                  // 90以上: 霓虹烈焰红 (Neon Crimson)
}

/**
 * 获取悬停或高光发光时的加亮配色，用于高质感发光交互反馈
 */
function getGlowColor(score) {
  if (score === undefined || score === null) return '#ffe066';
  if (score < 30) return '#ffe066';  // 金 -> 亮金
  if (score < 50) return '#ffa726';  // 橙 -> 亮橙
  if (score < 70) return '#ff9100';  // 经典橙 -> 闪亮橙
  if (score < 90) return '#ff6e40';  // 红橙 -> 亮红橙
  return '#ff5252';                  // 烈焰红 -> 荧光红
}

function getHotPointMeta(category) {
  const metas = {
    scenic: { color: '#00e676', icon: 'fa-tree', label: '景观点' },
    supply: { color: '#00b0ff', icon: 'fa-mug-hot', label: '补给点' },
    rest: { color: '#ffd600', icon: 'fa-chair', label: '休息点' },
    service: { color: '#d500f9', icon: 'fa-screwdriver-wrench', label: '骑行服务' },
    start_end: { color: '#ff9100', icon: 'fa-flag-checkered', label: '热门起终点' }
  };

  return metas[category] || { color: '#ffffff', icon: 'fa-location-dot', label: '热门点位' };
}

function createHotPointHeatmapLayer() {
  return new (L.Layer.extend({
    initialize() {
      this._points = [];
      this._opacity = 0;
      this._renderFrame = null;
      this._gridScale = 3;
    },

    onAdd(mapInstance) {
      this._map = mapInstance;
      this._canvas = L.DomUtil.create('canvas', 'hotpoint-heatmap-canvas leaflet-zoom-hide');
      this._ctx = this._canvas.getContext('2d', { alpha: true });
      this._workCanvas = document.createElement('canvas');
      this._workCtx = this._workCanvas.getContext('2d', { alpha: true });
      this._canvas.style.opacity = '0';
      mapInstance.getPanes().overlayPane.appendChild(this._canvas);
      mapInstance.on('resize moveend zoomend', this._reset, this);
      this._reset();
    },

    onRemove(mapInstance) {
      if (this._canvas && this._canvas.parentNode) {
        this._canvas.parentNode.removeChild(this._canvas);
      }
      mapInstance.off('resize moveend zoomend', this._reset, this);
      if (this._renderFrame) {
        cancelAnimationFrame(this._renderFrame);
        this._renderFrame = null;
      }
    },

    setData(points, opacity) {
      this._points = Array.isArray(points) ? points : [];
      this._opacity = opacity || 0;
      if (this._canvas) {
        this._canvas.style.opacity = String(this._opacity);
      }
      this._reset();
    },

    clear() {
      this._points = [];
      this._opacity = 0;
      if (this._canvas) {
        this._canvas.style.opacity = '0';
      }
      if (this._ctx && this._canvas) {
        this._ctx.clearRect(0, 0, this._canvas.width, this._canvas.height);
      }
    },

    _reset() {
      if (!this._map || !this._canvas) return;

      const size = this._map.getSize();
      const topLeft = this._map.containerPointToLayerPoint([0, 0]);
      L.DomUtil.setPosition(this._canvas, topLeft);

      if (this._canvas.width !== size.x || this._canvas.height !== size.y) {
        this._canvas.width = size.x;
        this._canvas.height = size.y;
      }

      if (this._renderFrame) cancelAnimationFrame(this._renderFrame);
      this._renderFrame = requestAnimationFrame(() => this._render());
    },

    _render() {
      this._renderFrame = null;
      if (!this._ctx || !this._map || !this._canvas) return;

      const width = this._canvas.width;
      const height = this._canvas.height;
      this._ctx.clearRect(0, 0, width, height);

      if (!this._points.length || this._opacity <= 0) return;

      const zoom = this._map.getZoom();
      const scale = this._gridScale;
      const lowWidth = Math.max(1, Math.ceil(width / scale));
      const lowHeight = Math.max(1, Math.ceil(height / scale));
      const grid = new Float32Array(lowWidth * lowHeight);
      const radiusPx = zoom === 12 ? 142 : (zoom === 13 ? 118 : 92);
      const radius = Math.max(5, Math.round(radiusPx / scale));
      const bounds = this._map.getBounds().pad(0.08);

      for (const point of this._points) {
        if (!point || !point.lat || !point.lng) continue;
        const latLng = L.latLng(point.lat, point.lng);
        if (!bounds.contains(latLng)) continue;

        const containerPoint = this._map.latLngToContainerPoint(latLng);
        const cx = Math.round(containerPoint.x / scale);
        const cy = Math.round(containerPoint.y / scale);
        const score = Math.max(0, Math.min(100, point.routeRelevanceScore || point.cyclistScore || 50));
        const weight = 0.6 + score / 90;

        const minX = Math.max(0, cx - radius);
        const maxX = Math.min(lowWidth - 1, cx + radius);
        const minY = Math.max(0, cy - radius);
        const maxY = Math.min(lowHeight - 1, cy + radius);

        for (let y = minY; y <= maxY; y++) {
          const dy = y - cy;
          for (let x = minX; x <= maxX; x++) {
            const dx = x - cx;
            const distSq = dx * dx + dy * dy;
            if (distSq > radius * radius) continue;
            const falloff = 1 - Math.sqrt(distSq) / radius;
            grid[y * lowWidth + x] += weight * falloff * falloff;
          }
        }
      }

      let maxValue = 0;
      for (let i = 0; i < grid.length; i++) {
        if (grid[i] > maxValue) maxValue = grid[i];
      }
      if (maxValue <= 0) return;

      this._workCanvas.width = lowWidth;
      this._workCanvas.height = lowHeight;
      const imageData = this._workCtx.createImageData(lowWidth, lowHeight);

      for (let i = 0; i < grid.length; i++) {
        const normalized = Math.pow(Math.min(1, grid[i] / maxValue), 0.78);
        const color = getHeatmapColor(normalized);
        const offset = i * 4;
        imageData.data[offset] = color[0];
        imageData.data[offset + 1] = color[1];
        imageData.data[offset + 2] = color[2];
        imageData.data[offset + 3] = color[3];
      }

      this._workCtx.putImageData(imageData, 0, 0);
      this._ctx.imageSmoothingEnabled = true;
      this._ctx.imageSmoothingQuality = 'high';
      this._ctx.clearRect(0, 0, width, height);
      this._ctx.filter = 'blur(8px) saturate(1.08)';
      this._ctx.drawImage(this._workCanvas, 0, 0, width, height);
      this._ctx.filter = 'none';
    }
  }))();
}

function getHotPointDisplayMode(zoom) {
  if (zoom <= 11) return 'hidden';
  if (zoom >= 12 && zoom <= 14) return 'heatmap';
  return 'points';
}

function getHeatmapOpacityForZoom(zoom) {
  if (zoom === 12) return 0.1;
  if (zoom === 13) return 0.3;
  if (zoom === 14) return 0.5;
  return 0;
}

function isHotPointHeatmapLegendEligible() {
  return hotPointHeatmapEnabled && map && getHotPointDisplayMode(map.getZoom()) === 'heatmap';
}

function setHotPointHeatmapLegendVisible(visible) {
  const legend = document.getElementById('hotpoint-heatmap-legend');
  if (!legend) return;

  legend.classList.toggle('active', visible);
  legend.setAttribute('aria-hidden', visible ? 'false' : 'true');
}

function hideHotPointHeatmapLegend() {
  if (hotPointHeatmapLegendTimer) {
    clearTimeout(hotPointHeatmapLegendTimer);
    hotPointHeatmapLegendTimer = null;
  }
  setHotPointHeatmapLegendVisible(false);
}

function revealHotPointHeatmapLegend() {
  if (!isHotPointHeatmapLegendEligible()) {
    hideHotPointHeatmapLegend();
    return;
  }

  if (hotPointHeatmapLegendTimer) {
    clearTimeout(hotPointHeatmapLegendTimer);
  }

  setHotPointHeatmapLegendVisible(true);
  hotPointHeatmapLegendTimer = setTimeout(() => {
    setHotPointHeatmapLegendVisible(false);
    hotPointHeatmapLegendTimer = null;
  }, HOTPOINT_HEATMAP_LEGEND_VISIBLE_MS);
}

function scheduleInitialHotPointHeatmapLegendReveal() {
  if (hotPointHeatmapLegendInitialDelayTimer) {
    clearTimeout(hotPointHeatmapLegendInitialDelayTimer);
  }

  hotPointHeatmapLegendInitialDelayActive = true;
  hotPointHeatmapLegendInitialDelayTimer = setTimeout(() => {
    hotPointHeatmapLegendInitialDelayActive = false;
    hotPointHeatmapLegendInitialDelayTimer = null;
    syncHotPointHeatmapLegend({ reveal: true });
  }, HOTPOINT_HEATMAP_LEGEND_INITIAL_DELAY_MS);
}

function syncHotPointHeatmapLegend(options = {}) {
  if (options.reveal && hotPointHeatmapLegendInitialDelayActive) {
    if (hotPointHeatmapLegendInitialDelayTimer) {
      clearTimeout(hotPointHeatmapLegendInitialDelayTimer);
      hotPointHeatmapLegendInitialDelayTimer = null;
    }
    hotPointHeatmapLegendInitialDelayActive = false;
  }

  const eligible = isHotPointHeatmapLegendEligible();
  const becameEligible = eligible && !hotPointHeatmapLegendEligible;
  hotPointHeatmapLegendEligible = eligible;

  if (!eligible) {
    hideHotPointHeatmapLegend();
    return;
  }

  if ((options.reveal || becameEligible) && (!hotPointHeatmapLegendInitialDelayActive || options.reveal)) {
    revealHotPointHeatmapLegend();
  }
}

function getHeatmapColor(value) {
  if (value <= 0.002) return [0, 0, 0, 0];

  const stops = [
    { t: 0.0, c: [44, 62, 160, 0] },
    { t: 0.08, c: [44, 62, 160, 96] },
    { t: 0.28, c: [75, 154, 192, 176] },
    { t: 0.48, c: [236, 247, 218, 224] },
    { t: 0.64, c: [255, 234, 143, 240] },
    { t: 0.8, c: [249, 132, 62, 252] },
    { t: 1.0, c: [191, 0, 47, 255] }
  ];

  for (let i = 1; i < stops.length; i++) {
    if (value <= stops[i].t) {
      const prev = stops[i - 1];
      const next = stops[i];
      const ratio = (value - prev.t) / (next.t - prev.t);
      return prev.c.map((channel, index) => Math.round(channel + (next.c[index] - channel) * ratio));
    }
  }

  return stops[stops.length - 1].c;
}

function getMaxVisibleHotPointsForZoom(zoom) {
  if (zoom === 15) return 72;
  return 96;
}

function drawSingleHotPoint(point) {
  if (!hotPointGroup || !point || !point.id || loadedHotPoints.has(point.id)) return;
  if (!point.lat || !point.lng) return;

  const currentZoom = map.getZoom();
  if (getHotPointDisplayMode(currentZoom) !== 'points') return;

  const meta = getHotPointMeta(point.category);
  const score = Math.round(point.routeRelevanceScore || point.cyclistScore || 0);
  const isSelected = selectedHotPointId === point.id;

  const marker = L.marker([point.lat, point.lng], {
    icon: L.divIcon({
      className: 'hotpoint-map-icon',
      html: `
        <div class="hotpoint-pin ${isSelected ? 'active' : ''}" style="--hotpoint-color: ${meta.color};">
          <i class="fa-solid ${meta.icon}"></i>
          <span>${score}</span>
        </div>
      `,
      iconSize: [38, 38],
      iconAnchor: [19, 19]
    }),
    zIndexOffset: isSelected ? 540 : 430
  }).addTo(hotPointGroup);

  marker.on('click', (e) => {
    L.DomEvent.stopPropagation(e);
    showHotPointDetails(point);
  });

  loadedHotPoints.set(point.id, marker);
}

function clearHotPointMarkers() {
  if (!hotPointGroup) return;
  hotPointGroup.clearLayers();
  loadedHotPoints.clear();
}

function clearHotPointVisuals() {
  clearHotPointMarkers();
  if (hotPointHeatmapLayer) {
    hotPointHeatmapLayer.clear();
  }
}

function getCachedHotPointsInView() {
  const bounds = map.getBounds();
  const points = [];
  allFetchedHotPoints.forEach(point => {
    if (bounds.contains(L.latLng(point.lat, point.lng))) {
      points.push(point);
    }
  });
  return points;
}

function redrawCachedHotPoints() {
  const currentZoom = map.getZoom();
  const mode = getHotPointDisplayMode(currentZoom);
  const cachedPoints = getCachedHotPointsInView();
  syncHotPointHeatmapLegend();

  if (mode === 'hidden') {
    clearHotPointVisuals();
    return;
  }

  if (mode === 'heatmap') {
    clearHotPointMarkers();
    if (hotPointHeatmapEnabled && hotPointHeatmapLayer) {
      hotPointHeatmapLayer.setData(cachedPoints, getHeatmapOpacityForZoom(currentZoom));
    } else if (hotPointHeatmapLayer) {
      hotPointHeatmapLayer.clear();
    }
    return;
  }

  if (hotPointHeatmapLayer) {
    hotPointHeatmapLayer.clear();
  }
  clearHotPointMarkers();
  cachedPoints
    .filter(point => point.source === 'hot_points')
    .sort((a, b) => (b.routeRelevanceScore || 0) - (a.routeRelevanceScore || 0))
    .slice(0, getMaxVisibleHotPointsForZoom(currentZoom))
    .forEach(point => {
      drawSingleHotPoint(point);
    });
}

async function fetchHotPointsSilently() {
  if (!map || !hotPointGroup) return;

  const currentZoom = map.getZoom();
  const mode = getHotPointDisplayMode(currentZoom);
  syncHotPointHeatmapLegend();
  if (mode === 'hidden' || currentZoom > 18) {
    clearHotPointVisuals();
    return;
  }

  clearTimeout(hotPointDebounceTimer);
  hotPointDebounceTimer = setTimeout(async () => {
    const currentCenter = map.getCenter();

    if (lastHotPointCenter && lastHotPointZoom !== null) {
      const distance = getLatLngDistance(
        lastHotPointCenter.lat, lastHotPointCenter.lng,
        currentCenter.lat, currentCenter.lng
      );
      const zoomChanged = currentZoom !== lastHotPointZoom;

      if (distance < 260 && !zoomChanged) {
        return;
      }
    }

    const zoomChanged = currentZoom !== lastHotPointZoom;
    if (zoomChanged) {
      redrawCachedHotPoints();
    }

    lastHotPointCenter = currentCenter;
    lastHotPointZoom = currentZoom;

    const bounds = map.getBounds();
    const south = bounds.getSouth();
    const west = bounds.getWest();
    const north = bounds.getNorth();
    const east = bounds.getEast();

    try {
      const response = await fetch(`${API_BASE_URL}/routes/hot-points?bounds=${south},${west},${north},${east}&zoom=${currentZoom}`);
      if (!response.ok) {
        throw new Error(`Hot points API response failed: ${response.status}`);
      }

      const points = await response.json();
      if (!Array.isArray(points)) return;

      points.forEach(point => {
        allFetchedHotPoints.set(point.id, point);
      });

      if (mode === 'heatmap') {
        clearHotPointMarkers();
        closeHotPointDetails(false);
        if (hotPointHeatmapEnabled && hotPointHeatmapLayer) {
          hotPointHeatmapLayer.setData(points, getHeatmapOpacityForZoom(currentZoom));
        } else if (hotPointHeatmapLayer) {
          hotPointHeatmapLayer.clear();
        }
        console.log(`🔥 [HotPoints] Zoom ${currentZoom} 热力图${hotPointHeatmapEnabled ? '更新' : '已关闭'}：${points.length} 个点，opacity=${hotPointHeatmapEnabled ? getHeatmapOpacityForZoom(currentZoom) : 0}`);
        return;
      }

      if (hotPointHeatmapLayer) {
        hotPointHeatmapLayer.clear();
      }

      let addedCount = 0;
      points
        .filter(point => point.source === 'hot_points')
        .sort((a, b) => (b.routeRelevanceScore || 0) - (a.routeRelevanceScore || 0))
        .slice(0, getMaxVisibleHotPointsForZoom(currentZoom))
        .forEach(point => {
          if (!loadedHotPoints.has(point.id)) {
            drawSingleHotPoint(point);
            addedCount++;
          }
        });

      console.log(`📍 [HotPoints] 渲染 ${addedCount} 个新增点位，当前地图点位数: ${loadedHotPoints.size}`);
    } catch (error) {
      console.warn('[HotPoints] 静默视口请求失败:', error.message);
    }
  }, 650);
}

function closeHotPointDetails(shouldRedraw = true) {
  const panel = document.getElementById('hotpoint-details-panel');
  const wasActive = panel?.classList.contains('active') || false;
  const hadSelection = selectedHotPointId !== null;

  if (panel) panel.classList.remove('active');
  selectedHotPointId = null;

  if (shouldRedraw && (wasActive || hadSelection)) {
    redrawCachedHotPoints();
  }
}

function showHotPointDetails(point) {
  closeIdeaRoutePanel();
  selectedHotPointId = point.id;
  redrawCachedHotPoints();

  closeStravaSegmentDetails();

  const panel = document.getElementById('hotpoint-details-panel');
  if (!panel) return;

  const meta = getHotPointMeta(point.category);
  const addressText = point.address || point.businessArea || point.districtName || '暂无地址信息';
  const nearestText = point.nearestSegmentDistanceM !== null && point.nearestSegmentDistanceM !== undefined
    ? `${Math.round(point.nearestSegmentDistanceM)} m`
    : '--';

  document.getElementById('hotpoint-panel-tag').innerText = `${meta.label} · ${point.source === 'map_hotspots' ? '热区补充' : '高德点位'}`;
  document.getElementById('hotpoint-panel-title').innerText = point.name || '未命名点位';
  document.getElementById('hotpoint-panel-address').innerText = addressText;
  document.getElementById('hotpoint-stat-score').innerText = Math.round(point.routeRelevanceScore || point.cyclistScore || 0);
  document.getElementById('hotpoint-stat-category').innerText = meta.label;
  document.getElementById('hotpoint-stat-nearby').innerText = nearestText;

  const header = panel.querySelector('.strava-panel-header');
  if (header) header.style.color = meta.color;

  panel.classList.add('active');
}

/**
 * 单条 Strava 黄金路段的高保真绘制渲染函数 (支持起终点圆点、动态旋转航向箭头与大型 28px 点击热区)
 */
function drawSingleStravaSegment(seg, animate = true) {
  const segId = Number(seg.id);
  const isDimmed = selectedSegmentId !== null && Number(selectedSegmentId) !== segId;

  // 如果不是当前选中的路段，则执行最低评分门槛过滤
  if (selectedSegmentId === null || Number(selectedSegmentId) !== segId) {
    if (seg.rawScore === undefined || seg.rawScore < minScoreFilter) {
      return;
    }
  }

  // 去重：如果该 ID 已经存在，则不进行重复渲染
  if (loadedStravaSegments.has(segId)) {
    return;
  }

  if (!seg.coordinates || seg.coordinates.length < 2) return;

  const latlngs = seg.coordinates.map(p => [p.lat, p.lng]);
  const segColor = getSegmentColor(seg.rawScore);

  // 创建独立的 LayerGroup 来包装当前路段的所有相关子图层
  const segmentGroup = L.layerGroup().addTo(stravaGroup);

  // 计算初始的 Leaflet options 属性，确保 Leaflet 缩放重构 SVG 时依然维持高亮/淡化状态
  const polylineOpacity = isDimmed ? 0.15 : (selectedSegmentId !== null && Number(selectedSegmentId) === segId ? 1.0 : 0.85);
  const polylineWeight = isDimmed ? 3.5 : (selectedSegmentId !== null && Number(selectedSegmentId) === segId ? 7.0 : 5.5);
  const markerOpacity = isDimmed ? 0.15 : 0.95;

  // 4.1 可见的高精豪华彩色折线 (无交互以防止干扰点击热区)
  const visiblePolyline = L.polyline(latlngs, {
    color: segColor,
    weight: polylineWeight,
    opacity: polylineOpacity,
    lineCap: 'round',
    lineJoin: 'round',
    interactive: false
  }).addTo(segmentGroup);

  // 4.2 隐形的极宽点击热区折线 (解决手机端不容易点到的痛点，热区宽度增加至 28px！)
  const hitAreaPolyline = L.polyline(latlngs, {
    color: 'transparent',
    weight: 28,
    opacity: 0,
    lineCap: 'round',
    lineJoin: 'round',
    interactive: true
  }).addTo(segmentGroup);

  // 4.3 绘制起点圆点 (使用与折线相同的相近色 - 实心点加白边)
  const startMarker = L.circleMarker(latlngs[0], {
    radius: 4.5,
    color: '#ffffff',
    fillColor: segColor,
    fillOpacity: 1,
    weight: 1.5,
    opacity: markerOpacity,
    interactive: false
  }).addTo(segmentGroup);

  // 4.4 绘制终点圆点 (使用与折线相同的相近色 - 空心点加彩色边)
  const endMarker = L.circleMarker(latlngs[latlngs.length - 1], {
    radius: 4.5,
    color: segColor,
    fillColor: '#ffffff',
    fillOpacity: 1,
    weight: 2,
    opacity: markerOpacity,
    interactive: false
  }).addTo(segmentGroup);

  // 4.5 动态计算航向角并在合适的位置标记方向指示器
  const distanceKm = seg.distanceKm || (seg.distance_km ? seg.distance_km : 0);
  let numArrows = Math.max(2, Math.min(12, Math.floor(distanceKm * 2.5)));
  const defaultArrowOpacity = isDimmed ? '0.15' : '0.9';
  const directionMarkers = [];

  for (let i = 1; i <= numArrows; i++) {
    const ratio = i / (numArrows + 1);
    let targetIndex = Math.floor(latlngs.length * ratio);
    if (latlngs.length > 3) {
      targetIndex = 1 + Math.floor((latlngs.length - 2) * ratio);
    }

    const targetPoint = latlngs[targetIndex];
    const prevPoint = latlngs[Math.max(0, targetIndex - 1)];
    const bearingAngle = getBearing(prevPoint[0], prevPoint[1], targetPoint[0], targetPoint[1]);

    const arrowIcon = L.divIcon({
      html: `<div class="segment-direction-arrow" style="transform: rotate(${bearingAngle}deg); color: ${segColor}; opacity: ${defaultArrowOpacity}; transition: opacity 0.6s ease, transform 0.2s ease;"><i class="fa-solid fa-chevron-up"></i></div>`,
      iconSize: [20, 20],
      iconAnchor: [10, 10],
      className: 'custom-direction-icon'
    });

    const directionMarker = L.marker(targetPoint, {
      icon: arrowIcon,
      interactive: false
    }).addTo(segmentGroup);

    // 将航向角保存在 Layer 实例属性上，供悬停缩放旋转时使用
    directionMarker.bearingAngle = bearingAngle;
    directionMarkers.push({ marker: directionMarker, ratio: targetIndex / (latlngs.length - 1) });
  }

  // 将 seg 和整个图层组关联存储在缓存 Map 中
  loadedStravaSegments.set(segId, { seg: seg, layer: segmentGroup });

  // 沿坐标顺序从起点向终点绘制；保留原有样式，避免干扰选中和悬停。
  const pathEl = visiblePolyline.getElement();
  const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  if (animate && !reducedMotion && pathEl && typeof pathEl.getTotalLength === 'function' && pathEl.animate) {
    const length = pathEl.getTotalLength();
    if (length > 0) {
      const duration = 1800;
      pathEl.animate([
        { strokeDasharray: `${length} ${length}`, strokeDashoffset: length },
        { strokeDasharray: `${length} ${length}`, strokeDashoffset: 0 }
      ], { duration, easing: 'linear' });

      directionMarkers.forEach(({ marker, ratio }) => {
        marker.getElement()?.animate?.([{ opacity: 0 }, { opacity: 1 }], {
          duration: 200, delay: duration * ratio, fill: 'backwards', easing: 'ease-out'
        });
      });
      endMarker.getElement()?.animate?.([{ opacity: 0 }, { opacity: markerOpacity }], {
        duration: 200, delay: duration - 100, fill: 'backwards', easing: 'ease-out'
      });
    }
  }

  // 6. 点击热区折线事件绑定：阻止冒泡，弹出底部详情卡片，并将其他路段变暗
  hitAreaPolyline.on('click', (e) => {
    L.DomEvent.stopPropagation(e);
    showStravaSegmentDetails(seg);
    dimAllOtherSegments(segId);
  });

  // 7. 点击热区的悬停交互高光加粗，更新可见折线的样式与所有箭头的缩放
  hitAreaPolyline.on('mouseover', () => {
    if (selectedSegmentId !== null && Number(selectedSegmentId) !== segId) return;

    visiblePolyline.setStyle({
      color: getGlowColor(seg.rawScore),
      weight: 7.5,
      opacity: 1.0
    });

    const layers = segmentGroup.getLayers();
    for (let k = 4; k < layers.length; k++) {
      const dirEl = layers[k]?.getElement();
      if (dirEl) {
        const arrowDiv = dirEl.querySelector('.segment-direction-arrow');
        if (arrowDiv) {
          const angle = layers[k].bearingAngle || 0;
          arrowDiv.style.transform = `rotate(${angle}deg) scale(1.2)`;
        }
      }
    }
  });

  hitAreaPolyline.on('mouseout', () => {
    if (selectedSegmentId !== null && Number(selectedSegmentId) !== segId) return;

    visiblePolyline.setStyle({
      color: segColor,
      weight: 5.5,
      opacity: 0.85
    });

    const layers = segmentGroup.getLayers();
    for (let k = 4; k < layers.length; k++) {
      const dirEl = layers[k]?.getElement();
      if (dirEl) {
        const arrowDiv = dirEl.querySelector('.segment-direction-arrow');
        if (arrowDiv) {
          const angle = layers[k].bearingAngle || 0;
          arrowDiv.style.transform = `rotate(${angle}deg) scale(1.0)`;
        }
      }
    }
  });
}

function isHomeRecommendationEligible() {
  return HOME_RECOMMENDATIONS_ENABLED && !!map && !selectedPlace && !placeRouteActive && map.getZoom() >= HOME_RECOMMENDATION_MIN_ZOOM &&
    window.matchMedia('(max-width: 640px)').matches;
}

function getHomeOriginLabel() {
  if (originLocationSource === 'ip') return '按 IP 大致位置出发';
  if (originLocationSource === 'default') return '以上海人民广场为起点';
  if (originLocationSource === 'manual') return '从所选起点出发';
  return '从当前位置出发';
}

function syncHomeRecommendationVisibility() {
  const panel = document.getElementById('home-recommendations');
  const backButton = document.getElementById('location-search-back');
  if (!panel || !backButton) return;

  const eligible = isHomeRecommendationEligible();
  if (!eligible) homeRecommendationSearchOpen = false;
  const detailsOpen = document.getElementById('strava-details-panel')?.classList.contains('active');
  const showRecommendations = eligible && !homeRecommendationSearchOpen && !detailsOpen;
  panel.hidden = !showRecommendations;
  panel.classList.toggle('active', showRecommendations);
  backButton.hidden = !(eligible && homeRecommendationSearchOpen);
  document.body.classList.toggle('home-recommendation-mode', showRecommendations);
  if (homeRecommendationRouteLayer && map) {
    const showRoute = eligible && !homeRecommendationSearchOpen;
    if (showRoute && !map.hasLayer(homeRecommendationRouteLayer)) homeRecommendationRouteLayer.addTo(map);
    if (!showRoute && map.hasLayer(homeRecommendationRouteLayer)) map.removeLayer(homeRecommendationRouteLayer);
  }
}

function requestHomeRecommendations(force = false) {
  const requestId = ++homeRecommendationRequestId;
  homeRecommendationRouteRequest?.abort();
  homeRecommendationRouteLayer?.clearLayers();
  syncHomeRecommendationVisibility();
  if (!isHomeRecommendationEligible()) return;

  renderHomeRecommendationMessage('正在查找附近路段', getHomeOriginLabel());
  if (map.getZoom() > 16) fetchDeepZoomHomeRecommendations(requestId);
  else fetchStravaSegmentsSilently(force, requestId);
}

function bindHomeRecommendationEvents() {
  document.getElementById('home-recommendations-search')?.addEventListener('click', () => {
    homeRecommendationSearchOpen = true;
    syncHomeRecommendationVisibility();
    document.getElementById('location-search-input')?.focus();
  });

  document.getElementById('location-search-back')?.addEventListener('click', () => {
    homeRecommendationSearchOpen = false;
    hideLocationSearchResults();
    document.getElementById('location-search-input')?.blur();
    syncHomeRecommendationVisibility();
  });

  document.getElementById('home-recommendations-retry')?.addEventListener('click', () => {
    requestHomeRecommendations(true);
  });

  document.getElementById('home-recommendations-detail')?.addEventListener('click', () => {
    const seg = homeRecommendationSelected?.seg;
    if (!seg) return;
    selectedSegmentId = Number(seg.id);
    if (!loadedStravaSegments.has(selectedSegmentId)) drawSingleStravaSegment(seg);
    dimAllOtherSegments(selectedSegmentId);
    showStravaSegmentDetails(seg);
  });

  window.addEventListener('resize', syncHomeRecommendationVisibility);
  syncHomeRecommendationVisibility();
}

function renderHomeRecommendationMessage(title, summary, state = 'loading') {
  const titleElement = document.getElementById('home-recommendations-title');
  const summaryElement = document.getElementById('home-recommendation-summary');
  const stats = document.getElementById('home-recommendation-stats');
  const retry = document.getElementById('home-recommendations-retry');
  const detail = document.getElementById('home-recommendations-detail');
  const status = document.getElementById('home-recommendations-status');
  if (!titleElement || !summaryElement || !stats || !retry || !detail || !status) return;

  titleElement.textContent = title;
  summaryElement.textContent = summary;
  document.getElementById('home-recommendation-icon').className =
    `fa-solid ${state === 'loading' ? 'fa-spinner fa-spin' : 'fa-route'}`;
  stats.hidden = true;
  retry.hidden = state !== 'error';
  detail.hidden = true;
  homeRecommendationSelected = null;
  status.textContent = `${title}。${summary}`;
}

function getHomeSegmentSample(seg) {
  const coordinates = Array.isArray(seg.coordinates) ? seg.coordinates : [];
  if (coordinates.length < 2) return [];
  const step = Math.max(1, Math.ceil(coordinates.length / 32));
  const sample = coordinates.filter((_, index) => index % step === 0);
  if (sample[sample.length - 1] !== coordinates[coordinates.length - 1]) {
    sample.push(coordinates[coordinates.length - 1]);
  }
  return sample.filter(point => Number.isFinite(Number(point.lat)) && Number.isFinite(Number(point.lng)));
}

function getRankedHomeSegments(segments) {
  if (!origin || !Number.isFinite(Number(origin.lat)) || !Number.isFinite(Number(origin.lng))) return [];
  const bounds = map.getBounds();
  const ranked = segments.map((seg) => {
    const sample = getHomeSegmentSample(seg);
    const distance = Number(seg.distanceKm);
    if (sample.length < 2 || !Number.isFinite(distance) || distance <= 0 || distance > 30) return null;

    const segmentBounds = L.latLngBounds(sample.map(point => [point.lat, point.lng]));
    if (!segmentBounds.intersects(bounds)) return null;

    const start = Array.isArray(seg.startLatLng) ? seg.startLatLng : [sample[0].lat, sample[0].lng];
    if (!Number.isFinite(Number(start[0])) || !Number.isFinite(Number(start[1]))) return null;
    const approachDistance = getLatLngDistance(origin.lat, origin.lng, start[0], start[1]);
    if (approachDistance > 12000) return null;

    const distanceFit = Math.max(0, 1 - Math.abs(Math.log((distance + 1) / 9)) / 2.2);
    const gradeFit = Math.max(0, 1 - Math.max(0, Math.abs(Number(seg.avgGrade) || 0) - 2) / 10);
    const ownScore = Math.min(1, Math.log1p(Math.max(0, Number(seg.veloRoamScore ?? seg.rawScore) || 0)) / Math.log(101));
    return {
      seg,
      start: { lat: Number(start[0]), lng: Number(start[1]) },
      rank: Math.max(0, 1 - approachDistance / 12000) * 55 + distanceFit * 20 + gradeFit * 10 + ownScore * 15
    };
  }).filter(Boolean).sort((a, b) => b.rank - a.rank);

  return ranked;
}

function drawHomeRecommendationRoute(item, route) {
  if (!homeRecommendationRouteLayer) return;
  homeRecommendationRouteLayer.clearLayers();

  if (route.polyline) {
    const approach = decodePolyline(route.polyline);
    if (approach.length > 1) {
      L.polyline(approach, {
        color: '#00e676', weight: 5, opacity: 0.9, lineCap: 'round', lineJoin: 'round',
        interactive: false, className: 'home-recommendation-approach-line'
      }).addTo(homeRecommendationRouteLayer);
    }
  }

  const segment = item.seg.coordinates.map(point => [Number(point.lat), Number(point.lng)]);
  L.polyline(segment, {
    color: '#ffd600', weight: 6, opacity: 0.96, lineCap: 'round', lineJoin: 'round',
    interactive: false, className: 'home-recommendation-segment-line'
  }).addTo(homeRecommendationRouteLayer);
}

async function planHomeRecommendationRoute(item, startOrigin) {
  if (getLatLngDistance(startOrigin.lat, startOrigin.lng, item.start.lat, item.start.lng) < 35) {
    return { distanceKm: 0, durationMin: 0, polyline: '' };
  }

  const cacheKey = `${startOrigin.lat.toFixed(4)},${startOrigin.lng.toFixed(4)}:${item.seg.id}`;
  if (homeRecommendationRouteCache.has(cacheKey)) return homeRecommendationRouteCache.get(cacheKey);

  const controller = new AbortController();
  homeRecommendationRouteRequest = controller;
  const timeout = setTimeout(() => controller.abort(), 20000);
  try {
    const response = await fetch(`${API_BASE_URL}/routes/plan`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      signal: controller.signal,
      body: JSON.stringify({
        origin: startOrigin,
        destination: item.start,
        waypoints: [],
        preferences: { supplyType: 'none', autoLoopback: false }
      })
    });
    if (!response.ok) throw new Error(`Route planning failed: ${response.status}`);
    const result = await response.json();
    const routes = Array.isArray(result) ? result : [result];
    const route = routes.find(candidate => Number.isFinite(Number(candidate.distanceKm)) &&
      Number(candidate.distanceKm) >= 0 && typeof candidate.polyline === 'string' &&
      (Number(candidate.distanceKm) === 0 || candidate.polyline.length > 0));
    if (!route) throw new Error('Route planning returned no valid route');

    homeRecommendationRouteCache.set(cacheKey, route);
    if (homeRecommendationRouteCache.size > 12) {
      homeRecommendationRouteCache.delete(homeRecommendationRouteCache.keys().next().value);
    }
    return route;
  } finally {
    clearTimeout(timeout);
    if (homeRecommendationRouteRequest === controller) homeRecommendationRouteRequest = null;
  }
}

async function updateHomeRecommendations(segments, requestId) {
  if (requestId !== homeRecommendationRequestId || !isHomeRecommendationEligible()) return;
  homeRecommendationSegments = segments;
  if (!origin) {
    renderHomeRecommendationMessage('等待当前位置', '定位完成后自动规划骑行路线', 'empty');
    return;
  }

  const item = getRankedHomeSegments(segments)[0];
  if (!item) {
    const center = map.getCenter();
    const viewingElsewhere = getLatLngDistance(origin.lat, origin.lng, center.lat, center.lng) > 12000;
    renderHomeRecommendationMessage(
      viewingElsewhere ? '当前区域离你较远' : '附近暂无可达路段',
      viewingElsewhere ? '回到当前位置查看骑行推荐' : '移动地图探索其他路段',
      'empty'
    );
    return;
  }

  renderHomeRecommendationMessage(item.seg.name || '推荐骑行路段', '正在规划从当前位置到路段起点…');
  const startOrigin = { lat: Number(origin.lat), lng: Number(origin.lng) };
  try {
    const route = await planHomeRecommendationRoute(item, startOrigin);
    if (requestId !== homeRecommendationRequestId || !isHomeRecommendationEligible()) return;

    const approachKm = Number(route.distanceKm);
    const segmentKm = Number(item.seg.distanceKm);
    const approachMin = Number(route.durationMin);
    const durationMin = Math.max(1, Math.round(
      (Number.isFinite(approachMin) ? approachMin : approachKm / 18 * 60) + segmentKm / 18 * 60
    ));
    document.getElementById('home-recommendations-title').textContent = item.seg.name || '推荐骑行路段';
    document.getElementById('home-recommendation-summary').textContent = `${getHomeOriginLabel()} · 预计约 ${durationMin} 分钟`;
    document.getElementById('home-recommendation-total').textContent = (approachKm + segmentKm).toFixed(1);
    document.getElementById('home-recommendation-approach').textContent = approachKm.toFixed(1);
    document.getElementById('home-recommendation-segment').textContent = segmentKm.toFixed(1);
    document.getElementById('home-recommendation-stats').hidden = false;
    document.getElementById('home-recommendations-detail').hidden = false;
    document.getElementById('home-recommendation-icon').className = 'fa-solid fa-route';
    document.getElementById('home-recommendations-status').textContent =
      `${item.seg.name || '推荐骑行路段'}，总里程 ${(approachKm + segmentKm).toFixed(1)} 公里`;
    homeRecommendationSelected = item;
    drawHomeRecommendationRoute(item, route);
  } catch (error) {
    if (requestId === homeRecommendationRequestId && isHomeRecommendationEligible()) {
      renderHomeRecommendationMessage(item.seg.name || '推荐骑行路段', '路线规划暂不可用，请重试', 'error');
    }
  }
}

async function fetchDeepZoomHomeRecommendations(requestId) {
  const bounds = map.getBounds();
  const boundsParam = [bounds.getSouth(), bounds.getWest(), bounds.getNorth(), bounds.getEast()].join(',');
  try {
    const response = await fetch(`${API_BASE_URL}/routes/strava-segments?bounds=${boundsParam}&zoom=${map.getZoom()}`);
    if (!response.ok) throw new Error(`Strava segments API response failed: ${response.status}`);
    const segments = await response.json();
    if (!Array.isArray(segments)) throw new Error('Invalid segments response');
    await updateHomeRecommendations(segments, requestId);
  } catch (error) {
    if (requestId === homeRecommendationRequestId && isHomeRecommendationEligible()) {
      renderHomeRecommendationMessage('推荐暂时不可用', '获取附近路段失败，请重试', 'error');
    }
  }
}

/**
 * 静默请求当前地图视口 Bounds 内的 Strava Segments 路段数据，并利用 Leaflet 实时动态图层渲染
 * 升级版：实现不要跟手请求（600ms 拖拽后防抖）、微小位移过滤（位移 < 350米时不触发）并传递 zoom 级别
 * 终极迭代：不清理旧图层，只新增绘制 rawScore > 10 的唯一路段，配合路径出场动画与独立底部详情看板
 */
async function fetchStravaSegmentsSilently(force = false, recommendationRequestId = homeRecommendationRequestId) {
  if (!map || !stravaGroup) return;

  const currentZoom = map.getZoom();
  // 缩放级别 <= 9 或 > 16 时，清空未选中路段并跳过静默探索
  if (currentZoom <= 9 || currentZoom > 16) {
    console.log(`[StravaRadar] 当前缩放等级 (${currentZoom}) 不在允许探索范围 [10-16] 内，清空未选中图层。`);
    clearTimeout(exploreDebounceTimer);
    lastExploreZoom = null;
    clearUnselectedSegments();
    return;
  }

  // 根据当前缩放等级动态调节最低筛选门槛
  minScoreFilter = getMinScoreForZoom(currentZoom);

  // 1. 防抖拦截：只有在拖动/缩放完全静止 600ms 后才进行真正的请求触发
  clearTimeout(exploreDebounceTimer);
  exploreDebounceTimer = setTimeout(async () => {
    const currentCenter = map.getCenter();

    // 2. 空间微小位移过滤：若中心点平移位移小于 350 米，则直接忽略以节省性能
    if (lastExploreCenter && lastExploreZoom !== null) {
      const distance = getLatLngDistance(
        lastExploreCenter.lat, lastExploreCenter.lng,
        currentCenter.lat, currentCenter.lng
      );
      const zoomChanged = currentZoom !== lastExploreZoom;

      if (distance < 350 && !zoomChanged && !force) {
        console.log(`[StravaRadar] 地图微小位移 (${distance.toFixed(1)}米 < 350米)，忽略本轮请求以节省资源。`);
        if (recommendationRequestId === homeRecommendationRequestId && isHomeRecommendationEligible()) {
          void updateHomeRecommendations(homeRecommendationSegments, recommendationRequestId);
        }
        return;
      }
    }

    // 3. 缩放等级改变时，清空当前未选中的图层，并立刻就地用新评分门槛筛选并绘制已缓存段
    const zoomChanged = currentZoom !== lastExploreZoom;
    const previouslyVisibleIds = new Set(loadedStravaSegments.keys());
    if (zoomChanged) {
      // 仅清理未选中的路段，保留当前选中高亮路段不消失
      clearUnselectedSegments();

      const bounds = map.getBounds();
      let redrawnCount = 0;
      allFetchedSegments.forEach((seg) => {
        const segId = Number(seg.id);
        // 如果是选中的路段，已经保留在地图上，这里不再重复重绘
        if (selectedSegmentId !== null && Number(selectedSegmentId) === segId) {
          return;
        }

        if (seg.rawScore !== undefined && seg.rawScore >= minScoreFilter) {
          if (seg.coordinates && seg.coordinates.length > 0) {
            const firstPt = seg.coordinates[0];
            if (bounds.contains(L.latLng(firstPt.lat, firstPt.lng))) {
              drawSingleStravaSegment(seg, !previouslyVisibleIds.has(segId));
              redrawnCount++;
            }
          }
        }
      });
      console.log(`[StravaRadar] 缩放等级改变 (${lastExploreZoom} -> ${currentZoom})，门槛设为 ≥${minScoreFilter}，从内存重绘了 ${redrawnCount} 条未选中路段。`);
    }

    lastExploreCenter = currentCenter;
    lastExploreZoom = currentZoom;

    const bounds = map.getBounds();
    const south = bounds.getSouth();
    const west = bounds.getWest();
    const north = bounds.getNorth();
    const east = bounds.getEast();

    console.log(`[StravaRadar] 视口平稳，开始探索. Zoom: ${currentZoom}, Center: [${currentCenter.lat.toFixed(4)}, ${currentCenter.lng.toFixed(4)}]`);

    try {
      // 传递 zoom 级别给后端。当 zoom >= 13 时，后端开启 2x2 网格并发探索
      const response = await fetch(`${API_BASE_URL}/routes/strava-segments?bounds=${south},${west},${north},${east}&zoom=${currentZoom}`);
      if (!response.ok) {
        throw new Error(`Strava segments API response failed: ${response.status}`);
      }

      const segments = await response.json();
      if (!Array.isArray(segments)) return;
      if (map.getZoom() !== currentZoom) return;

      if (recommendationRequestId === homeRecommendationRequestId && isHomeRecommendationEligible()) {
        void updateHomeRecommendations(segments, recommendationRequestId);
      }

      console.log(`🚴 [Strava] 后端接口返回了 ${segments.length} 条路段。进行去重合并与渲染...`);

      let addedCount = 0;

      segments.forEach((seg) => {
        const segId = Number(seg.id);
        // 全局缓存起来，方便后续本地即时高响应切换筛选
        allFetchedSegments.set(segId, seg);

        // 如果是选中的路段，不管评分多少，都必须强制绘制保留，无视过滤条件
        if (selectedSegmentId !== null && Number(selectedSegmentId) === segId) {
          if (!loadedStravaSegments.has(segId)) {
            drawSingleStravaSegment(seg);
          }
          return;
        }

        // 根据当前的最低门槛评分进行过滤
        if (seg.rawScore === undefined || seg.rawScore < minScoreFilter) {
          return;
        }

        // 如果当前在视图中没渲染过，则执行渲染绘制
        if (!loadedStravaSegments.has(segId)) {
          drawSingleStravaSegment(seg, !zoomChanged || !previouslyVisibleIds.has(segId));
          addedCount++;
        }
      });

      console.log(`🚴 [Strava] 视口静默增量刷新：共渲染了 ${addedCount} 条全新探索出的路段。当前客户端缓存渲染中: ${loadedStravaSegments.size}`);
    } catch (error) {
      console.warn(`[Strava] 静默视口探索请求被跳过或失败:`, error.message);
      if (recommendationRequestId === homeRecommendationRequestId && isHomeRecommendationEligible()) {
        renderHomeRecommendationMessage('推荐暂时不可用', '获取附近路段失败，请重试', 'error');
      }
    }
  }, 600);
}

/**
 * 在页面底部独立看板展示 Strava 黄金路段详情
 */
function showStravaSegmentDetails(seg, trigger = null) {
  closeIdeaRoutePanel();
  const panel = document.getElementById('strava-details-panel');
  if (!panel) return;
  closeHotPointDetails();
  stravaDetailRequest?.abort();
  const request = new AbortController();
  stravaDetailRequest = request;
  stravaDetailTrigger = trigger;
  const set = (id, value) => { document.getElementById(id).textContent = value; };
  const format = (value, suffix = '', digits = 1) => typeof value === 'number' && Number.isFinite(value) ? `${Number(value.toFixed(digits)).toLocaleString()}${suffix}` : '--';
  const render = detail => {
    set('strava-panel-title', detail.name || seg.name || '未命名路段');
    set('strava-stat-score', format(seg.veloRoamScore ?? seg.rawScore));
    set('strava-stat-distance', format(detail.distanceKm ?? seg.distanceKm, '', 2));
    set('strava-stat-grade', format(detail.avgGrade ?? seg.avgGrade));
    set('strava-stat-max-grade', format(detail.maxGrade, '%'));
    set('strava-stat-elevation', format(detail.totalElevationGain, ' m', 0));
    set('strava-stat-range', detail.elevationLow != null && detail.elevationHigh != null ? `${format(detail.elevationLow, '', 0)}–${format(detail.elevationHigh, ' m', 0)}` : '--');
    set('strava-stat-stars', format(detail.starCount ?? seg.starCount, '', 0));
    set('strava-stat-athletes', format(detail.athleteCount ?? seg.athleteCount, '', 0));
    set('strava-stat-efforts', format(detail.effortCount ?? seg.effortCount, '', 0));
  };
  const status = document.getElementById('strava-detail-status');
  const retry = document.getElementById('strava-detail-retry');
  render({});
  retry.hidden = true;
  status.textContent = '正在获取 Strava 路段详情…';
  panel.classList.add('active');
  if (selectedPlace) clearSelectedPlace();
  document.dispatchEvent(new CustomEvent('strava-detail-change', { detail: { open: true } }));
  syncHomeRecommendationVisibility();
  const id = String(seg.id || '').replace(/^segment:/, '');
  const load = async () => {
    try {
      if (!/^[1-9]\d*$/.test(id)) throw new Error('无法识别路段 ID。');
      const response = await fetch(`${API_BASE_URL}/routes/strava-segments/${id}`, { signal: request.signal });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || '路段详情暂时不可用，请稍后重试。');
      if (stravaDetailRequest !== request) return;
      render(data);
      status.textContent = data.hazardous ? 'Strava 标记此路段存在潜在危险，请注意路况。' : '数据来自 Strava；-- 表示暂无数据。';
    } catch (error) {
      if (error.name === 'AbortError' || stravaDetailRequest !== request) return;
      status.textContent = error.message || '获取路段详情失败，请稍后重试。';
      retry.hidden = false;
    }
  };
  retry.onclick = () => showStravaSegmentDetails(seg, trigger);
  load();
}

// 骑行想法使用独立图层，不依赖首页热门点位显示开关。
let ideaMapLayer = null;
let ideaRequest = null;
let ideaRouteRequest = null;
let ideaActiveRoute = null;

document.addEventListener('DOMContentLoaded', () => {
  const sheet = document.getElementById('idea-sheet');
  const backdrop = document.getElementById('idea-backdrop');
  const content = document.getElementById('idea-content');
  const segmentDetail = document.getElementById('strava-details-panel');
  const input = document.getElementById('idea-input');
  const send = document.getElementById('idea-send');
  const handle = document.getElementById('idea-sheet-handle');
  const title = document.getElementById('idea-title');
  const prompt = document.getElementById('idea-input-prompt');
  const newChat = document.getElementById('idea-new-chat');
  const more = document.getElementById('idea-more');
  const menu = document.getElementById('idea-menu');
  const historyPanel = document.getElementById('idea-history-panel');
  const historyList = document.getElementById('idea-history-list');
  const form = document.getElementById('idea-form');
  const sessions = new Map();
  let nextSessionId = 0;
  let currentSessionId = ++nextSessionId;
  const emptyContent = [...content.childNodes].map(node => node.cloneNode(true));
  let history = [];
  let previousIntent = null;
  let sessionTitle = '';
  let sessionEpoch = 0;
  let menuOpen = false;
  let menuTimer = null;
  let greetingIndex = 0;
  const limitIdeaTitle = text => {
    const value = String(text || '').replace(/[\r\n]+/g, ' ').trim();
    return Array.from(value).slice(0, 20).join('');
  };
  let titleTimer = null;
  let titleTarget = '';
  const animateIdeaTitle = text => {
    if (text === titleTarget) return;
    titleTarget = text;
    clearTimeout(titleTimer);
    input.setAttribute('aria-label', text + '，输入骑行想法');
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
      title.textContent = text;
      prompt.textContent = text;
      return;
    }
    const characters = typeof Intl.Segmenter === 'function'
      ? [...new Intl.Segmenter(undefined, { granularity: 'grapheme' }).segment(text)].map(part => part.segment)
      : Array.from(text);
    let index = 0;
    title.textContent = '';
    prompt.textContent = '';
    const typeNext = () => {
      title.textContent += characters[index++];
      prompt.textContent = title.textContent;
      if (index < characters.length) titleTimer = setTimeout(typeNext, 45);
    };
    if (characters.length) typeNext();
  };
  const greeting = () => {
    const hour = new Date().getHours();
    const greetings = hour < 11
      ? ['早安，今天想骑向哪里看看？', '新的一天，从哪条路开始？', '早安，想去哪里感受清晨？']
      : hour < 18
        ? ['今天，想沿哪条路慢慢骑行？', '哪一段路，值得今天出发？', '今天的骑行，从哪里开始？']
        : ['晚上好，想聊聊哪一段骑行？', '今天，还想去哪里慢慢看看？', '下一段路，想怎样自在骑行？'];
    return limitIdeaTitle(greetings[(new Date().getDate() + greetingIndex) % greetings.length]);
  };
  animateIdeaTitle(greeting());
  let greetingRequest = null;
  let greetingSequence = 0;
  const cancelGreeting = () => { greetingSequence++; greetingRequest?.abort(); greetingRequest = null; };
  const requestGreeting = async () => {
    cancelGreeting();
    const sequence = greetingSequence;
    const session = currentSessionId;
    // Do not delay the interface if initial location is denied or slow.
    await Promise.race([ideaLocationReady, new Promise(resolve => setTimeout(resolve, 5000))]);
    if (sequence !== greetingSequence || currentSessionId !== session || sessionTitle || content.querySelector('.idea-user-message')) return;
    const controller = new AbortController(); greetingRequest = controller;
    const timeout = setTimeout(() => controller.abort(), 22000);
    try {
      const info = ideaGreetingLocation && Date.now() - ideaGreetingLocation.recordedAt < 10 * 60 * 1000 ? ideaGreetingLocation : null;
      const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
      const response = await fetch(`${API_BASE_URL}/routes/idea-greeting`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, signal: controller.signal,
        body: JSON.stringify({ timezone, location: info?.location || null, locationSource: info?.source || 'unknown', city: info?.city || '' })
      });
      if (!response.ok) return;
      const data = await response.json();
      if (sequence !== greetingSequence || currentSessionId !== session || sessionTitle || content.querySelector('.idea-user-message')) return;
      if (typeof data.greeting === 'string' && data.greeting.trim()) animateIdeaTitle(limitIdeaTitle(data.greeting.trim()));
    } catch (error) {
      if (error.name !== 'AbortError') console.warn('[IdeaGreeting] 问候暂时不可用');
    } finally { clearTimeout(timeout); if (greetingRequest === controller) greetingRequest = null; }
  };
  const setTitle = value => {
    if (sessionTitle || typeof value !== 'string') return;
    const clean = limitIdeaTitle(value.replace(/[\r\n]+/g, ' ').trim());
    if (clean) { sessionTitle = clean; animateIdeaTitle(clean); }
  };
  const remember = (role, value) => {
    if (typeof value !== 'string' || !value.trim()) return;
    history.push({ role, content: value.trim().slice(0, 1000) });
    history = history.slice(-12);
  };
  const describeResult = data => {
    const parts = [data.message || ''];
    if (data.route) {
      parts.push(`路线：${(data.route.stops || []).map(stop => stop.name).join(' → ')}；总里程 ${Number(data.route.distanceKm).toFixed(1)} 公里；预计骑行 ${Math.round(data.route.durationMin)} 分钟${data.route.hasEstimatedTime ? '（含估算）' : ''}。`);
      if (Array.isArray(data.route.legs)) parts.push(`分段：${data.route.legs.map(leg => `${leg.type === 'segment' ? '路段' : '导航'} ${leg.name} ${Number(leg.distanceKm).toFixed(1)} 公里`).join('；')}。`);
      if (data.distanceNote) parts.push(data.distanceNote);
      if (data.note) parts.push(data.note);
    }
    if (Array.isArray(data.items) && data.items.length) parts.push(`推荐结果：${data.items.map((item, i) => `${i + 1}. ${item.name}（${item.type === 'segment' ? '路段' : '点位'}${Number.isFinite(item.distanceKm) ? `，${item.distanceKm.toFixed(1)} 公里` : ''}）${item.reason || ''}`).join('；')}`);
    return parts.filter(Boolean).join('\n');
  };
  const hideMenu = (restoreFocus = false) => {
    if (!menuOpen && menu.hidden) return;
    menuOpen = false;
    menu.classList.remove('is-visible');
    menu.inert = true;
    more.setAttribute('aria-expanded', 'false');
    clearTimeout(menuTimer);
    const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    menuTimer = setTimeout(() => {
      if (!menuOpen) { menu.hidden = true; sheet.classList.remove('menu-open'); }
    }, reducedMotion ? 0 : 220);
    if (restoreFocus) more.focus({ preventScroll: true });
  };
  const showConversation = () => {
    historyPanel.hidden = true;
    segmentDetail.hidden = true;
    content.hidden = false;
    form.hidden = false;
  };
  const saveConversation = () => {
    const firstMessage = content.querySelector('.idea-user-message')?.textContent?.trim();
    if (!firstMessage) return;
    sessions.set(currentSessionId, {
      id: currentSessionId, title: sessionTitle || limitIdeaTitle(firstMessage), sessionTitle,
      history: history.map(turn => ({ ...turn })), previousIntent, nodes: [...content.childNodes],
      draft: input.value, updatedAt: Date.now()
    });
  };
  const cancelConversationWork = () => {
    sessionEpoch++;
    ideaRequest?.abort(); ideaRequest = null;
    ideaRouteRequest?.abort(); ideaRouteRequest = null;
    send.disabled = false;
  };
  const resetConversation = () => {
    cancelGreeting();
    hideMenu();
    cancelConversationWork();
    saveConversation();
    currentSessionId = ++nextSessionId;
    history = []; previousIntent = null; sessionTitle = ''; greetingIndex++; animateIdeaTitle(greeting());
    content.replaceChildren(...emptyContent.map(node => node.cloneNode(true)));
    input.value = ''; resizeIdeaInput();
    showConversation();
    closeIdeaRoutePanel(); ideaMapLayer?.clearLayers(); ideaActiveRoute = null;
    if (!expanded) setExpanded(true);
    else loadNearbyRoutes();
    input.focus({ preventScroll: true });
    requestGreeting();
  };
  const restoreConversation = session => {
    cancelGreeting();
    hideMenu();
    if (session.id !== currentSessionId) {
      cancelConversationWork();
      saveConversation();
      currentSessionId = session.id;
      history = session.history.map(turn => ({ ...turn }));
      previousIntent = session.previousIntent;
      sessionTitle = limitIdeaTitle(session.sessionTitle || session.title);
      animateIdeaTitle(sessionTitle);
      content.replaceChildren(...session.nodes);
      input.value = session.draft || ''; resizeIdeaInput();
      closeIdeaRoutePanel(); ideaMapLayer?.clearLayers(); ideaActiveRoute = null;
    }
    showConversation();
    content.scrollTop = content.scrollHeight;
    input.focus({ preventScroll: true });
  };
  const openHistory = () => {
    hideMenu();
    saveConversation();
    if (!expanded) setExpanded(true);
    content.hidden = true;
    form.hidden = true;
    historyPanel.hidden = false;
    historyList.replaceChildren();
    const ordered = [...sessions.values()].sort((a, b) => b.updatedAt - a.updatedAt);
    if (!ordered.length) {
      const empty = document.createElement('p'); empty.className = 'idea-history-empty'; empty.textContent = '还没有历史对话。'; historyList.append(empty);
    } else {
      ordered.forEach(session => {
        const button = document.createElement('button'); button.type = 'button'; button.className = 'idea-history-item';
        const label = document.createElement('span'); label.textContent = session.title;
        const meta = document.createElement('small'); meta.textContent = session.id === currentSessionId ? '当前对话' : '继续对话';
        button.append(label, meta); button.addEventListener('click', () => restoreConversation(session)); historyList.append(button);
      });
    }
    document.getElementById('idea-history-back').focus({ preventScroll: true });
  };
  more.addEventListener('click', () => {
    if (menuOpen) { hideMenu(); return; }
    clearTimeout(menuTimer);
    menuOpen = true; menu.hidden = false; menu.inert = false;
    sheet.classList.add('menu-open'); more.setAttribute('aria-expanded', 'true');
    menu.getBoundingClientRect();
    requestAnimationFrame(() => { if (menuOpen) menu.classList.add('is-visible'); });
    document.getElementById('idea-history-open').focus({ preventScroll: true });
  });
  menu.addEventListener('keydown', event => {
    if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return;
    event.preventDefault();
    const buttons = [...menu.querySelectorAll('button')];
    const current = buttons.indexOf(document.activeElement);
    const offset = event.key === 'ArrowDown' ? 1 : -1;
    buttons[(current + offset + buttons.length) % buttons.length].focus();
  });
  newChat.addEventListener('click', resetConversation);
  document.getElementById('idea-history-open').addEventListener('click', openHistory);
  document.getElementById('idea-history-back').addEventListener('click', () => { showConversation(); more.focus({ preventScroll: true }); });
  document.addEventListener('click', event => { if (!event.target.closest('.idea-actions') && menuOpen) hideMenu(); });
  let expanded = false;
  let sheetState = 'collapsed';
  const syncIdeaEntryHeight = () => {
    if (expanded) return;
    const height = getComputedStyle(sheet).getPropertyValue('--idea-collapsed-height').trim();
    document.documentElement.style.setProperty('--idea-entry-height', height);
  };
  const setExpanded = (next) => {
    sheetState = next === true ? 'half' : next === false ? 'collapsed' : next;
    if (sheetState !== 'full' && document.activeElement === input) input.blur();
    next = sheetState !== 'collapsed';
    expanded = next;
    sheet.classList.toggle('is-full', sheetState === 'full');
    if (!next) {
      hideMenu();
      if (segmentDetail.classList.contains('active')) closeStravaSegmentDetails();
      showConversation();
    }
    sheet.classList.toggle('is-open', next);
    handle.setAttribute('aria-expanded', String(next));
    handle.setAttribute('aria-label', next ? '收起骑行想法' : '展开骑行想法');
    content.inert = !next;
    if (next) {
      loadNearbyRoutes();
      sheet.setAttribute('role', 'dialog');
    } else {
      sheet.removeAttribute('role');
      input.blur();
      requestAnimationFrame(syncIdeaEntryHeight);
    }
    if (sheetState === 'full') {
      backdrop.hidden = false;
      sheet.setAttribute('aria-modal', 'true');
      requestAnimationFrame(() => { if (sheetState === 'full') backdrop.classList.add('is-open'); });
    } else {
      backdrop.classList.remove('is-open');
      backdrop.hidden = true;
      sheet.removeAttribute('aria-modal');
    }
  };
  const close = () => setExpanded(false);
  document.getElementById('strava-detail-close').addEventListener('click', () => {
    const trigger = stravaDetailTrigger;
    closeStravaSegmentDetails();
    if (trigger?.isConnected) { setExpanded('half'); trigger.focus({ preventScroll: true }); }
  });
  document.addEventListener('strava-detail-change', event => {
    if (event.detail.open) {
      hideMenu();
      historyPanel.hidden = true;
      content.hidden = true;
      segmentDetail.hidden = false;
      form.hidden = false;
      setExpanded('half');
    } else {
      segmentDetail.hidden = true;
      showConversation();
      if (sheetState !== 'collapsed') setExpanded(false);
    }
  });
  const resizeIdeaInput = () => {
    input.style.height = 'auto';
    const viewportHeight = window.visualViewport?.height || window.innerHeight;
    const limit = Math.min(240, Math.max(72, Math.floor(viewportHeight * 0.3)));
    input.style.height = `${Math.min(input.scrollHeight, limit)}px`;
    input.style.overflowY = input.scrollHeight > limit ? 'auto' : 'hidden';
  };
  input.addEventListener('input', resizeIdeaInput);
  input.addEventListener('focus', () => {
    if (sheetState !== 'full') setExpanded('full');
    requestAnimationFrame(resizeIdeaInput);
  });
  input.addEventListener('keydown', event => {
    if (event.key !== 'Enter' || event.shiftKey || event.isComposing || event.keyCode === 229) return;
    event.preventDefault();
    if (!send.disabled) form.requestSubmit();
  });
  if (window.ResizeObserver) {
    let lastWidth = 0;
    new ResizeObserver(entries => {
      const width = entries[0]?.contentRect.width || 0;
      if (Math.abs(width - lastWidth) > 0.5) { lastWidth = width; resizeIdeaInput(); }
    }).observe(input.parentElement);
  }
  resizeIdeaInput();
  backdrop.addEventListener('click', close);
  const syncIdeaViewport = () => {
    const viewport = window.visualViewport;
    if (!viewport) return;
    const keyboardInset = Math.max(0, window.innerHeight - viewport.height - viewport.offsetTop);
    sheet.style.setProperty('--idea-viewport-height', `${viewport.height}px`);
    sheet.style.setProperty('--idea-keyboard-inset', `${keyboardInset}px`);
    sheet.classList.toggle('keyboard-open', keyboardInset > 100);
    resizeIdeaInput();
  };
  window.visualViewport?.addEventListener('resize', syncIdeaViewport);
  window.visualViewport?.addEventListener('scroll', syncIdeaViewport);
  window.addEventListener('resize', syncIdeaEntryHeight);
  if (window.ResizeObserver) {
    const collapsedSizeObserver = new ResizeObserver(syncIdeaEntryHeight);
    collapsedSizeObserver.observe(sheet.querySelector('.idea-header'));
    collapsedSizeObserver.observe(form);
  }
  syncIdeaViewport();
  syncIdeaEntryHeight();
  document.getElementById('idea-route-close').addEventListener('click', closeIdeaRoutePanel);
  map.on('click', closeIdeaRoutePanel);

  const loadNearbyRoutes = async () => {
    const list = content.querySelector('.idea-nearby-list');
    if (!list || list.dataset.loading) return;
    const priorKey = origin && ['manual', 'gps', 'ip'].includes(originLocationSource) ? `${Number(origin.lat).toFixed(4)},${Number(origin.lng).toFixed(4)},${originLocationSource === 'gps' && Date.now() - originGpsTimestamp >= 60000 ? 'gps-stale' : originLocationSource}` : '';
    if (priorKey && list.dataset.loaded === priorKey) return;
    list.dataset.loading = 'true';
    list.textContent = '正在规划附近的骑行路线…';
    try {
      await Promise.race([ideaLocationReady, new Promise(resolve => setTimeout(resolve, 5000))]);
      if (!list.isConnected) return;
      const available = origin && ['manual', 'gps', 'ip'].includes(originLocationSource) && Number.isFinite(Number(origin.lat)) && Number.isFinite(Number(origin.lng));
      if (!available) {
        list.textContent = '获取当前位置或设置起点后，即可查看路线推荐。';
        return;
      }
      const source = originLocationSource === 'gps' && Date.now() - originGpsTimestamp >= 60000 ? 'gps-stale' : originLocationSource;
      const key = `${Number(origin.lat).toFixed(4)},${Number(origin.lng).toFixed(4)},${source}`;
      if (list.dataset.loaded === key) return;
      const response = await fetch(`${API_BASE_URL}/routes/idea-distance-recommendations`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ origin: { lat: Number(origin.lat), lng: Number(origin.lng) }, originSource: source })
      });
      if (!response.ok) throw new Error('request failed');
      const data = await response.json();
      if (!list.isConnected) return;
      // Do not display results calculated from a location that has since changed.
      if (!origin || `${Number(origin.lat).toFixed(4)},${Number(origin.lng).toFixed(4)}` !== key.split(',').slice(0, 2).join(',')) {
        setTimeout(() => { if (list.isConnected) loadNearbyRoutes(); }, 0); return;
      }
      list.replaceChildren();
      (data.recommendations || []).forEach(({ targetKm, route, segmentScore }) => {
        if (![20, 50, 100].includes(targetKm)) return;
        const card = document.createElement(route ? 'button' : 'div');
        if (route) card.type = 'button';
        card.className = 'idea-nearby-route';
        const name = document.createElement('strong'); name.textContent = `${targetKm} 公里左右`;
        const distance = document.createElement('span');
        if (route && Number.isFinite(Number(route.distanceKm)) && Array.isArray(route.legs)) {
          const segment = route.legs.find(leg => leg.type === 'segment');
          distance.textContent = `实际约 ${Number(route.distanceKm).toFixed(1)} 公里 · ${segment?.name || '往返骑行'}${Number.isFinite(segmentScore) ? ` · 路段评分 ${segmentScore.toFixed(1)}` : ''}`;
          card.addEventListener('click', () => showCompositeIdeaRoute({ route, distanceNote: `目标约 ${targetKm} 公里，实际约 ${Number(route.distanceKm).toFixed(1)} 公里。`, note: [source === 'ip' ? '起点使用 IP 大致位置，可能与实际位置有偏差。' : source === 'gps-stale' ? '起点使用上次定位的位置，请确认是否仍准确。' : '', '路段里程按轨迹估算；部分骑行时间为估算值。'].filter(Boolean).join(' ') }, close));
        } else { distance.textContent = '暂未找到符合距离的路线'; card.classList.add('is-unavailable'); }
        card.append(name, distance); list.append(card);
      });
      if (!list.childElementCount) throw new Error('empty response');
      list.dataset.loaded = key;
    } catch (_) {
      if (list.isConnected) {
        list.replaceChildren();
        const retry = document.createElement('button'); retry.type = 'button'; retry.className = 'idea-nearby-retry'; retry.textContent = '路线推荐暂时不可用，点击重试';
        retry.addEventListener('click', loadNearbyRoutes); list.append(retry);
      }
    } finally { delete list.dataset.loading; }
  };

  const states = ['collapsed', 'half', 'full'];
  let startY = null;
  let startHeight = 0;
  let dragDistance = 0;
  let dragged = false;
  let dragPointer = null;
  const beginDrag = y => {
    startY = y; startHeight = sheet.getBoundingClientRect().height; dragDistance = 0; dragged = false;
    sheet.classList.add('is-dragging');
  };
  const moveDrag = y => {
    dragDistance = startY - y;
    if (Math.abs(dragDistance) > 5) dragged = true;
    const viewportHeight = window.visualViewport?.height || window.innerHeight;
    const minHeight = parseFloat(getComputedStyle(sheet).getPropertyValue('--idea-collapsed-height')) || 120;
    const height = Math.max(minHeight, Math.min(viewportHeight, startHeight + dragDistance));
    sheet.style.height = `${height}px`;
    if (sheetState !== 'full') {
      const inset = 12 - Math.min(4, Math.max(0, height - minHeight));
      sheet.style.setProperty('--idea-sheet-inset', `${inset}px`);
    }
  };
  const finishDrag = (cancelled = false) => {
    if (startY === null) return;
    startY = null;
    sheet.classList.remove('is-dragging');
    if (!cancelled && Math.abs(dragDistance) >= 60) {
      const index = states.indexOf(sheetState);
      setExpanded(states[Math.max(0, Math.min(2, index + (dragDistance > 0 ? 1 : -1)))]);
    }
    sheet.getBoundingClientRect();
    sheet.style.removeProperty('height');
  };
  handle.addEventListener('pointerdown', event => {
    if (event.button !== 0) return;
    dragPointer = event.pointerId; handle.setPointerCapture(event.pointerId); beginDrag(event.clientY);
  });
  handle.addEventListener('pointermove', event => { if (event.pointerId === dragPointer && startY !== null) moveDrag(event.clientY); });
  handle.addEventListener('pointerup', () => { finishDrag(); dragPointer = null; });
  handle.addEventListener('pointercancel', () => { finishDrag(true); dragPointer = null; });
  handle.addEventListener('click', event => {
    if (dragged) { event.preventDefault(); dragged = false; return; }
    setExpanded(sheetState === 'collapsed' ? 'half' : sheetState === 'half' ? 'full' : 'collapsed');
  });
  // Content keeps normal scrolling; a swipe at its boundary moves the sheet.
  let touchStart = null;
  let touchDragging = false;
  sheet.addEventListener('touchstart', event => {
    if (event.target.closest('.idea-handle, textarea, input')) return;
    touchStart = event.touches[0].clientY; touchDragging = false;
  }, { passive: true });
  sheet.addEventListener('touchmove', event => {
    if (touchStart === null) return;
    const y = event.touches[0].clientY;
    const delta = touchStart - y;
    const scroller = event.target.closest('.idea-content, .idea-history');
    const atTop = !scroller || scroller.scrollTop <= 0;
    const atBottom = !scroller || scroller.scrollTop + scroller.clientHeight >= scroller.scrollHeight - 1;
    const canMove = delta > 0 ? sheetState !== 'full' && (atTop || atBottom) : sheetState !== 'collapsed' && atTop;
    if (!touchDragging && Math.abs(delta) > 8 && canMove) { beginDrag(touchStart); touchDragging = true; }
    if (touchDragging) { if (event.cancelable) event.preventDefault(); moveDrag(y); }
  }, { passive: false });
  sheet.addEventListener('touchend', () => { if (touchDragging) finishDrag(); touchStart = null; touchDragging = false; });
  sheet.addEventListener('touchcancel', () => { if (touchDragging) finishDrag(true); touchStart = null; touchDragging = false; });
  sheet.addEventListener('keydown', event => {
    if (event.key === 'Escape') { if (menuOpen) { hideMenu(true); } else if (!historyPanel.hidden) { showConversation(); more.focus({ preventScroll: true }); } else close(); return; }
    if (event.key !== 'Tab' || sheetState !== 'full') return;
    const focusable = [...sheet.querySelectorAll('button:not(:disabled), input:not(:disabled), textarea:not(:disabled)')].filter(el => el.offsetParent !== null && !el.closest('[inert]'));
    if (!focusable.length) return;
    if (event.shiftKey && document.activeElement === focusable[0]) { event.preventDefault(); focusable[focusable.length - 1].focus(); }
    else if (!event.shiftKey && document.activeElement === focusable[focusable.length - 1]) { event.preventDefault(); focusable[0].focus(); }
  });
  content.addEventListener('click', event => {
    const example = event.target.closest('[data-idea]');
    if (example) { input.value = example.dataset.idea; document.getElementById('idea-form').requestSubmit(); }
  });
  document.getElementById('idea-form').addEventListener('submit', async event => {
    event.preventDefault();
    const idea = input.value.trim();
    if (!idea) { input.focus(); return; }
    cancelGreeting();
    ideaRequest?.abort();
    ideaRouteRequest?.abort();
    const request = new AbortController(); ideaRequest = request;
    const epoch = sessionEpoch;
    const sessionAtSubmit = currentSessionId;
    const priorHistory = history.map(turn => ({ ...turn }));
    send.disabled = true;
    content.querySelector('.idea-nearby')?.remove();
    content.querySelector('.idea-examples')?.remove();
    const sourceRect = input.getBoundingClientRect();
    const bubble = document.createElement('p'); bubble.className = 'idea-user-message'; bubble.textContent = idea;
    content.append(bubble); input.value = ''; resizeIdeaInput();
    const status = document.createElement('div'); status.className = 'idea-progress';
    const heading = document.createElement('button'); heading.type = 'button'; heading.className = 'idea-progress-title is-thinking';
    heading.setAttribute('aria-expanded', 'true');
    const headingText = document.createElement('span'); headingText.textContent = '正在思考';
    const chevron = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    chevron.setAttribute('viewBox', '0 0 1024 1024'); chevron.setAttribute('aria-hidden', 'true');
    const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    path.setAttribute('d', 'M192 384l320 320 320-320-90.5-90.5L512 522.7 282.5 293.5z'); path.setAttribute('fill', 'currentColor'); chevron.append(path);
    heading.append(headingText, chevron);
    const steps = document.createElement('ol'); steps.className = 'idea-progress-steps is-loading';
    heading.addEventListener('click', () => { const expanded = heading.getAttribute('aria-expanded') !== 'true'; heading.setAttribute('aria-expanded', String(expanded)); steps.hidden = !expanded; });
    status.append(heading, steps); content.append(status);
    content.scrollTop = content.scrollHeight;
    animateIdeaMessage(bubble, sourceRect);
    const addStep = stage => {
      const previous = steps.lastElementChild;
      if (previous) previous.classList.add('done');
      const step = document.createElement('li'); step.textContent = stage; steps.append(step);
      content.scrollTop = content.scrollHeight;
    };
    try {
      const center = map.getCenter();
      const response = await fetch(`${API_BASE_URL}/routes/idea-recommendations`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'Accept': 'text/event-stream' }, body: JSON.stringify({ idea, center: { lat: center.lat, lng: center.lng }, origin: origin && ['manual', 'gps', 'ip'].includes(originLocationSource) && Number.isFinite(Number(origin.lat)) && Number.isFinite(Number(origin.lng)) ? { lat: Number(origin.lat), lng: Number(origin.lng) } : null, originSource: originLocationSource === 'gps' && Date.now() - originGpsTimestamp >= 60000 ? 'gps-stale' : originLocationSource, history: priorHistory, previousIntent }), signal: request.signal });
      let data;
      if (!response.ok) { const error = await response.json(); throw new Error(error.error || '推荐暂时不可用，请稍后重试。'); }
      if ((response.headers.get('content-type') || '').includes('text/event-stream')) {
        data = await readIdeaStream(response, addStep, value => { if (sessionEpoch === epoch && ideaRequest === request) setTitle(value); });
      } else { data = await response.json(); }
      if (ideaRequest !== request || sessionEpoch !== epoch) return;
      setTitle(data.title || idea);
      if (data.contextIntent) previousIntent = data.contextIntent;
      remember('user', idea); remember('assistant', describeResult(data));
      if (steps.lastElementChild) steps.lastElementChild.classList.add('done');
      headingText.textContent = '思考完成';
      heading.classList.remove('is-thinking'); heading.setAttribute('aria-expanded', 'false'); steps.hidden = true;
      const answer = document.createElement('p'); answer.className = 'idea-answer'; answer.textContent = data.message || ''; content.append(answer);
      if (Array.isArray(data.options) && data.options.length) {
        const choices = document.createElement('div'); choices.className = 'idea-card-actions';
        data.options.slice(0, 3).forEach(option => {
          if (typeof option !== 'string' || !option.trim()) return;
          const button = document.createElement('button'); button.type = 'button'; button.textContent = option;
          button.addEventListener('click', () => { if (currentSessionId !== sessionAtSubmit || send.disabled) return; input.value = option; document.getElementById('idea-form').requestSubmit(); });
          choices.append(button);
        });
        content.append(choices);
      }
      if (data.needsOrigin) {
        const locate = document.createElement('button'); locate.type = 'button'; locate.className = 'idea-locate'; locate.textContent = '使用当前位置重新规划';
        const locateStatus = document.createElement('p'); locateStatus.className = 'idea-route-status'; locateStatus.setAttribute('role', 'status');
        locate.addEventListener('click', async () => {
          if (currentSessionId !== sessionAtSubmit) return;
          const locateEpoch = sessionEpoch;
          locate.disabled = true; locateStatus.textContent = '正在获取当前位置…';
          try { await ideaRouteOrigin(); if (sessionEpoch !== locateEpoch) return; input.value = idea; document.getElementById('idea-form').requestSubmit(); }
          catch (error) { locateStatus.textContent = error.message || '定位失败，请手动设置起点。'; }
          finally { locate.disabled = false; }
        });
        content.append(locate, locateStatus);
      }
      if (data.route) {
        const card = document.createElement('article'); card.className = 'idea-card idea-composite-card';
        const type = document.createElement('div'); type.className = 'idea-card-type'; type.textContent = '完整骑行路线';
        const title = document.createElement('h3'); title.textContent = `${Number(data.route.distanceKm).toFixed(1)} 公里 · 约 ${Math.round(data.route.durationMin)} 分钟`;
        const sequence = document.createElement('p'); sequence.textContent = data.route.stops.map(stop => stop.name).join(' → ');
        const legs = document.createElement('ol'); legs.className = 'idea-route-legs';
        (data.route.legs || []).forEach(leg => {
          const row = document.createElement('li');
          const details = [];
          if (leg.detail) {
            if (Number.isFinite(leg.detail.averageGrade)) details.push(`平均坡度 ${leg.detail.averageGrade}%`);
            if (Number.isFinite(leg.detail.elevationGainM)) details.push(`爬升 ${leg.detail.elevationGainM} 米`);
            if (Number.isFinite(leg.detail.athleteCount)) details.push(`${leg.detail.athleteCount} 人骑过`);
            if (leg.detail.hazardous === true) details.push('标记为危险');
          }
          row.textContent = `${leg.type === 'segment' ? '路段' : '导航'} · ${leg.name} · ${Number(leg.distanceKm).toFixed(1)} 公里${details.length ? `（${details.join(' · ')}）` : ''}`;
          legs.append(row);
        });
        const note = document.createElement('p'); note.className = 'idea-composite-note'; note.textContent = [data.distanceNote, data.note].filter(Boolean).join(' ');
        const actions = document.createElement('div'); actions.className = 'idea-card-actions';
        const show = document.createElement('button'); show.type = 'button'; show.textContent = '查看完整路线'; show.addEventListener('click', () => { if (currentSessionId !== sessionAtSubmit) return; remember('assistant', `用户查看了路线：${data.route.stops.map(stop => stop.name).join(' → ')}，总里程 ${Number(data.route.distanceKm).toFixed(1)} 公里。`); showCompositeIdeaRoute(data, close); });
        actions.append(show); card.append(type, title, sequence, legs, note, actions); content.append(card);
      }
      const items = Array.isArray(data.items) ? data.items : [];
      items.forEach(item => {
        const card = document.createElement('article'); card.className = 'idea-card';
        const type = document.createElement('div'); type.className = 'idea-card-type'; type.textContent = item.type === 'point' ? '推荐点位' : `骑行路段${Number.isFinite(item.distanceKm) ? ` · ${item.distanceKm.toFixed(1)} 公里` : ''}`;
        const title = document.createElement('h3'); title.textContent = item.name;
        const reason = document.createElement('p'); reason.textContent = item.reason;
        const actions = document.createElement('div'); actions.className = 'idea-card-actions';
        const show = document.createElement('button'); show.type = 'button'; show.textContent = '在地图查看'; show.addEventListener('click', () => { if (currentSessionId !== sessionAtSubmit) return; remember('assistant', `用户查看了${item.type === 'segment' ? '路段' : '点位'}：${item.name}。`); showIdeaOnMap(item, close); });
        const route = document.createElement('button'); route.type = 'button'; route.textContent = '规划前往路线'; route.addEventListener('click', () => { if (currentSessionId !== sessionAtSubmit) return; remember('assistant', `用户选择规划前往${item.name}。`); planIdeaRoute(item, route, close); });
        const routeStatus = document.createElement('p'); routeStatus.className = 'idea-route-status'; routeStatus.setAttribute('role', 'status');
        actions.append(show, route);
        if (item.type === 'segment') {
          const detail = document.createElement('button'); detail.type = 'button'; detail.textContent = '路段详情';
          detail.addEventListener('click', () => { if (currentSessionId === sessionAtSubmit) showStravaSegmentDetails(item, detail); });
          actions.append(detail);
        }
        card.append(type, title, reason, actions, routeStatus); content.append(card);
      });
      content.scrollTop = content.scrollHeight;
    } catch (error) {
      if (error.name !== 'AbortError') { headingText.textContent = '思考未完成'; status.classList.add('has-error'); const message = document.createElement('p'); message.className = 'idea-route-status'; message.textContent = error.message || '网络连接失败，请稍后重试。'; content.append(message); }
      else { headingText.textContent = '已取消'; }
      heading.classList.remove('is-thinking');
    } finally {
      steps.classList.remove('is-loading');
      if (ideaRequest === request) { send.disabled = false; ideaRequest = null; }
    }
  });
  requestGreeting();
});

function animateIdeaMessage(bubble, sourceRect) {
  if (window.matchMedia('(prefers-reduced-motion: reduce)').matches || !bubble.animate) return;
  const target = bubble.getBoundingClientRect();
  const flying = bubble.cloneNode(true);
  Object.assign(flying.style, { position: 'fixed', zIndex: '3001', left: `${target.left}px`, top: `${target.top}px`, width: `${target.width}px`, maxWidth: 'none', margin: '0', pointerEvents: 'none' });
  flying.setAttribute('aria-hidden', 'true'); document.body.append(flying); bubble.style.visibility = 'hidden';
  const animation = flying.animate([
    { transform: `translate(${sourceRect.left - target.left}px, ${sourceRect.top - target.top}px) scale(.92)`, opacity: .45 },
    { transform: 'translate(0, 0) scale(1)', opacity: 1 }
  ], { duration: 380, easing: 'cubic-bezier(.2,.8,.2,1)' });
  animation.finished.catch(() => {}).finally(() => { flying.remove(); bubble.style.visibility = ''; });
}

async function readIdeaStream(response, onProgress, onTitle = () => {}) {
  if (!response.body) throw new Error('推荐服务未返回结果，请重试。');
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = ''; let result;
  const processEvent = block => {
    let event = 'message'; const data = [];
    block.split(/\r?\n/).forEach(line => { if (line.startsWith('event:')) event = line.slice(6).trim(); else if (line.startsWith('data:')) data.push(line.slice(5).trim()); });
    if (!data.length) return;
    const payload = JSON.parse(data.join('\n'));
    if (event === 'progress') onProgress(payload.stage);
    else if (event === 'title') onTitle(payload.title);
    else if (event === 'result') result = payload;
    else if (event === 'error') throw new Error(payload.error || '推荐暂时不可用，请稍后重试。');
  };
  while (true) {
    const { value, done } = await reader.read();
    buffer += decoder.decode(value || new Uint8Array(), { stream: !done });
    const blocks = buffer.split(/\r?\n\r?\n/); buffer = blocks.pop(); blocks.forEach(processEvent);
    if (done) break;
  }
  if (buffer.trim()) processEvent(buffer);
  if (!result) throw new Error('推荐连接中断，请重试。');
  return result;
}

function closeIdeaRoutePanel() {
  const panel = document.getElementById('idea-route-panel');
  panel?.classList.remove('active');
  panel?.setAttribute('aria-hidden', 'true');
}
function showIdeaRoutePanel() {
  if (!ideaActiveRoute) return;
  closeStravaSegmentDetails(); closeHotPointDetails();
  const { item, route, source, composite } = ideaActiveRoute;
  document.getElementById('idea-route-title').textContent = composite ? '完整骑行路线' : `前往 ${item.name}`;
  document.getElementById('idea-route-origin').textContent = composite ? route.stops.map(stop => stop.name).join(' → ') : (source === 'manual' ? '从所选起点出发' : '从当前位置出发');
  const note = document.getElementById('idea-route-note');
  note.textContent = composite ? [composite.distanceNote, composite.note].filter(Boolean).join(' ') : '';
  const durationLabel = document.getElementById('idea-route-duration-label');
  durationLabel.textContent = composite && route.hasEstimatedTime ? '预计骑行（含估算）' : '预计骑行';
  document.getElementById('idea-route-distance').textContent = Number(route.distanceKm).toFixed(1);
  document.getElementById('idea-route-duration').textContent = Number.isFinite(Number(route.durationMin)) && Number(route.durationMin) > 0 ? Math.round(Number(route.durationMin)) : '--';
  document.getElementById('idea-route-signals').textContent = route.trafficLightsCount == null ? '--' : String(route.trafficLightsCount);
  const panel = document.getElementById('idea-route-panel');
  panel.classList.add('active');
  panel.removeAttribute('aria-hidden');
}


function showCompositeIdeaRoute(data, close) {
  const route = data.route;
  if (!Array.isArray(route.legs) || !route.legs.length) return;
  closeStravaSegmentDetails(); closeHotPointDetails();
  if (!ideaMapLayer) ideaMapLayer = L.layerGroup().addTo(map);
  ideaMapLayer.clearLayers();
  ideaActiveRoute = { route, composite: { distanceNote: data.distanceNote, note: data.note } };
  const allPoints = [];
  route.legs.forEach(leg => {
    if (!Array.isArray(leg.points) || leg.points.length < 2) return;
    const points = leg.points.map(point => [point.lat, point.lng]); allPoints.push(...points);
    const line = L.polyline(points, { pane: 'plannedRoutes', color: leg.type === 'segment' ? '#ffd600' : '#00e676', weight: leg.type === 'segment' ? 7 : 5, opacity: .95 }).addTo(ideaMapLayer);
    line.on('click', event => { L.DomEvent.stopPropagation(event); showIdeaRoutePanel(); });
  });
  route.stops.forEach(stop => {
    const marker = L.circleMarker([stop.point.lat, stop.point.lng], { pane: 'plannedRoutes', radius: stop.type === 'point' ? 8 : 6, color: '#fff', fillColor: stop.type === 'point' ? '#ff9100' : '#00b0ff', fillOpacity: 1, weight: 2 }).addTo(ideaMapLayer);
    const label = document.createElement('span'); label.textContent = stop.name; marker.bindTooltip(label);
    marker.on('click', event => { L.DomEvent.stopPropagation(event); showIdeaRoutePanel(); });
  });
  if (allPoints.length) map.fitBounds(L.latLngBounds(allPoints), { paddingTopLeft: [45, 60], paddingBottomRight: [45, 230], maxZoom: 16 });
  close(); showIdeaRoutePanel();
  updateLocationSearchStatus(`完整骑行路线已规划，约 ${Number(route.distanceKm).toFixed(1)} 公里`);
}

function showIdeaOnMap(item, close) {
  closeIdeaRoutePanel(); ideaActiveRoute = null;
  if (!ideaMapLayer) ideaMapLayer = L.layerGroup().addTo(map);
  ideaMapLayer.clearLayers();
  if (item.type === 'segment' && item.coordinates?.length) {
    const line = L.polyline(item.coordinates.map(p => [p.lat, p.lng]), { color: '#66e9a0', weight: 6 }).addTo(ideaMapLayer);
    map.fitBounds(line.getBounds(), { padding: [60, 60], maxZoom: 16 });
  } else {
    L.circleMarker([item.lat, item.lng], { radius: 9, color: '#d9ffe5', fillColor: '#00e676', fillOpacity: 1, weight: 3 }).addTo(ideaMapLayer);
    map.flyTo([item.lat, item.lng], 15);
  }
  close();
  if (item.type === 'segment') showStravaSegmentDetails(item);
}

function ideaRouteOrigin() {
  if (origin && originLocationSource === 'manual') return Promise.resolve({ point: { lat: Number(origin.lat), lng: Number(origin.lng) }, source: 'manual' });
  if (!navigator.geolocation || !window.isSecureContext) return Promise.reject(new Error('无法获取准确位置，请开启定位或手动设置起点。'));
  return new Promise((resolve, reject) => navigator.geolocation.getCurrentPosition(position => {
    origin = { lat: position.coords.latitude, lng: position.coords.longitude }; originLocationSource = 'gps'; originGpsTimestamp = Date.now();
    setIdeaGreetingLocation({ ...origin }, 'gps');
    document.getElementById('origin-input').value = '当前位置';
    resolve({ point: { ...origin }, source: 'gps' });
  }, () => reject(new Error('无法获取准确位置，请开启定位或手动设置起点。')), { enableHighAccuracy: true, timeout: 10000, maximumAge: 60000 }));
}

async function planIdeaRoute(item, button, close) {
  ideaRouteRequest?.abort();
  const request = new AbortController(); ideaRouteRequest = request;
  const status = button.closest('.idea-card').querySelector('.idea-route-status');
  button.disabled = true; button.textContent = '正在定位…'; status.textContent = '';
  const timer = setTimeout(() => request.abort(), 35000);
  try {
    const start = await ideaRouteOrigin();
    if (request.signal.aborted) throw new Error('定位或路线规划超时，请重试。');
    button.textContent = '正在规划…';
    const response = await fetch(`${API_BASE_URL}/routes/plan-fewest-signals`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ origin: start.point, destination: { lat: item.lat, lng: item.lng } }), signal: request.signal });
    const route = await response.json();
    if (!response.ok || !route.polyline || !Number.isFinite(Number(route.distanceKm))) throw new Error('路线规划暂时不可用，请稍后重试。');
    const points = decodePolyline(route.polyline);
    if (points.length < 2) throw new Error('路线规划暂时不可用，请稍后重试。');
    if (!ideaMapLayer) ideaMapLayer = L.layerGroup().addTo(map);
    ideaMapLayer.clearLayers(); ideaActiveRoute = { item, route, source: start.source };
    const line = L.polyline(points, { pane: 'plannedRoutes', color: '#00e676', weight: 6, opacity: .9 }).addTo(ideaMapLayer);
    line.on('click', event => { L.DomEvent.stopPropagation(event); showIdeaRoutePanel(); });
    L.circleMarker([start.point.lat, start.point.lng], { pane: 'plannedRoutes', radius: 6, color: '#fff', fillColor: '#00b0ff', fillOpacity: 1 }).addTo(ideaMapLayer);
    L.circleMarker([item.lat, item.lng], { pane: 'plannedRoutes', radius: 8, color: '#fff', fillColor: '#00e676', fillOpacity: 1 }).addTo(ideaMapLayer);
    map.fitBounds(line.getBounds(), { paddingTopLeft: [45, 60], paddingBottomRight: [45, 220], maxZoom: 16 });
    close(); showIdeaRoutePanel();
    updateLocationSearchStatus(`骑行路线已规划，约 ${Number(route.distanceKm).toFixed(1)} 公里`);
  } catch (error) {
    if (ideaRouteRequest === request) status.textContent = error.name === 'AbortError' ? '路线规划已取消或超时，请重试。' : (error.message || '规划失败，请重试。');
  } finally {
    clearTimeout(timer);
    button.disabled = false; button.textContent = '规划前往路线';
    if (ideaRouteRequest === request) ideaRouteRequest = null;
  }
}
