# 百灵中枢 WorkBuddy 连接器

[English](README.md)

让用户在 WorkBuddy 中用自然语言查询商城订单、整理商品信息，并执行已获授权的商品操作。百灵中枢（BailingHub）连接业务能力，最终权限与业务规则仍由业务系统决定。

**0.1.2 是审核候选版本，尚未在 WorkBuddy 连接器市场上架。** 中文显示名称为「百灵中枢」，英文显示名称为「BailingHub Business Operations」；npm 包名和集成标识保持不变。

## 能解决什么问题

如果商城已声明相应工具，并且当前账号有权限，可以这样提出请求：

- 「查看最近 7 天的订单，按状态整理结果。」
- 「找出库存低于 10 件的商品，列出来供我检查。」
- 「把这个测试商品的展示排序改为我提供的数值；如果需要审批，告诉我当前进度。」
- 「审批已经完成，帮我查询刚才那次商品修改的结果。」

这些是请求示例，不是连接器自带工具或演示数据。可用操作以业务系统声明、当前账号权限和返回的能力目录为准。安装连接器不会自动接入商城、CRM、ERP 或多个业务系统。

## 首次连接

1. 按 WorkBuddy 审核流程安装候选包；市场入口需要等待审核上架。
2. 点击「连接」，本机浏览器打开配置页。
3. 填写开发者提供的公开 `hubUrl`、`clientAppId`、`workspace`，并设置本地连接名称 `connectionName`。
4. 浏览器跳到业务系统自己的授权页。在该页登录，选择允许使用的账号或门店，并确认授权。
5. 回到 WorkBuddy 提出业务请求。WorkBuddy 本地 Agent 负责理解与编排；百灵中枢提供当前身份可用的能力，并在每次执行时检查身份、权限、策略、审批、幂等、限制和审计。

首次连接仍需要开发者准备公开参数，连接器不会自动发现业务环境。缺少这些参数时，可以检查安装与连接表单，不能完成真实业务验证。

不要把 Client Token、管理员 Token、Tool Provider Secret、业务 Cookie、模型 Key 或 Agent Session Token 分发给用户，或粘贴到聊天与公开连接表单中。用户只填四项非敏感连接信息；业务登录凭据只在业务系统自己的授权页输入。

## 开发者需要准备什么

- 启用 Agent Auth v1 和 Agent Client Runtime v1 的百灵中枢部署。
- 已注册的公开 `clientAppId` 及其允许访问的 `workspace`。
- 业务系统自己的授权页，从服务端登录会话派生 `principal` 和 `on_behalf_of`，不接受 Agent 自报身份。
- 由业务系统声明并接入的查询工具，以及需要验收的低风险商品操作；审批场景还需要可用的审批规则与审批人。
- 用于验收的业务测试账号和测试数据。公开仓库与候选包不附带私有环境地址、账号或凭据。

## 0.1.2 重审候选的变化

- 中文名称统一为「百灵中枢」，说明与示例优先围绕商城订单、商品操作和审批恢复。
- SDK 从 `bailinghub-mcp-server@0.3.0` 升级并精确锁定到正式版 `0.5.0`。
- CLI 与 MCP 显式声明 Node `>=20.15.0`，兼容 WorkBuddy 托管 Node 22。安装前输出 Node/npm 版本，Windows 使用 `npm install` 形式，便于识别环境问题。该调整不会补齐宿主缺失的托管运行时或修复其 PATH；Windows WorkBuddy 实机安装仍待验证，不能据此断言此前所有安装错误的根因，也不代表已通过平台审核。

重审前提、安装检查与业务验收步骤见 [中文重审说明](docs/REVIEW_GUIDE.zh-CN.md)。

## 每轮执行与恢复边界

连接器使用 `MCP + Skill + preAuth CLI`。CLI 负责连接配置、浏览器 PKCE 授权、状态检查和撤销；MCP 只向模型暴露 `start / search / invoke / resume / complete` 五个固定工具。

每次用户可见轮次只创建一个 `run_id`，本轮的能力搜索与新调用使用该 run。当前适配器把每个可见用户轮次映射为独立的百灵中枢会话，不承诺自动归档或连续聚合整个 WorkBuddy 聊天。

同一 run 内，相同工具和标准化参数派生相同的 `invocation_id`，传输响应丢失后的原样重试会保留调用标识。用户有意重复相同操作，需要在新的可见轮次提出请求并获取新 run。如果调用正在审批、执行中或结果未知，应先报告状态并结束当前可见轮次；后续用户要求继续时，通过原 `invocation_id` 恢复，保留它与原 run、原连接的绑定，不在新轮次补发替代写入。结束可见轮次不等于业务操作已成功。

本机恢复记录仅保存路由标识、workspace、能力版本、当前工具 Schema、待恢复调用标识、状态与时间，不保存凭据、用户消息、工具参数或业务返回正文。用户可见输入、能力调用与最终答复会发送到所选百灵中枢部署，详见 [PRIVACY.md](PRIVACY.md)。

## 连接管理

连接的新增、选择和删除由用户通过 CLI/设置完成，不是模型工具。

```bash
bailinghub-workbuddy connections list
bailinghub-workbuddy connections add
bailinghub-workbuddy connections use <connection-name>
bailinghub-workbuddy connections remove <connection-name>
```

选择连接只影响后续新 run。已开始的 run 和待恢复调用继续绑定原连接与业务身份。`logout` 只撤销当前连接的 Agent Session；`connections remove` 撤销并删除指定本地连接。本机存储命名空间固定为 `bailinghub-workbuddy`。

## 本地开发

```bash
npm install
npm test
npm run verify
```

`npm run connector:build` 生成可复现的 `artifacts/bailinghub-workbuddy-connector-0.1.2.zip`。ZIP 只包含 WorkBuddy 元数据、MCP/CLI 配置、Skill 和图标，引用精确版本的 npm 运行时包。在该 npm 版本公开可解析之前，不应上传 ZIP 进入市场审核。

凭据使用 macOS Keychain、Windows 当前用户 DPAPI，或经 Linux 用户一次性明确确认后启用的仅当前用户可读 mode-0600 文件。详见 [SECURITY.md](SECURITY.md)。

本项目是独立的生态适配器。责任边界见 [PROJECT_BOUNDARIES.md](PROJECT_BOUNDARIES.md)，贡献方式见 [CONTRIBUTING.md](CONTRIBUTING.md)。
