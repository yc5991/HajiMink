import { ArrowLeft } from 'lucide-react';
import '../desktop/help-content.js';
import '../desktop/help.css';

declare global { interface Window { HajiminkHelp: string } }

export function Help() {
  return <main className="help-web"><header className="help-web-header"><a href="/" aria-label="返回工作台" title="返回工作台"><ArrowLeft size={21}/></a><h1>文档</h1></header><article className="help-content" dangerouslySetInnerHTML={{ __html: window.HajiminkHelp }}/></main>;
}
