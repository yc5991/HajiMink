import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { diagrams } from './diagram-data.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const directory = path.join(root, 'docs', 'diagrams'); fs.mkdirSync(directory, { recursive: true });
const escape = value => String(value).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;');
for (const graph of diagrams) {
  const parts = [`<svg xmlns="http://www.w3.org/2000/svg" width="${graph.width}" height="${graph.height}" viewBox="0 0 ${graph.width} ${graph.height}" role="img" aria-labelledby="title desc"><title id="title">${escape(graph.title)}</title><desc id="desc">${escape(graph.subtitle)}</desc><defs><marker id="arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="8" markerHeight="8" orient="auto-start-reverse"><path d="M0 0L10 5L0 10z" fill="#64748b"/></marker></defs><style>text{font-family:'Microsoft YaHei','PingFang SC','Noto Sans CJK SC',sans-serif;fill:#172554} .edge{fill:none;stroke:#64748b;stroke-width:2} .label{font-size:16px;paint-order:stroke;stroke:white;stroke-width:8;stroke-linejoin:round}</style><rect width="100%" height="100%" fill="#ffffff"/><text x="32" y="32" font-size="26" font-weight="700">${escape(graph.title)}</text><text x="32" y="55" font-size="15" fill="#475569">${escape(graph.subtitle)}</text>`];
  for (const g of graph.groups || []) parts.push(`<rect x="${g.x}" y="${g.y}" width="${g.w}" height="${g.h}" rx="20" fill="#f8fafc" stroke="#cbd5e1" stroke-dasharray="6 5"/><text x="${g.x + 18}" y="${g.y + 24}" font-size="15">${escape(g.label)}</text>`);
  for (const edge of graph.edges) parts.push(`<path class="edge" d="${edge.d}" marker-end="url(#arrow)"${edge.both ? ' marker-start="url(#arrow)"' : ''}${edge.dashed ? ' stroke-dasharray="7 5"' : ''}/>`);
  for (const node of graph.nodes) {
    const fill = node.status === 'planned' ? '#fffbeb' : node.status === 'implemented' ? '#f0fdf4' : node.kind === 'data' ? '#f1f5f9' : '#eff6ff';
    const stroke = node.status === 'planned' ? '#d97706' : node.status === 'implemented' ? '#16a34a' : '#2563eb';
    const common = `fill="${fill}" stroke="${stroke}" stroke-width="2"${node.status === 'planned' ? ' stroke-dasharray="7 5"' : ''}`;
    const cx = node.x + node.w / 2; const cy = node.y + node.h / 2;
    parts.push(node.kind === 'decision' ? `<polygon points="${cx},${node.y} ${node.x + node.w},${cy} ${cx},${node.y + node.h} ${node.x},${cy}" ${common}/>` : `<rect x="${node.x}" y="${node.y}" width="${node.w}" height="${node.h}" rx="14" ${common}/>`);
    const first = cy - (node.lines.length - 1) * 13 + 6;
    parts.push(`<text x="${cx}" y="${first}" text-anchor="middle" font-size="18">${node.lines.map((line, index) => `<tspan x="${cx}" dy="${index ? 26 : 0}"${index === 0 ? ' font-weight="600"' : ''}>${escape(line)}</tspan>`).join('')}</text>`);
  }
  for (const edge of graph.edges) if (edge.label) parts.push(`<text class="label" x="${edge.lx}" y="${edge.ly}" text-anchor="middle">${escape(edge.label)}</text>`);
  const legend = graph.id === 'architecture' ? '实线：已实现的连接　　虚线：预留接入　　远程服务商和真实设备仍需分别验收' : graph.id === 'task-flow' ? '此图展示消息路径；停止和设置分别转交原桌面的对应动作' : '本机模式用于环回访问；正式部署选择 owner 或 access';
  parts.push(`<text x="32" y="${graph.height - 18}" font-size="14">${legend}</text></svg>`);
  fs.writeFileSync(path.join(directory, `${graph.id}.svg`), parts.join('\n') + '\n');
  const mermaid = ['flowchart TD', ...graph.nodes.map(node => `  ${node.id}${node.kind === 'decision' ? '{' : '['}"${node.lines.map(escape).join('<br/>')}"${node.kind === 'decision' ? '}' : ']'}`), ...graph.edges.map(edge => `  ${edge.from} ${edge.dashed ? '-.->' : edge.both ? '<-->' : '-->'}${edge.label ? `|${edge.label}|` : ''} ${edge.to}`), '  classDef implemented fill:#f0fdf4,stroke:#16a34a,color:#172554', '  classDef planned fill:#fffbeb,stroke:#d97706,stroke-dasharray:7 5,color:#172554', ...graph.nodes.filter(n => n.status).map(n => `  class ${n.id} ${n.status}`)];
  fs.writeFileSync(path.join(directory, `${graph.id}.mmd`), mermaid.join('\n') + '\n');
  console.log(`Rendered ${graph.id}.svg and ${graph.id}.mmd`);
}
