// Configuración de endpoints de los Nodos Nacionales (RACSEL) para los dashboards
// ServiceRequest (Interconsulta) y MedicationStatement (Reporte Medicamentos).
//
// IMPORTANTE — multi-nodo: por ahora se usa el Nodo Nacional PROPIO. A futuro, las consultas
// cross-border deben resolver rutas a los NN de OTROS países (Broadcast). Para eso está
// COUNTRY_ROUTES y el helper fhirBaseForCountry(): hoy devuelve el nacional propio, mañana
// la ruta del país correspondiente.
//
// Override en runtime: window.__MFE_CONFIG__ o variables de entorno (build).
//   RACSEL_NATIONAL_FHIR_BASE   base FHIR del NN propio (ej. https://hapinacional.../fhir)
//   RACSEL_BASIC_USER / RACSEL_BASIC_PASS   credenciales Basic (si el NN las exige)
//   RACSEL_COUNTRY_ROUTES        objeto { "PA": "https://nn-panama/fhir", ... } (multi-nodo)

const globalCfg = (typeof window !== 'undefined' && window.__MFE_CONFIG__) || {};
const env = (typeof process !== 'undefined' && process.env) || {};

const DEFAULT_NATIONAL_FHIR_BASE = 'https://hapinacional.nodonacionalph4h-dev.minsal.cl/fhir';
const DEFAULT_RESOURCE_FHIR_BASE = 'https://hapilocal.nodonacionalph4h-dev.minsal.cl/fhir';

export const NODES_CONFIG = {
  // Nodo Nacional propio (lectura de documentos MHD: DocumentReference + Bundle)
  NATIONAL_FHIR_BASE:
    (globalCfg.RACSEL_NATIONAL_FHIR_BASE || env.RACSEL_NATIONAL_FHIR_BASE || DEFAULT_NATIONAL_FHIR_BASE).replace(/\/$/, ''),
  // Nodo de RECURSOS clínicos sueltos (hapilocal) — para escribir/actualizar (ej. completar un ServiceRequest)
  RESOURCE_FHIR_BASE:
    (globalCfg.RACSEL_RESOURCE_FHIR_BASE || env.RACSEL_RESOURCE_FHIR_BASE || DEFAULT_RESOURCE_FHIR_BASE).replace(/\/$/, ''),
  BASIC_USER: globalCfg.RACSEL_BASIC_USER || env.RACSEL_BASIC_USER || '',
  BASIC_PASS: globalCfg.RACSEL_BASIC_PASS || env.RACSEL_BASIC_PASS || '',
  // Rutas a NN de otros países (placeholder multi-nodo). Clave = código país (ISO alpha-2).
  COUNTRY_ROUTES: globalCfg.RACSEL_COUNTRY_ROUTES || env.RACSEL_COUNTRY_ROUTES || {},
};

// Base FHIR para un país dado (ISO alpha-2). Hoy: nacional propio si no hay ruta específica.
export function fhirBaseForCountry(countryCode) {
  const routes = NODES_CONFIG.COUNTRY_ROUTES || {};
  if (countryCode && routes[countryCode]) return String(routes[countryCode]).replace(/\/$/, '');
  return NODES_CONFIG.NATIONAL_FHIR_BASE;
}

export function buildAuthHeaders(accept = 'application/fhir+json') {
  const headers = { Accept: accept };
  const { BASIC_USER, BASIC_PASS } = NODES_CONFIG;
  if (BASIC_USER && BASIC_PASS && typeof btoa === 'function') {
    headers.Authorization = 'Basic ' + btoa(`${BASIC_USER}:${BASIC_PASS}`);
  }
  return headers;
}

// Limpia prefijos de tipo del identificador (rut*, RUN*, PPN*, …) antes de usarlo en búsquedas.
export function cleanIdentifier(value) {
  return String(value || '').replace(/^[A-Za-z]+\*/, '').trim();
}

// Códigos LOINC del DocumentReference por tipo de documento RACSEL
export const DOC_TYPE = {
  INTERCONSULTA: '11488-4',      // LACCompositionIT  (Consultation note)
  MEDICATION_REPORT: '56445-0',  // LACCompositionMeOw (Medication summary)
};

// Flujo RESOURCE-based: la interconsulta viaja como ServiceRequest suelto (LACServiceRequestIT),
// NO como documento. Se consulta el recurso vivo en el NN para reflejar el estado (active/completed)
// que muta con el PUT de "Completar" (Track 1.2-G). Devuelve [{ resource }].
export async function fetchServiceRequestsByPatient(axiosInst, identifier) {
  const base = NODES_CONFIG.NATIONAL_FHIR_BASE;
  const id = cleanIdentifier(identifier);
  if (!id) return [];
  const url =
    `${base}/ServiceRequest?patient.identifier=${encodeURIComponent(id)}` +
    `&_sort=-authoredOn&_count=50`;
  const res = await axiosInst.get(url, { headers: buildAuthHeaders() });
  return (res.data && res.data.entry ? res.data.entry : [])
    .map((e) => e.resource)
    .filter((r) => r && r.resourceType === 'ServiceRequest')
    .map((r) => ({ resource: r }));
}

// Flujo document-based (igual que el dashboard IPS): consulta DocumentReference por
// patient.identifier + type en el NN, baja cada Bundle (content.attachment.url) y extrae
// los recursos del tipo pedido desde adentro. Devuelve [{ resource, docRef, bundleUrl }].
export async function fetchResourcesFromDocs(axiosInst, identifier, typeCode, resourceType) {
  const base = NODES_CONFIG.NATIONAL_FHIR_BASE;
  const id = cleanIdentifier(identifier);
  if (!id) return [];
  const drUrl =
    `${base}/DocumentReference?patient.identifier=${encodeURIComponent(id)}` +
    `&type=${encodeURIComponent(typeCode)}&_sort=-_lastUpdated&_count=50`;
  const drRes = await axiosInst.get(drUrl, { headers: buildAuthHeaders() });
  const docRefs = (drRes.data && drRes.data.entry ? drRes.data.entry : [])
    .map((e) => e.resource)
    .filter((r) => r && r.resourceType === 'DocumentReference');

  const out = [];
  for (const dr of docRefs) {
    let url = (dr.content || []).map((c) => c && c.attachment && c.attachment.url).find(Boolean);
    if (!url) continue;
    if (!/^https?:\/\//i.test(url)) url = `${base}/${String(url).replace(/^\//, '')}`;
    try {
      const bRes = await axiosInst.get(url, { headers: buildAuthHeaders() });
      const entries = (bRes.data && bRes.data.entry) ? bRes.data.entry : [];
      for (const e of entries) {
        if (e.resource && e.resource.resourceType === resourceType) {
          out.push({ resource: e.resource, docRef: dr, bundleUrl: url });
        }
      }
    } catch (e) { /* documento inaccesible: se omite */ }
  }
  return out;
}
