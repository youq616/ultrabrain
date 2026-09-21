"""Real console processing + damaged browser acknowledgements; synthetic data/models only."""
import json
import os
from pathlib import Path
from playwright.sync_api import sync_playwright, expect

origin, token = (os.environ[k] for k in ('ULTRABRAIN_BROWSER_ORIGIN', 'ULTRABRAIN_BROWSER_TOKEN'))
f = json.loads(os.environ['ULTRABRAIN_RECOVERY_FIXTURE'])
checks = 0
with sync_playwright() as p:
    browser = p.chromium.launch(headless=True, args=['--no-sandbox'])
    context = browser.new_context(viewport={'width': 1320, 'height': 1050})
    page = context.new_page()
    calls, errors = [], []
    page.on('pageerror', lambda e: errors.append(str(e)))
    page.on('dialog', lambda d: d.accept())
    page.on('request', lambda r: calls.append(r.post_data_json)
            if r.method == 'POST' and r.url.endswith('/api/call') else None)
    def response_for(operation):
        return page.expect_response(lambda r: r.request.method == 'POST' and r.request.post_data_json.get('operation') == operation)
    def select(name):
        page.locator('[data-view="jobs"]').click()
        page.locator('#job-id').fill(f[name]['job_id'])
        with response_for('jobs'):
            page.locator('#job-form button[type="submit"]').click()
        expect(page.locator('#results article')).to_have_count(1)
        expect(page.locator('#results')).to_contain_text(f[name]['job_id'])
    def inspect(state):
        with response_for('jobs'):
            page.locator('#pending-job-inspect').click()
        expect(page.locator('#pending-job-status')).to_contain_text('"state": "'+state+'"')
        expect(page.locator('#pending-panel')).to_be_visible()
    def finish():
        page.locator('#pending-job-consent').check()
        with response_for('jobs'):
            page.locator('#pending-job-finish').click()
        expect(page.locator('#pending-panel')).to_be_hidden()
        expect(page.locator('#message')).to_contain_text('原处理回执仍未恢复')
    def damage_process(name, change):
        select(name)
        def intercept(route):
            if route.request.post_data_json['operation'] != 'consolidate':
                route.continue_(); return
            response = route.fetch()
            assert response.ok
            body = response.json()
            assert body['result']['results'][0]['job_id'] == f[name]['job_id']
            change(body)
            route.fulfill(status=200, content_type='application/json', body=json.dumps(body))
        page.route('**/api/call', intercept)
        page.get_by_role('button', name='整理此条（调用模型）', exact=True).click()
        expect(page.locator('#message')).to_contain_text('console_receipt_unconfirmed')
        expect(page.locator('#pending-panel')).to_be_visible()
        expect(page.locator('#retry')).to_be_disabled()
        page.unroute('**/api/call', intercept)
    page.goto(origin, wait_until='networkidle')
    page.locator('#token').fill(token)
    page.locator('#login-form button').click()
    expect(page.locator('#workspace')).to_be_visible()
    page.locator('#content').fill('RECOVERY_UNSAVED_DRAFT')
    damage_process('completed', lambda body: body.update(result={}))
    assert len([c for c in calls if c['operation'] == 'consolidate']) == 1
    expect(page.locator('#pending-guidance')).to_contain_text('不是幂等事件重放')
    checks += 1
    # Even a status endpoint with a bad source must not release the uncertain request.
    def wrong_source(route):
        if route.request.post_data_json['operation'] != 'jobs':
            route.continue_(); return
        response = route.fetch()
        assert response.ok
        body = response.json(); body['result']['source_id'] = 'foreign'
        route.fulfill(status=200, content_type='application/json', body=json.dumps(body))
    page.route('**/api/call', wrong_source)
    page.locator('#pending-job-inspect').click()
    expect(page.locator('#message')).to_contain_text('job_page_unconfirmed')
    expect(page.locator('#pending-panel')).to_be_visible()
    expect(page.locator('#pending-job-finish')).to_be_disabled()
    page.unroute('**/api/call', wrong_source)
    checks += 1
    inspect('completed')
    expect(page.locator('#pending-job-finish')).to_be_disabled()
    expect(page.locator('#content')).to_have_value('RECOVERY_UNSAVED_DRAFT')
    if os.environ.get('ULTRABRAIN_JOB_RECOVERY_SCREENSHOT'):
        page.screenshot(path=os.environ['ULTRABRAIN_JOB_RECOVERY_SCREENSHOT'], full_page=True)
    checks += 1
    page.locator('#pending-job-clear').click()
    expect(page.locator('#pending-job-status')).to_have_text('')
    expect(page.locator('#pending-panel')).to_be_visible()
    inspect('completed'); finish()
    assert len([c for c in calls if c['operation'] == 'consolidate']) == 1
    checks += 1
    # The first retry scenario really never reaches the server; the retried JSON must remain identical.
    select('retry')
    def drop_before_send(route):
        if route.request.post_data_json['operation'] == 'consolidate':
            route.abort('failed')
        else:
            route.continue_()
    page.route('**/api/call', drop_before_send)
    page.get_by_role('button', name='整理此条（调用模型）', exact=True).click()
    expect(page.locator('#message')).to_contain_text('network_unconfirmed')
    page.unroute('**/api/call', drop_before_send)
    inspect('queued')
    expect(page.locator('#pending-job-finish')).to_be_disabled()
    with response_for('consolidate'):
        page.locator('#retry').click()
    expect(page.locator('#pending-panel')).to_be_hidden()
    writes = [c for c in calls if c['operation'] == 'consolidate' and c['input']['job_id'] == f['retry']['job_id']]
    assert len(writes) == 2 and writes[0] == writes[1]
    checks += 1
    damage_process('failed', lambda body: body['result'].update(source_id='foreign'))
    inspect('failed'); finish()
    assert len([c for c in calls if c['operation'] == 'consolidate' and c['input']['job_id'] == f['failed']['job_id']]) == 1
    checks += 1
    # Cancel on the real API between card selection and process admission: no work is a valid reply.
    select('no_work')
    def cancel_first(route):
        if route.request.post_data_json['operation'] != 'consolidate':
            route.continue_(); return
        response = context.request.post(origin+'/api/call', headers={'Origin': origin, 'Authorization': 'Bearer '+token},
                                        data={'operation': 'cancel_job', 'input': {'job_id': f['no_work']['job_id']}})
        assert response.ok
        result = route.fetch()
        assert result.ok and result.json()['result']['processed'] == 0
        route.fulfill(response=result)
    page.route('**/api/call', cancel_first)
    with response_for('consolidate'):
        page.get_by_role('button', name='整理此条（调用模型）', exact=True).click()
    expect(page.locator('#pending-panel')).to_be_hidden()
    expect(page.locator('#results')).to_contain_text('stale')
    page.unroute('**/api/call', cancel_first)
    checks += 1
    select('lease')
    with response_for('consolidate') as item:
        page.get_by_role('button', name='整理此条（调用模型）', exact=True).click()
    assert item.value.json()['result']['results'][0]['state'] == 'lease_lost'
    expect(page.locator('#pending-panel')).to_be_hidden()
    expect(page.locator('#results')).to_contain_text('stale')
    checks += 1
    expect(page.locator('#content')).to_have_value('RECOVERY_UNSAVED_DRAFT')
    assert not any(c['operation'] in ('capture','commit','update','review','document_read') for c in calls)
    assert len([c for c in calls if c['operation'] == 'consolidate']) == 6
    assert all(c['input']['limit'] == 1 for c in calls if c['operation'] == 'consolidate')
    page.locator('#logout').click()
    expect(page.locator('#workspace')).to_be_hidden()
    assert page.evaluate('localStorage.length') == 0 and page.evaluate('sessionStorage.length') == 0
    assert not errors, 'Unexpected browser JavaScript error; raw text omitted'
    checks += 1
    report = {'passed': True, 'checks': checks, 'browser': 'Chromium '+browser.version,
              'processing_browser_deliveries': 6, 'dropped_before_server': 1, 'synthetic_generator_invocations_expected': 4,
              'external_models': False, 'scope': 'Actual console processing/status with synthetic generators, corrupted acknowledgements, explicit fresh recovery and unchanged-input retry'}
    if os.environ.get('ULTRABRAIN_JOB_RECOVERY_REPORT'):
        Path(os.environ['ULTRABRAIN_JOB_RECOVERY_REPORT']).write_text(json.dumps(report, indent=2)+'\n',encoding='utf8')
    context.close(); browser.close()
print('PASS',checks,'real Chromium processing acknowledgement and recovery checks')
