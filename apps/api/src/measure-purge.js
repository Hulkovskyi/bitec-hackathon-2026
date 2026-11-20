const batchSize = 100;
const officialChildren = [
  "official_measure_results",
  "official_evidence_claims",
  "official_deadline_changes",
  "official_measure_metadata",
];

// The caller must already be in the same transaction as the deletion audit.
export async function purgeMeasureRows(db, measureIds) {
  const ids = [...new Set(measureIds)];
  const totals = { measures: 0, queuedEvidence: 0 };

  for (let offset = 0; offset < ids.length; offset += batchSize) {
    const batch = ids.slice(offset, offset + batchSize);
    const params = batch.map(() => "?").join(",");
    const results = `SELECT id FROM results WHERE measure_id IN (${params})`;
    const programs = await db.prepare(
      `SELECT DISTINCT program_id FROM official_measure_metadata WHERE measure_id IN (${params})`,
    ).all(...batch);

    const queued = await db.prepare(`
      INSERT INTO evidence_deletions (storage_key)
      SELECT storage_key FROM evidence_versions WHERE result_id IN (${results})
      ON CONFLICT (storage_key) DO NOTHING
    `).run(...batch);
    totals.queuedEvidence += queued.changes;

    await db.prepare(`
      DELETE FROM audit_events
      WHERE (entity_type IN ('measure','period_assignment') AND entity_id IN (${params}))
         OR (entity_type='indicator' AND entity_id IN (
           SELECT id FROM indicators WHERE measure_id IN (${params})
         ))
         OR (entity_type='result' AND entity_id IN (${results}))
         OR (entity_type='result_review' AND entity_id IN (
           SELECT id FROM result_reviews WHERE result_id IN (${results})
         ))
         OR (entity_type='evidence' AND entity_id IN (
           SELECT id FROM evidence_versions WHERE result_id IN (${results})
         ))
         OR (entity_type='risk_flag_decision' AND entity_id IN (
           SELECT id FROM risk_flag_decisions WHERE measure_id IN (${params})
         ))
    `).run(...batch, ...batch, ...batch, ...batch, ...batch, ...batch);

    await db.prepare(`DELETE FROM evidence_versions WHERE result_id IN (${results})`).run(...batch);
    await db.prepare(`DELETE FROM result_reviews WHERE result_id IN (${results})`).run(...batch);

    // Each result revision references its predecessor with ON DELETE RESTRICT.
    const revisions = await db.prepare(`${results} ORDER BY revision DESC`).all(...batch);
    const removeRevision = db.prepare("DELETE FROM results WHERE id=?");
    for (const { id } of revisions) await removeRevision.run(id);

    await db.prepare(`DELETE FROM period_assignments WHERE measure_id IN (${params})`).run(...batch);
    for (const table of officialChildren) {
      await db.prepare(`DELETE FROM ${table} WHERE measure_id IN (${params})`).run(...batch);
    }
    const removeEmptyBatch = db.prepare(`
      DELETE FROM official_dataset_batches WHERE program_id=? AND NOT EXISTS (
        SELECT 1 FROM official_measure_metadata m WHERE m.program_id=official_dataset_batches.program_id
      )
    `);
    for (const { program_id } of programs) await removeEmptyBatch.run(program_id);

    await db.prepare(`DELETE FROM indicators WHERE measure_id IN (${params})`).run(...batch);
    const deleted = await db.prepare(`DELETE FROM measures WHERE id IN (${params})`).run(...batch);
    totals.measures += deleted.changes;
  }

  return totals;
}
