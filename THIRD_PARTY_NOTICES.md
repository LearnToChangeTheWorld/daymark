# 第三方组件与参考

Daymark 自有代码采用根目录的 [MIT License](LICENSE)。以下组件保留各自的许可证；Daymark 的 MIT 授权不改变它们的条款。

| 组件 | 使用方式 | 版本 / 固定来源 | 许可证位置 |
| --- | --- | --- | --- |
| [Tabler](https://github.com/tabler/tabler) | 仓库只内置官方 CSS，用于按钮与表单等样式 | `@tabler/core` 1.6.1；包校验与 CSS 摘要见 [SOURCE.json](public/vendor/tabler/SOURCE.json) | [MIT](public/vendor/tabler/LICENSE)，The Tabler Authors |
| [wechat-decrypt](https://github.com/tzwkb/wechat-decrypt) | 内置 SHA-512 入口定位脚本与已提交 WAL 快照读取代码 | `f0b3f9f95dda2d954ee3dbe1d139fb1944a5ecfd` | [MIT](collector/wechat_vendor/LICENSE)，2026 cocofeng；[来源说明](collector/wechat_vendor/README.md) |
| [NapCatQQ](https://github.com/NapNeko/NapCatQQ) | 可选 QQ 外部运行组件，由安装脚本单独下载；源码包不包含运行文件 | v4.18.38；下载摘要见 [vendor/README.md](vendor/README.md) | [Limited Redistribution License for NapCat](vendor/NapCat.LICENSE)，2024 Mlikiowa；包含非商用限制 |

## Python 运行依赖

`tools/setup-chat.ps1 -Component WeChat` 从 PyPI 下载固定版本，按发布元数据核验 SHA-256 后安装到本机 `.venv-wechat/`。源码仓库和源码发布包不包含虚拟环境或 wheel 包。各包许可证随其安装文件保留：

`pywinauto==0.6.9`、`comtypes==1.4.17`、`six==1.17.0`、`pywin32==312`、`Pillow==12.0.0`、`pycryptodome==3.23.0`、`frida==17.8.0`、`zstandard==0.25.0`。

官方 Windows 微信、QQ、Microsoft Edge 和 Python 需要用户自行安装，不随项目分发。

## 设计与协议参考

- [shadcn/ui](https://github.com/shadcn-ui/ui)：参考 Tasks 和 Sidebar 的布局思路，未复制 React 组件；页面样式由 Daymark 自行实现。
- [Xuexitong-mcp](https://github.com/DanMo661/Xuexitong-mcp)：学习通登录与只读接口研究参考，本项目使用独立 Node.js 客户端，未打包其 Python 项目。
- [pywechat](https://github.com/Hello-Mr-Crab/pywechat)：早期 Windows 控件兼容性研究，未导入或分发该包。

其他探索记录位于 `docs/`，只作当时的选型记录，不表示相关项目是运行依赖或获得其官方支持。
