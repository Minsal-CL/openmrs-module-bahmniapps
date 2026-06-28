import React, { useEffect, useState, useCallback } from "react";
import PropTypes from "prop-types";
import axios from "axios";
import {
  NODES_CONFIG, buildAuthHeaders, fetchServiceRequestsByPatient,
} from "../../config/racselNodesConfig";
import "./serviceRequestDisplayControl.scss";

// Instancia aislada para no arrastrar interceptores globales de Bahmni
const axiosSR = axios.create({ timeout: 20000 });

const TITLE = "Interconsultas Transfronterizas";

// Convierte una referencia relativa (ej. "Bundle/2366") en URL absoluta al NN para que el link
// no se resuelva contra la URL de la app Bahmni.
const absUrl = (ref) => {
  if (!ref) return null;
  if (/^https?:\/\//i.test(ref)) return ref;
  return `${NODES_CONFIG.NATIONAL_FHIR_BASE}/${String(ref).replace(/^\//, "")}`;
};

// Resource-based: la interconsulta es un ServiceRequest suelto (LACServiceRequestIT) en el NN.
// Se lee el recurso vivo para que el estado refleje el PUT de "Completar" (Track 1.2-G).
const fetchServiceRequests = async (identifier) =>
  fetchServiceRequestsByPatient(axiosSR, identifier);

// T1.2-G: completar la solicitud -> PUT con status "completed" en el NODO NACIONAL
// (el mediador registra el SR suelto también ahí; el track dice PUT a <NN País A>).
const completeServiceRequest = async (sr) => {
  const base = NODES_CONFIG.NATIONAL_FHIR_BASE;
  // Quitamos meta de versión/origen (provoca 400 al re-PUT) conservando el profile,
  // y dejamos supportingInfo (IPS) como URL absoluta.
  const { meta, ...rest } = sr;
  const cleanMeta = meta && meta.profile ? { profile: meta.profile } : undefined;
  const updated = { ...rest, ...(cleanMeta ? { meta: cleanMeta } : {}), status: "completed" };
  if (Array.isArray(updated.supportingInfo)) {
    updated.supportingInfo = updated.supportingInfo.map((si) =>
      si && si.reference ? { ...si, reference: absUrl(si.reference) } : si);
  }
  const url = `${base}/ServiceRequest/${sr.id}`;
  await axiosSR.put(url, updated, {
    headers: { ...buildAuthHeaders(), "Content-Type": "application/fhir+json" },
  });
};

const destinationOf = (sr) => {
  const contained = (sr.contained || []).find((c) => c.id === "org-dest");
  if (contained) {
    const country = contained.address && contained.address[0] && contained.address[0].country;
    return [contained.name, country].filter(Boolean).join(" · ");
  }
  return (sr.performer && sr.performer[0] && sr.performer[0].display) || "—";
};

export function ServiceRequestDisplayControl(props) {
  const { hostData } = props;
  const { identifier } = hostData || {};
  const [items, setItems] = useState([]); // [{resource}] (ServiceRequest suelto del NN)
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [busyId, setBusyId] = useState(null);

  const load = useCallback(async () => {
    if (!identifier) { setLoading(false); return; }
    setLoading(true); setError(null);
    try { setItems(await fetchServiceRequests(identifier)); }
    catch (e) { setError(e && e.message ? e.message : "Error consultando interconsultas"); }
    finally { setLoading(false); }
  }, [identifier]);

  useEffect(() => { load(); }, [load]);

  const onComplete = async (sr) => {
    setBusyId(sr.id); setError(null);
    try { await completeServiceRequest(sr); await load(); }
    catch (e) {
      const oo = e && e.response && e.response.data;
      const issue = oo && oo.issue && oo.issue[0];
      const diag = issue && (issue.diagnostics || (issue.details && issue.details.text));
      setError(diag || (e && e.message) || "No se pudo completar la solicitud");
    }
    finally { setBusyId(null); }
  };

  let body;
  if (loading) body = <div className="sr-dash__msg">Cargando interconsultas…</div>;
  else if (error) body = <div className="sr-dash__error">⚠️ {error}</div>;
  else if (!items.length) body = <div className="sr-dash__msg">Sin interconsultas para este paciente.</div>;
  else body = (
    <table className="sr-table">
      <thead>
        <tr>
          <th>Estado</th>
          <th>Especialidad</th>
          <th>Destino</th>
          <th>Motivo</th>
          <th>Fecha</th>
          <th>IPS</th>
          <th aria-label="acciones" />
        </tr>
      </thead>
      <tbody>
        {items.map(({ resource: sr }) => {
          const ips = absUrl(sr.supportingInfo && sr.supportingInfo[0] && sr.supportingInfo[0].reference);
          return (
            <tr key={sr.id}>
              <td><span className={`sr-status sr-status--${sr.status}`}>{sr.status}</span></td>
              <td>{(sr.code && sr.code.text) || "—"}</td>
              <td>{destinationOf(sr)}</td>
              <td>{(sr.reasonCode && sr.reasonCode[0] && sr.reasonCode[0].text) || "—"}</td>
              <td>{(sr.authoredOn || "").slice(0, 10) || "—"}</td>
              <td>{ips ? <a href={`${ips}?_pretty=true`} target="_blank" rel="noreferrer">Ver IPS</a> : "—"}</td>
              <td>
                {sr.status === "active" ? (
                  <button
                    className="sr-btn-complete"
                    disabled={busyId === sr.id}
                    onClick={() => onComplete(sr)}
                  >
                    {busyId === sr.id ? "…" : "Completar"}
                  </button>
                ) : null}
              </td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );

  return (
    <div className="sr-dash">
      <h3 className="sr-dash__title">{TITLE}</h3>
      {body}
    </div>
  );
}

ServiceRequestDisplayControl.propTypes = {
  hostData: PropTypes.shape({
    patientUuid: PropTypes.string,
    identifier: PropTypes.string,
  }),
  hostApi: PropTypes.object,
};

ServiceRequestDisplayControl.defaultProps = {
  hostData: { patientUuid: "", identifier: "" },
  hostApi: {},
};
