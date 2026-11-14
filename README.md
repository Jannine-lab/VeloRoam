# VeloRoam

VeloRoam 是一个骑行路线规划与探索 Web 项目。用户可以在地图上查找地点、浏览 Strava 路段、规划骑行路线，也可以用自然语言描述骑行想法，由后端结合地点、路段和骑行导航生成建议。

项目由静态网页和 Node.js API 组成。路线、点位和推荐结果依赖外部服务及数据库中的数据；数据覆盖、服务配额和道路实际通行情况都会影响结果。

## 功能

- **地图与路线规划**：基于 Leaflet 展示地图，支持位置搜索、起终点和途经点规划、路线详情及高程图；提供红绿灯较少的路线候选。
- **Strava 路段探索**：按地图视口读取路段并查看详情；支持从当前位置出发，经过选定路段后返回。路段详情按需缓存到 MySQL。
- **骑行想法**：用自然语言表达地点、里程、骑行体验或路段偏好，进行多轮对话和路线推荐。后端通过 LangGraph、DeepSeek 原生工具调用和结构化校验理解意图，实际轨迹由导航服务及已有路段提供。对话仅保存在当前页面，刷新后不会恢复。
- **路线输出**：支持将推荐路线导出为 GPX，并跳转到外部地图进行导航。
- **数据维护与评测**：提供 Strava 路段采集、详情缓存和标签回填，高德点位采集，以及骑行想法的自动化测试和模型评测工具。

当前前端的热门点位图层和首页推荐路线默认关闭；语音输入按钮尚未启用。具名地点解析主要面向上海。自主路线的重复路段比例是几何估算，不能保证道路通行、方向、景观或实时路况；部分时间使用估算值。更多边界见[自主路线生成说明](docs/autonomous-route-generator.md)。

## 技术组成

| 部分 | 主要技术 |
| --- | --- |
| 前端 | 原生 HTML、CSS、JavaScript，Leaflet、Chart.js |
| API | Node.js、TypeScript、Express |
| 数据 | MySQL 8 空间索引、Strava 路段和高德点位 |
| 骑行想法 | LangGraph、DeepSeek、Zod |
| 地图与路线 | 高德、Google Maps、OpenStreetMap/Overpass、OSRM，依功能使用 |

```text
VeloRoam/
├── VeloRoam-ui/          # 静态页面、地图交互、GPX 与前端测试
├── VeloRoam-api/
│   ├── src/controllers/  # API 控制器
│   ├── src/services/     # 路线、推荐、数据采集与标签服务
│   ├── src/prompts/      # 骑行想法的提示词
│   ├── src/evals/        # 对话评测
│   ├── src/scripts/      # 采集、导入、回填与数据库工具
│   ├── sql/              # MySQL 建表与迁移脚本
│   └── .env.example      # 环境变量示例
├── dev/                  # 开发工具、评测及扫描数据
└── docs/                 # 设计、路线生成及评测说明
```

## 本地运行

### 1. 准备环境

- Node.js 22 和 npm；开发服务器使用 Node 的 `--watch`。
- MySQL 8，准备一个空数据库，例如 `veloroam`，并为应用配置具有所需建表及读写权限的账号。
- 按需准备高德 Web 服务、Strava、DeepSeek 和 Google Maps 凭证。地图展示和部分路线功能需要访问相应外部服务。

```bash
cd VeloRoam-api
cp .env.example .env
npm ci
```

编辑 `VeloRoam-api/.env`，至少将数据库地址改为自己的配置；需要使用相应功能时填写对应的密钥：

| 变量 | 用途 |
| --- | --- |
| `DATABASE_URL` | MySQL 连接地址 |
| `AMAP_API_KEY` | 高德地点查询与骑行导航 |
| `DEEPSEEK_API_KEY`、`DEEPSEEK_MODEL` | 骑行想法对话；模型默认为 `deepseek-chat` |
| `STRAVA_CLIENT_ID`、`STRAVA_CLIENT_SECRET`、`STRAVA_REFRESH_TOKEN` | Strava 授权及刷新；也可按示例配置 `STRAVA_ACCESS_TOKEN` |
| `GOOGLE_MAPS_API_KEY` | Google Maps 相关服务 |
| `OSM_TRAFFIC_SIGNAL_OVERPASS_URL` | 可选的红绿灯查询 Overpass 地址 |
| `PORT`、`NODE_ENV` | API 端口及运行环境，默认端口为 3000 |

其他采集间隔、额度和功能开关见 [环境变量示例](VeloRoam-api/.env.example)。密钥放在本地 `.env` 中，不要提交到仓库。骑行想法会向 DeepSeek 发送用户输入和必要的候选摘要；问候功能可能向 Open-Meteo 查询经过粗化的位置对应的天气。

### 2. 启动 API 并初始化数据表

```bash
# 在 VeloRoam-api 目录
npm run dev
```

服务启动后尝试连接 MySQL，创建或更新 `strava_segments` 及路段详情表。数据库连接失败不会阻止 HTTP 服务启动，但依赖数据库的功能不能正常使用。`GET http://localhost:3000/health` 可检查进程是否响应，并不代表数据库及所有外部服务都可用。

点位表不由上述初始化自动创建。需要点位及其与路段的关联时，在基础路段表建立后，对目标数据库执行 [001_create_hot_points.sql](VeloRoam-api/sql/001_create_hot_points.sql)。需要点位详情及路段推荐表时，再运行：

```bash
npm run init:recommendation-tables
```

该命令要求点位、路段和路段详情表已存在，并会在目标数据库建表和回填；详见[数据表说明](VeloRoam-api/sql/recommendation-tables.md)。空表不会自动拥有路段或点位数据，需要配置并运行采集或导入流程。

### 3. 启动前端

在另一个终端运行：

```bash
cd VeloRoam-ui
python3 -m http.server 8080
```

访问 `http://localhost:8080`。本地 HTTP 页面默认请求 `http://127.0.0.1:3000/api`；局域网 HTTP 页面默认请求当前主机的 3000 端口，也可通过 `?apiHost=主机:端口` 覆盖。HTTPS 页面默认通过同源 `/api` 访问，需要在部署时配置反向代理。浏览器定位通常需要 HTTPS 或 localhost。

## 开发与验证

以下命令在 `VeloRoam-api` 目录运行：

```bash
npm run typecheck    # TypeScript 类型检查
npm run build        # 编译到 dist/
npm test             # 后端测试
npm run test:ui      # 前端测试
npm start            # 运行已编译的 API
```

骑行想法的真实模型评测会请求 DeepSeek 并消耗额度：

```bash
npm run eval:idea -- --concurrency=2
```

评测使用固定替身检索和规划数据，不能代表真实地图算路质量。评测范围、工具调用及输出说明见[评测文档](docs/ai-tool-use-and-evaluation.md)。需要检查自主路线候选时，可按[调试说明](docs/autonomous-route-generator.md)启用仅限本机访问的调试页面。

### LangSmith 追踪

将 [环境变量示例](VeloRoam-api/.env.example) 中的 LangSmith 配置复制到后端 `.env`，填写 `LANGSMITH_API_KEY`，设置 `LANGSMITH_TRACING=true` 后重启 API。已有追踪项目时，将其 Tracing Project ID 填入 `LANGSMITH_PROJECT_ID`，VeloRoam 会优先使用该 ID。也可以按名称配置 `LANGSMITH_PROJECT`，示例名称为 `veloroam`。如果工作区按 Agent 和环境组织追踪，可将目标环境的 `tracer_session_name` 用作项目名。使用跨工作区密钥时填写 `LANGSMITH_WORKSPACE_ID`，非默认区域则设置 `LANGSMITH_ENDPOINT`。[LangSmith 配置文档](https://docs.langchain.com/langsmith/trace-with-langchain) · [按项目 ID 写入](https://docs.langchain.com/langsmith/trace-with-api)

发起一次「骑行想法」对话后，在 LangSmith 查找 `veloroam.idea.recommendations`。响应中的 `meta.requestId` 对应该轮 Trace ID。展开记录可查看意图理解、检索和响应节点，以及 DeepSeek 调用和实际执行的检索工具。首页 AI 问候以 `veloroam.idea.greeting` 单独记录。

示例配置隐藏输入和输出，仍可查看调用耗时、错误、Token 用量和提示词版本。调试合成用例时，可将 `LANGSMITH_HIDE_INPUTS` 和 `LANGSMITH_HIDE_OUTPUTS` 设为 `false` 查看内容。开启内容记录后，用户消息、历史和路线位置可能会发送到 LangSmith。[LangSmith 隐私设置](https://docs.langchain.com/langsmith/mask-inputs-outputs)

## 数据采集与接口

- `ENABLE_CRAWLER=true` 可在数据库初始化成功后启动 Strava 采集调度；`ENABLE_HOT_POINT_CRAWLER=true` 启动高德点位采集。两者默认不启动，会消耗外部 API 配额并写入数据库。
- `GET /api/crawlers/status` 查看采集状态。`/api/crawlers/{strava|hot-points}/{run|start|stop}` 提供 POST 控制接口；生产环境需设置 `ENABLE_CRAWLER_API=true` 才允许执行这些操作。部署时应限制接口访问。
- 路段标签回填使用 `npm run backfill:segment-tags -- --report=新报告路径` 预览；写入需显式传入 `--apply`。迁移脚本及说明位于 `VeloRoam-api/sql/`。
- 瓦片数据可通过 `src/scripts/importStravaTileSegments.ts` 导入，默认预览，`--apply` 才写入。导入会调用 Strava 详情接口，应注意授权、配额及目标数据库。

主要 API 包括 `/api/routes/plan`、`/api/routes/plan-fewest-signals`、`/api/routes/idea-recommendations`、`/api/routes/idea-distance-recommendations`、`/api/routes/segment-round-trip`、`/api/routes/strava-segments`、`/api/routes/hot-points` 和地点查询接口；方法及完整路由以 [routeRoutes.ts](VeloRoam-api/src/routes/routeRoutes.ts) 为准。

## 许可

后端 `package.json` 声明许可证为 ISC；仓库目前未提供单独的根目录许可证文件。第三方图标许可见 [图标许可证](VeloRoam-ui/assets/icons/LICENSE)。

## 管理员入口

API 提供 `GET /observer`。设置 `OBSERVER_USERNAME` 和强随机 `OBSERVER_PASSWORD`，并在反向代理中将 `/observer` 转发至 API（保留 `Authorization` 请求头）。仅通过 HTTPS 使用并在代理层限制登录尝试；未配置凭据时入口返回 503。页面默认读取项目中的 `VeloRoam-ui/observer.html`；部署时如目录布局不同，通过 `OBSERVER_HTML_PATH` 指定其绝对路径。API Docker 镜像不包含前端文件，须挂载该文件并设置此变量。当前页面尚未接入数据采集或展示。
