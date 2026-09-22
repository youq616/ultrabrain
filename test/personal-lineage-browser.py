"""Actual console+Chromium. One isolated read-only phase and one explicit write race."""
import hashlib
import json
import os
import sys
from pathlib import Path
from playwright.sync_api import sync_playwright, expect
origin = os.environ['ULTRABRAIN_BROWSER_ORIGIN']
token = os.environ['ULTRABRAIN_BROWSER_TOKEN']
f = json.loads(os.environ['ULTRABRAIN_LINEAGE_FIXTURE'])
race = '--race' in sys.argv
checks = 0
with sync_playwright() as p:
    browser = p.chromium.launch(headless=True, args=['--no-sandbox'])
    context = browser.new_context(viewport={'width': 1320, 'height': 1050}, accept_downloads=True)
    page = context.new_page()
    errors, calls, downloads = [], [], []
    page.on('pageerror', lambda e: errors.append(str(e)))
    page.on('download', lambda d: downloads.append(d))
    page.on('request', lambda r: calls.append(r.post_data_json)
            if r.method == 'POST' and r.url.endswith('/api/call') else None)
    page.goto(origin, wait_until='networkidle')
    page.locator('#token').fill(token)
    page.locator('#login-form button').click()
    expect(page.locator('#workspace')).to_be_visible()
    page.locator('[data-view="lookup"]').click()
    expect(page.locator('#lookup-panel')).to_be_visible()
    page.wait_for_load_state('networkidle')
    page.locator('#content').fill('UNSAVED_LINEAGE_DRAFT')
    start = len(calls)

    def open_record(name):
        page.locator('#lineage-open').click()
        page.locator('#lineage-id').fill(f[name]['id'])
        expect(page.locator('#lineage-run')).to_be_disabled()
        expect(page.locator('#lineage-result')).to_be_hidden()

    def inspect(name, state=None):
        open_record(name)
        before = len(calls)
        page.locator('#lineage-consent').check()
        page.locator('#lineage-run').click()
        expected = state or name
        expect(page.locator('#lineage-status')).to_have_attribute('data-state', expected)
        if name not in ('manual', 'shared'):
            assert [c['input']['memory_id'] for c in calls[before:]] == [f[name]['id'], f[name]['input'], f[name]['id']]
        else:
            assert [c['input']['memory_id'] for c in calls[before:]] == [f[name]['id']]
        expect(page.locator('#lineage-original')).to_be_hidden()

    if race:
        # Real server write after the source read, before the final primary reread.
        writes = []
        def change_selected(route):
            body = route.request.post_data_json
            if body['operation'] != 'memory_read' or body['input']['memory_id'] != f['matched']['input']:
                route.continue_()
                return
            response = route.fetch()
            assert response.ok
            changed = page.request.post(origin+'/api/call', headers={'Origin': origin, 'Authorization': 'Bearer '+token},
                data={'operation': 'update', 'input': {'memory_id': f['matched']['id'], 'expected_revision': 1,
                      'event_id': 'lineage-explicit-browser-race',
                      'memory': {'type': 'preference', 'content': 'EXPLICIT_CONCURRENT_CORRECTION', 'provenance': 'Synthetic concurrent edit'}}})
            assert changed.ok and changed.json()['ok']
            writes.append(changed.json()['result']['revision'])
            route.fulfill(response=response)
        page.route('**/api/call', change_selected)
        open_record('matched')
        page.locator('#lineage-consent').check()
        page.locator('#lineage-run').click()
        expect(page.locator('#message')).to_contain_text('lineage_selected_changed')
        expect(page.locator('#lineage-result')).to_be_hidden()
        expect(page.locator('#lineage-original-text')).to_have_text('')
        assert writes == [2]
        expect(page.locator('#content')).to_have_value('UNSAVED_LINEAGE_DRAFT')
        assert not errors and not downloads
        print('PASS real lineage concurrent correction: changed selected record withheld, draft preserved; one explicit update')
    else:
        open_record('matched')
        assert len(calls) == start
        checks += 1
        inspect('matched')
        checks += 1
        page.locator('#lineage-show-source').click()
        text = page.locator('#lineage-original-text').inner_text()
        assert '不要使用 Docker Hub' in text
        assert page.locator('#lineage-original-text img, #lineage-memory img').count() == 0
        assert page.evaluate('typeof window.lineageInjected') == 'undefined'
        expect(page.locator('#content')).to_have_value('UNSAVED_LINEAGE_DRAFT')
        # Independently compute the quote interval and both hashes from observed rows.
        observation = page.evaluate('({m:lineageData.memory,s:lineageData.original,r:lineageData.reference})')
        d, s = observation['r'], observation['s']
        assert hashlib.sha256(s['content'].encode('utf8')).hexdigest() == d['input_hash'] == s['content_hash']
        utf16 = s['content'].encode('utf-16-le')
        assert utf16[d['start']*2:d['end']*2].decode('utf-16-le') == d['quote']
        checks += 1
        count = len(calls)
        page.locator('#lineage-clear-source').click()
        expect(page.locator('#lineage-original-text')).to_have_text('')
        assert len(calls) == count
        checks += 1
        for name, state in [('changed', 'changed'), ('archived', 'archived'), ('fragment', 'matched'), ('manual', 'unlinked'), ('shared', 'withheld')]:
            inspect(name, state)
            checks += 1
        # Corrupt only source delivery; the server still enforces the actual read boundary.
        for fault, outcome in [('wrong-id', 'memory_read_contract_changed'), ('missing', 'unavailable'), ('outage', 'network_unconfirmed')]:
            def bad_source(route):
                body = route.request.post_data_json
                if body['operation'] != 'memory_read' or body['input']['memory_id'] != f['matched']['input']:
                    route.continue_()
                    return
                response = route.fetch()
                assert response.ok
                if fault == 'missing':
                    route.fulfill(status=404, content_type='application/json', body=json.dumps({'ok': False, 'error': 'not_found', 'delivery': 'rejected'}))
                elif fault == 'outage':
                    route.abort('failed')
                else:
                    data = response.json()
                    data['result']['memory']['id'] = f['changed']['input']
                    route.fulfill(status=200, content_type='application/json', body=json.dumps(data))
            page.route('**/api/call', bad_source)
            open_record('matched')
            page.locator('#lineage-consent').check()
            page.locator('#lineage-run').click()
            if fault == 'missing':
                expect(page.locator('#lineage-status')).to_have_attribute('data-state', outcome)
                expect(page.locator('#lineage-show-source')).to_be_disabled()
            else:
                expect(page.locator('#message')).to_contain_text(outcome)
                expect(page.locator('#lineage-result')).to_be_hidden()
            expect(page.locator('#lineage-original-text')).to_have_text('')
            page.unroute('**/api/call', bad_source)
            checks += 1
        # Actual source read completed but its delivery arrives after explicit withdrawal.
        def revoke_late(route):
            body = route.request.post_data_json
            if body['operation'] != 'memory_read' or body['input']['memory_id'] != f['matched']['input']:
                route.continue_()
                return
            response = route.fetch()
            assert response.ok
            page.locator('#lineage-consent').uncheck()
            route.fulfill(response=response)
        page.route('**/api/call', revoke_late)
        open_record('matched')
        count = len(calls)
        page.locator('#lineage-consent').check()
        page.locator('#lineage-run').click()
        expect(page.locator('#lineage-consent')).not_to_be_checked()
        expect(page.locator('#lineage-result')).to_be_hidden()
        assert len(calls) == count+2
        page.unroute('**/api/call', revoke_late)
        checks += 1
        inspect('matched')
        page.evaluate("document.getElementById('lineage-id').value='00000000-0000-4000-8000-000000000000'")
        page.locator('#lineage-show-source').click()
        expect(page.locator('#lineage-original-text')).to_have_text('')
        expect(page.locator('#lineage-result')).to_be_hidden()
        checks += 1
        inspect('matched')
        page.locator('#lineage-open-source').click()
        expect(page.locator('#message')).to_contain_text('记录已核对')
        expect(page.locator('#lookup-id')).to_have_value(f['matched']['input'])
        expect(page.locator('#content')).to_have_value('UNSAVED_LINEAGE_DRAFT')
        expect(page.locator('#lineage-panel')).to_be_hidden()
        checks += 1
        # Independent P2: a verified local file may already exist while lineage is open.
        # Prepare via the genuine inspector UI, not by injecting a fake checked handle.
        count = len(calls)
        page.locator('#inspector-open').click()
        page.locator('#inspector-left').set_input_files(os.environ['ULTRABRAIN_LINEAGE_SNAPSHOT'])
        expect(page.locator('#explorer-open')).to_be_disabled()
        page.locator('#inspector-consent').check()
        page.locator('#inspector-run').click()
        expect(page.locator('#message')).to_contain_text('内部一致性核验通过')
        expect(page.locator('#explorer-open')).to_be_enabled()
        assert len(calls) == count, 'Local file preparation must not query the server'
        checks += 1

        def source_cleared():
            expect(page.locator('#lineage-panel')).to_be_hidden()
            expect(page.locator('#lineage-result')).to_be_hidden()
            expect(page.locator('#lineage-original')).to_be_hidden()
            expect(page.locator('#lineage-consent')).not_to_be_checked()
            expect(page.locator('#lineage-id')).to_have_value('')
            for ident in ('lineage-status', 'lineage-memory', 'lineage-quote', 'lineage-metadata', 'lineage-original-text'):
                expect(page.locator('#'+ident)).to_have_text('')
            assert page.evaluate('lineageData===null && lineageController===null && lineageWorking===false')
            expect(page.locator('#content')).to_have_value('UNSAVED_LINEAGE_DRAFT')

        inspect('matched')
        page.locator('#lineage-show-source').click()
        expect(page.locator('#lineage-original-text')).to_contain_text('不要使用 Docker Hub')
        context_before = page.evaluate('({view,loadVersion})')
        count = len(calls)
        page.locator('#explorer-open').click()
        source_cleared()
        assert page.evaluate('({view,loadVersion})') == context_before
        expect(page.locator('#explorer-panel')).to_be_visible()
        expect(page.locator('#explorer-consent')).not_to_be_checked()
        assert page.evaluate('inspectorData!==null'), 'Independent verified local file must be retained'
        assert len(calls) == count
        checks += 1

        # Also leave during an actual server source read: cancellation must stop the
        # final primary reread, even when its successful response was already buffered.
        def open_explorer_late(route):
            body = route.request.post_data_json
            if body['operation'] != 'memory_read' or body['input']['memory_id'] != f['matched']['input']:
                route.continue_()
                return
            response = route.fetch()
            assert response.ok
            page.locator('#explorer-open').click()
            source_cleared()
            page.evaluate("document.getElementById('message').textContent='EXPLORER_CURRENT_MESSAGE'")
            route.fulfill(response=response)
        open_record('matched')
        page.route('**/api/call', open_explorer_late)
        count = len(calls)
        page.locator('#lineage-consent').check()
        page.locator('#lineage-run').click()
        expect(page.locator('#message')).to_have_text('EXPLORER_CURRENT_MESSAGE')
        page.wait_for_load_state('networkidle')
        source_cleared()
        assert len(calls) == count+2, 'Revoked lineage must not follow with a third read'
        page.unroute('**/api/call', open_explorer_late)
        checks += 1

        # File browsing remains usable, but reopening lineage never renews its consent.
        page.locator('#explorer-consent').check()
        page.locator('#explorer-run').click()
        expect(page.locator('#explorer-summary')).to_contain_text('仅本地快照')
        count = len(calls)
        open_record('matched')
        expect(page.locator('#lineage-consent')).not_to_be_checked()
        assert len(calls) == count
        checks += 1
        inspect('matched')
        page.locator('#lineage-show-source').click()
        page.set_viewport_size({'width': 390, 'height': 844})
        assert page.evaluate('document.documentElement.scrollWidth <= window.innerWidth')
        page.set_viewport_size({'width': 1320, 'height': 1050})
        if os.environ.get('ULTRABRAIN_LINEAGE_SCREENSHOT'):
            page.locator('#lineage-panel').screenshot(path=os.environ['ULTRABRAIN_LINEAGE_SCREENSHOT'])
        page.locator('#logout').click()
        expect(page.locator('#lineage-original-text')).to_have_text('')
        expect(page.locator('#lineage-panel')).to_be_hidden()
        assert page.evaluate('lineageData===null')
        assert page.evaluate('localStorage.length===0 && sessionStorage.length===0')
        assert not errors and not downloads
        assert all(c['operation'] == 'memory_read' for c in calls[start:])
        checks += 1
        report = {'passed': True, 'checks': checks, 'browser': 'Chromium '+browser.version,
                  'operations_after_setup': ['memory_read'], 'downloads': 0, 'model_calls': 0,
                  'workspace_revocation_checks': 4,
                  'scope': 'Real console/PostgreSQL source inspection; read-only phase including verified-file workspace transitions; concurrency write phase reported separately'}
        if os.environ.get('ULTRABRAIN_LINEAGE_REPORT'):
            Path(os.environ['ULTRABRAIN_LINEAGE_REPORT']).write_text(json.dumps(report, indent=2)+'\n', encoding='utf8')
        print('PASS', checks, 'real Chromium lineage read-only checks')
    context.close()
    browser.close()
