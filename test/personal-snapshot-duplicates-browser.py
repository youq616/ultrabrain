"""Production duplicate-review UI. Offline mode substitutes login and SHA-256 IO only.
Default mode loads real console HTTP/CSP; the launcher's database is synthetic.
Neither mode is a live-user deployment or independent code reviewer.
"""
import base64
import hashlib
import json
import os
from pathlib import Path
import re
import sys
from playwright.sync_api import sync_playwright, expect

ROOT = Path(__file__).resolve().parent.parent
OFFLINE = '--offline' in sys.argv
SCRIPTS = ['app.js', 'snapshot-ui.js', 'snapshot-inspector-ui.js', 'snapshot-explorer-ui.js',
           'snapshot-duplicates-ui.js', 'lineage-ui.js', 'overview-ui.js']

def encode(value):
    return json.dumps(value, ensure_ascii=False, separators=(',', ':')).encode('utf-8')

def record(number, text):
    return {'id': f'{number:08d}-1111-4111-8111-111111111111', 'type': 'preference', 'origin_kind': 'agent',
            'content': text, 'content_hash': hashlib.sha256(text.encode()).hexdigest(), 'confidence': None,
            'importance': 'normal', 'provenance': 'PRIVATE_PROVENANCE <b>not markup</b>', 'agent_id': 'fixture',
            'project_id': None if number % 2 else 'other-project',
            'status': ['candidate', 'active', 'archived'][number % 3], 'visibility': 'source' if number % 2 else 'private',
            'revision': 1, 'created_at': '2026-09-21T00:00:00.000Z', 'updated_at': '2026-09-21T00:00:00.000Z',
            'last_confirmed': None, 'owned_by_caller': True, 'derivation': None, 'derivation_current': True,
            'trust': 'untrusted-memory-data'}

def envelope(rows):
    return encode({'format': 'ultrabrain-owned-memories-v1', 'scope': 'owned-memories-all-states',
                   'source_id': 'selected', 'request_id': '00000099-1111-4111-8111-111111111111',
                   'snapshot_at': '2026-09-21T00:00:00.000Z', 'read_only': True, 'complete': True,
                   'record_count': len(rows),
                   'excluded': ['other-owners', 'document-original-bytes', 'jobs-and-event-history', 'host-configuration-and-credentials'],
                   'memories': rows, 'memories_sha256': hashlib.sha256(encode(rows)).hexdigest()})

body = 'PRIVATE_DUPLICATE <img src=x onerror="window.duplicateInjected=1">\r\n🙂'
left = [record(i + 1, body if i < 2 else f'PRIVATE_GROUP_{i // 2}') for i in range(46)]
left += [record(i, body) for i in range(47, 70)]
right = [record(1, 'RIGHT_PRIVATE'), record(2, 'RIGHT_PRIVATE')]
# Independent Python grouping, not a copy of the JavaScript report.
groups = {}
for item in left:
    groups.setdefault(item['content'], []).append(item)
oracle = [rows for rows in groups.values() if len(rows) > 1]
checks = 0
with sync_playwright() as p:
    options = {'headless': True, 'args': ['--no-sandbox']}
    if os.environ.get('ULTRABRAIN_CHROMIUM'):
        options['executable_path'] = os.environ['ULTRABRAIN_CHROMIUM']
    browser = p.chromium.launch(**options)
    context = browser.new_context(viewport={'width': 1320, 'height': 1000})
    page = context.new_page()
    errors, traffic, downloads = [], [], []
    page.on('pageerror', lambda e: errors.append(str(e)))
    page.on('request', lambda r: traffic.append((r.method, r.url)))
    page.on('download', lambda d: downloads.append(d))
    if OFFLINE:
        html = (ROOT / 'web/personal/index.html').read_text()
        assert re.findall(r'<script src="/([a-z-]+\.js)" defer></script>', html) == SCRIPTS
        html = re.sub(r'<script[^>]*>.*?</script>|<link[^>]*>', '', html)
        page.set_content(html)
        page.add_style_tag(content=(ROOT / 'web/personal/style.css').read_text())
        for name in SCRIPTS:
            page.add_script_tag(content=(ROOT / 'web/personal' / name).read_text())
        module = 'data:text/javascript;base64,' + base64.b64encode((ROOT / 'src/personal-snapshot-contract.mjs').read_bytes()).decode()
        # Opaque about:blank lacks WebCrypto.subtle. Use actual Python SHA-256,
        # explicitly marked as test-only instead of pretending this is online crypto.
        page.expose_function('offlineDigest', lambda values: hashlib.sha256(bytes(values)).hexdigest())
        page.evaluate('''async module => {
          const contract = await import(module); loadSnapshotContract=async()=>contract;
          sha256Hex=async bytes=>offlineDigest(Array.from(bytes));
          token='SYNTHETIC_TOKEN';sourceId='selected';view='lookup';
          $('workspace').hidden=false;$('login').hidden=true;
        }''', module)
    else:
        origin = os.environ['ULTRABRAIN_BROWSER_ORIGIN']
        page.goto(origin, wait_until='networkidle')
        page.locator('#token').fill(os.environ['ULTRABRAIN_BROWSER_TOKEN'])
        page.locator('#login-form button').click()
        expect(page.locator('#workspace')).to_be_visible()
        page.locator('[data-view="lookup"]').click()
        page.wait_for_load_state('networkidle')
    page.locator('#content').fill('DUPLICATE_UNSAVED_DRAFT')
    start = len(traffic)

    def select_file(selector, rows, raw=None):
        page.locator(selector).set_input_files({'name': 'synthetic.json', 'mimeType': 'application/json', 'buffer': raw or envelope(rows)})

    def prepare(rows=left, second=right):
        page.locator('#inspector-open').click()
        select_file('#inspector-left', rows)
        if second is None:
            page.locator('#inspector-right').set_input_files([])
        else:
            select_file('#inspector-right', second)
        expect(page.locator('#duplicates-open')).to_be_disabled()
        page.locator('#inspector-consent').check()
        page.locator('#inspector-run').click()
        expect(page.locator('#message')).to_contain_text('内部一致性核验通过')
        page.locator('#duplicates-open').click()
        expect(page.locator('#duplicates-run')).to_be_disabled()
        expect(page.locator('#duplicates-groups article')).to_have_count(0)

    def scan():
        page.locator('#duplicates-consent').check()
        page.locator('#duplicates-run').click()
        expect(page.locator('#message')).to_contain_text('重复组扫描完成')
        expect(page.locator('#duplicates-run')).to_be_enabled()

    def group_ids():
        return page.locator('#duplicates-groups article').evaluate_all('(nodes)=>nodes.map(n=>n.dataset.groupId)')

    def member_ids():
        return page.locator('#duplicates-members article').evaluate_all('(nodes)=>nodes.map(n=>n.dataset.memoryId)')

    prepare()
    checks += 1
    scan()
    expect(page.locator('#duplicates-summary')).to_contain_text('扫描 69 条；发现 23 组')
    assert group_ids() == [group[0]['id'] for group in oracle[:20]]
    assert 'PRIVATE_DUPLICATE' not in page.locator('#duplicates-groups').inner_text()
    expect(page.locator('#duplicates-detail')).to_be_hidden()
    checks += 1
    page.locator('#duplicates-next').click()
    assert group_ids() == [group[0]['id'] for group in oracle[20:]]
    expect(page.locator('#duplicates-next')).to_be_disabled()
    page.locator('#duplicates-prev').click()
    checks += 1
    page.locator('#duplicates-groups article button').first.click()
    assert member_ids() == [row['id'] for row in oracle[0][:20]]
    expect(page.locator('#duplicates-members article button').first).to_be_disabled()
    assert 'PRIVATE_PROVENANCE' not in page.locator('#duplicates-members').inner_text()
    checks += 1
    page.locator('#duplicates-text-consent').check()
    page.locator('#duplicates-members article button').first.click()
    assert json.loads(page.locator('#duplicates-detail-text').inner_text()) == oracle[0][0]
    assert page.locator('#duplicates-detail-text img, #duplicates-detail-text script, #duplicates-detail-text b').count() == 0
    assert page.evaluate('typeof window.duplicateInjected') == 'undefined'
    checks += 1
    page.locator('#duplicates-members-next').click()
    assert member_ids() == [row['id'] for row in oracle[0][20:]]
    expect(page.locator('#duplicates-detail-text')).to_have_text('')
    expect(page.locator('#duplicates-text-consent')).not_to_be_checked()
    expect(page.locator('#duplicates-members-next')).to_be_disabled()
    page.locator('#duplicates-members-prev').click()
    checks += 1
    page.locator('#duplicates-text-consent').check()
    page.locator('#duplicates-members article button').first.click()
    page.locator('#duplicates-text-consent').uncheck()
    expect(page.locator('#duplicates-detail-text')).to_have_text('')
    page.locator('#duplicates-consent').uncheck()
    expect(page.locator('#duplicates-groups article')).to_have_count(0)
    assert page.evaluate('duplicateReport===null')
    checks += 1
    page.locator('#duplicates-side').select_option('right')
    expect(page.locator('#duplicates-consent')).not_to_be_checked()
    scan()
    expect(page.locator('#duplicates-summary')).to_contain_text('右侧快照扫描 2 条；发现 1 组')
    page.locator('#duplicates-groups article button').first.click()
    page.locator('#duplicates-text-consent').check()
    page.locator('#duplicates-members article button').first.click()
    assert json.loads(page.locator('#duplicates-detail-text').inner_text())['content'] == 'RIGHT_PRIVATE'
    checks += 1
    # Cancel the actual yielding algorithm; do not inject a fake successful report.
    assert page.evaluate('''async()=>{
      const work=scanDuplicateSnapshot();$('duplicates-close').click();await work;
      return duplicateReport===null && !duplicateWorking && $('duplicates-panel').hidden;
    }''')
    checks += 1
    prepare([], None)
    scan()
    expect(page.locator('#duplicates-summary')).to_contain_text('扫描 0 条；发现 0 组')
    expect(page.locator('#duplicates-next')).to_be_disabled()
    checks += 1
    prepare()
    scan()
    page.locator('#duplicates-groups article button').first.click()
    page.locator('#duplicates-text-consent').check()
    page.locator('#duplicates-members article button').first.click()
    select_file('#inspector-left', left, envelope(left).replace(b'PRIVATE_DUPLICATE', b'CORRUPT_DUPLICATE'))
    expect(page.locator('#duplicates-panel')).to_be_hidden()
    expect(page.locator('#duplicates-detail-text')).to_have_text('')
    page.locator('#inspector-consent').check()
    page.locator('#inspector-run').click()
    expect(page.locator('#message')).to_contain_text('memory_snapshot_unconfirmed')
    expect(page.locator('#duplicates-open')).to_be_disabled()
    checks += 1
    prepare()
    scan()
    page.locator('#duplicates-groups article button').first.click()
    page.locator('#duplicates-text-consent').check()
    page.locator('#duplicates-members article button').first.click()
    page.set_viewport_size({'width': 390, 'height': 844})
    assert page.evaluate('document.documentElement.scrollWidth<=innerWidth'), 'Horizontal overflow'
    page.locator('#duplicates-detail-clear').click()
    expect(page.locator('#duplicates-detail-text')).to_have_text('')
    page.set_viewport_size({'width': 1320, 'height': 1000})
    # Screenshot is a bounded viewport, not the full multi-page list.
    page.locator('#duplicates-panel h3').evaluate("n=>n.scrollIntoView({block:'start'})")
    if os.environ.get('ULTRABRAIN_DUPLICATE_SCREENSHOT'):
        page.screenshot(path=os.environ['ULTRABRAIN_DUPLICATE_SCREENSHOT'])
    checks += 1
    page.locator('#inspector-consent').uncheck()
    expect(page.locator('#duplicates-panel')).to_be_hidden()
    assert page.evaluate('duplicateReport===null && duplicateBinding===null')
    expect(page.locator('#content')).to_have_value('DUPLICATE_UNSAVED_DRAFT')
    checks += 1
    if OFFLINE:
        assert not traffic
    else:
        assert all(method=='GET' and url==origin+'/snapshot-contract.mjs' for method,url in traffic[start:])
        assert page.evaluate('localStorage.length===0 && sessionStorage.length===0')
    assert not errors and not downloads
    checks += 1
    report = {'passed': True, 'checks': checks, 'browser': 'Chromium '+browser.version,
              'mode': 'offline production DOM and seven scripts; synthetic login and Python SHA-256 bridge; NOT live HTTP/CSP' if OFFLINE
                      else 'real production console HTTP/CSP and seven scripts; synthetic database and selected local files',
              'python_grouping_oracle': True, 'data_requests_during_review': 0, 'downloads': 0,
              'model_calls': 0, 'user_environment_verified': False}
    if os.environ.get('ULTRABRAIN_DUPLICATE_REPORT'):
        Path(os.environ['ULTRABRAIN_DUPLICATE_REPORT']).write_text(json.dumps(report, indent=2)+'\n')
    context.close()
    browser.close()
print('PASS', checks, 'duplicate-review Chromium checks;', report['mode'])
