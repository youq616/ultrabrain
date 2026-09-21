"""Actual browser loads local synthetic PostgreSQL exports; asserts no data upload/query."""
import hashlib
import json
import os
from pathlib import Path
from playwright.sync_api import sync_playwright, expect

origin, token = (os.environ[k] for k in ('ULTRABRAIN_BROWSER_ORIGIN', 'ULTRABRAIN_BROWSER_TOKEN'))
left, right, empty = (Path(os.environ['ULTRABRAIN_INSPECT_'+k]) for k in ('LEFT', 'RIGHT', 'EMPTY'))
checks = 0
with sync_playwright() as p:
    browser = p.chromium.launch(headless=True, args=['--no-sandbox'])
    context = browser.new_context(viewport={'width': 1320, 'height': 1050}, accept_downloads=True)
    page = context.new_page()
    errors, traffic, downloads = [], [], []
    page.on('pageerror', lambda error: errors.append(str(error)))
    page.on('request', lambda r: traffic.append((r.method, r.url)))
    page.on('download', lambda d: downloads.append(d))
    page.goto(origin, wait_until='networkidle')
    page.locator('#token').fill(token)
    page.locator('#login-form button').click()
    expect(page.locator('#workspace')).to_be_visible()
    page.locator('[data-view="lookup"]').click()
    expect(page.locator('#lookup-panel')).to_be_visible()
    page.wait_for_load_state('networkidle')
    page.locator('#content').fill('INSPECTOR_UNSAVED_DRAFT')
    start = len(traffic)

    def open_panel():
        page.locator('#inspector-open').click()
        expect(page.locator('#inspector-panel')).to_be_visible()
    def select(a=left, b=right):
        page.locator('#inspector-left').set_input_files(str(a))
        page.locator('#inspector-right').set_input_files(str(b) if b else [])
    def inspect():
        page.locator('#inspector-consent').check()
        page.locator('#inspector-run').click()
        expect(page.locator('#message')).to_contain_text('内部一致性核验通过')
    def compare():
        page.locator('#inspector-compare-consent').check()
        page.locator('#inspector-compare').click()

    open_panel()
    select()
    expect(page.locator('#inspector-run')).to_be_disabled()
    expect(page.locator('#inspector-summary')).to_have_text('')
    assert len(downloads) == 0
    checks += 1
    inspect()
    expect(page.locator('#inspector-summary')).to_contain_text('左侧：23 条')
    expect(page.locator('#inspector-summary')).to_contain_text('右侧：24 条')
    expect(page.locator('#inspector-details')).to_be_hidden()
    expect(page.locator('#inspector-compare')).to_be_disabled()
    checks += 1
    compare()
    expect(page.locator('#inspector-diff-summary')).to_contain_text('仅左侧 0 · 仅右侧 1 · 字段不同 1 · 完全相同 22')
    expect(page.locator('#inspector-differences article')).to_have_count(2)
    expect(page.locator('#inspector-differences')).not_to_contain_text('BEFORE_LOCAL_ONLY')
    expect(page.locator('#inspector-details')).to_be_hidden()
    checks += 1
    page.locator('#inspector-differences article').filter(has_text='字段不同').get_by_role('button').click()
    expect(page.locator('#inspector-detail-left')).to_contain_text('BEFORE_LOCAL_ONLY_0')
    expect(page.locator('#inspector-detail-right')).to_contain_text('AFTER_LOCAL_ONLY')
    assert page.locator('#inspector-details img, #inspector-details script').count() == 0
    assert page.evaluate('typeof window.inspectorInjected') == 'undefined'
    expect(page.locator('#content')).to_have_value('INSPECTOR_UNSAVED_DRAFT')
    checks += 1
    with page.expect_download() as item:
        page.locator('#inspector-export').click()
    report_text = Path(item.value.path()).read_text(encoding='utf8')
    report = json.loads(report_text)
    assert report['counts'] == {'left_only': 0, 'right_only': 1, 'changed': 1, 'unchanged': 22}
    assert len(report['differences']) == 2 and report['identity_verified'] is False
    for secret in (token, 'BEFORE_LOCAL_ONLY', 'AFTER_LOCAL_ONLY', 'INSPECTOR_UNSAVED_DRAFT'):
        assert secret not in report_text
    checks += 1
    page.locator('#inspector-detail-clear').click()
    expect(page.locator('#inspector-details')).to_be_hidden()
    expect(page.locator('#inspector-detail-left')).to_have_text('')
    page.locator('#inspector-compare-consent').uncheck()
    expect(page.locator('#inspector-differences article')).to_have_count(0)
    expect(page.locator('#inspector-export')).to_be_disabled()
    checks += 1
    # Compare all 24 rows to a true empty export, not a filtered search window.
    select(empty, right)
    inspect()
    compare()
    expect(page.locator('#inspector-differences article')).to_have_count(20)
    page.locator('#inspector-next').click()
    expect(page.locator('#inspector-differences article')).to_have_count(4)
    expect(page.locator('#inspector-next')).to_be_disabled()
    page.locator('#inspector-prev').click()
    expect(page.locator('#inspector-differences article')).to_have_count(20)
    checks += 1
    # Reverse the sides: no implicit chronology/restore inference.
    select(right, left)
    inspect()
    compare()
    expect(page.locator('#inspector-diff-summary')).to_contain_text('仅左侧 1 · 仅右侧 0 · 字段不同 1 · 完全相同 22')
    checks += 1
    for bad, expected in [
        (b'{"format":1,"\\u0066ormat":2}', 'snapshot_file_duplicate_key'),
        (b'\xc3\x28', 'snapshot_file_invalid_utf8'),
        (left.read_bytes().replace(b'BEFORE_LOCAL_ONLY', b'TAMPER_LOCAL_ONLY'), 'memory_snapshot_unconfirmed'),
    ]:
        page.locator('#inspector-left').set_input_files({'name': 'bad.json', 'mimeType': 'application/json', 'buffer': bad})
        page.locator('#inspector-consent').check()
        page.locator('#inspector-run').click()
        expect(page.locator('#message')).to_contain_text(expected)
        expect(page.locator('#inspector-summary')).to_have_text('')
        expect(page.locator('#inspector-details')).to_be_hidden()
        expect(page.locator('#inspector-export')).to_be_disabled()
        checks += 1
    # Independent P2: a malicious local JSON number may decode as Infinity, while
    # its claimed memories digest is identical to a genuine null representation.
    # Build the oracle with Python SHA-256, independently of the browser verifier.
    null_snapshot = json.loads(left.read_bytes())
    null_snapshot['memories'][0]['derivation'] = {'untrusted': [{'n': None}]}
    null_snapshot['memories_sha256'] = hashlib.sha256(json.dumps(
        null_snapshot['memories'], ensure_ascii=False, separators=(',', ':')).encode('utf8')).hexdigest()
    null_bytes = json.dumps(null_snapshot, ensure_ascii=False, separators=(',', ':')).encode('utf8')
    def local_file(data):
        return {'name': 'numeric-boundary.json', 'mimeType': 'application/json', 'buffer': data}
    page.locator('#inspector-left').set_input_files(local_file(null_bytes))
    page.locator('#inspector-right').set_input_files(local_file(null_bytes))
    inspect()
    compare()
    expect(page.locator('#inspector-diff-summary')).to_contain_text('完全相同 23')
    checks += 1
    assert null_bytes.count(b'"n":null') == 1
    for side, literal in [('left', b'1e400'), ('right', b'-1e400')]:
        overflow = null_bytes.replace(b'"n":null', b'"n":'+literal)
        page.locator('#inspector-left').set_input_files(local_file(overflow if side == 'left' else null_bytes))
        page.locator('#inspector-right').set_input_files(local_file(overflow if side == 'right' else null_bytes))
        page.locator('#inspector-consent').check()
        page.locator('#inspector-run').click()
        expect(page.locator('#message')).to_contain_text('memory_snapshot_unconfirmed')
        expect(page.locator('#inspector-summary')).to_have_text('')
        expect(page.locator('#inspector-differences article')).to_have_count(0)
        expect(page.locator('#inspector-details')).to_be_hidden()
        expect(page.locator('#inspector-export')).to_be_disabled()
        assert page.evaluate('inspectorData === null && inspectorReport === null')
        checks += 1
    # Cancellation while the real File read promise is awaiting local delivery.
    select()
    page.evaluate("""() => {window.originalInspectBuffer=File.prototype.arrayBuffer;
      File.prototype.arrayBuffer=async function(){const bytes=await window.originalInspectBuffer.call(this);
      document.documentElement.dataset.inspectWaiting='true';await new Promise(r=>window.releaseInspectRead=r);
      return bytes;};}""")
    page.locator('#inspector-consent').check()
    page.locator('#inspector-run').click()
    expect(page.locator('html')).to_have_attribute('data-inspect-waiting', 'true')
    page.locator('#inspector-cancel').click()
    page.evaluate('window.releaseInspectRead()')
    # Returning the native method here would make Playwright invoke it unbound.
    page.evaluate('() => { File.prototype.arrayBuffer=window.originalInspectBuffer; }')
    expect(page.locator('#inspector-panel')).to_be_hidden()
    expect(page.locator('#inspector-summary')).to_have_text('')
    assert page.evaluate('inspectorData === null')
    checks += 1
    open_panel()
    select(left, None)
    inspect()
    expect(page.locator('#inspector-compare')).to_be_disabled()
    page.locator('#inspector-consent').uncheck()
    expect(page.locator('#inspector-summary')).to_have_text('')
    checks += 1
    select()
    inspect()
    compare()
    if os.environ.get('ULTRABRAIN_INSPECTOR_SCREENSHOT'):
        page.screenshot(path=os.environ['ULTRABRAIN_INSPECTOR_SCREENSHOT'], full_page=True)
    page.set_viewport_size({'width': 390, 'height': 844})
    assert page.evaluate('document.documentElement.scrollWidth <= window.innerWidth')
    page.locator('#logout').click()
    expect(page.locator('#workspace')).to_be_hidden()
    expect(page.locator('#inspector-panel')).to_be_hidden()
    expect(page.locator('#inspector-summary')).to_have_text('')
    assert page.evaluate('inspectorData === null && inspectorReport === null')
    assert page.evaluate('localStorage.length === 0 && sessionStorage.length === 0')
    checks += 1
    # Only static verifier code may be fetched after opening the local inspector.
    assert all(method == 'GET' and url == origin+'/snapshot-contract.mjs' for method, url in traffic[start:])
    assert len(downloads) == 1
    assert not errors, 'Unexpected browser JavaScript error; raw content omitted'
    result = {'passed': True, 'checks': checks, 'browser': 'Chromium '+browser.version,
              'data_requests_during_inspection': 0, 'explicit_report_downloads': 1,
              'scope': 'Actual local files exported from isolated PostgreSQL; local comparison only, no import/write/model call'}
    if os.environ.get('ULTRABRAIN_INSPECTOR_REPORT'):
        Path(os.environ['ULTRABRAIN_INSPECTOR_REPORT']).write_text(json.dumps(result, indent=2)+'\n', encoding='utf8')
    context.close()
    browser.close()
print('PASS', checks, 'real Chromium local snapshot inspection checks; zero data HTTP requests')
