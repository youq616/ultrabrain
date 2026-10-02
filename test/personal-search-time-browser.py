"""Real shipped authenticated HTTP/CSP controls in Chromium; synthetic records only.
Native mode proves PostgreSQL results. Synthetic HTTP mode is explicitly NOT DB proof.
Route interception below delays/fails actual responses only; it never invents result rows.
"""
import json
import os
import re
import traceback
from pathlib import Path
from playwright.sync_api import sync_playwright, expect

ORIGIN = os.environ['ULTRABRAIN_BROWSER_ORIGIN']
TOKEN = os.environ['ULTRABRAIN_BROWSER_TOKEN']
ROWS = json.loads(os.environ['ULTRABRAIN_SEARCH_TIME_EXPECTED'])
MODE = os.environ['ULTRABRAIN_SEARCH_TIME_MODE']
ARTIFACTS = Path(os.environ['ULTRABRAIN_SEARCH_TIME_ARTIFACT_DIR'])
ARTIFACTS.mkdir(parents=True, exist_ok=True)
LOWER = '2024-11-03T06:30:00.123456Z'
UPPER = '2024-11-03T06:30:00.123458Z'
REPORT = {'mode': MODE, 'passed': False, 'contexts': [], 'model_calls': 0, 'write_requests': 0}


def canonical(value):
    if not value:
        return None
    body = value[:-1]
    whole, fraction = body.split('.') if '.' in body else (body, '')
    return whole + '.' + fraction.ljust(6, '0') + 'Z'


def expected_rows(status, query='', lower='', upper='', offset=0):
    # Independent oracle: declarative seed metadata and Python sorting, never server output.
    rows = [row for row in ROWS if row['visible'] and row['status'] == status
            and query.lower() in row['content'].lower()
            and (not lower or row['updated_at'] >= canonical(lower))
            and (not upper or row['updated_at'] < canonical(upper))]
    rows.sort(key=lambda row: row['id'])
    rows.sort(key=lambda row: row['updated_at'], reverse=True)
    return rows[offset:offset + 20]


def run_context(browser, timezone, width):
    context = browser.new_context(timezone_id=timezone, viewport={'width': width, 'height': 1000}, accept_downloads=True)
    page = context.new_page()
    page.set_default_timeout(10000)
    record = {'timezone': timezone, 'initial_width': width, 'checks': [], 'requests': [], 'timezone_values': []}
    REPORT['contexts'].append(record)
    errors, downloads = [], []
    page.on('pageerror', lambda error: errors.append(str(error)))
    page.on('download', lambda download: downloads.append(download))
    page.on('request', lambda request: record['requests'].append(request.post_data_json)
            if request.method == 'POST' and request.url.endswith('/api/call') else None)
    tag = timezone.replace('/', '-')

    def passed(name):
        record['checks'].append(name)

    def requests():
        return [request['input'] for request in record['requests'] if request['operation'] == 'search']

    def no_request_since(count):
        # Let queued event handlers and network events run; no debounce/automatic query is allowed.
        page.wait_for_timeout(80)
        assert len(requests()) == count, 'Editing/invalid/dirty navigation triggered a search'

    def cleared():
        expect(page.locator('#results article')).to_have_count(0)
        for selector in ['#prev', '#next', '#export']:
            expect(page.locator(selector)).to_be_disabled()

    def read_ids():
        ids = []
        for card in page.locator('#results article').all():
            match = re.search(r'[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}', card.inner_text())
            assert match, 'Every visible memory must expose its exact ID'
            ids.append(match.group(0))
        return ids

    def assert_results(status, query='', lower='', upper='', offset=0):
        wanted = expected_rows(status, query, lower, upper, offset)
        expect(page.locator('#export')).to_be_enabled()
        expect(page.locator('#results article')).to_have_count(len(wanted))
        assert read_ids() == [row['id'] for row in wanted], 'Result IDs/order differ from independent fixture oracle'
        assert page.locator('#results .memory-content').all_text_contents() == [row['content'] for row in wanted]
        # Hidden foreign source/identity records must never appear, even with identical bounds/content.
        assert not set(read_ids()) & {row['id'] for row in ROWS if not row['visible']}
        if offset == 0:
            expect(page.locator('#prev')).to_be_disabled()
        else:
            expect(page.locator('#prev')).to_be_enabled()
        return wanted

    def expected_input(status, query='', lower='', upper='', offset=0):
        value = {'query': query, 'status': status, 'offset': offset, 'limit': 20, 'budget_bytes': 131072}
        if lower:
            value['updated_from'] = canonical(lower)
        if upper:
            value['updated_before'] = canonical(upper)
        return value

    def submit(status='candidate', query='', lower='', upper='', keyboard=False):
        # Make criteria dirty before status navigation so drafts cannot auto-apply.
        for selector, value in [('#query', query), ('#updated-from', lower), ('#updated-before', upper)]:
            page.locator(selector).fill(value)
        current_status = page.locator('[data-view][aria-current="page"]').get_attribute('data-view')
        if current_status != status:
            page.locator('[data-view="' + status + '"]').click()
        before = len(requests())
        with page.expect_response(lambda response: response.url.endswith('/api/call') and
                                  response.request.post_data_json.get('operation') == 'search') as response:
            if keyboard:
                page.locator('#updated-before').press('Enter')
            else:
                page.locator('#search-form button[type="submit"]').click()
        assert response.value.ok and response.value.json()['ok']
        expect(page.locator('#search-applied')).to_contain_text('已应用：')
        assert len(requests()) == before + 1
        assert requests()[-1] == expected_input(status, query, lower, upper)
        assert_results(status, query, lower, upper)
        expect(page.locator('#updated-from')).to_have_value(lower)
        expect(page.locator('#updated-before')).to_have_value(upper)
        return requests()[-1]

    def export_page(expected, status, query='', lower='', upper='', offset=0):
        with page.expect_download() as download:
            page.locator('#export').click()
        data = json.loads(Path(download.value.path()).read_text(encoding='utf8'))
        assert data['search'] == expected
        assert data['complete'] is False and data['view'] == status
        assert [row['id'] for row in data['result']['memories']] == [row['id'] for row in expected_rows(status, query, lower, upper, offset)]
        assert TOKEN not in json.dumps(data), 'Console token must never enter page exports'
        assert 'history' not in data and 'events' not in data
        for row in data['result']['memories']:
            assert row['status'] == status and row['revision'] == (1 if status == 'candidate' else 2)
            assert 'updated_at' in row and 'created_at' in row
        return data

    try:
        response = page.goto(ORIGIN, wait_until='networkidle')
        csp = response.headers.get('content-security-policy', '')
        assert "script-src 'self'" in csp and "default-src 'none'" in csp
        expect(page.locator('#workspace')).to_be_hidden()
        assert page.evaluate("fetch('/api/call',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({operation:'info'})}).then(r=>r.status)") == 401
        page.locator('#token').fill(TOKEN)
        page.locator('#login-form button').click()
        expect(page.locator('#workspace')).to_be_visible()
        expect(page.locator('#search-applied')).to_contain_text('已应用：')
        assert requests() == [expected_input('candidate')], 'Login must retain one empty unbounded initial load'
        assert_results('candidate')
        assert page.evaluate('localStorage.length===0 && sessionStorage.length===0')
        passed('authenticated shipped HTTP/CSP, initial unbounded load, no browser token persistence')

        for selector, label in [('#updated-from', '修改时间起点 UTC（包含）'), ('#updated-before', '修改时间终点 UTC（不包含）')]:
            expect(page.get_by_label(label, exact=True)).to_be_visible()
            assert page.locator(selector).get_attribute('type') == 'text'
        page.locator('#updated-from').focus()
        page.keyboard.press('Tab')
        expect(page.locator('#updated-before')).to_be_focused()
        submit(query='TIME_NEEDLE', lower=LOWER, upper=UPPER, keyboard=True)
        expect(page.locator('#search-applied')).to_contain_text(LOWER)
        expect(page.locator('#search-applied')).to_contain_text(UPPER)
        expect(page.locator('#search-applied')).to_contain_text('当前记录修改时间')
        expect(page.locator('#search-applied')).to_contain_text('不是历史快照')
        export_page(expected_input('candidate', 'TIME_NEEDLE', LOWER, UPPER), 'candidate', 'TIME_NEEDLE', LOWER, UPPER)
        passed('labelled text controls, keyboard submit, inclusive/exclusive microseconds and applied export')

        # Full status x text-query x bound matrix. Tied IDs and both exact boundaries
        # are checked through actual result IDs, not display-only date formatting.
        for status in ['candidate', 'active', 'archived']:
            for query in ['', 'time_needle']:
                for lower, upper in [('', ''), (LOWER, ''), ('', UPPER), (LOWER, UPPER)]:
                    submit(status, query, lower, upper)
        passed('three statuses, literal query, two-sided bounds and each unbounded side, source/identity/shared visibility')

        for lower, upper in [
            ('2024-11-03T06:30:00.123456Z', '2024-11-03T06:30:00.123457Z'),
            ('2024-11-03T06:30:00.123457Z', '2024-11-03T06:30:00.123458Z'),
            ('2024-03-10T02:30:00.000001Z', '2024-03-10T02:30:00.000002Z'),
            ('2024-11-03T06:30:00.1Z', '2024-11-03T06:30:01Z'),
        ]:
            record['timezone_values'].append(submit('candidate', 'TIME_NEEDLE', lower, upper, keyboard=True))
        passed('adjacent microseconds, spring DST date, fall DST date, six-digit canonical payloads')

        page_lower, page_upper = '2024-11-03T06:30:00.1Z', '2024-11-03T06:30:01Z'
        submit('candidate', 'TIME_NEEDLE', page_lower, page_upper)
        first_ids = read_ids()
        assert len(first_ids) == 20
        expect(page.locator('#next')).to_be_enabled()
        with page.expect_response(lambda response: response.url.endswith('/api/call') and response.request.post_data_json.get('operation') == 'search'):
            page.locator('#next').click()
        expect(page.locator('#search-applied')).to_contain_text('实时第 2 页')
        assert requests()[-1] == expected_input('candidate', 'TIME_NEEDLE', page_lower, page_upper, offset=20)
        assert_results('candidate', 'TIME_NEEDLE', page_lower, page_upper, offset=20)
        assert not set(first_ids) & set(read_ids())
        export_page(requests()[-1], 'candidate', 'TIME_NEEDLE', page_lower, page_upper, offset=20)
        with page.expect_response(lambda response: response.url.endswith('/api/call') and response.request.post_data_json.get('operation') == 'search'):
            page.locator('#prev').click()
        expect(page.locator('#search-applied')).to_contain_text('实时第 1 页')
        assert_results('candidate', 'TIME_NEEDLE', page_lower, page_upper)
        passed('more than twenty rows, exact tie-break order, next/previous binding and page-two export')

        # Invalid forms cannot send requests or leave the previous valid results usable.
        invalid = ['2024-11-03', '2024-11-03T06:30:00+00:00', '2024-11-03T06:30:00.1234567Z',
                   '2023-02-29T00:00:00Z', '0000-01-01T00:00:00Z', '2024-11-03T06:30:60Z',
                   ' 2024-11-03T06:30:00Z', '2024-11-03T06:30:00Z ']
        for value in invalid:
            page.locator('#updated-from').fill(value)
            page.locator('#updated-before').fill('')
            count = len(requests())
            page.locator('#updated-before').press('Enter')
            expect(page.locator('#search-applied')).to_contain_text('条件无效')
            cleared()
            no_request_since(count)
        for lower, upper in [(LOWER, LOWER), (UPPER, LOWER)]:
            page.locator('#updated-from').fill(lower)
            page.locator('#updated-before').fill(upper)
            count = len(requests())
            page.locator('#updated-before').press('Enter')
            expect(page.locator('#search-applied')).to_contain_text('条件无效')
            cleared()
            no_request_since(count)
        passed('invalid format/calendar/precision/offset/whitespace/equal/reversed bounds send no request')

        submit('candidate', 'TIME_NEEDLE', LOWER, UPPER)
        # The ordinary search must leave the independent unsaved editor untouched.
        page.get_by_role('button', name='编辑', exact=True).first.click()
        page.locator('#content').fill('UNSAVED_SEARCH_TIME_DRAFT')
        page.locator('#provenance').fill('UNSAVED_PROVENANCE')
        page.locator('#importance').select_option('high')
        page.locator('#consent').check()
        editor = page.evaluate("JSON.stringify({editing,draftConfidence,pending,fields:['content','provenance','importance','visibility','project'].map(id=>document.getElementById(id).value),consent:document.getElementById('consent').checked})")
        for selector, value in [('#query', 'OTHER'), ('#updated-from', '2024-01-01T00:00:00Z'), ('#updated-before', '')]:
            count = len(requests())
            page.locator(selector).fill(value)
            cleared()
            expect(page.locator('#search-applied')).to_contain_text('条件已修改')
            page.locator('#refresh').click()
            page.locator('[data-view="active"]').click()
            page.locator('[data-view="candidate"]').click()
            no_request_since(count)
            assert page.evaluate("JSON.stringify({editing,draftConfidence,pending,fields:['content','provenance','importance','visibility','project'].map(id=>document.getElementById(id).value),consent:document.getElementById('consent').checked})") == editor
        submit('candidate', 'OTHER', LOWER, UPPER)
        assert requests()[-1]['offset'] == 0
        passed('all draft edits invalidate results/paging/export; refresh/navigation never apply drafts; editor/revision/confidence/consent preserved')

        # Unsignalled DOM replacements must be rechecked before page or export use.
        for action in ['#next', '#export']:
            submit('candidate', 'TIME_NEEDLE')
            count, download_count = len(requests()), len(downloads)
            page.evaluate("document.getElementById('updated-from').value='2024-01-01T00:00:00Z'")
            page.locator(action).click()
            cleared()
            no_request_since(count)
            assert len(downloads) == download_count
        passed('unsignalled form replacement cannot reuse page/export authority')

        # Hold actual read responses at transport delivery. Abort is deliberately part
        # of browser evidence; VM barriers separately exercise cancellation-loses-race.
        for outcome in ['success', 'error']:
            for action in ['edit', 'navigate', 'refresh', 'lock']:
                submit('candidate', 'TIME_NEEDLE', LOWER, UPPER)
                fired = []

                def delayed(route):
                    body = route.request.post_data_json
                    if body.get('operation') != 'search':
                        route.continue_()
                        return
                    response = route.fetch()
                    assert response.ok and response.json()['ok']
                    page.unroute('**/api/call', delayed)
                    if action == 'edit':
                        page.locator('#query').fill('UNAPPLIED_DELAYED_EDIT')
                    elif action == 'navigate':
                        page.locator('[data-view="lookup"]').click()
                    elif action == 'refresh':
                        with page.expect_response(lambda reply: reply.url.endswith('/api/call') and reply.request.post_data_json.get('operation') == 'search'):
                            page.locator('#refresh').click()
                        expect(page.locator('#search-applied')).to_contain_text('已应用：')
                    else:
                        page.locator('#logout').click()
                    fired.append({'message': page.locator('#message').inner_text(), 'summary': page.locator('#search-applied').inner_text()})
                    if outcome == 'error':
                        route.abort('failed')
                    else:
                        route.fulfill(response=response)

                page.route('**/api/call', delayed)
                page.locator('#search-form button[type="submit"]').click()
                page.wait_for_timeout(100)
                assert len(fired) == 1
                assert page.locator('#message').inner_text() == fired[0]['message'], 'Late response/error overwrote newer state'
                if action == 'refresh':
                    assert_results('candidate', 'TIME_NEEDLE', LOWER, UPPER)
                else:
                    cleared()
                if action == 'lock':
                    expect(page.locator('#workspace')).to_be_hidden()
                    page.locator('#token').fill(TOKEN)
                    page.locator('#login-form button').click()
                    expect(page.locator('#workspace')).to_be_visible()
                elif action == 'navigate':
                    expect(page.locator('#lookup-panel')).to_be_visible()
                    page.locator('[data-view="candidate"]').click()
                    expect(page.locator('#search-applied')).to_contain_text('已应用：')
        passed('actual delayed success/error ignored after edit, navigation, replacement refresh and lock')

        submit('active', 'TIME_NEEDLE', LOWER, UPPER)
        for screenshot_width, label in [(1320, 'desktop'), (390, 'narrow')]:
            page.set_viewport_size({'width': screenshot_width, 'height': 1000})
            page.locator('#search-form').scroll_into_view_if_needed()
            assert page.evaluate('document.documentElement.scrollWidth <= innerWidth + 1'), 'Horizontal overflow at ' + label
            for selector in ['#updated-from', '#updated-before']:
                box = page.locator(selector).bounding_box()
                assert box['x'] >= 0 and box['x'] + box['width'] <= screenshot_width + 1
            page.screenshot(path=str(ARTIFACTS / (tag + '-' + label + '-success.png')), full_page=True)
        passed('1320 desktop and 390 narrow control layout screenshots')
        assert all(request['operation'] in ['info', 'search'] for request in record['requests']), 'A browser write/model or unrelated read was attempted'
        assert not errors, errors
        record['passed'] = True
    except Exception:
        record['passed'] = False
        record['error'] = traceback.format_exc()
        for screenshot_width, label in [(1320, 'desktop'), (390, 'narrow')]:
            try:
                page.set_viewport_size({'width': screenshot_width, 'height': 1000})
                page.screenshot(path=str(ARTIFACTS / (tag + '-' + label + '-failure.png')), full_page=True)
            except Exception:
                pass
        raise
    finally:
        record['page_errors'] = errors
        record['search_count'] = len(requests())
        record['write_requests'] = sum(request['operation'] not in ['info', 'search'] for request in record['requests'])
        context.close()


try:
    with sync_playwright() as playwright:
        options = {'headless': True, 'args': ['--no-sandbox']}
        if os.environ.get('ULTRABRAIN_CHROMIUM'):
            options['executable_path'] = os.environ['ULTRABRAIN_CHROMIUM']
        browser = playwright.chromium.launch(**options)
        try:
            run_context(browser, 'America/New_York', 1320)
            run_context(browser, 'Asia/Shanghai', 390)
            assert REPORT['contexts'][0]['timezone_values'] == REPORT['contexts'][1]['timezone_values'], 'Browser timezone changed transmitted UTC values'
            REPORT['passed'] = True
            REPORT['timezone_payloads_identical'] = True
        finally:
            browser.close()
except Exception:
    REPORT['error'] = traceback.format_exc()
    raise
finally:
    (ARTIFACTS / 'browser-report.json').write_text(json.dumps(REPORT, ensure_ascii=False, indent=2) + '\n', encoding='utf8')
    print(json.dumps({'mode': MODE, 'passed': REPORT['passed'], 'checks': sum(len(record['checks']) for record in REPORT['contexts'])}))
