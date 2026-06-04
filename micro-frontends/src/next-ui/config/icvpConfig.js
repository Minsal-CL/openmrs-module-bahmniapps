// Valores de configuración específicos del dashboard IPS-ICVP.
// En producción, reemplazar estos valores mediante variables de entorno,
// el archivo micro-frontends/.env o proceso de build.
// Se soporta override mediante window.__MFE_CONFIG__ si existe.
//
// Variables admitidas:
//   ICVP_REGIONAL_BASE
//   ICVP_BASIC_USER
//   ICVP_BASIC_PASS
//   ICVP_VHL_ISSUANCE_URL
//   ICVP_VHL_RESOLVE_URL
//   ICVP_FROM_BUNDLE_URL

const globalCfg = (typeof window !== 'undefined' && window.__MFE_CONFIG__) || {};

export const ICVP_CONFIG = {
  REGIONAL_BASE:
    globalCfg.ICVP_REGIONAL_BASE || process.env.ICVP_REGIONAL_BASE ||
    'https://apiopenhim.nodonacionalph4h-dev.minsal.cl/regional',
  BASIC_USER:
    globalCfg.ICVP_BASIC_USER || process.env.ICVP_BASIC_USER || '',
  BASIC_PASS:
    globalCfg.ICVP_BASIC_PASS || process.env.ICVP_BASIC_PASS || '',
  VHL_ISSUANCE_URL:
    globalCfg.ICVP_VHL_ISSUANCE_URL || process.env.ICVP_VHL_ISSUANCE_URL ||
    'https://apiopenhim.nodonacionalph4h-dev.minsal.cl/vhl/_generate',
  VHL_RESOLVE_URL:
    globalCfg.ICVP_VHL_RESOLVE_URL || process.env.ICVP_VHL_RESOLVE_URL ||
    'https://apiopenhim.nodonacionalph4h-dev.minsal.cl/vhl/_resolve',
  ICVP_FROM_BUNDLE_URL:
    globalCfg.ICVP_FROM_BUNDLE_URL || process.env.ICVP_FROM_BUNDLE_URL ||
    'https://apiopenhim.nodonacionalph4h-dev.minsal.cl/icvpcert/_from-bundle',
  ICVP_BASE: globalCfg.ICVP_BASE || process.env.ICVP_BASE || 'signer.nodonacionalph4h-dev.minsal.cl'
};

export function buildBasicAuth() {
  const { BASIC_USER, BASIC_PASS } = ICVP_CONFIG;
  if (!BASIC_USER || !BASIC_PASS || typeof btoa !== 'function') {
    return '';
  }
  return 'Basic ' + btoa(`${BASIC_USER}:${BASIC_PASS}`);
}
