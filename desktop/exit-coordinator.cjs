'use strict';
// An exit is committed only after owned services are verified and stopped.
class ExitCoordinator {
  constructor({ inspect, confirm, stop, quit, notify = () => {} }) {
    this.inspect = inspect; this.confirm = confirm; this.stop = stop; this.quit = quit; this.notify = notify;
    this.current = { phase: 'idle', message: '' }; this.pending = null;
  }
  snapshot() { return { ...this.current }; }
  get busy() { return ['inspecting', 'confirming', 'stopping', 'quitting'].includes(this.current.phase); }
  set(phase, message = '') { this.current = { phase, message }; try { this.notify(this.snapshot()); } catch {} }
  request() {
    if (this.pending) return this.pending;
    if (this.current.phase === 'quitting') return Promise.resolve({ outcome: 'quitting' });
    this.set('inspecting', '正在检查本机服务');
    this.pending = this.execute().finally(() => { this.pending = null; });
    return this.pending;
  }
  async execute() {
    try {
      const inspected = await this.inspect();
      if (inspected?.error) { this.set('failed', `无法退出：${inspected.error}`); return { outcome: 'failed' }; }
      if (!inspected || !Object.hasOwn(inspected, 'gateway') || !Object.hasOwn(inspected, 'natapp')) throw new Error('invalid service state');
      if (inspected.gateway || inspected.natapp) {
        this.set('confirming', '请确认退出时停止本机服务');
        if (!(await this.confirm(inspected))) { this.set('idle'); return { outcome: 'canceled' }; }
      }
      this.set('stopping', '正在停止本机服务，请稍候');
      const result = await this.stop(inspected);
      if (result?.state !== 'stopped') {
        const detail = typeof result?.message === 'string' && result.message.length <= 200 && !/[\u0000-\u001f\u007f]/.test(result.message) ? result.message : '请检查网关状态后重试';
        this.set('failed', `未能完成停止并退出，桌面程序仍在运行：${detail}`);
        return { outcome: 'failed' };
      }
      this.set('quitting', '正在退出软件');
      try { this.quit(); }
      catch { this.set('failed', '本机服务已停止，但桌面未能退出，请手动退出'); return { outcome: 'failed' }; }
      return { outcome: 'quitting' };
    } catch {
      this.set('failed', '未确认本机服务已停止，桌面程序仍在运行。请检查网关状态后重试');
      return { outcome: 'failed' };
    }
  }
}
function buildTrayTemplate({ busy, showWindow, requestExit }) {
  return [{ label: '打开工作台', click: showWindow }, { type: 'separator' }, { label: '退出软件', enabled: !busy, click: requestExit }];
}
module.exports = { ExitCoordinator, buildTrayTemplate };
