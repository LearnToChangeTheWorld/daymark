# 微信接入调研（2026-10-15）

目标：个人微信扫码、保存登录、接收指定群（包括免打扰群）消息；无需每个群打开窗口。以下是上游资料核对结果，未登录本人账号验证这些协议端。

| 项目 | 公开能力 | 当前依赖 / 限制 | 结论 |
| --- | --- | --- | --- |
| [WeChatPadPro](https://github.com/WeChatPadPro/WeChatPadPro) | iPad 协议二维码登录、消息同步、API、运行包 | 核心并未完整开源；MySQL、Redis、授权服务；普通公开版本有授权失败反馈 | 机制契合，不能仅凭文档承诺当前可用 |
| [Gewechat](https://github.com/Devo919/Gewechat) | 历史扫码、REST API、群消息回调 | 原仓库当前 README 声明已停更，保留客户端示例，不提供完整底层服务或镜像 | 不用旧 fork 的 README 判断可用性 |
| [Wechaty / PadLocal](https://github.com/wechaty/puppet-padlocal) | 扫码事件、消息事件、群列表、设备会话 | 依赖 PadLocal Token 和底层供应商；开源的是适配层，服务当前可用性另需验证 | 可做供应商适配候选，不等于免费独立协议端 |
| [WeChatFerry](https://github.com/lich0821/WeChatFerry) | 登录二维码、直接接收客户端消息 | Windows Hook；公开文档适配 3.9.12.51，不适配当前电脑的 4.1.15.53 | 有读取能力，但不能直接替换当前新版客户端方案 |
| [Deepsee](https://github.com/leecyno1/Deepsee) | 个人信息流聚合、白名单、去重、微信网关 | 微信实时接入依赖 wechatapi.net 的 token/app_id、公网回调；仓库本身并非完整 iPad 协议端 | 借鉴网关和数据层设计，不能省去上游服务 |
| [wechat2ipad/wechat-ipad-protocol](https://github.com/wechat2ipad/wechat-ipad-protocol) | 作者宣称扫码、状态缓存、自动心跳、二次登录、WS 消息 | 当前公开仓库主要是展示和付费交付说明；非可直接免费克隆运行的完整源码 | 不把营销 README 当作已取得的可运行依赖 |

具体一手依据：

- [Gewechat 当前原仓库说明](https://github.com/Devo919/Gewechat#readme)：技术归档、停止维护，不含完整服务端。部分 fork/raw 缓存仍保留旧“免费可运行”说明，以原仓库当前说明为准。
- [WeChatPadPro 维护者关于源码的说明](https://github.com/WeChatPadPro/WeChatPadPro/issues/6)：主要分发已编译执行文件。
- [WeChatPadPro 授权失败问题及 2026 年 9 月反馈](https://github.com/WeChatPadPro/WeChatPadPro/issues/205)：有人反馈排除 DNS/TLS 后仍失败，贡献者建议联系维护者。不能据此认定所有版本停服，也不能认定公开版本已恢复。
- [PadLocal 官方接入说明](https://wechaty.js.org/docs/puppet-providers/padlocal/)：需要申请 Token；[Wechaty 示例](https://github.com/wechaty/getting-started#working-with-different-puppets)明确设置 `WECHATY_PUPPET_PADLOCAL_TOKEN`。
- [Deepsee 网关说明](https://github.com/leecyno1/Deepsee#wechat-api-对接)：保存 token/app_id/wxid/region_id/device_type，二次登录复用 app_id；外部回调需要可达地址。

协议适配的验收条件应为：真实二维码 → 本人手机确认 → 稳定账号 ID/设备会话持久化 → 重启恢复 → 群列表 → 未打开且已免打扰的指定群新消息 → 下线/失效提示。不能只拿到二维码就判为成功，也不应把整个个人微信的消息或会话交给第三方而界面不说明。

当前已实现的默认路线已改为官方 Windows 微信 + 本机数据库只读采集，替代无法读取控件的 UI Automation 路线。本机 4.1.15.53 已验证数据库账号身份、密钥页面认证、群列表、免打扰群近 7 天缓存及重复读取零新增。此结果不等于官方提供个人微信 API，也不等于已验证全部实时消息和完整手机历史。

实际复用的公开源码：

- [tzwkb/wechat-decrypt](https://github.com/tzwkb/wechat-decrypt)，固定提交 `f0b3f9f95dda2d954ee3dbe1d139fb1944a5ecfd`，MIT。使用 Windows SHA-512 入口定位与密钥捕获脚本，以及只接受已提交事务的 WAL 快照代码，保留许可证于 `collector/wechat_vendor/`。本项目独立实现账号识别、DPAPI 保存、逐页认证解密、消息解析、群白名单、历史范围和耐久采集进度。
- [ssq123123/weixin-db-decrypt-panel](https://github.com/ssq123123/weixin-db-decrypt-panel)，固定提交 `4cd561122b23f8077ecae8209069deb75ebc9aa2`：只作对照研究。其旧 codec 内存布局扫描在本机未取得可校验密钥，未作为运行依赖。
- [chatlog](https://github.com/sjzar/chatlog) 当前原仓库仅保留移除说明；不能按照旧教程直接克隆构建。PyWxDump 的旧 fork 也不能据此推定适配当前 4.1.15.53。

初始化只在用户主动请求时重启一次微信并临时附加本机进程，完成后卸载定位脚本；轮询和服务重启不会重新执行初始化。原始密钥不写入日志或明文文件，Windows DPAPI 密文与本机解密缓存留在忽略的数据目录。密钥加密不代表缓存数据库加密；缓存含个人聊天原文，不应复制到公开目录或云部署镜像。

读取账号通过官方微信进程当前打开的 `db_storage` 文件句柄确认，不按目录修改时间猜测；同时打开多个账号时拒绝采集，切换账号清空旧群白名单与进度。所选群消息通过 `server_id`（无此 ID 时使用库名与 local_id）生成稳定标识。仅请求最近 7 天，按页保存已成功入库后的增量位置，出错不把“空结果”当成读取完整。

路线边界：电脑微信须保持登录并实际同步数据；本机没有的数据读不到。页面报告本机库可读，不把它当成网络在线证明。持续检查约每 4 秒；客户端升级、离线、退出、密钥变化和新消息编码变化均需处理错误或重新验证。图片、语音、文件正文未做 OCR/识别；分享卡片仅保留标题和摘要。持久化会话不能保证永久免扫码。
