"""Explicit browser reads against a seeded disposable console; never a user profile/model."""
import json
import os
from pathlib import Path
from playwright.sync_api import sync_playwright, expect

origin = os.environ['ULTRABRAIN_BROWSER_ORIGIN']
token = os.environ['ULTRABRAIN_BROWSER_TOKEN']
checks = 0

def passed():
    global checks
    checks += 1

with sync_playwright() as p:
    options = {'headless': True, 'args': ['--no-sandbox']}
    if os.environ.get('ULTRABRAIN_CHROMIUM'):
        options['executable_path'] = os.environ['ULTRABRAIN_CHROMIUM']
    browser = p.chromium.launch(**options)
    context = browser.new_context(viewport={'width': 1320, 'height': 1050}, accept_downloads=True)
    page = context.new_page()
    errors, calls = [], []
    page.on('pageerror', lambda error: errors.append(str(error)))
    def record(request):
        if request.method == 'POST' and request.url.endswith('/api/call'):
            calls.append(request.post_data_json)
    page.on('request', record)
    page.goto(origin, wait_until='networkidle')
    page.locator('#token').fill(token)
    page.locator('#login-form button').click()
    expect(page.locator('#results')).to_contain_text('PREVIEW_CANDIDATE')
    page.locator('[data-view="recall"]').click()
    expect(page.locator('#recall-panel')).to_be_visible()
    expect(page.locator('#memory-panel')).to_be_hidden()
    assert not any(c['operation'] == 'context' for c in calls)
    passed()

    page.locator('#recall-task').fill('Docker QUERY_PRIVATE_MARKER')
    page.locator('#recall-submit').click()
    expect(page.locator('#message')).to_contain_text('未发送预览')
    assert not any(c['operation'] == 'context' for c in calls)
    passed()
    page.locator('#recall-task').fill('中' * 1366)
    page.locator('#recall-consent').check()
    page.locator('#recall-submit').click()
    expect(page.locator('#message')).to_contain_text('4096_utf8_bytes')
    assert not any(c['operation'] == 'context' for c in calls)
    passed()

    def preview():
        page.locator('#recall-consent').check()
        with page.expect_response(lambda response: response.request.method == 'POST'
                                  and response.request.post_data_json.get('operation') == 'context') as response:
            page.locator('#recall-submit').click()
        result = response.value.json()['result']
        expect(page.locator('#message')).to_contain_text('本次只读预览已返回')
        return result

    page.locator('#recall-task').fill('Docker QUERY_PRIVATE_MARKER')
    result = preview()
    assert len(result['memories']) == 1
    expect(page.locator('#results')).to_contain_text('PREVIEW_GLOBAL')
    for excluded in ['PREVIEW_PROJECT_A', 'PREVIEW_PROJECT_B', 'PREVIEW_CANDIDATE', 'PREVIEW_ARCHIVED', 'PREVIEW_OVERSIZED']:
        expect(page.locator('#results')).not_to_contain_text(excluded)
    assert result['dropped'] >= 1
    assert page.locator('#results img').count() == 0
    assert page.evaluate('typeof window.previewInjected') == 'undefined'
    assert page.locator('#results button').count() == 0
    expect(page.locator('#prev')).to_be_disabled()
    expect(page.locator('#next')).to_be_disabled()
    expect(page.locator('#coverage')).to_contain_text('6000 UTF-8 字节')
    passed()

    with page.expect_download() as item:
        page.locator('#export').click()
    raw = Path(item.value.path()).read_text(encoding='utf8')
    exported = json.loads(raw)
    assert exported['complete'] is False and exported['view'] == 'recall'
    assert exported['result'] == result
    assert 'QUERY_PRIVATE_MARKER' not in raw and token not in raw
    passed()

    page.locator('#recall-project').fill('project-a')
    expect(page.locator('#recall-consent')).not_to_be_checked()
    expect(page.locator('#export')).to_be_disabled()
    expect(page.locator('#results article')).to_have_count(0)
    result = preview()
    assert len(result['memories']) == 2
    expect(page.locator('#results')).to_contain_text('PREVIEW_PROJECT_A')
    expect(page.locator('#results')).not_to_contain_text('PREVIEW_PROJECT_B')
    assert all(row.get('project_id') in (None, 'project-a') for row in result['memories'])
    passed()
    page.locator('#recall-budget').select_option('2048')
    result = preview()
    assert len(json.dumps(result, ensure_ascii=False, separators=(',', ':')).encode('utf8')) <= 2048
    assert all('PREVIEW_OVERSIZED' not in row['content'] for row in result['memories'])
    expect(page.locator('#coverage')).to_contain_text('2048 UTF-8 字节')
    passed()

    before = len([c for c in calls if c['operation'] == 'context'])
    page.locator('#refresh').click()
    expect(page.locator('#results article')).to_have_count(0)
    expect(page.locator('#export')).to_be_disabled()
    assert len([c for c in calls if c['operation'] == 'context']) == before
    passed()

    # Fetch a REAL server response, then change local authority before browser delivery.
    # Cases without input events also exercise the final frozen-selection assertion.
    for change in ['task', 'consent', 'cancel', 'navigation', 'logout']:
        if page.locator('#workspace').is_hidden():
            page.locator('#token').fill(token)
            page.locator('#login-form button').click()
            expect(page.locator('#workspace')).to_be_visible()
        page.locator('[data-view="recall"]').click()
        page.locator('#recall-task').fill('Docker QUERY_PRIVATE_MARKER')
        page.locator('#recall-consent').check()
        before = len([c for c in calls if c['operation'] == 'context'])
        def intercept(route):
            if route.request.post_data_json.get('operation') != 'context':
                route.continue_()
                return
            response = route.fetch()
            assert response.ok, 'Actual context read failed before the synthetic race'
            if change == 'task':
                page.evaluate("document.getElementById('recall-task').value='changed without an input event'")
            elif change == 'consent':
                page.evaluate("document.getElementById('recall-consent').checked=false")
            elif change == 'cancel':
                page.locator('#recall-cancel').click()
            elif change == 'navigation':
                page.locator('[data-view="agents"]').click()
            else:
                page.locator('#logout').click()
            route.fulfill(response=response)
        page.route('**/api/call', intercept)
        page.locator('#recall-submit').click()
        if change in ['task', 'consent']:
            expect(page.locator('#message')).to_contain_text('recall_authorization_changed')
        elif change == 'cancel':
            expect(page.locator('#message')).to_contain_text('预览已取消')
        elif change == 'navigation':
            expect(page.locator('#results')).to_contain_text('preview-fixture')
        else:
            expect(page.locator('#workspace')).to_be_hidden()
            expect(page.locator('#recall-task')).to_have_value('')
            expect(page.locator('#recall-project')).to_have_value('')
        expect(page.locator('#results')).not_to_contain_text('PREVIEW_GLOBAL')
        assert len([c for c in calls if c['operation'] == 'context']) == before + 1
        page.unroute('**/api/call', intercept)
        passed()

    page.locator('#token').fill(token)
    page.locator('#login-form button').click()
    expect(page.locator('#workspace')).to_be_visible()
    page.locator('[data-view="recall"]').click()
    page.locator('#recall-task').fill('Docker')
    page.locator('#recall-consent').check()
    def corrupt(route):
        if route.request.post_data_json.get('operation') != 'context':
            route.continue_(); return
        response = route.fetch()
        data = response.json()
        assert response.ok and data['result']['memories']
        data['result']['memories'][0]['content_hash'] = '0' * 64
        route.fulfill(status=200, content_type='application/json', body=json.dumps(data))
    page.route('**/api/call', corrupt)
    page.locator('#recall-submit').click()
    expect(page.locator('#message')).to_contain_text('recall_contract_changed')
    expect(page.locator('#results article')).to_have_count(0)
    expect(page.locator('#export')).to_be_disabled()
    page.unroute('**/api/call', corrupt)
    passed()

    page.locator('#recall-budget').select_option('6000')
    page.locator('#recall-project').fill('project-a')
    preview()
    if os.environ.get('ULTRABRAIN_BROWSER_SCREENSHOT'):
        page.screenshot(path=os.environ['ULTRABRAIN_BROWSER_SCREENSHOT'], full_page=True)
    page.set_viewport_size({'width': 390, 'height': 844})
    assert page.evaluate('document.documentElement.scrollWidth <= window.innerWidth')
    expect(page.locator('#recall-submit')).to_be_visible()
    passed()
    page.locator('#logout').click()
    assert page.evaluate('localStorage.length') == 0
    assert page.evaluate('sessionStorage.length') == 0
    assert set(c['operation'] for c in calls) <= {'info', 'search', 'agents', 'context'}
    assert not errors, 'Unexpected browser JavaScript error (raw content omitted)'
    passed()
    version = browser.version
    context.close()
    browser.close()

report = {'passed': True, 'checks': checks, 'browser': 'Chromium ' + version,
          'scope': 'Explicit task preview browser/API; database unchanged verified by fixture, no model quality claim'}
if os.environ.get('ULTRABRAIN_BROWSER_REPORT'):
    Path(os.environ['ULTRABRAIN_BROWSER_REPORT']).write_text(json.dumps(report, indent=2) + '\n', encoding='utf8')
print('PASS', checks, 'real Chromium task-preview checks')
