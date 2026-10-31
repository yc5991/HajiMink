import { useCallback, useEffect, useSyncExternalStore, type RefObject } from 'react';

export function useMobile() {
  return useMedia('(max-width: 1023px)');
}
export function useMedia(query: string) {
  const subscribe = useCallback((listener: () => void) => { const media = window.matchMedia(query); media.addEventListener('change', listener); return () => media.removeEventListener('change', listener); }, [query]);
  return useSyncExternalStore(subscribe, () => window.matchMedia(query).matches);
}
// The visible viewport shrinks when the mobile keyboard opens, even if the layout viewport does not.
export function useAppViewport() {
  useEffect(() => {
    const viewport = window.visualViewport; let frame = 0;
    const update = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        if (viewport && Math.abs(viewport.scale - 1) > .01) return; // Keep pinch zoom available.
        document.documentElement.style.setProperty('--app-height', `${viewport?.height || window.innerHeight}px`);
        document.documentElement.style.setProperty('--app-top', `${viewport?.offsetTop || 0}px`);
        document.documentElement.dataset.keyboard = String(!!viewport && window.innerHeight - viewport.height > 100);
      });
    };
    update(); viewport?.addEventListener('resize', update); viewport?.addEventListener('scroll', update); window.addEventListener('resize', update);
    return () => { cancelAnimationFrame(frame); viewport?.removeEventListener('resize', update); viewport?.removeEventListener('scroll', update); window.removeEventListener('resize', update); document.documentElement.style.removeProperty('--app-height'); document.documentElement.style.removeProperty('--app-top'); delete document.documentElement.dataset.keyboard; };
  }, []);
}
export function useDialog(open: boolean, dialog: RefObject<HTMLElement | null>, background: RefObject<HTMLElement | null>, restore: RefObject<HTMLElement | null>, close: () => void) {
  useEffect(() => {
    if (!open) return;
    const panel = dialog.current; const behind = background.current;
    if (!panel) return;
    const marker = crypto.randomUUID(); let popped = false; let tracked = false;
    try { history.pushState({ ...history.state, acDialog: marker }, ''); tracked = true; } catch {}
    const popstate = () => { if (history.state?.acDialog !== marker) { popped = true; close(); } };
    if (tracked) window.addEventListener('popstate', popstate);
    if (behind) behind.inert = true;
    const focusFrame = requestAnimationFrame(() => (panel.querySelector<HTMLElement>('[data-dialog-close]') || panel).focus({ preventScroll: true }));
    const keydown = (event: KeyboardEvent) => {
      if (event.isComposing) return;
      if (event.key === 'Escape') { event.preventDefault(); close(); }
      if (event.key !== 'Tab') return;
      const elements = [...panel.querySelectorAll<HTMLElement>('button:not([disabled]),a[href],input:not([disabled]),select:not([disabled]),textarea:not([disabled]),[tabindex="0"]')].filter(element => element.getClientRects().length && getComputedStyle(element).visibility !== 'hidden');
      const first = elements[0]; const last = elements.at(-1);
      if (!first) { event.preventDefault(); panel.focus(); return; }
      if (!panel.contains(document.activeElement) || (event.shiftKey && document.activeElement === first)) { event.preventDefault(); (event.shiftKey ? last : first)?.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
    };
    document.addEventListener('keydown', keydown);
    return () => { cancelAnimationFrame(focusFrame); document.removeEventListener('keydown', keydown); window.removeEventListener('popstate', popstate); if (tracked && !popped && history.state?.acDialog === marker) history.back(); if (behind) behind.inert = false; restore.current?.focus({ preventScroll: true }); };
  }, [open, dialog, background, restore, close]);
}
