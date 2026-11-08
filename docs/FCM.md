# DSH Notify：Android FCM 专用客户端

这是 `chromoany/dsh-notify-me` 的独立开发 fork，不是上游正式版本。原有桌面通知、提示音和外部渠道继续保留。新增 FCM 为可选的宿主端能力，默认关闭；开发不会改动正在运行的生产 DSH。

## 第一版功能

- 服务端监听：回复完成、运行错误/输出截断、AI 提问、方案待审阅、目标完成/阻塞、工具审批。
- 通知包含事件类型、会话标题、简短内容、会话链接。`includePreview: false` 可隐藏具体内容。
- FCM 使用 data-only Android 高优先级消息；不需要网页存活，也不依靠浏览器本地设置。
- APK 只做设备配对、FCM 接收、原生通知和一次性审批；没有 WebView、聊天界面、轮询或自建常驻服务。
- 通知正文点击使用系统默认浏览器打开 HTTPS 会话链接。页面正常鉴权后，由 fork 的网页部分选择对应会话。
- 审批按钮只有“允许一次”和“拒绝”。与网页审批争用同一实时请求，先完成者生效；过期、重复、取消、已结束的请求均拒绝。没有永久放行能力。
- 设备列表与密钥摘要存于服务端私有文件；每个启用的设备接收一份通知，同一事件对每个设备去重。子智能体默认不单独推送。

## 重要安全边界

1. Firebase 服务账号只在 DSH 服务器。APK 只带 Firebase 客户端配置，不带 Google 账号 Token、管理员 Token 或服务账号私钥。
2. 设备秘密在 APK 内使用 Android Keystore AES-GCM 加密；服务端只保存 SHA-256 摘要。应用禁止备份和明文 HTTP。
3. 一次性配对码为高熵随机码，5 分钟有效、串行原子消费。撤销设备会阻止后续 API 请求和推送。
4. APK 不追随 HTTP 重定向；点击链接只能指向已配对的 HTTPS 同源与站点路径，禁止任意 scheme、跨站链接和 URL 内凭据。
5. API 仅接受原生客户端/CLI JSON POST + Bearer，拒绝浏览器 Origin，不提供 CORS。审批接收器不对外导出；通知 PendingIntent 不可变。
6. 审批必须解锁手机。Android 12+ 使用系统通知动作的认证要求；较旧系统锁定时拒绝提交动作，请解锁后再点。
7. DSH 本身必须启用“询问审批”的策略才会产生审批。若宿主/会话配置为禁止审批、自动拒绝，APK 不能绕过或开启权限。
8. 通知通过 Google 路由；不要开启包含秘密的预览。内容长度有限，复杂操作请打开网页核对完整内容后审批。

## Firebase 项目

APK 使用通用包名 `io.github.dshnotify.client`。首次启动的服务器地址为空，不会自动访问任何预置 DSH 站点。Firebase Android 客户端配置由构建者提供在 `android/app/google-services.json`（忽略，不提交）；它包含 FCM 必需的项目/应用标识，但不是服务账号私钥。

服务器地址只在已登录的设置界面中由用户填写，或明确点击“使用当前站点地址”后填入；保存后只进入服务器私有配置。源码、文档和示例不应包含实际部署域名。构建脚本通过参数接收 Firebase 项目，不绑定个人命名。

服务账号只应授予其项目的 `roles/firebasecloudmessaging.admin`。开发凭据存于忽略的 `.secrets/`，生产配置通过所有者设置界面上传并以 0600 保存；任何凭据都不能放入 Git、发行资产或 APK。

HTTP v1 已做 `validate_only` 验证。它只能证明账号、API 与发送权限可用，不能代替真机送达验证；没有伪装成已给手机发送成功。

如自行重建 Firebase：创建项目 → 启用 Cloud Messaging API → 注册 Android 包名 → 下载客户端配置 → 创建 FCM 专用最小权限服务账号。不要把 Google 登录授权码或 refresh token 放在服务器插件配置里。

## 图形化配置：无需手改 profile

这是对同名插件的 fork 替换，不要把上游和 fork 同时挂载，否则会重复通知。安装修改版后，确认版本为 `1.18.0-fcm.1` 或更新，并刷新网页。

1. 打开 **设置 → 通知提醒 → 高级 → 外部通知**，将“通知通道”选为 **FCM · Android**。
2. 填写你自己的 DSH 公网 HTTPS 地址；也可明确点击“使用当前站点地址”。初始字段为空，没有内置部署地址。
3. 上传 Firebase 专用发送账号 JSON。界面会从所选文件填写项目 ID；确认它与构建 APK 的 Firebase 项目一致。
4. 选择推送事件与是否包含内容摘要，打开 FCM 开关，点击 **保存到服务端**。无需复制私钥进 profile，也不需要管理员令牌。
5. 点击 **验证 Firebase 权限**，再 **生成配对码**。手机配对后可 **刷新设备**、**撤销设备**、**发送 FCM 测试通知**。

FCM 配置通过 DSH Connection 的 `/api` 精确 Fetch 路由管理。传输先走宿主 Host/Origin 与登录认证，精确路由只允许 owner Peer；不新增根路径，也不要求 CDN 额外转发一个自定义顶层 URL。读取只回传 `hasCredentials`，不会回传私钥或服务账号正文。空上传保留原凭据；“停用并移除凭据”必须显式确认。

配置保存在 `$DSH_HOME/dsh-notify-me/fcm-settings.json`（未设 DSH_HOME 时为用户目录下对应位置），以 0600 原子写入；有并发修订检查和失败回滚。换浏览器和重启服务器后仍从服务器读取，不使用 localStorage 存放 FCM 配置或凭据。FCM 开关独立于当前浏览器的本地提醒开关。原有其他外部通知渠道的设置没有被迁移或偷偷启用。

CDN 前端保持有效 HTTPS；源站可以仍监听 HTTP。需要保留登录 Cookie、Authorization、JSON POST，且 `/api/notify-me-fcm/control` 的 POST 请求不能被缓存、重定向或人机挑战拦截。上传服务账号仅允许 HTTPS 或本机通道；网页会拒绝把所选私钥上传到远程明文 HTTP。带子路径的部署应在地址中保留该子路径。

`docs/fcm-config.example.yml` 仅保留给兼容旧版或指定存储路径的高级用户，不是图形配置的前置步骤。

## 手机配对

先安装 APK 并允许通知。它需要 Android 8+、Google Play 服务以及可达的 Google FCM 网络；未上架 Play 商店也可以侧载。

推荐在插件设置里点击“生成配对码”。以下是可选的宿主机 CLI 用法，不是图形配置的前置步骤：

```sh
node scripts/fcm-admin.mjs pairing-code \
  --base http://127.0.0.1:3080/ \
  --admin-token-file /data/dsh/dsh-notify-me/fcm-admin-token
```

填入 APK：

- 服务器：你在插件设置保存的 HTTPS 地址（APK 首次打开为空）
- 设备名：自选
- 配对码：刚生成的一次性码

管理员密钥由插件首次启动生成，仅留服务器私有文件。CLI 默认读取 `$DSH_HOME/dsh-notify-me/fcm-admin-token`。只把短期配对码交给手机。

其他管理命令：

```sh
node scripts/fcm-admin.mjs devices --base http://127.0.0.1:3080/
node scripts/fcm-admin.mjs revoke --device-id <ID> --base http://127.0.0.1:3080/
node scripts/fcm-admin.mjs test --base http://127.0.0.1:3080/
```

Token 轮换由 WorkManager 的一次性任务同步，带版本号防止旧请求覆盖新 Token；没有周期性轮询。解除配对也可在 APK 执行。

## 构建与测试

需要 Node 24.9+、JDK 17+、Android SDK 35。FCM 宿主适配目标为 DSH 0.2.2-rc.1；保留旧宿主浏览器回归不等于认证旧版本的 FCM 接口。项目带 Gradle 8.13 wrapper 和分发校验和。

```sh
npm ci --ignore-scripts
npm test
# 从 Firebase CLI 或控制台取得相同包名的配置（不要提交它）：
firebase apps:sdkconfig ANDROID <APP_ID> --project <PROJECT_ID> --out android/app/google-services.json
ANDROID_HOME=/path/to/sdk ./android/gradlew -p android assembleDebug testDebugUnitTest lintDebug
npm pack
```

APK：`android/app/build/outputs/apk/debug/app-debug.apk`。这是开发测试签名，不是已上架或生产签名的正式发行包。0.2.0 使用新的通用包名；旧 0.1.0 测试版可卸载，不会自动继承旧地址或配对。正式发行应另外保存长期签名密钥，避免升级时需要卸载重装。

## 验收与已知限制

自动测试覆盖配对码并发消费/过期、设备认证/撤销、Token 版本、HTTP 接口、审批竞争/取消/超时、重复通知、内容字段、深链接冷启动与 Android URL 安全。上游原有 smoke 回归测试也必须通过。

尚须真机验证：GMS 和网络、首次授权、锁屏/后台/清理进程、通知动作、审批结果、浏览器登录后选择会话。系统强制停止 APK 后不保证收信，需要重新打开。WorkManager 和高优先级 FCM 不是永久豁免省电限制。

APK 0.3.0 起，通知点击向支持该 Android 约定的浏览器提供稳定的调用方标识，争取复用由此 App 打开的标签。浏览器仍决定是否复用、是否切到前台；不能保证找到用户手动打开的其他 DSH 标签。审批结果通知也使用相同的跳转方式。

网页鉴权入口不应再要求通知自行携带 DSH 登录 token。反向代理或登录插件必须支持从其他应用打开带会话片段的 HTTPS 链接；登录后由网页选择会话。

FCM/网络失败会隔离并有限重试，不中断 AI；待发通知不作为可靠消息队列跨服务器重启保存。重启前的审批动作会过期拒绝。通知被网页抢先处理后，手机旧按钮可能还在，点击会得到“已处理或过期”，不会重复放行。

暂无真实手机验收结果，不要把构建成功、模拟测试或 HTTP v1 validate-only 当作端到端收发成功。
