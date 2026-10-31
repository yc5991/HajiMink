import { CodexDesktopAdapter } from '../server/desktop-adapter.js';
const adapter = new CodexDesktopAdapter();
try {
  await adapter.start();
  console.log(JSON.stringify({ desktop: adapter.status }, null, 2));
  if (adapter.status.connected) {
    const catalog = await adapter.catalog();
    console.log(JSON.stringify({ projects: catalog.projects.length, threads: catalog.threads.length, models: adapter.models().length }, null, 2));
    const id = process.argv[2];
    if (id) { const view = await adapter.view(id); console.log(JSON.stringify({ id: view.id, live: view.live, turns: view.turns.length, totalTurns: view.totalTurns, requests: view.requests.length, model: view.model, effort: view.effort, status: view.status }, null, 2)); }
  } else process.exitCode = 1;
} finally { adapter.close(); }
