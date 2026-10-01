"""Real Chromium against the production authenticated console; server rows are synthetic."""
import os
from pathlib import Path
from playwright.sync_api import sync_playwright, expect

left = '11111111-1111-4111-8111-111111111111'
right = '22222222-2222-4222-8222-222222222222'
missing = '44444444-4444-4444-8444-444444444444'
checks = 0
with sync_playwright() as p:
    options = {'headless': True, 'args': ['--no-sandbox']}
    if os.environ.get('ULTRABRAIN_CHROMIUM'):
        options['executable_path'] = os.environ['ULTRABRAIN_CHROMIUM']
    browser = p.chromium.launch(**options)
    context = browser.new_context(viewport={'width': 1380, 'height': 1100})
    page = context.new_page()
    errors, calls, downloads = [], [], []
    page.on('pageerror', lambda error: errors.append(str(error)))
    page.on('request', lambda req: calls.append(req.post_data_json) if req.method == 'POST' and req.url.endswith('/api/call') else None)
    page.on('download', lambda download: downloads.append(download))
    page.goto(os.environ['ULTRABRAIN_BROWSER_ORIGIN'], wait_until='networkidle')
    page.locator('#token').fill(os.environ['ULTRABRAIN_BROWSER_TOKEN'])
    page.locator('#login-form button').click()
    expect(page.locator('#workspace')).to_be_visible()
    page.wait_for_load_state('networkidle')
    page.locator('#content').fill('UNSAVED PAIR REVIEW DRAFT')
    before = len(calls)
    page.locator('[data-view="pair"]').click()
    expect(page.locator('#pair-panel')).to_be_visible()
    assert len(calls) == before
    page.locator('#pair-left').fill(left)
    page.locator('#pair-right').fill(right)
    assert len(calls) == before
    checks += 1

    def read_pair():
        page.locator('#pair-read').click()
        expect(page.locator('#pair-results article')).to_have_count(2)
        expect(page.locator('#message')).to_contain_text('两条记录已读取')

    read_pair()
    pair_calls = calls[before:]
    assert pair_calls == [{'operation': 'memory_read', 'input': {'memory_id': value}} for value in (left, right)]
    expect(page.locator('#pair-results article').nth(0)).to_contain_text('r1 · active')
    expect(page.locator('#pair-results article').nth(1)).to_contain_text('r1 · candidate')
    expect(page.locator('#pair-results article').nth(0)).to_contain_text('<b>plain text</b>')
    expect(page.locator('#pair-results b')).to_have_count(0)
    expect(page.locator('#pair-results article').nth(1)).to_contain_text('Detailed technical reviews')
    expect(page.locator('#pair-summary')).to_contain_text('不是同一时刻')
    expect(page.locator('#content')).to_have_value('UNSAVED PAIR REVIEW DRAFT')
    assert page.evaluate("document.querySelectorAll('#pair-results [data-write]').length") == 0
    assert page.evaluate('localStorage.length + sessionStorage.length') == 0
    checks += 1

    # Side-by-side desktop, stacked narrow viewport; save only synthetic screenshots.
    rectangles = page.locator('#pair-results article').evaluate_all('(nodes)=>nodes.map(n=>({x:n.getBoundingClientRect().x,y:n.getBoundingClientRect().y}))')
    assert rectangles[0]['y'] == rectangles[1]['y'] and rectangles[1]['x'] > rectangles[0]['x']
    output = os.environ.get('ULTRABRAIN_PAIR_SCREENSHOTS')
    if output:
        Path(output).mkdir(parents=True, exist_ok=True)
        page.screenshot(path=str(Path(output) / 'manual-pair-desktop.png'), full_page=True)
    page.set_viewport_size({'width': 430, 'height': 960})
    rectangles = page.locator('#pair-results article').evaluate_all('(nodes)=>nodes.map(n=>({x:n.getBoundingClientRect().x,y:n.getBoundingClientRect().y}))')
    assert rectangles[1]['y'] > rectangles[0]['y'] and rectangles[1]['x'] == rectangles[0]['x']
    assert page.evaluate('document.documentElement.scrollWidth <= innerWidth')
    if output:
        page.screenshot(path=str(Path(output) / 'manual-pair-mobile.png'), full_page=True)
    page.set_viewport_size({'width': 1380, 'height': 1100})
    checks += 1

    read_pair()
    expect(page.locator('#pair-results article').nth(0)).to_contain_text('r2 · active')
    page.locator('#pair-results article').nth(0).get_by_role('button').click()
    expect(page.locator('#lookup-panel')).to_be_visible()
    expect(page.locator('#results')).to_contain_text('r3')
    expect(page.locator('#content')).to_have_value('UNSAVED PAIR REVIEW DRAFT')
    assert page.evaluate('editing') is None
    expect(page.locator('#pair-results article')).to_have_count(0)
    checks += 1

    page.locator('[data-view="pair"]').click()
    page.locator('#pair-right').fill(missing)
    page.locator('#pair-read').click()
    expect(page.locator('#pair-summary')).to_contain_text('not_found')
    expect(page.locator('#pair-results article')).to_have_count(0)
    page.locator('#pair-right').fill(left)
    before_invalid = len(calls)
    page.locator('#pair-read').click()
    expect(page.locator('#pair-summary')).to_contain_text('two_distinct_records_required')
    assert len(calls) == before_invalid
    checks += 1

    page.locator('#pair-right').fill(right)
    read_pair()
    page.locator('#pair-clear').click()
    expect(page.locator('#pair-results article')).to_have_count(0)
    expect(page.locator('#content')).to_have_value('UNSAVED PAIR REVIEW DRAFT')
    checks += 1

    # Delay a genuine HTTP result in page memory, deliberately ignoring cancellation.
    page.evaluate('''() => {
      const original = window.fetch;
      window.delayPairOnce = true;
      window.fetch = async (...args) => {
        const response = await original(...args);
        if(window.delayPairOnce && JSON.parse(args[1]?.body || '{}').operation === 'memory_read') {
          window.delayPairOnce = false;
          await new Promise(resolve => {
            window.releasePair = resolve;
            // Fixture-only readiness marker on the existing cancel control.
            // Locator polling respects production CSP; no string eval wait.
            document.querySelector('#pair-clear').setAttribute('data-test-response-ready', 'true');
          });
        }
        return response;
      };
    }''')
    page.locator('#pair-read').click()
    expect(page.locator('#pair-clear')).to_have_attribute('data-test-response-ready', 'true')
    page.locator('#pair-clear').click()
    page.evaluate('window.releasePair()')
    expect(page.locator('#pair-read')).to_be_enabled()
    page.wait_for_timeout(100)
    expect(page.locator('#pair-results article')).to_have_count(0)
    read_pair()
    page.locator('#refresh').click()
    expect(page.locator('#pair-results article')).to_have_count(0)
    checks += 1

    read_pair()
    page.locator('#logout').click()
    expect(page.locator('#login')).to_be_visible()
    expect(page.locator('#pair-left')).to_have_value('')
    expect(page.locator('#pair-right')).to_have_value('')
    expect(page.locator('#pair-results article')).to_have_count(0)
    checks += 1

    assert all(call['operation'] == 'memory_read' for call in calls[before:])
    assert not errors, errors
    assert not downloads
    context.close()
    browser.close()
print(f'PASS {checks} real Chromium manual pair scenarios; HTTP/CSP real, database rows synthetic')
