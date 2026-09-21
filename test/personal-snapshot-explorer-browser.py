"""Actual Chromium browsing of selected snapshot files; Python computes an independent oracle."""
import json
import os
from pathlib import Path
from playwright.sync_api import sync_playwright, expect

origin = os.environ['ULTRABRAIN_BROWSER_ORIGIN']
token = os.environ['ULTRABRAIN_BROWSER_TOKEN']
files = {side: Path(os.environ['ULTRABRAIN_EXPLORE_' + side.upper()]) for side in ('left', 'right', 'empty')}
snapshots = {side: json.loads(path.read_bytes()) for side, path in files.items()}
checks = 0

def oracle(side='left', **filters):
    rows = snapshots[side]['memories']
    rows = [r for r in rows if all(not value or r[key] == value for key, value in filters.items()
            if key in ('status', 'type', 'importance', 'origin_kind', 'agent_id'))
            and filters.get('query', '') in r['content']
            and (filters.get('project_scope', 'all') == 'all'
                 or filters['project_scope'] == 'global' and r['project_id'] is None
                 or filters['project_scope'] == 'exact' and r['project_id'] == filters['project_id'])]
    rows = sorted(rows, key=lambda r: r['id'])
    sort = filters.get('sort', 'id_asc')
    if sort == 'importance_desc':
        rows.sort(key=lambda r: {'low': 0, 'normal': 1, 'high': 2}[r['importance']], reverse=True)
    elif sort in ('updated_desc', 'created_desc'):
        rows.sort(key=lambda r: r['updated_at' if sort == 'updated_desc' else 'created_at'], reverse=True)
    return rows

with sync_playwright() as p:
    options = {'headless': True, 'args': ['--no-sandbox']}
    if os.environ.get('ULTRABRAIN_CHROMIUM'):
        options['executable_path'] = os.environ['ULTRABRAIN_CHROMIUM']
    browser = p.chromium.launch(**options)
    context = browser.new_context(viewport={'width': 1320, 'height': 1050}, accept_downloads=True)
    page = context.new_page()
    errors, traffic, downloads = [], [], []
    page.on('pageerror', lambda e: errors.append(str(e)))
    page.on('request', lambda r: traffic.append((r.method, r.url)))
    page.on('download', lambda d: downloads.append(d))
    page.goto(origin, wait_until='networkidle')
    page.locator('#token').fill(token)
    page.locator('#login-form button').click()
    expect(page.locator('#workspace')).to_be_visible()
    page.locator('[data-view="lookup"]').click()
    expect(page.locator('#lookup-panel')).to_be_visible()
    page.wait_for_load_state('networkidle')
    page.locator('#content').fill('EXPLORER_UNSAVED_DRAFT')
    start = len(traffic)

    def prepare(left='left', right='right'):
        page.locator('#inspector-open').click()
        page.locator('#inspector-left').set_input_files(str(files[left]))
        page.locator('#inspector-right').set_input_files(str(files[right]) if right else [])
        expect(page.locator('#explorer-open')).to_be_disabled()
        page.locator('#inspector-consent').check()
        page.locator('#inspector-run').click()
        expect(page.locator('#message')).to_contain_text('内部一致性核验通过')
        page.locator('#explorer-open').click()
        expect(page.locator('#explorer-results article')).to_have_count(0)
        expect(page.locator('#explorer-run')).to_be_disabled()

    def page_ids():
        return [card.locator('p').first.inner_text().removeprefix('记忆 ID：')
                for card in page.locator('#explorer-results article').all()]

    def browse(side='left', **filters):
        for key, ident in [('query', 'query'), ('type', 'type'), ('agent_id', 'agent')]:
            page.locator('#explorer-' + ident).fill(filters.get(key, ''))
        for key, ident in [('status', 'status'), ('importance', 'importance'), ('origin_kind', 'origin')]:
            page.locator('#explorer-' + ident).select_option(filters.get(key, ''))
        page.locator('#explorer-project-scope').select_option(filters.get('project_scope', 'all'))
        if filters.get('project_scope') == 'exact':
            page.locator('#explorer-project').fill(filters['project_id'])
        page.locator('#explorer-sort').select_option(filters.get('sort', 'id_asc'))
        page.locator('#explorer-side').select_option(side)
        expect(page.locator('#explorer-results article')).to_have_count(0)
        page.locator('#explorer-consent').check()
        page.locator('#explorer-run').click()
        rows = oracle(side, **filters)
        expect(page.locator('#explorer-summary')).to_contain_text(f'符合条件 {len(rows)} 条')
        expect(page.locator('#explorer-results article')).to_have_count(min(20, len(rows)))
        assert page_ids() == [r['id'] for r in rows[:20]], 'Local page IDs differ from Python oracle'
        return rows

    prepare()
    checks += 1
    rows = browse()
    expect(page.locator('#explorer-detail')).to_be_hidden()
    assert 'EXPLORER_PRIVATE_' not in page.locator('#explorer-results').inner_text()
    checks += 1
    seen = page_ids()
    while page.locator('#explorer-next').is_enabled():
        page.locator('#explorer-next').click()
        seen.extend(page_ids())
    assert seen == [r['id'] for r in rows] and len(seen) == len(set(seen))
    page.locator('#explorer-prev').click()
    assert page_ids() == [r['id'] for r in rows[20:40]]
    checks += 1
    cases = [dict(status=s) for s in ('candidate', 'active', 'archived')]
    cases += [dict(type='goal'), dict(importance='high'), dict(origin_kind='document_fragment'),
              dict(agent_id='explorer-b'), dict(project_scope='global'),
              dict(project_scope='exact', project_id='project-a'), dict(query='%_*[] 🙂'),
              dict(query='alpha'), dict(query='UNIQUE_PROVENANCE_ONLY'),
              dict(status='active', type='goal', project_scope='exact', project_id='project-a', query='Alpha'),
              dict(sort='importance_desc'), dict(sort='updated_desc'), dict(sort='created_desc')]
    for filters in cases:
        browse(**filters)
        checks += 1
    rows = browse(query='EXPLORER_PRIVATE_')
    page.locator('#explorer-results article').first.get_by_role('button').click()
    detail = json.loads(page.locator('#explorer-detail-text').inner_text())
    assert detail == rows[0], 'Explicit detail must retain all original fields'
    assert page.locator('#explorer-detail-text img, #explorer-detail-text script').count() == 0
    assert page.evaluate('typeof window.explorerInjected') == 'undefined'
    expect(page.locator('#content')).to_have_value('EXPLORER_UNSAVED_DRAFT')
    checks += 1
    page.locator('#explorer-next').click()
    expect(page.locator('#explorer-detail-text')).to_have_text('')
    page.locator('#explorer-query').fill('different')
    expect(page.locator('#explorer-results article')).to_have_count(0)
    expect(page.locator('#explorer-summary')).to_have_text('')
    checks += 1
    rows = browse('right', query='RIGHT_EXTRA')
    assert len(rows) == 1
    page.locator('#explorer-results article').first.get_by_role('button').click()
    expect(page.locator('#explorer-detail-id')).to_contain_text('右侧快照')
    page.locator('#explorer-side').select_option('left')
    expect(page.locator('#explorer-consent')).not_to_be_checked()
    expect(page.locator('#explorer-detail-text')).to_have_text('')
    expect(page.locator('#explorer-run')).to_be_disabled()
    checks += 1
    browse()
    page.locator('#explorer-results article').first.get_by_role('button').click()
    page.locator('#explorer-consent').uncheck()
    expect(page.locator('#explorer-detail-text')).to_have_text('')
    expect(page.locator('#explorer-results article')).to_have_count(0)
    browse()
    page.locator('#inspector-consent').uncheck()
    expect(page.locator('#explorer-panel')).to_be_hidden()
    expect(page.locator('#explorer-detail-text')).to_have_text('')
    assert page.evaluate('explorerPage === null && explorerBinding === null')
    checks += 1
    prepare('empty', None)
    page.locator('#explorer-consent').check()
    page.locator('#explorer-run').click()
    expect(page.locator('#explorer-summary')).to_contain_text('文件共 0 条；符合条件 0 条')
    expect(page.locator('#explorer-next')).to_be_disabled()
    checks += 1
    prepare()
    browse()
    page.locator('#explorer-results article').first.get_by_role('button').click()
    corrupt = files['left'].read_bytes().replace(b'EXPLORER_PRIVATE_', b'CORRUPT_PRIVATE_')
    page.locator('#inspector-left').set_input_files({'name': 'bad.json', 'mimeType': 'application/json', 'buffer': corrupt})
    expect(page.locator('#explorer-panel')).to_be_hidden()
    expect(page.locator('#explorer-detail-text')).to_have_text('')
    page.locator('#inspector-consent').check()
    page.locator('#inspector-run').click()
    expect(page.locator('#message')).to_contain_text('memory_snapshot_unconfirmed')
    expect(page.locator('#explorer-open')).to_be_disabled()
    checks += 1
    prepare()
    browse()
    page.set_viewport_size({'width': 390, 'height': 844})
    page.locator('#explorer-results article').first.get_by_role('button').click()
    assert page.evaluate('document.documentElement.scrollWidth <= window.innerWidth'), 'Mobile horizontal overflow'
    page.locator('#explorer-detail-clear').click()
    expect(page.locator('#explorer-detail-text')).to_have_text('')
    page.set_viewport_size({'width': 1320, 'height': 1050})
    if os.environ.get('ULTRABRAIN_EXPLORER_SCREENSHOT'):
        page.locator('#explorer-panel').screenshot(path=os.environ['ULTRABRAIN_EXPLORER_SCREENSHOT'])
    checks += 1
    page.locator('[data-view="recall"]').click()
    expect(page.locator('#explorer-panel')).to_be_hidden()
    assert page.evaluate('explorerPage === null && explorerBinding === null')
    expect(page.locator('#content')).to_have_value('EXPLORER_UNSAVED_DRAFT')
    page.locator('#logout').click()
    expect(page.locator('#workspace')).to_be_hidden()
    assert page.evaluate('localStorage.length === 0 && sessionStorage.length === 0')
    assert all(method == 'GET' and url == origin + '/snapshot-contract.mjs' for method, url in traffic[start:])
    assert not downloads and not errors
    checks += 1
    report = {'passed': True, 'checks': checks, 'browser': 'Chromium ' + browser.version,
              'data_requests_during_exploration': 0, 'downloads': 0,
              'scope': os.environ.get('ULTRABRAIN_EXPLORER_SCOPE', 'Selected exports from isolated PostgreSQL, real browser; no external model calls')}
    if os.environ.get('ULTRABRAIN_EXPLORER_REPORT'):
        Path(os.environ['ULTRABRAIN_EXPLORER_REPORT']).write_text(json.dumps(report, indent=2) + '\n', encoding='utf8')
    context.close()
    browser.close()
print('PASS', checks, 'real Chromium snapshot record browser checks; zero data HTTP or downloads')
