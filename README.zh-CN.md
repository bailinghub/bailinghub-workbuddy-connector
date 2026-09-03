# BailingHub WorkBuddy Connector

[English](README.md)

让 WorkBuddy 中的本地 Agent 直接查询和操作已接入 BailingHub 的商城、SaaS、CRM、ERP 等业务后台。

这是一个独立的 WorkBuddy 生态适配器，不是 BailingHub Core、ACC、DeepSeek Harness 插件或任何特定业务系统的一部分。

## 用户会经历什么

1. 在 WorkBuddy 连接器市场安装「BailingHub 业务后台」。
2. 点击「连接」，本机浏览器打开连接配置页。
3. 填写开发者提供的四项公开信息：`hubUrl` + `clientAppId` + `workspace` + `connectionName`。
4. 浏览器跳到业务系统自己的授权页。用户在那里登录、切换账号或选择门店，并确认授权。
5. 授权成功后，WorkBuddy 本地 Agent 负责思考和编排；BailingHub 提供当前身份可用的业务能力，并在每次执行时重新检查身份、权限、ACC 约束、审批、幂等、限制和审计。

连接器不是业务数据提供方。如果开发者没有部署 BailingHub、注册 Client App、配置 Workspace，并让业务系统声明可用能力，连接器就没有可执行的业务。

## 开发者需要准备什么

- 一套启用 Agent Auth v1 和 Agent Client Runtime v1 的 BailingHub。
- 一个公开 `clientAppId`，以及它允许的 Workspace。
- 业务系统自己的授权页。该页从当前服务端登录会话派生 `principal` 和 `on_behalf_of`，不接收由 Agent 声明的身份。
- 已通过 ACC 或 BailingHub 能力声明接入的业务工具。

不要向用户分发 BailingHub Client Token、管理员 Token、Tool Provider Secret、业务 Cookie、模型 Key 或 Agent Session Token。用户连接时只填四项非敏感公开元数据。

## 运行时设计

WorkBuddy 包使用 `MCP + Skill + preAuth CLI`：

- CLI 只负责人机交互的连接配置、浏览器 PKCE 授权、状态检查和撤销。
- MCP 只向模型暴露 `start / search / invoke / resume / complete` 五个固定工具。
- 同一 `run_id` 内，相同工具和标准化参数始终派生同一 `invocation_id`；即使 stdio 响应丢失后 WorkBuddy 换了请求号重试，也不会变成第二次业务写入。如需有意重复完全相同的动作，应在新的用户轮次获取新 `run_id`。
- 连接的新增、选择和删除只能由用户通过 CLI/设置完成，不是模型工具。
- 运行映射只保存连接 ID、Workspace、能力版本、当前工具 Schema 和待恢复的调用 ID；不保存凭据、用户消息、工具参数或业务返回正文。
- WorkBuddy 当前没有向 stdio `tools/call` 提供可信宿主会话 ID，因此首版把每个可见用户轮次映射为独立的 BailingHub 会话，优先避免不同聊天串线；未来平台提供可信会话 ID 后再支持连续会话聚合。

运行时精确依赖 `bailinghub-mcp-server@0.3.0`，本机存储命名空间固定为 `bailinghub-workbuddy`。

## 多连接 CLI

```bash
bailinghub-workbuddy connections list
bailinghub-workbuddy connections add
bailinghub-workbuddy connections use <connection-name>
bailinghub-workbuddy connections remove <connection-name>
```

`connections use` 只影响之后新建的会话/任务。已开始的 run 继续绑定原连接，不会因切换而跨业务身份执行。`logout` 只撤销当前连接的 Agent Session；`connections remove` 则撤销并删除指定本地连接。

## 本地开发

```bash
npm install
npm test
npm run verify
```

`npm run connector:build` 生成可复现的 `artifacts/bailinghub-workbuddy-connector-0.1.1.zip`。ZIP 只包含 WorkBuddy 元数据、MCP/CLI 配置、Skill 和图标；它指向精确版本的 npm 运行时包。在该 npm 版本公开可解析之前，不应上传 ZIP 进入市场审核。

## 凭据存储

- macOS：Keychain。
- Windows：当前用户 DPAPI。
- Linux：默认关闭文件回退。用户必须在本地配置页一次性明确确认，才会启用仅当前用户可读的 mode-0600 凭据文件。

参见 [PRIVACY.md](PRIVACY.md) 和 [SECURITY.md](SECURITY.md)。

仓库与其他项目的责任边界见 [PROJECT_BOUNDARIES.md](PROJECT_BOUNDARIES.md)，贡献方式见 [CONTRIBUTING.md](CONTRIBUTING.md)。
