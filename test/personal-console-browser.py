"""Real Chromium interaction with synthetic data. Never read user browser profiles or chats."""
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
    errors = []
    page.on('pageerror', lambda error: errors.append(str(error)))
    page.on('dialog', lambda dialog: dialog.accept())
    page.goto(origin, wait_until='networkidle')
    expect(page.locator('#login')).to_be_visible()
    expect(page.locator('#workspace')).to_be_hidden()
    assert page.evaluate("fetch('/api/call',{method:'POST',headers:{'Content-Type':'application/json'},body:'{\"operation\":\"info\"}'}).then(r=>r.status)") == 401
    passed()
    page.locator('#token').fill(token)
    page.locator('#login-form button').click()
    expect(page.locator('#workspace')).to_be_visible()
    expect(page.locator('#results')).to_contain_text('没有可见记录')
    passed()
    malicious = '<img src=x onerror="window.consoleInjected=1"> 合成偏好：请保留否定词，不使用 Docker Hub。'
    page.locator('#content').fill(malicious)
    page.locator('#importance').select_option('high')
    page.locator('#save').click()
    expect(page.locator('#message')).to_contain_text('必须明确同意')
    expect(page.locator('#results article')).to_have_count(0)
    passed()
    page.locator('#consent').check()
    page.locator('#save').click()
    expect(page.locator('#results article')).to_have_count(1)
    expect(page.locator('.memory-content')).to_have_text(malicious)
    assert page.locator('#results img').count() == 0
    assert page.evaluate('typeof window.consoleInjected') == 'undefined'
    passed()
    page.get_by_role('button', name='确认启用', exact=True).click()
    expect(page.locator('#results article')).to_have_count(0)
    page.locator('[data-view="profile"]').click()
    expect(page.locator('.memory-content')).to_have_text(malicious)
    passed()
    page.get_by_role('button', name='编辑', exact=True).click()
    page.locator('#content').fill('合成偏好：修改后需要重新确认。')
    page.locator('#consent').check()
    page.locator('#save').click()
    expect(page.locator('#message')).to_contain_text('操作已确认')
    expect(page.locator('#results article')).to_have_count(0)
    page.locator('[data-view="candidate"]').click()
    expect(page.locator('.memory-content')).to_have_text('合成偏好：修改后需要重新确认。')
    passed()
    # Intervene through the real API after the editor captured a revision.
    page.get_by_role('button', name='编辑', exact=True).click()
    concurrent = page.evaluate("""async ({token}) => {
      const call = async (operation,input) => (await fetch('/api/call', {method:'POST', headers:{'Content-Type':'application/json', Authorization:'Bearer '+token}, body:JSON.stringify({operation,input})})).json();
      const rows = await call('search',{status:'candidate'});
      const row=rows.result.memories[0];
      return call('review',{memory_id:row.id,expected_revision:row.revision,event_id:'browser-concurrent-review',status:'active'});
    }""", {'token': token})
    assert concurrent['ok'] is True
    page.locator('#content').fill('这个过时的编辑不能覆盖已确认版本')
    page.locator('#consent').check()
    page.locator('#save').click()
    expect(page.locator('#message')).to_contain_text('revision_conflict')
    page.locator('[data-view="active"]').click()
    expect(page.locator('.memory-content')).to_have_text('合成偏好：修改后需要重新确认。')
    passed()
    page.get_by_role('button', name='归档', exact=True).click()
    expect(page.locator('#results article')).to_have_count(0)
    page.locator('[data-view="archived"]').click()
    expect(page.locator('#results article')).to_have_count(1)
    passed()
    with page.expect_download() as item:
        page.locator('#export').click()
    download = item.value
    exported = json.loads(Path(download.path()).read_text(encoding='utf8'))
    assert exported['complete'] is False
    assert len(exported['result']['memories']) == 1
    assert token not in json.dumps(exported)
    passed()
    page.locator('[data-view="agents"]').click()
    expect(page.locator('#results')).to_contain_text('personal-console')
    passed()
    page.locator('[data-view="archived"]').click()
    expect(page.locator('#results article')).to_have_count(1)
    if os.environ.get('ULTRABRAIN_BROWSER_SCREENSHOT'):
        page.screenshot(path=os.environ['ULTRABRAIN_BROWSER_SCREENSHOT'], full_page=True)
    # Drop the response only after the real server committed it; retry must reuse the event.
    page.locator('[data-view="candidate"]').click()
    expect(page.locator('#results article')).to_have_count(0)
    page.locator('#content').fill('合成网络重试：只保存一次，不改变事件编号。')
    page.locator('#consent').check()
    attempts = []
    def interrupt_ack(route):
        body = route.request.post_data_json
        if body.get('operation') == 'commit':
            attempts.append(body['input']['event_id'])
            if len(attempts) == 1:
                response = route.fetch()
                assert response.ok, 'Synthetic commit failed before response interruption'
                route.abort('failed')
                return
        route.continue_()
    page.route('**/api/call', interrupt_ack)
    page.locator('#save').click()
    expect(page.locator('#pending-panel')).to_be_visible()
    expect(page.locator('#save')).to_be_disabled()
    page.locator('#retry').click()
    expect(page.locator('#pending-panel')).to_be_hidden()
    expect(page.locator('#results article')).to_have_count(1)
    assert len(attempts) == 2 and attempts[0] == attempts[1]
    page.unroute('**/api/call', interrupt_ack)
    passed()
    page.locator('#logout').click()
    expect(page.locator('#workspace')).to_be_hidden()
    assert page.evaluate('localStorage.length') == 0
    assert page.evaluate('sessionStorage.length') == 0
    page.reload()
    expect(page.locator('#login')).to_be_visible()
    expect(page.locator('#token')).to_have_value('')
    passed()
    assert not errors, 'Unexpected browser JavaScript error (raw text omitted)'
    passed()
    browser_version = browser.version
    context.close()
    browser.close()

report = {'passed': True, 'checks': checks, 'browser': 'Chromium ' + browser_version,
          'scope': 'Synthetic real browser/API interactions, not a user deployment or model-quality test'}
if os.environ.get('ULTRABRAIN_BROWSER_REPORT'):
    Path(os.environ['ULTRABRAIN_BROWSER_REPORT']).write_text(json.dumps(report, indent=2) + '\n', encoding='utf8')
print('PASS', checks, 'real Chromium personal-console checks')
