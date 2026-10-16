# 参与开发

建议在 Windows 上开发。核心事项服务仅依赖 Node.js 22+ 的内置模块，不需要前端编译或 Node 运行依赖安装。完整微信 / QQ 接入还需要 Windows 客户端和可选组件，见 [安装与平台接入](docs/platform-setup.md)。

## 本地验证

```powershell
node --test test/*.test.mjs
node tools/release-check.mjs
```

Node 测试使用临时目录、合成消息及模拟平台；不需要真实账号，也不会操作正在运行的微信或 QQ。Windows 微信数据库的合成加密 / WAL 回归：

```powershell
.\.venv-wechat\Scripts\python.exe tools/check-wechat-database.py
.\.venv-wechat\Scripts\python.exe tools/check-wechat-detection.py
```

界面检查需要额外安装 Playwright 和可用的 Edge。可在仓库外单独安装 Playwright，再用 `PLAYWRIGHT_MODULE` 指定其模块路径。先启动本机服务，按需设置 `BROWSER_CHECK_URL` 和 `STUDENT_INBOX_DATA_DIR`，然后运行 `tools/workspace-ui-check.mjs`、`tools/followup-ui-check.mjs`、`tools/archive-ui-check.mjs` 或 `tools/chat-ui-check.mjs`。这些脚本模拟事项修改请求；部分页面截图仍可能包含本机已采集内容，输出位于忽略的 `artifacts/`。不把这些截图用于公开演示。

`tools/check-chat-login.mjs` 是需要本人账号的手动集成检查，可能打开登录窗口；它不属于 CI 或普通回归。

## 提交内容

- 说明问题、最终行为和验证方法；不要为界面修改重写平台采集模块。
- 保留原消息时间、稳定消息 ID、用户完成/归档决定和账号隔离。
- 真实数据、密钥、Cookie、数据库、二维码、日志和运行截图不能提交。测试数据请手写合成。
- 调整第三方组件时，同时更新固定版本、校验信息及许可证。
- 网站同步、手机访问和后台提醒仍未完成，文档不能写成已上线功能。
