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
*   **Zoom 网格并发分裂探索 (Grid Subdivisions)**：绕过 Strava 每次只返回 10 条路段的硬限制。当用户放大地图（Zoom >= 13）时，后端自动将 bounds 切分为 **`2x2` 的四等分微型网格**并发请求，将路段发现上限**暴增 400% 至 40 条**！
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
开发环境使用 Node.js 22，并通过 Node 自带的监听模式热重载，不依赖系统临时目录中的 `ts-node-dev` 钩子文件。

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

后端启动命令
. ~/.nvm/nvm.sh && nvm use 22
npm run dev

前端启动命令
python3 -m http.server 8080
备选
. ~/.nvm/nvm.sh && nvm use 22
npx http-server -p 8080

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

### 骑行想法推荐

点击地图搜索栏旁的麦克风图标，输入骑行想法后可查看附近真实点位或 Strava 路段，并从当前位置或手动设置的起点规划前往路线。语音按钮暂未启用。没有明确地点时，以当前地图中心作为推荐范围；输入明确的上海地点时通过高德解析。推荐依赖 MySQL 的 `hot_points` 和 `strava_segments` 数据。

在后端 `.env` 中设置 `DEEPSEEK_API_KEY`，可选设置 `DEEPSEEK_MODEL`，然后重启后端。LangChain 依赖需要 Node.js 20 或更高版本。用户输入和必要的候选信息会发送至 DeepSeek；抽屉展示实际处理步骤。

综合路线默认从当前位置出发、在当前位置结束，也支持自然语言指定起终点或返回出发地。规划前会补问缺失的里程或时间预算和骑行体验；目标里程未给出明确范围时按上下浮动 10% 搜索，用户明确的上下限优先。候选路段会读取已计算的爬坡、绕圈、往返、长距离、热门和高收藏标签；未知标签保持未知。连接段使用高德骑行路线，路段使用 Strava 轨迹；不能连接时不会以模拟路线代替。部分骑行时间可能按 18 km/h 估算，包含停留的总时间在停留时长未知时无法确认。具名地点解析目前限制在上海，数据覆盖和道路实际通行情况可能影响结果。

骑行想法支持页面内的连续对话：首次请求生成会话标题，后续请求结合最近对话、当前需求摘要和已展示的结果；右上角按钮可开始新对话。会话暂存在当前页面，刷新后不会恢复。

每次打开一个新的骑行想法会话时，后端会根据本地时段及可用的附近天气、城市信息生成一句问候。天气由 Open-Meteo 提供；定位会先取约 0.01 度精度再查询天气与城市，模型只接收城市和天气摘要。获取失败时显示本地备用问候。

### Prompt、原生工具调用与输出评测

骑行对话现在使用 DeepSeek 原生 Function Calling，提供候选检索、地点解析和候选详情核验三个只读工具。后端使用 Zod 校验工具参数与模型输出，限制调用次数、超时及返回内容；实际路线仍交由已有规划与约束校验服务处理。五类业务 Prompt 统一保存在 `VeloRoam-api/src/prompts/ideaPrompts.ts` 并记录版本。

使用 Node.js 22，在 `VeloRoam-api` 目录运行 `npm run typecheck`、`npm test` 和 `npm run test:ui`。`npm run eval:idea -- --concurrency=2` 会使用现有 `DEEPSEEK_API_KEY` 调用真实模型，运行 60 个场景、73 轮对话的规则评测并生成原始结果和汇总报告。检索数据及规划器使用固定替身，该评测针对意图、上下文、候选身份和工具调用，不代表真实地图算路质量。完整说明见 [工具调用与评测文档](docs/ai-tool-use-and-evaluation.md)。

### Strava 路段详情缓存

`GET /api/routes/strava-segments/:id` 优先读取 `strava_segment_details` 中的完整详情；没有详情时才请求 Strava，成功后将完整响应保存到 `raw_detail`，并同步保存常用字段。已有基础路段记录并不代表详情已缓存。详情不会自动刷新；需要重新获取时，可由数据库管理员删除对应详情记录后再次查询。服务启动时会创建详情表，独立部署也可执行 `VeloRoam-api/sql/003_create_strava_segment_details.sql`。数据库不可用或保存失败时接口会报错，不会把未保存的结果当作成功返回。

### 从地图瓦片导入缺失路段

`src/scripts/importStravaTileSegments.ts` 接收已解码的瓦片 JSON（`source: "strava-map-vector-tile"`，`segments` 数组包含 `id` 和 `tileScore`），按路段 ID 去重并跳过 `strava_segments` 中已有的记录。新增路段通过详情 API 补全信息并缓存完整响应，使用详情中的 `map.polyline` 保存轨迹，不使用瓦片中可能被裁切的几何。瓦片的 `score` 原值保存到 `strava_score`；`raw_score` 使用当前实时导入逻辑的 VeloRoam 自定义评分。人数、尝试次数和收藏数取自详情 API。详情先缓存，再插入基础记录；若基础记录插入失败，重跑可以复用缓存。每条处理后保存报告，结束时回读核对轨迹、详情 ID 和瓦片评分。

在 `VeloRoam-api` 目录运行（默认仅预览，添加 `--apply` 写入）：

```bash
node --require ts-node/register/transpile-only src/scripts/importStravaTileSegments.ts --input=../dev/strava-map-tile-2026-11-03.json --report=../dev/strava-map-tile-preview.json
node --require ts-node/register/transpile-only src/scripts/importStravaTileSegments.ts --input=../dev/strava-map-tile-2026-11-03.json --report=../dev/strava-map-tile-import.json --apply
```

请求串行执行，默认间隔 2 秒，可通过 `--interval-ms` 调整。遇到 401、403 或 429 时停止；解决授权或配额问题后重跑，已入库的路段会自动跳过。服务启动时会补齐 `strava_score` 字段；独立运行导入脚本前需确保该列及详情表已存在。

长批次可增加 `--wait-for-quota`：读取 Strava 返回的读取及总请求配额，在短时额度约 90% 或每日额度约 98% 时等待相应窗口恢复，并遵守 429 的 `Retry-After`。额度属于整个应用，其他请求仍可能提前消耗额度；429 会保留当前 ID 等待重试，401/403 则停止。进度报告中的 `status`、`nextRequestAt`、`imported` 和 `failed` 可用于检查运行情况；等待配额时释放数据库连接，恢复后重新连接并获取锁。终止后可从已有记录继续。

已有基础路段可用 `src/scripts/backfillStravaTileScores.ts --input=FILE --report=FILE --apply` 补齐为空的 `strava_score`。脚本不会覆盖非空 Strava 评分，也不会修改 `raw_score`；在同一事务中回读核验后提交。上海 z13 工作矩形的分片进度位于 `dev/strava-shanghai-z13-2026-11-03/manifest.json`，去重结果位于同目录的 `candidates.json`。分片发现与详情导入分别记录，瓦片发现完成不代表所有详情已入库。
