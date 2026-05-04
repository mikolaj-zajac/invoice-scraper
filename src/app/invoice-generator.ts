import { promises as fs } from 'fs';
import path from 'path';
import * as XLSX from 'xlsx';

const PANEL_LOGIN_URL = 'https://defender.net.pl/panel/';
const PANEL_INVOICE_LIST_URL = 'https://defender.net.pl/panel/action/applications/open/application/2';
const INVOICE_URL_BASE = 'https://defender.net.pl/whi/invoice';
const DEFAULT_START_ID = 1684;
const CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000;
const BROWSER_UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36';
const BROWSER_HEADLESS = process.env.INVOICE_BROWSER_HEADLESS !== 'false';
const BROWSER_SLOW_MO_MS = Number(process.env.INVOICE_BROWSER_SLOW_MO_MS ?? 0);
const INVOICE_DEBUG = process.env.INVOICE_DEBUG === 'true';
const LATEST_INVOICES_LIMIT = 10;
const IS_VERCEL = process.env.VERCEL === '1';

let inMemoryStatus: InvoiceGeneratorStatus | null = null;

export type InvoiceShop = 'moto-tour' | 'defender' | 'unknown';

export interface InvoiceRecord {
  invoiceId: number;
  invoiceUrl: string;
  invoiceNumber: string;
  shop: InvoiceShop;
  fetchedAt: string;
  tableRows?: Array<Record<string, string>>;
}

export interface InvoiceGeneratorStatus {
  lastCheckedAt: string | null;
  lastSuccessfulCheckAt: string | null;
  lastCheckedInvoiceId: number | null;
  latestInvoices: InvoiceRecord[];
  note?: string;
  debugSteps?: string[];
}

async function launchInvoiceBrowser() {
  const maxRetries = 3;
  let lastError: Error | null = null;

  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      if (IS_VERCEL) {
        const [{ chromium: playwrightChromium }, { default: chromium }] = await Promise.all([
          import('playwright-core'),
          import('@sparticuz/chromium'),
        ]);

        const executablePath = await chromium.executablePath();
        console.log(`[INVOICE-BROWSER] Attempt ${attempt}: Chromium path=${executablePath}`);

        const browser = await playwrightChromium.launch({
          args: chromium.args,
          executablePath,
          headless: true,
        });

        console.log(`[INVOICE-BROWSER] Successfully launched Chromium on attempt ${attempt}`);
        return browser;
      }

      const { chromium } = await import('playwright');
      return chromium.launch({
        headless: BROWSER_HEADLESS,
        slowMo: Number.isFinite(BROWSER_SLOW_MO_MS) && BROWSER_SLOW_MO_MS > 0 ? BROWSER_SLOW_MO_MS : 0,
      });
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error));
      console.error(`[INVOICE-BROWSER] Attempt ${attempt} failed:`, lastError.message);

      if (attempt < maxRetries) {
        const delay = Math.min(1000 * Math.pow(2, attempt - 1), 5000);
        console.log(`[INVOICE-BROWSER] Retrying in ${delay}ms...`);
        await new Promise((resolve) => setTimeout(resolve, delay));
      }
    }
  }

  throw new Error(`Failed to launch browser after ${maxRetries} attempts: ${lastError?.message}`);
}

function addDebugStep(debugSteps: string[], message: string): void {
  if (!INVOICE_DEBUG) return;
  const ts = new Date().toISOString();
  const line = `[${ts}] ${message}`;
  debugSteps.push(line);
  console.log(`[INVOICE-GEN] ${line}`);
}

function getCredentials() {
  const login = process.env.INVOICE_PANEL_LOGIN;
  const password = process.env.INVOICE_PANEL_PASSWORD;

  if (!login || !password) {
    throw new Error('Brak danych logowania. Ustaw INVOICE_PANEL_LOGIN i INVOICE_PANEL_PASSWORD w .env.local');
  }

  return { login, password };
}

function getStartInvoiceId(): number {
  const value = process.env.INVOICE_START_ID;
  if (!value) return DEFAULT_START_ID;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_START_ID;
}

function mergeCookieHeaders(existingHeader: string, setCookieValues: string[]): string {
  const cookieMap = new Map<string, string>();

  if (existingHeader) {
    for (const part of existingHeader.split(';')) {
      const trimmed = part.trim();
      if (!trimmed) continue;
      const [name, ...rest] = trimmed.split('=');
      cookieMap.set(name, rest.join('='));
    }
  }

  for (const cookie of setCookieValues) {
    const [cookiePair] = cookie.split(';');
    const [name, ...rest] = cookiePair.split('=');
    cookieMap.set(name.trim(), rest.join('=').trim());
  }

  return Array.from(cookieMap.entries())
    .map(([name, value]) => `${name}=${value}`)
    .join('; ');
}

function getSetCookieValues(response: Response): string[] {
  const headersAny = response.headers as Headers & {
    getSetCookie?: () => string[];
  };

  if (typeof headersAny.getSetCookie === 'function') {
    const values = headersAny.getSetCookie();
    if (Array.isArray(values)) {
      return values;
    }
  }

  const single = response.headers.get('set-cookie');
  return single ? [single] : [];
}

function isLoginPage(html: string): boolean {
  return /name=["']panel_login["']/i.test(html) || /Zaloguj się/i.test(html);
}

function extractHtmlTitle(html: string): string {
  const match = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  return (match?.[1] || '').replace(/\s+/g, ' ').trim();
}

function extractHiddenInputs(html: string): Record<string, string> {
  const inputs: Record<string, string> = {};
  const hiddenInputRegex = /<input[^>]*type=["']hidden["'][^>]*>/gi;
  const elements = html.match(hiddenInputRegex) || [];

  for (const element of elements) {
    const nameMatch = element.match(/name=["']([^"']+)["']/i);
    if (!nameMatch) continue;
    const valueMatch = element.match(/value=["']([^"']*)["']/i);
    inputs[nameMatch[1]] = valueMatch ? valueMatch[1] : '';
  }

  return inputs;
}

async function fetchWithCookies(
  url: string,
  init: Omit<RequestInit, 'redirect'> & { redirect?: RequestRedirect },
  cookieHeader: string,
  debugSteps: string[],
  label: string
): Promise<{ response: Response; text: string; cookieHeader: string; finalUrl: string }> {
  let currentUrl = url;
  let currentMethod = init.method || 'GET';
  let currentBody = init.body;
  const baseHeaders = new Headers(init.headers || {});
  let mergedCookieHeader = cookieHeader;

  for (let i = 0; i < 10; i += 1) {
    const headers = new Headers(baseHeaders);
    if (!headers.has('user-agent')) {
      headers.set('user-agent', BROWSER_UA);
    }
    if (!headers.has('accept')) {
      headers.set('accept', 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8');
    }
    if (!headers.has('accept-language')) {
      headers.set('accept-language', 'pl-PL,pl;q=0.9,en-US;q=0.8,en;q=0.7');
    }
    if (mergedCookieHeader) {
      headers.set('cookie', mergedCookieHeader);
    }

    const response = await fetch(currentUrl, {
      ...init,
      method: currentMethod,
      body: currentBody,
      headers,
      redirect: 'manual',
    });

    mergedCookieHeader = mergeCookieHeaders(mergedCookieHeader, getSetCookieValues(response));
    addDebugStep(debugSteps, `${label}: hop=${i + 1}, status=${response.status}, url=${currentUrl}`);

    const isRedirect = [301, 302, 303, 307, 308].includes(response.status);
    const location = response.headers.get('location');

    if (isRedirect && location) {
      currentUrl = new URL(location, currentUrl).toString();
      if (response.status === 303 || ((response.status === 301 || response.status === 302) && currentMethod === 'POST')) {
        currentMethod = 'GET';
        currentBody = undefined;
        baseHeaders.delete('content-type');
      }
      continue;
    }

    const text = await response.text();

    // IdoSell/panel czasem zwraca stronę synchronizacji cookie z JS/meta redirectem.
    // Przeglądarka przechodzi dalej automatycznie, fetch nie - obsługujemy to ręcznie.
    const cookieSyncSources = [
      ...text.matchAll(/src=["'](https?:\/\/[^"']+\/cookie\/\?keyEnd=[^"']+)["']/gi),
    ].map((m) => m[1]);

    const jsRedirectMatch =
      text.match(/window\.location(?:\.href)?\s*=\s*["']([^"']+)["']/i) ||
      text.match(/location\.replace\(["']([^"']+)["']\)/i);
    const metaRedirectMatch = text.match(/http-equiv=["']refresh["'][^>]*content=["'][^"']*url=([^"']+)/i);
    const redirectTarget = jsRedirectMatch?.[1] || metaRedirectMatch?.[1];

    if (cookieSyncSources.length > 0 || redirectTarget) {
      addDebugStep(
        debugSteps,
        `${label}: detected cookie-sync page (cookieCalls=${cookieSyncSources.length}, redirect=${Boolean(redirectTarget)})`
      );

      for (const syncUrl of cookieSyncSources) {
        const syncResponse = await fetch(syncUrl, {
          method: 'GET',
          headers: {
            'user-agent': BROWSER_UA,
            accept: '*/*',
            ...(mergedCookieHeader ? { cookie: mergedCookieHeader } : {}),
          },
          redirect: 'manual',
        });
        mergedCookieHeader = mergeCookieHeaders(mergedCookieHeader, getSetCookieValues(syncResponse));
      }

      if (redirectTarget) {
        currentUrl = new URL(redirectTarget, currentUrl).toString();
        currentMethod = 'GET';
        currentBody = undefined;
        baseHeaders.delete('content-type');
        continue;
      }

      // Brak jawnego redirectu: po sync cookie ponawiamy ten sam adres.
      currentMethod = 'GET';
      currentBody = undefined;
      baseHeaders.delete('content-type');
      continue;
    }

    return { response, text, cookieHeader: mergedCookieHeader, finalUrl: currentUrl };
  }

  throw new Error('Zbyt wiele przekierowań podczas żądania do panelu.');
}

function extractLoginFormConfig(html: string, baseUrl: string): {
  actionUrl: string;
  loginField: string;
  passwordField: string;
} {
  const forms = html.match(/<form[\s\S]*?<\/form>/gi) || [];
  const loginForm = forms.find((form) => /type=["']password["']/i.test(form)) || '';

  const actionMatch = loginForm.match(/action=["']([^"']+)["']/i);
  const actionUrl = actionMatch ? new URL(actionMatch[1], baseUrl).toString() : baseUrl;

  const passwordNameMatch = loginForm.match(/<input[^>]*type=["']password["'][^>]*name=["']([^"']+)["']/i);
  const passwordField = passwordNameMatch?.[1] || 'panel_password';

  const textInputMatches = [
    ...loginForm.matchAll(/<input[^>]*type=["'](?:text|email)["'][^>]*name=["']([^"']+)["']/gi),
  ];
  const preferredLogin = textInputMatches.find((m) => /login|email|user/i.test(m[1]))?.[1];
  const loginField = preferredLogin || textInputMatches[0]?.[1] || 'panel_login';

  return { actionUrl, loginField, passwordField };
}

async function loginAndGetCookieHeader(debugSteps: string[]): Promise<string> {
  const { login, password } = getCredentials();
  addDebugStep(debugSteps, `Login start: loginSet=${Boolean(login)}, passwordSet=${Boolean(password)}`);

  const loginPage = await fetchWithCookies(PANEL_LOGIN_URL, { method: 'GET' }, '', debugSteps, 'GET login page');

  if (!loginPage.response.ok) {
    throw new Error('Nie udało się otworzyć strony logowania do panelu.');
  }

  let cookieHeader = loginPage.cookieHeader;
  addDebugStep(debugSteps, `Cookies after GET login page: length=${cookieHeader.length}`);
  const hiddenInputs = extractHiddenInputs(loginPage.text);
  const loginFormConfig = extractLoginFormConfig(loginPage.text, loginPage.finalUrl);
  addDebugStep(debugSteps, `Hidden inputs found on login page: ${Object.keys(hiddenInputs).length}`);
  addDebugStep(
    debugSteps,
    `Login form parsed: action=${loginFormConfig.actionUrl}, loginField=${loginFormConfig.loginField}, passwordField=${loginFormConfig.passwordField}`
  );

  const body = new URLSearchParams();
  for (const [key, value] of Object.entries(hiddenInputs)) {
    body.set(key, value);
  }
  body.set(loginFormConfig.loginField, login);
  body.set(loginFormConfig.passwordField, password);
  body.set('panel_login', login);
  body.set('panel_password', password);

  const submit = await fetchWithCookies(loginFormConfig.actionUrl, {
    method: 'POST',
    headers: {
      'content-type': 'application/x-www-form-urlencoded',
      origin: 'https://defender.net.pl',
      referer: loginPage.finalUrl,
    },
    body: body.toString(),
  }, cookieHeader, debugSteps, 'POST login form');

  if (!submit.response.ok) {
    throw new Error('Logowanie do panelu nie powiodło się.');
  }

  cookieHeader = submit.cookieHeader;
  addDebugStep(debugSteps, `Cookies after POST login: length=${cookieHeader.length}`);

  const submitTitle = extractHtmlTitle(submit.text);
  if (submitTitle) {
    addDebugStep(debugSteps, `POST login title: ${submitTitle}`);
  }

  // Nie wymuszamy walidacji przez wejście na /panel/, bo dla części kont
  // poprawna sesja działa dopiero na bezpośrednich URL-ach akcji/list.
  if (isLoginPage(submit.text)) {
    addDebugStep(debugSteps, 'POST login returned login-like HTML, proceeding with cookies to target list URL.');
  }

  if (!cookieHeader) {
    throw new Error('Logowanie zakończone bez sesji cookie.');
  }

  return cookieHeader;
}

function parseInvoiceNumber(html: string, preferredShop?: InvoiceShop): string {
  const allDocNumbers = Array.from(
    html.matchAll(/\b((?:MOTO|DEF|FV)\/[0-9]+\/[0-9]{2}\/[0-9]{4})\b/gi)
  ).map((m) => m[1].trim());

  if (preferredShop === 'defender') {
    const defMatch = allDocNumbers.find((n) => /^DEF\//i.test(n));
    if (defMatch) return defMatch;
  }

  if (preferredShop === 'moto-tour') {
    const motoMatch = allDocNumbers.find((n) => /^MOTO\//i.test(n));
    if (motoMatch) return motoMatch;
  }

  const patterns = [
    /Numer faktury[\s\S]{0,250}?<b>\s*([^<]+)\s*<\/b>/i,
    /Dokument nr\s*([^<\s]+)/i,
    /(DEF\/\d+\/\d{2}\/\d{4})/i,
    /(MOTO\/\d+\/\d{2}\/\d{4})/i,
    /(FV\/\d+\/PL\/\d{4})/i,
  ];

  for (const pattern of patterns) {
    const match = html.match(pattern);
    if (match && match[1]) {
      return match[1].trim();
    }
  }

  return allDocNumbers[0] || 'UNKNOWN';
}

function parseShop(html: string): InvoiceShop {
  if (/Moto-Tour/i.test(html)) return 'moto-tour';
  if (/DEFENDER/i.test(html)) return 'defender';
  return 'unknown';
}

function isInvoiceDetailHtml(html: string): boolean {
  const normalized = html.toLowerCase();

  // Lista dokumentów zawiera kolumny z wieloma pozycjami i akcjami [ pokaż ] - to nie jest detal faktury.
  const looksLikeList =
    normalized.includes('magzayn odbiorcy') ||
    normalized.includes('[ pokaż ]') ||
    normalized.includes('invoices-vat.php');

  const hasDetailMarkers =
    /nazwa towaru lub usługi|stawka vat|kwota brutto|wartość netto|faktura vat|numer faktury/i.test(html);

  const hasLineItemsTable = /nazwa towaru lub usługi/i.test(html);

  return hasDetailMarkers && (hasLineItemsTable || !looksLikeList);
}

function stripHtml(text: string): string {
  return text
    .replace(/<br\s*\/?>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/\s+/g, ' ')
    .trim();
}

function parseBestInvoiceTableRows(html: string): Array<Record<string, string>> {
  const cleaned = html
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<style[\s\S]*?<\/style>/gi, '');

  const tableMatches = [...cleaned.matchAll(/<table[^>]*>([\s\S]*?)<\/table>/gi)];
  if (tableMatches.length === 0) return [];

  type TableCandidate = { score: number; rows: string[][] };
  const candidates: TableCandidate[] = [];

  for (const tableMatch of tableMatches) {
    const tableHtml = tableMatch[0];
    const rowMatches = [...tableHtml.matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/gi)];
    const rows: string[][] = [];

    for (const rowMatch of rowMatches) {
      const rowHtml = rowMatch[1];
      const cellMatches = [...rowHtml.matchAll(/<(td|th)[^>]*>([\s\S]*?)<\/\1>/gi)];
      const cells = cellMatches.map((m) => stripHtml(m[2]));
      if (cells.some((cell) => cell.length > 0)) {
        rows.push(cells);
      }
    }

    if (rows.length < 2) continue;

    const flat = rows.flat().join(' ').toLowerCase();
    const headerLike = rows[0].join(' ').toLowerCase();
    const keywordScore =
      (/(nazwa|towar|produkt|pozycja)/.test(flat) ? 4 : 0) +
      (/(ilo[sś]c|qty|quantity)/.test(flat) ? 3 : 0) +
      (/(netto|brutto|vat|stawka|cena|warto[sś]c)/.test(flat) ? 4 : 0) +
      (/(razem|suma|total)/.test(flat) ? 2 : 0) +
      (/(nazwa|towar|produkt|pozycja|ilo[sś]c|netto|brutto|vat|cena)/.test(headerLike) ? 3 : 0) +
      (/nazwa towaru lub usługi/.test(headerLike) ? 8 : 0) +
      (/numer faktury|magzayn odbiorcy|\[ dodaj \]/.test(headerLike) ? -10 : 0);

    const score = keywordScore * 10 + rows.length * 2 + Math.max(...rows.map((r) => r.length));
    candidates.push({ score, rows });
  }

  if (candidates.length === 0) return [];
  const best = candidates.sort((a, b) => b.score - a.score)[0];

  const [headerRowRaw, ...dataRowsRaw] = best.rows;
  const columnCount = Math.max(...best.rows.map((r) => r.length));

  const headerRow = Array.from({ length: columnCount }, (_, index) => {
    const raw = (headerRowRaw[index] || '').trim();
    return raw || `Kolumna_${index + 1}`;
  });

  const normalizedHeaders = headerRow.map((header, index) => {
    const duplicateCount = headerRow.slice(0, index).filter((h) => h === header).length;
    return duplicateCount > 0 ? `${header}_${duplicateCount + 1}` : header;
  });

  const columnsToKeep = Array.from({ length: columnCount }, (_, index) => {
    const header = normalizedHeaders[index];
    const hasAnyData = dataRowsRaw.some((row) => ((row[index] || '').trim().length > 0));
    const isTechnicalHeader = /^Kolumna_\d+$/i.test(header);
    return hasAnyData || !isTechnicalHeader;
  });

  const effectiveHeaders = normalizedHeaders.map((header, index) => {
    if (!columnsToKeep[index]) return header;

    if (index === 0 && /^Kolumna_\d+$/i.test(header)) {
      const looksLikeIndexColumn = dataRowsRaw.every((row) => /^\d+$/.test((row[index] || '').trim()));
      if (looksLikeIndexColumn) {
        return 'Lp';
      }
    }

    return header;
  });

  const mappedRows = dataRowsRaw.map((row) => {
    const output: Record<string, string> = {};
    for (let i = 0; i < columnCount; i += 1) {
      if (!columnsToKeep[i]) continue;
      output[effectiveHeaders[i]] = (row[i] || '').trim();
    }
    return output;
  });

  const isTrailingSummaryRow = (row: Record<string, string>): boolean => {
    const text = Object.values(row).join(' ').toLowerCase();
    return /(\brazem\b|\bsuma\b|do zap[łl]aty|podsumowanie|\btotal\b)/i.test(text);
  };

  while (mappedRows.length > 0 && isTrailingSummaryRow(mappedRows[mappedRows.length - 1])) {
    mappedRows.pop();
  }

  return mappedRows;
}

async function fetchInvoiceHtml(invoiceId: number, cookieHeader: string): Promise<string | null> {
  const url = `${INVOICE_URL_BASE}/${invoiceId}`;
  const page = await fetchWithCookies(
    url,
    {
      method: 'GET',
      headers: {
        referer: PANEL_INVOICE_LIST_URL,
      },
    },
    cookieHeader,
    [],
    `GET invoice ${invoiceId}`
  );

  if (!page.response.ok) {
    return null;
  }

  const html = page.text;

  if (isLoginPage(html)) {
    return null;
  }

  if (!/Numer faktury|Dokument nr|Faktura VAT/i.test(html)) {
    return null;
  }

  return html;
}

async function probeInvoiceAccess(invoiceId: number, cookieHeader: string): Promise<'ok' | 'unauthorized' | 'not-found'> {
  const url = `${INVOICE_URL_BASE}/${invoiceId}`;
  const response = await fetch(url, {
    method: 'GET',
    headers: {
      'user-agent': BROWSER_UA,
      accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      'accept-language': 'pl-PL,pl;q=0.9,en-US;q=0.8,en;q=0.7',
      referer: PANEL_INVOICE_LIST_URL,
      ...(cookieHeader ? { cookie: cookieHeader } : {}),
    },
    redirect: 'follow',
  });

  if (!response.ok) {
    return 'not-found';
  }

  const html = await response.text();
  if (isLoginPage(html)) return 'unauthorized';
  if (!/Numer faktury|Dokument nr|Faktura VAT/i.test(html)) return 'not-found';
  return 'ok';
}

function extractInvoiceIdsFromListPage(html: string): number[] {
  const ids = new Set<number>();
  const regexes = [
    /href\s*=\s*["']\/whi\/invoice\/(\d+)(?:["'/?]|\b)/gi,
    /\/whi\/invoice\/(\d+)(?!\/(?:edit|delete))/gi,
    /\\\/whi\\\/invoice\\\/(\d+)/gi,
  ];

  for (const regex of regexes) {
    for (const match of html.matchAll(regex)) {
      const id = Number(match[1]);
      if (Number.isFinite(id) && id > 0) {
        ids.add(id);
      }
    }
  }

  return Array.from(ids).sort((a, b) => b - a);
}

function extractPositionActionUrls(html: string): string[] {
  const urls = new Set<string>();
  const pushUrl = (raw: string | undefined) => {
    if (!raw) return;
    const trimmed = raw.trim();
    if (!trimmed) return;
    if (/^(javascript:|#|mailto:)/i.test(trimmed)) return;
    urls.add(trimmed);
  };

  for (const match of html.matchAll(/href\s*=\s*["']([^"']+)["']/gi)) {
    pushUrl(match[1]);
  }

  for (const match of html.matchAll(/data-(?:href|url|action)\s*=\s*["']([^"']+)["']/gi)) {
    pushUrl(match[1]);
  }

  for (const match of html.matchAll(/(?:window\.open|window\.location(?:\.href)?|location\.href|location\.assign|location\.replace)\s*\(?\s*["']([^"']+)["']/gi)) {
    pushUrl(match[1]);
  }

  return Array.from(urls);
}

function toAbsolutePanelUrl(inputUrl: string): string {
  return new URL(inputUrl, 'https://defender.net.pl').toString();
}

function prioritizeLikelyInvoiceActions(urls: string[]): string[] {
  const scored = urls
    .map((url) => {
      const lower = url.toLowerCase();
      let score = 0;
      if (lower.includes('/whi/invoice/')) score += 100;
      if (lower.includes('invoice')) score += 25;
      if (lower.includes('faktur') || lower.includes('faktura')) score += 25;
      if (lower.includes('application') || lower.includes('position')) score += 10;
      if (lower.includes('/panel/action/')) score += 5;
      if (lower.includes('/application/2')) score += 50;
      return { url, score };
    })
    .sort((a, b) => b.score - a.score || a.url.localeCompare(b.url));

  return scored
    .filter((item) => {
      const lower = item.url.toLowerCase();
      return (
        lower.includes('/whi/invoice/') ||
        lower.includes('/application/2') ||
        lower.includes('invoice') ||
        lower.includes('faktur') ||
        lower.includes('faktura')
      );
    })
    .map((item) => item.url);
}

function extractInvoiceIdFromUrl(url: string): number | null {
  const match = url.match(/\/whi\/invoice\/(\d+)(?:[/?#]|$)/i);
  if (!match) return null;
  const id = Number(match[1]);
  return Number.isFinite(id) && id > 0 ? id : null;
}

function extractInvoiceIdsFromAnyText(text: string): number[] {
  const ids = new Set<number>();
  for (const match of text.matchAll(/\/whi\/invoice\/(\d+)(?:[/?#]|$)/gi)) {
    const id = Number(match[1]);
    if (Number.isFinite(id) && id > 0) {
      ids.add(id);
    }
  }
  return Array.from(ids).sort((a, b) => b - a);
}

async function fetchLatestInvoicesByBrowser(debugSteps: string[]): Promise<InvoiceRecord[]> {
  const { login, password } = getCredentials();
  const browser = await launchInvoiceBrowser();

  try {
    const context = await browser.newContext({
      userAgent: BROWSER_UA,
      locale: 'pl-PL',
      viewport: { width: 1440, height: 900 },
    });

    const page = await context.newPage();
    const foundIds = new Set<number>();
    const recordsById = new Map<number, InvoiceRecord>();

    const collectIdFromUrl = (url: string) => {
      const id = extractInvoiceIdFromUrl(url);
      if (id) foundIds.add(id);
    };

    page.on('request', (request) => collectIdFromUrl(request.url()));
    page.on('response', (response) => collectIdFromUrl(response.url()));

    const collectRecordsFromHtml = (html: string, urlHint?: string) => {
      if (!isInvoiceDetailHtml(html)) return;

      const ids = new Set<number>();
      const idFromUrl = urlHint ? extractInvoiceIdFromUrl(urlHint) : null;
      if (idFromUrl) ids.add(idFromUrl);
      for (const id of extractInvoiceIdsFromAnyText(html)) {
        ids.add(id);
      }

      for (const id of ids) {
        if (!recordsById.has(id)) {
          recordsById.set(id, toInvoiceRecord(id, html));
        }
      }
    };

    const collectRecordIfInvoice = async (targetPage: { url: () => string; content: () => Promise<string> }) => {
      const currentUrl = targetPage.url();
      collectIdFromUrl(currentUrl);

      const html = await targetPage.content();
      collectRecordsFromHtml(html, currentUrl);
    };

    addDebugStep(
      debugSteps,
      `Browser mode: opening login page (headless=${BROWSER_HEADLESS}, slowMo=${Number.isFinite(BROWSER_SLOW_MO_MS) ? BROWSER_SLOW_MO_MS : 0}ms).`
    );
    await page.goto(PANEL_LOGIN_URL, { waitUntil: 'domcontentloaded', timeout: 60000 });

    const loginInput = page.locator('input[name="panel_login"], input[type="email"], input[type="text"]').first();
    const passInput = page.locator('input[name="panel_password"], input[type="password"]').first();
    await loginInput.fill(login);
    await passInput.fill(password);

    const submitButton = page.locator('button[type="submit"], input[type="submit"]').first();
    if ((await submitButton.count()) > 0) {
      await Promise.all([
        page.waitForLoadState('domcontentloaded', { timeout: 20000 }).catch(() => null),
        submitButton.click({ timeout: 10000 }),
      ]);
    } else {
      await passInput.press('Enter');
      await page.waitForLoadState('domcontentloaded', { timeout: 20000 }).catch(() => null);
    }

    addDebugStep(debugSteps, `Browser mode: after login title=${await page.title()}`);

    await page.goto(PANEL_INVOICE_LIST_URL, { waitUntil: 'domcontentloaded', timeout: 60000 });
    await page.waitForLoadState('networkidle', { timeout: 10000 }).catch(() => null);
    addDebugStep(debugSteps, `Browser mode: invoice list opened. title=${await page.title()}`);

    const html = await page.content();
    for (const id of extractInvoiceIdsFromListPage(html)) {
      foundIds.add(id);
    }

    const domInvoiceLinks = await page.evaluate(() => {
      return Array.from(document.querySelectorAll('a[href]'))
        .map((el) => (el as HTMLAnchorElement).href)
        .filter((href) => /\/whi\/invoice\/\d+/i.test(href));
    });

    for (const href of domInvoiceLinks) {
      const id = extractInvoiceIdFromUrl(href);
      if (id) foundIds.add(id);
    }

    addDebugStep(debugSteps, `Browser mode: IDs from DOM/network=${foundIds.size}`);

    // Klikamy tylko dokładnie link typu: <a href="/whi/invoice/1684" target="_new">pokaż</a>
    // i tylko takie elementy przetwarzamy.
    const frames = page.frames();
    addDebugStep(debugSteps, `Browser mode: frames=${frames.length}`);

    let strictCandidatesTotal = 0;
    for (const frame of frames) {
      const frameUrl = frame.url();
      if (frameUrl) {
        addDebugStep(debugSteps, `Browser mode: frame url=${frameUrl}`);
        collectIdFromUrl(frameUrl);
      }

      const textCandidates = frame
        .locator('a[href^="/whi/invoice/"], a[href*="/whi/invoice/"]')
        .filter({ hasText: /poka[zż]/i });

      const count = Math.min(await textCandidates.count(), 20);
      if (count === 0) continue;
      strictCandidatesTotal += count;

      addDebugStep(debugSteps, `Browser mode: strict invoice-link candidates in frame=${count}`);

      for (let i = 0; i < count && recordsById.size < 10; i += 1) {
        const target = textCandidates.nth(i);
        if (!(await target.isVisible().catch(() => false))) continue;

        const label = (await target.innerText().catch(() => '')).replace(/\s+/g, ' ').trim().slice(0, 100);
        const href = await target.getAttribute('href').catch(() => null);
        addDebugStep(debugSteps, `Browser mode: clicking invoice link href=${href || 'N/A'} text="${label}"`);

        const popupPromise = context.waitForEvent('page', { timeout: 2500 }).catch(() => null);
        await target.click({ timeout: 4000 }).catch(() => null);

        const popup = await popupPromise;
        if (popup) {
          await popup.waitForLoadState('domcontentloaded', { timeout: 15000 }).catch(() => null);
          await collectRecordIfInvoice(popup);
          await popup.close().catch(() => null);
        }

        await page.waitForTimeout(900);
        await collectRecordIfInvoice(page);

        const hrefAbsolute = href ? new URL(href, PANEL_LOGIN_URL).toString() : null;
        const hrefId = hrefAbsolute ? extractInvoiceIdFromUrl(hrefAbsolute) : null;

        // Gdy link ma target _new, a popup nie pojawił się (blokada/przejęcie zdarzenia),
        // otwieramy ten sam href w nowej karcie przeglądarki, aby pozyskać szczegóły dokumentu.
        if (hrefAbsolute && hrefId && !recordsById.has(hrefId)) {
          const probePage = await context.newPage();
          await probePage.goto(hrefAbsolute, { waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => null);
          await collectRecordIfInvoice(probePage);
          await probePage.close().catch(() => null);
        }

        const updatedFrameHtml = await frame.content().catch(() => '');
        if (updatedFrameHtml) {
          collectRecordsFromHtml(updatedFrameHtml, frame.url());
          for (const id of extractInvoiceIdsFromAnyText(updatedFrameHtml)) {
            foundIds.add(id);
          }
        }
      }
    }

    if (strictCandidatesTotal === 0) {
      addDebugStep(debugSteps, 'Browser mode: no strict invoice links with text "pokaż" found.');
    }

    for (const frame of frames) {
      const html = await frame.content().catch(() => '');
      if (!html) continue;
      collectRecordsFromHtml(html, frame.url());
      for (const id of extractInvoiceIdsFromAnyText(html)) {
        foundIds.add(id);
      }
    }

    const records = Array.from(recordsById.values()).sort((a, b) => b.invoiceId - a.invoiceId);
    addDebugStep(debugSteps, `Browser mode: collected invoice records=${records.length}`);
    return records;
  } finally {
    await browser.close();
  }
}

async function fetchInvoiceIdsFromPanelList(cookieHeader: string, debugSteps: string[]): Promise<number[]> {
  const page = await fetchWithCookies(
    PANEL_INVOICE_LIST_URL,
    {
      method: 'GET',
      headers: {
        referer: PANEL_LOGIN_URL,
      },
    },
    cookieHeader,
    debugSteps,
    'GET panel invoice list'
  );

  if (!page.response.ok) {
    throw new Error('Nie udało się pobrać listy faktur z panelu.');
  }

  if (isLoginPage(page.text)) {
    throw new Error('Brak dostępu do listy faktur po logowaniu (uprawnienia konta lub sesja).');
  }

  const plainMatches = page.text.match(/\/whi\/invoice\/\d+/gi) || [];
  addDebugStep(debugSteps, `Raw /whi/invoice/ID occurrences in HTML: ${plainMatches.length}`);

  const keywordHits = page.text.match(/faktur|faktura|invoice|application\/2|whi\/invoice/gi) || [];
  addDebugStep(debugSteps, `Keyword hits in panel list HTML: ${keywordHits.length}`);

  const directIds = extractInvoiceIdsFromListPage(page.text);
  addDebugStep(debugSteps, `Invoice IDs found directly in panel list: ${directIds.length}`);

  if (directIds.length > 0) {
    return directIds;
  }

  const actionUrlsRaw = extractPositionActionUrls(page.text);
  const actionUrls = prioritizeLikelyInvoiceActions(actionUrlsRaw).slice(0, 40);
  addDebugStep(debugSteps, `Action URLs extracted from list page: ${actionUrlsRaw.length}, candidates=${actionUrls.length}`);

  if (actionUrls.length > 0) {
    addDebugStep(debugSteps, `Top action candidates: ${actionUrls.slice(0, 8).join(' | ')}`);
  }

  const ids = new Set<number>();

  for (const rawUrl of actionUrls) {
    const absoluteUrl = toAbsolutePanelUrl(rawUrl);

    const immediateId = extractInvoiceIdFromUrl(absoluteUrl);
    if (immediateId) {
      ids.add(immediateId);
      if (ids.size >= 20) break;
      continue;
    }

    const actionPage = await fetchWithCookies(
      absoluteUrl,
      {
        method: 'GET',
        headers: {
          referer: PANEL_INVOICE_LIST_URL,
        },
      },
      cookieHeader,
      debugSteps,
      `GET action from position`
    );

    const finalId = extractInvoiceIdFromUrl(actionPage.finalUrl);
    if (finalId) {
      ids.add(finalId);
    }

    const nestedIds = extractInvoiceIdsFromListPage(actionPage.text);
    for (const id of nestedIds) {
      ids.add(id);
    }

    if (ids.size >= 20) {
      break;
    }
  }

  const idsSorted = Array.from(ids).sort((a, b) => b - a);
  addDebugStep(debugSteps, `Invoice IDs found via position actions: ${idsSorted.length}`);

  if (idsSorted.length === 0) {
    await writeDebugHtmlSnapshot('last-panel-list.html', page.text);
    const sample = page.text
      .slice(0, 3000)
      .replace(/\s+/g, ' ')
      .trim();
    addDebugStep(debugSteps, `Panel list HTML sample: ${sample}`);
  }

  return idsSorted;
}

function toInvoiceRecord(invoiceId: number, html: string): InvoiceRecord {
  const shop = parseShop(html);
  return {
    invoiceId,
    invoiceUrl: `${INVOICE_URL_BASE}/${invoiceId}`,
    invoiceNumber: parseInvoiceNumber(html, shop),
    shop,
    fetchedAt: new Date().toISOString(),
    tableRows: parseBestInvoiceTableRows(html),
  };
}

function pickLatest(records: InvoiceRecord[]): InvoiceRecord[] {
  const sorted = [...records].sort((a, b) => b.invoiceId - a.invoiceId);

  const byShop = new Map<InvoiceShop, InvoiceRecord>();
  for (const record of sorted) {
    if (!byShop.has(record.shop)) {
      byShop.set(record.shop, record);
    }
  }

  const preferred: InvoiceRecord[] = [];
  const moto = byShop.get('moto-tour');
  const defender = byShop.get('defender');

  if (moto) preferred.push(moto);
  if (defender) preferred.push(defender);

  if (preferred.length >= LATEST_INVOICES_LIMIT) {
    return preferred
      .sort((a, b) => b.invoiceId - a.invoiceId)
      .slice(0, LATEST_INVOICES_LIMIT);
  }

  const selected = [...preferred];
  for (const record of sorted) {
    if (selected.find((item) => item.invoiceId === record.invoiceId)) {
      continue;
    }
    selected.push(record);
    if (selected.length >= LATEST_INVOICES_LIMIT) {
      break;
    }
  }

  return selected.sort((a, b) => b.invoiceId - a.invoiceId).slice(0, LATEST_INVOICES_LIMIT);
}

async function findInvoicesByDirectProbe(startId: number, cookieHeader: string, debugSteps: string[]): Promise<InvoiceRecord[]> {
  const upperBound = startId + 50;
  const lowerBound = Math.max(1, startId - 180);
  const found: InvoiceRecord[] = [];
  let missesAfterFirstHit = 0;

  addDebugStep(debugSteps, `Direct probe fallback: range ${upperBound}..${lowerBound}`);

  for (let invoiceId = upperBound; invoiceId >= lowerBound; invoiceId -= 1) {
    const html = await fetchInvoiceHtml(invoiceId, cookieHeader);
    if (html) {
      found.push(toInvoiceRecord(invoiceId, html));
      missesAfterFirstHit = 0;

      if (found.length >= 8) {
        break;
      }
      continue;
    }

    if (found.length > 0) {
      missesAfterFirstHit += 1;
      if (missesAfterFirstHit >= 25) {
        break;
      }
    }
  }

  addDebugStep(debugSteps, `Direct probe fallback found invoices: ${found.length}`);
  return found.sort((a, b) => b.invoiceId - a.invoiceId);
}

function getStatusFilePath(): string {
  return path.join(process.cwd(), 'storage', 'invoice-generator', 'status.json');
}

async function ensureStatusDir(): Promise<void> {
  await fs.mkdir(path.dirname(getStatusFilePath()), { recursive: true });
}

export async function readInvoiceGeneratorStatus(): Promise<InvoiceGeneratorStatus> {
  // Jeśli mamy status w RAM, zwróć go
  if (inMemoryStatus) {
    return inMemoryStatus;
  }

  // Spróbuj czytać z pliku (tylko lokalnie)
  if (!IS_VERCEL) {
    try {
      await ensureStatusDir();
      const raw = await fs.readFile(getStatusFilePath(), 'utf-8');
      const parsed = JSON.parse(raw) as InvoiceGeneratorStatus;
      inMemoryStatus = {
        lastCheckedAt: parsed.lastCheckedAt ?? null,
        lastSuccessfulCheckAt: parsed.lastSuccessfulCheckAt ?? null,
        lastCheckedInvoiceId: parsed.lastCheckedInvoiceId ?? null,
        latestInvoices: Array.isArray(parsed.latestInvoices) ? parsed.latestInvoices : [],
        note: parsed.note,
        debugSteps: Array.isArray(parsed.debugSteps) ? parsed.debugSteps : [],
      };
      return inMemoryStatus;
    } catch {
      // Nie ma pliku, kontynuuj
    }
  }

  // Zwróć domyślny status
  const defaultStatus = {
    lastCheckedAt: null,
    lastSuccessfulCheckAt: null,
    lastCheckedInvoiceId: null,
    latestInvoices: [],
    debugSteps: [],
  };
  inMemoryStatus = defaultStatus;
  return defaultStatus;
}

async function writeInvoiceGeneratorStatus(status: InvoiceGeneratorStatus): Promise<void> {
  // Zawsze zapisz w RAM
  inMemoryStatus = status;

  // Spróbuj zapisać do pliku (lokalnie, zignoruj błędy na Vercel)
  if (!IS_VERCEL) {
    try {
      await ensureStatusDir();
      await fs.writeFile(getStatusFilePath(), JSON.stringify(status, null, 2), 'utf-8');
    } catch {
      // Zignoruj błędy zapisu do pliku
    }
  }
}

async function writeDebugHtmlSnapshot(fileName: string, html: string): Promise<void> {
  // Snapshoty HTML będą zapisywane tylko lokalnie
  if (IS_VERCEL) {
    return;
  }

  try {
    await ensureStatusDir();
    const filePath = path.join(path.dirname(getStatusFilePath()), fileName);
    await fs.writeFile(filePath, html, 'utf-8');
  } catch {
    // Zignoruj błędy zapisu
  }
}

export async function refreshInvoiceGeneratorStatus(forceStartId?: number): Promise<InvoiceGeneratorStatus> {
  const current = await readInvoiceGeneratorStatus();
  const nowIso = new Date().toISOString();
  const debugSteps: string[] = [];

  try {
    const startId = forceStartId ?? current.lastCheckedInvoiceId ?? getStartInvoiceId();
    addDebugStep(debugSteps, `Refresh start. startId=${startId}`);

    // Jedyna ścieżka: prawdziwa symulacja kliknięć w przeglądarce (bez HTTP fallbacku).
    try {
      const browserCandidates = await fetchLatestInvoicesByBrowser(debugSteps);
      if (browserCandidates.length > 0) {
        const latestInvoices = pickLatest(browserCandidates);
        const highestFound = Math.max(...browserCandidates.map((item) => item.invoiceId));

        const browserStatus: InvoiceGeneratorStatus = {
          lastCheckedAt: nowIso,
          lastSuccessfulCheckAt: latestInvoices.length > 0 ? nowIso : current.lastSuccessfulCheckAt,
          lastCheckedInvoiceId: highestFound,
          latestInvoices,
          note: latestInvoices.length === 0 ? 'Symulacja kliknięć nie zwróciła dokumentów.' : undefined,
          debugSteps,
        };
        await writeInvoiceGeneratorStatus(browserStatus);
        return browserStatus;
      }

      const failed: InvoiceGeneratorStatus = {
        ...current,
        lastCheckedAt: nowIso,
        note: 'Symulacja klikania nie znalazla dokumentow faktur.',
        debugSteps,
      };
      await writeInvoiceGeneratorStatus(failed);
      return failed;
    } catch (browserError) {
      const message = browserError instanceof Error ? browserError.message : 'unknown browser error';
      addDebugStep(debugSteps, `Browser mode failed: ${message}`);

      const failed: InvoiceGeneratorStatus = {
        ...current,
        lastCheckedAt: nowIso,
        note: `Blad symulacji klikania: ${message}`,
        debugSteps,
      };
      await writeInvoiceGeneratorStatus(failed);
      return failed;
    }
  } catch (error) {
    const note = error instanceof Error ? error.message : 'Nieznany błąd generatora faktur.';
    addDebugStep(debugSteps, `ERROR: ${note}`);

    const failed: InvoiceGeneratorStatus = {
      ...current,
      lastCheckedAt: nowIso,
      note,
      debugSteps,
    };
    await writeInvoiceGeneratorStatus(failed);
    return failed;
  }
}

export async function getInvoiceGeneratorStatus(options?: { forceRefresh?: boolean }): Promise<InvoiceGeneratorStatus> {
  const current = await readInvoiceGeneratorStatus();

  if (options?.forceRefresh) {
    return refreshInvoiceGeneratorStatus();
  }

  if (!current.lastCheckedAt) {
    return refreshInvoiceGeneratorStatus();
  }

  const lastCheck = new Date(current.lastCheckedAt).getTime();
  const now = Date.now();

  if (!Number.isFinite(lastCheck) || now - lastCheck >= CHECK_INTERVAL_MS) {
    return refreshInvoiceGeneratorStatus();
  }

  return current;
}

export function buildInvoiceXlsx(record: InvoiceRecord): Buffer {
  const workbook = XLSX.utils.book_new();

  const rows = record.tableRows && record.tableRows.length > 0
    ? record.tableRows
    : [
        {
          'Numer.Pelny': record.invoiceNumber,
          NumerDokumentu: record.invoiceNumber,
          Sklep: record.shop,
          Url: record.invoiceUrl,
          DataPobrania: record.fetchedAt,
        },
      ];

  const sheet = XLSX.utils.json_to_sheet(rows, { skipHeader: false });
  XLSX.utils.book_append_sheet(workbook, sheet, 'Dane');

  return XLSX.write(workbook, { type: 'buffer', bookType: 'xlsx' }) as Buffer;
}
