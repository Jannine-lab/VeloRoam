# VeloRoam：Prompt、工具调用与输出评测

## 运行流程

现有 LangGraph 继续编排意图理解、条件检索和响应。意图节点使用 DeepSeek 原生 Function Calling：模型返回 `tool_calls`，后端验证参数并执行服务，将同一调用 ID 的 `ToolMessage` 返回模型，模型再输出结构化意图。对具名查询或候选选择，如果模型先输出 JSON 而跳过核实，下一轮要求调用工具。

工具均为只读。模型在需求确认前可使用检索工具；用户确认路线需求后，独立的规划阶段才会暴露规划和沿途探索工具：

| 工具 | 作用 | 约束 |
| --- | --- | --- |
| `search_candidates` | 按名称查询公开路段和活跃点位 | Zod 参数校验，最多返回 8 条摘要，不向模型发送轨迹点列 |
| `resolve_place` | 解析地点位置 | 唯一匹配或未确定；中心点不代表行政区边界 |
| `get_candidate_detail` | 核实已展示候选 | 仅接受会话或本轮已检索的 ID，按 ID 重新读取公开记录；不替换失效记录 |
| `search_nearby_candidates` | 按位置探索附近路段和点位 | 半径 1–50 公里，中心为用户提供的位置、地图中心或已核实候选；最多 8 条摘要。标明定位来源，客户端推荐沿用工具的实际范围 |
| `plan_cycling_route` | 按已确认的需求生成骑行路线 | 仅确认后开放；参数为空，由服务端使用已确认的起终点、预算和途经顺序，模型只接收距离、时间和停靠点摘要 |
| `find_enroute_segments` | 在本次已规划路线中探索顺路路段 | 仅确认后开放；必须先规划，在原路线和原预算上执行有限探索和验证，只向模型返回新增路段与距离摘要 |

每个 Agent 阶段最多 3 轮模型请求、4 次可执行工具请求，最后一轮禁用工具；额外请求返回预算错误。检索工具默认 8 秒超时，规划及沿途探索工具默认 45 秒，Agent 阶段总时限 60 秒。超时不会自动取消底层地图请求。规划结果在请求内复用，若模型漏调或工具调用出错，控制器使用同一个规划结果回退，不重复启动；沿途探索未被模型调用时仍执行原有的有界自动探索，失败保留基础路线。因此 HTTP 总响应时间可能超过 Agent 阶段时限。重复工具参数在当前请求内复用结果，仍占用调用预算。模型请求禁用自动重试。错误结果与零条结果使用不同状态。

原有路线生成服务继续负责坐标、预算、途经顺序与轨迹连接检查。模型不能修改已确认的路线条件，也不接收完整路线轨迹。现有用户端继续展示实际进度；响应 `meta` 提供版本、调用次数、Token 用量、时延和不包含参数的工具状态，供调试与评测使用。

## Prompt 与输出契约

`VeloRoam-api/src/prompts/ideaPrompts.ts` 集中管理意图理解、环线候选、点位选择、路段选择、推荐解释和关联词等 Prompt，以及工具策略。版本记录在 `IDEA_PROMPT_VERSION`；改变行为时更新版本并重新评测。

意图示例覆盖可选预算、显式上下限、时间单位、否定偏好、多轮修改、新会话与候选序号。Zod 校验模型输出的字段类型、范围与枚举；选择型输出额外核对候选 ID 白名单与重复项。JSON 模式不等于业务验证；本实现使用服务端 Zod 验证，没有启用 DeepSeek Beta strict 模式。

预算与骑行体验可选，未提供时继续现有规划；顺序或身份不明确时仍可澄清。资料不足时保持未知。候选名称、用户输入和工具结果均作为数据处理。

## 回归检查

使用 Node.js 22：

```sh
cd VeloRoam-api
npm run typecheck
npm test
npm run test:ui
```

测试覆盖协议消息回传、候选重新核实、未知工具、无效参数、伪造 ID、重复调用、工具失败、超时、调用预算、输出 Schema、候选白名单，以及控制器集成和评测器判分。单元测试使用替身验证可确定行为，不作为模型效果评测结果。

工具选择冒烟评测使用真实模型与合成候选、固定规划器，不连接真实地图或数据库；每种场景可重复 1–5 次：

```sh
npm run eval:agent-tools -- --repeat=3 --output=/private/tmp/agent-tools-smoke.json
```

该命令需要 `DEEPSEEK_API_KEY` 并消耗模型调用额度。少量重复只能验证工具选择和协议是否能跑通，不能说明生产路线质量或稳定性。

## 真实模型评测

```sh
cd VeloRoam-api
# 需要项目现有 DEEPSEEK_API_KEY；会调用真实模型并消耗额度。
npm run eval:idea -- --concurrency=2
# 仅运行开发集；用于 Prompt 迭代。
npm run eval:idea -- --split=development --repeat=3
# 复测指定场景；输出目录必须不存在。
npm run eval:idea -- --ids=distance-20,lookup-segment --output=reports/idea-eval/manual-check
```

数据集 `idea-business-v1` 包含 60 个手工定义业务场景、73 轮请求，40 个场景标为开发集、20 个标为留出集。后续迭代以开发集调试，完整报告分别列出两个分组的结果；少量冒烟检查不充当独立留出集实验。

评测直接调用生产控制器、真实 DeepSeek 与原生工具协议，检索服务返回固定合成记录，路线规划使用固定替身。由此隔离网络地图与数据库变化，测量结构化输出、约束继承、候选身份和工具选择。该模式不证明真实路线质量、地图服务可用性、一般知识回答的语义准确率或线上用户成功率。

每个场景按全部轮次的全部断言通过才计为通过。字段断言、工具选择、候选身份与响应有效性独立记录；HTTP 错误或空回答不能通过。保留失败用例，记录调用次数、Token、单轮延迟 P50/P95、样本数、并发度、重复次数、Prompt/模型版本及数据集/实现哈希。单轮请求延迟包含本轮完整 Agent 流程，不只是模型首 Token 时延。

每次运行创建独立目录，逐场景写入 `results.json`，完成后生成 `summary.json`。网络失败与语义错误均会出现在原始记录中，不能将连接失败时的快速返回当作成功响应性能。

## 官方协议依据

- [DeepSeek 工具调用](https://api-docs.deepseek.com/guides/tool_calls/)
- [DeepSeek Chat Completions：tool_choice](https://api-docs.deepseek.com/api/create-chat-completion/)
- [LangGraph 工作流与 Agent](https://docs.langchain.com/oss/javascript/langgraph/workflows-agents)

本机的真实评测结果及简历采用的数值另见对应运行目录和核验报告。
