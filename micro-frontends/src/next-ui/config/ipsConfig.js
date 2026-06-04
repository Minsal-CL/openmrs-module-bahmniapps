// Valores de configuración específicos del dashboard IPS (sin ICVP).
// En producción, reemplazar estos valores mediante variables de entorno,
// el archivo micro-frontends/.env o window.__MFE_CONFIG__.
//
// Variables admitidas:
//   IPS_REGIONAL_BASE
//   IPS_BASIC_USER
//   IPS_BASIC_PASS
//   IPS_VHL_ISSUANCE_URL
//   IPS_VHL_RESOLVE_URL
//
// NO guardar credenciales en el repositorio.

const globalCfg = (typeof window !== 'undefined' && window.__MFE_CONFIG__) || {};
const DEFAULT_HOST = 'https://apiopenhim.nodonacionalph4h-dev.minsal.cl';
const DEFAULT_REGIONAL_BASE = `${DEFAULT_HOST}/regional`;

export const IPS_CONFIG = {
  REGIONAL_BASE:
    globalCfg.IPS_REGIONAL_BASE || process.env.IPS_REGIONAL_BASE || DEFAULT_REGIONAL_BASE,
  BASIC_USER:
    globalCfg.IPS_BASIC_USER || process.env.IPS_BASIC_USER || '',
  BASIC_PASS:
    globalCfg.IPS_BASIC_PASS || process.env.IPS_BASIC_PASS || '',
  VHL_ISSUANCE_URL:
    globalCfg.IPS_VHL_ISSUANCE_URL || process.env.IPS_VHL_ISSUANCE_URL ||
    `${DEFAULT_HOST}/vhl/_generate`,
  VHL_RESOLVE_URL:
    globalCfg.IPS_VHL_RESOLVE_URL || process.env.IPS_VHL_RESOLVE_URL ||
    `${DEFAULT_HOST}/vhl/_resolve`,
};

export function buildBasicAuth() {
  const { BASIC_USER, BASIC_PASS } = IPS_CONFIG;
  if (!BASIC_USER || !BASIC_PASS || typeof btoa !== 'function') {
    return '';
  }
  return 'Basic ' + btoa(`${BASIC_USER}:${BASIC_PASS}`);
}
