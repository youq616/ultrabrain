"""Read-only phase AFTER synthetic document writes: real console/DB, corrupt browser delivery only."""
import base64
import json
import os
from pathlib import Path
from playwright.sync_api import sync_playwright, expect

origin, token = (os.environ[k] for k in ('ULTRABRAIN_BROWSER_ORIGIN', 'ULTRABRAIN_BROWSER_TOKEN'))
checks = 0
with sync_playwright() as p:
    browser = p.chromium.launch(headless=True, args=['--no-sandbox'])
    context = browser.new_context(viewport={'width': 1320, 'height': 1050}, accept_downloads=True)
    page = context.new_page()
    calls, downloads, errors = [], [], []
    page.on('request', lambda r: calls.append(r.post_data_json) if r.method == 'POST' and r.url.endswith('/api/call') else None)
    page.on('download', lambda item: downloads.append(item))
    page.on('pageerror', lambda error: errors.append(str(error)))

    def api(operation, data):
        response = context.request.post(origin + '/api/call', headers={'Origin': origin, 'Authorization': 'Bearer ' + token},
                                        data={'operation': operation, 'input': data})
        assert response.ok, 'Read fixture failed; response omitted'
        return response.json()['result']

    rows = api('document_list', {'status': 'any', 'limit': 20})['documents']
    assert len(rows) == 2 and all(r['status'] == 'archived' for r in rows)
    a = next(r for r in rows if r['label'] == '回执合成.MD')
    b = next(r for r in rows if r['label'] == 'historical-import.txt')
    originals = {r['document_id']: api('document_read', {'document_id': r['document_id']}) for r in (a, b)}

    def card(row):
        return page.locator('#results article').filter(has=page.locator('strong', has_text=row['label']))

    def click(row, download=False):
        card(row).get_by_role('button', name='下载原文' if download else '查看原文', exact=True).click()

    def login():
        page.locator('#token').fill(token)
        page.locator('#login-form button').click()
        expect(page.locator('#workspace')).to_be_visible()
        page.locator('[data-view="documents"]').click()
        expect(page.locator('#results article')).to_have_count(2)

    page.goto(origin, wait_until='networkidle')
    login()
    page.locator('#content').fill('READ_UNSAVED_DRAFT')
    click(a)
    expect(page.locator('#document-original')).to_be_visible()
    expect(page.locator('#document-original-title')).to_contain_text('已归档')
    assert page.locator('#document-original-text').text_content() == base64.b64decode(originals[a['document_id']]['content_base64']).decode('utf-8-sig')
    before = len([c for c in calls if c['operation'] == 'document_read'])
    with page.expect_download() as item:
        click(a, download=True)
    assert item.value.suggested_filename == a['label']
    assert Path(item.value.path()).read_bytes() == base64.b64decode(originals[a['document_id']]['content_base64'])
    assert len([c for c in calls if c['operation'] == 'document_read']) == before + 1, 'Download must not bypass a fresh server read'
    checks += 1

    def corrupt(change, download=False, reject=False):
        sent = []
        def intercept(route):
            body = route.request.post_data_json
            if body['operation'] != 'document_read':
                route.continue_()
                return
            response = route.fetch()
            assert response.ok
            data = response.json()
            sent.append(body)
            if reject:
                route.fulfill(status=404, content_type='application/json', body=json.dumps({'ok': False, 'error': 'not_found', 'delivery': 'rejected'}))
            else:
                change(data['result'])
                route.fulfill(status=200, content_type='application/json', body=json.dumps(data))
        page.route('**/api/call', intercept)
        before = len(downloads)
        click(a, download)
        expect(page.locator('#message')).to_contain_text('未确认')
        expect(page.locator('#document-original')).to_be_hidden()
        expect(page.locator('#document-original-text')).to_have_text('')
        expect(page.locator('#pending-panel')).to_be_hidden()
        expect(page.locator('#content')).to_have_value('READ_UNSAVED_DRAFT')
        assert len(downloads) == before and len(sent) == 1
        page.unroute('**/api/call', intercept)

    for change in [lambda r: r.update(source_id='different-source'),
                   lambda r: r.update(document_id=b['document_id']),
                   lambda r: r.update(originals[b['document_id']]),
                   lambda r: r.update(content_base64=r['content_base64'] + '\n'),
                   lambda r: r.update(label='../unsafe.md')]:
        corrupt(change)
        checks += 1
    click(a)
    expect(page.locator('#document-original')).to_be_visible()
    corrupt(lambda r: None, download=True, reject=True)
    checks += 1

    def hold_a():
        held = []
        def intercept(route):
            body = route.request.post_data_json
            if body['operation'] == 'document_read' and body['input']['document_id'] == a['document_id']:
                response = route.fetch()  # The actual server read finished before the UI cancels it.
                assert response.ok
                held.append((route, response))
                page.evaluate("document.documentElement.dataset.documentReadHeld='true'")
            else:
                route.continue_()
        page.route('**/api/call', intercept)
        return held, intercept

    def release(held, intercept):
        assert len(held) == 1
        held[0][0].fulfill(response=held[0][1])
        page.unroute('**/api/call', intercept)
        page.evaluate('delete document.documentElement.dataset.documentReadHeld')
        page.wait_for_load_state('networkidle')

    held, intercept = hold_a()
    click(a)
    expect(page.locator('html')).to_have_attribute('data-document-read-held', 'true')
    click(b)
    expect(page.locator('#document-original-text')).to_have_text('HISTORICAL_IMPORT')
    release(held, intercept)
    expect(page.locator('#document-original-text')).to_have_text('HISTORICAL_IMPORT')
    expect(page.locator('#document-original-title')).to_contain_text(b['label'])
    checks += 1

    held, intercept = hold_a()
    before = len(downloads)
    click(a, download=True)
    expect(page.locator('html')).to_have_attribute('data-document-read-held', 'true')
    with page.expect_download() as item:
        click(b, download=True)
    assert item.value.suggested_filename == b['label']
    assert Path(item.value.path()).read_bytes() == b'HISTORICAL_IMPORT'
    release(held, intercept)
    assert len(downloads) == before + 1, 'Cancelled older download must not produce another file'
    checks += 1

    held, intercept = hold_a()
    before = len(downloads)
    click(a, download=True)
    expect(page.locator('html')).to_have_attribute('data-document-read-held', 'true')
    page.locator('#document-read-cancel').click()
    release(held, intercept)
    expect(page.locator('#document-original-text')).to_have_text('')
    expect(page.locator('#document-original')).to_be_hidden()
    assert len(downloads) == before
    checks += 1

    click(b)
    expect(page.locator('#document-original')).to_be_visible()
    page.locator('#document-read-cancel').click()
    expect(page.locator('#document-original-text')).to_have_text('')
    if os.environ.get('ULTRABRAIN_BROWSER_SCREENSHOT'):
        page.screenshot(path=os.environ['ULTRABRAIN_BROWSER_SCREENSHOT'], full_page=True)
    checks += 1

    held, intercept = hold_a()
    click(a)
    expect(page.locator('html')).to_have_attribute('data-document-read-held', 'true')
    page.locator('#logout').click()
    release(held, intercept)
    expect(page.locator('#workspace')).to_be_hidden()
    expect(page.locator('#message')).to_have_text('管理台已锁定。')
    expect(page.locator('#document-original-text')).to_have_text('')
    assert page.evaluate('localStorage.length') == 0 and page.evaluate('sessionStorage.length') == 0
    assert not errors, 'Unexpected browser JS error; details omitted'
    assert all(c['operation'] in ('info', 'search', 'document_list', 'document_read') for c in calls), 'No write or model request allowed'
    checks += 1
    report = {'passed': True, 'checks': checks, 'browser': 'Chromium ' + browser.version,
              'download_count': len(downloads), 'document_reads': sum(c['operation'] == 'document_read' for c in calls),
              'scope': 'Read-only real console/DB phase after synthetic document seeding; corrupt browser replies, current-selection fencing, fresh downloads and cancellation; no model calls'}
    if os.environ.get('ULTRABRAIN_BROWSER_REPORT'):
        Path(os.environ['ULTRABRAIN_BROWSER_REPORT']).write_text(json.dumps(report, indent=2) + '\n', encoding='utf8')
    context.close()
    browser.close()
print('PASS', checks, 'real Chromium bound-document read checks; no writes or model calls in this phase')
