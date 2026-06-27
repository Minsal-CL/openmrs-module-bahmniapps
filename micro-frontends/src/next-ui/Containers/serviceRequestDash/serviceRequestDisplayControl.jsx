import React, { useEffect, useState, useCallback } from "react";
import PropTypes from "prop-types";
import axios from "axios";
import {
  NODES_CONFIG, buildAuthHeaders, fetchResourcesFromDocs, DOC_TYPE,
} from "../../config/racselNodesConfig";
import "./serviceRequestDisplayControl.scss";

// Instancia aislada para no arrastrar interceptores globales de Bahmni
const axiosSR = axios.create({ timeout: 20000 });

// Document-based (igual que IPS): DocumentReference (type 11488-4) -> Bundle -> ServiceRequest[]
const fetchServiceRequests = async (identifier) =>
  fetchResourcesFromDocs(axiosSR, identifier, DOC_TYPE.INTERCONSULTA, "ServiceRequest");

// T1.2-G: completar la solicitud -> PUT con status "completed" en el Nodo Nacional
const completeServiceRequest = async (sr) => {
  const base = NODES_CONFIG.NATIONAL_FHIR_BASE;
  const updated = { ...sr, status: "completed" };
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
  const [items, setItems] = useState([]); // [{resource, docRef, bundleUrl}]
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
    catch (e) { setError(e && e.message ? e.message : "No se pudo completar la solicitud"); }
    finally { setBusyId(null); }
  };

  if (loading) return <div className="sr-dash sr-dash--msg">Cargando interconsultas…</div>;
  if (error) return <div className="sr-dash sr-dash--error">⚠️ {error}</div>;
  if (!items.length) return <div className="sr-dash sr-dash--msg">Sin interconsultas para este paciente.</div>;

  return (
    <div className="sr-dash">
      <table className="sr-table">
        <thead>
          <tr>
            <th>Estado</th>
            <th>Especialidad</th>
            <th>Destino</th>
            <th>Motivo</th>
            <th>Fecha</th>
            <th>IPS</th>
            <th>Documento</th>
            <th aria-label="acciones" />
          </tr>
        </thead>
        <tbody>
          {items.map(({ resource: sr, bundleUrl }) => {
            const ips = sr.supportingInfo && sr.supportingInfo[0] && sr.supportingInfo[0].reference;
            return (
              <tr key={sr.id}>
                <td><span className={`sr-status sr-status--${sr.status}`}>{sr.status}</span></td>
                <td>{(sr.code && sr.code.text) || "—"}</td>
                <td>{destinationOf(sr)}</td>
                <td>{(sr.reasonCode && sr.reasonCode[0] && sr.reasonCode[0].text) || "—"}</td>
                <td>{(sr.authoredOn || "").slice(0, 10) || "—"}</td>
                <td>{ips ? <a href={ips} target="_blank" rel="noreferrer">Ver IPS</a> : "—"}</td>
                <td>{bundleUrl ? <a href={`${bundleUrl}?_pretty=true`} target="_blank" rel="noreferrer">Bundle</a> : "—"}</td>
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
