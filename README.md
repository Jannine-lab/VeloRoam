# 🚴 VeloRoam

> **Apple Maps 奢华暗黑美学 (Apple Maps Dark Aesthetic) ⇆ 高精度多因子骑行路由规划与 Strava 黄金路段静默探索雷达**

VeloRoam 是一款专为硬核骑行爱好者与极客骑手打造的**殿堂级全栈骑行规划 Web 应用**。我们彻底打破了传统繁琐卡片布局的束缚，极致还原了 iOS / Apple Maps 的原生悬浮与滑动抽屉触感，并在底层部署了高精度的多因子路由打分引擎与 Strava 真实路段静默雷达。

---

## ⛰️ 核心技术亮点与特色功能 (Technical Masterpieces)

### 1. 苹果极奢暗黑交互与阻尼卡片抽屉 (Sliding Bottom Sheet)
*   **iOS 物理手势抽屉**：前端高度还原苹果地图 UI，支持在移动端/桌面端进行**零延迟、零卡顿的高精度物理跟手拖曳**，并根据阈值自动回弹吸附至 `80vh`（展开）或 `184px`（折叠）。
*   **全宽手势操作区**：`100%` 水平宽度的隐形拖拽抓取条，覆盖整个面板顶部，绝无触控死角，操作极度丝滑。
*   **地图悬浮功能组 (FABs)**：集成半透明圆形控制键，支持 **`Dark Matter (炫酷黑夜)`** 与 **`Positron (极简白天)`** 图层一键秒切，以及平滑 `flyTo` 重心 GPS 定位。

### 2. 多核混合双引擎与高精度火星坐标纠偏 (AMap & Google Dual-Engine)
*   **WGS-84 ⇆ GCJ-02 纠偏算法**：内置高精度数学级投影转换。在请求高德前自动将 WGS-84 转为火星坐标（GCJ-02），在数据返回后自动还原为 WGS-84 绘制在地图上，实现**与世界地图底图 $100\%$ 像素级绝对贴合**。
*   **多途经点并行分段规划**：攻克了高德骑行 Web 服务不支持多途经点的缺陷，后端自动拆分子路径（Legs）并发求解，并由插值器无缝拼接为连贯折线。
*   **四级智能路由降级链**：高德骑行（精细实路） ──> 谷歌骑行（欧美首选） ──> OSRM 真实路网降级（免 Key 备用） ──> 高保真 Mock 演示（无网兜底），坚不可摧。

### 3. 多因子加权骑行打分看板与多备选横向滑卡 (Specialist Scoring)
*   **三大骑行专精打分**：
    *   **绿道风景星级 (Scenic Stars)**：批量调用 Overpass API 分析公园、水体等自然要素距离，动态渲染 FontAwesome 精美星级。
    *   **舒适好骑度 (Comfort Score)**：深度分析高程采样点，计算坡度差、陡坡比例与非自行车道惩罚。
    *   **连贯避堵率 (Traffic Lights)**：检索沿途交叉口红绿灯分布，预估起步顿挫频次。
*   **Apple 横向备选卡片**：详情页顶部横向滑动卡片，带 `"避堵山地爬坡"`、`"优选江景绿道"` 等自适应个性化标签。支持地图背景灰色备选线，点击线路秒级切换。
*   **跨图表 Scrubbing 联动**：鼠标划过 Chart.js 高程图时，地图上会同步出现**蔚蓝色呼吸灯虚拟骑手圆点**进行高精度实路跟手追踪。

### 4. 寻味骑行个性化定制与黄金 POI 补给路由 (Supply Station Planning)
*   **iOS 级 Range 个性滑块**：支持目标里程、预计时间及途中美食补给公里数设定。补给上限随目标里程动态更新（最高 `80%`），严防逻辑冲突。
*   **黄金 POI 周边搜索雷达**：后端沿骑行轨迹进行里程积分，精确锁定补给里程对应的物理坐标点，向高德 POI 发起 5 公里半径雷达搜索，调取权重最高的美食/驿站注入为途中途经点。
*   **一键闭环返程 (Round Trip)**：开启后，吃饱喝足系统会自动将终点重置为起点，为您设计一条完美的起终点贴合的闭环骑行环线。
*   **金色 Pin 针与垂直黄金线**：地图上插上水晶发光 Pin 针（内置 🐑/☕/🥬/🏪 补给 Emoji），并在高度剖面图的对应公里数位置画出**金色垂直虚线标注 🍜 驿站**。

### 5. 基于当前视口的 Strava 真实黄金路段静默探索雷达 (Strava Exploration)
*   **后端 Token 缓存与自动刷新**：内存中实时检测 Strava Access Token 效期，过期自动通过 `refresh_token` 并组合 credentials 刷票，保障服务 24h 永远稳定。
*   **Zoom 网格并发分裂探索 (Grid Subdivisions)**：绕过 Strava 每次只返回 10 条路段的硬限制。当用户放大地图（Zoom >= 14）时，后端自动将 bounds 切分为 **`2x2` 的四等分微型网格**并发请求，将路段发现上限**暴增 400% 至 40 条**！
*   **空间冗余去重与 loops 优先打分 (Greedy Spatial Deduplication)**：
    *   **路段价值打分**：闭环刷圈（Start/End < 150m）直接斩获 `+15` 分巨额分，长线与爬坡挑战带加分。
    *   **N² 空间去重**：按得分降序后，进行 N² 贪心空间重合率扫描（阈值 70%）。高得分的优质闭环/长线段天然被保留为代表，其余高度平行的短细碎线段被优雅剪枝。
*   **严格 15 条 FIFO 视觉去载与离场渐隐**：防止视窗内路线堆叠引发信息过载。当路段数超过 `15` 条时，FIFO 队列自动将最老路段弹栈，并触发 **`0.8s` 渐隐并变细的消融出场动画**，优雅从地图上淡化释放。
*   **动态等时出场绘制动画 (2.0s Line-Drawing)**：拒绝生硬闪现。利用 Leaflet `pathEl.getTotalLength()` 动态测算折线真实物理像素长度，利用 SVG stroke-dash 属性与三次贝塞尔曲线，**确保不论 1km 还是 10km 路段，都在精确的 2.0s 内流畅等时沿路蔓延绘制完成**！
*   **iOS 级专属底部详情看板**：拆除 Leaflet 刺眼的 Popup 弹窗，全新打造固定于屏幕下方的暗黑磨砂玻璃详情卡片，展示 `name`、`rawScore`、`distanceKm`、`avgGrade`，支持关闭按钮与点击地图空白处优雅下滑收起。

### 6. HTML5 GPS ⇆ IP 双工多级智能定位降级链 (Mobile Geolocation)
*   **安全上下文校验 (Secure Context)**：预判非 HTTPS 局域网调试下，移动端浏览器对 GPS API 的隐私阻断。
*   **公网 IP Geolocation 降级**：GPS 超时（4000ms）或被 HTTP 协议限制时，秒级降级至公网 `ip-api.com` 接口（支持 HTTP/HTTPS 双栈）获取移动端 IP 对应的城市及位置，实现局域网测试下的零触控自动定位。
*   **上海人民广场兜底**：断网或极端情况下，默认优雅定位在上海市中心，防止视角随机飞越乱跳。

---

## 🛠️ 全栈代码目录结构 (Codebase Structure)

```
VeloRoam/
├── docs/
│   └── VeloRoamPRD.md                  # 应用核心 PRD 交互与算法规范
├── VeloRoam-api/ (Node.js TypeScript 后端服务)
│   ├── src/
│   │   ├── index.ts                    # 后端服务入口 (开启 0.0.0.0 局域网监听)
│   │   ├── controllers/
│   │   │   ├── routeController.ts      # 多路径打分规划、美食 POI 注入控制器
│   │   │   └── stravaController.ts     # Strava 黄金路段参数清洗与代理端点
│   │   ├── routes/
│   │   │   └── routeRoutes.ts          # Express API 路由注册
│   │   ├── services/
│   │   │   ├── amapService.ts          # 高德 WGS-84 ⇆ GCJ-02 并行规划与 POI 周边搜索服务
│   │   │   ├── googleMapsService.ts    # 谷歌及混合多路由管理器
│   │   │   ├── routeScorer.ts          # Scenic, Comfort, Traffic 多因子打分引擎
│   │   │   ├── osmService.ts           # Overpass API 绿地/红绿灯批量检索服务
│   │   │   └── stravaService.ts        # 内存自动刷新令牌、网格并发、N²去重 Strava 数据服务
│   │   └── utils/
│   │       └── polyline.ts             # 坐标纠偏与 Encoded Polyline 后端解码工具
│   ├── .env                            # [需要配置] 本地环境变量
│   └── tsconfig.json                   # TS 编译配置
└── VeloRoam-ui/ (HTML/CSS/JS 前端静态网页)
    ├── index.html                      # 奢华磨砂暗黑主界面、iOS卡片列表、高度剖面图、Strava底部底板
    ├── style.css                       # 垂直航线联结器、iOS 滑块阻尼面板、发光霓虹特效样式表
    └── app.js                          # 阻尼卡片手势跟手拖曳、GPS-IP 定位链、动态 2s 等时动画、FIFO 视觉去载
```

---

## ⚙️ 快速启动与本地部署 (Quick Onboarding)

### 1. 克隆项目并配置环境变量
在 `/Users/jannine/Desktop/VeloRoam/VeloRoam-api` 目录下创建并编辑 `.env` 配置文件（可参考 `.env.example`）：
```env
PORT=3000
NODE_ENV=development

# 逆地理与多路径规划高精度高德 Web 服务 Key
AMAP_API_KEY=您的高德Web服务API_Key

# Strava API 配置项 (请替换为您的实际应用凭证)
STRAVA_CLIENT_ID=您的Strava_Client_ID
STRAVA_CLIENT_SECRET=您的Strava_Client_Secret
STRAVA_REFRESH_TOKEN=您的Strava_Refresh_Token

# 临时/直发 Access Token (开发调试可选)
# 配置此项后，系统将在 6 小时内直接采用此 Access Token 进行 Segment explore，完全绕过 refresh_token 换票流程
STRAVA_ACCESS_TOKEN=您的有效Access_Token
```

### 2. 启动后端 API 开发服务器
```bash
cd VeloRoam-api
# 安装依赖
npm install
# 启动热重载开发服务器
npm run dev
```
编译成功后，控制台会输出：
```text
========================================
🚴 VeloRoam API Server is running!
🔌 Port: 3000
🌍 Environment: development
========================================
```

### 3. 启动前端局域网静态网页托管
```bash
cd VeloRoam-ui
# 使用 http-server 开启局域网广播
npx http-server -p 8080
```
启动后您可以通过以下地址畅快调试：
*   **本地浏览器**: `http://localhost:8080`
*   **手机/真机局域网**: `http://192.168.124.6:8080` *(手机端能无缝获取 IP 定位，并具备 100% 原生的 iOS 滑动拖拽物理手势反馈！)*

---

## 🎨 极奢视觉效果预览 (Visual Feast)

VeloRoam 采用了**最严苛的暗黑微发光设计规范**：
1.  **磨砂毛玻璃底板**：`backdrop-filter: blur(20px)`，让卡片在深邃地图上拥有完美悬浮质感。
2.  **Strava 经典品牌发光橙**：以 `#ff6d00` 作为路段主色调，鼠标划过触发 `#ff9100` 的 Glow 呼吸高光加粗特效。
3.  **三级降级等时动效**：不论长短，任何新路线都将在 2.0s 内以流水蔓延的生命力优雅铺开，并在多于 15 条时以 0.8s 悄然渐隐消融退场。
4.  **金色水晶 Pin 针与高程虚线**：金色垂直虚线标记 🍜 驿站，带来无与伦比的数据流动美学。

---

## 📄 许可协议 (License)
本项目基于 **ISC 许可协议** 开源。VeloRoam 开发团队倾力呈献。
