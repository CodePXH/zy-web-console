# Zylos 控制台定制插件

这是一个面向 Zylos 的本地插件市场仓库，用于保存并复用 Web Console 与项目工作区的自定义能力。它的目标是让自研功能不再散落在 Zylos Core 管理的运行目录中，并能在 Core 升级后以安全、可验证的方式恢复。

## 包含的能力

- 项目级工作目录，以及每个项目独立的 Codex runner 会话；
- 项目、会话、附件和消息路由的用户级隔离；
- 控制台顶部的当前模型与推理强度显示；
- 附件预览失败时的文件链接降级显示；
- 切换会话后仍能恢复“正在思考”状态；
- 按“登录用户 + 项目 + 会话”保存未发送的输入框草稿；
- 普通用户可查看自己的项目、会话、消息、附件使用汇总和近期活动；
- 管理员可查看所有用户的使用汇总、最后活动时间和近期审计事件；
- 管理员可打开运行驾驶舱，查看 14 天请求/估算 Token 趋势、用户 Token 排行、项目会话总量和既有监控指标；
- 所有登录用户可从左侧 Skills & guide 查看当前安装的可用技能、功能说明和示例提示词；
- Web Console 和 C4 Dispatcher 的升级兼容检查。

## 工作原理

插件保存每个自定义文件的两份快照：

- `baseline/`：制作该定制时对应的 Zylos Core 原始文件；
- `overrides/`：包含本地定制后的文件。

升级 Zylos Core 后，`apply-overrides.mjs` 会将“升级后的当前文件、基线文件和定制文件”进行三方合并。它会先完成所有文件的预演；只要其中一个文件有冲突，就不会写入任何运行文件。因此不会通过复制旧版本的方式覆盖新版 Core。

## 在其他机器安装

前提条件：已安装 Git、Node.js、Codex CLI、Zylos，且 Zylos 已安装并启动 `web-console` 和 `comm-bridge` 服务。

```bash
git clone git@github.com:CodePXH/zy-web-console.git
cd zy-web-console

# 将当前仓库注册为本地 Codex 插件市场，并安装插件
codex plugin marketplace add "$PWD"
codex plugin add zylos-project-workspaces@zy-web-console

# 先做只读检查；确认后再应用定制
node plugins/zylos-project-workspaces/scripts/apply-overrides.mjs --check
node plugins/zylos-project-workspaces/scripts/apply-overrides.mjs --apply

# 重载受影响服务
pm2 reload web-console c4-dispatcher
```

默认会操作 `~/zylos`。如果 Zylos 安装在其他位置，请通过 `ZYLOS_DIR` 指定：

```bash
ZYLOS_DIR=/path/to/zylos \
  node plugins/zylos-project-workspaces/scripts/apply-overrides.mjs --check
```

## Zylos Core 升级后

升级完成后依次执行：

```bash
cd zy-web-console
node plugins/zylos-project-workspaces/scripts/apply-overrides.mjs --check
node plugins/zylos-project-workspaces/scripts/apply-overrides.mjs --apply
pm2 reload web-console c4-dispatcher
node plugins/zylos-project-workspaces/scripts/verify-project-workspaces.mjs
```

说明：

- `--check` 不会修改任何文件；
- `--apply` 会在插件目录下生成仅包含受影响文件的时间戳备份；
- 若发生合并冲突，脚本会终止且不修改运行文件。此时应根据新 Core 的变化更新插件兼容层，而不是强行覆盖；
- 验证脚本会检查项目归属、会话归属、项目工作目录、附件范围与 C4 路由边界。

## 仓库结构

```text
.
├── marketplace.json                         # Codex 本地插件市场清单
├── README.md                                # English documentation
└── plugins/
    └── zylos-project-workspaces/
        ├── .codex-plugin/plugin.json        # 插件清单
        ├── baseline/                         # Zylos Core 基线文件
        ├── overrides/                        # 本地定制文件
        ├── scripts/                          # 合并和验证脚本
        ├── skills/                           # Codex 维护说明
        └── compatibility/                    # 兼容层说明
```

## 安全边界

本仓库不包含运行时数据库、上传文件、会话 Cookie、环境变量、SSH 私钥或 API 密钥。使用审计仅记录操作类型、时间、资源 ID、附件大小/类型和消息/附件数量，不记录消息正文、附件文件名、密码或凭据。驾驶舱 Token 值会在服务端基于已路由消息文本聚合为估算值，页面不会返回消息正文，也不能作为模型供应商账单。普通用户接口在服务端按当前身份隔离；汇总审计和驾驶舱接口在服务端强制要求管理员角色。插件会修改 Zylos 的运行源文件，因此建议先运行 `--check`，并在生产环境升级前保留常规备份。
