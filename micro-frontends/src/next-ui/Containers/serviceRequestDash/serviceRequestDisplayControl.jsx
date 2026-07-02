import React, { useEffect, useState, useCallback, useMemo } from "react";
import PropTypes from "prop-types";
import axios from "axios";
import {
  NODES_CONFIG, fetchServiceRequestsAllNodes, fetchResponseDocsAllNodes,
  completeServiceRequestOnNode, fetchNarrativeFromBundle, submitContrarreferencia,
} from "../../config/racselNodesConfig";
import "./serviceRequestDisplayControl.scss";

// Instancia aislada para no arrastrar interceptores globales de Bahmni
const axiosSR = axios.create({ timeout: 20000 });

const TITLE = "Interconsultas Transfronterizas";

// Convierte una referencia relativa en URL absoluta contra una base dada (el nodo del SR).
const absUrl = (ref, base) => {
  if (!ref) return null;
  if (/^https?:\/\//i.test(ref)) return ref;
  return `${base || NODES_CONFIG.NATIONAL_FHIR_BASE}/${String(ref).replace(/^\//, "")}`;
};

// Correlaciona una contrarreferencia con su interconsulta: DocumentReference.context.related apunta
// al ServiceRequest que responde. Match por sufijo (la ref puede ser relativa o absoluta).
const responseForSr = (responses, sr) =>
  responses.find((r) => (r.relatedRefs || []).some(
    (ref) => new RegExp(`(^|/)ServiceRequest/${sr.id}$`).test(String(ref))
  ));

const destinationOf = (sr) => {
  const contained = (sr.contained || []).find((c) => c.id === "org-dest");
  if (contained) {
    const country = contained.address && contained.address[0] && contained.address[0].country;
    return [contained.name, country].filter(Boolean).join(" · ");
  }
  return (sr.performer && sr.performer[0] && sr.performer[0].display) || "—";
};

const specialtyOf = (sr) => (sr.code && sr.code.text) || "—";

export function ServiceRequestDisplayControl(props) {
  const { hostData } = props;
  const { identifier, patientUuid } = hostData || {};
  const [items, setItems] = useState([]);          // [{resource, node}] de TODOS los nodos
  const [responses, setResponses] = useState([]);  // [{docRef, bundleUrl, relatedRefs, date, node}]
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [expandedId, setExpandedId] = useState(null);
  const [narratives, setNarratives] = useState({});
  // Modal de contrarreferencia (Completar = contestar)
  const [answering, setAnswering] = useState(null); // { sr, node }
  const [answerText, setAnswerText] = useState("");
  const [submitting, setSubmitting] = useState(false);
  // Filtros
  const [fCountry, setFCountry] = useState("");
  const [fSpecialty, setFSpecialty] = useState("");
  const [fStatus, setFStatus] = useState("");

  const load = useCallback(async () => {
    if (!identifier) { setLoading(false); return; }
    setLoading(true); setError(null);
    try {
      const [srs, resp] = await Promise.all([
        fetchServiceRequestsAllNodes(axiosSR, identifier),
        fetchResponseDocsAllNodes(axiosSR, identifier).catch(() => []),
      ]);
      setItems(srs);
      setResponses(resp);
    } catch (e) {
      setError(e && e.message ? e.message : "Error consultando interconsultas");
    } finally { setLoading(false); }
  }, [identifier]);

  useEffect(() => { load(); }, [load]);

  // Opciones de filtro derivadas de los datos
  const countries = useMemo(
    () => [...new Set(items.map((it) => it.node && it.node.country).filter(Boolean))].sort(),
    [items]);
  const specialties = useMemo(
    () => [...new Set(items.map((it) => specialtyOf(it.resource)).filter((s) => s && s !== "—"))].sort(),
    [items]);
  const statuses = useMemo(
    () => [...new Set(items.map((it) => it.resource.status).filter(Boolean))].sort(),
    [items]);

  const visible = useMemo(() => items.filter((it) => {
    if (fCountry && (it.node && it.node.country) !== fCountry) return false;
    if (fSpecialty && specialtyOf(it.resource) !== fSpecialty) return false;
    if (fStatus && it.resource.status !== fStatus) return false;
    return true;
  }), [items, fCountry, fSpecialty, fStatus]);

  // Completar = contestar: abre el modal para redactar la contrarreferencia.
  const openAnswer = (sr, node) => { setAnswering({ sr, node }); setAnswerText(""); setError(null); };

  // Envía la contrarreferencia (MHD → nuestro nodo) y marca el SR completed en su nodo de origen.
  const submitAnswer = async () => {
    if (!answering || !answerText.trim()) return;
    const { sr, node } = answering;
    setSubmitting(true); setError(null);
    try {
      // 1) Contrarreferencia (documento MHD) al nodo PROPIO — nosotros somos quienes respondemos.
      await submitContrarreferencia(axiosSR, {
        identifier, patientUuid, narrative: answerText.trim(),
        srRef: `ServiceRequest/${sr.id}`, base: NODES_CONFIG.NATIONAL_FHIR_BASE,
      });
      // 2) Completar el ServiceRequest en su NODO DE ORIGEN (donde vive).
      await completeServiceRequestOnNode(axiosSR, sr, node.base);
      setAnswering(null); setAnswerText("");
      await load();
    } catch (e) {
      const oo = e && e.response && e.response.data;
      const issue = oo && oo.issue && oo.issue[0];
      const diag = issue && (issue.diagnostics || (issue.details && issue.details.text));
      setError(diag || (e && e.message) || "No se pudo enviar la contrarreferencia");
    } finally { setSubmitting(false); }
  };

  const onToggleResponse = async (sr, resp) => {
    if (expandedId === sr.id) { setExpandedId(null); return; }
    setExpandedId(sr.id);
    if (!narratives[sr.id] && resp && resp.bundleUrl) {
      setNarratives((n) => ({ ...n, [sr.id]: { loading: true } }));
      try {
        const text = await fetchNarrativeFromBundle(axiosSR, resp.bundleUrl);
        setNarratives((n) => ({ ...n, [sr.id]: { text: text || "(respuesta sin texto)" } }));
      } catch (e) {
        setNarratives((n) => ({ ...n, [sr.id]: { error: (e && e.message) || "No se pudo leer la respuesta" } }));
      }
    }
  };

  const filters = (
    <div className="sr-filters">
      <select value={fCountry} onChange={(e) => setFCountry(e.target.value)}>
        <option value="">País: todos</option>
        {countries.map((c) => <option key={c} value={c}>{c}</option>)}
      </select>
      <select value={fSpecialty} onChange={(e) => setFSpecialty(e.target.value)}>
        <option value="">Especialidad: todas</option>
        {specialties.map((s) => <option key={s} value={s}>{s}</option>)}
      </select>
      <select value={fStatus} onChange={(e) => setFStatus(e.target.value)}>
        <option value="">Estado: todos</option>
        {statuses.map((s) => <option key={s} value={s}>{s}</option>)}
      </select>
    </div>
  );

  let body;
  if (loading) body = <div className="sr-dash__msg">Cargando interconsultas…</div>;
  else if (error) body = <div className="sr-dash__error">⚠️ {error}</div>;
  else if (!items.length) body = <div className="sr-dash__msg">Sin interconsultas para este paciente.</div>;
  else body = (
    <>
      {filters}
      <table className="sr-table">
        <thead>
          <tr>
            <th>País</th>
            <th>Estado</th>
            <th>Especialidad</th>
            <th>Destino</th>
            <th>Motivo</th>
            <th>Fecha</th>
            <th>IPS</th>
            <th>Respuesta</th>
            <th aria-label="acciones" />
          </tr>
        </thead>
        <tbody>
          {visible.map(({ resource: sr, node }) => {
            const ips = absUrl(sr.supportingInfo && sr.supportingInfo[0] && sr.supportingInfo[0].reference, node.base);
            const resp = responseForSr(responses, sr);
            const open = expandedId === sr.id;
            const nar = narratives[sr.id];
            return (
              <React.Fragment key={`${node.base}|${sr.id}`}>
                <tr>
                  <td>{node.country || "—"}</td>
                  <td><span className={`sr-status sr-status--${sr.status}`}>{sr.status}</span></td>
                  <td>{specialtyOf(sr)}</td>
                  <td>{destinationOf(sr)}</td>
                  <td>{(sr.reasonCode && sr.reasonCode[0] && sr.reasonCode[0].text) || "—"}</td>
                  <td>{(sr.authoredOn || "").slice(0, 10) || "—"}</td>
                  <td>{ips ? <a href={`${ips}?_pretty=true`} target="_blank" rel="noreferrer">Ver IPS</a> : "—"}</td>
                  <td>
                    {resp ? (
                      <button type="button" className="sr-btn-response" onClick={() => onToggleResponse(sr, resp)}>
                        {open ? "Ocultar" : "Ver respuesta"}
                      </button>
                    ) : (
                      <span className="sr-noresp">Sin respuesta aún</span>
                    )}
                  </td>
                  <td>
                    {sr.status === "active" ? (
                      <button className="sr-btn-complete" onClick={() => openAnswer(sr, node)}>
                        Completar
                      </button>
                    ) : null}
                  </td>
                </tr>
                {open && resp ? (
                  <tr className="sr-resp-row">
                    <td colSpan={9}>
                      <div className="sr-resp">
                        <div className="sr-resp__head">
                          Contrarreferencia{resp.node && resp.node.country ? ` · ${resp.node.country}` : ""}
                          {resp.date ? ` · ${String(resp.date).slice(0, 10)}` : ""}
                          {resp.bundleUrl ? (
                            <a href={`${resp.bundleUrl}?_pretty=true`} target="_blank" rel="noreferrer"> · Documento</a>
                          ) : null}
                        </div>
                        {nar && nar.loading ? <div className="sr-resp__msg">Cargando respuesta…</div> : null}
                        {nar && nar.error ? <div className="sr-dash__error">⚠️ {nar.error}</div> : null}
                        {nar && nar.text ? <div className="sr-resp__text">{nar.text}</div> : null}
                      </div>
                    </td>
                  </tr>
                ) : null}
              </React.Fragment>
            );
          })}
        </tbody>
      </table>
    </>
  );

  return (
    <div className="sr-dash">
      <h3 className="sr-dash__title">{TITLE}</h3>
      {body}
      {answering ? (
        <div className="sr-modal" role="dialog" aria-modal="true">
          <div className="sr-modal__box">
            <div className="sr-modal__title">
              Contrarreferencia — {specialtyOf(answering.sr)}
              {answering.node && answering.node.country ? ` · ${answering.node.country}` : ""}
            </div>
            <label className="sr-modal__label" htmlFor="sr-answer">Resultado de la evaluación</label>
            <textarea
              id="sr-answer"
              className="sr-modal__text"
              rows={6}
              value={answerText}
              onChange={(e) => setAnswerText(e.target.value)}
              placeholder="Redacte la evaluación del especialista…"
              disabled={submitting}
            />
            {error ? <div className="sr-dash__error">⚠️ {error}</div> : null}
            <div className="sr-modal__actions">
              <button className="sr-btn-cancel" onClick={() => setAnswering(null)} disabled={submitting}>
                Cancelar
              </button>
              <button
                className="sr-btn-complete"
                onClick={submitAnswer}
                disabled={submitting || !answerText.trim()}
              >
                {submitting ? "Enviando…" : "Enviar y completar"}
              </button>
            </div>
          </div>
        </div>
      ) : null}
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
