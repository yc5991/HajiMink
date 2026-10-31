# HajiMink · 哈基米 AI 工作台

把本机 Agent 桌面应用里的项目和会话带到浏览器，方便在电脑、平板和手机上继续工作

HajiMink 的 Agent Control 网关面向个人使用，网页与桌面共用原会话标识，任务执行和审批权限由原桌面应用管理

当前真实接入为 Codex，DSH 已有软件入口和适配接口，真实连接是下一阶段工作

## 1 当前状态

当前 Windows x64 发行准备版本为 `0.2.2`，版本号来自 `package.json`。程序尚未签名，Windows 可能显示安全提示。使用者已反馈在自己的环境中远程访问成功；其他隧道、认证方式及全新系统仍需分别验收

### 下载和启动

从 [GitHub Releases](https://github.com/yc5991/HajiMink/releases/latest) 下载 Windows x64 压缩包，解压后运行 `HajiMink.exe`。首次使用请在设置中启动本机网关；远程访问需要自行配置支持 HTTPS 和 WebSocket 的隧道。

关闭远程访问后，本机工作台仍直连本机网关。程序只能停止由 HajiMink 管理的 NATAPP，其他隧道和端口转发需要自行关闭。

适配器会尝试连接数字格式的 Codex 桌面 `26.x` 版本，包括 `26.1023.6123.0`；其他大版本暂不连接。允许尝试不代表每个版本的所有操作都经过验证

此前的真实写入验证覆盖一个专用测试会话的新建、发送和停止。本轮已对 `26.1023.6123.0` 完成只读连接检查，模型设置、审批和执行中追加消息等路径仍需真实联调，详见 [验收记录](VERIFICATION.md)

适配器使用未公开的桌面通信接口，桌面升级后接口可能变化，发生错误时需检查桌面版本和操作状态

<div align="center">

表 1.1 功能状态

| 功能 | 当前状态 |
| --- | --- |
| 原项目、原会话、新建和继续聊天 | 已接入真实 Codex 桌面，操作范围取决于桌面版本和连接状态 |
| 实时输出、历史分页、命令与文件变更查看 | 已实现 |
| 停止、模型和思考强度设置 | 已实现；实际桌面版本的设置行为仍需验证 |
| 问答与普通审批回应 | 已实现；真实审批种类覆盖见验收记录，权限扩展仍需在桌面审阅 |
| Codex CLI 终端 | 运行网关电脑已安装的 Codex CLI；断开终端会结束当前 CLI 进程 |
| 手机抽屉、横屏、主题、代码复制、草稿恢复 | 已实现并经过多尺寸浏览器检查 |
| 独立密码、通行密钥、Cloudflare Access | 可选择的登录模式 |
| 多 Agent 隔离与能力检查 | 已实现公共接入层 |
| DSH | 预留入口，真实接入待实现 |

</div>

当前数据流如下，虚线表示仍在准备的接入路径：

<div align="center">

![当前架构](docs/diagrams/architecture.svg)

图 1.1 当前运行架构

</div>

详细的消息流程和登录流程见 [架构说明](docs/ARCHITECTURE.md)，近期进度见 [项目进度](docs/PROJECT-STATUS-2026-10-29.md)，已验证与待验证的范围见 [验收记录](VERIFICATION.md)

### 1.1 桌面版

HajiMink 的 Electron 桌面外壳提供单实例窗口、托盘、工作台页面和连接管理，连接页面复用已有 React 工作台，连接之间使用隔离的临时浏览器数据

Windows 提供指向 `127.0.0.1:3000` 的默认连接，macOS 和 Linux 首次使用时需要手动添加远程网关。连接设置支持填写服务器 IP 或 HTTPS 地址，并可选择 NATAPP、SakuraFrp、Tailscale、Cloudflare Tunnel、自建服务器或其他地址。服务商隧道需要自行配置，设置内文档提供步骤和官方指南。Windows 用户可以选择自己准备的 NATAPP 客户端及配置文件，由 HajiMink 启动或停止这个客户端；其他方式的客户端仍由用户自行管理。未保存地址的检查只确认入口响应；已保存且受保护的地址还会检查部分未登录拦截和实时转发。结果不能证明服务器归属或持续连接正常，请核对地址并亲自登录验证

Windows 桌面端使用独立后台控制器管理自己启动的本机网关。关闭窗口会收起到托盘；选择退出软件时，程序会确认并停止自己管理的本机服务，下次启动时尝试恢复。手动停止的服务保持停止。重新连接时会校验实例凭据、进程路径、启动参数和创建时间，不会接管或结束未知进程。网关页可选择 1024 至 65535 之间的本机端口；修改运行中网关的端口需要短暂重启，已有隧道需要同步更改目标端口

手动停止网关后，重新打开桌面及切回本机连接时会保持停止。使用网关开关重新启动后恢复正常启动策略。停止状态无法保存时，程序会提示检查资料目录；“日志”页保留异常情况下的“保持停止”操作

首次使用 Windows 桌面版时，网关页会引导选择端口。远程登录可以先在本机设置密码，也可以选择通行密钥首次设置：填写最终 HTTPS 域名，在本机生成一次性设置码，配置隧道和有效证书后，可从设置码面板打开已保存的域名，在浏览器核对地址并手动输入设置码完成注册。设置期间工作台内容保持锁定；设置码使用一次或过期后，需要在本机重新生成。使用者反馈已在自己的环境中完成公网访问，但未记录设备及认证方式；真实设备认证器仍需分别验收，本机 `local` 模式不能直接发布公网

网关页接受自己的 HTTPS 地址、域名或服务器 IP，未填写协议时默认 HTTPS。修改后的地址会保留在当前窗口中；远程入口的详细状态和已保存地址显示在“日志”页

远程连接可以使用系统浏览器授权，适用于已部署设备授权功能的 `owner` 模式网关。确认后，桌面端把凭据保存在操作系统保护的存储中；Linux 找不到安全存储后端时只在内存保存。其他临时浏览器数据在应用退出后清除

```powershell
npm ci # 安装锁定依赖
npm run build:desktop:fixture # 先生成隔离的网页和网关构建
npm run desktop # 启动桌面开发版
npm run test:desktop # 使用模拟网关检查连接隔离和桌面边界
npm run test:device-ui # 用临时 HTTPS 网关检查浏览器和桌面设备授权
npm run test:stream-ui # 隔离检查实时连接中断、恢复与草稿保护
npm run test:gateway-manager # 启停临时本机网关并检查健康状态
npm run test:port-change # 临时网关的端口冲突与失败恢复
npm run test:owner-setup # 隔离 HTTPS、实时转发、密码与虚拟通行密钥流程
npm run test:passkey-setup # 一次性设置码、首次通行密钥和密码备用流程
npm run test:private-control # Windows 私有通道和凭据检查
npm run test:bridge-disconnect # 认证请求断开后的控制通道恢复检查
npm run test:exit-coordinator # 确认、停止失败和退出顺序检查
npm run test:gateway-intent # 手动停止和自动启动策略检查
npm run test:desktop:intent # 隔离检查停止状态持久化和桌面流程
npm run test:desktop:exit # 使用隔离网关和假客户端检查桌面退出行为
npm run test:controller # 后台控制器、进程校验和重连检查
npm run test:natapp-manager # 用独立假客户端检查 NATAPP 进程安全边界
npm run test:natapp-controller # 受保护网关与 NATAPP 控制器联调
npm run test:natapp-ui # 用独立假客户端检查 NATAPP 图形配置流程
npm run test:desktop:controller # 测试桌面退出后重新连接
npm run test:desktop:gateway # 使用独立端口进行只读桌面联调
npx tsx scripts/test-limited-ui.ts # 用模拟适配器检查部分兼容界面
npm run package:desktop:win # 构建包含固定运行环境的未签名 Windows 程序包
```

桌面联调脚本会读取当前用户的 Codex 项目和会话目录，不发送、修改或中断任务

Windows 程序包包含隔离构建的网页、网关、生产依赖及固定 Node.js 运行环境。其他服务商的桌面 Tunnel 管理、异常自动重试、公开发布和跨平台安装验收仍待完成，详见 [桌面开发说明](docs/DESKTOP.md)

开发桌面版时使用 `npm run build:desktop:fixture`，网页和网关会输出到 `.local/hajimink-stage`。`npm run build` 会写入项目根目录的 `dist` 与 `dist-server`，接管线上服务前不要在运行目录执行它

## 2 本机运行

根据 `package.json`，需要 Windows、Node.js 24 或更高版本，以及已登录并保持运行的受支持 Codex 桌面应用

网关与桌面应使用同一个 Windows 用户

Node.js 要求来自 `package.json`，网关使用其内置 SQLite 数据库保存自己的登录、偏好和操作摘要

在项目根目录的 PowerShell 中运行：

```powershell
npm ci # 按锁定依赖安装
npm test # 运行自动检查，测试不连接真实桌面
npm run build # 构建网页与网关
New-Item -ItemType Directory -Path .local/runtime -Force | Out-Null # 创建本机运行目录
if (-not (Test-Path .local/runtime/config.json)) { Copy-Item config.example.json .local/runtime/config.json } # 首次创建本机配置
.\scripts\Start.ps1 # 以当前用户后台启动
```

打开 `http://localhost:3000`，本机模式依赖环回地址限制，远程部署需要按 [部署说明](docs/DEPLOYMENT.md) 启用正式身份验证

常用命令：

```powershell
.\scripts\Diagnose.ps1 # 查看模式、进程和桌面连接
.\scripts\Stop.ps1 # 停止网页网关，桌面任务继续执行
.\scripts\Register-Startup.ps1 # 注册当前用户登录后启动
.\scripts\Register-Startup.ps1 -Remove # 取消登录启动
```

开发时分别运行 `npm run dev` 和 `npm run dev:ui`，打开 `http://localhost:5173`，开发数据保存在 `.local/dev`

## 3 使用边界

网页发送消息会继续原会话，停止和审批绑定具体会话与轮次

数字格式的 `26.x` 版本会尝试现有的会话、模型设置和请求回应接口；连接显示正常不代表所有写操作都已在该版本验证

工作台可以启动网关电脑上的 Codex CLI。选择项目或项目中的会话后，终端使用对应项目目录；未选项目时使用网关电脑的用户目录。需要预先在网关电脑安装并登录 Codex CLI

CLI 的终端连接断开或网关停止时，当前 CLI 进程会结束。远程使用前应启用登录保护并配置 HTTPS，已授权的用户可以通过 CLI 发起具有执行或修改文件能力的操作

网关保存操作标识以避免重复执行，提交结果不明确时保留草稿并提示核实，重连不会自动重发消息

浏览器草稿保存在本机浏览器，原始会话记录仍由桌面管理，网关读取 Codex 目录元数据时使用只读连接

权限扩展的批准、复杂工具表单、Codex 远程主机会话和附件上传仍需其他操作入口；聊天中的图片目前提示在桌面端查看。更多限制见 [安全说明](SECURITY.md)

## 4 开发扩展

`src` 保存 React 网页，`server` 保存 Fastify 网关和桌面适配器，`shared` 定义展示数据与软件选择，`tests` 保存自动检查

新增 Agent 从 [适配器约定](ADAPTERS.md) 开始，接入层会按软件隔离查询、操作、实时流、偏好和草稿

```powershell
npm run check # TypeScript 类型检查
npm test # 自动检查
npm run diagrams # 更新可编辑流程图与 SVG 图
npm run check:release # 检查公开源文件和已跟踪文件的发布边界
npm run package:source # 导出经过检查的独立源码目录和 ZIP
```

源码导出按 `release-files.json` 的允许清单生成，运行配置、凭据、数据库和现场截图保存在忽略目录，发布步骤见 [开源发布说明](docs/RELEASING.md)

## 5 许可证

项目自身源代码采用 [MIT](LICENSE)，依赖保留各自的许可证，直接依赖信息见 [依赖说明](docs/DEPENDENCIES.md)

Codex、DSH、Claude Code 和相关产品名称属于各自权利人，本项目由独立贡献者维护
