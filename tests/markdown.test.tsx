import { renderToStaticMarkup } from 'react-dom/server';
import { it, expect } from 'vitest';
import { Markdown } from '../src/App';

it('renders code while filtering active Markdown content and remote tracking images', () => {
  const html = renderToStaticMarkup(<Markdown text={'<script>alert(1)</script>\n\n[x](javascript:alert(2))\n\n![secret](https://tracker.example/pixel)\n\n```js\nconst safe = 1;\n```\n\n[文档](https://example.com)'}/>);
  expect(html).not.toContain('<script>');
  expect(html).not.toContain('href="javascript:');
  expect(html).not.toContain('<img');
  expect(html).not.toContain('tracker.example');
  expect(html).toContain('<code class="language-js">');
  expect(html).toContain('rel="noopener noreferrer"');
});
