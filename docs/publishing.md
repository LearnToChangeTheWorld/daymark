# 发布到 GitHub

当前发布内容是 **Windows 本地运行预览版的源码**。没有线上网址，不支持手机远程访问；平台网站接入和后续同步接口保留。请在仓库简介中保留这个范围。

## 生成干净源码包

在项目根目录执行：

```powershell
node --test test/*.test.mjs
node tools/release-check.mjs
powershell -ExecutionPolicy Bypass -File tools/prepare-release.ps1
```

检查通过后，在 `artifacts/releases/` 生成源码目录、ZIP 和 SHA-256 校验文件。只导出检查通过的源码，不删除或更改本机账号、聊天记录、数据库和运行组件。没有 Git 仓库的源码解压目录也可以执行发布检查；在 Git 仓库中会同时检查已跟踪文件，避免忽略规则掩盖已经加入版本库的私人文件。

工具会拒绝运行数据目录、密钥文件、可疑凭据、符号链接和未知顶层目录，并验证本地 Tabler 资源校验值。它只检查当前文件，不能替代人工检查或清除 Git 历史中已经泄漏的数据。不要直接压缩正在使用的整个项目文件夹。

## 创建仓库并上传

建议仓库名 `daymark`。可直接使用的英文简介：

> A Windows-local student inbox and task manager for WeChat, QQ and learning platforms. No hosted service; future website sync interfaces are retained.

在 GitHub 新建空仓库，选择公开或私有；上传已有源码时，不勾选自动创建 README、许可证或 .gitignore，避免重复初始化。

### 用 Git 上传（推荐）

在检查通过的本地项目目录操作；如果是解压的发布包，先运行 `git init -b main`。下面的示例地址必须换成自己新建仓库页面提供的地址：

```powershell
git add .
git diff --cached --stat
git commit -m "Prepare Daymark local preview"
git remote add origin https://github.com/YOUR_USERNAME/daymark.git
git push -u origin main
```

提交前查看文件列表，确认没有 `data/`、`artifacts/`、`.venv-wechat/`、`vendor/napcat/`、登录缓存或实际账号配置。Git 第一次提交如果要求身份，按提示设置自己的提交姓名和邮箱；使用 GitHub 提供的隐私邮箱可以避免公开个人邮箱。登录通过 GitHub 或凭据管理器完成，不把 Token 写进远程地址或代码。

### 不使用 Git

解压发布 ZIP，将其中源码文件夹的**内容**上传到仓库，包含 `.github/`、`.gitignore`、`.env.example` 等配置文件。不要只上传 ZIP 作为仓库全部内容，否则 GitHub 不会直接展示代码或运行自动检查。ZIP 可另外作为 Release 的附件。

## 上传后检查

- 首页能看到 README，并明确写着仅本机运行；MIT 及第三方说明都在。
- Actions 中的 Windows / Node 22、24 检查通过。工作流已经配置，首次远程执行结果以 GitHub 页面为准。
- 下载仓库到新目录，按 README 启动；不要依赖开发电脑已有的运行组件。
- 示例、Issue、截图和 Release 附件不含真实账号、访问码、聊天内容和学生信息。

这个版本标记为 `0.1.0` 本地预览。请勿宣传雨课堂、教务适配、手机远程访问或系统提醒已经完成。NapCat 运行组件需另行下载安装，Daymark 的 MIT 许可不改变它的独立许可。
