/**
 * Hash-based routing for Skyline's top-level views.
 *
 * Hash routing keeps every view reachable from a static Cloudflare Pages
 * deployment with no redirect configuration (`#/sky`, `#/events`, …), and it
 * degrades gracefully: an unknown hash returns to the home view.
 */
import type { Route } from '../state/store';

export const ROUTES: Array<{ id: Route; path: string; label: string }> = [
  { id: 'home', path: '#/', label: 'Home' },
  { id: 'explorer', path: '#/explorer', label: 'Explorer' },
  { id: 'sky', path: '#/sky', label: 'Sky & Passes' },
  { id: 'weather', path: '#/weather', label: 'Space Weather' },
  { id: 'events', path: '#/events', label: 'Debris Events' },
  { id: 'about', path: '#/about', label: 'How It Works' },
];

export function routeFromHash(hash: string): Route {
  const clean = hash.replace(/^#/, '').split('?')[0].replace(/\/+$/, '');
  switch (clean) {
    case '':
    case '/':
      return 'home';
    case '/explorer':
      return 'explorer';
    case '/sky':
      return 'sky';
    case '/weather':
      return 'weather';
    case '/events':
      return 'events';
    case '/about':
      return 'about';
    default:
      return 'home';
  }
}

export function hashForRoute(route: Route): string {
  const found = ROUTES.find((r) => r.id === route);
  return found ? found.path : '#/';
}

export function navigate(route: Route): void {
  const hash = hashForRoute(route);
  if (window.location.hash !== hash) window.location.hash = hash;
}
