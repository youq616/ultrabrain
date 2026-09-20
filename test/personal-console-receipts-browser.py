"""Fault-inject only browser delivery AFTER real console/DB replies. Synthetic records only."""
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
        assert response.ok, 'Synthetic API read failed; raw response omitted'
        return response.json()['result']
    def lookup(memory_id):
        page.locator('[data-view="lookup"]').click()
        page.locator('#lookup-id').fill(memory_id)
        page.locator('#lookup-submit').click()
        expect(page.locator('#message')).to_contain_text('记录已核对')
    def damage(operation, change, action):
        observed = []
        def intercept(route):
            body = route.request.post_data_json
            if body['operation'] != operation:
                route.continue_()
                return
            response = route.fetch()
            assert response.ok, 'Actual server operation failed before injected receipt damage'
            data = response.json()
            observed.append({'input': body['input'], 'result': json.loads(json.dumps(data['result']))})
            change(data['result'])
            route.fulfill(status=200, content_type='application/json', body=json.dumps(data))
        page.route('**/api/call', intercept)
        action()
        expect(page.locator('#pending-panel')).to_be_visible()
        expect(page.locator('#message')).to_contain_text('console_receipt_unconfirmed')
        expect(page.locator('#save')).to_be_disabled()
        assert len(observed) == 1, 'There must be no automatic retry'
        page.unroute('**/api/call', intercept)
        return observed[0]
    def replay(operation, original):
        with page.expect_response(lambda r: r.request.method == 'POST' and r.request.post_data_json.get('operation') == operation) as response:
            page.locator('#retry').click()
        actual = response.value.json()['result']
        assert actual['replayed'] is True
        expect(page.locator('#pending-panel')).to_be_hidden()
        assert [c['input'] for c in calls if c['operation'] == operation][-2:] == [original['input'], original['input']]
        return actual

    page.goto(origin, wait_until='networkidle')
    page.locator('#token').fill(token)
    page.locator('#login-form button').click()
    expect(page.locator('#workspace')).to_be_visible()
    page.locator('[data-view="lookup"]').click()
    page.locator('#content').fill('RECEIPT_REGISTRATION_PROTECTED')
    page.locator('#consent').check()
    damage('register', lambda r: r.update(source_id='incorrect-source'), lambda: page.locator('#save').click())
    assert not any(c['operation'] == 'commit' for c in calls), 'Unverified registration must not release plaintext'
    expect(page.locator('#content')).to_have_value('RECEIPT_REGISTRATION_PROTECTED')
    checks += 1
    with page.expect_response(lambda r: r.request.method == 'POST' and r.request.post_data_json.get('operation') == 'commit'):
        page.locator('#retry').click()
    expect(page.locator('#pending-panel')).to_be_hidden()
    checks += 1

    page.locator('#content').fill('RECEIPT_COMMIT_ONCE')
    page.locator('#consent').check()
    sent = damage('commit', lambda r: r.update(event_id='wrong-event'), lambda: page.locator('#save').click())
    memory_id = sent['result']['entries'][0]['id']
    assert api('memory_read', {'memory_id': memory_id})['memory']['revision'] == 1
    # Download only the explicit recovery request. Never include the live token/closures.
    with page.expect_download() as download:
        page.locator('#save-pending').click()
    exported = Path(download.value.path()).read_text(encoding='utf8')
    saved = json.loads(exported)
    assert saved['input'] == sent['input'] and saved['delivery_unconfirmed'] is True
    assert token not in exported and 'sessionCurrent' not in saved
    if os.environ.get('ULTRABRAIN_BROWSER_SCREENSHOT'):
        page.screenshot(path=os.environ['ULTRABRAIN_BROWSER_SCREENSHOT'], full_page=True)
    replay('commit', sent)
    assert api('memory_read', {'memory_id': memory_id})['memory']['revision'] == 1
    checks += 1

    lookup(memory_id)
    page.locator('#results button', has_text='编辑').click()
    page.locator('#content').fill('RECEIPT_UPDATED_ONCE')
    page.locator('#consent').check()
    sent = damage('update', lambda r: r.update(id='22222222-2222-4222-8222-222222222222'), lambda: page.locator('#save').click())
    replay('update', sent)
    current = api('memory_read', {'memory_id': memory_id})['memory']
    assert current['revision'] == 2 and current['content'] == 'RECEIPT_UPDATED_ONCE' and current['status'] == 'candidate'
    checks += 1

    lookup(memory_id)
    page.locator('#content').fill('UNRELATED_DRAFT_REVIEW')
    sent = damage('review', lambda r: r.update(revision=999), lambda: page.locator('#results button', has_text='确认启用').click())
    replay('review', sent)
    expect(page.locator('#content')).to_have_value('UNRELATED_DRAFT_REVIEW')
    current = api('memory_read', {'memory_id': memory_id})['memory']
    assert current['revision'] == 3 and current['status'] == 'active'
    checks += 1

    page.locator('#content').fill('RECEIPT_CAPTURE_ONCE')
    page.locator('#consent').check()
    sent = damage('capture', lambda r: r.update(job_id='invalid-job-id'), lambda: page.locator('#queue-personal').click())
    actual = replay('capture', sent)
    assert actual['job_id'] == sent['result']['job_id']
    jobs = api('jobs', {'job_id': actual['job_id']})['jobs']
    assert len(jobs) == 1 and jobs[0]['state'] == 'queued' and jobs[0]['attempts'] == 0
    checks += 1

    # Keep a NEW local draft created after actual server commit but before delivery.
    late_receipt = []
    def edit_after_commit(route):
        body = route.request.post_data_json
        if body['operation'] != 'commit':
            route.continue_()
            return
        response = route.fetch()
        assert response.ok
        late_receipt.append(response.json()['result'])
        page.locator('#content').fill('RECEIPT_NEWER_UNSAVED_DRAFT')
        route.fulfill(response=response)
    page.route('**/api/call', edit_after_commit)
    page.locator('#content').fill('RECEIPT_ORIGINAL_ACTUALLY_SENT')
    page.locator('#consent').check()
    page.locator('#save').click()
    expect(page.locator('#message')).to_contain_text('草稿已保留')
    expect(page.locator('#pending-panel')).to_be_hidden()
    expect(page.locator('#content')).to_have_value('RECEIPT_NEWER_UNSAVED_DRAFT')
    expect(page.locator('#consent')).not_to_be_checked()
    page.unroute('**/api/call', edit_after_commit)
    latest_id = late_receipt[0]['entries'][0]['id']
    assert api('memory_read', {'memory_id': latest_id})['memory']['content'] == 'RECEIPT_ORIGINAL_ACTUALLY_SENT'
    checks += 1
    lookup(latest_id)
    page.locator('#results button', has_text='确认启用').click()
    expect(page.locator('#message')).to_contain_text('操作已确认')
    expect(page.locator('#content')).to_have_value('RECEIPT_NEWER_UNSAVED_DRAFT')
    assert api('memory_read', {'memory_id': latest_id})['memory']['revision'] == 2
    checks += 1
    page.locator('#logout').click()
    expect(page.locator('#workspace')).to_be_hidden()
    assert page.evaluate('localStorage.length') == 0 and page.evaluate('sessionStorage.length') == 0
    assert not errors, 'Unexpected browser JavaScript error; details omitted'
    # Exclude duplicate deliveries: the fixture separately checks real DB deltas.
    events = [c['input']['event_id'] for c in calls if c['operation'] in ('commit', 'capture', 'update', 'review')]
    assert len(set(events)) == 7 and len(events) == 11
    checks += 1
    report = {'passed': True, 'checks': checks, 'browser': 'Chromium ' + browser.version,
              'unique_events': 7, 'memory_write_deliveries': 11,
              'scope': 'Real console/database responses, browser-only damage, stable explicit replay and independent draft preservation; synthetic data, no model calls'}
    if os.environ.get('ULTRABRAIN_BROWSER_REPORT'):
        Path(os.environ['ULTRABRAIN_BROWSER_REPORT']).write_text(json.dumps(report, indent=2) + '\n', encoding='utf8')
    context.close()
    browser.close()
print('PASS', checks, 'real Chromium receipt/replay/draft checks; seven explicit synthetic events')
