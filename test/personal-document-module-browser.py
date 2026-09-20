"""Actual complete personal-document workflow, then hostile metadata-page responses. Synthetic only."""
import json
import os
from pathlib import Path
from playwright.sync_api import sync_playwright, expect

origin, token = (os.environ[k] for k in ('ULTRABRAIN_BROWSER_ORIGIN', 'ULTRABRAIN_BROWSER_TOKEN'))
original = '\ufeffMODULE_ORIGINAL\r\n保留否定词🙂\r\n'.encode('utf8')
checks = []
with sync_playwright() as p:
    browser = p.chromium.launch(headless=True, args=['--no-sandbox'])
    context = browser.new_context(viewport={'width': 1320, 'height': 1050}, accept_downloads=True)
    page = context.new_page()
    calls, errors = [], []
    page.on('pageerror', lambda e: errors.append(str(e)))
    page.on('dialog', lambda d: d.accept())
    page.on('request', lambda r: calls.append(r.post_data_json) if r.method == 'POST' and r.url.endswith('/api/call') else None)
    page.goto(origin, wait_until='networkidle')
    page.locator('#token').fill(token)
    page.locator('#login-form button').click()
    expect(page.locator('#workspace')).to_be_visible()
    page.locator('[data-view="documents"]').click()
    expect(page.locator('#results article')).to_have_count(20)
    expect(page.locator('#next')).to_be_enabled()
    page.locator('#next').click()
    expect(page.locator('#results article')).to_have_count(3)
    expect(page.locator('#next')).to_be_disabled()
    assert not any(c['operation'] == 'document_read' for c in calls)
    checks.append('metadata-only real 23-document pagination')

    page.locator('#document-status').select_option('archived')
    expect(page.locator('#results article')).to_have_count(2)
    expect(page.locator('#prev')).to_be_disabled()
    assert [c for c in calls if c['operation'] == 'document_list'][-1]['input'] == {'status': 'archived', 'limit': 20, 'offset': 0}
    page.locator('#document-status').select_option('active')
    expect(page.locator('#results article')).to_have_count(20)
    page.locator('#next').click()
    expect(page.locator('#results article')).to_have_count(1)
    checks.append('server lifecycle filtering resets pagination')

    page.locator('#content').fill('MODULE_UNSAVED_DRAFT')
    page.locator('#document-file').set_input_files({'name': 'module-user.md', 'mimeType': 'text/plain', 'buffer': original})
    page.locator('#document-consent').check()
    page.locator('#document-import').click()
    expect(page.locator('#message')).to_contain_text('操作已确认')
    page.locator('#document-status').select_option('any')
    card = page.locator('#results article').filter(has=page.locator('strong', has_text='module-user.md'))
    expect(card).to_have_count(1)
    card.get_by_role('button', name='查看原文', exact=True).click()
    expect(page.locator('#document-original-text')).to_have_text(original.decode('utf-8-sig'))
    with page.expect_download() as download:
        card.get_by_role('button', name='下载原文', exact=True).click()
    assert Path(download.value.path()).read_bytes() == original
    expect(page.locator('#content')).to_have_value('MODULE_UNSAVED_DRAFT')
    checks.append('explicit import then verified preview and exact-byte download')

    card.get_by_role('button', name='排队整理（之后才会调用模型）', exact=True).click()
    expect(page.locator('#message')).to_contain_text('操作已确认')
    expect(card).to_contain_text('片段 1')
    card.get_by_role('button', name='归档文档', exact=True).click()
    expect(page.locator('#message')).to_contain_text('操作已确认')
    expect(card).to_contain_text('已归档')
    expect(card.get_by_role('button', name='归档文档', exact=True)).to_have_count(0)
    with page.expect_download() as download:
        card.get_by_role('button', name='下载原文', exact=True).click()
    assert Path(download.value.path()).read_bytes() == original
    checks.append('queued fragment archived; original retained and freshly downloadable')

    page.locator('#document-status').select_option('archived')
    expect(page.locator('#results article')).to_have_count(3)
    if os.environ.get('ULTRABRAIN_MODULE_SCREENSHOT'):
        page.screenshot(path=os.environ['ULTRABRAIN_MODULE_SCREENSHOT'], full_page=True)
    for kind in ('foreign-source', 'duplicate-id', 'embedded-content', 'invalid-last-row', 'invalid-cursor'):
        def corrupt(route):
            if route.request.post_data_json.get('operation') != 'document_list':
                route.continue_()
                return
            response = route.fetch()
            assert response.ok
            data = response.json()
            result = data['result']
            if kind == 'foreign-source':
                result['source_id'] = 'foreign'
            elif kind == 'duplicate-id':
                result['documents'][1]['document_id'] = result['documents'][0]['document_id']
            elif kind == 'embedded-content':
                result['documents'][0]['content_base64'] = 'SHOULD_NOT_RENDER'
            elif kind == 'invalid-last-row':
                result['documents'][-1]['fragments'] = -1
            else:
                result['next_offset'] = 20
            route.fulfill(status=200, content_type='application/json', body=json.dumps(data))
        page.route('**/api/call', corrupt)
        page.locator('#refresh').click()
        expect(page.locator('#coverage')).to_contain_text('列表未确认')
        expect(page.locator('#results article')).to_have_count(0)
        expect(page.locator('#export')).to_be_disabled()
        expect(page.locator('#next')).to_be_disabled()
        expect(page.locator('#document-original')).to_be_hidden()
        expect(page.locator('#pending-panel')).to_be_hidden()
        expect(page.locator('#content')).to_have_value('MODULE_UNSAVED_DRAFT')
        page.unroute('**/api/call', corrupt)
        checks.append('metadata response refused atomically: ' + kind)
    page.locator('#refresh').click()
    expect(page.locator('#results article')).to_have_count(3)
    with page.expect_download() as download:
        page.locator('#export').click()
    exported = json.loads(Path(download.value.path()).read_text(encoding='utf8'))
    assert exported['complete'] is False and len(exported['result']['documents']) == 3
    assert 'content_base64' not in json.dumps(exported) and token not in json.dumps(exported)
    checks.append('explicit page export contains only validated metadata')
    page.set_viewport_size({'width': 390, 'height': 844})
    assert page.evaluate('document.documentElement.scrollWidth <= window.innerWidth')
    expect(page.locator('#document-status')).to_be_visible()
    expect(page.locator('#content')).to_have_value('MODULE_UNSAVED_DRAFT')
    page.locator('#logout').click()
    expect(page.locator('#workspace')).to_be_hidden()
    assert not errors
    assert not any(c['operation'] in ('consolidate', 'commit', 'capture', 'update', 'review') for c in calls)
    writes = [c for c in calls if c['operation'] in ('document_import', 'document_queue', 'document_archive')]
    assert len(writes) == 3 and len({c['input']['event_id'] for c in writes}) == 3
    checks.append('mobile, lock, no model invocation or unrelated draft capture')
    report = {'passed': True, 'checks': len(checks), 'cases': checks, 'browser': 'Chromium '+browser.version,
              'scope': 'Explicit synthetic document lifecycle plus metadata-only pagination/filter/refusal; not model-quality or user deployment proof'}
    if os.environ.get('ULTRABRAIN_MODULE_REPORT'):
        Path(os.environ['ULTRABRAIN_MODULE_REPORT']).write_text(json.dumps(report, indent=2)+'\n', encoding='utf8')
    context.close()
    browser.close()
print('PASS', len(checks), 'whole-document-module Chromium acceptance checks')
