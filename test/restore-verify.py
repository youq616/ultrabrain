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
