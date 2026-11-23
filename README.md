# 巡演吊挂资料的工况采集与装台放行交接

巡演舞美组从场馆获取工况、已检查设备和签字回执，另维护各场的装台申报。 这些上游资料可通过本地合成接口查阅。场馆数据使用整数千克。inspectionPages 描述来源本版证书分页。资料用于装台送签。

## 运行来源服务

使用 Node.js 22。运行 `npm ci --offline --ignore-scripts --no-audit` 校验锁文件，`npm run source` 启动服务。默认监听 `127.0.0.1:4173`，可用 `SOURCE_PORT` 更换端口。运行 `npm test` 检查来源发布内容、传输格式和本地门户交互。服务重启会清空临时门户请求。

## 来源协议

GET `/v1/{release}/{resource}` 读取资源。阶段名为 `opening`、`interim`、`confirmed`，分别是开始时、中间观察和后续发布。阶段名只用于选择模拟接口，使用资料中标注的编号与有效时间判断其业务含义。返回的 `X-Release` 指观察阶段。索引声明的页暂未发布时返回 404，服务暂不可用时返回 503。各发布方的业务编号及生效信息见资源正文。

吊点表中同 beam 可对应多个 point，zone 与工况决定适用限额。同一 group 表示同工况同时吊挂，合计全部申报重量。证书有效期左闭右开，旧证只有 inheritance 明确写入适用工况才可供新梁引用。场馆签字仅覆盖声明的区域、工况及实际送签资料。场馆可独立确认一个区，签字不能用作结构计算。portal 支持 send、replace、inspect。
mounted 记录上一工况实际挂载，until 是计划撤场时间，cleared=confirmed 才表示场馆确认实际卸下。conditionalClearingZones 的交接条件要求上场物件腾空，本场独立资料仍可送审。其他共用区仍需考虑现场留存的适用重量。

这些接口固定提供以下资源。分页资源名以各业务索引为准。

`calls`, `floor-index`, `zones`, `points`, `inspection-a`, `inspection-b`, `set`, `signatures`, `inheritance`, `mounted`

POST `/v1/{release}/portal` 接受 JSON 对象，`action` 取操作名，`key` 是来件唯一请求号，`facts` 可携带操作的业务事实。首次接收通常返回 201，发出完全相同的报文按原请求返回 200，已有请求号换报文返回 409。用 `inspect` 和原 `key` 查询，可见回执时返回 200。无法查到记录返回 404。正常接收的回执含 `sourceRef`，业务状态字段随来源使用 `decision`。合成门户保留请求并提供回执查询。

`wire/` 保存发布方的原始载荷，`wire.json` 记录各阶段可访问的路由，便于人工对照接口。

## 装台送签应用

应用（`server.mjs`）在来源协议之上提供装台经理与舞监使用的查询、送签和交接界面，默认 `http://127.0.0.1:3000`。

```bash
npm ci --offline --ignore-scripts --no-audit
npm run source          # 终端 1：合成来源，127.0.0.1:4173
SOURCE_URL=http://127.0.0.1:4173 npm start   # 终端 2：应用
npm test                # 来源协议 + 业务规则
```

不设 `SOURCE_URL` 时，M1 直接读 `wire/` 快照、门户也由本地按同一请求语法应答，便于离线核对。
另有当地场馆 M2（`data/m2/`）用于验证"下一站按当地发布重办"：两站的吊点、限额、证书与签字互不通用。

运行期只写 `var/store.json`（可用 `STORE_FILE` 覆盖），保存签字首次覆盖范围的观测、送签报文与回执、装台包。场馆资料本身不改写。

### 业务边界

- **只采录来源额定值**：吊点—承重区关系、分区并用限额、检测额定值、编组与场馆明示沿用。不补算结构、不按梁号推测、不并入来源未写明的编组。
- **换梁关联**：旧检测只有 `inheritance` 明示 `old_beam → new_beam`，且该行与证书都覆盖本工况、证书在本次场次日期有效时才可引用。被拒原因会随"所缺材料"一起显示。
- **分区分开处理**：一页检测缺失只让引用该梁的分区变为"资料不全"，其它分区仍可交签。
- **签字覆盖范围**：场馆签字只覆盖其声明的分区、工况、资料版次与检测。局部换梁、增重、增加物件或切换彩排/演出后，旧签字失效；同区同编组物件须一并重新确认，不能只重签变化的那一件。
- **共用区**：同区其他清单的物件共用并用限额，旧清单的签字不能覆盖新清单。
- **现场留存**：`mounted.cleared !== confirmed` 的物件仍在现场。非清场条件区必须把它纳入新工况，否则阻断送签；`conditionalClearingZones` 内可继续送签，但交接挂起，直到场馆确认清空。
- **不悄悄消失**：已有送签或装台包的分区，即使换清单、换场次，也会以提醒形式保留，直到纳入新工况或由场馆确认撤场。
- **下一站**：场馆概览与交接视图列出上一站装台包，但本场分析只使用当地发布，不继承上一站签字。

### API

| 方法 | 路径 | 用途 |
| --- | --- | --- |
| GET | `/api/venues` | 场馆与阶段 |
| GET | `/api/venues/:id/overview` | 各版次清单、检测页采集结果、上一站装台包 |
| GET | `/api/venues/:id/analysis?phase=&proposal=&call=` | 单方案分析：分区、冲突、所缺材料、签字/待重签、接续提醒 |
| POST | `/api/venues/:id/packs` | 生成装台包（保留冲突，标记人工复核） |
| GET | `/api/venues/:id/packs/:pack` | 读取装台包与送签记录 |
| GET | `/api/venues/:id/packs/:pack/review` | 对照当前发布复核：完全适用 / 须重签 / 新增 / 已消失 |
| POST | `/api/venues/:id/submit` | 按装台包送签（可指定单区）；冲突区返回 409 及原因 |
| POST | `/api/venues/:id/inspect` | 用原请求号查询门户回执 |

`lib/engine.mjs` 是纯分析函数（`analyze`、`resolveInspection`、`scopeFingerprint`），可单独测试；`lib/service.mjs` 负责采集、装台包、送签与复核；`lib/store.mjs` 只保存本机观测。
