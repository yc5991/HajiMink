import { useEffect, useState, type FormEvent } from 'react';
import { ArrowLeft, Check, Command, LoaderCircle, Monitor, ShieldCheck } from 'lucide-react';
import { api, ApiError } from './api';

type DeviceDetails = { approvalTicket: string; userCode: string; deviceName: string; expiresAt: number };
type DeviceGrant = { id: string; name: string; createdAt: number; expiresAt: number };
type Notice = { message: string; reauthenticate: boolean };

function notice(error: unknown): Notice {
  return { message: error instanceof Error ? error.message : '操作未完成，请稍后重试', reauthenticate: error instanceof ApiError && error.code === 'REAUTHENTICATE' };
}
function displayDate(value: number) {
  return new Date(value).toLocaleString('zh-CN', { year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });
}
function Reauthenticate({ destination }: { destination: 'device' | 'account' }) {
  return <a className="auth-reauth" href={`/login?next=${destination}`}>重新验证所有者身份</a>;
}

export function DeviceAuthorization({ available, owner }: { available: boolean; owner: boolean }) {
  const [code, setCode] = useState('');
  const [details, setDetails] = useState<DeviceDetails | null>(null);
  const [remember, setRemember] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<Notice | null>(null);
  const [result, setResult] = useState<'approved' | 'denied' | null>(null);
  const lookup = async (event: FormEvent) => {
    event.preventDefault();
    if (busy) return;
    setBusy(true); setError(null);
    try { setDetails(await api<DeviceDetails>('/api/auth/device/lookup', { code })); }
    catch (failure) { setError(notice(failure)); }
    finally { setBusy(false); }
  };
  const decide = async (approve: boolean) => {
    if (busy || !details) return;
    setBusy(true); setError(null);
    try {
      await api('/api/auth/device/decide', { approvalTicket: details.approvalTicket, approve, remember: approve && remember });
      setDetails(null); setResult(approve ? 'approved' : 'denied');
    } catch (failure) {
      setError(notice(failure));
      // A lost response may already have consumed the one-time ticket. Never report success.
      if (failure instanceof ApiError && ['NETWORK_UNCONFIRMED', 'DEVICE_APPROVAL_EXPIRED'].includes(failure.code)) setDetails(null);
    } finally { setBusy(false); }
  };
  return <main className="auth-screen"><a className="auth-brand" href="/"><Command size={24}/><span>HajiMink</span></a><section className="auth-card device-card">
    <div className="device-symbol"><ShieldCheck size={27}/></div>
    <div className="auth-heading"><h1>授权桌面设备</h1><p>只允许你认识的设备连接你的私人工作台</p></div>
    {!available ? <p className="auth-error" role="alert">当前网关登录方式暂不支持桌面设备授权。</p> : !owner ? <><p className="auth-error" role="alert">设备账号不能批准其他设备，请使用所有者账号登录。</p><Reauthenticate destination="device"/></> : result ? <div className="device-result" role="status"><Check size={24}/><h2>{result === 'approved' ? '已允许连接' : '已拒绝连接'}</h2><p>{result === 'approved' ? '请返回桌面应用，等待连接完成。' : '这台设备不会获得访问权限。'}</p><button className="auth-passkey" onClick={() => { setResult(null); setCode(''); setRemember(false); }}>处理其他请求</button></div> : <>
      {error && <div className="auth-error" role="alert">{error.message}{error.reauthenticate && <Reauthenticate destination="device"/>}</div>}
      {!details ? <form onSubmit={event => void lookup(event)}><label className="auth-field device-code-field"><span>桌面应用显示的确认码</span><div><input aria-label="确认码" aria-describedby="device-code-help" value={code} onChange={event => setCode(event.target.value.toUpperCase())} placeholder="ABCD-2345" autoComplete="off" autoCapitalize="characters" spellCheck={false} maxLength={20} required/></div></label><p className="auth-help" id="device-code-help">输入桌面应用中的 8 位确认码。不要输入他人发给你的代码。</p><button className="auth-primary" disabled={busy || !code.trim()}>{busy && <LoaderCircle className="spin" size={19}/>}查找设备</button></form> : <>
        <div className="device-summary"><div className="device-summary-heading"><Monitor size={22}/><div><span>请求连接的设备</span><strong>{details.deviceName}</strong></div></div><div className="device-code" aria-label={`确认码 ${details.userCode}`}>{details.userCode}</div><p>请核对桌面应用中显示的确认码是否完全一致。</p><small>请求有效至 {displayDate(details.expiresAt)}</small></div>
        <p className="device-warning">允许后，这台设备可以访问你的工作台和 Agent 会话。只有确认是你自己的设备时才允许。</p>
        <label className="auth-remember"><input type="checkbox" checked={remember} onChange={event => setRemember(event.target.checked)}/>在这台设备上保持登录 7 天</label><p className="auth-help">不勾选时，授权有效期为 8 小时。</p>
        <div className="device-actions"><button className="auth-primary" disabled={busy} onClick={() => void decide(true)}>{busy && <LoaderCircle className="spin" size={19}/>}允许连接</button><button className="auth-passkey" disabled={busy} onClick={() => void decide(false)}>拒绝连接</button></div><button className="device-back" disabled={busy} onClick={() => { setDetails(null); setError(null); }}>返回重新输入</button>
      </>}
    </>}
  </section><footer className="auth-footer"><ShieldCheck size={14}/>正在授权 {location.host}</footer></main>;
}

export function AuthorizedDevices() {
  const [devices, setDevices] = useState<DeviceGrant[] | null>(null);
  const [busy, setBusy] = useState('');
  const [error, setError] = useState<Notice | null>(null);
  const [message, setMessage] = useState('');
  const load = async () => {
    const value = await api<{ devices: DeviceGrant[] }>('/api/auth/device/list');
    setDevices(value.devices); setError(null);
  };
  useEffect(() => { let active = true; void api<{ devices: DeviceGrant[] }>('/api/auth/device/list').then(value => { if (active) setDevices(value.devices); }).catch(failure => { if (active) setError(notice(failure)); }); return () => { active = false; }; }, []);
  const revoke = async (device: DeviceGrant) => {
    if (busy || !window.confirm(`撤销“${device.name}”的连接授权？这台设备将立即退出，但正在运行的 Agent 任务不会被停止。`)) return;
    setBusy(device.id); setError(null); setMessage('');
    try { await api('/api/auth/device/revoke', { id: device.id }); await load(); setMessage(`已撤销“${device.name}”的授权`); }
    catch (failure) { setError(notice(failure)); }
    finally { setBusy(''); }
  };
  return <section className="account-section"><div className="account-section-title"><Monitor size={23}/><div><h2>已授权的桌面设备</h2></div></div>
    {error ? <div className="auth-error" role="alert">{error.message}{error.reauthenticate && <Reauthenticate destination="account"/>}{!error.reauthenticate && <button className="device-back" onClick={() => { setError(null); void load().catch(failure => setError(notice(failure))); }}>重试</button>}</div> : devices === null ? <p className="auth-help" role="status">正在读取设备…</p> : devices.length === 0 ? <p className="auth-help">暂无已授权的桌面设备。</p> : <ul className="device-list">{devices.map(device => <li key={device.id}><div><strong>{device.name}</strong><small>授权于 {displayDate(device.createdAt)}<br/>有效至 {displayDate(device.expiresAt)}</small></div><button disabled={!!busy} aria-label={`撤销 ${device.name} 的授权`} onClick={() => void revoke(device)}>{busy === device.id ? '正在撤销…' : '撤销授权'}</button></li>)}</ul>}
    {message && <p className="auth-success" role="status"><Check size={17}/>{message}</p>}
    <a className="device-manage-link" href="/device">授权新设备 <ArrowLeft size={15}/></a>
  </section>;
}
