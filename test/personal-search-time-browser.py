"""Real shipped authenticated HTTP/CSP controls in Chromium; synthetic records only.
Native mode proves PostgreSQL results. Synthetic HTTP mode is explicitly NOT DB proof.
Route interception below delays/fails actual responses only; it never invents result rows.
"""
import hashlib
import json
import os
import re
import time
import traceback
from pathlib import Path
from playwright.sync_api import sync_playwright, expect

ORIGIN = os.environ['ULTRABRAIN_BROWSER_ORIGIN']
TOKEN = os.environ['ULTRABRAIN_BROWSER_TOKEN']
MODE = os.environ['ULTRABRAIN_SEARCH_TIME_MODE']
ARTIFACTS = Path(os.environ['ULTRABRAIN_SEARCH_TIME_ARTIFACT_DIR'])
ARTIFACTS.mkdir(parents=True, exist_ok=True)
LOWER = '2024-11-03T06:30:00.123456Z'
UPPER = '2024-11-03T06:30:00.123458Z'
AGENT_LABELS = ['search-time-fixture', 'Agent_A', 'agent_a']
REPORT = {'mode': MODE, 'passed': False, 'contexts': [], 'model_calls': 0, 'write_requests': 0}


def read_metadata(path, expected_sha256, mode):
    # Check size before reading; no large expected-row JSON crosses the environment.
    path = Path(path)
    byte_size = path.stat().st_size
    assert 0 < byte_size <= 1048576, 'Fixture metadata must be at most 1 MiB'
    raw = path.read_bytes()
    assert len(raw) == byte_size
    digest = hashlib.sha256(raw).hexdigest()
    assert re.fullmatch(r'[0-9a-f]{64}', expected_sha256) and digest == expected_sha256
    metadata = json.loads(raw.decode('utf8'))
    assert metadata['format'] == 'ultrabrain-search-time-fixture' and metadata['version'] == 1
    assert metadata['mode'] == mode and mode in ['native-postgresql', 'synthetic-http-not-postgresql']
    assert metadata['row_count'] == 504 and len(metadata['rows']) == 504
    assert len({row['id'] for row in metadata['rows']}) == 504
    assert {row['agent_id'] for row in metadata['rows']} == set(AGENT_LABELS)
    for label in AGENT_LABELS:
        assert sum(row['agent_id'] == label for row in metadata['rows']) == 168
    evidence = {key: metadata[key] for key in ['format', 'version', 'mode', 'row_count']}
    evidence.update(byte_size=byte_size, sha256=digest)
    return metadata['rows'], evidence


def canonical(value):
    if not value:
        return None
    body = value[:-1]
    whole, fraction = body.split('.') if '.' in body else (body, '')
    return whole + '.' + fraction.ljust(6, '0') + 'Z'


def expected_rows(status, query='', lower='', upper='', offset=0, project='', agent=''):
    # Independent oracle: declarative seed metadata and Python sorting, never server output.
    rows = [row for row in ROWS if row['visible'] and row['status'] == status
            and (not project or row['project_id'] == project)
            and (not agent or row['agent_id'] == agent)
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
    started = time.monotonic()
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

    def assert_results(status, query='', lower='', upper='', offset=0, project='', agent=''):
        wanted = expected_rows(status, query, lower, upper, offset, project, agent)
        expect(page.locator('#export')).to_be_enabled()
        expect(page.locator('#results article')).to_have_count(len(wanted))
        assert read_ids() == [row['id'] for row in wanted], 'Result IDs/order differ from independent fixture oracle'
        assert page.locator('#results .memory-content').all_text_contents() == [row['content'] for row in wanted]
        actual = page.evaluate('current.memories')
        assert [{key: row[key] for key in ['id', 'content', 'project_id', 'agent_id']} for row in actual] == [
            {key: row[key] for key in ['id', 'content', 'project_id', 'agent_id']} for row in wanted]
        assert all(not agent or row['agent_id'] == agent for row in actual)
        # Hidden foreign source/identity records must never appear, even with identical bounds/content.
        assert not set(read_ids()) & {row['id'] for row in ROWS if not row['visible']}
        if offset == 0:
            expect(page.locator('#prev')).to_be_disabled()
        else:
            expect(page.locator('#prev')).to_be_enabled()
        return wanted

    def expected_input(status, query='', lower='', upper='', offset=0, project='', agent=''):
        value = {'query': query, 'status': status, 'offset': offset, 'limit': 20, 'budget_bytes': 131072}
        if project:
            value['project_id'] = project
        if agent:
            value['agent_id'] = agent
        if lower:
            value['updated_from'] = canonical(lower)
        if upper:
            value['updated_before'] = canonical(upper)
        return value

    def submit(status='candidate', query='', lower='', upper='', keyboard=False, project='', agent=''):
        # Make criteria dirty before status navigation so drafts cannot auto-apply.
        for selector, value in [('#query', query), ('#updated-from', lower), ('#updated-before', upper), ('#search-project', project), ('#search-agent', agent)]:
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
        assert requests()[-1] == expected_input(status, query, lower, upper, project=project, agent=agent)
        assert_results(status, query, lower, upper, project=project, agent=agent)
        expect(page.locator('#search-project')).to_have_value(project)
        expect(page.locator('#search-agent')).to_have_value(agent)
        expect(page.locator('#search-applied')).to_contain_text(agent + '（精确匹配）' if agent else '全部可见标签')
        expect(page.locator('#search-applied')).to_contain_text(project + '（仅该项目，不含全局）' if project else '全部可见（含全局）')
        expect(page.locator('#updated-from')).to_have_value(lower)
        expect(page.locator('#updated-before')).to_have_value(upper)
        return requests()[-1]

    def export_page(expected, status, query='', lower='', upper='', offset=0, project='', agent=''):
        with page.expect_download() as download:
            page.locator('#export').click()
        data = json.loads(Path(download.value.path()).read_text(encoding='utf8'))
        assert data['search'] == expected
        assert data['complete'] is False and data['view'] == status
        assert [row['id'] for row in data['result']['memories']] == [row['id'] for row in expected_rows(status, query, lower, upper, offset, project, agent)]
        assert TOKEN not in json.dumps(data), 'Console token must never enter page exports'
        assert 'history' not in data and 'events' not in data
        for row in data['result']['memories']:
            assert row['status'] == status and row['revision'] == (1 if status == 'candidate' else 2)
            assert 'updated_at' in row and 'created_at' in row
            spec = next(spec for spec in ROWS if spec['id'] == row['id'])
            assert row['project_id'] == spec['project_id'] and row['agent_id'] == spec['agent_id']
            assert row['content'] == spec['content']
            if agent:
                assert row['agent_id'] == agent
            if project:
                assert row['project_id'] == project
        return data

    def assert_agent_accessibility():
        name = '搜索 Agent 标签（精确标识，可留空）'
        expect(page.get_by_label(name, exact=True)).to_have_attribute('id', 'search-agent')
        expect(page.get_by_role('textbox', name=name, exact=True)).to_have_attribute('id', 'search-agent')
        expect(page.get_by_label(name, exact=True)).to_be_visible()
        expect(page.get_by_role('textbox', name=name, exact=True)).to_be_visible()
        label = page.locator('#search-agent-label')
        assert label.inner_text() == name and label.get_attribute('for') == 'search-agent'
        assert label.locator('*').count() == 0, 'Agent accessible label must remain text-only'
        assert page.locator('#search-agent').get_attribute('type') == 'text'
        assert page.locator('#search-agent').get_attribute('aria-labelledby') == 'search-agent-label'
        assert page.locator('#search-agent').get_attribute('aria-describedby') == 'search-agent-help'
        page.locator('#search-project').focus()
        for selector in ['#search-agent', '#updated-from', '#updated-before']:
            page.keyboard.press('Tab')
            expect(page.locator(selector)).to_be_focused()
        record.setdefault('accessibility_widths', []).append(page.viewport_size['width'])

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
        expect(page.get_by_label('搜索项目（精确标识，可留空）', exact=True)).to_be_visible()
        assert page.locator('#search-project').get_attribute('type') == 'text'
        assert_agent_accessibility()
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
        agent_core_submissions = 0
        for agent in [''] + AGENT_LABELS:
            for status in ['candidate', 'active', 'archived']:
                for project in ['', 'Project_A', 'project_a']:
                    submit(status, 'TIME_NEEDLE', LOWER, UPPER, project=project, agent=agent)
                    agent_core_submissions += 1
        assert agent_core_submissions == 36
        agent_bound_submissions = 0
        for agent in AGENT_LABELS:
            for query in ['', 'time_needle']:
                for lower, upper in [('', ''), (LOWER, ''), ('', UPPER), (LOWER, UPPER)]:
                    submit('candidate', query, lower, upper, project='Project_A', agent=agent)
                    agent_bound_submissions += 1
        assert agent_bound_submissions == 24
        record['agent_matrix_submissions'] = {'core': agent_core_submissions, 'text_bounds': agent_bound_submissions}
        passed('36 All/exact Agent x status x project and 24 selected-Agent x text x bound submissions; exact case and unchanged sharing')
        for agent in ['No_such_Agent', 'null', 'undefined', 'constructor', '__proto__']:
            submit(agent=agent, keyboard=True)
            assert read_ids() == []
        submit('active', 'TIME_NEEDLE', LOWER, UPPER, project='Project_A', agent='Agent_A')
        selected = export_page(requests()[-1], 'active', 'TIME_NEEDLE', LOWER, UPPER, project='Project_A', agent='Agent_A')
        assert any(not row['owned_by_caller'] and row['visibility'] == 'source' for row in selected['result']['memories'])
        passed('valid missing/prototype-like labels are empty and exact-label export retains peer source-shared active rows')
        for project in ['No_such_Project', 'null', 'undefined']:
            submit(project=project, keyboard=True)
            assert read_ids() == []
        submit('active', 'TIME_NEEDLE', LOWER, UPPER, project='Project_A')
        export_page(requests()[-1], 'active', 'TIME_NEEDLE', LOWER, UPPER, project='Project_A')
        submit('active', 'TIME_NEEDLE', LOWER, UPPER)
        export_page(requests()[-1], 'active', 'TIME_NEEDLE', LOWER, UPPER)
        narrow_upper = '2024-11-03T06:30:00.123457Z'
        submit('archived', 'TIME_NEEDLE', LOWER, narrow_upper, project='Project_A', agent='Agent_A')
        submit('archived', 'TIME_NEEDLE', LOWER, narrow_upper)
        all_rows = expected_rows('archived', 'TIME_NEEDLE', LOWER, narrow_upper)
        assert len(all_rows) == 18
        assert {row['project_id'] for row in all_rows} == {None, 'Project_A', 'project_a'}
        assert {row['agent_id'] for row in all_rows} == set(AGENT_LABELS)
        export_page(requests()[-1], 'archived', 'TIME_NEEDLE', LOWER, narrow_upper)
        passed('valid empty exact-project result, literal IDs, filtered export and clearing to all including global')

        for lower, upper in [
            ('2024-11-03T06:30:00.123456Z', '2024-11-03T06:30:00.123457Z'),
            ('2024-11-03T06:30:00.123457Z', '2024-11-03T06:30:00.123458Z'),
            ('2024-03-10T02:30:00.000001Z', '2024-03-10T02:30:00.000002Z'),
            ('2024-11-03T06:30:00.1Z', '2024-11-03T06:30:01Z'),
        ]:
            record['timezone_values'].append(submit('candidate', 'TIME_NEEDLE', lower, upper, keyboard=True))
            record['timezone_values'].append(submit('candidate', 'TIME_NEEDLE', lower, upper, keyboard=True, project='Project_A', agent='Agent_A'))
        passed('adjacent microseconds, spring DST date, fall DST date, six-digit canonical payloads')

        page_lower, page_upper = '2024-11-03T06:30:00.1Z', '2024-11-03T06:30:01Z'
        for page_project, page_agent in [('', ''), ('Project_A', ''), ('Project_A', 'Agent_A')]:
            submit('candidate', 'TIME_NEEDLE', page_lower, page_upper, project=page_project, agent=page_agent)
            first_ids = read_ids()
            assert len(first_ids) == 20
            expect(page.locator('#next')).to_be_enabled()
            with page.expect_response(lambda response: response.url.endswith('/api/call') and response.request.post_data_json.get('operation') == 'search'):
                page.locator('#next').click()
            expect(page.locator('#search-applied')).to_contain_text('实时第 2 页')
            assert requests()[-1] == expected_input('candidate', 'TIME_NEEDLE', page_lower, page_upper, offset=20, project=page_project, agent=page_agent)
            assert_results('candidate', 'TIME_NEEDLE', page_lower, page_upper, offset=20, project=page_project, agent=page_agent)
            assert not set(first_ids) & set(read_ids())
            export_page(requests()[-1], 'candidate', 'TIME_NEEDLE', page_lower, page_upper, offset=20, project=page_project, agent=page_agent)
            with page.expect_response(lambda response: response.url.endswith('/api/call') and response.request.post_data_json.get('operation') == 'search'):
                page.locator('#prev').click()
            expect(page.locator('#search-applied')).to_contain_text('实时第 1 页')
            assert_results('candidate', 'TIME_NEEDLE', page_lower, page_upper, project=page_project, agent=page_agent)
        passed('more than twenty exact-label/project rows, other-label/project/global distractors, tie-break order, next/previous and page-two export')

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

        for value in [' Agent_A', 'Agent_A ', 'a.b', 'a/b', '代理', 'a' * 97]:
            submit(project='Project_A', agent='Agent_A')
            page.evaluate("value => {const input=document.getElementById('search-agent');input.value=value;input.dispatchEvent(new Event('input',{bubbles:true}));}", value)
            count = len(requests())
            page.locator('#search-form button[type="submit"]').click()
            expect(page.locator('#search-applied')).to_contain_text('条件无效')
            cleared()
            no_request_since(count)
        submit(project='Project_A', agent='Agent_A')
        count = len(requests())
        page.locator('#search-agent').fill('agent_a')
        page.locator('#search-agent').fill('Agent_A')
        page.locator('#refresh').click()
        cleared()
        no_request_since(count)
        # Actual key events edit the Agent field; Enter explicitly applies it.
        page.locator('#search-agent').focus()
        page.keyboard.press('ControlOrMeta+A')
        page.keyboard.type('Agent_A')
        with page.expect_response(lambda response: response.url.endswith('/api/call') and response.request.post_data_json.get('operation') == 'search'):
            page.locator('#search-agent').press('Enter')
        expect(page.locator('#search-applied')).to_contain_text('已应用：')
        assert requests()[-1] == expected_input('candidate', project='Project_A', agent='Agent_A')
        assert_results('candidate', project='Project_A', agent='Agent_A')
        for status in ['active', 'archived', 'candidate']:
            with page.expect_response(lambda response: response.url.endswith('/api/call') and response.request.post_data_json.get('operation') == 'search'):
                page.locator('[data-view="' + status + '"]').click()
            assert requests()[-1] == expected_input(status, project='Project_A', agent='Agent_A')
            assert_results(status, project='Project_A', agent='Agent_A')
        with page.expect_response(lambda response: response.url.endswith('/api/call') and response.request.post_data_json.get('operation') == 'search'):
            page.locator('#refresh').click()
        assert requests()[-1] == expected_input('candidate', project='Project_A', agent='Agent_A')
        assert_results('candidate', project='Project_A', agent='Agent_A')
        passed('invalid Agent sends no request; eventful revert stays dirty; keyboard editing/Enter, status and refresh preserve applied label/project')

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
        page.locator('#consent').check()
        editor = page.evaluate("JSON.stringify({editing,draftConfidence,pending,fields:['content','provenance','importance','visibility','project'].map(id=>document.getElementById(id).value),consent:document.getElementById('consent').checked})")
        for selector, value in [('#query', 'OTHER'), ('#updated-from', '2024-01-01T00:00:00Z'), ('#updated-before', ''), ('#search-project', 'project_a'), ('#search-agent', 'Agent_A')]:
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
        for field, value in [('updated-from', '2024-01-01T00:00:00Z'), ('search-project', 'Project_A'), ('search-agent', 'Agent_A')]:
            for action in ['#next', '#prev', '#export']:
                submit('candidate', 'TIME_NEEDLE')
                if action == '#prev':
                    with page.expect_response(lambda response: response.url.endswith('/api/call') and response.request.post_data_json.get('operation') == 'search'):
                        page.locator('#next').click()
                    expect(page.locator('#search-applied')).to_contain_text('实时第 2 页')
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
            for action in ['edit', 'project', 'project-revert', 'agent', 'agent-revert', 'navigate', 'refresh', 'lock']:
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
                    elif action in ['agent', 'agent-revert']:
                        page.locator('#search-agent').fill('Agent_A')
                        if action == 'agent-revert':
                            page.locator('#search-agent').fill('')
                    elif action == 'navigate':
                        page.locator('[data-view="lookup"]').click()
                    elif action == 'refresh':
                        with page.expect_response(lambda reply: reply.url.endswith('/api/call') and reply.request.post_data_json.get('operation') == 'search'):
                            page.locator('#refresh').click()
                        expect(page.locator('#search-applied')).to_contain_text('已应用：')
                    else:
                        page.locator('#logout').click()
                    newer = {'message': page.locator('#message').inner_text(), 'summary': page.locator('#search-applied').inner_text(),
                        'ids': read_ids(), 'export_disabled': page.locator('#export').is_disabled()}
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
                assert read_ids() == fired[0]['ids'], 'Late response/error overwrote newer result IDs'
                assert page.locator('#export').is_disabled() == fired[0]['export_disabled']
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

        submit('active', 'TIME_NEEDLE', LOWER, UPPER, project='Project_A', agent='Agent_A')
        page.get_by_role('button', name='编辑', exact=True).first.click()
        page.locator('#content').fill('UNSAVED_SEARCH_TIME_DRAFT')
        page.locator('#provenance').fill('UNSAVED_PROVENANCE')
        page.locator('#project').fill('Independent_Editor')
        page.locator('#consent').check()
        for screenshot_width, label in [(1320, 'desktop'), (390, 'narrow')]:
            page.set_viewport_size({'width': screenshot_width, 'height': 1000})
            page.locator('#search-form').scroll_into_view_if_needed()
            assert page.evaluate('document.documentElement.scrollWidth <= innerWidth + 1'), 'Horizontal overflow at ' + label
            assert_agent_accessibility()
            expect(page.locator('#search-agent')).to_have_value('Agent_A')
            expect(page.locator('#search-project')).to_have_value('Project_A')
            expect(page.locator('#content')).to_have_value('UNSAVED_SEARCH_TIME_DRAFT')
            expect(page.locator('#project')).to_have_value('Independent_Editor')
            for selector in ['#search-project', '#search-agent', '#updated-from', '#updated-before']:
                box = page.locator(selector).bounding_box()
                assert box['x'] >= 0 and box['x'] + box['width'] <= screenshot_width + 1
            page.screenshot(path=str(ARTIFACTS / (tag + '-' + label + '-success.png')), full_page=True)
        passed('1320 desktop and 390 narrow control layout screenshots')
        assert all(request['operation'] in ['info', 'search'] for request in record['requests']), 'A browser write/model or unrelated read was attempted'
        assert len(requests()) < 300, 'Each context must stay below 300 search requests'
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
        record['elapsed_ms'] = round((time.monotonic() - started) * 1000)
        record['page_errors'] = errors
        record['search_count'] = len(requests())
        record['write_requests'] = sum(request['operation'] not in ['info', 'search'] for request in record['requests'])
        context.close()


try:
    ROWS, REPORT['fixture_metadata'] = read_metadata(os.environ['ULTRABRAIN_SEARCH_TIME_EXPECTED_FILE'],
        os.environ['ULTRABRAIN_SEARCH_TIME_EXPECTED_SHA256'], MODE)
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
