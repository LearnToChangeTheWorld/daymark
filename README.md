# Daymark

把分散在群聊和学习平台里的要求，整理成可以处理、完成和回查的事项。

**当前是 Windows 本地运行的预览版，没有线上网站，也不支持 iPhone 远程访问。** 软件和数据放在自己的电脑上，不需要服务器或域名。网站接入与同步接口已保留，尚未完成公网部署验证。

## 能做什么

- **待办**：明确的作业、提交和填写要求自动加入；按原消息日期分组，截止时间另行标注。
- **待确认**：只保留可能需要行动的候选，确认或归档；支持批量归档。
- **通知**：直接显示完整正文，可按作业、考试、课程安排等主题筛选。
- **记录**：回查原消息、普通聊天、已完成和已归档事项，支持搜索与恢复。

微信和 QQ 自动识别学习相关群，无需先逐个勾选；可以纠正识别结果。分类使用本机文字规则，没有大模型 API 费用。明确的事项自动加入待办，普通闲聊不会堆进待确认。

### 平台支持情况

| 来源 | 当前能力 | 边界 |
| --- | --- | --- |
| 微信 | 官方 Windows 客户端扫码；本机数据库只读采集；学习群自动识别；近 7 天缓存补读 | 已在微信 4.1.15.53 上验证，其他版本需测试；不等于完整手机历史 |
| QQ | NapCat 外部组件扫码；学习群自动识别；近期历史补读与消息接收 | 已验证本机登录、历史和重启恢复；不同客户端、实时到达及断线完整性仍需验证 |
| 学习通 | 手机号密码登录；课程、未提交作业、近 7 天通知；保存账号后恢复 | 可能需要本人在 Edge 验证；暂不支持扫码 |
| 雨课堂 | 已预留来源和适配位置 | **采集器尚未实现** |
| 中南大学教务系统 | 已预留来源和适配位置 | **采集器尚未实现** |

## 开始使用

需要 Windows、Node.js 22 或更新版本。先下载源码 ZIP 并解压，进入包含 `server.mjs` 的文件夹，在 PowerShell 运行：

```powershell
node server.mjs
```

无需安装 Node 运行依赖，也不需要编译前端。打开 [http://127.0.0.1:4317](http://127.0.0.1:4317)，输入启动窗口中显示的**软件访问码**。它与微信、QQ 或学习通密码不同。使用期间保持启动窗口打开；关闭服务会停止采集，数据仍然保留。

首次运行的数据默认保存在 `%LOCALAPPDATA%\StudentInbox`，包括访问码、事项库及加密账号文件。可以通过 `STUDENT_INBOX_DATA_DIR` 指定其他目录。建议把数据目录放在源码目录之外，升级时沿用原目录。

### 接入平台

核心事项功能可直接使用；连接聊天平台时再安装可选组件。使用微信需要官方 Windows 微信和 **Python 3.10 x64**；使用 QQ 需要官方 Windows QQ。按需执行：

```powershell
# 只安装微信读取组件
powershell -ExecutionPolicy Bypass -File tools/setup-chat.ps1 -Component WeChat

# 只安装 QQ 组件
powershell -ExecutionPolicy Bypass -File tools/setup-chat.ps1 -Component QQ
```

脚本会联网下载固定版本并核验校验值，运行组件不包含在源码中。QQ 组件有独立许可证，见 [第三方说明](THIRD_PARTY_NOTICES.md)。

在网页点击“接入账号”，选择微信、QQ 或学习通。微信首次初始化会明确提示并重启一次客户端；以后静默尝试恢复，不反复弹出微信窗口。登录由对应客户端管理，需要扫码或手机确认时仍须本人操作。

具体步骤、成功提示、采集范围及常见问题见 [安装与平台接入](docs/platform-setup.md)。

## 使用范围

- **本地运行需要联网采集**；已有事项可在本机服务运行时离线查看。默认仅监听 `127.0.0.1`，不开放校园网、局域网或公网访问。
- **保存登录不等于永不掉线**。客户端退出、平台验证、密钥变化或升级都可能需要重新连接，界面会显示状态。
- **补读只覆盖能够取得的历史**。微信限电脑已缓存的数据，QQ 限组件返回的数据；不能保证所有消息绝不遗漏。
- **图片、语音、附件正文暂未理解**，文字规则也可能误判或漏判。可以人工新增、纠正或排除事项。
- **没有系统后台推送、开机自启或安装包**。待办会保留到完成或归档，不代表已经实现定时提醒。
- 学习通作业在平台提交后，已导入待办暂不会自动标为完成。

## 项目结构

```text
server.mjs       本机事项服务、访问限制及 API
public/          浏览器界面和本地静态资源
collector/       平台连接、只读采集与耐久队列
shared/          事件格式、分类规则和运行配置
test/            使用合成数据的回归测试
tools/           组件安装、验证和源码发布工具
docs/            平台接入、设计与接口文档
```

界面参考 [shadcn/ui Tasks](https://ui.shadcn.com/examples/tasks) 和 [Sidebar](https://ui.shadcn.com/docs/components/sidebar) 的组织方式，使用原生 JavaScript 和本地 Tabler 样式实现，不依赖 CDN。

- [网站接口与后续扩展](docs/website-interfaces.md)
- [界面与信息组织方案](docs/product-redesign.md)
- [参与开发及验证](CONTRIBUTING.md)
- [GitHub 发布步骤](docs/publishing.md)
- [数据与安全说明](SECURITY.md)
- [版本记录](CHANGELOG.md)

## 验证与发布

```powershell
node --test test/*.test.mjs
node tools/release-check.mjs
powershell -ExecutionPolicy Bypass -File tools/prepare-release.ps1
```

发布工具只导出经过检查的源码，排除账号、密钥、聊天数据、数据库、截图、日志和已安装运行组件；不会删除本机数据。生成的 ZIP 位于 `artifacts/releases/`，详细流程见 [发布步骤](docs/publishing.md)。

## 许可证

Daymark 自有代码使用 [MIT](LICENSE)。Tabler、微信读取所复用的代码及外部 NapCat 组件各自保留上游许可；项目的 MIT 不覆盖这些许可。版本与来源见 [第三方说明](THIRD_PARTY_NOTICES.md)。
