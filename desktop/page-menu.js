'use strict';
const params = new URLSearchParams(location.search);
document.documentElement.dataset.theme = params.get('theme') === 'dark' ? 'dark' : 'light';
document.documentElement.dataset.keyboard = params.get('keyboard') === 'true' ? 'true' : 'false';
window.hajiminkPageMenu.data().then(data => {
  const surface = document.querySelector('.menu-surface');
  const list = document.querySelector('.menu-items');
  if (data.kind === 'connection') {
    surface.setAttribute('aria-label', '选择工作台连接');
    document.querySelector('.menu-heading').textContent = '切换连接';
    const template = list.firstElementChild;
    list.replaceChildren();
    for (const connection of data.items) {
      const button = template.cloneNode(true);
      delete button.dataset.page;
      button.dataset.connection = connection.id;
      const label = connection.local ? `${connection.name} · 本机` : connection.name;
      button.querySelector('span').textContent = label;
      button.title = label;
      list.append(button);
    }
  }
  const items = [...list.querySelectorAll('[role="menuitemradio"]')];
  const valueOf = item => data.kind === 'connection' ? item.dataset.connection : item.dataset.page;
  const selected = items.find(item => valueOf(item) === data.selected);
  selected?.setAttribute('aria-checked', 'true');
  surface.hidden = false;
  if (!items.length) { window.hajiminkPageMenu.close('trigger'); return; }
  const current = selected || items[0];
  current.tabIndex = 0;
  current.focus();

  function focusItem(index) {
    for (const item of items) item.tabIndex = -1;
    const target = items[(index + items.length) % items.length];
    target.tabIndex = 0;
    target.focus();
  }
  for (const item of items) item.addEventListener('click', () => window.hajiminkPageMenu.choose(valueOf(item)));
  document.addEventListener('keydown', event => {
    document.documentElement.dataset.keyboard = 'true';
    const index = Math.max(0, items.indexOf(document.activeElement));
    if (event.key === 'ArrowDown') { event.preventDefault(); focusItem(index + 1); }
    else if (event.key === 'ArrowUp') { event.preventDefault(); focusItem(index - 1); }
    else if (event.key === 'Home') { event.preventDefault(); focusItem(0); }
    else if (event.key === 'End') { event.preventDefault(); focusItem(items.length - 1); }
    else if (event.key === 'Escape') { event.preventDefault(); window.hajiminkPageMenu.close('trigger'); }
    else if (event.key === 'Tab') { event.preventDefault(); window.hajiminkPageMenu.close(event.shiftKey ? 'trigger' : 'next'); }
  });
}).catch(() => window.hajiminkPageMenu.close('trigger'));
