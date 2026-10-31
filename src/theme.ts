export function applyTheme(theme: string, systemDark = window.matchMedia('(prefers-color-scheme: dark)').matches) {
  document.documentElement.dataset.theme = theme;
  const dark = theme === 'dark' || (theme === 'system' && systemDark);
  for (const meta of document.querySelectorAll<HTMLMetaElement>('meta[name="theme-color"]')) meta.content = dark ? '#212121' : '#ffffff';
}
