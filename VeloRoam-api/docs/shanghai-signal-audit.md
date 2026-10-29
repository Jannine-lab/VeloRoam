# 上海骑行路线 OSM 信号灯抽样核查

该任务不修改数据库，也不把 OSM 匹配数当成真实红绿灯数。它自动解析上海地标坐标，按浦西中心、浦西西南、浦东三个区域挑选最多 30 组 A-B 起终点；每组向高德查询骑行备选路线，再按区域批量查询 OSM 信号灯及带灯过街点。

## 运行

当前抽样任务已暂时停用。恢复时需取消 `src/scripts/auditShanghaiSignals.ts` 文件末尾入口的注释，并移除停用提示及退出码。

在 `VeloRoam-api` 目录运行：

```bash
npm run audit:shanghai-signals
npm run audit:shanghai-signals -- --limit 3
npm run audit:shanghai-signals -- --input reports/shanghai-signal-audit/<运行时间>/report.json
```

新采样需要 `.env` 中的 `AMAP_API_KEY`。可用 `OSM_TRAFFIC_SIGNAL_OVERPASS_URL` 指向能访问的 Overpass 实例。默认输出到 `reports/shanghai-signal-audit/<运行时间>/`，也可用 `--output /absolute/path` 指定新的空目录。一次完整运行会使用约 30 次高德骑行算路请求以及地标检索请求。若 Overpass 暂不可用，用 `--input` 读取已生成的 `report.json`，仅重试失败区域的 OSM 查询，不再调用高德；新结果写入另一个时间戳目录。

## 产物

- `report.html`：可交互地图，显示高德候选路线、OSM 匹配节点和需要复核的原因。
- `summary.csv`：每组 A-B 的每条候选路线及 OSM 查询状态。
- `review.csv`：最多 10 条优先复核路线，并预留独立核验字段。
- `report.json`：完整坐标和匹配结果，供进一步分析。

信号灯在路线 20 米内算作“OSM 匹配”，20–45 米算作“邻近待查”。35 米内的多个节点暂合并为一个可能的路口。匹配并不证明骑行方向受该灯约束，也不证明 OSM 没有漏标。查询失败时数字留空，不能解释成 0；完整性需要用独立资料或实地骑行核验 `review.csv` 中的少量样本。
