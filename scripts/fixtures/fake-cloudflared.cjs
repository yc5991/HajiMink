'use strict';
const http = require('node:http');
const port = Number(process.argv[process.argv.indexOf('--metrics') + 1].split(':').pop());
const server = http.createServer((request, response) => { if (request.url === '/ready') { response.setHeader('content-type', 'application/json'); response.end(JSON.stringify({ readyConnections: 1 })); } else { response.statusCode = 404; response.end(); } });
server.listen(port, '127.0.0.1');
const stop = () => server.close(() => process.exit(0));
process.on('SIGTERM', stop); process.on('SIGINT', stop);
setInterval(() => {}, 1000);
