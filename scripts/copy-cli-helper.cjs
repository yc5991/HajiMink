'use strict';
const fs = require('node:fs');
const path = require('node:path');
const destination = process.argv[2];
if (!destination) throw new Error('Missing build output directory');
fs.copyFileSync(path.join(__dirname, '../server/cli-pty-worker.cjs'), path.join(destination, 'cli-pty-worker.cjs'));
