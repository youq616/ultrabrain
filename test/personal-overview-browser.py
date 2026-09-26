"""Production UI in Chromium. --offline uses synthetic transport, not a live DB/server.
The normal CI mode uses an actual loopback console and prepared PostgreSQL fixture.
"""
import base64
import json
import os
import sys
from pathlib import Path
from playwright.sync_api import sync_playwright, expect

root = Path(__file__).resolve().parent.parent
offline = '--offline' in sys.argv
synthetic_http = '--synthetic-http' in sys.argv
assert not (offline and synthetic_http), 'Select one transport evidence mode'
checks = 0
with sync_playwright() as p:
    options = {'headless': True, 'args': ['--no-sandbox']}
    if os.environ.get('ULTRABRAIN_CHROMIUM'):
        options['executable_path'] = os.environ['ULTRABRAIN_CHROMIUM']
    browser = p.chromium.launch(**options)
    context = browser.new_context(viewport={'width': 1320, 'height': 1000})
    page = context.new_page()
    errors, downloads = [], []
    page.on('pageerror', lambda e: errors.append(str(e)))
    page.on('download', lambda d: downloads.append(d))
    if offline:
        import re
        html = (root / 'web/personal/index.html').read_text()
        scripts = re.findall(r'<script src="/([a-z-]+\.js)" defer></script>', html)
        assert scripts == ['app.js', 'snapshot-ui.js', 'snapshot-inspector-ui.js', 'snapshot-explorer-ui.js',
                           'snapshot-duplicates-ui.js', 'lineage-ui.js', 'overview-ui.js'], 'Load all production scripts in order'
        html = re.sub(r'<script[^>]*>.*?</script>', '', html)
        html = re.sub(r'<link[^>]*>', '', html)
        page.set_content(html)
        page.add_style_tag(content=(root / 'web/personal/style.css').read_text())
        for script in scripts:
            page.add_script_tag(content=(root / 'web/personal' / script).read_text())
        module = 'data:text/javascript;base64,' + base64.b64encode((root/'src/personal-overview-contract.mjs').read_bytes()).decode()
        expected = json.loads(os.environ['ULTRABRAIN_OVERVIEW_EXPECTED'])
        page.evaluate('''async ({module,expected})=>{
          globalThis.overviewContract=await import(module);
          loadOverviewContract=async()=>overviewContract;
          sourceId='selected';token='SYNTHETIC_TOKEN';view='lookup';
          document.getElementById('workspace').hidden=false;document.getElementById('login').hidden=true;
          globalThis.overviewWire=[];globalThis.overviewExpected=expected;globalThis.overviewFault=null;
          // about:blank is an opaque test context, unlike the real secure loopback
          // page. Supply ONLY request UUIDs when this context lacks randomUUID.
          if(typeof crypto.randomUUID!=='function'){
            let serial=0;crypto.randomUUID=()=>String(++serial).padStart(8,'0')+'-1111-4111-8111-111111111111';
          }
          globalThis.fetch=async(url,options)=>{
            const body=JSON.parse(options.body);overviewWire.push(body);
            if(body.operation!=='overview')throw Error('Unexpected synthetic operation');
            const result=structuredClone(overviewExpected);result.request_id=body.input.request_id;
            if(overviewFault==='bad-count')result.memories.total++;
            if(overviewFault==='bad-source')result.source_id='other';
            if(overviewFault==='late'){await new Promise(r=>globalThis.releaseOverview=r);}
            if(overviewFault==='error')throw Error('PRIVATE_REMOTE_ERROR');
            return {ok:true,status:200,json:async()=>({ok:true,result})};
          };
        }''', {'module': module, 'expected': expected})
        calls = lambda: page.evaluate('overviewWire')
    else:
        origin, token = os.environ['ULTRABRAIN_BROWSER_ORIGIN'], os.environ['ULTRABRAIN_BROWSER_TOKEN']
        captured = []
        page.on('request', lambda r: captured.append(r.post_data_json)
                if r.method == 'POST' and r.url.endswith('/api/call') else None)
        page.goto(origin, wait_until='networkidle')
        page.locator('#token').fill(token)
        page.locator('#login-form button').click()
        expect(page.locator('#workspace')).to_be_visible()
        page.locator('[data-view="lookup"]').click()
        page.wait_for_load_state('networkidle')
        setup_calls = len(captured)
        calls = lambda: captured[setup_calls:]
        expected = json.loads(os.environ['ULTRABRAIN_OVERVIEW_EXPECTED'])
    page.locator('#content').fill('OVERVIEW_UNSAVED_DRAFT')
    page.locator('#overview-open').click()
    expect(page.locator('#overview-panel')).to_be_visible()
    expect(page.locator('#overview-cards article')).to_have_count(0)
    assert not calls()
    checks += 1

    def read():
        page.locator('#overview-run').click()
        expect(page.locator('#message')).to_contain_text('运行概览已读取')
        expect(page.locator('#overview-cards article')).to_have_count(4)

    read()
    assert len(calls()) == 1
    for group, position in [('memories', 0), ('jobs', 1), ('documents', 2), ('agents', 3)]:
        card = page.locator('#overview-cards article').nth(position)
        for key, value in expected[group].items():
            assert card.locator('[data-metric="'+key+'"]').inner_text().endswith('：'+str(value))
    assert page.evaluate('overviewData.read_only && overviewData.model_calls===0')
    expect(page.locator('#content')).to_have_value('OVERVIEW_UNSAVED_DRAFT')
    checks += 1
    # Displayed observations grant no execution authority, and reveal no body.
    assert all(c['operation'] == 'overview' and list(c['input']) == ['request_id'] for c in calls())
    assert not any(word in page.locator('#overview-cards').inner_text() for word in ('PRIVATE_ORIGINAL', 'PRIVATE_CANDIDATE'))
    expect(page.locator('#overview-jobs')).to_be_enabled()
    checks += 1
    first = calls()[0]['input']['request_id']
    page.locator('#overview-run').click()
    expect(page.locator('#overview-cards article')).to_have_count(4)
    assert len(calls()) == 2 and calls()[1]['input']['request_id'] != first
    checks += 1
    # Damage real/synthetic transport responses; never manufacture successful emptiness.
    for fault in ('bad-count', 'bad-source', 'error'):
        if offline:
            page.evaluate('fault=>overviewFault=fault', fault)
        else:
            def corrupt(route):
                body = route.request.post_data_json
                if body['operation'] != 'overview':
                    route.continue_(); return
                response = route.fetch()
                assert response.ok
                if fault == 'error':
                    route.abort('failed'); return
                data = response.json()
                if fault == 'bad-count':
                    data['result']['memories']['total'] += 1
                else:
                    data['result']['source_id'] = 'other'
                route.fulfill(status=200, content_type='application/json', body=json.dumps(data))
            page.route('**/api/call', corrupt)
        page.locator('#overview-run').click()
        expect(page.locator('#overview-notice')).to_contain_text('未确认')
        expect(page.locator('#overview-cards article')).to_have_count(0)
        expect(page.locator('#overview-jobs')).to_be_disabled()
        assert 'PRIVATE_REMOTE_ERROR' not in page.locator('#message').inner_text()
        if not offline:
            page.unroute('**/api/call', corrupt)
        checks += 1
    if offline:
        page.evaluate('overviewFault=null')
    read()
    # Revocation before the pending response is delivered: no restoration of counts.
    if offline:
        page.evaluate('overviewFault="late"')
        page.locator('#overview-run').click()
        page.locator('#overview-close').click()
        page.evaluate('releaseOverview()')
        page.evaluate('overviewFault=null')
    else:
        def clear_late(route):
            response = route.fetch()
            assert response.ok
            page.locator('#overview-close').click()
            route.fulfill(response=response)
        page.route('**/api/call', clear_late)
        page.locator('#overview-run').click()
        expect(page.locator('#overview-panel')).to_be_hidden()
        page.unroute('**/api/call', clear_late)
    expect(page.locator('#overview-panel')).to_be_hidden()
    assert page.evaluate('overviewData===null && overviewController===null')
    expect(page.locator('#overview-cards article')).to_have_count(0)
    checks += 1
    page.locator('#overview-open').click()
    read()
    page.set_viewport_size({'width': 390, 'height': 844})
    assert page.evaluate('document.documentElement.scrollWidth <= innerWidth')
    page.set_viewport_size({'width': 1320, 'height': 1000})
    if os.environ.get('ULTRABRAIN_OVERVIEW_SCREENSHOT'):
        page.locator('#overview-panel').screenshot(path=os.environ['ULTRABRAIN_OVERVIEW_SCREENSHOT'])
    checks += 1
    before = len(calls())
    page.locator('#overview-close').click()
    assert len(calls()) == before
    expect(page.locator('#content')).to_have_value('OVERVIEW_UNSAVED_DRAFT')
    assert page.evaluate('pending===null')
    assert page.evaluate('localStorage.length===0 && sessionStorage.length===0') if not offline else True
    assert not errors and not downloads
    checks += 1
    report = {'passed': True, 'checks': checks, 'browser': 'Chromium '+browser.version,
              'mode': 'offline production DOM/scripts, synthetic transport and counts; NOT real PostgreSQL or HTTP' if offline else 'real console HTTP/CSP and Chromium; synthetic database, NOT PostgreSQL' if synthetic_http else 'real PostgreSQL and console HTTP',
              'data_operations': ['overview'], 'model_calls': 0, 'downloads': 0}
    if os.environ.get('ULTRABRAIN_OVERVIEW_REPORT'):
        Path(os.environ['ULTRABRAIN_OVERVIEW_REPORT']).write_text(json.dumps(report, indent=2)+'\n')
    context.close(); browser.close()
print('PASS', checks, 'Chromium overview checks; mode:', report['mode'])
