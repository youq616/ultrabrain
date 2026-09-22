"""Real UI correction after an intervening edit. Isolated source and synthetic data only."""
import json
import os
from pathlib import Path
from playwright.sync_api import sync_playwright, expect
origin, token, memory_id = (os.environ[k] for k in ('ULTRABRAIN_BROWSER_ORIGIN', 'ULTRABRAIN_BROWSER_TOKEN', 'ULTRABRAIN_BROWSER_MEMORY_ID'))
checks = 0
with sync_playwright() as p:
    browser = p.chromium.launch(headless=True, args=['--no-sandbox'])
    context = browser.new_context(viewport={'width': 1320, 'height': 1050})
    page = context.new_page()
    errors, calls = [], []
    page.on('pageerror', lambda e: errors.append(str(e)))
    page.on('dialog', lambda d: d.accept())
    def record(request):
        if request.method == 'POST' and request.url.endswith('/api/call'):
            calls.append(request.post_data_json)
    page.on('request', record)
    def api(operation, data):
        r = context.request.post(origin + '/api/call', headers={'Origin': origin, 'Authorization': 'Bearer ' + token}, data={'operation': operation, 'input': data})
        assert r.ok, 'Disposable fixture API operation failed (raw data omitted)'
        return r.json()['result']
    def read():
        return api('memory_read', {'memory_id': memory_id})['memory']
    page.goto(origin, wait_until='networkidle')
    page.locator('#token').fill(token)
    page.locator('#login-form button').click()
    expect(page.locator('#workspace')).to_be_visible()
    page.locator('[data-view="recall"]').click()
    page.locator('#recall-task').fill('LOOKUP_BEFORE')
    page.locator('#recall-consent').check()
    page.locator('#recall-submit').click()
    card = page.locator('#results article').filter(has_text='LOOKUP_BEFORE')
    expect(card).to_have_count(1)
    # Another explicit synthetic actor action changes the real DB AFTER the preview.
    api('update', {'memory_id': memory_id, 'expected_revision': 2, 'event_id': 'lookup-intervening',
                   'memory': {'type': 'preference', 'content': 'LOOKUP_INTERVENING', 'provenance': 'Synthetic intervening edit', 'confidence': 0.4}})
    card.locator('[data-read]').click()
    expect(page.locator('#message')).to_contain_text('记录已核对')
    expect(page.locator('#results')).to_contain_text('LOOKUP_INTERVENING')
    expect(page.locator('#results')).not_to_contain_text('LOOKUP_BEFORE')
    expect(page.locator('#coverage')).to_contain_text('r3')
    expect(page.locator('#results')).to_contain_text('candidate')
    checks += 1
    page.locator('#results button', has_text='编辑').click()
    expect(page.locator('#content')).to_have_value('LOOKUP_INTERVENING')
    expect(page.locator('#consent')).not_to_be_checked()
    page.locator('#content').fill('LOOKUP_USER_CORRECTED')
    page.locator('#consent').check()
    page.locator('#save').click()
    expect(page.locator('#message')).to_contain_text('操作已确认')
    update = [c for c in calls if c['operation'] == 'update'][-1]
    assert update['input']['memory_id'] == memory_id and update['input']['expected_revision'] == 3
    result = read()
    assert result['revision'] == 4 and result['status'] == 'candidate' and result['content'] == 'LOOKUP_USER_CORRECTED'
    checks += 1
    # Confirmation stays an explicit existing revision-checked action, not lookup side effect.
    page.locator('#lookup-submit').click()
    expect(page.locator('#coverage')).to_contain_text('r4')
    page.locator('#results button', has_text='确认启用').click()
    expect(page.locator('#message')).to_contain_text('操作已确认')
    assert read()['status'] == 'active' and read()['revision'] == 5
    checks += 1
    page.locator('#lookup-submit').click()
    expect(page.locator('#coverage')).to_contain_text('r5')
    page.locator('#results button', has_text='编辑').click()
    api('update', {'memory_id': memory_id, 'expected_revision': 5, 'event_id': 'lookup-concurrent',
                   'memory': {'type': 'preference', 'content': 'LOOKUP_CONCURRENT', 'provenance': 'Synthetic concurrent edit', 'confidence': 0.9}})
    page.locator('#content').fill('LOOKUP_STALE_EDIT')
    page.locator('#consent').check()
    page.locator('#save').click()
    expect(page.locator('#message')).to_contain_text('revision_conflict')
    result = read()
    assert result['revision'] == 6 and result['status'] == 'candidate' and result['content'] == 'LOOKUP_CONCURRENT'
    assert len([c for c in calls if c['operation'] == 'update']) == 2
    checks += 1
    # A read does not silently replace the user's unsaved editor; editing is another click.
    page.locator('#lookup-submit').click()
    expect(page.locator('#coverage')).to_contain_text('r6')
    expect(page.locator('#content')).to_have_value('LOOKUP_STALE_EDIT')
    # Explicit read -> three-way comparison -> local baseline adoption, still no write.
    page.locator('#provenance').fill('Explicit synthetic manual reconciliation')
    before_comparison = read()
    page.locator('#compare-current').click()
    expect(page.locator('#comparison-panel')).to_be_visible()
    expect(page.locator('#comparison-original')).to_contain_text('LOOKUP_USER_CORRECTED')
    expect(page.locator('#comparison-latest')).to_contain_text('LOOKUP_CONCURRENT')
    expect(page.locator('#comparison-draft')).to_contain_text('LOOKUP_STALE_EDIT')
    expect(page.locator('#comparison-draft')).to_contain_text('0.4')
    expect(page.locator('#comparison-latest')).to_contain_text('0.9')
    expect(page.locator('#editor-title')).to_contain_text('r5')
    expect(page.locator('#comparison-adopt')).to_be_disabled()
    assert read() == before_comparison, 'Comparison mutated the real memory'
    if os.environ.get('ULTRABRAIN_COMPARISON_SCREENSHOT'):
        page.screenshot(path=os.environ['ULTRABRAIN_COMPARISON_SCREENSHOT'], full_page=True)
    page.set_viewport_size({'width': 390, 'height': 844})
    assert page.evaluate('document.documentElement.scrollWidth <= window.innerWidth')
    page.set_viewport_size({'width': 1320, 'height': 1050})
    checks += 1
    page.locator('#comparison-consent').check()
    page.locator('#comparison-adopt').click()
    expect(page.locator('#editor-title')).to_contain_text('r6')
    expect(page.locator('#content')).to_have_value('LOOKUP_STALE_EDIT')
    expect(page.locator('#consent')).not_to_be_checked()
    expect(page.locator('#comparison-panel')).to_be_hidden()
    assert read() == before_comparison
    assert len([c for c in calls if c['operation'] == 'update']) == 2
    checks += 1
    # Adoption is not a lease: another edit after comparison must still reject a stale save.
    api('update', {'memory_id': memory_id, 'expected_revision': 6, 'event_id': 'lookup-second-concurrent',
                   'memory': {'type': 'preference', 'content': 'LOOKUP_SECOND_CONCURRENT', 'confidence': 0.7,
                              'provenance': 'Synthetic second concurrent edit'}})
    page.locator('#consent').check()
    page.locator('#save').click()
    expect(page.locator('#message')).to_contain_text('revision_conflict')
    result = read()
    assert result['revision'] == 7 and result['content'] == 'LOOKUP_SECOND_CONCURRENT'
    expect(page.locator('#content')).to_have_value('LOOKUP_STALE_EDIT')
    checks += 1
    # The user manually composes the final draft BEFORE the next comparison.
    page.locator('#content').fill('LOOKUP_MANUAL_MERGE')
    page.locator('#compare-current').click()
    expect(page.locator('#comparison-latest')).to_contain_text('LOOKUP_SECOND_CONCURRENT')
    expect(page.locator('#comparison-draft')).to_contain_text('LOOKUP_MANUAL_MERGE')
    expect(page.locator('#comparison-draft')).to_contain_text('0.4')
    page.locator('#comparison-consent').check()
    page.locator('#comparison-adopt').click()
    expect(page.locator('#editor-title')).to_contain_text('r7')
    page.locator('#consent').check()
    page.locator('#save').click()
    expect(page.locator('#message')).to_contain_text('操作已确认')
    result = read()
    assert result['revision'] == 8 and result['status'] == 'candidate' and result['content'] == 'LOOKUP_MANUAL_MERGE'
    assert result['confidence'] == 0.4 and result['provenance'] == 'Explicit synthetic manual reconciliation'
    assert [c['input']['expected_revision'] for c in calls if c['operation'] == 'update'] == [3, 5, 6, 7]
    checks += 1
    page.locator('#lookup-submit').click()
    expect(page.locator('#coverage')).to_contain_text('r8')
    page.locator('#results button', has_text='编辑').click()
    # Cancelling a real read before browser delivery keeps the independent draft intact.
    def cancel_comparison(route):
        if route.request.post_data_json.get('operation') != 'memory_read':
            route.continue_(); return
        response = route.fetch()
        assert response.ok
        page.locator('#comparison-cancel').click()
        route.fulfill(response=response)
    page.route('**/api/call', cancel_comparison)
    page.locator('#compare-current').click()
    expect(page.locator('#message')).to_contain_text('对照已清除')
    expect(page.locator('#comparison-panel')).to_be_hidden()
    expect(page.locator('#content')).to_have_value('LOOKUP_MANUAL_MERGE')
    page.unroute('**/api/call', cancel_comparison)
    checks += 1
    page.locator('#compare-current').click()
    expect(page.locator('#comparison-note')).to_contain_text('版本未变化')
    page.locator('#comparison-consent').check()
    expect(page.locator('#comparison-adopt')).to_be_disabled()
    assert read()['revision'] == 8
    page.locator('#cancel-edit').click()
    if os.environ.get('ULTRABRAIN_BROWSER_SCREENSHOT'):
        page.screenshot(path=os.environ['ULTRABRAIN_BROWSER_SCREENSHOT'], full_page=True)
    checks += 1
    def delayed(route):
        if route.request.post_data_json.get('operation') != 'memory_read':
            route.continue_(); return
        response = route.fetch()
        assert response.ok
        page.locator('#logout').click()
        route.fulfill(response=response)
    page.route('**/api/call', delayed)
    page.locator('#lookup-submit').click()
    expect(page.locator('#workspace')).to_be_hidden()
    expect(page.locator('#lookup-id')).to_have_value('')
    expect(page.locator('#content')).to_have_value('')
    expect(page.locator('#results article')).to_have_count(0)
    expect(page.locator('#comparison-latest')).to_have_text('')
    assert not errors, 'Unexpected browser error (content omitted)'
    checks += 1
    report = {'passed': True, 'checks': checks, 'browser': 'Chromium ' + browser.version,
              'scope': 'Synthetic explicit editor writes: fresh exact read, edit, candidate, confirmation, stale CAS rejection, explicit three-way comparison/adoption, repeated concurrent rejection, draft/confidence preservation, late-read lock; not model quality'}
    if os.environ.get('ULTRABRAIN_BROWSER_REPORT'):
        Path(os.environ['ULTRABRAIN_BROWSER_REPORT']).write_text(json.dumps(report, indent=2) + '\n', encoding='utf8')
    context.close()
    browser.close()
print('PASS', checks, 'real Chromium lookup/correction checks; explicit synthetic writes only')
