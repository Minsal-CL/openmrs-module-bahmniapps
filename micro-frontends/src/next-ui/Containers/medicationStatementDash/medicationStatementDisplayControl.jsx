import React, { useEffect, useState, useCallback } from "react";
import PropTypes from "prop-types";
import axios from "axios";
import { fetchResourcesFromDocs, DOC_TYPE } from "../../config/racselNodesConfig";
import "./medicationStatementDisplayControl.scss";

const axiosMS = axios.create({ timeout: 20000 });

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

export function MedicationStatementDisplayControl(props) {
  const { hostData } = props;
  const { identifier } = hostData || {};
  const [items, setItems] = useState([]); // [{resource, docRef, bundleUrl}]
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  const load = useCallback(async () => {
    if (!identifier) { setLoading(false); return; }
    setLoading(true); setError(null);
    try { setItems(await fetchMedicationStatements(identifier)); }
    catch (e) { setError(e && e.message ? e.message : "Error consultando medicamentos"); }
    finally { setLoading(false); }
  }, [identifier]);

  useEffect(() => { load(); }, [load]);

  if (loading) return <div className="ms-dash ms-dash--msg">Cargando medicamentos…</div>;
  if (error) return <div className="ms-dash ms-dash--error">⚠️ {error}</div>;
  if (!items.length) return <div className="ms-dash ms-dash--msg">Sin reporte de medicamentos para este paciente.</div>;

  return (
    <div className="ms-dash">
      <table className="ms-table">
        <thead>
          <tr>
            <th>Estado</th>
            <th>Medicamento</th>
            <th>Dosis</th>
            <th>Vía</th>
            <th>Fecha</th>
            <th>Documento</th>
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
                <td>{bundleUrl ? <a href={`${bundleUrl}?_pretty=true`} target="_blank" rel="noreferrer">Bundle</a> : "—"}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
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
