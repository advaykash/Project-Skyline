/**
 * Skyline end-to-end browser test.
 *
 * Drives the *running application* (Cloudflare Pages runtime via
 * `wrangler pages dev`, or the Vite dev server) with a real Chromium, exercises
 * the central user journey, checks the browser console, and captures screenshots
 * of the actual rendered interface.
 *
 * Usage:
 *   CHROME_PATH=/path/to/chromium node tests/e2e/run.mjs [baseURL] [outDir]
 *
 * The script finds a Chrome/Chromium binary from $CHROME_PATH or common install
 * locations. It needs no Playwright browser download, so it runs anywhere a
 * system Chromium exists. WebGL is exercised through the browser's own GL stack
 * (SwiftShader software rendering works when no GPU is available).
 */
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
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
    '/Applications/Chromium.app/Contents/MacOS/Chromium',
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  ];
  return candidates.find((p) => existsSync(p)) ?? null;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function shot(page, name) {
  const file = path.join(OUT_DIR, `${name}.jpg`);
  await page.screenshot({ path: file, type: 'jpeg', quality: 82 });
  console.log(`  • screenshot: ${file}`);
  return file;
}

async function main() {
  const executablePath = findChrome();
  if (!executablePath) {
    console.error(
      'No Chromium/Chrome binary found. Set CHROME_PATH to a browser executable and retry.\n' +
        'This test never pretends to have run: without a browser it exits non-zero.',
    );
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

  const consoleErrors = [];
  const pageErrors = [];
  const failedRequests = [];
  const results = [];
  const record = (name, ok, detail = '') => {
    results.push({ name, ok, detail });
    console.log(`${ok ? '  ✓' : '  ✗'} ${name}${detail ? ` — ${detail}` : ''}`);
  };

  try {
    const page = await browser.newPage();
    page.on('console', (msg) => {
      if (msg.type() === 'error') consoleErrors.push(msg.text());
    });
    page.on('pageerror', (err) => pageErrors.push(String(err)));
    page.on('requestfailed', (req) => failedRequests.push(`${req.url()} :: ${req.failure()?.errorText}`));

    await page.setViewport({ width: 1440, height: 900, deviceScaleFactor: 1 });

    // --- 1. Open the application -----------------------------------------
    console.log('\n[1] Opening the application');
    await page.goto(BASE_URL, { waitUntil: 'networkidle2', timeout: 60_000 });
    record('page loads', true, await page.title());
    await page.waitForSelector('.hero', { timeout: 20_000 });
    const heroTitle = await page.$eval('.hero-content h1', (el) => el.textContent);
    record('hero introduces Skyline', /Every dot/.test(heroTitle ?? ''), heroTitle?.trim());
    await shot(page, '00-home');

    // Enter the explorer through the primary call to action.
    await page.evaluate(() => {
      const btns = [...document.querySelectorAll('.hero-actions .btn')];
      btns[0]?.click();
    });
    await page.waitForSelector('.globe-canvas', { timeout: 20_000 });
    const hash = await page.evaluate(() => window.location.hash);
    record('Explore the globe opens the explorer', hash.includes('explorer'), hash);

    // --- 2. WebGL / globe --------------------------------------------------
    console.log('\n[2] Globe & WebGL');
    await sleep(2500); // allow the first worker tick + texture load
    const gl = await page.evaluate(() => {
      const canvas = document.querySelector('.globe-canvas');
      const glCtx = canvas?.getContext('webgl2') || canvas?.getContext('webgl');
      if (!glCtx) return null;
      const dbg = glCtx.getExtension('WEBGL_debug_renderer_info');
      return {
        renderer: dbg ? glCtx.getParameter(dbg.UNMASKED_RENDERER_WEBGL) : glCtx.getParameter(glCtx.RENDERER),
        width: canvas.width,
        height: canvas.height,
      };
    });
    record('WebGL context active', Boolean(gl), gl ? `${gl.renderer} @ ${gl.width}×${gl.height}` : 'no context');
    record('canvas is sized', Boolean(gl && gl.width > 200 && gl.height > 200));

    // --- 3. Health endpoint through the app -------------------------------
    console.log('\n[3] Backend health & data provenance');
    const health = await page.evaluate(async () => {
      const res = await fetch('/api/health');
      return res.json();
    });
    record('GET /api/health responds', health.ok === true, `runtime=${health.runtime}`);
    record(
      'health carries per-group provenance',
      Array.isArray(health.groups) && health.groups.every((g) => typeof g.state === 'string'),
      `${health.groups.length} groups`,
    );
    const catalogJson = await page.evaluate(async () => {
      const res = await fetch('/api/gp?group=stations');
      return res.json();
    });
    record(
      'GET /api/gp returns genuine records + state',
      catalogJson.recordCount > 0 && ['live', 'cached', 'stale', 'snapshot'].includes(catalogJson.state),
      `${catalogJson.recordCount} records, state=${catalogJson.state}, retrievedAt=${catalogJson.provenance.retrievedAt}`,
    );
    record(
      'provenance is explicit about freshness',
      typeof catalogJson.provenance.ageSeconds === 'number' && Boolean(catalogJson.provenance.note),
      catalogJson.provenance.note.slice(0, 90),
    );

    // --- 4. Catalogue UI ---------------------------------------------------
    console.log('\n[4] Catalogue & search');
    await page.waitForSelector('.result-item', { timeout: 30_000 });
    const resultCount = await page.$$eval('.result-item', (els) => els.length);
    record('search results render', resultCount > 0, `${resultCount} rows`);
    await shot(page, '01-desktop-initial');

    await page.type('#satellite-search', 'ISS');
    await sleep(400);
    const issRow = await page.$('.result-item');
    record('search filters the real catalogue', Boolean(issRow), await page.$eval('.result-name', (el) => el.textContent));

    // --- 5. Selection & inspector -----------------------------------------
    console.log('\n[5] Selecting ISS and inspecting orbital data');
    await page.click('.result-item');
    await sleep(2000);
    const inspector = await page.evaluate(() => {
      const name = document.querySelector('.inspector-name')?.textContent ?? '';
      const rows = [...document.querySelectorAll('.panel-right .data-table tr')].map((tr) => [
        tr.querySelector('th')?.textContent?.trim(),
        tr.querySelector('td')?.textContent?.trim(),
      ]);
      return { name, rows };
    });
    record('inspector shows the selected object', inspector.name.includes('ISS'), inspector.name);
    const findRow = (label) => inspector.rows.find((r) => r[0]?.startsWith(label))?.[1] ?? '';
    const lat = findRow('Latitude');
    const lon = findRow('Longitude');
    const alt = findRow('Altitude');
    const speed = findRow('Speed');
    record('geodetic position is populated', /N|S/.test(lat) && /E|W/.test(lon), `lat=${lat} lon=${lon}`);
    record('altitude is plausible for the ISS', /^4\d\d|^3\d\d|^5\d\d/.test(alt.replace(/[^\d.]/g, '')), `alt=${alt}`);
    record('velocity is populated', /km\/s/.test(speed), `speed=${speed}`);
    record(
      'source elements shown separately from calculated values',
      inspector.rows.some((r) => r[0]?.includes('Element epoch')) && inspector.rows.some((r) => r[0]?.includes('Inclination')),
    );
    record(
      'provenance section present',
      inspector.rows.some((r) => r[0]?.includes('Retrieved')) || inspector.rows.some((r) => r[0]?.includes('State')),
    );
    await shot(page, '02-desktop-selected');

    // --- 6. Globe interactions --------------------------------------------
    console.log('\n[6] Globe interactions');
    const labelVisible = await page.$eval('.sat-label', (el) => el.style.display !== 'none' && el.textContent.length > 0)
      .catch(() => false);
    record('selected-satellite label renders over the globe', labelVisible);

    const orbitToggle = await page.$('label.layer-toggle:has(input[type=checkbox])');
    record('layer toggles present', Boolean(orbitToggle));
    await page.evaluate(() => {
      const boxes = [...document.querySelectorAll('.layer-toggle input')];
      boxes[0]?.click(); // orbit path off
    });
    await sleep(600);
    await shot(page, '03-orbit-toggled');
    await page.evaluate(() => {
      const boxes = [...document.querySelectorAll('.layer-toggle input')];
      boxes[0]?.click(); // back on
    });

    // Camera focus via the inspector button
    const focusBtn = await page.$$('.panel-right .btn');
    record('inspector actions render', focusBtn.length >= 3, `${focusBtn.length} buttons`);

    // Drag the globe a little and confirm no errors appear
    const canvas = await page.$('.globe-canvas');
    const box = await canvas.boundingBox();
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.mouse.down();
    await page.mouse.move(box.x + box.width / 2 + 120, box.y + box.height / 2 + 40, { steps: 12 });
    await page.mouse.up();
    await sleep(800);
    record('camera drag interaction completes without errors', pageErrors.length === 0);
    await shot(page, '04-desktop-dragged');

    // --- 7. Time controls --------------------------------------------------
    console.log('\n[7] Time controls');
    const rateButtons = await page.$$('.rate-btn');
    record('time controls render', rateButtons.length >= 5, `${rateButtons.length} controls`);
    await page.evaluate(() => {
      const btns = [...document.querySelectorAll('.rate-btn')];
      btns[2]?.click(); // 300x
    });
    await sleep(1200);
    const timeCaption = await page.$eval('.time-caption', (el) => el.textContent);
    record('speed change is reflected in the readout', /speed/.test(timeCaption ?? ''), timeCaption);

    // --- 8. Group switch (bigger catalogue) --------------------------------
    console.log('\n[8] Switching catalogue group');
    await page.select('#group-select', 'visual');
    await sleep(4000);
    const groupCount = await page.$$eval('.result-item', (els) => els.length);
    record('group switch loads a different catalogue', groupCount > 0, `${groupCount} rows visible`);
    await shot(page, '05-group-visual');

    // --- 9. Mobile layout --------------------------------------------------
    console.log('\n[9] Responsive layouts');
    await page.setViewport({ width: 390, height: 844, deviceScaleFactor: 1 });
    await sleep(1500);
    const mobileOverflow = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 2);
    record('mobile: no horizontal overflow', !mobileOverflow);
    await shot(page, '06-mobile');
    await page.setViewport({ width: 768, height: 1024, deviceScaleFactor: 1 });
    await sleep(1200);
    await shot(page, '07-tablet');

    // --- 9b. Routed views --------------------------------------------------
    console.log('\n[9b] Sky, weather, events and about routes');
    await page.setViewport({ width: 1440, height: 900, deviceScaleFactor: 1 });
    await page.goto(`${BASE_URL}#/sky`, { waitUntil: 'networkidle2', timeout: 60_000 });
    await page.waitForSelector('.sky-page', { timeout: 20_000 });
    await sleep(1500);
    record('sky route renders replay workspace', true);
    await shot(page, '12-sky');
    await page.goto(`${BASE_URL}#/weather`, { waitUntil: 'networkidle2', timeout: 60_000 });
    await page.waitForSelector('.weather-page', { timeout: 20_000 });
    await sleep(1500);
    record('weather route renders', true);
    await shot(page, '13-weather');
    await page.goto(`${BASE_URL}#/events`, { waitUntil: 'networkidle2', timeout: 60_000 });
    await page.waitForSelector('.events-page', { timeout: 20_000 });
    await sleep(800);
    record('events route renders', true);
    await shot(page, '14-events');
    await page.goto(`${BASE_URL}#/about`, { waitUntil: 'networkidle2', timeout: 60_000 });
    await page.waitForSelector('.about-page', { timeout: 20_000 });
    record('about route renders', true);
    await shot(page, '15-about');

    // --- 10. Console cleanliness -------------------------------------------
    console.log('\n[10] Console & network hygiene');
    record('no uncaught page errors', pageErrors.length === 0, pageErrors.slice(0, 2).join(' | '));
    const textureFailures = failedRequests.filter((r) => r.includes('/textures/'));
    record('no failed texture requests', textureFailures.length === 0, textureFailures.slice(0, 2).join(' | '));
    record(
      'console errors (informational)',
      consoleErrors.length === 0,
      consoleErrors.length ? consoleErrors.slice(0, 3).join(' | ') : 'clean',
    );

    // --- Summary ------------------------------------------------------------
    const summary = {
      baseURL: BASE_URL,
      testedAt: new Date().toISOString(),
      webglRenderer: gl?.renderer ?? null,
      results,
      consoleErrors,
      pageErrors,
      failedRequests,
    };
    writeFileSync(path.join(OUT_DIR, 'e2e-report.json'), JSON.stringify(summary, null, 2));

    const failed = results.filter((r) => !r.ok && !r.name.includes('informational'));
    console.log(`\n=== ${results.length - failed.length}/${results.length} checks passed ===`);
    if (failed.length > 0) {
      console.log('Failures:');
      for (const f of failed) console.log(`  ✗ ${f.name} — ${f.detail}`);
      process.exitCode = 1;
    }
  } finally {
    await browser.close();
  }
}

main().catch((err) => {
  console.error('E2E run failed:', err);
  process.exit(1);
});
