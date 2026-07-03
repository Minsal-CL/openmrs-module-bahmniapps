import React, { useEffect, useState, useCallback, useRef } from "react";
import PropTypes from "prop-types";
import axios from "axios";
import { Html5Qrcode, Html5QrcodeSupportedFormats } from "html5-qrcode";
import { fetchResourcesFromDocs, DOC_TYPE } from "../../config/racselNodesConfig";
import { MEOW_CONFIG, buildMeowAuthHeaders, extractBundleId, extractMeowPayload } from "../../config/meowConfig";
import "./medicationStatementDisplayControl.scss";

const axiosMS = axios.create({ timeout: 20000 });

const TITLE = "Reporte de Medicamentos";
const READER_REGION_ID = "meow-qr-reader-region";

const EMPTY_QR_MODAL = { open: false, loading: false, error: null, title: "", qrCodeDataUrl: null };
const EMPTY_READER = {
  open: false,
  text: "",
  imageBase64: null,
  imageName: "",
  scanActive: false,
  scanError: null,
  scanStatus: "",
  loading: false,
  error: null,
  payload: null,
  decoded: null,
};

// Document-based (igual que IPS): DocumentReference (type 56445-0) -> Bundle -> MedicationStatement[]
const fetchMedicationStatements = async (identifier) =>
  fetchResourcesFromDocs(axiosMS, identifier, DOC_TYPE.MEDICATION_REPORT, "MedicationStatement");

const medicationText = (ms) => {
  const cc = ms.medicationCodeableConcept;
  if (!cc) return "—";
  const code = cc.coding && cc.coding[0];
  const codeTxt = code ? `${code.code}` : "";
  return cc.text ? `${cc.text}${codeTxt ? ` (SNOMED ${codeTxt})` : ""}` : (code && code.display) || codeTxt || "—";
};

const normalizeHc1Input = (rawInput) => {
  const raw = String(rawInput || "").trim();
  if (!raw) return "";
  const withoutLineBreaks = raw.replace(/[\r\n\t]+/g, "").trim();
  if (/^HC1:/i.test(withoutLineBreaks)) {
    return `HC1:${withoutLineBreaks.replace(/^HC1:/i, "").trim()}`;
  }
  return withoutLineBreaks;
};

// "Network Error" de axios no trae response (CORS bloqueado, mediador caído/no registrado en
// OpenHIM, DNS, o mixed-content). Se agrega una pista para no confundirlo con un error de negocio.
const humanizeHttpError = (e, fallbackLabel = "Error") => {
  if (e && e.response) return `${e.response.status} ${e.response.statusText}`;
  const raw = (e && e.message) || String(e || fallbackLabel);
  if (/Network Error/i.test(raw) || /Failed to fetch/i.test(raw)) {
    return `${raw} (posible CORS, mediador MeOw no disponible/registrado en OpenHIM, o certificado TLS no confiable)`;
  }
  return raw;
};

// Log detallado en consola para poder distinguir CORS / mediador caído / error de negocio
// sin depender del mensaje genérico "Network Error" que muestra axios en la UI.
const logMeowError = (context, e, extra) => {
  // eslint-disable-next-line no-console
  console.error(`[MeOw] ${context} falló:`, {
    message: e && e.message,
    code: e && e.code,
    url: e && e.config && e.config.url,
    method: e && e.config && e.config.method,
    requestData: e && e.config && e.config.data,
    hasResponse: !!(e && e.response),
    responseStatus: e && e.response && e.response.status,
    responseData: e && e.response && e.response.data,
    hasRequest: !!(e && e.request),
    ...extra,
  });
  // eslint-disable-next-line no-console
  console.error(e);
};

const nextFrame = () =>
  new Promise((resolve) => {
    if (typeof window !== "undefined" && typeof window.requestAnimationFrame === "function") {
      window.requestAnimationFrame(() => window.requestAnimationFrame(resolve));
      return;
    }
    setTimeout(resolve, 0);
  });

const waitRegionReady = async (id, timeoutMs = 10000) => {
  const start = Date.now();
  for (;;) {
    const el = document.getElementById(id);
    if (el) {
      const r = el.getBoundingClientRect();
      if (el.offsetParent !== null && r.width > 10 && r.height > 10) return el;
    }
    if (Date.now() - start > timeoutMs) {
      throw new Error("El lector de QR no está listo. Cierra el diálogo y reintenta.");
    }
    await nextFrame();
  }
};

// React desmonta todo el árbol si un error de render no es capturado por un Error Boundary
// (solo funciona en class components). Se agrega para que un error al pegar el HC1 no
// haga "desaparecer" el pop-up entero sin dejar rastro: en vez de eso, muestra el error.
class MeowErrorBoundary extends React.Component {
  constructor(props) {
    super(props);
    this.state = { error: null };
  }

  static getDerivedStateFromError(error) {
    return { error };
  }

  componentDidCatch(error, info) {
    // eslint-disable-next-line no-console
    console.error("[MeOw] Error de render capturado:", error, info && info.componentStack);
  }

  render() {
    if (this.state.error) {
      return (
        <div className="ms-dash">
          <div className="ms-dash__error">
            ⚠️ Ocurrió un error inesperado en el dashboard de medicamentos: {this.state.error.message || String(this.state.error)}
          </div>
        </div>
      );
    }
    return this.props.children;
  }
}

function MedicationStatementDisplayControlInner(props) {
  const { hostData } = props;
  const { identifier } = hostData || {};
  const [items, setItems] = useState([]); // [{resource, docRef, bundleUrl}]
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [qrModal, setQrModal] = useState(EMPTY_QR_MODAL);
  const [reader, setReader] = useState(EMPTY_READER);
  const scannerRef = useRef(null);

  const load = useCallback(async () => {
    if (!identifier) { setLoading(false); return; }
    setLoading(true); setError(null);
    try { setItems(await fetchMedicationStatements(identifier)); }
    catch (e) { setError(e && e.message ? e.message : "Error consultando medicamentos"); }
    finally { setLoading(false); }
  }, [identifier]);

  useEffect(() => { load(); }, [load]);

  useEffect(() => () => {
    if (scannerRef.current) {
      try { scannerRef.current.stop(); } catch { /* noop */ }
      try { scannerRef.current.clear(); } catch { /* noop */ }
    }
  }, []);

  const closeQrModal = () => setQrModal(EMPTY_QR_MODAL);

  const handleGenerateQr = async (ms, bundleUrl) => {
    const title = medicationText(ms);
    setQrModal({ open: true, loading: true, error: null, title, qrCodeDataUrl: null });
    try {
      const bundleId = extractBundleId(bundleUrl);
      if (!bundleId) throw new Error("No se pudo determinar el documento del medicamento.");

      const payload = {
        resourceType: "Bundle",
        id: bundleId,
        entry: [{ resource: { resourceType: "MedicationStatement", id: ms.id } }],
      };
      // eslint-disable-next-line no-console
      console.log("[MeOw] POST _generate", MEOW_CONFIG.GENERATE_URL, payload);
      const res = await axiosMS.post(MEOW_CONFIG.GENERATE_URL, payload, {
        headers: { ...buildMeowAuthHeaders(), "Content-Type": "application/json" },
      });
      // eslint-disable-next-line no-console
      console.log("[MeOw] _generate response", res.status, res.data);

      const results = (res.data && res.data.results) || [];
      const result = results.find((r) => r.medicationStatementId === ms.id) || results[0];
      const qrCode = result && result.qrCodes && result.qrCodes[0];
      if (!result || result.ok === false || !qrCode || !qrCode.qrCodeDataUrl) {
        throw new Error("No se pudo generar el QR para este medicamento.");
      }

      setQrModal((q) => ({ ...q, loading: false, qrCodeDataUrl: qrCode.qrCodeDataUrl }));
    } catch (e) {
      logMeowError("_generate", e, { medicationStatementId: ms.id, bundleUrl });
      setQrModal((q) => ({ ...q, loading: false, error: humanizeHttpError(e, "Error generando el QR") }));
    }
  };

  /* -------- Lector de QR (/meow/_decode) -------- */
  const stopScan = async () => {
    try {
      if (scannerRef.current) {
        try { await scannerRef.current.stop(); } catch { /* noop */ }
        try { await scannerRef.current.clear(); } catch { /* noop */ }
      }
    } finally {
      scannerRef.current = null;
      setReader((r) => ({ ...r, scanActive: false, scanStatus: "" }));
    }
  };

  const openReader = () => setReader({ ...EMPTY_READER, open: true });

  const closeReader = async () => {
    await stopScan();
    setReader(EMPTY_READER);
  };

  const startScan = async () => {
    setReader((r) => ({ ...r, scanError: null, scanStatus: "Activando cámara…", scanActive: true }));
    try {
      await nextFrame();
      await waitRegionReady(READER_REGION_ID);
      if (scannerRef.current) await stopScan();

      const scanner = new Html5Qrcode(READER_REGION_ID, {
        formatsToSupport: [Html5QrcodeSupportedFormats.QR_CODE],
        // El QR de MeOw (HC1) es muy denso (payload CBOR/Base45 largo): el decoder JS puro
        // falla seguido con cámaras web a baja resolución. El BarcodeDetector nativo del
        // navegador (Chrome/Edge) es mucho más robusto para códigos densos; si el browser
        // no lo soporta, html5-qrcode cae automáticamente al decoder JS de siempre.
        experimentalFeatures: { useBarCodeDetectorIfSupported: true },
        verbose: false,
      });
      scannerRef.current = scanner;

      const cams = await Html5Qrcode.getCameras();
      if (!Array.isArray(cams) || cams.length === 0) throw new Error("No se encontraron cámaras disponibles");
      const back = cams.find((c) => /back|rear|environment/i.test(c.label));
      const deviceId = (back || cams[0]).id;

      await scanner.start(
        {
          deviceId: { exact: deviceId },
          // Más resolución = más píxeles por módulo del QR denso = mejor tasa de decodificación.
          width: { ideal: 1920 },
          height: { ideal: 1080 },
        },
        {
          fps: 10,
          qrbox: (vw, vh) => {
            const min = Math.min(vw, vh);
            // Caja de escaneo grande: un QR denso necesita ocupar el mayor área posible
            // del cuadro para que cada módulo tenga suficientes píxeles.
            const size = Math.floor(Math.min(420, min * 0.9));
            return { width: size, height: size };
          },
          aspectRatio: 1.0,
          disableFlip: true,
        },
        async (decodedText) => {
          setReader((r) => ({ ...r, text: decodedText || "", imageBase64: null, imageName: "", scanStatus: "QR detectado." }));
          await stopScan();
        },
        (() => {
          const startedAt = Date.now();
          let lastNoticeAt = 0;
          return (errMsg) => {
            const now = Date.now();
            if (now - startedAt <= 4000) {
              if (now - lastNoticeAt > 2000) {
                lastNoticeAt = now;
                setReader((r) => (r.scanActive ? { ...r, scanStatus: "Cámara activa. Apunta al QR dentro del recuadro." } : r));
              }
              return;
            }
            if (now - lastNoticeAt > 2500) {
              lastNoticeAt = now;
              setReader((r) => (r.scanActive
                ? { ...r, scanStatus: "No se detecta el QR aún. Acércalo/aléjalo, evita reflejos y espera 2–3s." }
                : r));
            }
          };
        })()
      );
    } catch (e) {
      setReader((r) => ({
        ...r,
        scanError: (e && e.message) || "No se pudo iniciar la cámara. Revisa los permisos.",
        scanStatus: "",
        scanActive: false,
      }));
      await stopScan();
    }
  };

  const handleFileChange = (e) => {
    const file = e.target.files && e.target.files[0];
    if (!file) return;
    const fr = new FileReader();
    fr.onload = () => {
      const base64 = String(fr.result || "").replace(/^data:.*;base64,/, "");
      setReader((r) => ({ ...r, imageBase64: base64, imageName: file.name, text: "" }));
    };
    fr.readAsDataURL(file);
  };

  const handleDecode = async () => {
    setReader((r) => ({ ...r, loading: true, error: null, payload: null, decoded: null }));
    try {
      let body;
      if (reader.imageBase64) {
        body = { qrImage: reader.imageBase64 };
      } else {
        const hc1 = normalizeHc1Input(reader.text);
        if (!hc1) throw new Error("Pega un código HC1, escanea con la cámara o sube una imagen del QR.");
        body = { hc1 };
      }

      // eslint-disable-next-line no-console
      console.log("[MeOw] POST _decode", MEOW_CONFIG.DECODE_URL, reader.imageBase64 ? { qrImage: "<base64 omitido>" } : body);
      const res = await axiosMS.post(MEOW_CONFIG.DECODE_URL, body, {
        headers: { ...buildMeowAuthHeaders(), "Content-Type": "application/json" },
      });
      // eslint-disable-next-line no-console
      console.log("[MeOw] _decode response", res.status, res.data);

      const decoded = res.data && res.data.decoded;
      if (!decoded) throw new Error("El servicio de decodificación no devolvió un resultado.");
      const payload = extractMeowPayload(decoded);
      if (!payload) throw new Error("El QR no contiene un certificado MeOw interpretable.");

      setReader((r) => ({ ...r, loading: false, decoded, payload }));
    } catch (e) {
      logMeowError("_decode", e, { usingImage: !!reader.imageBase64 });
      setReader((r) => ({ ...r, loading: false, error: humanizeHttpError(e, "Error decodificando el QR") }));
    }
  };

  let body;
  if (loading) body = <div className="ms-dash__msg">Cargando medicamentos…</div>;
  else if (error) body = <div className="ms-dash__error">⚠️ {error}</div>;
  else if (!items.length) body = <div className="ms-dash__msg">Sin reporte de medicamentos para este paciente.</div>;
  else body = (
    <table className="ms-table">
      <thead>
        <tr>
          <th>Estado</th>
          <th>Medicamento</th>
          <th>Dosis</th>
          <th>Vía</th>
          <th>Fecha</th>
          <th>QR</th>
        </tr>
      </thead>
      <tbody>
        {items.map(({ resource: ms, bundleUrl }) => {
          const dosage = (ms.dosage && ms.dosage[0]) || {};
          return (
            <tr key={ms.id}>
              <td><span className={`ms-status ms-status--${ms.status}`}>{ms.status}</span></td>
              <td>{medicationText(ms)}</td>
              <td>{dosage.text || "—"}</td>
              <td>{(dosage.route && dosage.route.text) || "—"}</td>
              <td>{(ms.effectiveDateTime || "").slice(0, 10) || "—"}</td>
              <td>
                {bundleUrl ? (
                  <button type="button" className="ms-qr-btn" onClick={() => handleGenerateQr(ms, bundleUrl)}>
                    Generar QR
                  </button>
                ) : "—"}
              </td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );

  const qrModalEl = qrModal.open && (
    <div className="ms-qr-modal__overlay" onClick={closeQrModal}>
      <div className="ms-qr-modal" onClick={(e) => e.stopPropagation()}>
        <div className="ms-qr-modal__header">
          <span className="ms-qr-modal__title">{qrModal.title}</span>
          <button type="button" className="ms-qr-modal__close" onClick={closeQrModal} aria-label="Cerrar">×</button>
        </div>
        <div className="ms-qr-modal__body">
          {qrModal.loading && <div className="ms-dash__msg">Generando QR…</div>}
          {!qrModal.loading && qrModal.error && <div className="ms-dash__error">⚠️ {qrModal.error}</div>}
          {!qrModal.loading && !qrModal.error && qrModal.qrCodeDataUrl && (
            <img className="ms-qr-modal__img" src={qrModal.qrCodeDataUrl} alt="QR MeOw" />
          )}
        </div>
      </div>
    </div>
  );

  const payload = reader.payload;
  const meds = (payload && Array.isArray(payload.m)) ? payload.m : [];

  const readerModalEl = reader.open && (
    <div className="ms-qr-modal__overlay" onClick={closeReader}>
      <div
        className="ms-qr-modal ms-qr-modal--wide"
        onClick={(e) => e.stopPropagation()}
        onKeyDown={(e) => e.stopPropagation()}
        onKeyUp={(e) => e.stopPropagation()}
        onPaste={(e) => e.stopPropagation()}
      >
        <div className="ms-qr-modal__header">
          <span className="ms-qr-modal__title">Leer QR MeOw</span>
          <button type="button" className="ms-qr-modal__close" onClick={closeReader} aria-label="Cerrar">×</button>
        </div>
        <div className="ms-qr-modal__body ms-qr-modal__body--reader">
          <div className="ms-reader__inputs">
            <div className="ms-reader__scan">
              <button type="button" className="ms-qr-btn" onClick={reader.scanActive ? stopScan : startScan}>
                {reader.scanActive ? "Detener cámara" : "Escanear con cámara"}
              </button>
              {reader.scanStatus && <div className="ms-dash__msg">{reader.scanStatus}</div>}
              {reader.scanError && <div className="ms-dash__error">⚠️ {reader.scanError}</div>}
              {reader.scanActive && <div id={READER_REGION_ID} className="ms-reader__region" />}
            </div>

            <div className="ms-reader__paste">
              <label htmlFor="ms-reader-hc1">O pega el código HC1</label>
              <textarea
                id="ms-reader-hc1"
                rows={3}
                value={reader.text}
                onChange={(e) => {
                  const value = e.target.value;
                  setReader((r) => ({ ...r, text: value, imageBase64: null, imageName: "" }));
                }}
                onPaste={(e) => {
                  e.stopPropagation();
                  // eslint-disable-next-line no-console
                  console.log("[MeOw] onPaste en textarea HC1", {
                    length: e.clipboardData && e.clipboardData.getData("text").length,
                  });
                }}
                onKeyDown={(e) => e.stopPropagation()}
                placeholder="HC1:..."
              />
            </div>

            <div className="ms-reader__file">
              <label htmlFor="ms-reader-file">O sube una imagen del QR</label>
              <input id="ms-reader-file" type="file" accept="image/*" onChange={handleFileChange} />
              {reader.imageName && <span className="ms-reader__filename">{reader.imageName}</span>}
            </div>

            <button type="button" className="ms-qr-btn ms-qr-btn--primary" onClick={handleDecode} disabled={reader.loading}>
              {reader.loading ? "Decodificando…" : "Decodificar"}
            </button>
          </div>

          <div className="ms-reader__result">
            {reader.loading && <div className="ms-dash__msg">Decodificando QR…</div>}
            {!reader.loading && reader.error && <div className="ms-dash__error">⚠️ {reader.error}</div>}
            {!reader.loading && !reader.error && payload && (
              <div className="ms-reader__payload">
                <div className="ms-reader__patient">
                  <div><b>Nombre:</b> {payload.n || "—"}</div>
                  <div><b>Identificador:</b> {payload.id || "—"}</div>
                  <div><b>Fecha de nacimiento:</b> {payload.dob || "—"}</div>
                  <div><b>Sexo:</b> {payload.s || "—"}</div>
                  <div><b>Documento:</b> {payload.dt || "—"}</div>
                </div>
                <table className="ms-table ms-reader__meds">
                  <thead>
                    <tr>
                      <th>Código</th>
                      <th>Descripción</th>
                      <th>Dosis</th>
                    </tr>
                  </thead>
                  <tbody>
                    {meds.length === 0 ? (
                      <tr><td colSpan={3}>Sin medicamentos en el QR.</td></tr>
                    ) : meds.map((m, idx) => (
                      <tr key={idx}>
                        <td>{m.m || "—"}</td>
                        <td>{m.r || "—"}</td>
                        <td>{m.d || "—"}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );

  return (
    <div className="ms-dash">
      <div className="ms-dash__header">
        <h3 className="ms-dash__title">{TITLE}</h3>
        <button type="button" className="ms-qr-btn" onClick={openReader}>Leer QR</button>
      </div>
      {qrModalEl}
      {readerModalEl}
      {body}
    </div>
  );
}

export function MedicationStatementDisplayControl(props) {
  return (
    <MeowErrorBoundary>
      <MedicationStatementDisplayControlInner {...props} />
    </MeowErrorBoundary>
  );
}

MedicationStatementDisplayControl.propTypes = {
  hostData: PropTypes.shape({
    patientUuid: PropTypes.string,
    identifier: PropTypes.string,
  }),
  hostApi: PropTypes.object,
};

MedicationStatementDisplayControl.defaultProps = {
  hostData: { patientUuid: "", identifier: "" },
  hostApi: {},
};
