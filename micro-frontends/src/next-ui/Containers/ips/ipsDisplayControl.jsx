import React, {useState, useEffect, useRef} from "react";
import PropTypes from "prop-types";

import "../../../styles/carbon-conflict-fixes.scss";
import "../../../styles/carbon-theme.scss";
import "../../../styles/common.scss";
import "../formDisplayControl/formDisplayControl.scss";
import "./ipsDisplayControl.scss";

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
import QRCode from "qrcode";
import {Html5Qrcode, Html5QrcodeSupportedFormats} from "html5-qrcode";
import {IPS_CONFIG, buildBasicAuth} from "../../config/ipsConfig";

// Instancia AISLADA de axios para evitar que los interceptores globales de Bahmni
// intercepten los errores y muestren diálogos de error en la UI de Bahmni.
// Timeouts diferenciados para no bloquear la UI cuando el servidor no responde:
//   TIMEOUT_LIST  → carga inicial (spinner de página), falla rápido si no hay servidor
//   TIMEOUT_DOC   → ver documento (el usuario hizo clic, puede esperar más)
//   TIMEOUT_VHL   → operaciones VHL generate/resolve
const TIMEOUT_LIST = 6000;
const TIMEOUT_DOC  = 20000;
const TIMEOUT_VHL  = 15000;

const axiosIps = axios.create({ timeout: TIMEOUT_DOC });

/* ===========================
   CONFIG ITI-67/68
   =========================== */
// En producción, usa variables de entorno o window.__MFE_CONFIG__.
const { REGIONAL_BASE, VHL_ISSUANCE_URL, VHL_RESOLVE_URL } = IPS_CONFIG;

// Headers con Basic Auth (por OpenHIM)
const buildAuthHeaders = (accept = "application/fhir+json") => {
    const headers = {Accept: accept};
    const auth = buildBasicAuth();
    if (auth) headers.Authorization = auth;
    return headers;
};

// Une base + path cuidando slashes
const joinUrl = (base, path) =>
    `${base.replace(/\/+$/, "")}/${String(path || "").replace(/^\/+/, "")}`;

// Dada la fullUrl de un DocumentReference, obtén la base FHIR sin el recurso final
const getFhirBaseFromDocFullUrl = (fullUrl) => {
    if (!fullUrl) return null;
    const match = String(fullUrl).match(/^(https?:\/\/[^/]+?)\/DocumentReference(?:\/|$)/i);
    if (match) return match[1];
    return String(fullUrl).replace(/\/DocumentReference\/.*$/, "");
};

// Resuelve attachment.url relativo contra la base detectada en el DocumentReference
const resolveAttachmentUrl = (doc, attachmentUrl) => {
    const url = String(attachmentUrl || "");
    if (!url) return null;

    // Si ya es una URL absoluta, devuélvela tal cual
    if (/^https?:\/\//i.test(url)) {
        console.log("[resolveAttachmentUrl] URL absoluta:", url);
        return url;
    }

    const base = doc?.__docRefBase || REGIONAL_BASE;
    console.log("[resolveAttachmentUrl] base:", base, "attachmentUrl:", attachmentUrl);

    // Para URLs que empiezan con //, usar el protocolo de la base
    if (url.startsWith("//")) {
        try {
            const baseUrl = new URL(base);
            const resolved = `${baseUrl.protocol}${url}`;
            console.log("[resolveAttachmentUrl] URL // resuelta:", resolved);
            return resolved;
        } catch {
            return `http:${url}`;
        }
    }

    // Para URLs relativas (paths), construir URL completa preservando el protocolo de base
    try {
        const baseUrl = new URL(base);
        if (url.startsWith("/")) {
            const resolved = `${baseUrl.origin}${url}`;
            console.log("[resolveAttachmentUrl] Path absoluto resuelto:", resolved);
            return resolved;
        }
    } catch (err) {
        console.warn("[resolveAttachmentUrl] Error parseando base URL:", err);
        /* fallback al joinUrl */
    }

    const resolved = joinUrl(base, url);
    console.log("[resolveAttachmentUrl] joinUrl resuelto:", resolved);
    return resolved;
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
            `?patient.identifier=${encodeURIComponent(ensured)}&_count=${count}&type=60591-5&_sort=-_lastUpdated`;

        let res;
            console.log('axiosIps IPS ITI-67 GET', url);
        try {
            res = await axiosIps.get(url, {headers: buildAuthHeaders("application/fhir+json"), timeout: TIMEOUT_LIST});
        } catch (err) {
            // Silenciar siempre: no propagar errores de red para evitar diálogos de Bahmni
            console.warn("[IPS] Error ITI-67 (silenciado):", err?.message || err);
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

// Normaliza Bundle -> DocumentReference[]
const parseDocRefsFromBundle = (bundle) => {
    if (!bundle || !Array.isArray(bundle.entry) || bundle.entry.length === 0) return [];
    return (bundle.entry || [])
        .map((entry) => {
            const resource = entry?.resource;
            if (resource?.resourceType !== "DocumentReference") return null;
            const fullUrl = entry?.fullUrl || "";
            const base = getFhirBaseFromDocFullUrl(fullUrl) || REGIONAL_BASE;
            console.log("[parseDocRefsFromBundle] DocumentReference id:", resource?.id, "fullUrl:", fullUrl, "base detectada:", base);
            return {...resource, __docRefBase: base, __fullUrl: fullUrl};
        })
        .filter(Boolean);
};

/* ===========================
   Helpers de render FHIR
   =========================== */
const getResource = (bundle, resourceType) =>
    (bundle?.entry || []).map((e) => e.resource).find((r) => r?.resourceType === resourceType) || null;

const safeDiv = (html) => ({__html: html || ""});

/* ===========================
   COMPONENTE
   =========================== */
export function IpsDisplayControl(props) {
    const {hostData, tx} = props;
    const {identifier} = hostData || {};

    const t = (key, fallback) => {
        const value = tx?.(key);
        return !value || value === key ? fallback : value;
    };

    // IDs únicos para evitar colisión si IPS + ICVP están renderizados en la misma pantalla.
    const qrRegionId = "vhl-qr-region-ips";
    const vhlInputId = "vhl-input-ips";

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

    // Leer VHL (pegar/scannear → resolver → elegir archivo → ver Bundle)
    const [vhlModalOpen, setVhlModalOpen] = useState(false);
    const [vhlInput, setVhlInput] = useState("");           // texto pegado/escaneado (HC1:...)
    const [vhlScanActive, setVhlScanActive] = useState(false);
    const [vhlScanError, setVhlScanError] = useState(null);
    const [vhlScanStatus, setVhlScanStatus] = useState("");
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
                console.warn("[IPS] ITI-67 error (silenciado, no se mostrará en UI):", e);
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
        setResolveFiles([]);
        setResolveError(null);
        setShareError(null);
    };

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

                    // Si tras unos segundos no detecta nada, dar feedback (sin cortar el escáner)
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

            const resp = await axiosIps.post(
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

        try {
            // Algunos servidores (p.ej. /v2/ips-json) responden 406 si el Accept es demasiado estricto.
            // Para evitarlo, pedimos FHIR+JSON pero aceptamos también application/json y */*.
            const accept = "application/fhir+json, application/json;q=0.9, */*;q=0.8";
            const sameOrigin = String(location).startsWith(REGIONAL_BASE);
            const headers = sameOrigin ? buildAuthHeaders(accept) : { Accept: accept };
            const res = await axiosIps.get(location, { headers, responseType: "json", timeout: TIMEOUT_DOC });
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
                const binRes = await axiosIps.get(url, {
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
        try {
            console.log('axiosIps IPS ITI-68 GET', url);
            const jsonRes = await axiosIps.get(url, {
                headers: buildAuthHeaders("application/fhir+json"),
                timeout: TIMEOUT_DOC,
            });
            console.log('axiosIps IPS ITI-68 response', jsonRes);
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

        const composition = getResource(bundle, "Composition");
        const patient = getResource(bundle, "Patient");
        const title =
            composition?.title || composition?.type?.coding?.[0]?.display || "Clinical Document";
        const timestamp = bundle?.timestamp || composition?.date || null;
        const sections = composition?.section || [];

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

                const resp = await axiosIps.post(
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
                        <Button kind="primary" size="sm" onClick={handleShareVHL} disabled={shareLoading}>
                            <FormattedMessage id="SHARE_VHL" defaultMessage="Compartir VHL"/>
                        </Button>
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

                {(shareLoading || shareError || shareText) && (
                    <div className="vhl-share-block" style={{marginBottom: "1rem"}}>
                        {shareLoading && (
                            <InlineLoading
                                description={t("EMITTING_VHL", "Emitiendo VHL...")}
                            />
                        )}

                        {!shareLoading && shareError && (
                            <div className="bundle-error" style={{color: "#da1e28"}}>
                                {shareError}
                            </div>
                        )}

                        {!shareLoading && !shareError && shareText && (
                            <div
                                className="vhl-share-result"
                                style={{
                                    display: "grid",
                                    gridTemplateColumns: "auto 1fr",
                                    gap: "1rem",
                                    alignItems: "center",
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

    /* -------- UI principal -------- */
    const formsHeading = (
        <FormattedMessage id="DASHBOARD_TITLE_IPS_LAC_KEY" defaultMessage="IPS LAC Dashboard"/>
    );


    if (error) {
        // Error silenciado: no mostrar nada para no interferir con la UI de Bahmni
        return null;
    }

    // slice para paginación
    const start = (page - 1) * pageSize;
    const end = start + pageSize;
    const docsPage = documents.slice(start, end);

    return (
        <I18nProvider>
            <div className="ips-display-control">
                {/* Header */}
                <div className="ips-header">
                    <h2 className={"forms-display-control-section-title"}>{formsHeading}</h2>

                    {/* Leer VHL: abre modal para pegar/escanner y resolver */}
                    <Button kind="primary" renderIcon={QrCode32} onClick={handleOpenVhlReader}>
                        <FormattedMessage id="READ_VHL_DOCUMENT" defaultMessage="Leer QR"/>
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
                    <ModalHeader label="QR" title={t("READ_VHL_DOCUMENT", "Leer QR")}/>
                    <ModalBody hasScrollingContent>
                        <div className="vhl-reader" style={{display: "grid", gap: "1rem"}}>
                            <TextArea
                                id={vhlInputId}
                                labelText={t("PASTE_VHL_HC1", "Pega el código (HC1)")}
                                placeholder="HC1:..."
                                rows={4}
                                value={vhlInput}
                                onChange={(e) => setVhlInput(e.target.value)}
                            />

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




IpsDisplayControl.propTypes = {
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

IpsDisplayControl.defaultProps = {
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
