import type { Page } from '@playwright/test';

/**
 * The browser logs every non-2xx fetch as a console error. The UI handles
 * those (a 409 opens the confirmation, a 400 is shown verbatim), so they don't
 * count. Anything else does: CSP violations, uncaught errors, React warnings.
 */
const HANDLED = /^Failed to load resource: the server responded with a status of 4\d\d/;

/** Collects console errors and page errors; a spec fails if any are left at the end. */
export function watchConsole(page: Page): string[] {
  const errors: string[] = [];
  page.on('console', (m) => {
    if (m.type() === 'error' && !HANDLED.test(m.text())) errors.push(m.text());
  });
  page.on('pageerror', (e) => errors.push(e.message));
  return errors;
}
