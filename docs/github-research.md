# 账号接入候选仓库

> 历史调研记录：下文描述 2026-10-15 调研当时的状态，不是当前功能清单。现有接入能力及限制以 [README](../README.md) 和 [平台接入说明](platform-setup.md) 为准。

调研日期：2026-10-15。此轮只调研，没有安装、执行第三方仓库，也没有在本人账号上验证登录或消息采集。以下区分“源码已提供能力”和“集成后实测可用”。

## 优先候选

| 平台 | 仓库 | 已核对能力 | 对本项目的用途与缺口 |
| --- | --- | --- | --- |
| 微信 | https://github.com/Hello-Mr-Crab/pywechat | README 当前主推 pyweixin（微信 4.1.6+），Windows UI 自动化；有指定独立聊天窗口的 Monitor.listen_on_chat，多窗口监听返回文本和发送人。LICENSE 为 LGPL 2.1 文本。 | 用户在官方 Windows 微信扫码登录后，本机适配器读取指定群。不是独立微信协议登录；UI 可访问性、电脑锁屏、免打扰群、断线补齐、消息稳定 ID 均需实测。不要仅扫描未读红点代替指定群监听。 |
| QQ | https://github.com/NapNeko/NapCatQQ | 基于 NTQQ 的 OneBot 协议端；项目文档明确有扫码登录与 WebUI 配置。 | 作为独立外部程序使用 OneBot 接口对接；已有收件箱 webhook 只能接事件，尚未集成扫码登录页面。仓库采用混合/自定义许可，README 限制未经授权基于其代码开发，不能当成 MIT 代码复制进项目。免打扰群与历史补齐待实测。 |
| 学习通 | https://github.com/DanMo661/Xuexitong-mcp | MIT；client.py 包含手机号密码登录、cookie 持久化与过期重登、课程、作业列表/详情、截止看板及通知查询。 | 最贴近只读通知需求。优先做独立客户端适配，不必引入 MCP 服务层。网页登录接口而非官方授权接口；验证码/学校账号登录差异需本人验证。截止详情只有月日时，其补年算法需审核，不能盲目生成确定日期。 |
| 雨课堂 | https://github.com/thuhollow2/yuketang | MIT；yuketang.py 包含微信扫码、登录 cookie 保存/有效性检查、课堂及考试信息相关流程。 | 可研究登录和只读请求方式；尚未确认课后作业清单与完整截止提醒能力，不能整库接上就称需求完成。仓库含签到/答题等行为，不执行整套程序；本项目只需登录与读取通知。 |

## 已检查但不优先使用

- https://github.com/cluic/wxauto ：页面列 Apache-2.0，但 README 同时禁止用于实际生产项目/商业用途，且版本兼容信息不足，暂不作为直接复用基础。
- https://github.com/ZaytsevZY/yuketang-helper-auto ：主要是浏览器课堂习题提醒和课件工具，README 要求页面已登录；不能直接解决本项目的独立登录和全课程课后作业收件箱。
- https://github.com/travellerse/RainClassroomAssistant ：仓库已归档，README 表明停止维护，上游缺许可证；不作为新项目依赖。
- https://github.com/LagrangeDev/Lagrange.Core ：QQ NTQQ 协议实现备选；本轮尚未完成当前登录可用性与许可核对，不据此确定选型。

## 阅读过的关键原始资料

- 微信 README：https://raw.githubusercontent.com/Hello-Mr-Crab/pywechat/main/README.md
- 微信 LICENSE：https://github.com/Hello-Mr-Crab/pywechat/blob/main/LICENSE
- QQ 文档：https://napneko.github.io/use/integration
- QQ 许可：https://github.com/NapNeko/NapCatQQ/blob/main/LICENSE
- 学习通客户端：https://github.com/DanMo661/Xuexitong-mcp/blob/main/xuexitong_mcp/client.py
- 雨课堂客户端：https://github.com/thuhollow2/yuketang/blob/main/yuketang.py

## 实施顺序

先做学习通登录/只读采集闭环，然后接 QQ 外部协议端扫码流程，再验证微信指定群监听，最后补雨课堂作业读取。所有平台的登录态保留在 Windows 采集端，云服务只接收归一化后的通知；云端和 iPhone 网页不承担 Windows UI 自动化。当前 GitHub API 遇到匿名速率限制，未获取精确的最新提交/发行版本；正式选定依赖时应固定提交并重新核对许可。
