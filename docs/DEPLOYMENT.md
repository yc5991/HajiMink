# 部署说明

## 1 运行目录

网关以当前 Windows 用户运行并监听 `127.0.0.1`，Codex 桌面应由同一个用户登录并保持运行

默认正式数据目录为项目内 `.local/runtime`，开发数据目录为 `.local/dev`，运行目录保存配置、登录数据库、操作记录和日志

`AGENT_CONTROL_DATA_DIR` 与 `AGENT_CONTROL_CONFIG` 可以覆盖网关数据目录和配置路径，使用自定义路径时应同时检查连接器脚本读取的位置

## 2 本机使用

按 README 安装、测试和构建，复制 `config.example.json` 作为 `.local/runtime/config.json` 后运行 `scripts/Start.ps1`

默认打开 `http://localhost:3000`，`publicOrigin` 应与实际使用的浏览器地址一致，浏览器来源不同会影响校验和通行密钥

`local` 适合本机使用，远程发布需要切换为后续正式模式，隧道启动脚本会拒绝本机开发模式

## 3 独立登录

Windows 桌面版还提供一次性设置码流程，可以在最终 HTTPS 域名直接设置通行密钥。网关进入待设置状态后，先配置隧道和有效证书，再由所有者在正式地址输入本机设置码并完成注册；设置完成前工作台内容保持锁定。设置码过期或使用后，可回到本机网关页面重新生成。该流程和真实公网服务商尚需人工验收

`owner` 模式提供密码和通行密钥，命令行部署可在可信本机设置密码，再通过正式域名添加通行密钥：

- 第一步，以本机模式打开 `http://localhost:3000/account`，本人设置密码

- 第二步，停止网关，将配置改为 `config.owner.example.json` 的格式，把 `publicOrigin` 替换为自己的 HTTPS 域名，保留原数据目录

- 第三步，启动网关，确认未登录的业务请求被拒绝，再配置正式访问通道

- 第四步，在正式域名用密码登录，进入登录与账户添加该域名的通行密钥

通行密钥绑定站点域名，localhost 下创建的密钥不能直接用于正式域名，修改密码或添加密钥需要本人在浏览器和设备上完成

根据 `server/owner-auth.ts`，密码至少 12 个字符，默认登录有效 8 小时，选择保持登录后有效 7 天，最近身份验证要求来自 `server/auth-routes.ts` 的 5 分钟设置

已有 Cloudflare Access 保护时，也可以先在原入口完成初始化，再切换为独立登录

## 4 Cloudflare Tunnel

Cloudflare Tunnel 从本机建立出站连接，发布的服务地址为 `http://127.0.0.1:3000`，公网域名由部署者自己配置

官方 `cloudflared.exe` 放在 `.local/runtime/bin`，真实 Tunnel Token 保存在同一运行目录的 `tunnel-token` 文件中

```powershell
.\scripts\Start-Tunnel.ps1 # 检查正式验证后启动连接器
.\scripts\Stop-Tunnel.ps1 # 停止当前网关对应的连接器
```

脚本使用 Token 文件参数并收紧文件权限，正式配置和凭据存在时，后台启动脚本会同时启动连接器

独立登录模式下，Tunnel 的 Protect with Access 应关闭，相关 Access 应用也应采用与本站登录匹配的策略，网关负责最终业务授权

Access 模式下，边缘应用、连接器和网关应使用一致的团队名称与应用标识，并启用连接器的 Access 检查

Token 文件参数要求 cloudflared 2025.4.0 或更新版本，依据官方参数说明 [1]

## 5 Access 模式

复制 `config.access.example.json` 的格式，填写自己的 `accessIssuer`、`accessAudience` 和 `allowedEmail`

`accessIssuer` 是团队签发地址，`accessAudience` 是对应应用的受众标识，`allowedEmail` 是唯一允许的所有者邮箱

Access 策略应限制为所有者，网关会核对签名、签发方、应用标识和邮箱，示例占位符不能作为真实部署值

两种正式模式的选择应贯穿边缘入口和本机配置，身份校验尚未生效时应先处理配置，再开放远程路由

## 6 运行管理

`Register-Startup.ps1` 注册当前用户登录启动任务，`Stop.ps1` 停止网页网关，Codex 原任务继续执行

Windows 注销会退出当前用户的程序，桌面升级后应重新检查适配版本，更多恢复边界见 `VERIFICATION.md`

遗失所有独立登录方式时，可以通过受信任的本机入口恢复，或先恢复严格的 Access 所有者策略，再将网关切回 Access 模式完成本人重新设置

Access 中存在绕过策略时，应先移除对应绑定并确认所有者策略生效，再依赖 Access 进行恢复

恢复、迁移和备份时应保留自己的运行数据库及配置，公开源码包不包含这些数据

## 7 参考资料

[1] Cloudflare, Tunnel tokens, https://developers.cloudflare.com/tunnel/reference/tunnel-tokens/

[2] Cloudflare, Origin parameters, https://developers.cloudflare.com/cloudflare-one/networks/connectors/cloudflare-tunnel/configure-tunnels/origin-configuration/origin-parameters/
