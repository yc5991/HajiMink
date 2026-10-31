'use strict';
const path = require('node:path');
const { ControllerGatewayManager } = require('../../desktop/controller-manager.cjs');
const root = path.resolve(__dirname, '..', '..');
const manager = new ControllerGatewayManager({ appRoot: path.join(root, '.local', 'hajimink-stage'), dataDir: process.argv[2], port: Number(process.argv[3]), nodePath: process.execPath, runAsNode: false });
manager.start().then(value => {
  manager.close();
  process.stdout.write(`${JSON.stringify(value)}\n`, () => process.exit(value.state === 'ready' ? 0 : 1));
}).catch(() => { manager.close(); process.exit(1); });
