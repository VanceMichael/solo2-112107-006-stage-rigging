# 巡演吊挂资料的工况采集与装台放行交接

巡演舞美组从场馆获取工况、已检查设备和签字回执，另维护各场的装台申报。 这些上游资料可通过本地合成接口查阅。场馆数据使用整数千克。inspectionPages 描述来源本版证书分页。资料用于装台送签。

## 运行来源服务

使用 Node.js 22。运行 `npm ci --offline --ignore-scripts --no-audit` 校验锁文件，`npm run source` 启动服务。默认监听 `127.0.0.1:4173`，可用 `SOURCE_PORT` 更换端口。运行 `npm test` 检查来源发布内容、传输格式和本地门户交互。服务重启会清空临时门户请求。

## 来源协议

GET `/v1/{release}/{resource}` 读取资源。阶段名为 `opening`、`interim`、`confirmed`，分别是开始时、中间观察和后续发布。阶段名只用于选择模拟接口，使用资料中标注的编号与有效时间判断其业务含义。返回的 `X-Release` 指观察阶段。索引声明的页暂未发布时返回 404，服务暂不可用时返回 503。各发布方的业务编号及生效信息见资源正文。

吊点表中同 beam 可对应多个 point，zone 与工况决定适用限额。同一 group 表示同工况同时吊挂，合计全部申报重量。证书有效期左闭右开，旧证只有 inheritance 明确写入适用工况才可供新梁引用。场馆签字仅覆盖声明的区域、工况及实际送签资料。场馆可独立确认一个区，签字不能用作结构计算。portal 支持 send、replace、inspect。

这些接口固定提供以下资源。分页资源名以各业务索引为准。

`calls`, `floor-index`, `zones`, `points`, `inspection-a`, `inspection-b`, `set`, `signatures`, `inheritance`

POST `/v1/{release}/portal` 接受 JSON 对象，`action` 取操作名，`key` 是来件唯一请求号，`facts` 可携带操作的业务事实。首次接收通常返回 201，发出完全相同的报文按原请求返回 200，已有请求号换报文返回 409。用 `inspect` 和原 `key` 查询，可见回执时返回 200。无法查到记录返回 404。正常接收的回执含 `sourceRef`，业务状态字段随来源使用 `decision`。合成门户保留请求并提供回执查询。

`wire/` 保存发布方的原始载荷，`wire.json` 记录各阶段可访问的路由，便于人工对照接口。
