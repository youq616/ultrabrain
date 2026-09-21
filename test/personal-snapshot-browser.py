"""Actual console + PostgreSQL exports; fault injection changes delivery only. Synthetic records."""
import hashlib
import json
import os
from pathlib import Path
from playwright.sync_api import sync_playwright, expect

origin, token = (os.environ[k] for k in ('ULTRABRAIN_BROWSER_ORIGIN', 'ULTRABRAIN_BROWSER_TOKEN'))
expected = int(os.environ['ULTRABRAIN_SNAPSHOT_EXPECTED'])
checks = 0
with sync_playwright() as p:
    browser = p.chromium.launch(headless=True, args=['--no-sandbox'])
    context = browser.new_context(viewport={'width': 1320, 'height': 1050}, accept_downloads=True)
    page = context.new_page()
    errors, calls, downloads = [], [], []
    page.on('pageerror', lambda error: errors.append(str(error)))
    page.on('download', lambda value: downloads.append(value))
    page.on('request', lambda r: calls.append(r.post_data_json) if r.method == 'POST' and r.url.endswith('/api/call') else None)
    page.goto(origin, wait_until='networkidle')
    page.locator('#token').fill(token)
    page.locator('#login-form button').click()
    expect(page.locator('#workspace')).to_be_visible()
    page.locator('[data-view="lookup"]').click()
    page.locator('#content').fill('SNAPSHOT_UNSAVED_LOCAL_DRAFT')
    def begin():
        page.locator('#snapshot-open').click()
        expect(page.locator('#snapshot-panel')).to_be_visible()
    before = len(calls)
    begin()
    expect(page.locator('#snapshot-consent')).not_to_be_checked()
    expect(page.locator('#snapshot-export')).to_be_disabled()
    assert len(calls) == before
    checks += 1
    page.locator('#snapshot-consent').check()
    with page.expect_download() as item:
        page.locator('#snapshot-export').click()
    data = json.loads(Path(item.value.path()).read_text(encoding='utf8'))
    assert data['record_count'] == expected == len(data['memories'])
    assert data['scope'] == 'owned-memories-all-states' and data['complete'] is True
    assert {m['status'] for m in data['memories']} == {'candidate', 'active', 'archived'}
    assert all(m['owned_by_caller'] for m in data['memories'])
    assert 'OTHER_OWNER_SHARED' not in json.dumps(data) and token not in json.dumps(data)
    assert 'SNAPSHOT_UNSAVED_LOCAL_DRAFT' not in json.dumps(data)
    # JS number spelling differs from Python for some floats: use the actual JS codec for payload hash.
    assert page.evaluate("data=>JSON.stringify(data.memories)", data)
    canonical = page.evaluate("data=>JSON.stringify(data.memories)", data).encode('utf8')
    assert hashlib.sha256(canonical).hexdigest() == data['memories_sha256']
    assert all(hashlib.sha256(m['content'].encode('utf8')).hexdigest() == m['content_hash'] for m in data['memories'])
    expect(page.locator('#content')).to_have_value('SNAPSHOT_UNSAVED_LOCAL_DRAFT')
    expect(page.locator('#snapshot-consent')).not_to_be_checked()
    assert len(downloads) == 1
    checks += 1
    # Force five independent post-server faults. Nothing may be partially downloaded.
    for fault in ['source', 'nonce', 'hash', 'count', 'partial']:
        def corrupt(route):
            if route.request.post_data_json['operation'] != 'memory_snapshot':
                route.continue_(); return
            response = route.fetch()
            assert response.ok
            value = response.json()
            result = value['result']
            if fault == 'source': result['source_id'] = 'foreign'
            elif fault == 'nonce': result['request_id'] = '22222222-2222-4222-8222-222222222222'
            elif fault == 'hash': result['memories'][0]['content'] = 'WRONG_CONTENT'
            elif fault == 'count': result['record_count'] += 1
            else: result['complete'] = False
            route.fulfill(status=200, content_type='application/json', body=json.dumps(value))
        page.route('**/api/call', corrupt)
        begin()
        page.locator('#snapshot-consent').check()
        page.locator('#snapshot-export').click()
        expect(page.locator('#message')).to_contain_text('memory_snapshot_unconfirmed')
        expect(page.locator('#snapshot-consent')).not_to_be_checked()
        assert len(downloads) == 1
        page.unroute('**/api/call', corrupt)
        checks += 1
    for cancel in ['consent', 'cancel', 'navigation']:
        def stop_before_delivery(route):
            if route.request.post_data_json['operation'] != 'memory_snapshot':
                route.continue_(); return
            response = route.fetch()
            assert response.ok
            if cancel == 'consent': page.locator('#snapshot-consent').uncheck()
            elif cancel == 'cancel': page.locator('#snapshot-cancel').click()
            else: page.locator('[data-view="recall"]').click()
            route.fulfill(response=response)
        begin()
        page.locator('#snapshot-consent').check()
        page.route('**/api/call', stop_before_delivery)
        page.locator('#snapshot-export').click()
        expect(page.locator('#snapshot-consent')).not_to_be_checked()
        # Explicit browser task barrier: allow all queued promise callbacks to settle.
        page.evaluate('()=>new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)))')
        assert len(downloads) == 1
        page.unroute('**/api/call', stop_before_delivery)
        if cancel == 'navigation': page.locator('[data-view="lookup"]').click()
        checks += 1
    begin()
    if os.environ.get('ULTRABRAIN_SNAPSHOT_SCREENSHOT'):
        page.screenshot(path=os.environ['ULTRABRAIN_SNAPSHOT_SCREENSHOT'], full_page=True)
    page.locator('#logout').click()
    expect(page.locator('#workspace')).to_be_hidden()
    assert page.evaluate('localStorage.length') == 0 and page.evaluate('sessionStorage.length') == 0
    assert not errors, 'Unexpected browser error; raw data omitted'
    assert not any(c['operation'] in ('register','commit','capture','update','review','consolidate','cancel_job','document_import','document_queue','document_archive') for c in calls)
    checks += 1
    report = {'passed': True, 'checks': checks, 'browser': 'Chromium '+browser.version, 'downloaded_records': expected,
              'downloads': len(downloads), 'scope': 'Real owner-only consistent memory export; damaged replies and cancelled delivery withheld; no write/model calls in browser phase'}
    if os.environ.get('ULTRABRAIN_SNAPSHOT_REPORT'):
        Path(os.environ['ULTRABRAIN_SNAPSHOT_REPORT']).write_text(json.dumps(report, indent=2)+'\n', encoding='utf8')
    context.close()
    browser.close()
print('PASS', checks, 'real Chromium snapshot checks; only one explicit verified download')
