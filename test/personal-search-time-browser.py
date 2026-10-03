"""Real shipped authenticated HTTP/CSP controls in Chromium; synthetic records only.
Native mode proves PostgreSQL results. Synthetic HTTP mode is explicitly NOT DB proof.
Route interception below delays/fails actual responses only; it never invents result rows.
"""
import json
import hashlib
import os
import re
import time
import traceback
from pathlib import Path
from playwright.sync_api import sync_playwright, expect

ORIGIN = os.environ['ULTRABRAIN_BROWSER_ORIGIN']
TOKEN = os.environ['ULTRABRAIN_BROWSER_TOKEN']
ROWS_PATH = Path(os.environ['ULTRABRAIN_SEARCH_TIME_EXPECTED_FILE'])
ROWS_BYTES = ROWS_PATH.read_bytes()
assert len(ROWS_BYTES) <= 1048576, 'Bound synthetic fixture metadata'
ROWS = json.loads(ROWS_BYTES)
assert isinstance(ROWS, list) and len(ROWS) == 1512
MEMORY_TYPES = ['identity', 'preference', 'environment', 'project', 'decision', 'skill', 'error', 'goal', 'experience']
MODE = os.environ['ULTRABRAIN_SEARCH_TIME_MODE']
ARTIFACTS = Path(os.environ['ULTRABRAIN_SEARCH_TIME_ARTIFACT_DIR'])
ARTIFACTS.mkdir(parents=True, exist_ok=True)
LOWER = '2024-11-03T06:30:00.123456Z'
UPPER = '2024-11-03T06:30:00.123458Z'
REPORT = {'mode': MODE, 'passed': False, 'contexts': [], 'model_calls': 0, 'write_requests': 0,
          'fixture_metadata': {'file': ROWS_PATH.name, 'rows': len(ROWS), 'sha256': hashlib.sha256(ROWS_BYTES).hexdigest()}}


def canonical(value):
    if not value:
        return None
    body = value[:-1]
    whole, fraction = body.split('.') if '.' in body else (body, '')
    return whole + '.' + fraction.ljust(6, '0') + 'Z'


def expected_rows(status, query='', lower='', upper='', offset=0, project='', memory_type=''):
    # Independent oracle: declarative seed metadata and Python sorting, never server output.
    rows = [row for row in ROWS if row['visible'] and row['status'] == status
            and (not project or row['project_id'] == project)
            and (not memory_type or row['type'] == memory_type)
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

    def assert_results(status, query='', lower='', upper='', offset=0, project='', memory_type=''):
        wanted = expected_rows(status, query, lower, upper, offset, project, memory_type)
        expect(page.locator('#export')).to_be_enabled()
        expect(page.locator('#results article')).to_have_count(len(wanted))
        assert read_ids() == [row['id'] for row in wanted], 'Result IDs/order differ from independent fixture oracle'
        assert page.locator('#results .memory-content').all_text_contents() == [row['content'] for row in wanted]
        actual = page.evaluate('current.memories.map(row=>({id:row.id,type:row.type,project_id:row.project_id,content:row.content}))')
        assert actual == [{key: row[key] for key in ['id', 'type', 'project_id', 'content']} for row in wanted]
        # Hidden foreign source/identity records must never appear, even with identical bounds/content.
        assert not set(read_ids()) & {row['id'] for row in ROWS if not row['visible']}
        if offset == 0:
            expect(page.locator('#prev')).to_be_disabled()
        else:
            expect(page.locator('#prev')).to_be_enabled()
        return wanted

    def expected_input(status, query='', lower='', upper='', offset=0, project='', memory_type=''):
        value = {'query': query, 'status': status, 'offset': offset, 'limit': 20, 'budget_bytes': 131072}
        if memory_type:
            value['types'] = [memory_type]
        if project:
            value['project_id'] = project
        if lower:
            value['updated_from'] = canonical(lower)
        if upper:
            value['updated_before'] = canonical(upper)
        return value

    def submit(status='candidate', query='', lower='', upper='', keyboard=False, project='', memory_type=''):
        # Make criteria dirty before status navigation so drafts cannot auto-apply.
        for selector, value in [('#query', query), ('#updated-from', lower), ('#updated-before', upper), ('#search-project', project)]:
            page.locator(selector).fill(value)
        page.locator('#search-type').select_option(memory_type)
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
        assert requests()[-1] == expected_input(status, query, lower, upper, project=project, memory_type=memory_type)
        assert_results(status, query, lower, upper, project=project, memory_type=memory_type)
        expect(page.locator('#search-type')).to_have_value(memory_type)
        expect(page.locator('#search-applied')).to_contain_text('（' + memory_type + '）' if memory_type else '全部已存类型')
        expect(page.locator('#search-project')).to_have_value(project)
        expect(page.locator('#search-applied')).to_contain_text(project + '（仅该项目，不含全局）' if project else '全部可见（含全局）')
        expect(page.locator('#updated-from')).to_have_value(lower)
        expect(page.locator('#updated-before')).to_have_value(upper)
        return requests()[-1]

    def export_page(expected, status, query='', lower='', upper='', offset=0, project='', memory_type=''):
        with page.expect_download() as download:
            page.locator('#export').click()
        data = json.loads(Path(download.value.path()).read_text(encoding='utf8'))
        assert data['search'] == expected
        assert data['complete'] is False and data['view'] == status
        assert [row['id'] for row in data['result']['memories']] == [row['id'] for row in expected_rows(status, query, lower, upper, offset, project, memory_type)]
        assert TOKEN not in json.dumps(data), 'Console token must never enter page exports'
        assert 'history' not in data and 'events' not in data
        for row in data['result']['memories']:
            assert row['status'] == status and row['revision'] == (1 if status == 'candidate' else 2)
            assert 'updated_at' in row and 'created_at' in row
            spec = next(spec for spec in ROWS if spec['id'] == row['id'])
            assert row['project_id'] == spec['project_id']
            assert row['type'] == spec['type']
            if memory_type:
                assert row['type'] == memory_type
            if project:
                assert row['project_id'] == project
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
        expect(page.get_by_label('记忆类型（已存类型）', exact=True)).to_be_visible()
        assert page.locator('#search-type option').evaluate_all('(options)=>options.map(option=>option.value)') == ['', *MEMORY_TYPES]
        page.locator('#search-type').focus()
        page.keyboard.press('Tab')
        expect(page.locator('#search-project')).to_be_focused()
        expect(page.get_by_label('搜索项目（精确标识，可留空）', exact=True)).to_be_visible()
        assert page.locator('#search-project').get_attribute('type') == 'text'
        page.locator('#search-project').focus()
        page.keyboard.press('Tab')
        expect(page.locator('#updated-from')).to_be_focused()
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
                    for project in ['', 'Project_A', 'project_a']:
                        submit(status, query, lower, upper, project=project)
        passed('all/exact case-distinct projects x three statuses x literal query x time bounds, global exclusion and source/identity/shared visibility')
        for project in ['No_such_Project', 'null', 'undefined']:
            submit(project=project, keyboard=True)
            assert read_ids() == []
        submit('active', 'TIME_NEEDLE', LOWER, UPPER, project='Project_A')
        export_page(requests()[-1], 'active', 'TIME_NEEDLE', LOWER, UPPER, project='Project_A')
        submit('active', 'TIME_NEEDLE', LOWER, UPPER, memory_type='preference')
        all_projects = {row['project_id'] for row in expected_rows('active', 'TIME_NEEDLE', LOWER, UPPER, memory_type='preference')}
        assert all_projects == {None, 'Project_A', 'project_a'}
        passed('valid empty exact-project result, literal IDs, filtered export and clearing to all including global')

        # Stored types are declarative fixture data, not classifications or response-derived expectations.
        for memory_type in ['', *MEMORY_TYPES]:
            for status in ['candidate', 'active', 'archived']:
                for project in ['', 'Project_A', 'project_a']:
                    submit(status, 'TIME_NEEDLE', LOWER, UPPER, project=project, memory_type=memory_type)
        passed('All plus nine stored types x three statuses x all/exact-case projects; exact singleton versus omitted types')
        for memory_type in MEMORY_TYPES:
            for query in ['', 'TIME_NEEDLE']:
                for lower, upper in [('', ''), (LOWER, ''), ('', UPPER), (LOWER, UPPER)]:
                    submit('candidate', query, lower, upper, project='Project_A', memory_type=memory_type)
        passed('each stored type x literal text x four UTC bound choices against independent IDs/type/project oracle')
        one_microsecond = '2024-11-03T06:30:00.123457Z'
        submit('archived', 'TIME_NEEDLE', LOWER, one_microsecond, project='Project_A')
        mixed = export_page(requests()[-1], 'archived', 'TIME_NEEDLE', LOWER, one_microsecond, project='Project_A')
        assert len(mixed['result']['memories']) == 18
        assert {row['type'] for row in mixed['result']['memories']} == set(MEMORY_TYPES)
        submit('active', 'TIME_NEEDLE', LOWER, UPPER, project='Project_A', memory_type='decision')
        export_page(requests()[-1], 'active', 'TIME_NEEDLE', LOWER, UPPER, project='Project_A', memory_type='decision')
        passed('deterministic eighteen-row All-types export contains all nine types; selected-type export remains exact')

        for value in ['unknown', 'Preference', ' preference', 'preference ', 'preference\n', 'constructor', 'toString', 'hasOwnProperty', '__proto__']:
            submit(memory_type='preference')
            # Inject a selected invalid option; assigning an unknown native-select value alone would become All.
            page.evaluate("value => {const select=document.getElementById('search-type'),option=new Option(value,value);option.dataset.fixtureInvalid='true';select.add(option);select.value=value;select.dispatchEvent(new Event('change',{bubbles:true}));}", value)
            count = len(requests())
            page.locator('#search-form button[type="submit"]').click()
            expect(page.locator('#search-applied')).to_contain_text('条件无效')
            cleared()
            no_request_since(count)
            page.locator('#search-type option[data-fixture-invalid]').evaluate_all('(options)=>options.forEach(option=>option.remove())')
        submit(memory_type='goal')
        count = len(requests())
        page.locator('#search-type').select_option('decision')
        page.locator('#search-type').select_option('goal')
        page.locator('#refresh').click()
        cleared()
        no_request_since(count)
        # Keyboard changes the native select; only explicit form submission sends a query.
        page.locator('#search-type').focus()
        page.keyboard.press('Home')
        page.keyboard.press('ArrowDown')
        expect(page.locator('#search-type')).to_have_value('identity')
        no_request_since(count)
        submit(memory_type='goal', keyboard=True)
        for status in ['active', 'archived', 'candidate']:
            with page.expect_response(lambda response: response.url.endswith('/api/call') and response.request.post_data_json.get('operation') == 'search'):
                page.locator('[data-view="' + status + '"]').click()
            assert requests()[-1] == expected_input(status, memory_type='goal')
            assert_results(status, memory_type='goal')
        with page.expect_response(lambda response: response.url.endswith('/api/call') and response.request.post_data_json.get('operation') == 'search'):
            page.locator('#refresh').click()
        assert requests()[-1] == expected_input('candidate', memory_type='goal')
        submit(memory_type='')
        assert 'types' not in requests()[-1]
        passed('tampered invalid type options never widen; dirty/reverted native select, keyboard and status/refresh/clear semantics')

        for lower, upper in [
            ('2024-11-03T06:30:00.123456Z', '2024-11-03T06:30:00.123457Z'),
            ('2024-11-03T06:30:00.123457Z', '2024-11-03T06:30:00.123458Z'),
            ('2024-03-10T02:30:00.000001Z', '2024-03-10T02:30:00.000002Z'),
            ('2024-11-03T06:30:00.1Z', '2024-11-03T06:30:01Z'),
        ]:
            record['timezone_values'].append(submit('candidate', 'TIME_NEEDLE', lower, upper, keyboard=True))
        passed('adjacent microseconds, spring DST date, fall DST date, six-digit canonical payloads')

        page_lower, page_upper = '2024-11-03T06:30:00.1Z', '2024-11-03T06:30:01Z'
        for page_project, page_type in [('', ''), ('Project_A', ''), ('Project_A', 'decision')]:
            submit('candidate', 'TIME_NEEDLE', page_lower, page_upper, project=page_project, memory_type=page_type)
            first_ids = read_ids()
            assert len(first_ids) == 20
            expect(page.locator('#next')).to_be_enabled()
            with page.expect_response(lambda response: response.url.endswith('/api/call') and response.request.post_data_json.get('operation') == 'search'):
                page.locator('#next').click()
            expect(page.locator('#search-applied')).to_contain_text('实时第 2 页')
            assert requests()[-1] == expected_input('candidate', 'TIME_NEEDLE', page_lower, page_upper, offset=20, project=page_project, memory_type=page_type)
            assert_results('candidate', 'TIME_NEEDLE', page_lower, page_upper, offset=20, project=page_project, memory_type=page_type)
            assert not set(first_ids) & set(read_ids())
            export_page(requests()[-1], 'candidate', 'TIME_NEEDLE', page_lower, page_upper, offset=20, project=page_project, memory_type=page_type)
            with page.expect_response(lambda response: response.url.endswith('/api/call') and response.request.post_data_json.get('operation') == 'search'):
                page.locator('#prev').click()
            expect(page.locator('#search-applied')).to_contain_text('实时第 1 页')
            assert_results('candidate', 'TIME_NEEDLE', page_lower, page_upper, project=page_project, memory_type=page_type)
        passed('more than twenty selected-type/exact-project rows, other-type/global/other-project distractors, tie-break order, next/previous and page-two export')

        for value in [' Project_A', 'Project_A ', 'a.b', 'a/b', '项目', 'a' * 97]:
            submit(project='Project_A')
            # A DOM replacement covers overlength values beyond maxlength as well.
            page.evaluate("value => {const input=document.getElementById('search-project');input.value=value;input.dispatchEvent(new Event('input',{bubbles:true}));}", value)
            count = len(requests())
            page.locator('#search-form button[type="submit"]').click()
            expect(page.locator('#search-applied')).to_contain_text('条件无效')
            cleared()
            no_request_since(count)
        submit(project='Project_A')
        count = len(requests())
        page.locator('#search-project').fill('project_a')
        page.locator('#search-project').fill('Project_A')
        page.locator('#refresh').click()
        cleared()
        no_request_since(count)
        submit(project='Project_A', keyboard=True)
        for status in ['active', 'archived', 'candidate']:
            with page.expect_response(lambda response: response.url.endswith('/api/call') and response.request.post_data_json.get('operation') == 'search'):
                page.locator('[data-view="' + status + '"]').click()
            assert requests()[-1] == expected_input(status, project='Project_A')
            assert_results(status, project='Project_A')
        with page.expect_response(lambda response: response.url.endswith('/api/call') and response.request.post_data_json.get('operation') == 'search'):
            page.locator('#refresh').click()
        assert requests()[-1] == expected_input('candidate', project='Project_A')
        assert_results('candidate', project='Project_A')
        passed('invalid project no-request, eventful revert stays dirty, keyboard apply, immutable status-navigation project')

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
        page.locator('#project').fill('Independent_Editor')
        page.locator('#type').select_option('environment')
        page.locator('#consent').check()
        editor = page.evaluate("JSON.stringify({editing,draftConfidence,pending,fields:['content','type','provenance','importance','visibility','project'].map(id=>document.getElementById(id).value),consent:document.getElementById('consent').checked})")
        for selector, value in [('#query', 'OTHER'), ('#updated-from', '2024-01-01T00:00:00Z'), ('#updated-before', ''), ('#search-project', 'project_a')]:
            count = len(requests())
            page.locator(selector).fill(value)
            cleared()
            expect(page.locator('#search-applied')).to_contain_text('条件已修改')
            page.locator('#refresh').click()
            page.locator('[data-view="active"]').click()
            page.locator('[data-view="candidate"]').click()
            no_request_since(count)
            assert page.evaluate("JSON.stringify({editing,draftConfidence,pending,fields:['content','type','provenance','importance','visibility','project'].map(id=>document.getElementById(id).value),consent:document.getElementById('consent').checked})") == editor
        count = len(requests())
        page.locator('#search-type').select_option('goal')
        cleared()
        page.locator('#refresh').click()
        page.locator('[data-view="active"]').click()
        page.locator('[data-view="candidate"]').click()
        no_request_since(count)
        assert page.evaluate("JSON.stringify({editing,draftConfidence,pending,fields:['content','type','provenance','importance','visibility','project'].map(id=>document.getElementById(id).value),consent:document.getElementById('consent').checked})") == editor
        submit('candidate', 'OTHER', LOWER, UPPER, memory_type='goal')
        assert requests()[-1]['offset'] == 0
        passed('all draft edits invalidate results/paging/export; refresh/navigation never apply drafts; editor/revision/confidence/consent preserved')

        # Unsignalled DOM replacements must be rechecked before page or export use.
        for field, value in [('updated-from', '2024-01-01T00:00:00Z'), ('search-project', 'Project_A'), ('search-type', 'goal')]:
            for action in ['#next', '#export']:
                submit('candidate', 'TIME_NEEDLE')
                count, download_count = len(requests()), len(downloads)
                page.evaluate("([id,value]) => {document.getElementById(id).value=value}", [field, value])
                page.locator(action).click()
                cleared()
                no_request_since(count)
                assert len(downloads) == download_count
        passed('unsignalled form replacement cannot reuse page/export authority')

        # Hold actual read responses at transport delivery. Abort is deliberately part
        # of browser evidence; VM barriers separately exercise cancellation-loses-race.
        # After cancellation, fulfill/abort below do not deliver a stale body to the UI.
        for outcome in ['success', 'error']:
            for action in ['edit', 'project', 'project-revert', 'type', 'type-revert', 'navigate', 'refresh', 'lock']:
                submit('candidate', 'TIME_NEEDLE', LOWER, UPPER)
                held, fired = [], []

                def delayed(route):
                    body = route.request.post_data_json
                    if body.get('operation') != 'search' or held:
                        route.continue_()
                        return
                    held.append(route.request)
                    response = route.fetch()
                    assert response.ok and response.json()['ok']
                    # Removing this handler while it owns the paused request can
                    # auto-continue that route. Keep it installed until exactly one
                    # terminal operation; the held guard passes refresh reads through.
                    if action == 'edit':
                        page.locator('#query').fill('UNAPPLIED_DELAYED_EDIT')
                    elif action in ['project', 'project-revert']:
                        page.locator('#search-project').fill('Project_A')
                        if action == 'project-revert':
                            page.locator('#search-project').fill('')
                    elif action in ['type', 'type-revert']:
                        page.locator('#search-type').select_option('goal')
                        if action == 'type-revert':
                            page.locator('#search-type').select_option('')
                    elif action == 'navigate':
                        page.locator('[data-view="lookup"]').click()
                    elif action == 'refresh':
                        with page.expect_response(lambda reply: reply.url.endswith('/api/call') and reply.request.post_data_json.get('operation') == 'search'):
                            page.locator('#refresh').click()
                        expect(page.locator('#search-applied')).to_contain_text('已应用：')
                    else:
                        page.locator('#logout').click()
                    newer = {'message': page.locator('#message').inner_text(), 'summary': page.locator('#search-applied').inner_text()}
                    if outcome == 'error':
                        route.abort('failed')
                    else:
                        route.fulfill(response=response)
                    fired.append(newer)  # Signal only after the held route is handled.

                page.route('**/api/call', delayed)
                with page.expect_event('requestfailed', predicate=lambda request: bool(held) and request is held[0]) as cancelled:
                    page.locator('#search-form button[type="submit"]').click()
                deadline = time.monotonic() + 10
                while not fired and time.monotonic() < deadline:
                    page.wait_for_timeout(20)
                assert len(held) == len(fired) == 1, 'Held route did not complete exactly once'
                page.unroute('**/api/call', delayed)
                assert cancelled.value.failure == 'net::ERR_ABORTED', 'The UI must cancel the exact held fetch'
                page.wait_for_timeout(100)
                assert page.locator('#message').inner_text() == fired[0]['message'], 'Late response/error overwrote newer state'
                assert page.locator('#search-applied').inner_text() == fired[0]['summary'], 'Late response/error overwrote newer criteria'
                record.setdefault('delayed_cases', []).append({'late_terminal_operation': 'fulfill' if outcome == 'success' else 'abort',
                    'action': action, 'cancellation': cancelled.value.failure, 'terminal_operations': len(fired)})
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
        passed('exact held fetch cancelled after edit/navigation/refresh/lock; later fulfill/abort leaves newer UI intact; VM covers delivered stale results')

        submit('active', 'TIME_NEEDLE', LOWER, UPPER, project='Project_A', memory_type='decision')
        record['timezone_values'].append(requests()[-1])
        for screenshot_width, label in [(1320, 'desktop'), (390, 'narrow')]:
            page.set_viewport_size({'width': screenshot_width, 'height': 1000})
            page.locator('#search-form').scroll_into_view_if_needed()
            assert page.evaluate('document.documentElement.scrollWidth <= innerWidth + 1'), 'Horizontal overflow at ' + label
            for selector in ['#search-type', '#search-project', '#updated-from', '#updated-before']:
                box = page.locator(selector).bounding_box()
                assert box['x'] >= 0 and box['x'] + box['width'] <= screenshot_width + 1
            page.screenshot(path=str(ARTIFACTS / (tag + '-' + label + '-success.png')), full_page=True)
        passed('1320 desktop and 390 narrow control layout screenshots')
        assert all(request['operation'] in ['info', 'search'] for request in record['requests']), 'A browser write/model or unrelated read was attempted'
        assert len(requests()) < 400, 'Stay within the reviewed per-context search budget'
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
