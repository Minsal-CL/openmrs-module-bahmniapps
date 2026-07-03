import React, { useEffect, useState, useCallback, useMemo } from "react";
import PropTypes from "prop-types";
import axios from "axios";
import {
  NODES_CONFIG, fetchServiceRequestsAllNodes, fetchResponseDocsAllNodes,
  completeServiceRequestOnNode, fetchNarrativeFromBundle, submitContrarreferencia, fetchIpsSummary,
} from "../../config/racselNodesConfig";
import "./serviceRequestDisplayControl.scss";

const axiosSR = axios.create({ timeout: 20000 });
const TITLE = "Interconsultas Transfronterizas";

const absUrl = (ref, base) => {
  if (!ref) return null;
  if (/^https?:\/\//i.test(ref)) return ref;
  return `${base || NODES_CONFIG.NATIONAL_FHIR_BASE}/${String(ref).replace(/^\//, "")}`;
};

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
const reasonOf = (sr) => (sr.reasonCode && sr.reasonCode[0] && sr.reasonCode[0].text) || "—";
const noteOf = (sr) => (sr.note && sr.note[0] && sr.note[0].text) || "";
const identifierOf = (sr) => (sr.identifier && sr.identifier[0] && sr.identifier[0].value) || "—";
const dateOf = (sr) => (sr.authoredOn || "").slice(0, 10) || "—";

// Grupo de recursos del IPS (condiciones, medicamentos, etc.) como lista legible.
const IpsGroup = ({ title, rows, line }) => (rows && rows.length ? (
  <div className="sr-ips-grp">
    <div className="sr-ips-grp__title">{title} <span className="sr-ips-grp__count">({rows.length})</span></div>
    <ul className="sr-ips-grp__list">
      {rows.map((r, i) => <li key={i}>{line(r) || "—"}</li>)}
    </ul>
  </div>
) : null);
IpsGroup.propTypes = {
  title: PropTypes.string,
  rows: PropTypes.array,
  line: PropTypes.func,
};

export function ServiceRequestDisplayControl(props) {
  const { hostData } = props;
  const { identifier, patientUuid } = hostData || {};
  const [items, setItems] = useState([]);
  const [responses, setResponses] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [busyId, setBusyId] = useState(null);
  // Modal de VER (interconsulta o respuesta)
  const [viewing, setViewing] = useState(null);     // { kind:'interconsulta'|'respuesta', sr, node, resp }
  const [ipsSummary, setIpsSummary] = useState(null); // { loading, data, error }
  const [respText, setRespText] = useState(null);     // { loading, text, error }
  // Modal de contestar
  const [answering, setAnswering] = useState(null);
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

  // Ver interconsulta completa (modal) + IPS renderizado
  const openInterconsulta = async (sr, node) => {
    setViewing({ kind: "interconsulta", sr, node }); setIpsSummary(null);
    const ips = absUrl(sr.supportingInfo && sr.supportingInfo[0] && sr.supportingInfo[0].reference, node.base);
    if (!ips) return;
    setIpsSummary({ loading: true });
    try { setIpsSummary({ data: await fetchIpsSummary(axiosSR, ips), url: ips }); }
    catch (e) { setIpsSummary({ error: (e && e.message) || "No se pudo cargar el IPS", url: ips }); }
  };

  // Ver respuesta (modal)
  const openRespuesta = async (sr, node, resp) => {
    setViewing({ kind: "respuesta", sr, node, resp }); setRespText({ loading: true });
    try { setRespText({ text: (await fetchNarrativeFromBundle(axiosSR, resp.bundleUrl)) || "(respuesta sin texto)" }); }
    catch (e) { setRespText({ error: (e && e.message) || "No se pudo leer la respuesta" }); }
  };

  const closeView = () => { setViewing(null); setIpsSummary(null); setRespText(null); };

  const openAnswer = (sr, node) => { setAnswering({ sr, node }); setAnswerText(""); setError(null); };

  const submitAnswer = async () => {
    if (!answering || !answerText.trim()) return;
    const { sr, node } = answering;
    setSubmitting(true); setError(null);
    try {
      await submitContrarreferencia(axiosSR, {
        identifier, patientUuid, narrative: answerText.trim(),
        srRef: `ServiceRequest/${sr.id}`, base: NODES_CONFIG.NATIONAL_FHIR_BASE,
      });
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

  // Completar cuando YA hay respuesta: solo cierra el SR (sin re-preguntar ni duplicar).
  const completeOnly = async (sr, node) => {
    setBusyId(sr.id); setError(null);
    try { await completeServiceRequestOnNode(axiosSR, sr, node.base); await load(); }
    catch (e) {
      const oo = e && e.response && e.response.data;
      const issue = oo && oo.issue && oo.issue[0];
      const diag = issue && (issue.diagnostics || (issue.details && issue.details.text));
      setError(diag || (e && e.message) || "No se pudo completar la solicitud");
    } finally { setBusyId(null); }
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
      <div className="sr-tablewrap">
        <table className="sr-table">
          <thead>
            <tr>
              <th>País</th><th>Estado</th><th>Especialidad</th>
              <th>Interconsulta</th><th>Respuesta</th><th aria-label="acciones" />
            </tr>
          </thead>
          <tbody>
            {visible.map(({ resource: sr, node }) => {
              const resp = responseForSr(responses, sr);
              return (
                <tr key={`${node.base}|${sr.id}`}>
                  <td>{node.country || "—"}</td>
                  <td><span className={`sr-status sr-status--${sr.status}`}>{sr.status}</span></td>
                  <td>{specialtyOf(sr)}</td>
                  <td>
                    <button type="button" className="sr-btn-link" onClick={() => openInterconsulta(sr, node)}>Ver</button>
                  </td>
                  <td>
                    {resp ? (
                      <button type="button" className="sr-btn-link" onClick={() => openRespuesta(sr, node, resp)}>Ver respuesta</button>
                    ) : (<span className="sr-noresp">Sin respuesta aún</span>)}
                  </td>
                  <td className="sr-actions">
                    {sr.status === "active" && resp ? (
                      <button className="sr-btn-complete" disabled={busyId === sr.id} onClick={() => completeOnly(sr, node)}>
                        {busyId === sr.id ? "…" : "Completar"}
                      </button>
                    ) : null}
                    {sr.status === "active" && !resp ? (
                      <button className="sr-btn-answer" onClick={() => openAnswer(sr, node)}>Contestar</button>
                    ) : null}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </>
  );

  // ---- Modal VER interconsulta / respuesta ----
  let viewModal = null;
  if (viewing) {
    const { sr, node, kind, resp } = viewing;
    viewModal = (
      <div className="sr-modal" role="dialog" aria-modal="true" onClick={closeView}>
        <div className="sr-modal__box sr-modal__box--wide" onClick={(e) => e.stopPropagation()}>
          <div className="sr-modal__title">
            {kind === "interconsulta" ? "Interconsulta" : "Contrarreferencia"} — {specialtyOf(sr)}
            {node && node.country ? ` · ${node.country}` : ""}
            <button type="button" className="sr-modal__close" onClick={closeView} aria-label="Cerrar">×</button>
          </div>

          {kind === "interconsulta" ? (
            <div className="sr-modal__body">
              <div className="sr-form">
                <div className="sr-form__row"><span>Estado</span><b>{sr.status}</b></div>
                <div className="sr-form__row"><span>Especialidad</span><b>{specialtyOf(sr)}</b></div>
                <div className="sr-form__row"><span>Destino</span><b>{destinationOf(sr)}</b></div>
                <div className="sr-form__row"><span>Motivo</span><b>{reasonOf(sr)}</b></div>
                {noteOf(sr) ? <div className="sr-form__row"><span>Antecedentes</span><b>{noteOf(sr)}</b></div> : null}
                <div className="sr-form__row"><span>Fecha</span><b>{dateOf(sr)}</b></div>
                <div className="sr-form__row"><span>Identificador</span><b>{identifierOf(sr)}</b></div>
              </div>

              <div className="sr-form__sectitle">IPS asociado</div>
              {!ipsSummary ? <div className="sr-modal__msg">Sin IPS asociado.</div> : null}
              {ipsSummary && ipsSummary.loading ? <div className="sr-modal__msg">Cargando IPS…</div> : null}
              {ipsSummary && ipsSummary.error ? (
                <div className="sr-dash__error">⚠️ {ipsSummary.error}
                  {ipsSummary.url ? <a href={`${ipsSummary.url}?_pretty=true`} target="_blank" rel="noreferrer"> · Ver documento</a> : null}
                </div>
              ) : null}
              {ipsSummary && ipsSummary.data ? (() => {
                const d = ipsSummary.data;
                const empty = !d.sections.length && !d.conditions.length && !d.medications.length
                  && !d.allergies.length && !d.immunizations.length;
                return (
                  <div className="sr-ips">
                    {d.patientName ? <div className="sr-ips__pat">Paciente: {d.patientName}</div> : null}
                    {d.sections.map((s, i) => (
                      <div className="sr-ips-sec" key={i}>
                        <div className="sr-ips-sec__title">{s.title}</div>
                        <div className="sr-ips-sec__text">{s.text}</div>
                      </div>
                    ))}
                    <IpsGroup title="Condiciones" rows={d.conditions}
                      line={(r) => [r.text, r.status, r.date].filter(Boolean).join(" · ")} />
                    <IpsGroup title="Medicamentos" rows={d.medications}
                      line={(r) => [r.text, r.dose, r.status].filter(Boolean).join(" · ")} />
                    <IpsGroup title="Alergias" rows={d.allergies}
                      line={(r) => [r.text, r.detail].filter(Boolean).join(" · ")} />
                    <IpsGroup title="Inmunizaciones" rows={d.immunizations}
                      line={(r) => [r.text, r.detail].filter(Boolean).join(" · ")} />
                    {empty ? (
                      <div className="sr-modal__msg">El IPS no trae contenido legible.
                        {ipsSummary.url ? <a href={`${ipsSummary.url}?_pretty=true`} target="_blank" rel="noreferrer"> Ver documento</a> : null}
                      </div>
                    ) : null}
                  </div>
                );
              })() : null}
            </div>
          ) : (
            <div className="sr-modal__body">
              <div className="sr-resp__head">
                {resp && resp.node && resp.node.country ? `${resp.node.country} · ` : ""}
                {resp && resp.date ? String(resp.date).slice(0, 10) : ""}
                {resp && resp.bundleUrl ? <a href={`${resp.bundleUrl}?_pretty=true`} target="_blank" rel="noreferrer"> · Documento</a> : null}
              </div>
              {respText && respText.loading ? <div className="sr-modal__msg">Cargando respuesta…</div> : null}
              {respText && respText.error ? <div className="sr-dash__error">⚠️ {respText.error}</div> : null}
              {respText && respText.text ? <div className="sr-resp__text">{respText.text}</div> : null}
            </div>
          )}
        </div>
      </div>
    );
  }

  return (
    <div className="sr-dash">
      <h3 className="sr-dash__title">{TITLE}</h3>
      {body}
      {viewModal}
      {answering ? (
        <div className="sr-modal" role="dialog" aria-modal="true">
          <div className="sr-modal__box">
            <div className="sr-modal__title">
              Contrarreferencia — {specialtyOf(answering.sr)}
              {answering.node && answering.node.country ? ` · ${answering.node.country}` : ""}
            </div>
            <label className="sr-modal__label" htmlFor="sr-answer">Resultado de la evaluación</label>
            <textarea id="sr-answer" className="sr-modal__text" rows={6} value={answerText}
              onChange={(e) => setAnswerText(e.target.value)}
              placeholder="Redacte la evaluación del especialista…" disabled={submitting} />
            {error ? <div className="sr-dash__error">⚠️ {error}</div> : null}
            <div className="sr-modal__actions">
              <button className="sr-btn-cancel" onClick={() => setAnswering(null)} disabled={submitting}>Cancelar</button>
              <button className="sr-btn-complete" onClick={submitAnswer} disabled={submitting || !answerText.trim()}>
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
