// Configuración del dashboard de Reporte de Medicamentos (MeOw) — generación y lectura de QR.
// Override en runtime: window.__MFE_CONFIG__ o variables de entorno (build).
//   MEOW_GENERATE_URL   endpoint del mediador MeOw expuesto por OpenHIM (POST /meow/_generate)
//   MEOW_DECODE_URL     endpoint del mediador MeOw expuesto por OpenHIM (POST /meow/_decode)
//   MEOW_BASIC_USER / MEOW_BASIC_PASS   credenciales Basic hacia OpenHIM (si las exige)

const globalCfg = (typeof window !== 'undefined' && window.__MFE_CONFIG__) || {};
const env = (typeof process !== 'undefined' && process.env) || {};

export const MEOW_CONFIG = {
  GENERATE_URL:
    globalCfg.MEOW_GENERATE_URL || env.MEOW_GENERATE_URL ||
    'https://apiopenhim.nodonacionalph4h-dev.minsal.cl/meow/_generate',
  DECODE_URL:
    globalCfg.MEOW_DECODE_URL || env.MEOW_DECODE_URL ||
    'https://apiopenhim.nodonacionalph4h-dev.minsal.cl/meow/_decode',
  BASIC_USER: globalCfg.MEOW_BASIC_USER || env.MEOW_BASIC_USER || '',
  BASIC_PASS: globalCfg.MEOW_BASIC_PASS || env.MEOW_BASIC_PASS || '',
};

export function buildMeowAuthHeaders(accept = 'application/json') {
  const headers = { Accept: accept };
  const { BASIC_USER, BASIC_PASS } = MEOW_CONFIG;
  if (BASIC_USER && BASIC_PASS && typeof btoa === 'function') {
    headers.Authorization = 'Basic ' + btoa(`${BASIC_USER}:${BASIC_PASS}`);
  }
  return headers;
}

// Extrae el id del Bundle desde una URL FHIR tipo ".../Bundle/18" (o ".../Bundle/18/_history/2").
export function extractBundleId(bundleUrl) {
  const m = String(bundleUrl || '').match(/\/Bundle\/([^/?]+)/i);
  return m ? m[1] : null;
}

// Extrae el payload MeOw (claim -7) del objeto "decoded" que devuelve /meow/_decode.
// Estructura real observada: { cose: {...}, diagnostics: {...}, hcert: null,
//   payload: { "1": iss, "4": exp, "6": iat, "-260": { "-7": { n, dob, s, id, dt, m: [...] } } } }
// Se soporta también decoded["-260"] directo por si el mediador cambia el nivel de anidamiento.
export function extractMeowPayload(decoded) {
  const claims = (decoded && decoded.payload) || decoded;
  const hcert = claims && claims['-260'];
  if (!hcert || typeof hcert !== 'object') return null;
  if (hcert['-7'] && typeof hcert['-7'] === 'object') return hcert['-7'];
  const first = Object.values(hcert).find((v) => v && typeof v === 'object');
  return first || null;
}
