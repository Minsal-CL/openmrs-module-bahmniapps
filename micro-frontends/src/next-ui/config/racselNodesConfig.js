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

// Rutas a NN de otros países, hardcodeadas porque RACSEL_COUNTRY_ROUTES vía .env no se pudo levantar
// en el ambiente actual. Agregar un país nuevo = agregar su entrada aquí.
const DEFAULT_COUNTRY_ROUTES = {
  UY: 'https://lacpass-test.agesic.gub.uy/fhir',
};

// RACSEL_COUNTRY_ROUTES llega como string JSON desde .env/webpack (window.__MFE_CONFIG__ puede traerlo ya como objeto).
function parseCountryRoutes(value) {
  if (value && typeof value === 'object') return value;
  if (typeof value !== 'string' || !value.trim()) return null;
  try {
    const parsed = JSON.parse(value);
    return (parsed && typeof parsed === 'object') ? parsed : null;
  } catch (e) { return null; }
}

export const NODES_CONFIG = {
  // Nodo Nacional propio (lectura de documentos MHD: DocumentReference + Bundle)
  NATIONAL_FHIR_BASE:
    (globalCfg.RACSEL_NATIONAL_FHIR_BASE || env.RACSEL_NATIONAL_FHIR_BASE || DEFAULT_NATIONAL_FHIR_BASE).replace(/\/$/, ''),
  // Nodo de RECURSOS clínicos sueltos (hapilocal) — para escribir/actualizar (ej. completar un ServiceRequest)
  RESOURCE_FHIR_BASE:
    (globalCfg.RACSEL_RESOURCE_FHIR_BASE || env.RACSEL_RESOURCE_FHIR_BASE || DEFAULT_RESOURCE_FHIR_BASE).replace(/\/$/, ''),
  BASIC_USER: globalCfg.RACSEL_BASIC_USER || env.RACSEL_BASIC_USER || '',
  BASIC_PASS: globalCfg.RACSEL_BASIC_PASS || env.RACSEL_BASIC_PASS || '',
  // País propio (ISO alpha-2) del nodo nacional local.
  OWN_COUNTRY: globalCfg.RACSEL_OWN_COUNTRY || env.RACSEL_OWN_COUNTRY || 'CL',
  // Endpoint del mediador de contrarreferencia (arma el MHD). El dashboard le manda {narrativa, srRef, paciente}.
  // Ajustar a la URL pública real del OpenHIM que rutea al mediador 8020.
  CONTRARREF_ENDPOINT:
    (globalCfg.RACSEL_CONTRARREF_ENDPOINT || env.RACSEL_CONTRARREF_ENDPOINT ||
     'https://apiopenhim.nodonacionalph4h-dev.minsal.cl/forwardercontrarreferencia/_answer').replace(/\/$/, ''),
  // Rutas a NN de otros países. Clave = código país (ISO alpha-2), valor = base FHIR (…/fhir).
  // Ej: { "PA": "https://hapinacional-panama/fhir", "UY": "https://nn-uy/fhir" }.
  // Se puede sobreescribir vía RACSEL_COUNTRY_ROUTES (.env, JSON) o window.__MFE_CONFIG__ en runtime;
  // si no llega ninguno, se usa el default hardcodeado (DEFAULT_COUNTRY_ROUTES).
  COUNTRY_ROUTES: parseCountryRoutes(globalCfg.RACSEL_COUNTRY_ROUTES)
    || parseCountryRoutes(env.RACSEL_COUNTRY_ROUTES) || DEFAULT_COUNTRY_ROUTES,
};

// Base FHIR para un país dado (ISO alpha-2). Hoy: nacional propio si no hay ruta específica.
export function fhirBaseForCountry(countryCode) {
  const routes = NODES_CONFIG.COUNTRY_ROUTES || {};
  if (countryCode && routes[countryCode]) return String(routes[countryCode]).replace(/\/$/, '');
  return NODES_CONFIG.NATIONAL_FHIR_BASE;
}

// Lista de nodos nacionales a consultar (multi-nodo): el propio + los de COUNTRY_ROUTES.
// Cada entrada: { country, base }. Dedup por base. El nodo propio siempre está presente.
export function listNodes() {
  const routes = NODES_CONFIG.COUNTRY_ROUTES || {};
  const own = { country: NODES_CONFIG.OWN_COUNTRY, base: NODES_CONFIG.NATIONAL_FHIR_BASE };
  const others = Object.keys(routes).map((c) => ({ country: c, base: String(routes[c]).replace(/\/$/, '') }));
  const all = [own, ...others];
  const seen = new Set();
  return all.filter((n) => n.base && !seen.has(n.base) && seen.add(n.base));
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
  INTERCONSULTA: '11488-4',       // LACCompositionIT  (Consultation note) — type de la Composition
  CONTRARREFERENCIA: '57133-1',   // Referral note — type que el mediador estampa en el DocumentReference
  MEDICATION_REPORT: '56445-0',   // LACCompositionMeOw (Medication summary)
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
    `&_sort=-authored&_count=50`;
  const res = await axiosInst.get(url, { headers: buildAuthHeaders() });
  return (res.data && res.data.entry ? res.data.entry : [])
    .map((e) => e.resource)
    .filter((r) => r && r.resourceType === 'ServiceRequest')
    .map((r) => ({ resource: r }));
}

// Contrarreferencias (respuesta a la interconsulta): documentos MHD tipo 11488-4 (LACCompositionIT).
// Devuelve, por cada DocumentReference, su bundleUrl (para leer la narrativa) y las referencias de
// context.related (para correlacionar con el ServiceRequest exacto que responde). Una sola query.
export async function fetchResponseDocsByPatient(axiosInst, identifier, typeCode = DOC_TYPE.INTERCONSULTA) {
  const base = NODES_CONFIG.NATIONAL_FHIR_BASE;
  const id = cleanIdentifier(identifier);
  if (!id) return [];
  const url =
    `${base}/DocumentReference?patient.identifier=${encodeURIComponent(id)}` +
    `&type=${encodeURIComponent(typeCode)}&_sort=-_lastUpdated&_count=50`;
  const res = await axiosInst.get(url, { headers: buildAuthHeaders() });
  const docRefs = (res.data && res.data.entry ? res.data.entry : [])
    .map((e) => e.resource)
    .filter((r) => r && r.resourceType === 'DocumentReference');
  return docRefs.map((dr) => {
    let bundleUrl = (dr.content || []).map((c) => c && c.attachment && c.attachment.url).find(Boolean);
    if (bundleUrl && !/^https?:\/\//i.test(bundleUrl)) bundleUrl = `${base}/${String(bundleUrl).replace(/^\//, '')}`;
    const relatedRefs = ((dr.context && dr.context.related) || [])
      .map((r) => r && r.reference).filter(Boolean);
    return { docRef: dr, bundleUrl, relatedRefs, date: dr.date || (dr.meta && dr.meta.lastUpdated) };
  });
}

// Lee la narrativa (Composition.section[].text) de un Bundle documento MHD, como texto plano.
export async function fetchNarrativeFromBundle(axiosInst, bundleUrl) {
  if (!bundleUrl) return '';
  const bRes = await axiosInst.get(bundleUrl, { headers: buildAuthHeaders() });
  const entries = (bRes.data && bRes.data.entry) ? bRes.data.entry : [];
  const comp = entries.map((e) => e.resource).find((r) => r && r.resourceType === 'Composition');
  const sections = (comp && comp.section) || [];
  const html = sections.map((s) => s && s.text && s.text.div).filter(Boolean).join(' ');
  // El div es contenido propio (texto del especialista): lo pasamos a texto plano para no inyectar HTML.
  return html.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
}

// MULTI-NODO: consulta los ServiceRequest del paciente en CADA nodo nacional configurado
// (). Cada resultado queda etiquetado con su nodo de origen, para poder
// (a) filtrar por país y (b) hacer el PUT de "completar" en el nodo donde vive ese SR.
// Devuelve [{ resource, node: { country, base } }].
export async function fetchServiceRequestsAllNodes(axiosInst, identifier) {
  const id = cleanIdentifier(identifier);
  if (!id) return [];
  const nodes = listNodes();
  // eslint-disable-next-line no-console
  console.log(`[RACSEL][ServiceRequest] Buscando identifier="${id}" en ${nodes.length} nodo(s):`,
    nodes.map((n) => `${n.country} -> ${n.base}`));
  const perNode = await Promise.all(nodes.map(async (node) => {
    const url = `${node.base}/ServiceRequest?patient.identifier=${encodeURIComponent(id)}&_sort=-authored&_count=50`;
    // eslint-disable-next-line no-console
    console.log(`[RACSEL][ServiceRequest] GET (${node.country}):`, url);
    try {
      const res = await axiosInst.get(url, { headers: buildAuthHeaders() });
      const found = (res.data && res.data.entry ? res.data.entry : [])
        .map((e) => e.resource)
        .filter((r) => r && r.resourceType === 'ServiceRequest');
      // eslint-disable-next-line no-console
      console.log(`[RACSEL][ServiceRequest] (${node.country}) ${found.length} resultado(s) en ${node.base}`);
      return found.map((r) => ({ resource: r, node }));
    } catch (e) {
      // eslint-disable-next-line no-console
      console.warn(`[RACSEL][ServiceRequest] (${node.country}) error consultando ${node.base}:`, (e && e.message) || e);
      return []; // nodo inaccesible: se omite, no rompe el resto
    }
  }));
  return perNode.flat();
}

// MULTI-NODO: consulta las contrarreferencias en CADA nodo por su DocumentReference.type = 57133-1
// (Referral note) — el mismo type que estampa el mediador al crear el MHD. Así vemos tanto nuestras
// respuestas como las que otros países dejaron (en SUS nodos) a nuestras interconsultas.
// Devuelve [{ docRef, bundleUrl, relatedRefs, date, node }].
export async function fetchResponseDocsAllNodes(axiosInst, identifier, typeCode = DOC_TYPE.CONTRARREFERENCIA) {
  const id = cleanIdentifier(identifier);
  if (!id) return [];
  const nodes = listNodes();
  const perNode = await Promise.all(nodes.map(async (node) => {
    const url = `${node.base}/DocumentReference?patient.identifier=${encodeURIComponent(id)}` +
      `&type=${encodeURIComponent(typeCode)}&_sort=-_lastUpdated&_count=50`;
    try {
      const res = await axiosInst.get(url, { headers: buildAuthHeaders() });
      const docRefs = (res.data && res.data.entry ? res.data.entry : [])
        .map((e) => e.resource)
        .filter((r) => r && r.resourceType === 'DocumentReference');
      return docRefs.map((dr) => {
        let bundleUrl = (dr.content || []).map((c) => c && c.attachment && c.attachment.url).find(Boolean);
        if (bundleUrl && !/^https?:\/\//i.test(bundleUrl)) bundleUrl = `${node.base}/${String(bundleUrl).replace(/^\//, '')}`;
        const relatedRefs = ((dr.context && dr.context.related) || []).map((r) => r && r.reference).filter(Boolean);
        return { docRef: dr, bundleUrl, relatedRefs, date: dr.date || (dr.meta && dr.meta.lastUpdated), node };
      });
    } catch (e) { return []; }
  }));
  return perNode.flat();
}

// Marca un ServiceRequest como completed en el NODO DE ORIGEN (donde vive ese SR).
export async function completeServiceRequestOnNode(axiosInst, sr, base) {
  const { meta, ...rest } = sr;
  const cleanMeta = meta && meta.profile ? { profile: meta.profile } : undefined;
  const updated = { ...rest, ...(cleanMeta ? { meta: cleanMeta } : {}), status: 'completed' };
  if (Array.isArray(updated.supportingInfo)) {
    updated.supportingInfo = updated.supportingInfo.map((si) =>
      (si && si.reference && !/^https?:\/\//i.test(si.reference))
        ? { ...si, reference: `${base}/${String(si.reference).replace(/^\//, '')}` } : si);
  }
  const url = `${base}/ServiceRequest/${sr.id}`;
  await axiosInst.put(url, updated, {
    headers: { ...buildAuthHeaders(), 'Content-Type': 'application/fhir+json' },
  });
}

// Lee un Bundle IPS y devuelve un resumen legible del MISMO bundle referenciado por la interconsulta:
// secciones narrativas + recursos estructurados (condiciones, medicamentos, alergias, inmunizaciones).
export async function fetchIpsSummary(axiosInst, bundleUrl) {
  if (!bundleUrl) return null;
  const res = await axiosInst.get(bundleUrl, { headers: buildAuthHeaders() });
  const entries = (res.data && res.data.entry) ? res.data.entry : [];
  const resources = entries.map((e) => e.resource).filter(Boolean);
  const byType = (t) => resources.filter((r) => r.resourceType === t);
  const strip = (html) => String(html || '').replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
  const cc = (x) => (x && (x.text
    || (Array.isArray(x.coding) && x.coding[0] && (x.coding[0].display || x.coding[0].code)))) || '';
  const day = (d) => (d ? String(d).slice(0, 10) : '');

  const comp = byType('Composition')[0];
  const patient = byType('Patient')[0];
  const sections = ((comp && comp.section) || [])
    .map((s) => ({ title: s.title || cc(s.code) || 'Sección', text: strip(s.text && s.text.div) }))
    .filter((s) => s.text);

  const conditions = byType('Condition').map((r) => ({
    text: cc(r.code) || '—',
    status: cc(r.clinicalStatus) || cc(r.verificationStatus),
    date: day(r.onsetDateTime || r.recordedDate),
  }));
  const medications = [...byType('MedicationStatement'), ...byType('MedicationRequest')].map((r) => ({
    text: cc(r.medicationCodeableConcept) || (r.medicationReference && r.medicationReference.display) || '—',
    status: r.status || '',
    dose: (Array.isArray(r.dosage) && r.dosage[0] && r.dosage[0].text) || '',
  }));
  const allergies = byType('AllergyIntolerance').map((r) => ({
    text: cc(r.code) || '—',
    detail: [r.criticality, cc(r.clinicalStatus)].filter(Boolean).join(' · '),
  }));
  const immunizations = byType('Immunization').map((r) => ({
    text: cc(r.vaccineCode) || '—',
    detail: [day(r.occurrenceDateTime), r.status].filter(Boolean).join(' · '),
  }));

  const n = patient && patient.name && patient.name[0];
  const patientName = n ? [(n.given || []).join(' '), n.family].filter(Boolean).join(' ') : '';
  return {
    title: (comp && comp.title) || 'IPS', patientName, sections,
    conditions, medications, allergies, immunizations,
  };
}

// ============================================================================
// CONTRARREFERENCIA (respuesta) — se DELEGA al mediador 8020 por la complejidad del MHD.
// El dashboard NO arma el documento: manda { narrativa, srRef, paciente } al endpoint del mediador,
// y el mediador construye y POSTea el LACBundleTransactionMHDIT (ITI-65) al nodo nacional.
// ============================================================================
export async function submitContrarreferencia(axiosInst, { identifier, patientUuid, narrative, srRef }) {
  const endpoint = NODES_CONFIG.CONTRARREF_ENDPOINT;
  if (!endpoint) throw new Error('Endpoint de contrarreferencia no configurado (RACSEL_CONTRARREF_ENDPOINT)');
  const body = { patientUuid, identifier: cleanIdentifier(identifier), narrative, srRef };
  await axiosInst.post(endpoint, body, {
    headers: { ...buildAuthHeaders('application/json'), 'Content-Type': 'application/json' },
  });
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
