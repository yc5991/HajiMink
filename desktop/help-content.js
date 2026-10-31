'use strict';

// This bundled, static document is shared by the desktop shell and web client.
window.HajiminkHelp = `
  <nav class="help-index" aria-label="文档目录">
    <a href="#help-local">本机网关</a><a href="#help-remote">远程访问</a><a href="#help-auth">登录方式</a><a href="#help-tunnels">隧道服务</a><a href="#help-check">连接与排查</a><a href="#help-exit">退出与恢复</a>
  </nav>
  <section id="help-local" class="help-section">
    <h2>本机网关</h2>
    <ol>
      <li>在桌面端打开“设置 → 网关”，选择 1024 至 65535 之间未被占用的端口，保存后启用网关。</li>
      <li>只在本机使用时无需选择远程连接方式。启动 Codex 桌面后，返回工作台检查连接状态。</li>
      <li>更改运行中网关的端口会重启网关，连接的 CLI 终端和 HajiMink 管理的 NATAPP 会停止；Codex 桌面会话任务不会因此停止。已有隧道需要同步更改目标端口。</li>
    </ol>
    <p>本机模式没有远程登录保护。不要将其通过隧道或端口映射直接开放到公网。</p>
    <p>桌面端只管理自己启动的网关及 NATAPP 客户端。端口被其他程序占用时不会结束或接管未知进程。</p>
  </section>
  <section id="help-remote" class="help-section">
    <h2>配置远程访问</h2>
    <ol>
      <li>先关闭所有指向本机模式网关的隧道和端口映射。启动本机网关，选择密码或通行密钥，准备独立登录保护。</li>
      <li>准备自己的 HTTPS 访问地址和隧道，将隧道目标指向网关所在电脑的 <code>127.0.0.1</code> 与网关设置中显示的端口。确保转发支持 WebSocket，并保留外部访问域名。</li>
      <li>在“远程访问”选择连接方式、填写最终访问地址，按所选登录方式完成设置。只有独立登录已启用，或网关已进入受设置码限制的首次设置状态后，才开启转发。</li>
      <li>完成服务商配置后检查远程入口，再用自己的浏览器访问最终地址并亲自登录。检查结果不能证明服务器归属或持续连接正常。</li>
    </ol>
    <p>有些服务商要先启动隧道才显示地址。此时可在网关页展开“还没有访问地址？”并选择“先保护网关”，确认网关进入受限状态后启动隧道；取得真实地址后，再填写并保存或生成设置码。</p>
    <p>远程地址需要可信 HTTPS 证书。未填写协议时默认使用 HTTPS；地址不能包含账号、路径、查询参数或片段。本机 HTTP 只允许 <code>localhost</code> 或 <code>127.0.0.1</code>。</p>
  </section>
  <section id="help-auth" class="help-section">
    <h2>密码与通行密钥</h2>
    <h3>使用密码</h3>
    <ol>
      <li>在网关页选择连接方式和“密码”，打开账户页面设置至少 12 个字符的密码。此时本机模式仍不要求密码，不能对外开放。</li>
      <li>回到网关页，填写最终 HTTPS 地址并选择“启用登录”。密码方式支持有可信证书的域名或服务器 IP，证书必须覆盖实际访问地址。</li>
    </ol>
    <h3>使用通行密钥</h3>
    <ol>
      <li>填写最终 HTTPS 域名，选择“通行密钥”并设置。设置码有效 10 分钟，只能使用一次，请勿分享。</li>
      <li>网关进入受限首次设置后，开启已准备好的隧道。在浏览器中核对最终地址，手动输入设置码，再创建通行密钥；也可以在该页面选择密码。</li>
      <li>通行密钥与域名绑定，更换域名后可能需要重新注册。使用服务器 IP 时请选择密码。</li>
    </ol>
    <p>设置码过期、使用后或窗口关闭后，可在本机重新生成。设置完成前，工作台内容保持锁定。</p>
    <p>授权其他桌面设备时，仅批准自己认识的设备，核对两端显示的确认码；可在账户页面撤销授权。Cloudflare Access 等外部登录跳转需要使用系统浏览器。</p>
  </section>
  <section id="help-tunnels" class="help-section">
    <h2>隧道服务</h2>
    <p>HajiMink 不会替你创建服务商隧道或证书。各服务商的可用域名、HTTPS、节点和费用以其实际方案为准。</p>
    <h3>NATAPP</h3>
    <p>创建支持网页和 WebSocket 的隧道，目标填写本机网关的地址和端口，并确认 HTTPS 可用。桌面端可管理你自行选择的官方 <code>natapp.exe</code> 和已配置的 <code>.ini</code> 文件；配置可能包含令牌，请自行保管。HajiMink 不读取或修改其内容。</p>
    <p>受管理客户端在后台运行，不显示客户端窗口；访问地址需从 NATAPP 获取。若只能从客户端窗口查看地址，请先停止 HajiMink 启动的客户端，再自行打开。已有 NATAPP 进程不会被自动接管。</p>
    <p><a data-help-provider="natapp" href="https://natapp.cn/article/natapp_newbie" target="_blank" rel="noopener noreferrer">NATAPP 官方教程</a> · <a data-help-provider="natapp-config" href="https://natapp.cn/article/config_ini" target="_blank" rel="noopener noreferrer">配置文件教程</a></p>
    <h3>SakuraFrp</h3>
    <p>按官方 Web 应用教程选择可用节点和隧道，准备 HTTPS 域名与证书。本地服务为 HTTP，目标是网关所在电脑的 <code>127.0.0.1</code> 和网关端口；访问密钥留在官方客户端。</p>
    <p><a data-help-provider="sakurafrp" href="https://doc.natfrp.com/app/http.html" target="_blank" rel="noopener noreferrer">SakuraFrp 官方教程</a></p>
    <h3>Tailscale</h3>
    <p>在网关电脑安装并登录 Tailscale。Serve 仅供 Tailscale 网络内访问；Funnel 可向公网开放。先保护网关，再将所选方式的目标指向本机网关。</p>
    <p><a data-help-provider="tailscale-serve" href="https://tailscale.com/kb/1242/tailscale-serve" target="_blank" rel="noopener noreferrer">Tailscale Serve 教程</a> · <a data-help-provider="tailscale" href="https://tailscale.com/docs/features/tailscale-funnel" target="_blank" rel="noopener noreferrer">Tailscale Funnel 教程</a></p>
    <h3>Cloudflare Tunnel</h3>
    <p>在 Cloudflare 配置 Tunnel、自己的域名及访问策略，保护网关后在本机运行连接器，将服务目标指向本机网关。核对最终 HTTPS 地址和转发的外部域名。</p>
    <p><a data-help-provider="cloudflare" href="https://developers.cloudflare.com/cloudflare-one/networks/connectors/cloudflare-tunnel/get-started/" target="_blank" rel="noopener noreferrer">Cloudflare Tunnel 官方教程</a></p>
    <h3>自建服务器</h3>
    <p>准备自己的服务器、可信 HTTPS 证书和安全中转。在网关电脑建立到服务器的隧道，最终目标是网关电脑上的 <code>127.0.0.1</code> 和网关端口。服务器上的 <code>127.0.0.1</code> 指服务器本身，不是网关电脑。单独填写服务器 IP 或 URL 不会自动创建隧道。</p>
  </section>
  <section id="help-check" class="help-section">
    <h2>连接与排查</h2>
    <p>在“设置 → 连接”添加已有网关，填写名称以及自己的 HTTPS 地址或服务器 IP。服务商选择只用于记录和提示，不会创建隧道。远程设备授权需要网关支持独立登录与设备授权。</p>
    <p>网关页可检测输入的地址，不发送登录凭据，也不会跟随跳转。未保存地址仅检查入口响应，不能确认它属于本机网关或已受保护。已保存的独立登录地址还会比对本机响应、部分未登录接口，并尝试一次实时连接；检查结果不代表隧道进程的实时状态。</p>
    <p>本机网关未连接时，检查网关是否启动及端口是否被占用；远程连接失败时，检查地址、证书、隧道和网络；网关正常但 Codex 未连接时，在网关电脑打开 Codex 桌面并重试。</p>
    <p>“设置 → 日志”显示网关、Codex 桌面和远程入口状态，运行日志仅包含本次桌面运行期间的网关启停事件，不包含网关原始输出或聊天内容。删除连接只删除本机连接信息，不删除远程项目与会话。</p>
  </section>
  <section id="help-exit" class="help-section">
    <h2>退出与恢复</h2>
    <p>关闭窗口通常会收起到托盘；Linux 或托盘不可用时会最小化。选择“退出软件”时，会先确认受 HajiMink 管理的本机网关和 NATAPP。退出会断开工作台中的 CLI 终端，但不会停止 Codex 桌面会话的任务。</p>
    <p>下次打开时尝试恢复退出前受管理且正在运行的服务；手动停止的服务保持停止。其他服务商的客户端由你自行管理。</p>
  </section>
`;
