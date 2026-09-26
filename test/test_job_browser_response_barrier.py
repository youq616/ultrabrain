"""Execute the production browser-fixture loop with delayed synthetic responses.
This is a deterministic test-harness regression, NOT real HTTP/Chromium evidence.
"""
import ast
import copy
import json
import unittest
from pathlib import Path
from types import SimpleNamespace


class Response:
    def __init__(self, page, data):
        self.page, self.data = page, data
        self.ok = True
        self.url = 'http://fixture.invalid/api/call'
        self.request = SimpleNamespace(method='POST', post_data_json={'operation': 'jobs'})

    def json(self):
        return copy.deepcopy(self.data)

    def finished(self):
        self.page.finished_count += 1
        self.page.coverage = '本次任务列表未确认'
        self.page.message = 'job_page_unconfirmed'


class Route:
    def __init__(self, page):
        self.page = page
        self.request = SimpleNamespace(post_data_json={'operation': 'jobs'})

    def fetch(self):
        return Response(self.page, {'result': {'source_id': 'owner', 'jobs': [
            {'created_at': '2026-09-26T00:00:00.000Z'}]}})

    def fulfill(self, *, status, content_type, body):
        assert status == 200 and content_type == 'application/json'
        data = json.loads(body)
        self.page.delivered.append(data)
        self.page.response = Response(self.page, data)
        # Browser delivery and handler completion are separately observed.
        self.page.callback_pending = True


class ResponseWait:
    def __init__(self, page, predicate):
        self.page, self.predicate = page, predicate
        self.value = None

    def __enter__(self):
        self.page.response_waits += 1
        return self

    def __exit__(self, exc_type, exc, tb):
        if exc_type:
            return False
        assert self.page.request_pending, 'Response waiter must cover the click'
        self.page.handler(Route(self.page))
        assert self.predicate(self.page.response)
        self.page.request_pending = False
        self.value = self.page.response
        return False


class Locator:
    def __init__(self, page, selector):
        self.page, self.selector = page, selector

    def click(self):
        assert self.selector == '#job-form button[type="submit"]'
        self.page.clicks += 1
        self.page.request_pending = True
        # The next request starts with old error text and empty results.
        self.page.coverage = '正在核对整理任务元数据'

    def to_contain_text(self, text):
        actual = self.page.coverage if self.selector == '#coverage' else self.page.message
        assert text in actual

    def to_have_count(self, count):
        assert self.selector == '#results article' and count == 0

    def to_be_disabled(self):
        assert self.selector == '#export'


class DelayedPage:
    def __init__(self):
        self.message = 'job_page_unconfirmed'  # intentionally stale and misleading
        self.coverage = '本次任务列表未确认'
        self.handler = self.response = None
        self.request_pending = self.callback_pending = False
        self.delivered = []
        self.response_waits = self.finished_count = self.drains = self.clicks = 0

    def route(self, pattern, handler):
        assert pattern == '**/api/call' and self.handler is None
        self.handler = handler

    def locator(self, selector):
        return Locator(self, selector)

    def expect_response(self, predicate):
        return ResponseWait(self, predicate)

    def unroute(self, pattern, handler):
        assert not self.request_pending and not self.callback_pending, \
            'stale DOM state cannot authorize removing an active response handler'
        self.handler = None

    def unroute_all(self, *, behavior):
        assert behavior == 'wait', 'Errors may not be silently ignored'
        assert not self.request_pending, 'Wait for the selected response first'
        self.callback_pending = False
        self.handler = None
        self.drains += 1


def corruption_loop(source):
    tree = ast.parse(source)
    matches = [node for node in ast.walk(tree) if isinstance(node, ast.For)
               and isinstance(node.target, ast.Name) and node.target.id == 'damage']
    assert len(matches) == 1
    return compile(ast.fix_missing_locations(ast.Module(body=matches, type_ignores=[])),
                   '<actual-job-browser-corruption-loop>', 'exec')


class BrowserResponseBarrierTests(unittest.TestCase):
    def test_each_damage_round_observes_its_own_response_and_drains_handler(self):
        source = (Path(__file__).parent / 'personal-job-manager-browser.py').read_text()
        page = DelayedPage()
        env = {'page': page, 'expect': lambda locator: locator, 'json': json, 'checks': 0}
        exec(corruption_loop(source), env)
        self.assertEqual(env['checks'], 2)
        self.assertEqual((page.clicks, page.response_waits, page.finished_count, page.drains),
                         (2, 2, 2, 2))
        self.assertEqual(page.delivered[0]['result']['jobs'][0]['created_at'],
                         '2026-02-30T00:00:00.000Z')
        self.assertEqual(page.delivered[1]['result']['source_id'], 'foreign')
        self.assertFalse(page.request_pending or page.callback_pending)


if __name__ == '__main__':
    unittest.main()
