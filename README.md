# TokenSyber Plugin

Claude Code 插件 — 把 AI 对话产生的 token 实时注入 [TokenSyber](https://github.com/yyb1988/tokensyber) 游戏，驱动 3D 模型打印。

## 安装

在终端运行：

```bash
claude plugins marketplace add yyb1988/tokensyber-plugin
claude plugins install tokensyber@tokensyber-marketplace
```

然后在 `~/.claude/settings.json` 中启用：

```json
{
  "enabledPlugins": {
    "tokensyber@tokensyber-marketplace": true
  }
}
```

重启 Claude Code，状态栏出现 `🔥 TokenSyber: N tokens` 即表示插件正常工作。

## 工作原理

- **SessionStart hook**：启动本地 WebSocket 服务器（端口 3001-3010）
- **Stop hook**：每轮对话结束后解析 transcript，把新增的 token 数推送给游戏页面
- **SessionEnd hook**：停止服务器
- **Statusline**：显示已注入 token 总数 / 连接状态

游戏页面打开后会自动连接到 `ws://127.0.0.1:3001`。

## 文件结构

```
.claude-plugin/
  plugin.json        插件元数据
  marketplace.json   本地市场定义
hooks/
  hooks.json         Hook 配置
  run-hook.cmd       跨平台启动器（Windows cmd + Unix bash 双语脚本）
  session-start      启动 WebSocket 服务器
  stop               解析 transcript → 注入 token
  session-end        停止服务器
server/
  server.cjs         WebSocket + HTTP 服务器（无依赖，手写 RFC 6455）
statusline/
  statusline.js      状态栏脚本
  statusline / .cmd  Unix / Windows 启动器
```

## License

MIT
