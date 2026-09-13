---
name: nearby-you
description: AI agent 玩家版「附近的人」：上报自己的资料（位置、agent 总结的简介、在用的 agent/模型、自愿公开的联系方式）到云端，查询附近 50km 内还有谁在玩 Claude Code。当用户说「上报我的资料」「附近的人」「看看附近谁在玩」「查附近」「更新附近资料」「删除我的附近资料」时触发。
---

# 附近的你（nearby-you）

AI agent 圆子里的小社交：上报你的位置和资料，看看附近还有谁在玩 agent。所有资料存云端（腾讯云），随时可删。

## 前置依赖

- Python 3.8+（**Windows 上若 `python` 不在 PATH，用完整路径调用**，如 `C:\Users\<你>\AppData\Local\Programs\Python\Python3xx\python.exe`；macOS/Linux 直接 `python3`）
- Windows 上调用 PowerShell 脚本前先执行 `[Console]::OutputEncoding = [System.Text.Encoding]::UTF8`，防止中文乱码
- 无需任何第三方 Python 库（PyYAML 可选）
- 平台说明：GPS 一级定位目前仅 Windows（get_location.ps1）；macOS/Linux 自动落到二级 IP 定位或手填城市

## 脚本位置

| 文件 | 作用 |
|---|---|
| `~/.claude/skills/nearby-you/scripts/nearby.py` | API 客户端（所有子命令） |
| `~/.claude/skills/nearby-you/scripts/get_location.ps1` | Windows 本机 GPS 定位 |
| `~/.nearby-you/identity.json` | 本地身份（id+secret），**勿删** |

下文用 `$PY` 代指 Python 命令、`$SKILL` 代指 `~/.claude/skills/nearby-you`（Windows 下即 `C:\Users\<你>\.claude\skills\nearby-you`）。

## 通用约定（所有流程生效）

1. **输出契约**：脚本进度走 `[INFO]/[OK]/[WARN]/[ERROR]` 行；**结果永远在最后一行 `RESULT_JSON: {...}`**，只解析该行，忽略其他行。
2. **隐私红线**：任何字段上传前必须先给用户过目确认；联系方式填写时必须明确警示「将公开展示给所有查询附近的用户」。
3. 服务不可达时按脚本 `[ERROR]` 提示排查（防火墙 3210 / pm2 状态），不要瞎重试。
4. 展示时间字段（`updated_at` 是 UTC ISO8601）时转成北京时间，并补一句「x 天前」。

---

## 流程 A：首次上报资料

触发：用户说「上报我的资料」，且 `~/.nearby-you/identity.json` **不存在**。若存在则走流程 C。

### 第 1 步：检查服务（自动）

```
& $PY "$SKILL\scripts\nearby.py" health
```
失败则把 `[ERROR]` 内容原样转告用户，终止。

### 第 2 步：定位（三级降级链，结果必须经用户确认）

**一级 GPS**（仅 Windows；自动，约需几秒到 15 秒）：
```
& "C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe" -NoProfile -ExecutionPolicy Bypass -File "$SKILL\scripts\get_location.ps1"
```
（非 Windows 跳过本级，直接进二级 IP 定位）
成功（`ok:true`）→ 拿着 lat/lon 调 `& $PY "$SKILL\scripts\nearby.py" geocode --lat <lat> --lon <lon>` 拿中文地址 → **AskUserQuestion**：
> 定位到「{地址}」（GPS 定位，精度约 ±{accuracy} 米），用这个位置吗？
> 选项：用这个位置 / 我手动填城市

**二级 IP**（GPS 失败时自动降级，输出 `[WARN]` 告知用户降级原因）：
```
& $PY "$SKILL\scripts\nearby.py" ip-loc
```
成功 → **AskUserQuestion**：「IP 粗定位到「{城市}」（城市级精度，可能有偏差），用这个吗？」选项：用 / 手动填城市

**三级手填**：AskUserQuestion 让用户输入城市名 → `& $PY "$SKILL\scripts\nearby.py" geocode --city <城市>` 解析坐标。解析失败则把错误转告用户重填。

### 第 3 步：生成简介（必须用户确认）

按顺序尝试数据源了解用户（**不写死单一来源，不同 agent 环境不同**）：全局 CLAUDE.md（`~/.claude/CLAUDE.md`）→ 当前项目 CLAUDE.md → memory 目录 → 当前对话上下文。综合后生成 1~2 句身份简介（技术博主 / 独立开发者 / 学生等）。**只总结已知事实，宁可写少不可编造**；对用户一无所知就直说并让用户口述。

**AskUserQuestion**：展示简介草稿 → 选项：就用这个 / 我自己改（自由输入）。

### 第 4 步：agent/模型信息（自动采集 + 询问补充）

自动组装一行，如 `Claude Code v2.x（GLM-4.7 模型）/ Windows 11`：
- 版本：`claude --version`（拿不到就跳过）
- 模型：你（Claude）自己知道当前用什么模型，直接写
- 系统：`Windows 11`

**AskUserQuestion**：展示组装结果 → 问是否补充其他在用的工具（Cursor / Codex / 自建 agent 等，可跳过）。

### 第 5 步：联系方式（强隐私警示）

**AskUserQuestion**，问题文案必须包含：
> ⚠ 你填写的内容（如微信、邮箱）将**公开展示给所有查询附近的人**，任何人都能看到。不要填密码、住址等敏感信息。可以留空。

用户自主选择填什么（agent 的邮箱 / 个人微信 / 个人邮箱都行，也可空）。

### 第 6 步：昵称 + 最终确认

**AskUserQuestion** 问昵称（必填）。然后用一张表汇总全部字段（昵称/简介/agent信息/位置/联系方式），**AskUserQuestion 最终确认**后才上传。

**上传方式（必须用文件，不要用管道传中文——PS 5.1 管道默认 ASCII，中文会变问号）**：先用 Write 工具把 JSON 写到 `%TEMP%\nearby_create.json`（UTF-8）：

```json
{ "nickname": "...", "bio": "...", "agent_info": "...", "contact": "...",
  "location": { "lat": 23.17, "lon": 114.30, "address": "...", "city": "...", "source": "gps" } }
```

再执行：
```
& $PY "$SKILL\scripts\nearby.py" create --file "$env:TEMP\nearby_create.json"
```
（location.source 用 gps / ip / manual 之一；address/city 传定位链路里已确认的值。）

### 第 7 步：收尾（自动）

成功后明确告知：身份已保存到 `~/.nearby-you/identity.json`，**别删这个文件**，secret 丢了要找服务器管理员才能删资料。409 IP_TAKEN 时把报错解释给用户（同宽带多设备的已知限制）。

---

## 流程 B：查询附近的人

触发：「附近的人」「看看附近谁在玩」「查附近」。

1. **位置**：本地有 identity.json 且带位置缓存 → AskUserQuestion「用上次上报的位置还是重新定位？」（重新定位则走流程 A 第 2 步的降级链）；没有缓存则走一遍定位链（确认从简）。
2. **查询**（不带 --lat/--lon 时自动用缓存位置）：
```
& $PY "$SKILL\scripts\nearby.py" nearby --radius 50
```
3. **展示**：markdown 表格——昵称 | 简介 | agent/模型 | 位置（地址 + 距离） | 联系方式 | 最近上报（北京时间 + x 天前）。`RESULT_JSON` 里 `distance_km` 是排好序的。
4. 结果不足 10 条 → 提示「要扩大半径再查一次吗？比如 200km」。0 条 → 告知附近暂无用户，可扩大半径或过几天再看。

## 流程 C：更新资料

触发：「更新附近资料」「改一下我的简介/位置/联系方式」。

1. `& $PY "$SKILL\scripts\nearby.py" whoami` 展示现有资料（secret 已打码）。
2. AskUserQuestion 问改哪项；位置变了就重走流程 A 第 2 步定位链。
3. 只传要改的字段，同样走文件（Write 到 `%TEMP%\nearby_update.json`）：
```
& $PY "$SKILL\scripts\nearby.py" update --file "$env:TEMP\nearby_update.json"
```
4. 成功后展示服务端返回的最新资料。

## 流程 D：删除我的资料

触发：「删除我的附近资料」「不玩了，删掉」。

1. AskUserQuestion 确认：「将永久删除你在云端的全部资料（不可恢复），确定？」
2. 确认后：`& $PY "$SKILL\scripts\nearby.py" delete --yes`
3. 成功后告知：云端资料已删、IP 名额已释放、本地身份文件已清除。想再玩重新走流程 A。

---

## 关键说明

- 服务器：`http://124.221.77.217:3210`（写死在 config.yaml，改服务器地址改那里）
- 一个公网 IP 只能创建一条资料（防灌水）；家庭/公司多设备共享 IP 是已知限制
- 修改/删除必须带 secret，它只存在本地 identity.json 里，**丢了就要服务器管理员救援**
- 上报的数据公开给所有用户（这是产品本身），所以才有那么多确认环节——别替用户省掉

## 触发示例

- 「上报我的资料」→ 流程 A
- 「看看附近谁在玩 Claude Code」→ 流程 B
- 「我搬家了，更新一下位置」「改下我的联系方式」→ 流程 C
- 「把我的附近资料删了」→ 流程 D
