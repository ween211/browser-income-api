// Browser Income API
// Node.js + Express + Puppeteer service for collecting income statistics
// through browser automation with persistent profile, queue, retries,
// navigation mutex, keepalive and optional image captcha resolver.

import 'dotenv/config';
import fs from 'fs';
import path from 'path';
import express from 'express';
import puppeteer from 'puppeteer-extra';
import StealthPlugin from 'puppeteer-extra-plugin-stealth';
import { fileURLToPath } from 'url';

puppeteer.use(StealthPlugin());

/* ============== Paths & Config ============== */

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const PORT = +(process.env.PORT || 8003);

const ORIGIN = (process.env.TARGET_ORIGIN || 'https://example.com').replace(/\/$/, '');
const LOCALE = process.env.TARGET_LOCALE || 'ru';

const LOGIN_EMAIL = process.env.BROWSER_LOGIN_EMAIL || '';
const LOGIN_PASSWORD = process.env.BROWSER_LOGIN_PASSWORD || '';
const CAPTCHA_API_KEY = process.env.CAPTCHA_API_KEY || '';

const USER_DATA_DIR = process.env.USER_DATA_DIR
  ? path.resolve(process.env.USER_DATA_DIR)
  : path.join(__dirname, 'profiles', 'browser');

const AUTH_DIR = process.env.AUTH_DIR
  ? path.resolve(process.env.AUTH_DIR)
  : path.join(__dirname, 'auth');

const COOKIES_PATH = path.join(AUTH_DIR, 'cookies.json');
const LSTORAGE_PATH = path.join(AUTH_DIR, 'localstorage.json');

const HEADFUL = String(process.env.HEADFUL || '').toLowerCase() === '1';
const DEBUG_LOGS = String(process.env.DEBUG_LOGS || '').toLowerCase() === '1';
const DEBUG_SHOTS = String(process.env.DEBUG_SHOTS || '').toLowerCase() === '1';

const TIMEZONE = process.env.TIMEZONE || 'Europe/Moscow';
const ACCEPT_LANGUAGE =
  process.env.ACCEPT_LANGUAGE || 'ru-RU,ru;q=0.9,en-US;q=0.8,en;q=0.7';

const FIXED_UA =
  process.env.FIXED_UA ||
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/124.0 Safari/537.36';

const KEEP_OPEN = String(process.env.KEEP_OPEN || '1').toLowerCase() === '1';
const KEEPALIVE_MIN = Math.max(0, +(process.env.KEEPALIVE_MIN || 0));
const SOFT_RESTART_HOURS = Math.max(2, +(process.env.SOFT_RESTART_HOURS || 4));
const MIN_SECS_BETWEEN_CALLS = Math.max(1, +(process.env.MIN_SECS_BETWEEN_CALLS || 2));

const CACHE_TTL_SEC = Math.max(1, +(process.env.CACHE_TTL_SEC || 20));

const REQ_TIMEOUT_SEC = Math.max(15, +(process.env.REQ_TIMEOUT_SEC || 75));
const REQ_TIMEOUT_COLD_SEC = Math.max(60, +(process.env.REQ_TIMEOUT_COLD_SEC || 180));

const LOGIN_URL = `${ORIGIN}/${LOCALE}/login`;

const incomeUrl = ({ from, to, status = 'all', category = 'all' }) =>
  `${ORIGIN}/${LOCALE}/payout/income-statistics?fromDate=${encodeURIComponent(
    from
  )}&toDate=${encodeURIComponent(to)}&status=${status}&category=${category}`;

const log = (...args) => {
  if (DEBUG_LOGS) console.log(...args);
};

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const ensureDir = (targetPath) => fs.mkdirSync(targetPath, { recursive: true });
const nowStr = () => new Date().toISOString().replace(/[:.]/g, '-');

/* ============== Robust navigation helpers ============== */

function isRetriableNavError(error) {
  const message = String(error?.message || error || '').toLowerCase();

  return (
    message.includes('timeout') ||
    message.includes('navigation timeout') ||
    message.includes('net::err_failed') ||
    message.includes('net::err_aborted') ||
    message.includes('frame detached') ||
    message.includes('execution context was destroyed') ||
    message.includes('session closed') ||
    message.includes('target closed') ||
    message.includes('browser has disconnected')
  );
}

async function safeWaitForIncomeReady(page, timeout = 45000) {
  const started = Date.now();

  while (Date.now() - started < timeout) {
    try {
      const ready = await page.evaluate(() => {
        const bodyText = (document.body?.innerText || '').toLowerCase();

        const hasRows =
          !!document.querySelector('tr.tableRow') ||
          !!document.querySelector('table tr');

        const hasTable =
          !!document.querySelector('table, .table, .tableContainer, #payoutsTable, .incomeTable');

        const hasLoginForm =
          !!document.querySelector('#emailOrNick, input[name="emailOrNick"], input[type="password"]');

        const hasFatal =
          bodyText.includes('access denied') ||
          bodyText.includes('forbidden') ||
          bodyText.includes('something went wrong');

        return {
          hasRows,
          hasTable,
          hasLoginForm,
          hasFatal,
          url: location.href,
        };
      });

      if (ready.hasLoginForm) return { ok: false, reason: 'login_required' };
      if (ready.hasRows) return { ok: true, reason: 'rows_visible' };
      if (ready.hasTable) return { ok: true, reason: 'table_visible' };
      if (ready.hasFatal) return { ok: false, reason: 'fatal_page_state' };
    } catch {}

    await sleep(400);
  }

  return { ok: false, reason: 'income_ready_timeout' };
}

async function safeGotoWithReady(page, url, options = {}) {
  const { timeout = 90000, readyTimeout = 45000, retries = 2 } = options;
  let lastError;

  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const navPromise = page.goto(url, {
        waitUntil: 'domcontentloaded',
        timeout,
      });

      const readyPromise = safeWaitForIncomeReady(page, readyTimeout);

      const result = await Promise.race([
        navPromise.then(() => ({ ok: true, via: 'goto' })),
        readyPromise.then((ready) =>
          ready.ok
            ? { ok: true, via: `ready:${ready.reason}` }
            : Promise.reject(new Error(ready.reason))
        ),
      ]);

      return result;
    } catch (error) {
      lastError = error;

      try {
        const ready = await safeWaitForIncomeReady(page, 5000);
        if (ready.ok) return { ok: true, via: `late_ready:${ready.reason}` };
      } catch {}

      if (!isRetriableNavError(error) || attempt === retries) break;

      await sleep(1500 + attempt * 1500);

      try {
        if (!page.isClosed?.()) {
          await page
            .evaluate(() => {
              try {
                window.stop();
              } catch {}
            })
            .catch(() => {});
        }
      } catch {}
    }
  }

  throw lastError;
}

async function safeReloadWithReady(page, options = {}) {
  const { timeout = 90000, readyTimeout = 45000, retries = 2 } = options;
  let lastError;

  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const reloadPromise = page.reload({
        waitUntil: 'domcontentloaded',
        timeout,
      });

      const readyPromise = safeWaitForIncomeReady(page, readyTimeout);

      const result = await Promise.race([
        reloadPromise.then(() => ({ ok: true, via: 'reload' })),
        readyPromise.then((ready) =>
          ready.ok
            ? { ok: true, via: `ready:${ready.reason}` }
            : Promise.reject(new Error(ready.reason))
        ),
      ]);

      return result;
    } catch (error) {
      lastError = error;

      try {
        const ready = await safeWaitForIncomeReady(page, 5000);
        if (ready.ok) return { ok: true, via: `late_ready:${ready.reason}` };
      } catch {}

      if (!isRetriableNavError(error) || attempt === retries) break;

      await sleep(1500 + attempt * 1500);

      try {
        if (!page.isClosed?.()) {
          await page
            .evaluate(() => {
              try {
                window.stop();
              } catch {}
            })
            .catch(() => {});
        }
      } catch {}
    }
  }

  throw lastError;
}

/* ============== Humanization utils ============== */

const rnd = (a, b) => a + Math.random() * (b - a);

const humanSleep = async (minMs, maxMs) => {
  await sleep(Math.round(rnd(minMs, maxMs)));
};

async function humanMouse(page) {
  try {
    const { width, height } = page.viewport() || { width: 1366, height: 768 };
    const pathLen = 3 + Math.floor(Math.random() * 4);

    let x = Math.round(rnd(20, width - 20));
    let y = Math.round(rnd(80, height - 20));

    await page.mouse.move(x, y, { steps: 8 + Math.floor(Math.random() * 12) });

    for (let i = 0; i < pathLen; i++) {
      x = Math.round(Math.min(width - 10, Math.max(10, x + rnd(-80, 80))));
      y = Math.round(Math.min(height - 10, Math.max(10, y + rnd(-60, 60))));

      await page.mouse.move(x, y, { steps: 6 + Math.floor(Math.random() * 10) });
      await humanSleep(50, 180);
    }
  } catch {}
}

async function humanScroll(page) {
  try {
    await page.evaluate(() => window.scrollTo(0, 0));
    await humanSleep(120, 260);

    await page.evaluate(() => window.scrollBy(0, Math.round(200 + Math.random() * 600)));
    await humanSleep(80, 180);

    await page.evaluate(() => window.scrollBy(0, -Math.round(100 + Math.random() * 300)));
  } catch {}
}

/* ============== Frames helpers ============== */

function allFrames(page) {
  const output = [];

  (function walk(frame) {
    output.push(frame);
    frame.childFrames().forEach(walk);
  })(page.mainFrame());

  return output;
}

async function waitInFrames(page, selectors, { timeout = 30000 } = {}) {
  const started = Date.now();

  while (Date.now() - started < timeout) {
    for (const frame of allFrames(page)) {
      for (const selector of selectors) {
        try {
          const handle = await frame.$(selector);
          if (handle) return { frame, handle, selector };
        } catch {}
      }
    }

    await sleep(200);
  }

  return null;
}

async function typeIntoHandle(frame, handle, text) {
  try {
    await handle.click({ clickCount: 3 }).catch(() => {});
    await handle.type(text, { delay: 70 + Math.floor(Math.random() * 120) });
    return;
  } catch {}

  await frame.evaluate(
    (element, value) => {
      const descriptor = Object.getOwnPropertyDescriptor(element.__proto__, 'value');

      try {
        descriptor?.set?.call(element, '');
        descriptor?.set?.call(element, value);
      } catch {}

      try {
        element.dispatchEvent(new Event('input', { bubbles: true }));
      } catch {}

      try {
        element.dispatchEvent(new Event('change', { bubbles: true }));
      } catch {}
    },
    handle,
    text
  );
}

/* ============== Optional image captcha resolver ============== */

async function solveImageCaptchaIfPresent(page) {
  let found = null;

  for (const frame of allFrames(page)) {
    const handle = await frame.$('div.captchaContainer img, .captchaContainer img, img[src*="captcha" i]');

    if (handle) {
      found = { frame, handle };
      break;
    }
  }

  if (!found) return { used: false, solution: null };

  if (!CAPTCHA_API_KEY) {
    log('[captcha] image found, but CAPTCHA_API_KEY is not configured');
    return { used: false, solution: null };
  }

  const src = await found.handle.evaluate((image) => image.src);
  const url = src.startsWith('http') ? src : `${ORIGIN}${src}`;

  const imageResponse = await fetch(url, {
    headers: {
      Referer: LOGIN_URL,
      'User-Agent': FIXED_UA,
    },
  });

  if (!imageResponse.ok) {
    throw new Error(`[captcha] image fetch failed ${imageResponse.status}`);
  }

  const base64 = Buffer.from(new Uint8Array(await imageResponse.arrayBuffer())).toString('base64');

  const createTaskResponse = await fetch('https://2captcha.com/in.php', {
    method: 'POST',
    body: new URLSearchParams({
      key: CAPTCHA_API_KEY,
      method: 'base64',
      body: base64,
      json: '1',
    }),
  }).then((response) => response.json());

  if (createTaskResponse.status !== 1) {
    throw new Error(`captcha provider create task error: ${createTaskResponse.request}`);
  }

  const taskId = createTaskResponse.request;
  let solution = null;

  for (let i = 0; i < 40; i++) {
    const result = await fetch(
      `https://2captcha.com/res.php?key=${CAPTCHA_API_KEY}&action=get&id=${taskId}&json=1`
    ).then((response) => response.json());

    if (result.status === 1) {
      solution = result.request;
      break;
    }

    if (result.request !== 'CAPCHA_NOT_READY') {
      throw new Error(`captcha provider result error: ${result.request}`);
    }

    await sleep(3000);
  }

  if (!solution) {
    throw new Error('captcha provider timeout');
  }

  const captchaInput = await waitInFrames(page, ['input[name="captcha"]', '#captcha'], {
    timeout: 5000,
  });

  if (captchaInput) {
    await typeIntoHandle(captchaInput.frame, captchaInput.handle, solution);
  }

  return { used: true, solution };
}

/* ============== Persistence: cookies & localStorage ============== */

async function restoreCookiesAndStorage(page) {
  ensureDir(AUTH_DIR);

  let restored = false;

  try {
    if (fs.existsSync(COOKIES_PATH)) {
      const cookies = JSON.parse(fs.readFileSync(COOKIES_PATH, 'utf8'));

      if (Array.isArray(cookies) && cookies.length) {
        await page.setCookie(...cookies);
        log(`[cookies] restored ${cookies.length}`);
        restored = true;
      }
    }
  } catch (error) {
    log('[cookies] restore error:', error.message);
  }

  try {
    if (fs.existsSync(LSTORAGE_PATH)) {
      const entries = JSON.parse(fs.readFileSync(LSTORAGE_PATH, 'utf8')) || {};

      await page
        .goto(`${ORIGIN}/${LOCALE}`, {
          waitUntil: 'domcontentloaded',
          timeout: 45000,
        })
        .catch(() => {});

      await sleep(700);

      await page.evaluate((pairs) => {
        try {
          for (const [key, value] of Object.entries(pairs)) {
            localStorage.setItem(key, value);
          }
        } catch {}
      }, entries);

      await sleep(300);
      log(`[localStorage] restored ${Object.keys(entries).length}`);

      restored = true;
    }
  } catch (error) {
    log('[localStorage] restore error:', error.message);
  }

  return restored;
}

async function dumpCookiesAndStorage(page) {
  ensureDir(AUTH_DIR);

  try {
    const all = await page.cookies();

    const filtered = all.filter((cookie) => {
      const domain = cookie.domain || '';
      return domain.includes(new URL(ORIGIN).hostname.replace(/^www\./, ''));
    });

    fs.writeFileSync(COOKIES_PATH, JSON.stringify(filtered, null, 2));
    log(`[cookies] saved ${filtered.length} → ${COOKIES_PATH}`);
  } catch (error) {
    log('[cookies] save error:', error.message);
  }

  try {
    const entries = await page.evaluate(() => Object.fromEntries(Object.entries(localStorage)));
    fs.writeFileSync(LSTORAGE_PATH, JSON.stringify(entries, null, 2));
    log(`[localStorage] saved ${Object.keys(entries || {}).length} → ${LSTORAGE_PATH}`);
  } catch (error) {
    log('[localStorage] save error:', error.message);
  }
}

/* ============== Browser Manager ============== */

class BrowserManager {
  constructor() {
    this.browser = null;
    this.context = null;
    this.page = null;

    this.startedAt = 0;
    this.lastActivity = 0;

    this.keepaliveTimer = null;
    this.softRestartTimer = null;

    this.lastApiCall = 0;
    this.restoredOnce = false;
    this.restoredFromFiles = false;

    this.lastOpenAt = 0;
    this.lastPeriodKey = '';

    this._launching = null;

    this.navLock = Promise.resolve();
    this.navRunning = false;
    this.lastSuccessfulNavAt = 0;
  }

  _isGoneError(error) {
    const message = String(error?.message || error || '').toLowerCase();

    return (
      message.includes('target closed') ||
      message.includes('browser has disconnected') ||
      message.includes('session closed') ||
      message.includes('navigation failed')
    );
  }

  async serializeNav(fn) {
    const previous = this.navLock;

    let release;
    this.navLock = new Promise((resolve) => {
      release = resolve;
    });

    await previous;
    this.navRunning = true;

    try {
      return await fn();
    } finally {
      this.navRunning = false;
      release();
    }
  }

  async launch() {
    ensureDir(USER_DATA_DIR);
    ensureDir(AUTH_DIR);

    const launchOptions = {
      headless: !HEADFUL ? 'new' : false,
      userDataDir: USER_DATA_DIR,
      defaultViewport: HEADFUL ? null : { width: 1366, height: 768 },
      devtools: !!HEADFUL,
      args: [
        '--disable-blink-features=AutomationControlled',
        `--lang=${ACCEPT_LANGUAGE.split(',')[0]}`,
        ...(HEADFUL ? ['--start-maximized'] : ['--no-sandbox', '--disable-setuid-sandbox']),
      ],
    };

    try {
      this.browser = await puppeteer.launch(launchOptions);
    } catch (error) {
      if (!HEADFUL) {
        console.log("[browser] headless:new failed → retry headless:'chrome'");
        this.browser = await puppeteer.launch({ ...launchOptions, headless: 'chrome' });
      } else {
        throw error;
      }
    }

    this.browser.on('disconnected', () => {
      log('[browser] disconnected');
      this.browser = null;
      this.context = null;
      this.page = null;
    });

    this.context = this.browser.defaultBrowserContext();

    const pages = await this.browser.pages();
    this.page = pages[0] || (await this.browser.newPage());

    await this._preparePage(this.page);

    this.startedAt = Date.now();
    this.touch();

    this.scheduleKeepalive();
    this.scheduleSoftRestart();

    log('[browser] launched, headful=', HEADFUL, 'profile=', USER_DATA_DIR);
  }

  async _preparePage(page) {
    try {
      await page.setUserAgent(FIXED_UA);
    } catch {}

    try {
      await page.setExtraHTTPHeaders({ 'Accept-Language': ACCEPT_LANGUAGE });
    } catch {}

    try {
      await (this.context || this.browser).emulateTimezone?.(TIMEZONE);
    } catch {}

    try {
      await page.evaluateOnNewDocument(() => {
        try {
          Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
        } catch {}
      });
    } catch {}

    page.on('response', async (response) => {
      try {
        const url = response.url();

        if (
          url.includes('/login') ||
          url.includes('/auth') ||
          url.includes('/signin') ||
          url.includes('/session')
        ) {
          log('[response]', response.status(), url);
        }
      } catch {}
    });

    page.on('requestfailed', (request) => {
      try {
        const url = request.url();

        if (
          url.startsWith('wss://') ||
          url.includes('socket.io') ||
          url.includes('/session/refresh')
        ) {
          log('[requestfailed:ignored]', request.failure()?.errorText, url);
          return;
        }

        if (
          url.includes('/login') ||
          url.includes('/auth') ||
          url.includes('/signin') ||
          url.includes('/session')
        ) {
          log('[requestfailed]', request.failure()?.errorText, url);
        }
      } catch {}
    });

    page.on('console', (message) => {
      try {
        log('[console]', message.type(), message.text());
      } catch {}
    });
  }

  touch() {
    this.lastActivity = Date.now();
  }

  async maybeRestore() {
    if (this.restoredOnce) return;

    this.restoredOnce = true;

    try {
      this.restoredFromFiles = await restoreCookiesAndStorage(this.page);
    } catch (error) {
      log('[restore] error:', error.message);
      this.restoredFromFiles = false;
    }
  }

  async launchIfNeeded() {
    if (this.browser && this.browser.isConnected?.()) {
      // Browser is already available.
    } else {
      if (!this._launching) {
        this._launching = (async () => {
          try {
            await this.launch();
          } finally {
            this._launching = null;
          }
        })();
      }

      await this._launching;
    }

    if (!this.page || this.page.isClosed?.()) {
      try {
        const pages = await this.browser.pages();
        this.page = pages[0] || (await this.browser.newPage());
        await this._preparePage(this.page);
      } catch (error) {
        log('[ensure] newPage failed:', error.message);
        await this.restart();
      }
    }
  }

  scheduleKeepalive() {
    if (this.keepaliveTimer) clearInterval(this.keepaliveTimer);
    if (!KEEP_OPEN || KEEPALIVE_MIN <= 0) return;

    this.keepaliveTimer = setInterval(async () => {
      try {
        if (this.navRunning) return;

        await this.launchIfNeeded();

        if (!this.page) return;

        const idleMs = Date.now() - this.lastActivity;

        if (idleMs < 30000) return;

        log('[keepalive] soft check/reload');

        await this.serializeNav(async () => {
          try {
            await safeReloadWithReady(this.page, {
              timeout: 60000,
              readyTimeout: 20000,
              retries: 1,
            });

            this.lastOpenAt = Date.now();
            this.lastSuccessfulNavAt = Date.now();
          } catch (error) {
            log('[keepalive] reload error:', error.message);
          }
        });
      } catch (error) {
        log('[keepalive] error:', error.message);
      }
    }, KEEPALIVE_MIN * 60 * 1000);
  }

  scheduleSoftRestart() {
    if (this.softRestartTimer) clearInterval(this.softRestartTimer);

    this.softRestartTimer = setInterval(async () => {
      try {
        const hours = (Date.now() - this.startedAt) / 3600000;

        if (hours >= SOFT_RESTART_HOURS) {
          log('[soft-restart] restarting browser');
          await this.restart();
        }
      } catch (error) {
        log('[soft-restart] error:', error.message);
      }
    }, 5 * 60 * 1000);
  }

  async restart() {
    try {
      await this.browser?.close();
    } catch {}

    this.browser = null;
    this.context = null;
    this.page = null;

    this.restoredOnce = false;
    this.restoredFromFiles = false;

    this.lastOpenAt = 0;
    this.lastPeriodKey = '';
    this.lastSuccessfulNavAt = 0;

    await this.launchIfNeeded();
  }

  async ensure() {
    await this.launchIfNeeded();

    this.touch();

    await this.maybeRestore();

    return this.page;
  }

  async gotoIncome({ from, to }) {
    return await this.serializeNav(async () => {
      const attempt = async () => {
        const page = await this.ensure();
        const target = incomeUrl({ from, to });
        const periodKey = `${from}|${to}`;
        const currentUrl = page.url();
        const withinTtl = Date.now() - this.lastOpenAt <= CACHE_TTL_SEC * 1000;

        if (
          KEEP_OPEN &&
          currentUrl &&
          currentUrl.startsWith(ORIGIN) &&
          currentUrl.includes('/payout/income-statistics') &&
          currentUrl === target &&
          withinTtl &&
          this.lastPeriodKey === periodKey
        ) {
          log('[goto] reuse same period within TTL');

          await humanSleep(120, 300);
          await humanMouse(page);
          await humanScroll(page);

          this.lastSuccessfulNavAt = Date.now();

          return page;
        }

        const staleForTooLong =
          this.lastSuccessfulNavAt &&
          Date.now() - this.lastSuccessfulNavAt > 20 * 60 * 1000;

        if (staleForTooLong) {
          log('[goto] stale browser/page detected → restart');
          await this.restart();
        }

        const livePage = await this.ensure();
        const liveUrl = livePage.url();

        if (
          KEEP_OPEN &&
          liveUrl &&
          liveUrl.startsWith(ORIGIN) &&
          liveUrl.includes('/payout/income-statistics')
        ) {
          if (liveUrl !== target) {
            log('[goto] navigate to new period');

            await safeGotoWithReady(livePage, target, {
              timeout: 90000,
              readyTimeout: 45000,
              retries: 2,
            });
          } else {
            log('[goto] reload same period');

            await safeReloadWithReady(livePage, {
              timeout: 90000,
              readyTimeout: 45000,
              retries: 2,
            });
          }
        } else {
          log('[goto] open target');

          await safeGotoWithReady(livePage, target, {
            timeout: 90000,
            readyTimeout: 45000,
            retries: 2,
          });
        }

        await humanSleep(200, 500);
        await humanMouse(livePage);
        await humanScroll(livePage);

        this.lastOpenAt = Date.now();
        this.lastSuccessfulNavAt = Date.now();
        this.lastPeriodKey = periodKey;

        return livePage;
      };

      try {
        return await attempt();
      } catch (error) {
        if (this._isGoneError(error) || isRetriableNavError(error)) {
          log('[goto] navigation failed → restart and retry once:', error.message);

          await this.restart();

          return await attempt();
        }

        throw error;
      }
    });
  }
}

const manager = new BrowserManager();

/* ============== Auth helpers ============== */

async function isLoginPage(page) {
  try {
    return await page.evaluate(() => /\/login(\/|$|\?)/.test(location.pathname));
  } catch {
    return false;
  }
}

async function needsLogin(page) {
  if (await isLoginPage(page)) return true;

  try {
    for (const frame of page.frames()) {
      if (
        await frame.$(
          '#emailOrNick, input[name="emailOrNick"], input[type="email"], input[name*="email"], input[name*="nick"][type="text"]'
        )
      ) {
        return true;
      }
    }
  } catch {}

  return false;
}

async function waitForLoginResult(page, timeout = 45000) {
  const started = Date.now();

  while (Date.now() - started < timeout) {
    const url = page.url();

    if (!/\/login(\/|$|\?)/.test(new URL(url).pathname)) {
      return { ok: true, reason: 'left login page' };
    }

    const stillHasLoginForm = await page
      .evaluate(() => {
        return !!document.querySelector(
          '#emailOrNick, input[name="emailOrNick"], input[type="password"]'
        );
      })
      .catch(() => true);

    if (!stillHasLoginForm) {
      return { ok: true, reason: 'login form disappeared' };
    }

    const pageState = await page
      .evaluate(() => {
        const bodyText = (document.body?.innerText || '').toLowerCase();

        return {
          bodyText,
          hasSpinner: !!document.querySelector('.spinner, .loading, [aria-busy="true"]'),
        };
      })
      .catch(() => ({ bodyText: '', hasSpinner: false }));

    if (
      pageState.bodyText.includes('invalid') ||
      pageState.bodyText.includes('error') ||
      pageState.bodyText.includes('captcha') ||
      pageState.bodyText.includes('blocked') ||
      pageState.bodyText.includes('ошиб')
    ) {
      return { ok: false, reason: 'error text detected on page' };
    }

    await sleep(500);
  }

  return { ok: false, reason: 'timeout waiting for successful login transition' };
}

async function performLogin(page, { email, password }) {
  const EMAIL_SELECTORS = [
    '#emailOrNick',
    'input[name="emailOrNick"]',
    'input[type="email"]',
    'input[name*="email"]',
    'input[name*="nick"][type="text"]',
  ];

  const PASSWORD_SELECTORS = ['#password', 'input[name="password"]', 'input[type="password"]'];

  const emailElement = await waitInFrames(page, EMAIL_SELECTORS, { timeout: 30000 });

  if (!emailElement) {
    throw new Error('email input not found');
  }

  const passwordElement = await waitInFrames(page, PASSWORD_SELECTORS, { timeout: 20000 });

  if (!passwordElement) {
    throw new Error('password input not found');
  }

  await typeIntoHandle(emailElement.frame, emailElement.handle, email);
  await humanSleep(90, 180);

  await typeIntoHandle(passwordElement.frame, passwordElement.handle, password);
  await humanSleep(120, 220);

  const captcha = await solveImageCaptchaIfPresent(page).catch((error) => {
    log('[captcha] solve error:', error.message);
    return { used: false, solution: null };
  });

  if (captcha.used) {
    log('[captcha] solved through optional image captcha resolver');
  }

  const submitButton = await waitInFrames(
    page,
    ['button[type="submit"]', 'form button'],
    { timeout: 8000 }
  );

  if (!submitButton) {
    throw new Error('submit button not found');
  }

  await submitButton.handle.evaluate((element) => element.click()).catch(async () => {
    await submitButton.frame.evaluate((element) => element.click(), submitButton.handle);
  });

  const loginResult = await waitForLoginResult(page, 45000);

  if (!loginResult.ok) {
    if (DEBUG_SHOTS) {
      ensureDir(path.join(__dirname, 'shots'));

      const filepath = path.join(__dirname, 'shots', `login-failed-${nowStr()}.png`);

      await page.screenshot({ path: filepath, fullPage: true }).catch(() => {});
      log('[screenshot]', filepath);
    }

    throw new Error(`login failed: ${loginResult.reason}`);
  }

  await dumpCookiesAndStorage(page);
}

/* ============== Parse helpers ============== */

function parseMoney(text) {
  if (!text) return { value: null, currency: null };

  const normalized = text.replace(/\s+/g, '').trim();
  const match = normalized.match(/^([\$€£])?([0-9,.]+)$/);

  const currency = match?.[1] || (normalized.startsWith('$') ? '$' : null);
  const value = Number((match?.[2] || normalized).replace(/,/g, ''));

  return {
    value: Number.isFinite(value) ? value : null,
    currency,
  };
}

async function extractIncomeForNick(page, nick) {
  const ready = await safeWaitForIncomeReady(page, 30000);

  if (!ready.ok && ready.reason === 'login_required') {
    throw new Error('login required before extracting income');
  }

  const tableSelector = 'table, .table, .tableContainer, #payoutsTable, .incomeTable';

  await page.waitForSelector(tableSelector, { timeout: 10000 }).catch(() => {});

  const data = await page.evaluate((nickArg) => {
    function text(element) {
      return (element?.innerText || element?.textContent || '').trim();
    }

    const rows = [...document.querySelectorAll('tr.tableRow, table tr')];

    for (const row of rows) {
      const nameSpan = row.querySelector('td .showMoreJs span, td span[title], td span');
      const name = text(nameSpan);

      if (!name) continue;

      if (name.toLowerCase() === nickArg.toLowerCase()) {
        const moneyCell = row.querySelector('td.tableHighlightedCell, td:nth-of-type(2)');
        const income = text(moneyCell);
        const detailsUrl = nameSpan?.getAttribute('data-details-url') || null;

        return {
          found: true,
          name,
          income,
          detailsUrl,
        };
      }
    }

    return { found: false };
  }, nick);

  if (data.found) {
    return {
      income_text: data.income,
      detailsUrl: data.detailsUrl,
    };
  }

  const searchInput = await waitInFrames(
    page,
    [
      'input[type="search"]',
      'input[name*="search" i]',
      'input[placeholder*="поиск" i]',
      'input[placeholder*="search" i]',
    ],
    { timeout: 3000 }
  );

  if (searchInput) {
    await typeIntoHandle(searchInput.frame, searchInput.handle, nick);
    await sleep(800);

    const again = await page.evaluate(() => {
      function text(element) {
        return (element?.innerText || element?.textContent || '').trim();
      }

      const rows = [...document.querySelectorAll('tr.tableRow, table tr')];

      for (const row of rows) {
        const nameSpan = row.querySelector('td .showMoreJs span, td span[title], td span');
        const name = text(nameSpan);

        if (!name) continue;

        const moneyCell = row.querySelector('td.tableHighlightedCell, td:nth-of-type(2)');
        const income = text(moneyCell);

        if (name && income) {
          return { name, income };
        }
      }

      return null;
    });

    if (again) {
      return {
        income_text: again.income,
        detailsUrl: null,
      };
    }
  }

  return {
    income_text: null,
    detailsUrl: null,
  };
}

/* ============== Core flow ============== */

async function ensureLoggedAndOpen({ from, to }) {
  const page = await manager.gotoIncome({ from, to });

  if (await needsLogin(page)) {
    log('[auth] login required:', page.url());

    await safeGotoWithReady(page, LOGIN_URL, {
      timeout: 90000,
      readyTimeout: 15000,
      retries: 1,
    }).catch(() => {});

    await performLogin(page, {
      email: LOGIN_EMAIL,
      password: LOGIN_PASSWORD,
    });

    await safeGotoWithReady(page, incomeUrl({ from, to }), {
      timeout: 90000,
      readyTimeout: 45000,
      retries: 2,
    }).catch((error) => {
      throw new Error(`post-login goto failed: ${error.message}`);
    });

    manager.lastOpenAt = Date.now();
    manager.lastSuccessfulNavAt = Date.now();
    manager.lastPeriodKey = `${from}|${to}`;

    return { page, login_performed: true };
  }

  return { page, login_performed: false };
}

async function runIncome({ nick, from, to }) {
  if (!LOGIN_EMAIL || !LOGIN_PASSWORD) {
    throw new Error('Set BROWSER_LOGIN_EMAIL and BROWSER_LOGIN_PASSWORD in .env');
  }

  if (!nick) {
    throw new Error('nick is required');
  }

  if (!/^\d{4}-\d{2}-\d{2}$/.test(from) || !/^\d{4}-\d{2}-\d{2}$/.test(to)) {
    throw new Error('from/to must be YYYY-MM-DD');
  }

  const periodKey = `${from}|${to}`;

  const freshSamePeriod =
    manager.lastPeriodKey === periodKey &&
    Date.now() - manager.lastOpenAt <= CACHE_TTL_SEC * 1000;

  if (!freshSamePeriod) {
    const now = Date.now();
    const gap = (now - manager.lastApiCall) / 1000;

    if (gap < MIN_SECS_BETWEEN_CALLS) {
      await sleep((MIN_SECS_BETWEEN_CALLS - gap) * 1000);
    }

    manager.lastApiCall = Date.now();
  }

  try {
    const { page, login_performed } = await ensureLoggedAndOpen({ from, to });

    await humanMouse(page);
    await humanScroll(page);

    const result = await extractIncomeForNick(page, nick);

    if (!result.income_text) {
      await humanSleep(300, 700);

      const retryResult = await extractIncomeForNick(page, nick);

      if (!retryResult.income_text) {
        throw new Error(`Account not found or income not visible for nick="${nick}"`);
      }

      const { value, currency } = parseMoney(retryResult.income_text);

      return {
        nick,
        income_text: retryResult.income_text,
        income_value: value,
        currency,
        period: { from, to },
        login_performed,
        restored_from_files: manager.restoredFromFiles,
        url: page.url(),
        cache_ttl_sec: CACHE_TTL_SEC,
        reused: freshSamePeriod,
      };
    }

    const { value, currency } = parseMoney(result.income_text);

    return {
      nick,
      income_text: result.income_text,
      income_value: value,
      currency,
      period: { from, to },
      login_performed,
      restored_from_files: manager.restoredFromFiles,
      url: page.url(),
      cache_ttl_sec: CACHE_TTL_SEC,
      reused: freshSamePeriod,
    };
  } catch (error) {
    return {
      nick,
      error: error.message,
      period: { from, to },
      restored_from_files: manager.restoredFromFiles,
    };
  }
}

/* ============== API server ============== */

const app = express();

app.use(express.json());

const API_KEY = process.env.API_KEY || '';
const CORS_ORIGIN = process.env.CORS_ORIGIN || '';

app.set('trust proxy', 1);

app.use((req, res, next) => {
  if (CORS_ORIGIN) {
    res.setHeader('Access-Control-Allow-Origin', CORS_ORIGIN);
    res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-API-Key');
    res.setHeader('Vary', 'Origin');

    if (req.method === 'OPTIONS') return res.sendStatus(204);
  }

  next();
});

app.use((req, res, next) => {
  if (!API_KEY) return next();

  const headerKey = req.get('x-api-key');
  const bearer = (req.get('authorization') || '').replace(/^Bearer\s+/i, '');
  const key = headerKey || bearer || '';

  if (key === API_KEY) return next();

  return res.status(401).json({ error: 'unauthorized' });
});

/* ============== Admin request logs ============== */

const ADMIN_KEY = process.env.ADMIN_KEY || '';
const MAX_REQ_LOGS = Math.max(10, +(process.env.MAX_REQ_LOGS || 200));
const LOG_REQUESTS = String(process.env.LOG_REQUESTS || '').toLowerCase() === '1';

const maskValue = (value) => {
  if (!value) return value;
  const stringValue = String(value);
  return stringValue.slice(0, 3) + '***' + stringValue.slice(-2);
};

const REQ_LOG = [];

function pushReqLog(entry) {
  REQ_LOG.push(entry);

  if (REQ_LOG.length > MAX_REQ_LOGS) {
    REQ_LOG.shift();
  }
}

function isAdmin(req) {
  return ADMIN_KEY && (req.query.key === ADMIN_KEY || req.headers['x-admin-key'] === ADMIN_KEY);
}

function requireAdmin(req, res) {
  if (!ADMIN_KEY) {
    return res.status(500).json({ error: 'admin key not set' });
  }

  if (!isAdmin(req)) {
    return res.status(401).json({ error: 'admin unauthorized' });
  }

  return true;
}

if (LOG_REQUESTS) {
  app.use((req, res, next) => {
    const started = Date.now();

    const ip =
      (req.headers['x-forwarded-for']?.split(',')[0] || '').trim() ||
      req.socket?.remoteAddress ||
      '';

    const entry = {
      ts: new Date().toISOString(),
      ip,
      method: req.method,
      path: req.path,
      query: req.query || {},
      headers: {
        'user-agent': req.headers['user-agent'],
        'x-api-key': maskValue(req.headers['x-api-key']),
        'content-type': req.headers['content-type'],
        'x-forwarded-for': req.headers['x-forwarded-for'],
      },
    };

    try {
      if (req.is?.('application/json') && typeof req.body !== 'undefined') {
        entry.body_preview = JSON.stringify(req.body).slice(0, 2000);
      }
    } catch {}

    const originalJson = res.json.bind(res);
    const originalSend = res.send.bind(res);

    function finish(preview) {
      entry.status = res.statusCode;
      entry.duration_ms = Date.now() - started;

      if (preview) {
        entry.res_preview = preview;
      }

      pushReqLog(entry);
    }

    res.json = (body) => {
      let preview = '';

      try {
        preview = JSON.stringify(body).slice(0, 4000);
      } catch {}

      finish(preview);

      return originalJson(body);
    };

    res.send = (body) => {
      let preview = '';

      try {
        preview =
          typeof body === 'string'
            ? body.slice(0, 4000)
            : JSON.stringify(body).slice(0, 4000);
      } catch {}

      finish(preview);

      return originalSend(body);
    };

    next();
  });
}

app.get('/browser/_logs', (req, res) => {
  if (requireAdmin(req, res) !== true) return;

  const n = Math.min(MAX_REQ_LOGS, Math.max(1, +(req.query.n || 50)));

  res.json({
    size: REQ_LOG.length,
    last: REQ_LOG.slice(-n),
  });
});

app.get('/browser/_logs/stream', (req, res) => {
  if (requireAdmin(req, res) !== true) return;

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');

  res.flushHeaders?.();

  let index = REQ_LOG.length;

  const timer = setInterval(() => {
    if (index < REQ_LOG.length) {
      const chunk = REQ_LOG.slice(index);
      index = REQ_LOG.length;

      for (const entry of chunk) {
        res.write(`data: ${JSON.stringify(entry)}\n\n`);
      }
    }
  }, 1000);

  req.on('close', () => clearInterval(timer));
});

app.all('/browser/_echo', (req, res) => {
  if (requireAdmin(req, res) !== true) return;

  res.json({
    ts: new Date().toISOString(),
    method: req.method,
    path: req.path,
    query: req.query,
    ip:
      (req.headers['x-forwarded-for']?.split(',')[0] || '').trim() ||
      req.socket?.remoteAddress ||
      '',
    headers: req.headers,
    body: req.body,
  });
});

/* ============== Public API ============== */

function normalizeDate(dateValue) {
  return /^\d{4}-\d{2}-\d{2}$/.test(String(dateValue || '')) ? String(dateValue) : null;
}

app.get('/browser/ping', async (req, res) => {
  try {
    res.json({
      ok: true,
      origin: ORIGIN,
      locale: LOCALE,
      keep_open: KEEP_OPEN,
      restored_from_files: manager.restoredFromFiles,
      cache_ttl_sec: CACHE_TTL_SEC,
    });
  } catch (error) {
    res.status(500).json({
      ok: false,
      error: error.message,
    });
  }
});

/* ============== Serial queue ============== */

let queue = [];
let active = false;

function withTimeout(promise, timeoutMs) {
  let timer;

  return Promise.race([
    promise,
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error('Timeout')), timeoutMs);
    }),
  ]).finally(() => clearTimeout(timer));
}

function pump() {
  if (active || !queue.length) return;

  active = true;

  const { res, payload } = queue.shift();

  const isCold = manager.lastOpenAt === 0 || !manager.restoredFromFiles;
  const budgetMs = (isCold ? REQ_TIMEOUT_COLD_SEC : REQ_TIMEOUT_SEC) * 1000;

  withTimeout(runIncome(payload), budgetMs)
    .then((output) => res.json(output))
    .catch((error) =>
      res.json({
        nick: payload.nick,
        error: String(error.message || error),
        period: {
          from: payload.from,
          to: payload.to,
        },
        restored_from_files: manager.restoredFromFiles,
      })
    )
    .finally(() => {
      active = false;
      pump();
    });
}

app.get('/browser/income', (req, res) => {
  const nick = String(req.query.nick || '').trim();
  const from = normalizeDate(req.query.from);
  const to = normalizeDate(req.query.to);

  if (!nick) return res.status(400).json({ error: 'nick is required' });

  if (!from || !to) {
    return res.status(400).json({
      error: 'from/to in YYYY-MM-DD format are required',
    });
  }

  res.set('X-Queue-Position', String(queue.length));
  res.set('X-Queue-Concurrency', '1');

  queue.push({
    res,
    payload: { nick, from, to },
  });

  pump();
});

app.post('/browser/income', (req, res) => {
  const nick = String(req.body?.nick || '').trim();
  const from = normalizeDate(req.body?.from);
  const to = normalizeDate(req.body?.to);

  if (!nick) return res.status(400).json({ error: 'nick is required' });

  if (!from || !to) {
    return res.status(400).json({
      error: 'from/to in YYYY-MM-DD format are required',
    });
  }

  res.set('X-Queue-Position', String(queue.length));
  res.set('X-Queue-Concurrency', '1');

  queue.push({
    res,
    payload: { nick, from, to },
  });

  pump();
});

/* ============== Graceful shutdown ============== */

process.on('SIGINT', async () => {
  try {
    await manager.browser?.close();
  } catch {}

  process.exit(0);
});

process.on('SIGTERM', async () => {
  try {
    await manager.browser?.close();
  } catch {}

  process.exit(0);
});

/* ============== Start server ============== */

app.listen(PORT, '127.0.0.1', async () => {
  console.log(
    `Browser Income API on ${PORT} — origin=${ORIGIN} keep_open=${KEEP_OPEN} cache_ttl=${CACHE_TTL_SEC}s`
  );

  if (KEEP_OPEN) {
    try {
      await manager.ensure();
    } catch (error) {
      console.log('[startup] ensure failed:', error.message);
    }
  }
});
