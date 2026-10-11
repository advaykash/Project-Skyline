/**
 * Skyline resilience & accessibility browser checks.
 *
 * Complements the main journey in run.mjs with the failure-mode and keyboard
 * scenarios required for release:
 *   A. keyboard-only selection (Tab, type, ArrowDown, Enter, Escape) + focus
 *      indicators + accessible names for icon-only buttons,
 *   B. Earth-texture failure fallback (app must still start and render),
 *   C. API failure -> honest error state -> working Retry recovery.
 *
 * Usage: CHROME_PATH=/path/to/chromium node tests/e2e/resilience.mjs [baseURL] [outDir]
 */
import { existsSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import puppeteer from 'puppeteer-core';

const BASE_URL = process.argv[2] ?? 'http://127.0.0.1:8788';
const OUT_DIR = process.argv[3] ?? path.resolve('docs/screenshots');

function findChrome() {
  if (process.env.CHROME_PATH && existsSync(process.env.CHROME_PATH)) return process.env.CHROME_PATH;
  const candidates = [
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser',
    '/usr/bin/google-chrome',
    '/usr/bin/google-chrome-stable',
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  ];
  return candidates.find((p) => existsSync(p)) ?? null;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const results = [];
const rec = (n, ok, d = '') => {
  results.push([n, ok]);
  console.log(`${ok ? '✓' : '✗'} ${n}${d ? ' — ' + d : ''}`);
};

async function main() {
  const executablePath = findChrome();
  if (!executablePath) {
    console.error('No Chromium/Chrome binary found. Set CHROME_PATH and retry.');
    process.exit(2);
  }
  mkdirSync(OUT_DIR, { recursive: true });

  const browser = await puppeteer.launch({
    executablePath,
    headless: true,
    args: [
      '--no-sandbox',
      '--disable-dev-shm-usage',
      '--enable-unsafe-swiftshader',
      '--use-gl=angle',
      '--use-angle=swiftshader',
      '--hide-scrollbars',
    ],
  });

  try {
    // ---------- A. Keyboard-only selection ----------
    console.log('\n[A] Keyboard & accessibility');
    {
      const page = await browser.newPage();
      await page.setViewport({ width: 1440, height: 900 });
      const pageErrors = [];
      page.on('pageerror', (e) => pageErrors.push(String(e)));
      await page.goto(`${BASE_URL}#/explorer`, { waitUntil: 'networkidle2', timeout: 60_000 });
      await page.waitForSelector('.result-item', { timeout: 30_000 });

      let focused = false;
      for (let i = 0; i < 12 && !focused; i += 1) {
        await page.keyboard.press('Tab');
        focused = await page.evaluate(() => document.activeElement?.id === 'satellite-search');
      }
      rec('search input reachable by Tab', focused);

      const focusRing = await page.evaluate(() => {
        const style = getComputedStyle(document.activeElement);
        return { outlineWidth: style.outlineWidth, outlineStyle: style.outlineStyle };
      });
      rec(
        'visible focus indicator',
        focusRing.outlineStyle !== 'none' && parseFloat(focusRing.outlineWidth) > 0,
        JSON.stringify(focusRing),
      );

      await page.keyboard.type('NAUKA');
      await sleep(300);
      await page.keyboard.press('ArrowDown');
      await page.keyboard.press('ArrowDown');
      await page.keyboard.press('Enter');
      await sleep(1800);
      const name = await page.$eval('.inspector-name', (el) => el.textContent).catch(() => '');
      rec('ArrowDown + Enter selects from results', /NAUKA/i.test(name ?? ''), name);

      await page.click('#satellite-search');
      await page.keyboard.press('Escape');
      await sleep(300);
      const query = await page.$eval('#satellite-search', (el) => el.value);
      rec('Escape clears search', query === '');

      const unlabeled = await page.evaluate(
        () =>
          [...document.querySelectorAll('button')].filter((b) => !b.textContent.trim() && !b.getAttribute('aria-label'))
            .length,
      );
      rec('every icon-only button has an accessible name', unlabeled === 0, `${unlabeled} unlabeled`);
      rec('no page errors during keyboard flow', pageErrors.length === 0);
      await page.close();
    }

    // ---------- B. Texture failure fallback ----------
    console.log('\n[B] Earth-texture failure fallback');
    {
      const page = await browser.newPage();
      await page.setViewport({ width: 1440, height: 900 });
      const pageErrors = [];
      page.on('pageerror', (e) => pageErrors.push(String(e)));
      await page.setRequestInterception(true);
      page.on('request', (req) => {
        if (req.url().includes('/textures/')) req.abort();
        else req.continue();
      });
      await page.goto(`${BASE_URL}#/explorer`, { waitUntil: 'networkidle2', timeout: 60_000 });
      await page.waitForSelector('.result-item', { timeout: 30_000 });
      await sleep(2500);
      const glOk = await page.evaluate(() => {
        const canvas = document.querySelector('.globe-canvas');
        return Boolean(canvas && canvas.width > 200);
      });
      rec('app still starts and renders with all textures blocked', glOk);
      rec('no uncaught errors on texture failure', pageErrors.length === 0, pageErrors.slice(0, 1).join('|'));
      await page.screenshot({ path: path.join(OUT_DIR, '10-textures-failed.jpg'), type: 'jpeg', quality: 82 });
      await page.close();
    }

    // ---------- C. API failure -> honest error -> Retry recovery ----------
    console.log('\n[C] API failure & recovery');
    {
      const page = await browser.newPage();
      await page.setViewport({ width: 1440, height: 900 });
      let blocked = true;
      await page.setRequestInterception(true);
      page.on('request', (req) => {
        if (blocked && req.url().includes('/api/gp')) {
          req.respond({
            status: 502,
            contentType: 'application/json',
            body: JSON.stringify({
              ok: false,
              error: {
                code: 'upstream-failure',
                message: 'CelesTrak is unreachable and no offline data is available for group.',
                hint: 'No records were invented.',
              },
            }),
          });
        } else {
          req.continue();
        }
      });
      await page.goto(`${BASE_URL}#/explorer`, { waitUntil: 'networkidle2', timeout: 60_000 });
      await page.waitForSelector('.banner-error', { timeout: 20_000 });
      const errText = await page.$eval('.banner-error', (el) => el.textContent);
      rec('honest error banner shown on API failure', /unreachable|unavailable/i.test(errText ?? ''), (errText ?? '').slice(0, 70));
      rec('error message never fabricates data', /no records were invented/i.test(errText ?? ''));

      blocked = false;
      await page.evaluate(() => {
        const btn = [...document.querySelectorAll('.banner-error button')].find((b) => /retry/i.test(b.textContent));
        btn?.click();
      });
      await page.waitForSelector('.result-item', { timeout: 20_000 });
      const rows = await page.$$eval('.result-item', (els) => els.length);
      rec('Retry recovers the catalogue', rows > 0, `${rows} rows`);
      await page.screenshot({ path: path.join(OUT_DIR, '11-api-recovered.jpg'), type: 'jpeg', quality: 82 });
      await page.close();
    }
  } finally {
    await browser.close();
  }

  const failed = results.filter(([, ok]) => !ok);
  console.log(`\n=== ${results.length - failed.length}/${results.length} resilience checks passed ===`);
  if (failed.length > 0) process.exitCode = 1;
}

main().catch((err) => {
  console.error('resilience run failed:', err);
  process.exit(1);
});
