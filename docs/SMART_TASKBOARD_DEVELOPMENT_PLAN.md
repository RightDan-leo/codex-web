# Remote Codex 智能项目看板开发计划

## 1. 目标

在 Codex Web 内原生增加一个面向 Owner 的智能项目看板，用同一套持久化、认证、任务队列和 Remote Worker 通道管理多个项目及其子任务。

完成后，Owner 可以：

- 按逻辑项目组织主任务、子任务、依赖、优先级和验收标准；
- 让 Codex 提出任务拆分、工作量、风险和优先级建议；
- 在明确授权的范围内，自动领取依赖已满足的高优先级低风险任务；
- 从看板查看运行进度、阻塞原因、测试证据和对应 Codex 会话；
- 对完成工作执行人工验收，通过后归档，驳回后沿用原项目和线程继续修改。

## 2. 不可破坏的边界

1. Tenant 仍是普通会话的默认执行器，只有 Owner 明确选择后才能使用 Remote。
2. 看板和服务器只保存 Remote Worker 的逻辑 `projectId`，不保存、下发或展示远端真实路径和 `CODEX_HOME`。
3. 一张进入实际工作的任务卡必须固定执行器、项目、会话和 Codex Thread，不能跨文件系统续接。
4. `REMOTE_WORKER_TOKEN` 等控制凭证不得进入 Codex 环境、Shell、日志、任务事件或最终回复。
5. 自动调度不得自动重试可能产生副作用的任务，也不得自动执行部署、合并、删除数据或外部发送等高风险操作。
6. 最终验收只允许用户执行；Codex 完成工作后只能进入“待验收”。
7. 取消、断线、重连和关机后的晚到结果不得把任务改为已完成。
8. 看板操作沿用现有登录、用户隔离、Owner、CSRF、Origin、Cookie 和 `BASE_PATH` 规则。

## 3. 产品状态模型

第一版固定状态：

```text
backlog  待规划
ready    待开发
running  开发中
review   待验收
blocked  已阻塞
done     已完成
cancelled 已取消
```

允许的主要转换：

```text
backlog -> ready | cancelled
ready -> backlog | running | blocked | cancelled
running -> review | blocked | cancelled
review -> ready | done | cancelled
blocked -> ready | cancelled
done -> archived
```

所有转换必须写入不可变事件记录。自动化只能执行策略明确允许的转换，不能通过直接更新数据库绕过状态机。

## 4. 分阶段交付

### 阶段 A：可靠基础看板

交付内容：

- 项目、任务、父子关系、依赖、优先级、风险、验收标准；
- 看板列、拖动或显式状态操作、筛选、排序、归档；
- 乐观版本号，防止页面或 Agent 用旧数据覆盖新状态；
- 一张任务卡关联一个 Codex Web 会话，并保存逻辑执行器目标；
- 项目和任务事件历史；
- Owner 可见的 Worker 在线状态和任务执行状态。

验收标准：不依赖 AI 自动化，也能完整管理多个项目和人工验收流程。

### 阶段 B：Codex 规划助手

交付内容：

- Owner 输入项目目标、约束和偏好；
- Codex 生成待确认的子任务、依赖、验收标准、风险和工作量；
- 服务端校验数量、字段和依赖环，不接受模型直接写库；
- Owner 批量批准、编辑或拒绝规划结果；
- 优先级计算保存分数、构成和解释。

验收标准：Codex 只能提出建议，未经批准的任务不得进入自动执行池。

### 阶段 C：受控自动调度

交付内容：

- Owner 为每个项目选择 `manual`、`assist` 或 `auto_low_risk`；
- 调度器只选择 `ready`、依赖已完成、Worker 在线且风险允许的任务；
- 原子领取、运行租约、执行代次和幂等键，防止重复开工和旧结果串线；
- 项目级并发上限、工作时间、暂停开关和资源预算；
- 每次自动选择都保存可解释理由；
- 失败任务进入阻塞或等待人工处理，不盲目重试。

验收标准：在一次性测试项目中可以连续推进多个低风险任务，且断线、取消、重启不会重复执行。

### 阶段 D：验收与通知闭环

交付内容：

- Codex 完成任务后自动进入 `review`；
- 展示修改摘要、测试结果、运行事件和远端交付限制；
- Owner 接受后进入 `done`，驳回后带反馈回到 `ready`；
- 页面内提醒、未读状态和可选外部通知适配层；
- 完成任务可归档，历史和审计记录继续保留。

验收标准：任何任务都不能在没有 Owner 验收记录的情况下进入 `done`。

## 5. 数据模型

建议新增正式迁移表：

- `taskboard_projects`：用户、名称、描述、逻辑 Remote `project_id`、自动化模式、并发上限、偏好、归档时间和版本；
- `taskboard_tasks`：项目、父任务、标题、正文、状态、优先级、风险、工作量、验收标准、会话、执行器快照、版本和归档时间；
- `taskboard_task_dependencies`：任务依赖关系，写入时检查同项目和环；
- `taskboard_task_runs`：任务执行代次、Job、状态、领取租约、开始/结束时间和错误摘要；
- `taskboard_events`：项目或任务的状态变化、人工操作、自动化理由和审计数据。

服务端真实路径不进入任何看板表。

## 6. 优先级策略

Codex 负责估算和解释，服务器负责根据结构化字段计算：

```text
分数 = 用户优先级 + 截止紧迫度 + 业务价值 + 依赖解锁收益 + 等待补偿
     - 风险惩罚 - 预计成本
```

Owner 置顶、暂停和手工排序始终优先。每次自动调度保存完整分数组成，便于解释和复盘。

## 7. API 与界面

第一阶段 API：

- `GET/POST /api/taskboard/projects`
- `GET/PATCH/DELETE /api/taskboard/projects/:id`
- `GET/POST /api/taskboard/projects/:id/tasks`
- `GET/PATCH /api/taskboard/tasks/:id`
- `POST /api/taskboard/tasks/:id/transition`
- `PUT /api/taskboard/tasks/:id/dependencies`
- `GET /api/taskboard/tasks/:id/events`

所有写请求必须包含 CSRF Token 和乐观版本号。

界面原生集成到 Codex Web，使用主应用的 React Root、主题和响应式布局，不使用 CDP 注入或第二套认证。移动端优先提供按列切换，桌面端提供横向看板。

## 8. 测试计划

- 数据库迁移、级联删除、用户隔离和归档；
- 状态转换、Owner 验收门禁、非法转换和并发版本冲突；
- 依赖环、跨项目依赖和未完成依赖阻止开工；
- 非 Owner、未登录、错误 CSRF、错误 Origin 和 `BASE_PATH`；
- Remote 离线失败关闭、Tenant 默认路径和执行位置锁定；
- 原子领取、并发上限、重复调度、取消、断线、重连、关机和晚到结果；
- 前端排序、筛选、移动端、错误状态和会话切换；
- 一次性 Git 项目的 mock Worker 全流程；
- 最终执行 `npm run lint`、`npm run build` 和完整 `npm test`。

## 9. 第一版范围外

- 通用远程命令、远程桌面和任意文件浏览；
- 自动合并 PR 或自动部署；
- 浏览器附件到 Worker 的新同步协议；
- Remote 交付文件自动回传；
- WSS 重写、多 Worker 调度和 Token 自动轮换；
- 完全无人监督的高风险任务执行。

## 10. 提交计划

按功能形成少量语义提交：

1. `docs(taskboard): add controlled automation development plan`
2. `feat(taskboard): add persistent project and task model`
3. `feat(taskboard): add owner taskboard API and state machine`
4. `feat(taskboard): add native project board UI`
5. `test(taskboard): cover transitions dependencies and access control`

每个提交前运行受影响测试，最终提交前运行完整 `npm test`。不重写 Remote Worker 现有历史，不修改 `main`，不 force push。
