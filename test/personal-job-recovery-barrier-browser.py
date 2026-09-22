"""Real in-flight operations and no-effect retries, not mocked no-work replies."""
import json
import os
import sys
from pathlib import Path
from playwright.sync_api import sync_playwright, expect

origin, token = (os.environ[k] for k in ('ULTRABRAIN_BROWSER_ORIGIN', 'ULTRABRAIN_BROWSER_TOKEN'))
f = json.loads(os.environ['ULTRABRAIN_BARRIER_FIXTURE'])
source = os.environ['ULTRABRAIN_BARRIER_SOURCE']
checks = 0
with sync_playwright() as p:
    browser = p.chromium.launch(headless=True, args=['--no-sandbox'])
    context = browser.new_context(viewport={'width': 1320, 'height': 1050}, accept_downloads=True)
    page = context.new_page()
    calls, errors = [], []
    page.on('pageerror', lambda e: errors.append(str(e)))
    page.on('dialog', lambda d: d.accept())
    page.on('request', lambda r: calls.append(r.post_data_json)
            if r.method == 'POST' and r.url.endswith('/api/call') else None)
    def control(command):
        print('@@CONTROL '+command, flush=True)
        assert sys.stdin.readline().strip() == 'OK', 'Fixture coordination failed'
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
    def retained(outcome, name):
        expect(page.locator('#message')).to_contain_text('此前请求仍未确认')
        expect(page.locator('#message')).to_contain_text(outcome)
        expect(page.locator('#pending-panel')).to_be_visible()
        expect(page.locator('#pending-id')).to_contain_text(f[name]['job_id'])
        expect(page.locator('#retry')).to_be_disabled()
        expect(page.locator('#pending-job-finish')).to_be_disabled()
        expect(page.locator('#pending-job-status')).to_have_text('')
        expect(page.locator('#content')).to_have_value('BARRIER_UNSAVED_DRAFT')
    def drop(name):
        select(name)
        def intercept(route):
            if route.request.post_data_json['operation'] == 'consolidate':
                route.abort('failed')
            else:
                route.continue_()
        page.route('**/api/call', intercept)
        page.get_by_role('button', name='整理此条（调用模型）', exact=True).click()
        expect(page.locator('#message')).to_contain_text('network_unconfirmed')
        page.unroute('**/api/call', intercept)
    page.goto(origin, wait_until='networkidle')
    page.locator('#token').fill(token)
    page.locator('#login-form button').click()
    expect(page.locator('#workspace')).to_be_visible()
    page.locator('#content').fill('BARRIER_UNSAVED_DRAFT')
    select('primary')
    # Send through the real fetch. Only the application's receipt promise is lost;
    # the actual request remains in flight in the server's synthetic generator.
    page.evaluate("""job => {
      window.originalFetch=window.fetch;
      window.fetch=async (...args)=>{
        const body=JSON.parse(args[1]?.body??'{}');
        if(body.operation==='consolidate'&&body.input.job_id===job){
          window.primaryWire=window.originalFetch(...args).then(r=>r.json()).then(
            result=>{window.primaryWireResult=result;},()=>{window.primaryWireResult={wireFailed:true};});
          await new Promise(resolve=>window.losePrimaryReceipt=resolve);
          throw Error('Synthetic lost delivery to application');
        }
        return window.originalFetch(...args);
      };
    }""", f['primary']['job_id'])
    page.get_by_role('button', name='整理此条（调用模型）', exact=True).click()
    # Observe actual DB processing before losing the receipt. This is fixture-only
    # status polling, not production automatic retry or model invocation.
    for _ in range(100):
        r = context.request.post(origin+'/api/call', headers={'Origin': origin, 'Authorization': 'Bearer '+token},
                                 data={'operation': 'jobs', 'input': {'job_id': f['primary']['job_id']}})
        assert r.ok
        if r.json()['result']['jobs'][0]['state'] == 'processing':
            break
        page.wait_for_timeout(25)
    else:
        raise AssertionError('Actual processing was not reached')
    page.evaluate('window.losePrimaryReceipt()')
    expect(page.locator('#message')).to_contain_text('network_unconfirmed')
    page.evaluate('window.fetch=window.originalFetch')
    checks += 1
    inspect('processing')
    with response_for('consolidate') as response:
        page.locator('#retry').click()
    assert response.value.json()['result']['processed'] == 0
    retained('no_work', 'primary')
    checks += 1
    # A zero-call needs_model response cannot rule out the earlier live call.
    control('DISABLE')
    inspect('processing')
    with response_for('consolidate') as response:
        page.locator('#retry').click()
    assert response.value.json()['result'] == {'source_id': source,
                                              'state': 'needs_model', 'results': [], 'model_calls': 0}
    retained('needs_model', 'primary')
    with page.expect_download() as item:
        page.locator('#save-pending').click()
    text = Path(item.value.path()).read_text(encoding='utf8')
    exported = json.loads(text)
    assert token not in text and 'BARRIER_UNSAVED_DRAFT' not in text
    assert exported['delivery_unconfirmed'] is True and exported['last_processing_outcome'] == 'needs_model'
    assert exported['input'] == [c['input'] for c in calls if c['operation'] == 'consolidate'][0]
    if os.environ.get('ULTRABRAIN_BARRIER_SCREENSHOT'):
        page.screenshot(path=os.environ['ULTRABRAIN_BARRIER_SCREENSHOT'], full_page=True)
    checks += 1
    control('ENABLE'); control('RELEASE_PRIMARY')
    # Await the actual wire Promise directly. wait_for_function uses in-page eval,
    # which can be refused by this console's strict CSP. Keep the original 30s bound
    # and all result/unknown-delivery assertions; never relax CSP or resend a request.
    primary_wire_result = page.evaluate("""async () => {
      const completion=window.primaryWire;
      if(!completion || typeof completion.then!=='function')throw Error('Primary wire missing');
      let timer;
      try {
        await Promise.race([completion,new Promise((_,reject)=>{
          timer=setTimeout(()=>reject(Error('Primary wire deadline exceeded')),30000);
        })]);
        return window.primaryWireResult;
      } finally {clearTimeout(timer);}
    }""")
    assert primary_wire_result['ok'] is True
    assert primary_wire_result['result']['results'][0]['state'] == 'completed'
    expect(page.locator('#pending-panel')).to_be_visible()
    inspect('completed'); finish()
    checks += 1
    # A different live job blocks admission, even though the uncertain target is queued.
    control('START_BLOCKER'); drop('waiting'); inspect('queued')
    with response_for('consolidate') as response:
        page.locator('#retry').click()
    assert response.value.json()['result']['processed'] == 0
    retained('no_work', 'waiting')
    checks += 1
    control('RELEASE_BLOCKER'); inspect('queued')
    with response_for('consolidate') as response:
        page.locator('#retry').click()
    assert response.value.json()['result']['results'][0]['state'] == 'completed'
    expect(page.locator('#pending-panel')).to_be_hidden()
    checks += 1
    # A same-job lease_lost response still gives no current terminal outcome.
    drop('lost'); inspect('queued')
    with response_for('consolidate') as response:
        page.locator('#retry').click()
    assert response.value.json()['result']['results'][0]['state'] == 'lease_lost'
    retained('lease_lost', 'lost'); inspect('stale'); finish()
    checks += 1
    writes = [c for c in calls if c['operation'] == 'consolidate']
    assert len(writes) == 8
    for name, count in [('primary', 3), ('waiting', 3), ('lost', 2)]:
        sent = [c['input'] for c in writes if c['input']['job_id'] == f[name]['job_id']]
        assert len(sent) == count and all(body == sent[0] for body in sent)
        assert sent[0]['limit'] == 1 and sent[0]['retry'] is False
    assert not any(c['operation'] in ('capture','commit','update','review','document_read','cancel_job') for c in calls)
    expect(page.locator('#content')).to_have_value('BARRIER_UNSAVED_DRAFT')
    page.locator('#logout').click()
    expect(page.locator('#workspace')).to_be_hidden()
    assert page.evaluate('localStorage.length') == 0 and page.evaluate('sessionStorage.length') == 0
    assert not errors, 'Unexpected JavaScript error; raw content omitted'
    checks += 1
    report = {'passed': True, 'checks': checks, 'browser': 'Chromium '+browser.version,
              'processing_browser_deliveries': 8, 'dropped_before_server': 2, 'original_inflight_receipt_hidden': 1,
              'synthetic_generator_invocations_expected': 4, 'external_models': False,
              'scope': 'Real live original and competing job leases, disabled-model/no-work retries, lease-loss reconciliation; exact original request preserved'}
    if os.environ.get('ULTRABRAIN_BARRIER_REPORT'):
        Path(os.environ['ULTRABRAIN_BARRIER_REPORT']).write_text(json.dumps(report, indent=2)+'\n', encoding='utf8')
    context.close(); browser.close()
print('PASS', checks, 'real Chromium unresolved-processing barrier checks')
