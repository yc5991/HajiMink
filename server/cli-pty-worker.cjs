'use strict';
const { spawn } = require('node-pty');
let terminal, exiting = false, stopping = false;
const send = value => { if (process.connected) { try { process.send(value, () => {}); } catch {} } };
function stop() {
  if (stopping) return;
  stopping = true;
  if (terminal && !exiting) { try { terminal.kill(); } catch {} }
  // Give node-pty time to terminate processes attached to this console.
  setTimeout(() => process.exit(0), 5500);
}
process.on('disconnect', stop);
process.on('message', message => {
  if (!message || typeof message !== 'object') return;
  if (message.type === 'start' && !terminal) {
    try {
      terminal = spawn(message.file, message.args, { name: 'xterm-256color', cwd: message.cwd, cols: message.cols, rows: message.rows, env: { ...process.env, TERM: 'xterm-256color' } });
      terminal.onData(data => send({ type: 'output', data }));
      terminal.onExit(result => {
        exiting = true; send({ type: 'exit', code: result.exitCode });
        // The dedicated process releases node-pty's Windows console resources
        // after a normal CLI exit, without signaling a potentially reused PID.
        if (!stopping) setTimeout(() => process.exit(0), 100);
      });
      send({ type: 'started', pid: terminal.pid });
    } catch { send({ type: 'error' }); setTimeout(() => process.exit(1), 100); }
  } else if (message.type === 'input' && terminal && !exiting && !stopping) terminal.write(message.data);
  else if (message.type === 'resize' && terminal && !exiting && !stopping) { try { terminal.resize(message.cols, message.rows); } catch {} }
  else if (message.type === 'stop') stop();
});
