#!/usr/bin/env python3
"""Verify isolated restoration against an idle test database; never prints memory."""
import runpy
import sys
from pathlib import Path
m = runpy.run_path(str(Path(__file__).resolve().parents[1] / 'scripts/postgres.py'))
name = sys.argv[1] if len(sys.argv) == 2 else 'ub_restore_ci'
if not name.startswith('ub_restore_'):
    raise SystemExit('Only isolated restoration targets are accepted')
queries = {
    'personal_consolidations': "SELECT count(*)::text || ':' || coalesce(md5(string_agg(row_to_json(t)::text, ',' ORDER BY id)),'empty') FROM ultrabrain.personal_consolidations t",
    'personal_derivations': "SELECT count(*)::text || ':' || coalesce(md5(string_agg(id::text || ':' || derivation::text, ',' ORDER BY id)),'empty') FROM ultrabrain.personal_memories WHERE derivation IS NOT NULL",
    'personal_memories': "SELECT count(*)::text || ':' || coalesce(md5(string_agg(row_to_json(t)::text, ',' ORDER BY id)),'empty') FROM ultrabrain.personal_memories t",
    'personal_agents': "SELECT count(*)::text || ':' || coalesce(md5(string_agg(row_to_json(t)::text, ',' ORDER BY registry_id)),'empty') FROM ultrabrain.agent_registry t",
    'personal_events': "SELECT count(*)::text || ':' || coalesce(md5(string_agg(row_to_json(t)::text, ',' ORDER BY source_id,actor_key,event_id)),'empty') FROM ultrabrain.personal_events t",
    'enterprise_policy': "SELECT count(*)::text || ':' || coalesce(md5(string_agg(source_id || ':' || revision::text || ':' || policy::text, ',' ORDER BY source_id)),'empty') FROM ultrabrain.enterprise_sources",
    'enterprise_audit': "SELECT count(*)::text || ':' || coalesce(md5(string_agg(row_to_json(t)::text, ',' ORDER BY id)),'empty') FROM ultrabrain.enterprise_audit t",
    'enterprise_rates': "SELECT count(*)::text || ':' || coalesce(md5(string_agg(row_to_json(t)::text, ',' ORDER BY source_id,subject)),'empty') FROM ultrabrain.enterprise_rate_windows t",
    'fact_evidence': "SELECT count(*)::text || ':' || coalesce(md5(string_agg(source_id || ':' || fact_id::text || ':' || revision::text || ':' || state || ':' || fact_sha256 || ':' || evidence_sha256, ',' ORDER BY source_id,fact_id)),'empty') FROM ultrabrain.fact_evidence",
    'fact_evidence_events': "SELECT count(*)::text || ':' || coalesce(md5(string_agg(request_hash || ':' || revision::text, ',' ORDER BY source_id,fact_id,event_id)),'empty') FROM ultrabrain.fact_evidence_events",
    'review_dependencies': "SELECT count(*)::text || ':' || coalesce(md5(string_agg(source_id || ':' || policy_slug || ':' || evidence_slug || ':' || evidence_sha256, ',' ORDER BY source_id,policy_slug,evidence_slug)),'empty') FROM ultrabrain.review_dependencies",
    'memory_policies': "SELECT count(*)::text || ':' || coalesce(md5(string_agg(source_id || ':' || slug || ':' || revision::text || ':' || status || ':' || content_sha256, ',' ORDER BY source_id,slug)),'empty') FROM ultrabrain.memory_policies",
    'memory_policy_history': "SELECT count(*)::text || ':' || coalesce(md5(string_agg(snapshot::text, ',' ORDER BY source_id,slug,revision)),'empty') FROM ultrabrain.memory_policy_history",
    'instance_identity': "SELECT instance_id::text FROM ultrabrain.instance_identity WHERE singleton",

    'summary_cache': "SELECT count(*)::text || ':' || coalesce(md5(string_agg(view_hash || ':' || coalesce(document::text,''), ',' ORDER BY source_id,slug,reader_key)),'empty') FROM ultrabrain.summary_cache",
    'migration_ledger': "SELECT count(*)::text || ':' || coalesce(md5(string_agg(id || ':' || checksum, ',' ORDER BY id)),'empty') FROM ultrabrain.schema_migrations",
    'projects': "SELECT count(*)::text || ':' || coalesce(md5(string_agg(state::text, ',' ORDER BY source_id,project_id)),'empty') FROM ultrabrain.projects",
    'project_history': "SELECT count(*)::text || ':' || coalesce(md5(string_agg(request_hash, ',' ORDER BY source_id,project_id,revision)),'empty') FROM ultrabrain.project_revisions",
    'deferred_queue': "SELECT count(*)::text || ':' || coalesce(md5(string_agg(content_hash || ':' || state || ':' || coalesce(pending_payload::text,''), ',' ORDER BY source_id,actor,session_id,event_id)),'empty') FROM ultrabrain.session_receipts WHERE deferred",
    'workspace_evidence': "SELECT count(*)::text || ':' || coalesce(md5(string_agg(workspace::text, ',' ORDER BY receipt_id)),'empty') FROM ultrabrain.verification_receipts WHERE workspace IS NOT NULL",
    'execution_evidence': "SELECT count(*)::text || ':' || coalesce(md5(string_agg(subject_hash || ':' || exit_code::text, ',' ORDER BY receipt_id)),'empty') FROM ultrabrain.verification_receipts",
    'forgotten_projects': "SELECT count(*)::text || ':' || coalesce(md5(string_agg(source_id || ':' || project_id, ',' ORDER BY source_id,project_id)),'empty') FROM ultrabrain.project_tombstones",
    'pages': "SELECT count(*)::text || ':' || coalesce(md5(string_agg(id::text || ':' || coalesce(content_hash,''), ',' ORDER BY id)),'empty') FROM pages",
    'receipts': "SELECT count(*)::text || ':' || coalesce(md5(string_agg(content_hash || ':' || state, ',' ORDER BY source_id,actor,session_id,event_id)),'empty') FROM ultrabrain.session_receipts",
    'schema': "SELECT value FROM config WHERE key='version'",
}
for label, query in queries.items():
    original = m['pg']('psql','-X','-tAc',query,'-d','ultrabrain').stdout.strip()
    restored = m['pg']('psql','-X','-tAc',query,'-d',name).stdout.strip()
    if not original or original != restored:
        raise SystemExit(f'Restored {label} differs from original')
    print(f'PASS restoration fingerprint: {label}')
