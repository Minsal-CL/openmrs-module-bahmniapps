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
  // País propio (ISO alpha-2) del nodo nacional local.
  OWN_COUNTRY: globalCfg.RACSEL_OWN_COUNTRY || env.RACSEL_OWN_COUNTRY || 'CL',
  // Rutas a NN de otros países. Clave = código país (ISO alpha-2), valor = base FHIR (…/fhir).
  // Ej: { "PA": "https://hapinacional-panama/fhir", "UY": "https://nn-uy/fhir" }.
  // Se agrega un país nuevo simplemente añadiendo su URL aquí (o vía RACSEL_COUNTRY_ROUTES en runtime).
  COUNTRY_ROUTES: globalCfg.RACSEL_COUNTRY_ROUTES || env.RACSEL_COUNTRY_ROUTES || {},
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
// (el propio + COUNTRY_ROUTES). Cada resultado queda etiquetado con su nodo de origen, para poder
// (a) filtrar por país y (b) hacer el PUT de "completar" en el nodo donde vive ese SR.
// Devuelve [{ resource, node: { country, base } }].
export async function fetchServiceRequestsAllNodes(axiosInst, identifier) {
  const id = cleanIdentifier(identifier);
  if (!id) return [];
  const nodes = listNodes();
  const perNode = await Promise.all(nodes.map(async (node) => {
    const url = `${node.base}/ServiceRequest?patient.identifier=${encodeURIComponent(id)}&_sort=-authored&_count=50`;
    try {
      const res = await axiosInst.get(url, { headers: buildAuthHeaders() });
      return (res.data && res.data.entry ? res.data.entry : [])
        .map((e) => e.resource)
        .filter((r) => r && r.resourceType === 'ServiceRequest')
        .map((r) => ({ resource: r, node }));
    } catch (e) { return []; } // nodo inaccesible: se omite, no rompe el resto
  }));
  return perNode.flat();
}

// MULTI-NODO: consulta las contrarreferencias (DocumentReference type 11488-4) en CADA nodo.
// Así vemos tanto nuestras respuestas como las que otros países dieron a nuestras interconsultas.
// Devuelve [{ docRef, bundleUrl, relatedRefs, date, node }].
export async function fetchResponseDocsAllNodes(axiosInst, identifier, typeCode = DOC_TYPE.INTERCONSULTA) {
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

// ============================================================================
// CONTRARREFERENCIA (respuesta) — arma y POSTea el documento MHD LACBundleTransactionMHDIT
// SIN encounter: el dashboard construye el documento y lo envía (ITI-65) al nodo propio.
// NOTA: esto DEBE mantenerse en sync con fhir-forwarder-contrarreferencia-mediator/index.js
// (mismo IG). Perfiles variante IT y sección 55112-7 "Resultado de la Evaluación".
// ============================================================================
const CR_PROFILES = {
  COMP: 'http://racsel.org/StructureDefinition/LACCompositionIT',
  DOCBNDL: 'http://racsel.org/StructureDefinition/LACBundleDocIT',
  DOCREF: 'http://racsel.org/StructureDefinition/LACDocReferenceIT',
  TXBNDL: 'http://racsel.org/StructureDefinition/LACBundleTransactionMHDIT',
  ORG: 'http://racsel.org/StructureDefinition/LACOrganization',
};
const CR_COMP_TYPE = { system: 'http://loinc.org', code: '11488-4', display: 'Consultation note' };
const CR_SECTION_CODE = { system: 'http://loinc.org', code: '55112-7', display: 'Document summary' };
const CR_SECTION_TITLE = 'Resultado de la Evaluación';
const CR_MASTER_ID_SYSTEM = 'urn:ietf:rfc:3986';

function uuidUrn() {
  const g = (typeof crypto !== 'undefined' && crypto.randomUUID)
    ? crypto.randomUUID()
    : 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
      const r = (Math.random() * 16) | 0; const v = c === 'x' ? r : (r & 0x3) | 0x8; return v.toString(16);
    });
  return `urn:uuid:${g}`;
}

// Asegura un Patient (con el identifier) en el nodo destino, para que el documento sea
// consultable por patient.identifier. Devuelve el recurso Patient a embeber en el documento.
export async function ensurePatientOnNode(axiosInst, base, identifier, patientUuid) {
  const id = cleanIdentifier(identifier);
  try {
    const res = await axiosInst.get(
      `${base}/Patient?identifier=${encodeURIComponent(id)}&_count=1`, { headers: buildAuthHeaders() });
    const p = (res.data && res.data.entry ? res.data.entry : []).map((e) => e.resource)
      .find((r) => r && r.resourceType === 'Patient');
    if (p) return p;
  } catch (e) { /* sigue al fallback */ }
  const minimal = { resourceType: 'Patient', id: patientUuid || (uuidUrn().slice(9)), identifier: [{ value: id }] };
  try {
    await axiosInst.put(`${base}/Patient/${minimal.id}`, minimal, {
      headers: { ...buildAuthHeaders(), 'Content-Type': 'application/fhir+json' } });
  } catch (e) { /* best-effort */ }
  return minimal;
}

// Construye la transacción MHD (LACBundleTransactionMHDIT) con la contrarreferencia embebida.
export function buildContrarreferenciaMhd({ patient, narrative, srRef, date, authorOrgName, authorOrgCountry }) {
  const patientUrl = `Patient/${patient.id}`;
  const authorUrl = uuidUrn(), compUrl = uuidUrn(), docBundleUrl = uuidUrn(), docRefUrl = uuidUrn(), listUrl = uuidUrn();
  const authorOrg = {
    resourceType: 'Organization', meta: { profile: [CR_PROFILES.ORG] },
    name: authorOrgName || 'Hospital Clínico San Borja Arriarán',
    address: [{ country: authorOrgCountry || NODES_CONFIG.OWN_COUNTRY }],
  };
  const div = `<div xmlns="http://www.w3.org/1999/xhtml">${String(narrative || '').replace(/[<>&]/g, '')}</div>`;
  const composition = {
    resourceType: 'Composition', meta: { profile: [CR_PROFILES.COMP] }, status: 'final',
    type: { coding: [CR_COMP_TYPE], text: CR_COMP_TYPE.display },
    subject: { reference: patientUrl }, date, author: [{ reference: authorUrl }], title: 'Contrarreferencia',
    ...(srRef ? { event: [{ detail: [{ reference: srRef }] }] } : {}),
    section: [{
      title: CR_SECTION_TITLE, code: { coding: [CR_SECTION_CODE] },
      text: { status: 'generated', div },
      ...(srRef ? { entry: [{ reference: srRef }] } : {}),
    }],
  };
  const docBundle = {
    resourceType: 'Bundle', meta: { profile: [CR_PROFILES.DOCBNDL] }, type: 'document',
    identifier: { system: CR_MASTER_ID_SYSTEM, value: docBundleUrl }, timestamp: date,
    entry: [
      { fullUrl: compUrl, resource: composition },
      { fullUrl: authorUrl, resource: authorOrg },
      { fullUrl: patientUrl, resource: patient },
    ],
  };
  const docRef = {
    resourceType: 'DocumentReference', meta: { profile: [CR_PROFILES.DOCREF] },
    masterIdentifier: { system: CR_MASTER_ID_SYSTEM, value: docBundleUrl },
    status: 'current', type: { coding: [CR_COMP_TYPE] }, subject: { reference: `Patient/${patient.id}` }, date,
    ...(srRef ? { context: { related: [{ reference: srRef }] } } : {}),
    content: [{ attachment: { contentType: 'application/fhir+json', url: docBundleUrl } }],
  };
  const list = {
    resourceType: 'List', status: 'current', mode: 'working', date,
    entry: [{ item: { reference: docRefUrl } }],
  };
  return {
    resourceType: 'Bundle', meta: { profile: [CR_PROFILES.TXBNDL] }, type: 'transaction',
    entry: [
      { fullUrl: listUrl, resource: list, request: { method: 'POST', url: 'List' } },
      { fullUrl: docRefUrl, resource: docRef, request: { method: 'POST', url: 'DocumentReference' } },
      { fullUrl: docBundleUrl, resource: docBundle, request: { method: 'POST', url: 'Bundle' } },
    ],
  };
}

// Envía la contrarreferencia: asegura el Patient, arma el MHD y lo POSTea (ITI-65) al nodo propio.
export async function submitContrarreferencia(axiosInst, { identifier, patientUuid, narrative, srRef, base }) {
  const target = (base || NODES_CONFIG.NATIONAL_FHIR_BASE).replace(/\/$/, '');
  const patient = await ensurePatientOnNode(axiosInst, target, identifier, patientUuid);
  const tx = buildContrarreferenciaMhd({ patient, narrative, srRef, date: new Date().toISOString() });
  await axiosInst.post(target, tx, {
    headers: { ...buildAuthHeaders(), 'Content-Type': 'application/fhir+json' },
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
