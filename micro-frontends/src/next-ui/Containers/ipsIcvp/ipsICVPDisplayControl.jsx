import React, {useState, useEffect, useRef} from "react";
import PropTypes from "prop-types";

import "../../../styles/carbon-conflict-fixes.scss";
import "../../../styles/carbon-theme.scss";
import "../../../styles/common.scss";
import "../formDisplayControl/formDisplayControl.scss";
import "./ipsICVPDisplayControl.scss";

import {I18nProvider} from "../../Components/i18n/I18nProvider";
import {FormattedMessage} from "react-intl";
import {
    DataTable,
    TableContainer,
    Table,
    TableHead,
    TableHeader,
    TableBody,
    TableRow,
    TableCell,
    Button,
    Grid,
    Row,
    Column,
    ComposedModal,
    ModalHeader,
    ModalBody,
    ModalFooter,
    InlineLoading,
    Pagination,
    TextArea,
} from "carbon-components-react";
import {View16, QrCode32} from "@carbon/icons-react";
import axios from "axios";
import { decode as cborDecode } from "cbor-x";
import pako from "pako";
import QRCode from "qrcode";
import {Html5Qrcode, Html5QrcodeSupportedFormats} from "html5-qrcode";
import {ICVP_CONFIG, buildBasicAuth} from "../../config/icvpConfig";

// Instancia AISLADA de axios para evitar que los interceptores globales de Bahmni
// intercepten los errores y muestren diálogos de error en la UI de Bahmni.
// Timeouts diferenciados para no bloquear la UI cuando el servidor no responde:
//   TIMEOUT_LIST  → carga inicial (spinner de página), falla rápido si no hay servidor
//   TIMEOUT_DOC   → ver documento (el usuario hizo clic, puede esperar más)
//   TIMEOUT_VHL   → operaciones VHL generate/resolve
const TIMEOUT_LIST = 6000;
const TIMEOUT_DOC  = 20000;
const TIMEOUT_VHL  = 15000;

const axiosIcvp = axios.create({ timeout: TIMEOUT_DOC });

const {
  REGIONAL_BASE,
  VHL_ISSUANCE_URL,
  VHL_RESOLVE_URL,
  ICVP_FROM_BUNDLE_URL,
} = ICVP_CONFIG;

/* ===========================
   CONFIG ITI-67/68
   =========================== */

/* ===========================
   DECODIFICACIÓN ICVP (HC1 Base45)
   - Preview local: no verifica firma.
   - Pasos: HC1 -> Base45 -> zlib inflate -> COSE_Sign1 (CBOR) -> payload (CWT/CBOR)
   =========================== */
const BASE45_ALPHABET = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ $%*+-./:";
const BASE45_MAP = (() => {
    const m = new Map();
    for (let i = 0; i < BASE45_ALPHABET.length; i++) m.set(BASE45_ALPHABET[i], i);
    return m;
})();

const base45Decode = (input) => {
    const s = String(input || "");
    const out = [];
    for (let i = 0; i < s.length; ) {
        const c1 = s[i++];
        const c2 = s[i++];
        if (c2 === undefined) throw new Error("Base45 inválido: longitud impar");

        const v1 = BASE45_MAP.get(c1);
        const v2 = BASE45_MAP.get(c2);
        if (v1 === undefined || v2 === undefined) throw new Error("Base45 inválido: caracter no permitido");

        if (i < s.length) {
            const c3 = s[i];
            const v3 = BASE45_MAP.get(c3);
            // Si el tercer caracter es inválido, tratamos como bloque de 2 (1 byte)
            if (v3 !== undefined) {
                i++;
                const x = v1 + v2 * 45 + v3 * 45 * 45;
                if (x > 0xffff) throw new Error("Base45 inválido: overflow");
                out.push((x >> 8) & 0xff, x & 0xff);
                continue;
            }
        }

        const x = v1 + v2 * 45;
        if (x > 0xff) throw new Error("Base45 inválido: overflow");
        out.push(x);
    }
    return new Uint8Array(out);
};

const toJsonFriendly = (value) => {
    if (value instanceof Map) {
        const obj = {};
        for (const [k, v] of value.entries()) {
            obj[String(k)] = toJsonFriendly(v);
        }
        return obj;
    }
    if (value instanceof Uint8Array) {
        // Representación compacta para binarios (no inundar la UI)
        const max = 32;
        const hex = Array.from(value.slice(0, max)).map((b) => b.toString(16).padStart(2, "0")).join("");
        return value.length > max ? `0x${hex}… (${value.length} bytes)` : `0x${hex}`;
    }
    if (Array.isArray(value)) return value.map(toJsonFriendly);
    if (value && typeof value === "object") {
        const obj = {};
        for (const [k, v] of Object.entries(value)) obj[k] = toJsonFriendly(v);
        return obj;
    }
    return value;
};

const unwrapCborTagged = (value) => {
    if (!value || typeof value !== "object") return value;
    // cbor-x puede devolver Tagged { tag, value }
    if (Object.prototype.hasOwnProperty.call(value, "tag") && Object.prototype.hasOwnProperty.call(value, "value")) {
        return value.value;
    }
    return value;
};

const getCwtClaim = (cwt, key) => {
    if (!cwt) return null;
    if (cwt instanceof Map) return cwt.get(key);
    // Cuando cbor-x decodifica mapas como objetos, las llaves numéricas terminan como strings.
    const asStringKey = String(key);
    return cwt[key] ?? cwt[asStringKey] ?? null;
};

const decodeHc1Preview = (hc1) => {
    const raw = String(hc1 || "").trim();
    if (!raw) return null;

    // Normalización mínima: quitar saltos de línea/tab y eliminar espacios justo después de HC1:
    const cleaned = raw.replace(/[\r\n\t]+/g, "").replace(/^(HC1:)\s+/i, "$1");
    if (!/^HC1:/i.test(cleaned)) throw new Error("El texto no comienza con HC1:");

    const b45 = cleaned.replace(/^HC1:/i, "");
    const compressed = base45Decode(b45);
    const coseBytes = pako.inflate(compressed);

    // COSE_Sign1 es un CBOR array de 4 elementos
    let cose = cborDecode(coseBytes);
    cose = unwrapCborTagged(cose);
    if (!Array.isArray(cose) || cose.length < 4) throw new Error("COSE inválido");

    const payloadBytes = cose[2];
    if (!(payloadBytes instanceof Uint8Array)) throw new Error("COSE payload inválido");

    const cwt = unwrapCborTagged(cborDecode(payloadBytes));
    const cwtJson = toJsonFriendly(cwt);

    // HCERT: típicamente está bajo claim -260.
    // En nuestros QR (ICVP) el mapa principal viene en -260/-6 (observado en práctica).
    const hcertContainer = unwrapCborTagged(getCwtClaim(cwt, -260));
    const hcertMain = unwrapCborTagged(
        getCwtClaim(hcertContainer, 1) ??
        getCwtClaim(hcertContainer, -6)
    );

    return {
        kind: "HC1",
        cwt: cwtJson,
        hcert: hcertMain ? toJsonFriendly(hcertMain) : null,
    };
};

const renderIcvpMinPreview = (decoded) => {
    const hcert = decoded?.hcert;
    if (!hcert) {
        return (
            <div className="icvp-preview">
                <div className="icvp-preview__card" aria-label="QR Decodificado">
                    <div className="icvp-preview__title">QR decodificado</div>
                    <div className="icvp-preview__empty">
                        Este QR no contiene un certificado ICVP (HCERT) interpretable.
                    </div>
                </div>
            </div>
        );
    }

    const vRaw = hcert?.v;
    const vaccines = Array.isArray(vRaw) ? vRaw : (vRaw && typeof vRaw === 'object' ? [vRaw] : []);
    const field = (v) => {
        if (v === null || v === undefined || v === "") return "—";
        if (Array.isArray(v)) return v.filter(Boolean).join(", ") || "—";
        if (typeof v === "object") return JSON.stringify(v);
        return String(v);
    };

    const PRODUCT_ID_EQUIV = {
        YellowFeverProductd2c75a15ed309658b3968519ddb31690: {
            vaccineType: 'YellowFever',
            description:
                'Yellow Fever - 2 dose - Federal State Autonomous Scientific Institution «Chumakov Federal Scientific Center for Research & Development of Immune-And Biological Products»'
        },
        YellowFeverProduct771d1a5c0acaee3e2dc9d56af1aba49d: {
            vaccineType: 'YellowFever',
            description:
                'Yellow Fever - 5 dose - Federal State Autonomous Scientific Institution «Chumakov Federal Scientific Center for Research & Development of Immune-And Biological Products»'
        },
        YellowFeverProducte929626497bdbb71adbe925f0c09c79f: {
            vaccineType: 'YellowFever',
            description:
                'Yellow Fever - 10 dose - Federal State Autonomous Scientific Institution «Chumakov Federal Scientific Center for Research & Development of Immune-And Biological Products»'
        },
        YellowFeverProduct01a3b83cf13e87948437db11cf5c34eb: {
            vaccineType: 'YellowFever',
            description: 'SinSaVac™ - 10 dose'
        },
        YellowFeverProductf82b015dfb3b1feeacd4c44d95b3b3ec: {
            vaccineType: 'YellowFever',
            description: 'Stabilized Yellow Fever Vaccine - 5 dose - Institut Pasteur de Dakar'
        },
        YellowFeverProduct223330a7c15da86b21cc363f591de002: {
            vaccineType: 'YellowFever',
            description: 'Stabilized Yellow Fever Vaccine - 10 dose - Institut Pasteur de Dakar'
        },
        YellowFeverProductffea8448252ee58b7a92add05f0c3431: {
            vaccineType: 'YellowFever',
            description: 'Stabilized Yellow Fever Vaccine - 20 dose - Institut Pasteur de Dakar'
        },
        YellowFeverProductd8a09f80301dc05e124f99ffe7711fc0: {
            vaccineType: 'YellowFever',
            description: 'STAMARIL - 10 dose - Sanofi Pasteur'
        },
        YellowFeverProductab01f006f8b24113f4a28cb50bfe6d9d: {
            vaccineType: 'YellowFever',
            description: 'Yellow Fever - 5 dose - Bio-Manguinhos/Fiocruz'
        },
        YellowFeverProduct5f0639d8e4d52afef089aa7148c5060c: {
            vaccineType: 'YellowFever',
            description: 'Yellow Fever - 10 dose - Bio-Manguinhos/Fiocruz'
        },
        YellowFeverProducte0534dbc71a6cc09f56dce25216c538c: {
            vaccineType: 'YellowFever',
            description: 'Yellow Fever - 50 dose - Bio-Manguinhos/Fiocruz'
        },
        PolioVaccineOralOPVTrivaProductfa4849f7532d522134f4102063af1617: {
            vaccineType: 'PolioVaccineOralOPVTrivalent',
            description: 'BIOPOLIO - Trivalent OPV - 10 dose - Bharat Biotech'
        },
        PolioVaccineOralOPVTrivaProduct4df3a93ab495d85b3583d0cd1ae3d83e: {
            vaccineType: 'PolioVaccineOralOPVTrivalent',
            description: 'BIOPOLIO - Trivalent OPV - 20 dose - Bharat Biotech'
        },
        PolioVaccineOralOPVTrivaProducte0bcdc085107751b3df34ad04620ac21: {
            vaccineType: 'PolioVaccineOralOPVTrivalent',
            description: 'Oral Poliomyelitis Vaccines - Trivalent - 20 dose - PT Bio Farma'
        },
        PolioVaccineOralOPVTrivaProductbd7faeaf3f0e633420fba396895d6cc9: {
            vaccineType: 'PolioVaccineOralOPVTrivalent',
            description: 'Polioviral vaccine - Trivalent - 20 dose - Haffkine Bio'
        },
        PolioVaccineOralOPVBivalProduct16e883911ea0108b8213bc213c9972fe: {
            vaccineType: 'PolioVaccineOralOPVBivalentTypes1and3',
            description: 'BIOPOLIO B1/3 - Bivalent OPV - 10 dose - Bharat Biotech'
        },
        PolioVaccineOralOPVBivalProduct0e59118bc5938520115bac65a45be04d: {
            vaccineType: 'PolioVaccineOralOPVBivalentTypes1and3',
            description: 'BIOPOLIO B1/3 - Bivalent OPV - 20 dose - Bharat Biotech'
        },
        PolioVaccineInactivatedIProduct532ef986c8042bbb15fee24056fdc4ed: {
            vaccineType: 'PolioVaccineInactivatedIPV',
            description: 'IMOVAX POLIO - IPV - 10 dose - Sanofi Pasteur'
        },
        PolioVaccineInactivatedIProduct087ff26057e89c006517428347dfbc3c: {
            vaccineType: 'PolioVaccineInactivatedIPV',
            description: 'IPV Vaccine AJV - 1 dose - AJ Vaccines'
        },
        PolioVaccineInactivatedSProduct0854d534a200bbeffa8be0f57dad584a: {
            vaccineType: 'PolioVaccineInactivatedSabinsIPV',
            description: 'Eupolio Inj. - sIPV - 1 dose - LG Chem'
        },
        PolioVaccineInactivatedSProduct031f63df3184acdf0cb82f90f316b6c3: {
            vaccineType: 'PolioVaccineInactivatedSabinsIPV',
            description: 'Eupolio Inj. - sIPV - 5 dose - LG Chem'
        },
        DiphtheriaTetanusPertussProductf4177b409d09d83e48630717437c5aea: {
            vaccineType:
                'DiphtheriaTetanusPertussiswholecellHepatitisBHaemophilusinfluenzaetypebPolioInactivated',
            description: 'HEXASIIL - DTP-HepB-Hib-IPV - 1 dose - Serum Institute'
        },
        DiphtheriaTetanusPertussProductd54558e2851d29311ee7f90975827dc7: {
            vaccineType:
                'DiphtheriaTetanusPertussisacellularHepatitisBHaemophilusinfluenzaetypebPolioInactivated',
            description: 'Hexaxim - DTPa-HepB-Hib-IPV - 1 dose - Sanofi Pasteur'
        },
        PolioVaccineNovelOralnOPProduct65b137f0201901bc43fc8759e4f35f35: {
            vaccineType: 'PolioVaccineNovelOralnOPVType2',
            description: 'Poliomyelitis Vaccine - nOPV Type 2 - 20 dose - Biological E.'
        },
        PolioVaccineNovelOralnOPProduct278e9af5dc50904dd144a7ceb4d42dd7: {
            vaccineType: 'PolioVaccineNovelOralnOPVType2',
            description: 'Polio Vaccine - nOPV Type 2 - 50 dose - PT Bio Farma'
        },
    };

    const getProductInfo = (vp) => {
        const code = String(vp || '');
        return PRODUCT_ID_EQUIV[code] || null;
    };

    return (
        <div className="icvp-preview">
            <div className="icvp-preview__card" aria-label="ICVPMin">
                <div className="icvp-preview__title">Certificado de vacunación (ICVP)</div>

                <div className="icvp-preview__section">
                    <div className="icvp-preview__sectionTitle">Datos del titular</div>
                    <dl className="icvp-preview__dl">
                        <div className="icvp-preview__row">
                            <dt>Nombre (n)</dt>
                            <dd>{field(hcert?.n)}</dd>
                        </div>
                        <div className="icvp-preview__row">
                            <dt>Nombres (gn)</dt>
                            <dd>{field(hcert?.gn)}</dd>
                        </div>
                        <div className="icvp-preview__row">
                            <dt>Fecha de nacimiento (dob)</dt>
                            <dd>{field(hcert?.dob)}</dd>
                        </div>
                        <div className="icvp-preview__row">
                            <dt>Sexo (s)</dt>
                            <dd>{field(hcert?.s)}</dd>
                        </div>
                        <div className="icvp-preview__row">
                            <dt>Nacionalidad (ntl)</dt>
                            <dd>{field(hcert?.ntl)}</dd>
                        </div>
                        <div className="icvp-preview__row">
                            <dt>Tipo de documento (ndt)</dt>
                            <dd>{field(hcert?.ndt)}</dd>
                        </div>
                        <div className="icvp-preview__row">
                            <dt>Número de documento (nid)</dt>
                            <dd>{field(hcert?.nid)}</dd>
                        </div>
                    </dl>
                </div>

                <div className="icvp-preview__section">
                    <div className="icvp-preview__sectionTitle">Vacunas</div>
                    {vaccines.length === 0 ? (
                        <div className="icvp-preview__empty">—</div>
                    ) : (
                        <div className="icvp-preview__vaccines">
                            {vaccines.map((v, idx) => {
                                const info = getProductInfo(v?.vp);
                                const vpDisplay = info?.description
                                    ? `${field(v?.vp)} — ${info.description}`
                                    : field(v?.vp);
                                const vtDisplay = info?.vaccineType ? info.vaccineType : "—";

                                return (
                                    <div key={idx} className="icvp-preview__vaccine">
                                        <div className="icvp-preview__vaccineTitle">Registro #{idx + 1}</div>
                                        <dl className="icvp-preview__dl">
                                            <div className="icvp-preview__row">
                                                <dt>Producto (vp)</dt>
                                                <dd>{vpDisplay}</dd>
                                            </div>
                                            <div className="icvp-preview__row">
                                                <dt>Tipo equivalente</dt>
                                                <dd>{vtDisplay}</dd>
                                            </div>
                                            <div className="icvp-preview__row">
                                                <dt>Fecha (dt)</dt>
                                                <dd>{field(v?.dt)}</dd>
                                            </div>
                                            <div className="icvp-preview__row">
                                                <dt>Lote / Identificador (bo)</dt>
                                                <dd>{field(v?.bo)}</dd>
                                            </div>
                                            <div className="icvp-preview__row">
                                                <dt>País (cn)</dt>
                                                <dd>{field(v?.cn)}</dd>
                                            </div>
                                            <div className="icvp-preview__row">
                                                <dt>Emisor (is)</dt>
                                                <dd>{field(v?.is)}</dd>
                                            </div>
                                            <div className="icvp-preview__row">
                                                <dt>Válido desde (vls)</dt>
                                                <dd>{field(v?.vls)}</dd>
                                            </div>
                                            <div className="icvp-preview__row">
                                                <dt>Válido hasta (vle)</dt>
                                                <dd>{field(v?.vle)}</dd>
                                            </div>
                                        </dl>
                                    </div>
                                );
                            })}
                        </div>
                    )}
                </div>
            </div>
        </div>
    );
};


/* ===========================
   CONFIG ICVP (Mediator)
   =========================== */
// Expuesto por OpenHIM (ajústalo si lo publicas en otro path)

// Perfiles para decidir el flujo
const PROFILE_LAC_BUNDLE   = "http://lacpass.racsel.org/StructureDefinition/lac-bundle";
const PROFILE_LAC_COMP     = "http://lacpass.racsel.org/StructureDefinition/lac-composition";
const PROFILE_ICVP_BUNDLE  = "http://smart.who.int/icvp/StructureDefinition/Bundle-uv-ips-ICVP";



// Headers con Basic Auth (por OpenHIM)
const buildAuthHeaders = (accept = "application/fhir+json") => {
    const headers = { Accept: accept };
    const auth = buildBasicAuth();
    if (auth) headers.Authorization = auth;
    return headers;
};

// Une base + path cuidando slashes
const joinUrl = (base, path) =>
    `${base.replace(/\/+$/, "")}/${String(path || "").replace(/^\/+/, "")}`;

// Dada la fullUrl de un DocumentReference, obtén la "FHIR base"
// p.ej. "http://host:8080/fhir/DocumentReference/173" -> "http://host:8080/fhir"
const getFhirBaseFromDocFullUrl = (fullUrl) => {
    if (!fullUrl) return null;
    const m = String(fullUrl).match(/^(https?:\/\/[^]+?)\/DocumentReference(?:\/|$)/i);
    if (m) return m[1];
    return String(fullUrl).replace(/\/DocumentReference\/.*$/, "");
};

// Resuelve attachment.url relativo contra la base del propio DocumentReference
// doc.__docRefBase la agregamos al parseo (ver más abajo)
const resolveAttachmentUrl = (doc, attachmentUrl) => {
    const url = String(attachmentUrl || "");
    if (!url) return null;
    if (/^https?:\/\//i.test(url)) return url;
    const base = doc?.__docRefBase || REGIONAL_BASE;

    if (url.startsWith("//")) {
        try {
            const u = new URL(base);
            return `${u.protocol}${url}`;
        } catch {
            return `http:${url}`;
        }
    }

    try {
        const u = new URL(base);
        if (url.startsWith("/")) {
            return `${u.origin}${url}`;
        }
    } catch {
        /* noop */
    }
    return joinUrl(base, url);
};

// ITI-67 vía mediador con _count escalonado (50→100→150→…).
// Repite la misma búsqueda aumentando _count hasta que desaparece el link "next"
// (sin seguir el "next" del servidor FHIR directo).
const fetchDocumentReferences = async (patientIdentifier) => {
    const raw = String(patientIdentifier || "").trim();
    // Si no viene con RUN*, lo agregamos (tu backend lo espera así).
    //const ensured = /^RUN\*/i.test(raw) ? raw : `RUN*${raw}`;
    // El backend ya no requiere prefijo RUN*, así que lo removemos si llega desde la fuente
    const ensured = raw.replace(/^RUN\*/i, "");

    const STEP = 50;        // incremento por iteración
    const MAX_COUNT = 2000; // hard-stop de seguridad
    let bestBundle = null;
    let bestEntries = [];
    let lastLen = 0;
    let stalled = 0;

    for (let count = STEP; count <= MAX_COUNT; count += STEP) {
        const url =
            `${REGIONAL_BASE}/DocumentReference` +
            `?patient.identifier=${encodeURIComponent(ensured)}&_count=${count}&type=60591-5&category=11369-6&_sort=-_lastUpdated`;

        let res;
        try {
            res = await axiosIcvp.get(url, {headers: buildAuthHeaders("application/fhir+json"), timeout: TIMEOUT_LIST});
        } catch (err) {
            // Silenciar siempre: no propagar errores de red para evitar diálogos de Bahmni
            console.warn("[IPSICVP] Error ITI-67 (silenciado):", err?.message || err);
            break;
        }

        const bundle = res?.data || {};
        const entries = Array.isArray(bundle.entry) ? bundle.entry : [];
        const currLen = entries.length;

        // Guardamos el bundle más "completo"
        if (currLen > bestEntries.length) {
            bestEntries = entries;
            bestBundle = bundle;
        }

        // ¿Servidor aún publica "next"?
        const links = Array.isArray(bundle.link) ? bundle.link : [];
        const hasNext = links.some((l) => String(l?.relation || "").toLowerCase() === "next");

        // Heurística anti-loop: si no crece, contamos "stalls"
        if (currLen <= lastLen) {
            stalled += 1;
        } else {
            stalled = 0;
        }
        lastLen = currLen;

        // Condiciones de término:
        // 1) no hay next → ya cargamos todo en esta iteración
        // 2) se estancó 2 veces seguidas → probablemente hay un límite de _count del servidor
        if (!hasNext || stalled >= 2) {
            break;
        }
    }

    // Si no hubo bundle válido, devolvemos uno vacío "searchset"
    if (!bestBundle) {
        return {resourceType: "Bundle", type: "searchset", entry: [], total: 0, link: []};
    }

    // Devolvemos un Bundle "fusionado" (metadatos del mejor bundle, entries completas y sin next externo)
    return {
        ...bestBundle,
        entry: bestEntries,
        total: bestEntries.length,
        link: [], // limpiamos links para no tentar al front a seguir paginación del FHIR directo
    };
};

// Normaliza Bundle -> DocumentReference[] y anota __docRefBase desde entry.fullUrl
const parseDocRefsFromBundle = (bundle) => {
    if (!bundle || !Array.isArray(bundle.entry) || bundle.entry.length === 0) return [];
    return (bundle.entry || [])
        .map((e) => {
            const r = e?.resource;
            if (r?.resourceType !== "DocumentReference") return null;
            const fullUrl = e?.fullUrl || "";
            const base = getFhirBaseFromDocFullUrl(fullUrl) || REGIONAL_BASE;
            return {...r, __docRefBase: base, __fullUrl: fullUrl};
        })
        .filter(Boolean);
};

/* ===========================
   Helpers de render FHIR
   =========================== */
const getResource = (bundle, resourceType) =>
    (bundle?.entry || []).map((e) => e.resource).find((r) => r?.resourceType === resourceType) || null;

const safeDiv = (html) => ({__html: html || ""});

// Perfiles del Bundle
const getBundleProfiles = (bundle) =>
  Array.isArray(bundle?.meta?.profile) ? bundle.meta.profile.map(String) : [];
const hasProfile = (bundle, profileUri) =>
  getBundleProfiles(bundle).includes(profileUri);

// Humaniza errores HTTP/Red para mostrar pistas útiles (CORS/TLS)
const humanizeHttpError = (e, fallbackLabel = "Error") => {
    if (e?.response) {
        return `${e.response.status} ${e.response.statusText}`;
    }
    const raw = e?.message || String(e || fallbackLabel);
    if (/Network Error/i.test(raw) || /Failed to fetch/i.test(raw)) {
        return `${raw} (posible CORS o certificado TLS no confiable)`;
    }
    return raw;
};


/* ===========================
   COMPONENTE
   =========================== */
export function IpsIcvpDisplayControl(props) {
    const {hostData, tx} = props;
    const {identifier} = hostData || {};

    const t = (key, fallback) => {
        const value = tx?.(key);
        return !value || value === key ? fallback : value;
    };

    // IDs únicos para evitar colisión si IPS + ICVP están renderizados en la misma pantalla.
    const qrRegionId = "vhl-qr-region-icvp";
    const vhlInputId = "vhl-input-icvp";

    const [documents, setDocuments] = useState([]);
    const [error, setError] = useState(null);

    // modal (ITI-68 viewer)
    const [viewerOpen, setViewerOpen] = useState(false);
    const [viewerLoading, setViewerLoading] = useState(false);
    const [viewerError, setViewerError] = useState(null);
    const [viewerBundle, setViewerBundle] = useState(null);

    // paginación
    const [page, setPage] = useState(1);
    const [pageSize, setPageSize] = useState(10);
    const pageSizes = [10, 20, 50, 100];

    // compartir VHL (emitir HC1 desde un Bundle)
    const [shareLoading, setShareLoading] = useState(false);
    const [shareError, setShareError] = useState(null);
    const [shareText, setShareText] = useState("");         // el "HC1: ..."
    const [shareQrDataUrl, setShareQrDataUrl] = useState(""); // dataURL del QR

    
    // ICVP (generar QR con $icvp por cada Immunization)
    const [icvpLoading, setIcvpLoading] = useState(false);
    const [icvpError, setIcvpError] = useState(null);
    const [icvpResults, setIcvpResults] = useState([]); // [{immunizationId, pngDataUrl, hc1}]

    // Leer VHL (pegar/scannear → resolver → elegir archivo → ver Bundle)
    const [vhlModalOpen, setVhlModalOpen] = useState(false);
    const [vhlInput, setVhlInput] = useState("");           // texto pegado/escaneado (HC1:...)
    const [vhlScanActive, setVhlScanActive] = useState(false);
    const [vhlScanError, setVhlScanError] = useState(null);
    const [vhlScanStatus, setVhlScanStatus] = useState("");
    // Preview/decodificación ICVP (Base45)
    const [hc1DecodeLoading, setHc1DecodeLoading] = useState(false);
    const [hc1DecodeError, setHc1DecodeError] = useState(null);
    const [hc1Decoded, setHc1Decoded] = useState(null);
    const [resolveLoading, setResolveLoading] = useState(false);
    const [resolveError, setResolveError] = useState(null);
    const [resolveFiles, setResolveFiles] = useState([]);   // [{location, contentType}]
    const scannerRef = useRef(null);

    /* -------- ITI-67 load -------- */
    useEffect(() => {
        let cancelled = false;
        const run = async () => {
            setError(null);
            try {
                if (!identifier) {
                    setDocuments([]);
                    return;
                }
                const bundle = await fetchDocumentReferences(identifier);
                const docs = parseDocRefsFromBundle(bundle);
                const docsSorted = [...docs].sort((a, b) => getDocTimestamp(b) - getDocTimestamp(a));
                if (!cancelled) setDocuments(docsSorted);
            } catch (e) {
                console.warn("[IPSICVP] ITI-67 error (silenciado, no se mostrará en UI):", e);
                if (!cancelled) setDocuments([]);
            }
        };
        run();
        return () => {
            cancelled = true;
        };
    }, [identifier]);

    // ajustar página si cambian documentos o pageSize
    useEffect(() => {
        setPage(1);
    }, [documents, pageSize]);

    /* -------- Acciones -------- */
    const handleOpenVhlReader = () => {
        setVhlModalOpen(true);
        setVhlInput("");
        setVhlScanActive(false);
        setVhlScanError(null);
        setVhlScanStatus("");
        setHc1DecodeLoading(false);
        setHc1DecodeError(null);
        setHc1Decoded(null);
        setResolveFiles([]);
        setResolveError(null);
        setShareError(null);
    };

    // Al pegar o escanear un HC1, mostrar (en el modal) una previsualización decodificada (Base45).
    useEffect(() => {
        if (!vhlModalOpen) return;

        const normalized = normalizeHc1Input(vhlInput);
        if (!normalized || !/^HC1:/i.test(normalized)) {
            setHc1DecodeLoading(false);
            setHc1DecodeError(null);
            setHc1Decoded(null);
            return;
        }

        let cancelled = false;
        const timer = setTimeout(() => {
            try {
                setHc1DecodeLoading(true);
                setHc1DecodeError(null);
                setHc1Decoded(null);

                const decoded = decodeHc1Preview(normalized);
                if (!cancelled) setHc1Decoded(decoded);
            } catch (e) {
                if (cancelled) return;
                setHc1DecodeError(e?.message || String(e));
            } finally {
                if (!cancelled) setHc1DecodeLoading(false);
            }
        }, 300);

        return () => {
            cancelled = true;
            clearTimeout(timer);
        };
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [vhlInput, vhlModalOpen]);

    const stopVhlScan = async () => {
        try {
            if (scannerRef.current) {
                try { await scannerRef.current.stop(); } catch {}
                try { await scannerRef.current.clear(); } catch {}
            }
        } finally {
            scannerRef.current = null;
            setVhlScanActive(false);
            setVhlScanStatus("");
        }
    };

    const nextFrame = () =>
        new Promise((resolve) => {
            if (typeof window !== "undefined" && typeof window.requestAnimationFrame === "function") {
                window.requestAnimationFrame(() => window.requestAnimationFrame(resolve));
                return;
            }
            setTimeout(resolve, 0);
        });

    // Espera a que el contenedor exista y tenga tamaño real (>0)
    const waitRegionReady = async (id, timeoutMs = 10000) => {
        const start = Date.now();
        for (;;) {
            const el = document.getElementById(id);
            if (el) {
                const r = el.getBoundingClientRect();
                const isVisibleInLayout = el.offsetParent !== null;
                if (isVisibleInLayout && r.width > 10 && r.height > 10) return el;
            }
            if (Date.now() - start > timeoutMs) {
                throw new Error(
                    "QR region no está listo (el modal aún no termina de renderizar). Cierra el lector y reintenta."
                );
            }
            await nextFrame();
        }
    };

    const startVhlScan = async () => {
        setVhlScanError(null);
        setVhlScanStatus("Activando cámara…");

        // 1) Mostrar el contenedor antes de iniciar
        setVhlScanActive(true);
        try {
            const id = qrRegionId;
            // Deja que el modal/DOM/layout se estabilicen (Carbon hace animación)
            await nextFrame();
            await waitRegionReady(id); // <-- asegura tamaño

            // Evita arrancar dos veces
            if (scannerRef.current) {
                await stopVhlScan();
            }

            const scanner = new Html5Qrcode(id, {
                formatsToSupport: [Html5QrcodeSupportedFormats.QR_CODE],
                verbose: false
            });
            scannerRef.current = scanner;

            // 2) Selecciona cámara estable con getCameras()
            const cams = await Html5Qrcode.getCameras();
            if (!Array.isArray(cams) || cams.length === 0) {
                throw new Error("No se encontraron cámaras disponibles");
            }

            // Preferir trasera si existe
            const back = cams.find(c => /back|rear|environment/i.test(c.label));
            const deviceId = (back || cams[0]).id;

            let consecutiveErrors = 0;
            const startedAt = Date.now();
            let lastNoticeAt = 0;
            await scanner.start(
                { deviceId: { exact: deviceId } },
                {
                    fps: 12,
                    qrbox: (vw, vh) => {
                        const min = Math.min(vw, vh);
                        const size = Math.floor(Math.min(280, min * 0.8));
                        return { width: size, height: size };
                    },
                    aspectRatio: 1.0,
                },
                async (decodedText) => {
                    // Éxito: pegar HC1 y parar
                    setVhlInput(decodedText || "");
                    setVhlScanStatus("QR detectado.");
                    await stopVhlScan();
                },
                (errMsg) => {
                    consecutiveErrors++;
                    if (consecutiveErrors % 40 === 0) {
                        console.debug("[QR] intentando leer…", errMsg);
                    }

                    const now = Date.now();
                    if (now - startedAt > 6000 && now - lastNoticeAt > 2500) {
                        lastNoticeAt = now;
                        setVhlScanStatus(
                            "No se detecta QR aún. Acerca/aleja el código, mejora la luz y espera 2–3s."
                        );
                    } else if (now - startedAt <= 6000) {
                        setVhlScanStatus("Cámara activa. Apunta al QR dentro del recuadro.");
                    }
                }
            );
        } catch (e) {
            console.error("[VHL] Error iniciando escáner:", e);
            setVhlScanError(
                e?.message ||
                "No se pudo iniciar la cámara. Revisa permisos y que 'html5-qrcode' esté instalado."
            );
            setVhlScanStatus("");
            await stopVhlScan();
        }
    };

    const normalizeHc1Input = (rawInput) => {
        const raw = String(rawInput || "").trim();
        if (!raw) return "";

        // Ojo: Base45 (EU DCC/HC1) permite el caracter espacio.
        // Quitamos solo saltos de línea/tabulaciones que suelen aparecer al pegar.
        const withoutLineBreaks = raw.replace(/[\r\n\t]+/g, "").trim();

        if (/^HC1:/i.test(withoutLineBreaks)) {
            const rest = withoutLineBreaks.replace(/^HC1:/i, "").trim();
            return `HC1:${rest}`;
        }

        const base45ish = /^[0-9A-Z $%*+\-./:]+$/i.test(withoutLineBreaks);
        if (base45ish && withoutLineBreaks.length > 25) {
            return `HC1:${withoutLineBreaks}`;
        }

        return withoutLineBreaks;
    };

    const handleCloseVhlModal = async () => {
        await stopVhlScan();
        setVhlModalOpen(false);
    };

    const handleResolveVHL = async () => {
        try {
            setResolveLoading(true);
            setResolveError(null);
            setResolveFiles([]);
            const normalized = normalizeHc1Input(vhlInput);
            setVhlInput(normalized);

            if (!normalized || !/^HC1:/.test(normalized)) {
                setResolveError("Pega o escanea un código válido que comience con 'HC1:'.");
                return;
            }

            const resp = await axiosIcvp.post(
                VHL_RESOLVE_URL,
                {qrCodeContent: normalized},
                {
                    headers: {
                        ...buildAuthHeaders("application/json"),
                        "Content-Type": "application/json",
                    },
                    responseType: "json",
                    timeout: TIMEOUT_VHL,
                }
            );

            const files = Array.isArray(resp?.data?.files) ? resp.data.files : [];
            setResolveFiles(files);
            if (files.length === 0) {
                setResolveError("No se encontraron archivos en el manifiesto.");
            }
        } catch (e) {
            console.error("[VHL] Resolve error:", e);
            const msg = e?.response ? `${e.response.status} ${e.response.statusText}` : e?.message || String(e);
            setResolveError(`Error al resolver VHL: ${msg}`);
        } finally {
            setResolveLoading(false);
        }
    };

    // === Helpers para fecha del DocumentReference ===
    const getDocDateISO = (doc) =>
        doc?.date ||
        doc?.indexed ||
        doc?.content?.[0]?.attachment?.creation ||
        doc?.meta?.lastUpdated ||
        null;

    const getDocTimestamp = (doc) => {
        const iso = getDocDateISO(doc);
        const t = iso ? Date.parse(iso) : NaN;
        return Number.isFinite(t) ? t : 0; // sin fecha -> 0 para que vaya al final
    };

    const formatDocDate = (doc) => {
        const iso = getDocDateISO(doc);
        return iso ? new Date(iso).toLocaleString() : "—";
    };

    const openResolvedFile = async (file) => {
        const location = file?.location;
        if (!location) return;
        await stopVhlScan();
        setVhlModalOpen(false);

        setViewerOpen(true);
        setViewerLoading(true);
        setViewerError(null);
        setViewerBundle(null);
        // reset de acciones previas
        setShareLoading(false); setShareError(null); setShareText(""); setShareQrDataUrl("");
        setIcvpLoading(false); setIcvpError(null); setIcvpResults([]);

        try {
            const accept = "application/fhir+json, application/json;q=0.9, */*;q=0.8";
            const sameOrigin = String(location).startsWith(REGIONAL_BASE);
            const headers = sameOrigin ? buildAuthHeaders(accept) : { Accept: accept };
            const res = await axiosIcvp.get(location, { headers, responseType: "json", timeout: TIMEOUT_DOC });
            setViewerBundle(res.data);
        } catch (e) {
            console.error("[VHL] Error cargando archivo del manifiesto:", e);
            const msg = e?.response ? `${e.response.status} ${e.response.statusText}` : e?.message || String(e);
            setViewerError(`No se pudo cargar el Bundle desde el archivo seleccionado: ${msg}`);
        } finally {
            setViewerLoading(false);
        }
    };

    // ITI-68: ver documento usando attachment.url (p. ej. "Bundle/18")
    const handleViewDocument = async (doc) => {
        const att = doc?.content?.[0]?.attachment;
        const attachmentUrl = att?.url;
        if (!attachmentUrl) {
            console.warn("[ITI-68] Sin attachment.url en DocumentReference:", doc?.id);
            return;
        }
        const url = resolveAttachmentUrl(doc, attachmentUrl);

        // Si es PDF, abrir como binario en nueva pestaña
        if (att?.contentType?.toLowerCase?.().includes("pdf")) {
            try {
                const binRes = await axiosIcvp.get(url, {
                    headers: buildAuthHeaders("*/*"),
                    responseType: "blob",
                    timeout: TIMEOUT_DOC,
                });
                const href = URL.createObjectURL(binRes.data);
                window.open(href, "_blank");
            } catch (err) {
                console.warn("[ITI-68] Error abriendo PDF (silenciado):", err);
            }
            return;
        }

        // Render como Bundle bonito en un modal
        setViewerOpen(true);
        setViewerLoading(true);
        setViewerError(null);
        setViewerBundle(null);
        // reset de acciones previas
        setShareLoading(false); setShareError(null); setShareText(""); setShareQrDataUrl("");
        setIcvpLoading(false); setIcvpError(null); setIcvpResults([]);

        try {
            const jsonRes = await axiosIcvp.get(url, {
                headers: buildAuthHeaders("application/fhir+json"),
                timeout: TIMEOUT_DOC,
            });
            setViewerBundle(jsonRes.data);
        } catch (err) {
            console.error("[ITI-68] Error cargando Bundle:", err);
            setViewerError(
                err?.response ? `ITI-68 ${err.response.status} ${err.response.statusText}` : String(err)
            );
        } finally {
            setViewerLoading(false);
        }
    };

    /* -------- Render helpers del modal (visor de Bundle) -------- */
    const renderBundleViewer = (bundle) => {
        if (!bundle) return null;
        const isLac  = [PROFILE_LAC_BUNDLE, PROFILE_LAC_COMP]
            .some(p => hasProfile(bundle, p));
        const isIcvp = hasProfile(bundle, PROFILE_ICVP_BUNDLE);

        const composition = getResource(bundle, "Composition");
        const patient = getResource(bundle, "Patient");
        const title =
            composition?.title || composition?.type?.coding?.[0]?.display || "Clinical Document";
        const timestamp = bundle?.timestamp || composition?.date || null;

        const handleShareVHL = async () => {
            try {
                setShareLoading(true);
                setShareError(null);
                setShareText("");
                setShareQrDataUrl("");

                if (!viewerBundle) {
                    setShareError("No hay documento cargado para compartir.");
                    return;
                }

                const resp = await axiosIcvp.post(
                    VHL_ISSUANCE_URL,
                    viewerBundle, // enviamos el Bundle FHIR puro
                    {
                        headers: {
                            ...buildAuthHeaders("application/json"),
                            "Content-Type": "application/json",
                        },
                        responseType: "json",
                        timeout: TIMEOUT_VHL,
                    }
                );

                const hc1 =
                    resp?.data?.hc1
                        ? String(resp.data.hc1).trim()
                        : typeof resp?.data === "string"
                            ? resp.data.trim()
                            : "";

                if (!hc1) {
                    setShareError("El emisor no devolvió un código HC1 válido.");
                    return;
                }

                setShareText(hc1);

                const dataUrl = await QRCode.toDataURL(hc1, {
                    errorCorrectionLevel: "M",
                    margin: 1,
                    scale: 6,
                });
                setShareQrDataUrl(dataUrl);
            } catch (e) {
                console.error("[VHL] Error al compartir:", e);
                const msg = e?.response
                    ? `${e.response.status} ${e.response.statusText}`
                    : e?.message || String(e);
                setShareError(`Error al emitir VHL: ${msg}`);
            } finally {
                setShareLoading(false);
            }
        };

        const handleCopyShareText = async () => {
            try {
                await navigator.clipboard.writeText(shareText || "");
            } catch {
                /* noop  */
            }
        };

        return (
            <div className="ips-bundle-viewer">
                <div
                    className="bundle-header"
                    style={{
                        display: "flex",
                        justifyContent: "space-between",
                        alignItems: "center",
                        gap: "0.75rem",
                        flexWrap: "wrap",
                    }}
                >
                    <h3 className="bundle-title" style={{margin: 0}}>
                        {title}
                    </h3>
                    <div style={{display: "flex", gap: "0.5rem", alignItems: "center"}}>
                        {isLac && (
                            <Button kind="primary" size="sm" onClick={handleShareVHL} disabled={shareLoading}>
                              <FormattedMessage id="SHARE_VHL" defaultMessage="Compartir VHL"/>
                            </Button>
                          )}
                          {isIcvp && (
                            <Button kind="primary" size="sm" onClick={handleGenerateICVP} disabled={icvpLoading}>
                              {icvpLoading
                                                                ? <InlineLoading description={t("GENERATING_ICVP", "Generando ICVP...")}/>
                                : <FormattedMessage id="GENERATE_ICVP" defaultMessage="Generar ICVP"/>
                              }
                            </Button>
                          )}
                    </div>
                </div>

                {timestamp && (
                    <div className="bundle-meta" style={{marginBottom: "1rem"}}>
                        <small>
                            <FormattedMessage id="DOC_DATE" defaultMessage="Date"/>:{" "}
                            {new Date(timestamp).toLocaleString()}
                        </small>
                    </div>
                )}

                {isLac && (shareLoading || shareError || shareText) && (

                    <div className="vhl-share-block" style={{marginBottom: "1rem"}}>
                        {shareLoading && (
                            <InlineLoading
                                description={t("EMITTING_VHL", "Emitiendo VHL...")}
                            />
                        )}
                        {!shareLoading && shareError && (
                            <div className="bundle-error" style={{color: "#da1e28", marginTop: "0.25rem"}}>
                                {shareError}
                            </div>
                        )}

                        {!shareLoading && !shareError && shareText && (
                            <div
                                style={{
                                    display: "grid",
                                    gridTemplateColumns: "auto 1fr",
                                    gap: "1rem",
                                    alignItems: "center",
                                    marginTop: "0.5rem",
                                }}
                            >
                                {shareQrDataUrl ? (
                                    <img src={shareQrDataUrl} alt="QR VHL" style={{width: 168, height: 168}}/>
                                ) : null}
                                <div>
                                    <div
                                        style={{
                                            whiteSpace: "pre-wrap",
                                            wordBreak: "break-word",
                                            background: "var(--cds-layer, #f4f4f4)",
                                            padding: "0.75rem",
                                            borderRadius: "0.25rem",
                                            fontFamily: "monospace",
                                            fontSize: "0.825rem",
                                            lineHeight: 1.3,
                                            marginBottom: "0.5rem",
                                        }}
                                    >
                                        {shareText}
                                    </div>
                                    <Button kind="secondary" size="sm" onClick={handleCopyShareText}>
                                        <FormattedMessage id="COPY_VHL" defaultMessage="Copiar código"/>
                                    </Button>
                                </div>
                            </div>
                        )}
                    </div>
                )}

                {/* Resultados ICVP */}
                {isIcvp && (icvpLoading || icvpError || icvpResults.length > 0) && (
                <div className="icvp-results-block" style={{marginBottom: "1rem"}}>
                    {icvpLoading && (
                    <InlineLoading description={t("GENERATING_ICVP", "Generando ICVP...")}/>
                    )}
                    {!icvpLoading && icvpError && (
                    <div className="bundle-error" style={{color: "#da1e28"}}>{icvpError}</div>
                    )}
                    {!icvpLoading && !icvpError && icvpResults.length > 0 && (
                    <div style={{display: "grid", gap: "1rem"}}>
                        {icvpResults.map((r, idx) => (
                        <div key={idx} style={{
                            border: "1px solid #e0e0e0",
                            borderRadius: 6,
                            padding: "0.75rem",
                            display: "grid",
                            gridTemplateColumns: "auto 1fr",
                            gap: "1rem",
                            alignItems: "center"
                        }}>
                            {r.pngDataUrl ? (
                            <img src={r.pngDataUrl} alt="QR ICVP" style={{width: 168, height: 168}}/>
                            ) : (
                            <div style={{
                                width: 168, height: 168, display: "grid", placeItems: "center",
                                background: "#f4f4f4", color: "#8d8d8d", fontSize: 12
                            }}>sin imagen</div>
                            )}
                            <div>
                            <div style={{marginBottom: 6}}>
                                <b>Immunization:</b> {r.immunizationId || "—"}
                                {!r.ok && <span style={{color: "#da1e28"}}> (error {r.status})</span>}
                            </div>
                            <div style={{
                                whiteSpace: "pre-wrap",
                                wordBreak: "break-word",
                                background: "var(--cds-layer, #f4f4f4)",
                                padding: "0.75rem",
                                borderRadius: "0.25rem",
                                fontFamily: "monospace",
                                fontSize: "0.825rem",
                                lineHeight: 1.3,
                                marginBottom: "0.5rem",
                            }}>
                                {r.hc1 || "—"}
                            </div>
                            <Button
                                kind="secondary"
                                size="sm"
                                onClick={async () => { try { await navigator.clipboard.writeText(r.hc1 || ""); } catch {} }}
                                disabled={!r.hc1}
                            >
                                <FormattedMessage id="COPY_HC1" defaultMessage="Copiar HC1"/>
                            </Button>
                            </div>
                        </div>
                        ))}
                    </div>
                    )}
                </div>
                )}


                {/* Patient */}
                <div className="bundle-block">
                    <h4>
                        <FormattedMessage id="PATIENT" defaultMessage="Patient"/>
                    </h4>
                    {patient?.text?.div ? (
                        <div className="bundle-html" dangerouslySetInnerHTML={safeDiv(patient.text.div)}/>
                    ) : (
                        <div className="bundle-fallback">
                            <div>
                                <b>ID:</b> {patient?.id || "—"}
                            </div>
                            <div>
                                <b>Identifier:</b> {patient?.identifier?.[0]?.value || "—"}
                            </div>
                            <div>
                                <b>Name:</b> {patient?.name?.[0]?.text || "—"}
                            </div>
                        </div>
                    )}
                </div>

                {/* Sections */}
                {(composition?.section || []).map((sec, i) => (
                    <div key={i} className="bundle-block">
                        <h4>{sec.title || sec.code?.coding?.[0]?.display || `Section ${i + 1}`}</h4>
                        {sec.text?.div ? (
                            <div className="bundle-html" dangerouslySetInnerHTML={safeDiv(sec.text.div)}/>
                        ) : (
                            <ul className="bundle-list">
                                {(sec.entry || []).map((ref, k) => (
                                    <li key={k}>{ref.reference}</li>
                                ))}
                            </ul>
                        )}
                    </div>
                ))}
            </div>
        );
    };

    async function handleGenerateICVP() {

    try {
        setIcvpLoading(true);
        setIcvpError(null);
        setIcvpResults([]);

        if (!viewerBundle || viewerBundle.resourceType !== "Bundle" || !viewerBundle.id) {
        setIcvpError("No hay un Bundle válido (con 'id') para generar ICVP.");
        return;
        }

        const resp = await axiosIcvp.post(
        ICVP_FROM_BUNDLE_URL,
        viewerBundle, // Bundle completo
        {
            headers: {
            ...buildAuthHeaders("application/json"),
            "Content-Type": "application/json",
            },
            responseType: "json",
            timeout: TIMEOUT_VHL,
        }
        );

        const results = Array.isArray(resp?.data?.results) ? resp.data.results : [];
        if (results.length === 0) {
        setIcvpError("La operación ICVP no devolvió resultados.");
        return;
        }

        // Mapear cada resultado a { immunizationId, pngDataUrl, hc1 }
        const mapped = results.map(r => {
        let pngDataUrl = "";
        let hc1 = "";
        try {
            const docRef = r?.data?.entry?.find?.(e => e?.resource?.resourceType === "DocumentReference")?.resource;
            const contents = Array.isArray(docRef?.content) ? docRef.content : [];
            for (const c of contents) {
            const ct = c?.attachment?.contentType || "";
            const data = c?.attachment?.data || "";
            const fmt = c?.format?.code || "";
            if (!data) continue;
            if (/^image\/png$/i.test(ct) || fmt === "image") {
                pngDataUrl = `data:image/png;base64,${data}`;

            } else if (/^text\/plain$/i.test(ct) || fmt === "hc1") {
                let txt = String(data || "");
                if (txt && !/^HC1:/.test(txt) && typeof atob === "function") {
                    try { txt = atob(txt); } catch {}
                }
                hc1 = txt;



            }
            }
        } catch {}
        return {
            immunizationId: r?.immunizationId || "",
            ok: !!r?.ok,
            status: r?.status,
            pngDataUrl,
            hc1,
        };
        });

        setIcvpResults(mapped);
    } catch (e) {
        console.error("[ICVP] Error:", e);
        const msg = humanizeHttpError(e, "ICVP");
        setIcvpError(`Error al generar ICVP: ${msg}`);
    } finally {
        setIcvpLoading(false);
    }
    };







    /* -------- UI principal -------- */
    const formsHeading = (
        <FormattedMessage id="DASHBOARD_TITLE_IPS_ICVP_KEY" defaultMessage="IPS LAC Dashboard"/>
    );


    if (error) {
        // Error silenciado: no mostrar nada para no interferir con la UI de Bahmni
        return null;
    }

    // slice para paginación
    const start = (page - 1) * pageSize;
    const end = start + pageSize;
    const docsPage = documents.slice(start, end);
    // En esta pantalla, el QR puede ser ICVP (decodificación local) o VHL (resolver/manifiesto).
    // Si el QR decodifica como ICVP (hcert presente), ocultamos el bloque "Resolver VHL" para evitar confusión.
    const enableVhlResolveUi = !(hc1Decoded?.hcert);

    return (
        <I18nProvider>
            <div className="ips-display-control">
                {/* Header */}
                <div className="ips-header">
                    <h2 className={"forms-display-control-section-title"}>{formsHeading}</h2>

                    {/* Leer VHL: abre modal para pegar/escanner y resolver */}
                    <Button kind="primary" renderIcon={QrCode32} onClick={handleOpenVhlReader}>
                        <FormattedMessage id="READ_ICVP_DOCUMENT" defaultMessage="Leer QR"/>
                    </Button>
                </div>

                <Grid>
                    {/* DocumentReference (ITI-67) */}
                    <Row>
                        <Column lg={12}>
                            <div className="ips-section">
                                <h3>
                                    <FormattedMessage
                                        id="IPS_DOCREF_TITLE"
                                        defaultMessage="Clinical Documents (ITI-67)"
                                    />
                                </h3>

                                {documents.length === 0 ? (
                                    <p className="empty-message">
                                        <FormattedMessage id="NO_DOCREF" defaultMessage="No documents found"/>
                                    </p>
                                ) : (
                                    <>
                                        <DataTable
                                            rows={docsPage.map((doc, idx) => ({
                                                id: doc.id || String(start + idx),
                                                type:
                                                    doc.type?.text ||
                                                    doc.type?.coding?.[0]?.display ||
                                                    doc.type?.coding?.[0]?.code ||
                                                    "—",
                                                date: formatDocDate(doc),
                                                status: doc.status || "—",
                                                actions: "view",
                                            }))}
                                            headers={[
                                                {key: "type", header: t("DOC_TYPE", "Type")},
                                                {key: "date", header: t("DATE", "Date")},
                                                {key: "status", header: t("STATUS", "Status")},
                                                {key: "actions", header: t("ACTIONS", "Actions")},
                                            ]}
                                        >
                                            {({rows, headers, getTableProps, getHeaderProps, getRowProps}) => (
                                                <TableContainer>
                                                    <Table {...getTableProps()}>
                                                        <TableHead>
                                                            <TableRow>
                                                                {headers.map((h) => (
                                                                    <TableHeader {...getHeaderProps({header: h})}>
                                                                        {h.header}
                                                                    </TableHeader>
                                                                ))}
                                                            </TableRow>
                                                        </TableHead>
                                                        <TableBody>
                                                            {rows.map((row, i) => {
                                                                const docForRow = docsPage[i] || null;
                                                                const canView = !!docForRow?.content?.[0]?.attachment?.url;

                                                                return (
                                                                    <TableRow {...getRowProps({row})}>
                                                                        {row.cells.map((cell) => {
                                                                            if (cell.info.header !== "actions") {
                                                                                return <TableCell key={cell.id}>{cell.value}</TableCell>;
                                                                            }
                                                                            return (
                                                                                <TableCell key={cell.id}>
                                                                                    <Button
                                                                                        kind="ghost"
                                                                                        size="sm"
                                                                                        renderIcon={View16}
                                                                                        disabled={!canView}
                                                                                        onClick={() =>
                                                                                            docForRow && handleViewDocument(docForRow)
                                                                                        }
                                                                                    >
                                                                                        <FormattedMessage id="VIEW_DOC"
                                                                                                          defaultMessage="Ver doc"/>
                                                                                    </Button>
                                                                                </TableCell>
                                                                            );
                                                                        })}
                                                                    </TableRow>
                                                                );
                                                            })}
                                                        </TableBody>
                                                    </Table>
                                                </TableContainer>
                                            )}
                                        </DataTable>

                                        {/* Paginación */}
                                        <div className="ips-pagination">
                                            <Pagination
                                                page={page}
                                                pageSize={pageSize}
                                                pageSizes={pageSizes}
                                                totalItems={documents.length}
                                                onChange={({page: p, pageSize: ps}) => {
                                                    setPage(p);
                                                    setPageSize(ps);
                                                }}
                                            />
                                        </div>
                                    </>
                                )}
                            </div>
                        </Column>
                    </Row>
                </Grid>

                {/* Modal: Lector VHL (pegar / cámara) */}
                <ComposedModal open={vhlModalOpen} onClose={handleCloseVhlModal} size="lg">
                    <ModalHeader label="QR" title={t("READ_QR", "Leer QR")}/>
                    <ModalBody hasScrollingContent>
                        <div className="vhl-reader" style={{display: "grid", gap: "1rem"}}>
                            <TextArea
                                id={vhlInputId}
                                labelText={t("PASTE_HC1", "Pega el código (HC1)")}
                                placeholder="HC1:..."
                                rows={4}
                                value={vhlInput}
                                onChange={(e) => setVhlInput(e.target.value)}
                            />

                            {/* Preview / decodificación */}
                            {hc1DecodeLoading && (
                                <InlineLoading description={t("DECODING_QR", "Decodificando QR (Base45)...")} />
                            )}
                            {/* Si no se puede decodificar como ICVP (COSE), no lo tratamos como error fatal: puede ser VHL. */}
                            {!hc1DecodeLoading && !hc1DecodeError && hc1Decoded && (
                                renderIcvpMinPreview(hc1Decoded)
                            )}

                            <div style={{display: "flex", gap: "0.5rem", alignItems: "center"}}>
                                <Button
                                    kind="tertiary"
                                    size="sm"
                                    onClick={async () => {
                                        try {
                                            const normalized = normalizeHc1Input(vhlInput);
                                            setVhlInput(normalized);
                                            await navigator.clipboard.writeText(normalized || "");
                                        } catch {
                                            /* noop */
                                        }
                                    }}
                                    disabled={!String(vhlInput || "").trim()}
                                >
                                    <FormattedMessage id="COPY_HC1" defaultMessage="Copiar código"/>
                                </Button>
                            </div>

                            {/* Scanner */}
                            <div>
                                <div style={{display: "flex", gap: "0.5rem", alignItems: "center"}}>
                                    <Button
                                        kind={vhlScanActive ? "danger--tertiary" : "tertiary"}
                                        size="sm"
                                        onClick={vhlScanActive ? stopVhlScan : startVhlScan}
                                    >
                                        {vhlScanActive
                                            ? t("STOP_SCANNING", "Detener escáner")
                                            : t("SCAN_QR", "Escanear QR")}
                                    </Button>
                                    {vhlScanError && (
                                        <span style={{color: "#da1e28", fontSize: 12}}>{vhlScanError}</span>
                                    )}
                                    {!vhlScanError && vhlScanStatus && (
                                        <span style={{color: "#525252", fontSize: 12}}>{vhlScanStatus}</span>
                                    )}
                                </div>

                                <div
                                    id={qrRegionId}
                                    style={{
                                        width: 320,
                                        height: 320,
                                        marginTop: "0.5rem",
                                        background: "#00000010",
                                        position: "relative",
                                        display: vhlScanActive ? "block" : "none",
                                    }}
                                />
                            </div>

                            {enableVhlResolveUi && (
                                <>
                                    {/* Resolver */}
                                    <div>
                                        <Button kind="primary" size="sm" onClick={handleResolveVHL} disabled={resolveLoading}>
                                            {resolveLoading ? (
                                                <InlineLoading
                                                    description={t("RESOLVING_VHL", "Resolviendo VHL...")}
                                                />
                                            ) : (
                                                <FormattedMessage id="RESOLVE_VHL" defaultMessage="Resolver VHL"/>
                                            )}
                                        </Button>
                                        {resolveError && (
                                            <div style={{color: "#da1e28", marginTop: "0.5rem"}}>{resolveError}</div>
                                        )}
                                    </div>

                                    {/* Archivos del manifiesto */}
                                    {resolveFiles.length > 0 && (
                                        <div className="manifest-files">
                                            <h4 style={{marginBottom: "0.5rem"}}>
                                                <FormattedMessage id="MANIFEST_FILES" defaultMessage="Archivos disponibles"/>
                                            </h4>
                                            <ul style={{listStyle: "none", padding: 0, margin: 0}}>
                                                {resolveFiles.map((f, idx) => (
                                                    <li
                                                        key={idx}
                                                        style={{
                                                            display: "flex",
                                                            justifyContent: "space-between",
                                                            alignItems: "center",
                                                            gap: "0.5rem",
                                                            padding: "0.5rem 0",
                                                            borderTop: idx === 0 ? "none" : "1px solid #e0e0e0",
                                                        }}
                                                    >
                                                        <div style={{minWidth: 0}}>
                                                            <div
                                                                style={{
                                                                    fontFamily: "monospace",
                                                                    fontSize: 12,
                                                                    wordBreak: "break-all",
                                                                }}
                                                                title={f.location}
                                                            >
                                                                {f.location}
                                                            </div>
                                                            <small style={{opacity: 0.7}}>
                                                                {f.contentType || "application/fhir+json"}
                                                            </small>
                                                        </div>
                                                        <div style={{flexShrink: 0}}>
                                                            <Button kind="ghost" size="sm" onClick={() => openResolvedFile(f)}>
                                                                <FormattedMessage id="OPEN" defaultMessage="Abrir"/>
                                                            </Button>
                                                        </div>
                                                    </li>
                                                ))}
                                            </ul>
                                        </div>
                                    )}
                                </>
                            )}
                        </div>
                    </ModalBody>
                    <ModalFooter>
                        <Button kind="secondary" onClick={handleCloseVhlModal}>
                            <FormattedMessage id="CLOSE" defaultMessage="Cerrar"/>
                        </Button>
                    </ModalFooter>
                </ComposedModal>

                {/* Modal Viewer ITI-68 */}
                <ComposedModal
                    open={viewerOpen}
                    onClose={() => setViewerOpen(false)}
                    size="lg"
                    className="custom-wide-modal"
                >
                    <ModalHeader label="ITI-68" title={t("DOC_VIEWER", "Visor de Documento")}/>
                    <ModalBody hasScrollingContent>
                        {viewerLoading && (
                            <div className="bundle-loading">
                                <InlineLoading
                                    description={t("LOADING", "Cargando documento...")}
                                />
                            </div>
                        )}
                        {!viewerLoading && viewerError && (
                            <div className="bundle-error">
                                <FormattedMessage
                                    id="DOC_VIEWER_ERROR"
                                    defaultMessage="No se pudo cargar el documento: {error}"
                                    values={{error: viewerError}}
                                />
                            </div>
                        )}
                        {!viewerLoading && !viewerError && viewerBundle && renderBundleViewer(viewerBundle)}
                    </ModalBody>
                    <ModalFooter>
                        <Button kind="secondary" onClick={() => setViewerOpen(false)}>
                            <FormattedMessage id="CLOSE" defaultMessage="Cerrar"/>
                        </Button>
                    </ModalFooter>
                </ComposedModal>
            </div>
        </I18nProvider>
    );
}

IpsIcvpDisplayControl.propTypes = {
    hostData: PropTypes.shape({
        patientUuid: PropTypes.string.isRequired,
        identifier: PropTypes.string.isRequired,
    }).isRequired,
    hostApi: PropTypes.shape({
        ipsService: PropTypes.shape({
            generateDocument: PropTypes.func,
        }),
    }),
    tx: PropTypes.func,
};

IpsIcvpDisplayControl.defaultProps = {
    hostData: {
        patientUuid: "",
        identifier: "",
    },
    hostApi: {
        ipsService: {
            generateDocument: () => {},
        },
    },
    tx: (key) => key,
};
export default IpsIcvpDisplayControl;