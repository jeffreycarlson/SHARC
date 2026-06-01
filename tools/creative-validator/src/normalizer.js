/**
 * @file Creative validator normalizer.
 *
 * Converts cleaned OpenRTB export rows into stable SHARC creative validator
 * test cases for the private hardening harness without changing the package
 * surface.
 */

import { Parser } from 'htmlparser2';

const SHARC_API_CODES = new Set([10, 11, 12]);
const MRAID_API_CODES = new Set([3, 5, 6]);
const OMID_API_CODES = new Set([7, 8, 9]);
const KNOWN_API_CODES = new Set([
  1, 2, 3, 5, 6, 7, 8, 9, 10, 11, 12,
]);
const EXECUTABLE_ADM_KINDS = new Set(['html', 'html-mraid', 'html-safeframe']);
const MEDIA_FIELDS = ['banner', 'video', 'native', 'audio'];
const MRAID_METHODS = [
  'addEventListener',
  'close',
  'createCalendarEvent',
  'expand',
  'getCurrentPosition',
  'getDefaultPosition',
  'getExpandProperties',
  'getMaxSize',
  'getPlacementType',
  'getResizeProperties',
  'getScreenSize',
  'getState',
  'getVersion',
  'isViewable',
  'open',
  'playVideo',
  'removeEventListener',
  'resize',
  'setExpandProperties',
  'setOrientationProperties',
  'setResizeProperties',
  'storePicture',
  'supports',
  'useCustomClose',
].join('|');
const MRAID_METHOD_RE = new RegExp(`\\bmraid\\s*\\.\\s*(${MRAID_METHODS})\\b`);
const OMID_VENDOR_SCRIPT_HOSTS = [
  {
    vendor: 'doubleverify',
    hosts: ['doubleverify.com'],
  },
  {
    vendor: 'ias',
    hosts: ['adsafeprotected.com', 'integralads.com', 'iasds01.com'],
  },
  {
    vendor: 'moat',
    hosts: ['moatads.com', 'moat.com'],
  },
  {
    vendor: 'oracle',
    hosts: ['oracle.com', 'oraclecloud.com', 'grapeshot.co.uk'],
  },
];
const INLINE_OMID_SIGNALS = [
  /\bomid3p\s*\.\s*(?:registerSessionObserver|addEventListener)\s*\(/i,
];
const INLINE_OMID_TOKEN_RE = /\bomid3p\b/i;
const MAX_OMID_ADM_SCAN_CHARS = 1_000_000;
const MAX_OMID_VENDOR_SCRIPT_MATCHES = 256;

function isPlainObject(value) {
  return value !== null
    && typeof value === 'object'
    && !Array.isArray(value);
}

/**
 * @typedef {object} NormalizedCase
 * @property {object} source
 * @property {object} ids
 * @property {object} creative
 * @property {object} bidSignals
 * @property {object} expectations
 * @property {object} sharcOptions
 */

/**
 * Sanitizes raw API framework declarations.
 *
 * @param {unknown[]} rawApis
 * @returns {number[]}
 */
function sanitizeApiDeclarations(rawApis) {
  if (!Array.isArray(rawApis)) return [];
  const seen = new Set();
  const out = [];
  for (const code of rawApis) {
    if (typeof code !== 'number' || !Number.isInteger(code)) continue;
    if (!KNOWN_API_CODES.has(code)) continue;
    if (seen.has(code)) continue;
    seen.add(code);
    out.push(code);
  }
  out.sort((a, b) => a - b);
  return out;
}

/**
 * @param {unknown} value
 * @returns {number[]|null}
 */
function normalizeApiValue(value) {
  if (Array.isArray(value)) {
    const filtered = value.filter((v) => typeof v === 'number' && Number.isInteger(v));
    return filtered.length > 0 ? filtered : null;
  }
  if (typeof value === 'number' && Number.isInteger(value)) return [value];
  return null;
}

/**
 * @param {number[]} codes
 * @returns {boolean}
 */
function hasAny(codes, set) {
  return codes.some((code) => set.has(code));
}

function safeHttpsUrl(value) {
  if (typeof value !== 'string' || !value.trim()) return null;
  try {
    const parsed = new URL(value.trim());
    if (parsed.protocol !== 'https:') return null;
    if (parsed.username || parsed.password) return null;
    return parsed.href;
  } catch (_) {
    return null;
  }
}

function sanitizeOptionalString(value) {
  return typeof value === 'string' && value.length > 0 ? value.slice(0, 500) : undefined;
}

function sanitizeVerificationScript(script) {
  if (!isPlainObject(script)) return null;
  const resourceUrl = safeHttpsUrl(script.resourceUrl || script.url);
  if (!resourceUrl) return null;

  const out = { resourceUrl };
  const vendor = sanitizeOptionalString(script.vendor);
  const verificationParameters = sanitizeOptionalString(script.verificationParameters);
  const accessMode = sanitizeOptionalString(script.accessMode);
  if (vendor !== undefined) out.vendor = vendor;
  if (verificationParameters !== undefined) out.verificationParameters = verificationParameters;
  if (accessMode !== undefined) out.accessMode = accessMode;
  return out;
}

function sanitizeOmidSidecar(value) {
  if (!isPlainObject(value) || !Array.isArray(value.verificationScripts)) return null;
  const scripts = value.verificationScripts
    .map((script) => sanitizeVerificationScript(script))
    .filter(Boolean);
  if (scripts.length === 0) return null;

  const out = { verificationScripts: scripts };
  for (const key of ['creativeType', 'impressionType', 'mediaType', 'contentUrl']) {
    const sanitized = key === 'contentUrl'
      ? safeHttpsUrl(value[key])
      : sanitizeOptionalString(value[key]);
    if (sanitized !== undefined && sanitized !== null) out[key] = sanitized;
  }
  if (isPlainObject(value.vastProperties)) {
    out.vastProperties = { ...value.vastProperties };
  }
  return out;
}

function extractOmidSidecar(bid) {
  const sources = [];
  const candidates = [
    ['bid.ext.measurement.omid', bid && bid.ext && bid.ext.measurement && bid.ext.measurement.omid],
    ['bid.ext.omid', bid && bid.ext && bid.ext.omid],
  ];

  for (const [path, value] of candidates) {
    const sidecar = sanitizeOmidSidecar(value);
    if (sidecar) {
      sources.push({ path, verificationScriptCount: sidecar.verificationScripts.length });
      return { sidecar, sources };
    }
  }
  return { sidecar: null, sources };
}

function hostMatchesSuffix(hostname, suffix) {
  return hostname === suffix || hostname.endsWith(`.${suffix}`);
}

function classifyOmidVendorScript(url) {
  if (!url || typeof url.hostname !== 'string' || !url.hostname) return null;
  const hostname = url.hostname;
  for (const pattern of OMID_VENDOR_SCRIPT_HOSTS) {
    if (pattern.hosts.some((host) => hostMatchesSuffix(hostname, host))) {
      return pattern.vendor;
    }
  }
  return null;
}

function sanitizeInlineVendorScriptUrl(value) {
  if (typeof value !== 'string' || !value.trim()) return null;
  const trimmed = value.trim();
  if (!/^https:\/\//i.test(trimmed)) return null;
  try {
    const parsed = new URL(trimmed);
    if (parsed.protocol !== 'https:') return null;
    const hostname = parsed.hostname
      ? parsed.hostname.toLowerCase().replace(/\.$/, '')
      : '';
    return {
      protocol: parsed.protocol,
      origin: parsed.origin === 'null' ? 'opaque' : parsed.origin,
      hostname,
      path: parsed.pathname.slice(0, 200),
      href: parsed.href,
    };
  } catch (_) {
    return null;
  }
}

function uniqueOmidVendorScripts(scripts) {
  const seen = new Set();
  const out = [];
  for (const script of scripts) {
    const key = `${script.vendor}\u001f${script.source}\u001f${script.value}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(script);
  }
  return out;
}

function isExecutableInlineScriptTag(attrs) {
  const type = attrs.type;
  if (!type) return true;
  const normalized = type.split(';')[0].trim().toLowerCase();
  return normalized === 'module'
    || normalized === 'text/javascript'
    || normalized === 'application/javascript'
    || normalized === 'application/ecmascript'
    || normalized === 'text/ecmascript';
}

function stripJsCommentsQuoteAware(source) {
  let out = '';
  let i = 0;
  let inString = '';
  let inLineComment = false;
  let inBlockComment = false;

  while (i < source.length) {
    const c = source[i];
    const next = source[i + 1];

    if (inLineComment) {
      if (c === '\n') {
        inLineComment = false;
        out += c;
      }
      i += 1;
      continue;
    }

    if (inBlockComment) {
      if (c === '*' && next === '/') {
        inBlockComment = false;
        i += 2;
      } else {
        i += 1;
      }
      continue;
    }

    if (inString) {
      if (c === '\\' && next !== undefined) {
        out += c + next;
        i += 2;
        continue;
      }
      if (c === inString) inString = '';
      out += c;
      i += 1;
      continue;
    }

    if (c === '/' && next === '/') {
      inLineComment = true;
      i += 2;
      continue;
    }

    if (c === '/' && next === '*') {
      inBlockComment = true;
      i += 2;
      continue;
    }

    if (c === '"' || c === "'" || c === '`') {
      inString = c;
      out += c;
      i += 1;
      continue;
    }

    out += c;
    i += 1;
  }

  return out;
}

function extractScriptTagSources(adm) {
  const sources = [];
  let inlineOmidSignalFound = false;
  const scanAdm = adm.length > MAX_OMID_ADM_SCAN_CHARS
    ? adm.slice(0, MAX_OMID_ADM_SCAN_CHARS)
    : adm;

  let inExecutableInlineScript = false;
  let currentInlineBuffer = '';
  function finishInlineScript() {
    if (!inExecutableInlineScript) return;
    const signalBody = INLINE_OMID_TOKEN_RE.test(currentInlineBuffer)
      ? stripJsCommentsQuoteAware(currentInlineBuffer)
      : '';
    if (!inlineOmidSignalFound
        && signalBody
        && INLINE_OMID_SIGNALS.some((re) => re.test(signalBody))) {
      inlineOmidSignalFound = true;
    }
    inExecutableInlineScript = false;
    currentInlineBuffer = '';
  }

  const parser = new Parser({
    onopentag(name, attrs) {
      if (!/^(?:[a-z][a-z0-9]*:)?script$/i.test(name)) return;
      finishInlineScript();
      if (attrs.src) {
        sources.push(attrs.src);
      } else if (isExecutableInlineScriptTag(attrs)) {
        inExecutableInlineScript = true;
        currentInlineBuffer = '';
      }
    },
    ontext(text) {
      if (inExecutableInlineScript) currentInlineBuffer += text;
    },
    onclosetag(name) {
      if (!/^(?:[a-z][a-z0-9]*:)?script$/i.test(name)) return;
      finishInlineScript();
    },
    onend() {
      finishInlineScript();
    },
  });
  parser.write(scanAdm);
  parser.end();

  return {
    sources,
    inlineOmidSignalFound,
    admTruncatedForScan: scanAdm.length < adm.length,
  };
}

function extractInlineOmidVendorScriptScan(adm) {
  if (typeof adm !== 'string' || !adm) {
    return {
      scripts: [],
      admTruncatedForScan: false,
      scriptTagLimitReached: false,
    };
  }
  const scan = extractScriptTagSources(adm);
  const scripts = [];
  let vendorScriptMatches = 0;
  let vendorMatchLimitReached = false;
  for (const src of scan.sources) {
    const url = sanitizeInlineVendorScriptUrl(src);
    const vendor = classifyOmidVendorScript(url);
    if (!vendor) continue;
    if (vendorScriptMatches >= MAX_OMID_VENDOR_SCRIPT_MATCHES) {
      vendorMatchLimitReached = true;
      continue;
    }
    vendorScriptMatches += 1;
    const value = url.href.slice(0, 500);
    scripts.push({
      vendor,
      source: 'adm-script-src',
      // Use parsed URL fields for comparisons; value is canonical report text.
      value,
      truncated: url.href.length > value.length,
      url,
    });
  }

  if (scan.inlineOmidSignalFound) {
    scripts.push({
      vendor: 'generic-omid3p',
      source: 'adm-inline-script',
      value: 'omid3p observer probe',
      url: null,
    });
  }

  return {
    scripts: uniqueOmidVendorScripts(scripts),
    admTruncatedForScan: scan.admTruncatedForScan,
    scriptTagLimitReached: vendorMatchLimitReached,
  };
}

function extractInlineOmidVendorScripts(adm) {
  return extractInlineOmidVendorScriptScan(adm).scripts;
}

/**
 * @param {string} s
 * @returns {object|null}
 */
function tryParseJson(s) {
  try {
    const parsed = JSON.parse(s);
    return parsed && typeof parsed === 'object' ? parsed : null;
  } catch (_) {
    return null;
  }
}

const BASE64_RE = /^[A-Za-z0-9+/\s=]+$/;

/**
 * Attempts conservative base64 decode. HTML and JSON text should not match
 * this path because they contain non-base64 punctuation.
 *
 * @param {string} s
 * @returns {string|null}
 */
function tryBase64Decode(s) {
  const trimmed = s.trim();
  if (trimmed.length < 50) return null;
  if (!BASE64_RE.test(trimmed)) return null;
  const compact = trimmed.replace(/\s+/g, '');
  if (compact.length % 4 === 1) return null;

  try {
    const buf = Buffer.from(compact, 'base64');
    if (buf.length === 0) return null;
    const decoded = buf.toString('utf8');
    const reencoded = Buffer.from(decoded, 'utf8').toString('base64');
    const withoutPadding = (value) => value.replace(/=+$/, '');
    if (withoutPadding(reencoded) !== withoutPadding(compact)) return null;

    const decodedPrefix = decoded.trimStart().slice(0, 20);
    if (!decodedPrefix.startsWith('<') && !decodedPrefix.startsWith('{')) return null;

    const sample = decoded.slice(0, 500);
    let printable = 0;
    for (let i = 0; i < sample.length; i++) {
      const code = sample.charCodeAt(i);
      if ((code >= 32 && code < 127) || code === 9 || code === 10 || code === 13) {
        printable++;
      }
    }
    if (sample.length > 0 && printable / sample.length < 0.8) return null;
    return decoded;
  } catch (_) {
    return null;
  }
}

/**
 * Unwraps known exchange wrapper shapes around bid.adm.
 *
 * @param {string} rawAdm
 * @returns {{adm: string, transformations: string[], nativeMeta: object|null}}
 */
function unwrapAdm(rawAdm) {
  let adm = typeof rawAdm === 'string' ? rawAdm.trim() : '';
  const transformations = [];
  let nativeMeta = null;

  const decoded = tryBase64Decode(adm);
  if (decoded !== null) {
    adm = decoded.trim();
    transformations.push('base64');
  }

  const parsed = tryParseJson(adm);
  if (!parsed) return { adm, transformations, nativeMeta };

  if (Array.isArray(parsed.renderables) && parsed.renderables.length > 0) {
    const renderable = parsed.renderables[0];
    if (renderable && typeof renderable.adm === 'string' && renderable.adm.trim()) {
      adm = renderable.adm.trim();
      transformations.push('renderables[0].adm');
      const inner = tryParseJson(adm);
      if (inner && typeof inner.adm === 'string') {
        nativeMeta = inner;
        adm = inner.adm.trim();
        transformations.push('inner.adm');
      }
      return { adm, transformations, nativeMeta };
    }
  }

  if (parsed.native || parsed.assets) {
    nativeMeta = parsed;
  } else if (typeof parsed.adm === 'string') {
    nativeMeta = parsed;
    adm = parsed.adm.trim();
    transformations.push('adm');
  }

  return { adm, transformations, nativeMeta };
}

/**
 * Classifies an adm payload for v0 execution.
 *
 * @param {string} adm
 * @returns {'html'|'html-mraid'|'html-safeframe'|'vast-xml'|'native-json'|'unknown'}
 */
function classifyAdmKind(adm) {
  if (!adm || typeof adm !== 'string') return 'unknown';
  const trimmed = adm.trim();
  const lower = trimmed.slice(0, 2000).toLowerCase();

  if (lower.startsWith('<?xml') || lower.includes('<vast')) return 'vast-xml';

  if (trimmed.startsWith('{')) {
    const parsed = tryParseJson(trimmed);
    if (parsed && (parsed.native || parsed.assets)) return 'native-json';
  }

  const looksHtml = lower.includes('<!doctype')
    || lower.includes('<html')
    || lower.includes('<body')
    || lower.includes('<script')
    || lower.includes('<div')
    || lower.includes('<iframe')
    || lower.includes('<style');
  if (!looksHtml) return 'unknown';

  if (lower.includes('$sf.ext') || lower.includes('safeframe')) {
    return 'html-safeframe';
  }
  if (lower.includes('mraid.js')
      || lower.includes('mraid.min.js')
      || lower.includes('window.mraid')
      || MRAID_METHOD_RE.test(lower)) {
    return 'html-mraid';
  }
  return 'html';
}

/**
 * @param {object|null} request
 * @param {object} bid
 * @returns {object|null}
 */
function resolvePlacement(request, bid) {
  if (!request || !Array.isArray(request.imp)) return null;
  return request.imp.find((imp) => imp && imp.id === bid.impid) || null;
}

/**
 * @param {object|null} placement
 * @returns {string[]}
 */
function mediaTypes(placement) {
  if (!placement || typeof placement !== 'object') return [];
  return MEDIA_FIELDS.filter((field) => placement[field]);
}

/**
 * @param {object|null} placement
 * @param {string|undefined} mtype
 * @returns {string|null}
 */
function primaryMediaField(placement, mtype) {
  if (!placement || typeof placement !== 'object') return null;
  if (mtype && placement[mtype]) return mtype;
  const present = mediaTypes(placement);
  return present.length === 1 ? present[0] : null;
}

/**
 * @param {object} bid
 * @param {object|null} placement
 * @param {string|undefined} mtype
 * @returns {{raw: number[], sanitized: number[], sources: object[]}}
 */
function extractApis(bid, placement, mtype) {
  const sources = [];
  const selectedRaw = [];

  function addSource(path, value, role) {
    const values = normalizeApiValue(value);
    if (!values) return;
    sources.push({ path, values: values.slice(), role });
    if (role !== 'context') selectedRaw.push(...values);
  }

  addSource('bid.apis', bid.apis, 'bid');
  addSource('bid.api', bid.api, 'bid');

  const primary = primaryMediaField(placement, mtype);
  for (const field of MEDIA_FIELDS) {
    const value = placement && placement[field] && placement[field].api;
    if (value === undefined) continue;
    const role = !primary || field === primary ? 'primary' : 'context';
    addSource(`imp.${field}.api`, value, role);
  }

  return {
    raw: selectedRaw.slice(),
    sanitized: sanitizeApiDeclarations(selectedRaw),
    sources,
  };
}

/**
 * @param {object} bid
 * @param {object|null} placement
 * @returns {{width: number|null, height: number|null}}
 */
function resolveDimensions(bid, placement) {
  let width = typeof bid.w === 'number' ? bid.w : null;
  let height = typeof bid.h === 'number' ? bid.h : null;
  const primary = primaryMediaField(placement, undefined);

  function applyMedia(media) {
    if (!media || typeof media !== 'object') return;
    if (width === null && typeof media.w === 'number') width = media.w;
    if (height === null && typeof media.h === 'number') height = media.h;
    if ((width === null || height === null)
        && Array.isArray(media.format)
        && media.format.length > 0) {
      const first = media.format[0];
      if (width === null && typeof first.w === 'number') width = first.w;
      if (height === null && typeof first.h === 'number') height = first.h;
    }
  }

  if (placement) {
    if (primary) applyMedia(placement[primary]);
    for (const field of MEDIA_FIELDS) applyMedia(placement[field]);
  }

  return { width, height };
}

/**
 * @param {object|null} placement
 * @returns {'inline'|'interstitial'}
 */
function resolvePlacementType(placement) {
  return placement && placement.instl === 1 ? 'interstitial' : 'inline';
}

/**
 * @param {number[]} apis
 * @param {string} admKind
 * @returns {{declared: string[], sniffed: string[]}}
 */
function resolveExpectations(apis, admKind) {
  const declared = [];
  const sniffed = [];

  if (hasAny(apis, MRAID_API_CODES)) declared.push('mraid');
  if (hasAny(apis, OMID_API_CODES)) declared.push('omid');
  if (hasAny(apis, SHARC_API_CODES)) declared.push('sharc');

  if (admKind === 'html-mraid') sniffed.push('mraid');
  if (admKind === 'html-safeframe') sniffed.push('safeframe');

  return { declared, sniffed };
}

/**
 * @param {string} mode
 * @param {string} admKind
 * @returns {{execute: boolean, skipReason: string|null}}
 */
function resolveExecution(mode, admKind) {
  if (mode === 'curl') {
    return { execute: false, skipReason: 'creative-url-mode-not-supported-v0' };
  }
  if (mode === 'ambiguous') {
    return { execute: false, skipReason: 'ambiguous-adm-and-curl' };
  }
  if (mode === 'missing') {
    return { execute: false, skipReason: 'missing-creative-payload' };
  }
  if (!EXECUTABLE_ADM_KINDS.has(admKind)) {
    return { execute: false, skipReason: `unsupported-adm-kind:${admKind}` };
  }
  return { execute: true, skipReason: null };
}

/**
 * @param {object} bid
 * @returns {string}
 */
function resolveMode(bid) {
  const hasAdm = typeof bid.adm === 'string' && bid.adm.trim().length > 0;
  const hasCurl = typeof bid.curl === 'string' && bid.curl.trim().length > 0;
  if (hasAdm && hasCurl) return 'ambiguous';
  if (hasAdm) return 'adm-html';
  if (hasCurl) return 'curl';
  return 'missing';
}

/**
 * @param {object} placement
 * @returns {object|null}
 */
function sanitizePlacement(placement) {
  if (!placement || typeof placement !== 'object') return null;
  return {
    id: placement.id || null,
    instl: placement.instl === 1 ? 1 : 0,
    secure: placement.secure === 1 ? 1 : 0,
    mediaTypes: mediaTypes(placement),
  };
}

/**
 * @param {object} row
 * @param {number} rowIndex
 * @param {object} auction
 * @param {number} auctionIndex
 * @param {object} bid
 * @param {object} options
 * @returns {NormalizedCase}
 */
function normalizeBid(row, rowIndex, auction, auctionIndex, bid, options) {
  const request = auction.bid_request || null;
  const response = auction.bid_response || {};
  const placement = resolvePlacement(request, bid);
  const mode = resolveMode(bid);
  const unwrapped = mode === 'adm-html'
    ? unwrapAdm(bid.adm)
    : { adm: '', transformations: [], nativeMeta: null };
  const admKind = mode === 'adm-html' ? classifyAdmKind(unwrapped.adm) : 'unknown';
  const apis = extractApis(bid, placement, auction.mtype);
  const dimensions = resolveDimensions(bid, placement);
  const placementType = resolvePlacementType(placement);
  const expectations = resolveExpectations(apis.sanitized, admKind);
  const execution = resolveExecution(mode, admKind);
  const creativeMeta = { apis: apis.sanitized.slice() };
  const omidDeclared = hasAny(apis.sanitized, OMID_API_CODES);
  const omidSidecar = extractOmidSidecar(bid);
  const inlineOmidVendorScan = mode === 'adm-html'
    ? extractInlineOmidVendorScriptScan(unwrapped.adm)
    : { scripts: [], admTruncatedForScan: false, scriptTagLimitReached: false };
  const inlineOmidVendorScripts = inlineOmidVendorScan.scripts;
  const omidMeasurement = {
    declaredByApi: omidDeclared,
    sidecarPresent: !!omidSidecar.sidecar,
    inlineVendorScriptPresent: inlineOmidVendorScripts.length > 0,
    inlineVendorScriptCount: inlineOmidVendorScripts.length,
    verificationScriptCount: omidSidecar.sidecar
      ? omidSidecar.sidecar.verificationScripts.length
      : 0,
    sources: omidSidecar.sources,
  };
  if (inlineOmidVendorScripts.length > 0) {
    omidMeasurement.inlineVendorVendors = [...new Set(inlineOmidVendorScripts.map((script) => script.vendor))].sort();
    omidMeasurement.inlineVendorScripts = inlineOmidVendorScripts;
  }
  if (inlineOmidVendorScan.admTruncatedForScan) {
    omidMeasurement.inlineVendorScanTruncated = true;
  }
  if (inlineOmidVendorScan.scriptTagLimitReached) {
    omidMeasurement.inlineVendorScriptTagLimitReached = true;
  }
  if (omidSidecar.sidecar) {
    creativeMeta.measurement = { omid: omidSidecar.sidecar };
  }

  return {
    source: {
      sourceFile: options.sourceFile || null,
      rowIndex,
      auctionId: row.id || null,
      auctionIndex,
      bidder: auction.bidder || null,
      mtype: auction.mtype || null,
    },
    ids: {
      requestId: request && request.id ? request.id : null,
      responseId: response.id || null,
      bidId: bid.id || null,
      impId: bid.impid || null,
      crid: bid.crid || null,
    },
    creative: {
      mode,
      admKind,
      html: mode === 'adm-html' ? unwrapped.adm : null,
      url: mode === 'curl' ? bid.curl.trim() : null,
      width: dimensions.width,
      height: dimensions.height,
      placementType,
      transformations: unwrapped.transformations,
    },
    bidSignals: {
      apis,
      mtype: auction.mtype || null,
      adomain: Array.isArray(bid.adomain) ? bid.adomain.slice() : [],
      cat: Array.isArray(bid.cat) ? bid.cat.slice() : [],
      battr: Array.isArray(bid.battr) ? bid.battr.slice() : [],
      attr: Array.isArray(bid.attr) ? bid.attr.slice() : [],
      placement: sanitizePlacement(placement),
      measurement: {
        omid: omidMeasurement,
      },
    },
    expectations: {
      declared: expectations.declared,
      sniffed: expectations.sniffed,
      execute: execution.execute,
      skipReason: execution.skipReason,
    },
    sharcOptions: {
      creativeMeta,
      requireSharcInit: hasAny(apis.sanitized, SHARC_API_CODES),
      placementType,
    },
  };
}

/**
 * Normalizes cleaned corpus rows.
 *
 * @param {object[]} rows
 * @param {{sourceFile?: string}} [options]
 * @returns {NormalizedCase[]}
 */
function normalizeCleanedCorpus(rows, options = {}) {
  if (!Array.isArray(rows)) {
    throw new TypeError('Cleaned corpus must be a JSON array.');
  }

  const cases = [];
  for (let rowIndex = 0; rowIndex < rows.length; rowIndex++) {
    const row = rows[rowIndex];
    if (!row || !Array.isArray(row.auction)) continue;

    for (let auctionIndex = 0; auctionIndex < row.auction.length; auctionIndex++) {
      const auction = row.auction[auctionIndex];
      const bids = auction
        && auction.bid_response
        && Array.isArray(auction.bid_response.seatbid)
        ? auction.bid_response.seatbid.flatMap((seat) => (
          seat && Array.isArray(seat.bid) ? seat.bid : []
        ))
        : [];

      for (const bid of bids) {
        if (bid && typeof bid === 'object') {
          cases.push(normalizeBid(row, rowIndex, auction, auctionIndex, bid, options));
        }
      }
    }
  }
  return cases;
}

/**
 * @param {NormalizedCase[]} cases
 * @returns {string}
 */
function toJsonl(cases) {
  return cases.map((item) => JSON.stringify(item)).join('\n') + (cases.length ? '\n' : '');
}

export {
  classifyAdmKind,
  extractInlineOmidVendorScripts,
  normalizeCleanedCorpus,
  sanitizeApiDeclarations,
  toJsonl,
  unwrapAdm,
};
