/* ==========================================================================
   VeloRoam 骑行路线规划 - 核心网页脚本 (Apple Maps Style)
   ========================================================================== */

// 自动检测并解析局域网宿主 IP，实现手机端局域网无缝对接！
const detectedHost = window.location.hostname && window.location.hostname !== 'localhost'
  ? window.location.hostname
  : '192.168.124.6';

const API_BASE_URL = window.location.protocol === 'https:'
  ? `https://${window.location.hostname}/api`
  : `http://${detectedHost}:3000/api`;

// 全局状态管理
let map = null;
let mapTileLayer = null;
let currentTheme = 'dark'; // 'dark' 或 'light'
let elevationChart = null;
let routeData = null;
let routeDataList = [];
let activeRouteIndex = 0;

// 地图图层组，方便重绘和清理
let markerGroup = null;
let polylineGroup = null;
let stravaGroup = null;
let scrubbedRiderMarker = null;
let loadedStravaSegments = new Map(); // 缓存和去重当前渲染在地图上的 Strava 路段 (ID -> Group)
let minScoreFilter = 50;              // 评分筛选阈值 (随 Zoom 动态变化)
const allFetchedSegments = new Map(); // 全局记录该会话抓取到的所有 Strava 原始路段数据 (ID -> Segment)
let selectedSegmentId = null;         // 当前选中正在查看的路段 ID (用于未选路段淡化)



// 规划坐标状态 (经纬度，不再直接呈现在输入框中)
let origin = null;        // 起点默认空，等待 GPS 定位或手动输入
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
    attributionControl: false
  }).setView([31.2304, 121.4737], 12);

  // 加载 CartoDB 极简黑夜图层
  mapTileLayer = L.tileLayer('https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png', {
    maxZoom: 19,
    subdomains: 'abcd'
  }).addTo(map);

  markerGroup = L.layerGroup().addTo(map);
  polylineGroup = L.layerGroup().addTo(map);
  stravaGroup = L.layerGroup().addTo(map);

  // 绑定地图视口变动事件（平移和缩放结束后，静默刷新 Strava 路段数据）
  map.on('moveend', () => {
    fetchStravaSegmentsSilently();
  });
}

/**
 * 启动时获取 HTML5 GPS 当前定位，若在移动端 HTTP 等非安全环境下，则通过 IP 定位或默认上海作为优雅兜底
 */
function initializeLocation() {
  const defaultShanghai = { lat: 31.2304, lng: 121.4737 };
  const defaultName = '上海人民广场';

  // 统一的 IP 定位及上海默认兜底处理函数
  const fallbackToIpOrShanghai = async (reason) => {
    console.warn(`[Location] 无法使用 HTML5 GPS (${reason})，正在尝试高精 IP 定位或默认上海兜底...`);

    try {
      // 使用支持 HTTP/HTTPS 双协议的免费 IP 定位服务
      const protocol = window.location.protocol === 'https:' ? 'https:' : 'http:';
      const ipRes = await fetch(`${protocol}//ip-api.com/json?lang=zh-CN`).catch(() => null);
      
      if (ipRes && ipRes.ok) {
        const ipData = await ipRes.json();
        if (ipData && ipData.status === 'success' && ipData.lat && ipData.lon) {
          const lat = ipData.lat;
          const lng = ipData.lon;
          origin = { lat, lng };
          
          const cityName = ipData.city || ipData.regionName || '上海市';
          document.getElementById('origin-input').value = cityName;
          
          console.log(`📍 IP 定位解析成功: ${cityName} (${lat}, ${lng})`);
          map.flyTo([lat, lng], 13, { animate: true, duration: 1.5 });
          drawSingleMarker('origin', origin, cityName);
          return;
        }
      }
    } catch (ipErr) {
      console.warn('⚠️ IP 定位接口请求异常:', ipErr);
    }

    // 终极默认兜底：上海人民广场
    origin = defaultShanghai;
    document.getElementById('origin-input').value = defaultName;
    map.flyTo([defaultShanghai.lat, defaultShanghai.lng], 13, { animate: true, duration: 1.5 });
    drawSingleMarker('origin', origin, defaultName);
  };

  // 只有在安全上下文（HTTPS 或 localhost）中才能正常调用 HTML5 GPS Geolocation API
  const isSecure = window.isSecureContext || window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1';

  if (navigator.geolocation && isSecure) {
    navigator.geolocation.getCurrentPosition(
      async (position) => {
        const lat = position.coords.latitude;
        const lng = position.coords.longitude;

        origin = { lat, lng };
        map.flyTo([lat, lng], 13, { animate: true, duration: 1.5 });

        // 🚀 使用我们高能的高德地图逆解析后端代理路由，瞬间返回秒级地名
        try {
          const res = await fetch(`${API_BASE_URL}/routes/reverse-geocode?lat=${lat}&lng=${lng}`);
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

  // 绑定 Strava 底部详情面板关闭事件
  const closeStravaBtn = document.getElementById('btn-close-strava-panel');
  if (closeStravaBtn) {
    closeStravaBtn.addEventListener('click', () => {
      const stravaPanel = document.getElementById('strava-details-panel');
      if (stravaPanel) stravaPanel.classList.remove('active');
      restoreAllSegmentsOpacity();
    });
  }

  // 点击 Leaflet 地图空白处时，自动收起 Strava 底部详情面板并恢复其余路段透明度
  if (map) {
    map.on('click', () => {
      const stravaPanel = document.getElementById('strava-details-panel');
      if (stravaPanel) {
        if (stravaPanel.classList.contains('active')) {
          stravaPanel.classList.remove('active');
          restoreAllSegmentsOpacity();
        }
      }
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
 * 切换黑夜/白天地图图层风格
 */
function toggleMapTheme() {
  const body = document.body;
  if (currentTheme === 'dark') {
    mapTileLayer.setUrl('https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png');
    currentTheme = 'light';
    body.classList.add('light-theme');
    console.log('☀️ Map Theme switched to Light Mode.');
  } else {
    mapTileLayer.setUrl('https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png');
    currentTheme = 'dark';
    body.classList.remove('light-theme');
    console.log('🌙 Map Theme switched to Dark Mode.');
  }

  // 刷新高度图以同步最新的网格线及指示器颜色
  if (elevationChart) {
    renderChart();
  }
}

/**
 * 根据地图缩放等级动态返回路段最低筛选评分，减少用户手动操作
 * - Zoom <= 11: 过滤评分 >= 70
 * - Zoom === 12: 过滤评分 >= 50
 * - Zoom === 13: 过滤评分 >= 30
 * - Zoom >= 14: 过滤评分 >= 0 (显示所有路段)
 */
function getMinScoreForZoom(zoom) {
  if (zoom <= 11) return 70;
  if (zoom === 12) return 50;
  if (zoom === 13) return 30;
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
  return function (...args) {
    clearTimeout(timer);
    timer = setTimeout(() => func.apply(this, args), delay);
  };
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
          inputEl.value = shortName;
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
        pointHoverBackgroundColor: currentTheme === 'light' ? '#1c1c1e' : '#ffffff',
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
            color: currentTheme === 'light' ? '#68686e' : '#8c8e94',
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
            color: currentTheme === 'light' ? 'rgba(0, 0, 0, 0.06)' : 'rgba(255, 255, 255, 0.04)',
            lineWidth: 1
          },
          ticks: {
            color: currentTheme === 'light' ? '#68686e' : '#8c8e94',
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

/**
 * 单条 Strava 黄金路段的高保真绘制渲染函数 (支持起终点圆点、动态旋转航向箭头与大型 28px 点击热区)
 */
/**
 * 单条 Strava 黄金路段的高保真绘制渲染函数 (支持起终点圆点、动态旋转航向箭头与大型 28px 点击热区)
 */
function drawSingleStravaSegment(seg) {
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
  }

  // 将 seg 和整个图层组关联存储在缓存 Map 中
  loadedStravaSegments.set(segId, { seg: seg, layer: segmentGroup });

  // 5. 稳定淡入动画，完全符合 Leaflet SVG 渲染管线生命周期，完美避免闪烁
  setTimeout(() => {
    const isDimmedCurrent = selectedSegmentId !== null && Number(selectedSegmentId) !== segId;
    const targetPolylineOpacity = isDimmedCurrent ? '0.15' : (selectedSegmentId !== null && Number(selectedSegmentId) === segId ? '1.0' : '0.85');
    const targetMarkerOpacity = isDimmedCurrent ? '0.15' : '0.95';
    const targetArrowOpacity = isDimmedCurrent ? '0.15' : '0.9';
    
    // 淡入可见折线
    const pathEl = visiblePolyline.getElement();
    if (pathEl) {
      pathEl.style.opacity = '0';
      pathEl.getBoundingClientRect(); // 强制触发重绘
      pathEl.style.transition = 'opacity 0.6s cubic-bezier(0.25, 1, 0.4, 1)';
      pathEl.style.opacity = targetPolylineOpacity;
    }

    // 淡入起点圆点
    const startEl = startMarker.getElement();
    if (startEl) {
      startEl.style.opacity = '0';
      startEl.getBoundingClientRect();
      startEl.style.transition = 'opacity 0.6s cubic-bezier(0.25, 1, 0.4, 1)';
      startEl.style.opacity = targetMarkerOpacity;
    }

    // 淡入终点圆点
    const endEl = endMarker.getElement();
    if (endEl) {
      endEl.style.opacity = '0';
      endEl.getBoundingClientRect();
      endEl.style.transition = 'opacity 0.6s cubic-bezier(0.25, 1, 0.4, 1)';
      endEl.style.opacity = targetMarkerOpacity;
    }

    // 淡入所有方向指示器
    const layers = segmentGroup.getLayers();
    for (let k = 4; k < layers.length; k++) {
      const dirEl = layers[k].getElement();
      if (dirEl) {
        const arrowDiv = dirEl.querySelector('.segment-direction-arrow');
        if (arrowDiv) {
          arrowDiv.style.opacity = '0';
          arrowDiv.getBoundingClientRect();
          arrowDiv.style.transition = 'opacity 0.6s cubic-bezier(0.25, 1, 0.4, 1)';
          arrowDiv.style.opacity = targetArrowOpacity;
        }
      }
    }
  }, 30);

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

/**
 * 静默请求当前地图视口 Bounds 内的 Strava Segments 路段数据，并利用 Leaflet 实时动态图层渲染
 * 升级版：实现不要跟手请求（600ms 拖拽后防抖）、微小位移过滤（位移 < 350米时不触发）并传递 zoom 级别
 * 终极迭代：不清理旧图层，只新增绘制 rawScore > 10 的唯一路段，配合路径出场动画与独立底部详情看板
 */
async function fetchStravaSegmentsSilently() {
  if (!map || !stravaGroup) return;

  const currentZoom = map.getZoom();
  // 🚀 终极规则：当缩放级别 <= 10 或 > 17 时，清空图层并跳过静默探索，不展示任何非选中路段
  if (currentZoom <= 10 || currentZoom > 17) {
    console.log(`[StravaRadar] 当前缩放等级 (${currentZoom}) 不在允许探索范围 [11-17] 内，清空未选中图层。`);
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

      if (distance < 350 && !zoomChanged) {
        console.log(`[StravaRadar] 地图微小位移 (${distance.toFixed(1)}米 < 350米)，忽略本轮请求以节省资源。`);
        return;
      }
    }

    // 3. 缩放等级改变时，清空当前未选中的图层，并立刻就地用新评分门槛筛选并绘制已缓存段
    const zoomChanged = currentZoom !== lastExploreZoom;
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
              drawSingleStravaSegment(seg);
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
      // 传递 zoom 级别给后端。当 zoom >= 14 时，后端将自动开启 2x2 网格并发分裂探索，拉满路段数量
      const response = await fetch(`${API_BASE_URL}/routes/strava-segments?bounds=${south},${west},${north},${east}&zoom=${currentZoom}`);
      if (!response.ok) {
        throw new Error(`Strava segments API response failed: ${response.status}`);
      }

      const segments = await response.json();
      if (!Array.isArray(segments)) return;

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
          drawSingleStravaSegment(seg);
          addedCount++;
        }
      });

      console.log(`🚴 [Strava] 视口静默增量刷新：共渲染了 ${addedCount} 条全新探索出的路段。当前客户端缓存渲染中: ${loadedStravaSegments.size}`);
    } catch (error) {
      console.warn(`[Strava] 静默视口探索请求被跳过或失败:`, error.message);
    }
  }, 600);
}

/**
 * 在页面底部独立看板展示 Strava 黄金路段详情
 */
function showStravaSegmentDetails(seg) {
  const panel = document.getElementById('strava-details-panel');
  if (!panel) return;

  // 填充信息
  document.getElementById('strava-panel-title').innerText = seg.name || '未命名路段';
  document.getElementById('strava-stat-score').innerText = seg.rawScore !== undefined ? seg.rawScore.toFixed(1) : '--';
  document.getElementById('strava-stat-distance').innerText = seg.distanceKm !== undefined ? seg.distanceKm.toFixed(2) : '--';
  document.getElementById('strava-stat-grade').innerText = seg.avgGrade !== undefined ? seg.avgGrade : '--';

  // 激活底栏滑入动画
  panel.classList.add('active');
}

