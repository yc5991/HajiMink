# 开源发布

## 1 发布内容

`release-files.json` 声明源码允许清单，导出包含实现、测试、配置示例、流程图、CI 配置和 MIT 许可证

`.local`、`output`、数据库、凭据、日志、安装包和编译结果属于部署或构建数据，源码导出会排除这些内容

公开文档使用示例域名和相对路径，自己的线上配置、会话标识与项目截图保存在本机

`package.json` 中的 `private: true` 用于阻止意外发布到 npm，不影响在 GitHub 公开源代码

## 2 生成发布副本

在项目根目录依次执行：

```powershell
npm ci # 安装锁定依赖
npm run check:release # 检查允许清单、常见敏感模式及已跟踪文件
npm test # 运行自动检查
npm run check # 检查类型
npm run build:desktop:fixture # 在隔离目录验证网页和网关构建
npm run diagrams # 根据结构定义更新流程图
npm run package:source # 导出独立源码目录、ZIP 与校验文件
```

导出位置为 `output/opensource`，命令输出实际目录、压缩包路径、文件数量和 `SHA-256` 校验值

每次生成新的目录，运行文件不会随发布副本一起复制。导出时逐文件比对工作区、导出副本和 ZIP 的 SHA-256；图片、新资料和许可证仍应由维护者检查

## 3 GitHub 首次上传

建议从导出的独立源码目录建立仓库，先核对文件清单，再创建首个提交：

```powershell
git init # 在导出的源码目录建立本地仓库
git add . # 按公开目录暂存源文件
git diff --cached --stat # 审阅将要提交的文件
git status --short # 核对暂存内容
git commit -m "Initial open-source release" # 创建首个本地提交
```

在 GitHub 创建仓库后，使用该仓库页面提供的远程地址推送，公开范围和发布内容由维护者确认

仓库描述可使用：Private web gateway for existing desktop Agent sessions

建议主题标签为 `codex`、`ai-agent`、`desktop`、`self-hosted` 和 `typescript`，DSH 真实接入前应保留准备状态说明

## 4 自动检查

根据 `.github/workflows/ci.yml`，GitHub Actions 使用 Windows 运行环境和 Node.js 24.19.0，工作流在桌面测试之前从干净依赖安装构建解包程序，并运行发布检查、测试及构建

Actions 的读取权限与固定版本引用保存在 `.github/workflows/ci.yml`，真实桌面和部署凭据不进入 CI

Windows 桌面包生成 `SHA256SUMS.txt`，发布前应把校验文件与 ZIP 一起审阅。当前包未签名，校验值只能确认文件完整性，不能代替代码签名和来源验证。可运行 `npm run check:desktop-release -- <解包目录>`，检查实际打包的应用、网关和依赖目录；可通过环境变量 `HAJIMINK_RELEASE_PRIVATE_MARKERS` 提供 JSON 字符串数组，让源码和桌面包检查同时排查本机特有标记。检查只报告位置，不打印匹配内容

远端 CI 结果以首次推送后的 Actions 记录为准，本地检查不能替代远端运行记录

## 5 检查边界

发布检查能够发现允许清单中的运行文件、常见凭据模式、非示例邮箱、符号链接和已跟踪的越界文件

规则检查不能覆盖所有私人信息，发布者还需要审阅图片、文档、新增文件及历史提交

首次发布前应确认 README 所列兼容版本、DSH 状态、未验证项目与实际实现一致，并核对商标和所有依赖的再分发许可。使用者已反馈其环境下公网访问成功，其他隧道、实体认证器、安装升级和全新系统验收不能由隐私扫描代替
