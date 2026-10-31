import { useEffect, useLayoutEffect, useState, type FormEvent } from 'react';
import { ArrowLeft, ArrowUpRight, Check, Command, Eye, EyeOff, Fingerprint, KeyRound, LoaderCircle, LogOut } from 'lucide-react';
import { browserSupportsWebAuthn, startAuthentication, startRegistration } from '@simplewebauthn/browser';
import { App } from './App';
import { AuthorizedDevices, DeviceAuthorization } from './Device';
import { api, initializeAuthSession } from './api';
import { useAppViewport, useMedia } from './mobile';
import { applyTheme } from './theme';
import { Help } from './Help';

type AuthState = { mode: 'local' | 'access' | 'owner'; configured: boolean; authenticated: boolean; accountType?: 'owner' | 'device' | null; passwordEnabled: boolean; passkeyCount: number; setupPending?: boolean; setupCodeAvailable?: boolean; setupSession?: boolean };
function canUsePasskey() {
  const hostname = location.hostname;
  const isIp = /^(?:\d{1,3}\.){3}\d{1,3}$/.test(hostname) || hostname.startsWith('[');
  return !isIp && window.isSecureContext && browserSupportsWebAuthn();
}
function passkeyError(error: unknown) {
  const name = (error as Error)?.name;
  if (name === 'SecurityError') return '请使用本站正式域名或 localhost，并在支持通行密钥的浏览器中操作';
  if (name === 'InvalidStateError') return '这个设备可能已添加过通行密钥，可以直接尝试登录';
  return ['NotAllowedError', 'AbortError'].includes(name) ? '操作已取消，你也可以使用密码' : (error as Error)?.message || '设备未完成通行密钥验证';
}
function PasswordField({ label, value, onChange, fresh = false }: { label: string; value: string; onChange: (value: string) => void; fresh?: boolean }) {
  const [visible, setVisible] = useState(false);
  return <label className="auth-field"><span>{label}</span><div><input aria-label={label} type={visible ? 'text' : 'password'} autoComplete={fresh ? 'new-password' : 'current-password'} value={value} minLength={fresh ? 12 : 1} maxLength={1024} required onChange={event => onChange(event.target.value)}/><button type="button" aria-label={visible ? `隐藏${label}` : `显示${label}`} onClick={() => setVisible(current => !current)}>{visible ? <EyeOff size={19}/> : <Eye size={19}/>}</button></div></label>;
}
function FirstSetup({ state, refresh }: { state: AuthState; refresh: () => Promise<void> }) {
  const [code, setCode] = useState(''); const [password, setPassword] = useState(''); const [confirm, setConfirm] = useState('');
  const [method, setMethod] = useState<'passkey' | 'password'>(() => canUsePasskey() ? 'passkey' : 'password'); const [busy, setBusy] = useState(''); const [error, setError] = useState('');
  const finish = () => { setCode(''); setPassword(''); setConfirm(''); window.location.replace('/'); };
  const exchange = async (event: FormEvent) => {
    event.preventDefault(); if (busy) return; setBusy('code'); setError('');
    try { await initializeAuthSession(); await api('/api/auth/setup/exchange', { code: code.trim() }); setCode(''); await refresh(); }
    catch (error) { setError((error as Error).message); } finally { setBusy(''); }
  };
  const register = async () => {
    if (busy) return; setBusy('passkey'); setError('');
    try { await initializeAuthSession(); const result = await api('/api/auth/setup/options', {}); const credential = await startRegistration({ optionsJSON: result.options }); await api('/api/auth/setup/verify', { challengeId: result.challengeId, credential }); finish(); }
    catch (error) { setError(passkeyError(error)); } finally { setBusy(''); }
  };
  const savePassword = async (event: FormEvent) => {
    event.preventDefault(); if (busy) return;
    if (password !== confirm) { setError('两次输入的密码不一致'); return; }
    setBusy('password'); setError('');
    try { await initializeAuthSession(); await api('/api/auth/setup/password', { password }); finish(); }
    catch (error) { setError((error as Error).message); } finally { setBusy(''); }
  };
  return <main className="auth-screen"><a className="auth-brand" href="/"><Command size={24}/><span>HajiMink</span></a><section className="auth-card"><div className="auth-heading"><h1>首次设置登录方式</h1><p>在你的正式访问地址完成设置</p></div>
    {error && <p className="auth-error" role="alert">{error}</p>}
    {!state.setupSession && state.setupCodeAvailable && <form onSubmit={event => void exchange(event)}><label className="auth-field"><span>本机一次性设置码</span><div><input aria-label="本机一次性设置码" type="password" value={code} autoComplete="off" autoCapitalize="none" spellCheck={false} maxLength={43} required onChange={event => setCode(event.target.value)}/></div></label><button className="auth-primary" disabled={!!busy || code.trim().length !== 43}>{busy === 'code' ? <LoaderCircle className="spin" size={19}/> : null}验证设置码</button><p className="auth-help">设置码显示在你的 HajiMink 本机网关页面，仅能使用一次，请勿分享。</p></form>}
    {!state.setupSession && !state.setupCodeAvailable && <p className="auth-help">设置码已使用或过期，请返回本机网关页面重新生成。</p>}
    {state.setupSession && method === 'passkey' && <><button className="auth-passkey" disabled={!!busy || !canUsePasskey()} onClick={() => void register()}>{busy === 'passkey' ? <LoaderCircle className="spin" size={21}/> : <Fingerprint size={22}/>}创建通行密钥</button>{!canUsePasskey() && <p className="auth-help">此设备或地址不支持通行密钥，请使用 HTTPS 域名，或选择密码。</p>}<button className="auth-reauth" type="button" disabled={!!busy} onClick={() => { setError(''); setMethod('password'); }}>改用密码设置</button></>}
    {state.setupSession && method === 'password' && <form onSubmit={event => void savePassword(event)}><PasswordField label="新密码" value={password} onChange={setPassword} fresh/><PasswordField label="确认新密码" value={confirm} onChange={setConfirm} fresh/><button className="auth-primary" disabled={!!busy || password.length < 12 || !confirm}>{busy === 'password' ? <LoaderCircle className="spin" size={19}/> : null}设置密码并登录</button>{canUsePasskey() && <button className="auth-reauth" type="button" disabled={!!busy} onClick={() => { setError(''); setPassword(''); setConfirm(''); setMethod('passkey'); }}>返回通行密钥设置</button>}</form>}
  <a className="auth-reauth" href="/help">文档</a></section></main>;
}
function Login({ state }: { state: AuthState }) {
  const [password, setPassword] = useState(''); const [remember, setRemember] = useState(false); const [busy, setBusy] = useState(''); const [error, setError] = useState('');
  const finish = () => { setPassword(''); const next = new URLSearchParams(location.search).get('next'); const destination = next === 'account' || next === 'device' ? `/${next}` : ['/account', '/device'].includes(location.pathname) ? location.pathname : '/'; window.location.replace(destination); };
  const loginPassword = async (event: FormEvent) => {
    event.preventDefault(); if (busy) return; setBusy('password'); setError('');
    try { await initializeAuthSession(); await api('/api/auth/password/login', { password, remember }); finish(); } catch (error) { setError((error as Error).message); } finally { setBusy(''); }
  };
  const loginPasskey = async () => {
    if (busy) return; setBusy('passkey'); setError('');
    try { await initializeAuthSession(); const result = await api('/api/auth/passkey/options', {}); const credential = await startAuthentication({ optionsJSON: result.options }); await api('/api/auth/passkey/login', { challengeId: result.challengeId, credential, remember }); finish(); } catch (error) { setError(passkeyError(error)); } finally { setBusy(''); }
  };
  return <main className="auth-screen"><a className="auth-brand" href="/"><Command size={24}/><span>HajiMink</span></a><section className="auth-card"><div className="auth-heading"><h1>登录你的工作台</h1></div>
    {error && <p className="auth-error" role="alert">{error}</p>}
    {state.passkeyCount > 0 && <button className="auth-passkey" disabled={!!busy || !canUsePasskey()} onClick={() => void loginPasskey()}>{busy === 'passkey' ? <LoaderCircle className="spin" size={21}/> : <Fingerprint size={22}/>}使用通行密钥</button>}
    {state.passkeyCount > 0 && state.passwordEnabled && <div className="auth-divider"><span>或使用密码</span></div>}
    {state.passwordEnabled && <form onSubmit={event => void loginPassword(event)}><input className="sr-only" name="username" autoComplete="username" value="owner" readOnly tabIndex={-1}/><PasswordField label="密码" value={password} onChange={setPassword}/><button className="auth-primary" disabled={!!busy || !password}>{busy === 'password' ? <LoaderCircle className="spin" size={19}/> : null}登录</button></form>}
    {!state.configured && <p className="auth-help">尚未设置本站登录，请先由本机所有者完成初始化</p>}
    <label className="auth-remember"><input type="checkbox" checked={remember} onChange={event => setRemember(event.target.checked)}/>在这台设备上保持登录 7 天</label>
    <a className="auth-reauth" href="/help">文档</a>
  </section></main>;
}
function Account({ state, refresh }: { state: AuthState; refresh: () => Promise<void> }) {
  const [password, setPassword] = useState(''); const [confirm, setConfirm] = useState(''); const [busy, setBusy] = useState(''); const [error, setError] = useState(''); const [message, setMessage] = useState('');
  const savePassword = async (event: FormEvent) => {
    event.preventDefault(); if (busy) return; if (password !== confirm) { setError('两次输入的密码不一致'); return; } setBusy('password'); setError(''); setMessage('');
    try { await initializeAuthSession(); await api('/api/auth/password', { password }); setPassword(''); setConfirm(''); await refresh(); setMessage('密码已保存，其他设备上的本站登录已退出'); } catch (error) { setError((error as Error).message); } finally { setBusy(''); }
  };
  const addPasskey = async () => {
    if (busy) return; setBusy('passkey'); setError(''); setMessage('');
    try { await initializeAuthSession(); const result = await api('/api/auth/register/options', {}); const credential = await startRegistration({ optionsJSON: result.options }); await api('/api/auth/register/verify', { challengeId: result.challengeId, credential }); await refresh(); setMessage('通行密钥已添加'); } catch (error) { setError(passkeyError(error)); } finally { setBusy(''); }
  };
  const logout = async (all = false) => { if (busy || (all && !window.confirm('退出本站的所有登录设备？Codex 中的任务会继续运行。'))) return; setBusy('logout'); try { await api(all ? '/api/auth/logout-all' : '/api/auth/logout', {}); window.location.replace('/login'); } catch (error) { setError((error as Error).message); setBusy(''); } };
  if (state.mode === 'owner' && state.accountType === 'device') return <main className="auth-screen account-screen"><header className="account-header"><a href="/" aria-label="返回工作台"><ArrowLeft size={22}/></a><strong>设备连接</strong></header><div className="account-content"><h1>桌面设备已连接</h1><p className="account-intro">这个设备可以使用工作台，但不能管理所有者的登录方式或其他设备。</p>{error && <p className="auth-error" role="alert">{error}</p>}<section className="account-section account-actions"><button onClick={() => void logout()} disabled={!!busy}><LogOut size={17}/>退出当前设备</button></section></div></main>;
  return <main className="auth-screen account-screen"><header className="account-header"><a href="/" aria-label="返回工作台"><ArrowLeft size={22}/></a><strong>登录与账户</strong></header><div className="account-content"><h1>{state.configured ? '管理登录方式' : '设置本站登录'}</h1>{state.mode === 'local' && <p className="account-intro">本机模式不会要求密码；启用独立登录前请勿公开网关。</p>}
    {error && <p className="auth-error" role="alert">{error}</p>}{message && <p className="auth-success" role="status"><Check size={17}/>{message}</p>}
    <section className="account-section"><div className="account-section-title"><Fingerprint size={24}/><div><h2>通行密钥</h2>{state.passkeyCount > 0 && <p>已添加 {state.passkeyCount} 个通行密钥</p>}</div></div><button className="auth-passkey" disabled={!!busy || !canUsePasskey()} onClick={() => void addPasskey()}>{busy === 'passkey' ? <LoaderCircle className="spin" size={20}/> : <Fingerprint size={21}/>}添加通行密钥</button>{!canUsePasskey() && <p className="auth-help">当前地址或浏览器不能注册通行密钥，请使用最终 HTTPS 域名。</p>}</section>
    <section className="account-section"><div className="account-section-title"><KeyRound size={23}/><div><h2>{state.passwordEnabled ? '更新密码' : '设置密码'}</h2><p>至少 12 个字符，建议使用较长的短语</p></div></div><form onSubmit={event => void savePassword(event)}><input className="sr-only" name="username" autoComplete="username" value="owner" readOnly tabIndex={-1}/><PasswordField label="新密码" value={password} onChange={setPassword} fresh/><PasswordField label="确认新密码" value={confirm} onChange={setConfirm} fresh/><button className="auth-primary" disabled={!!busy || password.length < 12 || !confirm}>{busy === 'password' ? <LoaderCircle className="spin" size={18}/> : null}保存密码</button></form></section>
    {state.mode === 'owner' && state.accountType === 'owner' && <AuthorizedDevices/>}
    {state.mode === 'access' && state.configured && <p className="auth-success"><Check size={17}/>本站登录已准备好，当前入口仍由原 Access 保护</p>}
    {state.mode === 'owner' && <section className="account-section account-actions"><a href="/login?next=account">重新验证身份 <ArrowUpRight size={16}/></a><button onClick={() => void logout()} disabled={!!busy}><LogOut size={17}/>退出当前设备</button><button onClick={() => void logout(true)} disabled={!!busy}>退出所有设备</button></section>}
  </div></main>;
}
export function Root() {
  const systemDark = useMedia('(prefers-color-scheme: dark)');
  useLayoutEffect(() => { try { const theme = localStorage.getItem('ac:theme'); applyTheme(theme && ['light', 'dark', 'system'].includes(theme) ? theme : 'system', systemDark); } catch { applyTheme('system', systemDark); } }, [systemDark]);
  useAppViewport(); const [state, setState] = useState<AuthState | null>(null); const [error, setError] = useState('');
  const refresh = async () => { const value = await initializeAuthSession(); setState(value); };
  useEffect(() => { let disposed = false; void initializeAuthSession().then(value => { if (!disposed) setState(value); }).catch(error => { if (!disposed) setError(error.message); }); const expired = () => { void initializeAuthSession().then(value => { if (!disposed) setState({ ...value, authenticated: false }); }).catch(() => { if (!disposed) setState(current => current ? { ...current, authenticated: false } : current); }); }; window.addEventListener('ac:login-required', expired); return () => { disposed = true; window.removeEventListener('ac:login-required', expired); }; }, []);
  if (location.pathname === '/help') return <Help/>;
  if (!state) return <main className="auth-screen auth-loading"><Command size={30}/>{error ? <><p role="alert">{error}</p><button className="secondary" onClick={() => location.reload()}>重新加载</button></> : <p>正在连接你的工作台…</p>}</main>;
  if (state.mode === 'owner' && !state.authenticated && state.setupPending) return <FirstSetup state={state} refresh={refresh}/>;
  if ((state.mode === 'owner' && !state.authenticated) || location.pathname === '/login') return <Login state={state}/>;
  if (location.pathname === '/device') return <DeviceAuthorization available={state.mode === 'owner'} owner={state.accountType === 'owner'}/>;
  if (location.pathname === '/account') return <Account state={state} refresh={refresh}/>;
  return <App/>;
}
