"""Real browser + console, synthetic task fixture. No configured model or user content."""
import json
import os
from pathlib import Path
from playwright.sync_api import sync_playwright, expect

origin, token = (os.environ[k] for k in ('ULTRABRAIN_BROWSER_ORIGIN', 'ULTRABRAIN_BROWSER_TOKEN'))
f = json.loads(os.environ['ULTRABRAIN_JOB_FIXTURE'])
checks = 0
with sync_playwright() as p:
    browser = p.chromium.launch(headless=True, args=['--no-sandbox'])
    context = browser.new_context(viewport={'width': 1320, 'height': 1050}, accept_downloads=True)
    page = context.new_page()
    errors, calls = [], []
    page.on('pageerror', lambda error: errors.append(str(error)))
    page.on('dialog', lambda dialog: dialog.accept())
    page.on('request', lambda request: calls.append(request.post_data_json)
            if request.method == 'POST' and request.url.endswith('/api/call') else None)
    page.goto(origin, wait_until='networkidle')
    page.locator('#token').fill(token)
    page.locator('#login-form button').click()
    expect(page.locator('#workspace')).to_be_visible()
    page.locator('#content').fill('TASK_UNSAVED_DRAFT')
    page.locator('[data-view="jobs"]').click()
    expect(page.locator('#results article')).to_have_count(20)
    expect(page.locator('#job-panel')).to_be_visible()
    expect(page.locator('#results')).not_to_contain_text('JOB_ORIGINAL_')
    assert not any(c['operation'] in ('consolidate', 'cancel_job', 'memory_read') for c in calls)
    checks += 1

    def state(value):
        page.locator('#job-id').fill('')
        page.locator('#job-state').select_option(value)
    state('queued')
    expect(page.locator('#results article')).to_have_count(20)
    first = set(page.locator('#results article').evaluate_all('(cards)=>cards.map(c=>c.dataset.jobId)'))
    page.locator('#next').click()
    expect(page.locator('#results article')).to_have_count(3)
    last = set(page.locator('#results article').evaluate_all('(cards)=>cards.map(c=>c.dataset.jobId)'))
    assert not (first & last) and first | last == set(f['queued'])
    expect(page.locator('#next')).to_be_disabled()
    page.locator('#prev').click()
    expect(page.locator('#results article')).to_have_count(20)
    checks += 1
    state('failed')
    expect(page.locator('#results article')).to_have_count(1)
    expect(page.locator('#results')).to_contain_text(f['failed'])
    expect(page.locator('#results')).to_contain_text('1 / 3')
    checks += 1
    state('completed')
    expect(page.locator('#results article')).to_have_count(1)
    expect(page.locator('#results')).to_contain_text(f['completed'])
    expect(page.get_by_role('button', name='取消整理，保留原文', exact=True)).to_have_count(0)
    with page.expect_download() as item:
        page.locator('#export').click()
    exported = Path(item.value.path()).read_text(encoding='utf8')
    assert 'JOB_GENERATED_CANDIDATE' not in exported and 'JOB_ORIGINAL_completed' not in exported and token not in exported
    assert json.loads(exported)['complete'] is False
    page.get_by_role('button', name='核对候选 #1', exact=True).click()
    expect(page.locator('#message')).to_contain_text('记录已核对')
    expect(page.locator('#lookup-id')).to_have_value(f['candidateMemory'])
    expect(page.locator('#results')).to_contain_text('JOB_GENERATED_CANDIDATE')
    expect(page.locator('#content')).to_have_value('TASK_UNSAVED_DRAFT')
    checks += 1
    page.locator('[data-view="jobs"]').click()
    expect(page.locator('#results article')).to_have_count(1)
    page.get_by_role('button', name='核对原文记录', exact=True).click()
    expect(page.locator('#message')).to_contain_text('记录已核对')
    expect(page.locator('#lookup-id')).to_have_value(f['sourceMemory'])
    expect(page.locator('#results')).to_contain_text('JOB_ORIGINAL_completed')
    checks += 1
    page.locator('[data-view="jobs"]').click()
    page.locator('#job-id').fill(f['queued'][0])
    page.locator('#job-form button[type="submit"]').click()
    expect(page.locator('#results article')).to_have_count(1)
    expect(page.locator('#results')).to_contain_text(f['queued'][0])
    expect(page.locator('#coverage')).to_contain_text('不受列表状态筛选')
    expect(page.locator('#next')).to_be_disabled()
    expect(page.locator('#prev')).to_be_disabled()
    checks += 1
    before = len(calls)
    page.locator('#job-clear').click()
    expect(page.locator('#results article')).to_have_count(0)
    expect(page.locator('#export')).to_be_disabled()
    assert len(calls) == before
    checks += 1
    page.locator('#job-id').fill('bad-id')
    page.locator('#job-form button[type="submit"]').click()
    expect(page.locator('#message')).to_contain_text('full_job_uuid_required')
    assert len(calls) == before
    page.locator('#job-id').fill('00000000-0000-4000-8000-000000000000')
    page.locator('#job-form button[type="submit"]').click()
    expect(page.locator('#message')).to_contain_text('not_found')
    expect(page.locator('#coverage')).to_contain_text('未确认')
    checks += 1
    page.locator('#job-id').fill(f['queued'][0])
    for damage in ['date', 'source']:
        def corrupt(route):
            if route.request.post_data_json['operation'] != 'jobs':
                route.continue_(); return
            response = route.fetch()
            assert response.ok
            data = response.json()
            if damage == 'date':
                data['result']['jobs'][0]['created_at'] = '2026-02-30T00:00:00.000Z'
            else:
                data['result']['source_id'] = 'foreign'
            route.fulfill(status=200, content_type='application/json', body=json.dumps(data))
        page.route('**/api/call', corrupt)
        page.locator('#job-form button[type="submit"]').click()
        expect(page.locator('#message')).to_contain_text('job_page_unconfirmed')
        expect(page.locator('#results article')).to_have_count(0)
        expect(page.locator('#export')).to_be_disabled()
        page.unroute('**/api/call', corrupt)
        checks += 1
    page.locator('#job-form button[type="submit"]').click()
    expect(page.locator('#results article')).to_have_count(1)
    # Alter selection without dispatching DOM events, then click the retained old card.
    before = len(calls)
    page.evaluate("id=>document.getElementById('job-id').value=id", f['queued'][1])
    page.get_by_role('button', name='取消整理，保留原文', exact=True).click()
    expect(page.locator('#message')).to_contain_text('任务视图已改变')
    assert len(calls) == before
    checks += 1
    # Successful actual cancellation followed by damaged acknowledgement; explicit same-ID retry.
    page.locator('#job-id').fill(f['queued'][0])
    page.locator('#job-form button[type="submit"]').click()
    expect(page.locator('#results article')).to_have_count(1)
    def bad_cancel(route):
        if route.request.post_data_json['operation'] != 'cancel_job':
            route.continue_(); return
        response = route.fetch()
        assert response.ok and response.json()['result']['state'] == 'stale'
        data = response.json()
        data['result']['id'] = f['failed']
        route.fulfill(status=200, content_type='application/json', body=json.dumps(data))
    page.route('**/api/call', bad_cancel)
    page.get_by_role('button', name='取消整理，保留原文', exact=True).click()
    expect(page.locator('#pending-panel')).to_be_visible()
    expect(page.locator('#message')).to_contain_text('console_receipt_unconfirmed')
    assert len([c for c in calls if c['operation'] == 'cancel_job']) == 1
    expect(page.locator('#content')).to_have_value('TASK_UNSAVED_DRAFT')
    if os.environ.get('ULTRABRAIN_JOB_SCREENSHOT'):
        page.screenshot(path=os.environ['ULTRABRAIN_JOB_SCREENSHOT'], full_page=True)
    page.unroute('**/api/call', bad_cancel)
    page.locator('#retry').click()
    expect(page.locator('#pending-panel')).to_be_hidden()
    expect(page.locator('#results')).to_contain_text('stale')
    delivered = [c for c in calls if c['operation'] == 'cancel_job']
    assert len(delivered) == 2 and delivered[0] == delivered[1]
    assert delivered[0]['input'] == {'job_id': f['queued'][0]}
    checks += 1
    page.get_by_role('button', name='核对原文记录', exact=True).click()
    expect(page.locator('#lookup-id')).to_have_value(f['cancelInput'])
    expect(page.locator('#message')).to_contain_text('记录已核对')
    expect(page.locator('#results')).to_contain_text('JOB_ORIGINAL_queued-0')
    checks += 1
    page.locator('[data-view="jobs"]').click()
    page.locator('#job-id').fill(f['queued'][1])
    page.locator('#job-form button[type="submit"]').click()
    expect(page.locator('#results')).to_contain_text(f['queued'][1])
    page.get_by_role('button', name='整理此条（调用模型）', exact=True).click()
    expect(page.locator('#message')).to_contain_text('尚未配置个人整理模型')
    expect(page.locator('#content')).to_have_value('TASK_UNSAVED_DRAFT')
    expect(page.locator('#results')).to_contain_text('queued')
    checks += 1
    # Deliver a real metadata read only after explicit local cancellation.
    def clear_late(route):
        if route.request.post_data_json['operation'] != 'jobs':
            route.continue_(); return
        response = route.fetch()
        assert response.ok
        page.locator('#job-clear').click()
        route.fulfill(response=response)
    page.route('**/api/call', clear_late)
    page.locator('#job-form button[type="submit"]').click()
    expect(page.locator('#message')).to_contain_text('任务结果已清除')
    expect(page.locator('#results article')).to_have_count(0)
    page.unroute('**/api/call', clear_late)
    checks += 1
    page.locator('#job-form button[type="submit"]').click()
    expect(page.locator('#results article')).to_have_count(1)
    page.set_viewport_size({'width': 390, 'height': 844})
    assert page.evaluate('document.documentElement.scrollWidth <= window.innerWidth')
    page.locator('#logout').click()
    expect(page.locator('#workspace')).to_be_hidden()
    expect(page.locator('#job-id')).to_have_value('')
    assert page.evaluate('localStorage.length') == 0 and page.evaluate('sessionStorage.length') == 0
    assert not errors, 'Unexpected browser error; raw data omitted'
    assert len([c for c in calls if c['operation'] == 'consolidate']) == 1
    assert not any(c['operation'] in ('capture','commit','update','review','document_import','document_queue','document_archive') for c in calls)
    checks += 1
    report = {'passed': True, 'checks': checks, 'browser': 'Chromium '+browser.version,
              'cancellation_deliveries': 2, 'cancelled_jobs': 1, 'model_configuration': 'absent; no model invocation',
              'scope': 'Real source-scoped task paging, metadata integrity, explicit trace reads, original-job cancellation retry and retained drafts; not model quality'}
    if os.environ.get('ULTRABRAIN_JOB_REPORT'):
        Path(os.environ['ULTRABRAIN_JOB_REPORT']).write_text(json.dumps(report, indent=2)+'\n', encoding='utf8')
    context.close()
    browser.close()
print('PASS', checks, 'real Chromium task management checks; only one synthetic job cancelled')
