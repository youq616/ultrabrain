"""Actual console/PostgreSQL operations with browser-only receipt corruption. Synthetic files only."""
import hashlib
import json
import os
from pathlib import Path
from playwright.sync_api import sync_playwright, expect

origin, token = (os.environ[k] for k in ('ULTRABRAIN_BROWSER_ORIGIN', 'ULTRABRAIN_BROWSER_TOKEN'))
# The normal 32 KiB cutoff falls INSIDE a Chinese code point; BOM and CRLF must survive.
original = b'\xef\xbb\xbf' + ('x' * 32760 + '🙂不要删除\r\n').encode('utf8')
checks = 0
with sync_playwright() as p:
    options = {'headless': True, 'args': ['--no-sandbox']}
    if os.environ.get('ULTRABRAIN_CHROMIUM'):
        options['executable_path'] = os.environ['ULTRABRAIN_CHROMIUM']
    browser = p.chromium.launch(**options)
    context = browser.new_context(viewport={'width': 1320, 'height': 1050}, accept_downloads=True)
    page = context.new_page()
    errors, calls = [], []
    page.on('pageerror', lambda error: errors.append(str(error)))
    page.on('dialog', lambda dialog: dialog.accept())
    def record(request):
        if request.method == 'POST' and request.url.endswith('/api/call'):
            calls.append(request.post_data_json)
    page.on('request', record)
    def api(operation, data):
        response = context.request.post(origin + '/api/call', headers={'Origin': origin, 'Authorization': 'Bearer ' + token},
                                        data={'operation': operation, 'input': data})
        assert response.ok, 'Synthetic API request failed; raw response omitted'
        return response.json()['result']
    def damage(operation, change, action):
        observed = []
        def intercept(route):
            body = route.request.post_data_json
            if body['operation'] != operation:
                route.continue_()
                return
            response = route.fetch()
            assert response.ok, 'Real operation failed before the injected receipt damage'
            data = response.json()
            observed.append({'input': body['input'], 'result': json.loads(json.dumps(data['result']))})
            change(data['result'])
            route.fulfill(status=200, content_type='application/json', body=json.dumps(data))
        page.route('**/api/call', intercept)
        action()
        expect(page.locator('#message')).to_contain_text('console_receipt_unconfirmed')
        expect(page.locator('#pending-panel')).to_be_visible()
        expect(page.locator('#document-import')).to_be_disabled()
        expect(page.locator('#content')).to_have_value('DOCUMENT_UNRELATED_UNSAVED_DRAFT')
        assert len(observed) == 1, 'No automatic resubmission is allowed'
        page.unroute('**/api/call', intercept)
        return observed[0]
    def replay(operation, sent):
        with page.expect_response(lambda r: r.request.method == 'POST' and r.request.post_data_json.get('operation') == operation) as response:
            page.locator('#retry').click()
        result = response.value.json()['result']
        assert result['replayed'] is True
        expect(page.locator('#pending-panel')).to_be_hidden()
        expect(page.locator('#message')).to_contain_text('重放确认的是原事件')
        assert [c['input'] for c in calls if c['operation'] == operation][-2:] == [sent['input'], sent['input']]
        return result
    page.goto(origin, wait_until='networkidle')
    page.locator('#token').fill(token)
    page.locator('#login-form button').click()
    expect(page.locator('#workspace')).to_be_visible()
    page.locator('[data-view="documents"]').click()
    expect(page.locator('#results article')).to_have_count(0)
    page.locator('#content').fill('DOCUMENT_UNRELATED_UNSAVED_DRAFT')
    page.locator('#project').fill('document-project')
    page.locator('#document-file').set_input_files({'name': '回执合成.MD', 'mimeType': 'text/plain', 'buffer': original})
    page.locator('#document-consent').check()
    sent = damage('document_import', lambda r: r.update(content_sha256='0' * 64), lambda: page.locator('#document-import').click())
    doc_id = sent['result']['document_id']
    assert api('document_read', {'document_id': doc_id})['content_sha256'] == hashlib.sha256(original).hexdigest()
    checks += 1
    page.locator('#document-consent').uncheck()
    before = len(calls)
    page.locator('#retry').click()
    expect(page.locator('#message')).to_contain_text('此前提交仍未确认')
    assert len(calls) == before, 'Revoked consent must not re-send the file or even register'
    page.locator('#document-consent').check()
    replay('document_import', sent)
    expect(page.locator('#results article')).to_have_count(1)
    checks += 1
    # A new explicit event for the identical file is acknowledged as deduplication.
    with page.expect_response(lambda r: r.request.method == 'POST' and r.request.post_data_json.get('operation') == 'document_import') as response:
        page.locator('#document-import').click()
    assert response.value.json()['result']['already_imported'] is True
    expect(page.locator('#pending-panel')).to_be_hidden()
    expect(page.locator('#results article')).to_have_count(1)
    checks += 1
    sent = damage('document_queue', lambda r: r['fragments'].pop(),
                  lambda: page.get_by_role('button', name='排队整理（之后才会调用模型）', exact=True).click())
    assert len(sent['result']['fragments']) == 2
    with page.expect_download() as download:
        page.locator('#save-pending').click()
    exported_text = Path(download.value.path()).read_text(encoding='utf8')
    exported = json.loads(exported_text)
    assert exported['receipt_context'] == {'document_id': doc_id, 'revision': 1, 'byte_size': len(original)}
    assert exported['input'] == sent['input'] and token not in exported_text
    if os.environ.get('ULTRABRAIN_BROWSER_SCREENSHOT'):
        page.screenshot(path=os.environ['ULTRABRAIN_BROWSER_SCREENSHOT'], full_page=True)
    result = replay('document_queue', sent)
    assert result['fragments'] == sent['result']['fragments']
    for f in result['fragments']:
        chunk = original[f['byte_start']:f['byte_end']]
        assert hashlib.sha256(chunk).hexdigest() == f['fragment_sha256']
        chunk.decode('utf8', errors='strict')
        job = api('jobs', {'job_id': f['job_id']})['jobs'][0]
        assert job['attempts'] == 0 and job['state'] == 'queued'
    checks += 1
    sent = damage('document_archive', lambda r: r.update(original_retained=False),
                  lambda: page.get_by_role('button', name='归档文档', exact=True).click())
    assert api('document_read', {'document_id': doc_id})['status'] == 'archived'
    replay('document_archive', sent)
    assert api('document_read', {'document_id': doc_id})['revision'] == 2
    for f in result['fragments']:
        job = api('jobs', {'job_id': f['job_id']})['jobs'][0]
        assert job['state'] == 'stale' and job['attempts'] == 0
    checks += 1
    with page.expect_download() as download:
        page.get_by_role('button', name='下载原文', exact=True).click()
    assert Path(download.value.path()).read_bytes() == original
    checks += 1
    # Replayed import acknowledges an OLD event, even if another explicit actor
    # action archived the original before the browser could confirm that import.
    page.locator('#document-file').set_input_files({'name': 'historical-import.txt', 'mimeType': 'text/plain', 'buffer': b'HISTORICAL_IMPORT'})
    page.locator('#document-consent').check()
    sent = damage('document_import', lambda r: r.update(event_id='wrong-event'), lambda: page.locator('#document-import').click())
    historic_id = sent['result']['document_id']
    api('document_archive', {'document_id': historic_id, 'event_id': 'document-browser-concurrent-archive'})
    result = replay('document_import', sent)
    assert result['status'] == 'active' and result['revision'] == 1, 'Replay must remain the original receipt'
    assert api('document_read', {'document_id': historic_id})['status'] == 'archived'
    expect(page.locator('#results article')).to_have_count(2)
    expect(page.get_by_role('button', name='归档文档', exact=True)).to_have_count(0)
    expect(page.locator('#content')).to_have_value('DOCUMENT_UNRELATED_UNSAVED_DRAFT')
    checks += 1
    # Independent receipt timestamp regression: the database already committed;
    # only the delivery is damaged. Keep each event until a verified exact replay.
    page.locator('#document-file').set_input_files({'name': 'timestamp-receipt.txt', 'mimeType': 'text/plain', 'buffer': b'TIMESTAMP_RECEIPT'})
    page.locator('#document-consent').check()
    sent = damage('document_import', lambda r: r.update(created_at='0'), lambda: page.locator('#document-import').click())
    timestamp_id = sent['result']['document_id']
    assert api('document_read', {'document_id': timestamp_id})['revision'] == 1
    replay('document_import', sent)
    expect(page.locator('#results article')).to_have_count(3)
    checks += 1
    sent = damage('document_archive', lambda r: r.update(archived_at='2026-02-31T00:00:00.000Z'),
                  lambda: page.get_by_role('button', name='归档文档', exact=True).click())
    assert api('document_read', {'document_id': timestamp_id})['status'] == 'archived'
    replay('document_archive', sent)
    assert api('document_read', {'document_id': timestamp_id})['revision'] == 2
    expect(page.get_by_role('button', name='归档文档', exact=True)).to_have_count(0)
    expect(page.locator('#content')).to_have_value('DOCUMENT_UNRELATED_UNSAVED_DRAFT')
    checks += 1
    writes = [c for c in calls if c['operation'] in ('document_import', 'document_queue', 'document_archive')]
    assert len(writes) == 13 and len({c['input']['event_id'] for c in writes}) == 7
    # The direct synthetic archival above is the eighth event, not a browser delivery.
    assert not any(c['operation'] in ('consolidate', 'commit', 'capture', 'update', 'review') for c in calls)
    page.locator('#logout').click()
    expect(page.locator('#workspace')).to_be_hidden()
    assert page.evaluate('localStorage.length') == 0 and page.evaluate('sessionStorage.length') == 0
    assert not errors, 'Unexpected browser JavaScript error; raw text omitted'
    checks += 1
    report = {'passed': True, 'checks': checks, 'browser': 'Chromium ' + browser.version,
              'browser_write_deliveries': 13, 'unique_browser_events': 7, 'direct_fixture_events': 1,
              'expected_total_events': 8, 'scope': 'Real console/PostgreSQL writes with damaged browser receipts and explicit stable replay; synthetic data, no model calls'}
    if os.environ.get('ULTRABRAIN_BROWSER_REPORT'):
        Path(os.environ['ULTRABRAIN_BROWSER_REPORT']).write_text(json.dumps(report, indent=2) + '\n', encoding='utf8')
    context.close()
    browser.close()
print('PASS', checks, 'real Chromium document receipt checks; 8 synthetic events including concurrent archival')
