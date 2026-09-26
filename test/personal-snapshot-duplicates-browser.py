"""Real Chromium UI. --offline loads production assets with a Python SHA-256 bridge;
normal mode uses the production authenticated console and native browser WebCrypto.
Snapshot inputs are synthetic; this test performs no live-memory queries or writes.
"""
import base64
import hashlib
import json
import os
from pathlib import Path
import re
import sys
import tempfile
from playwright.sync_api import sync_playwright, expect

ROOT = Path(__file__).resolve().parent.parent
OFFLINE = '--offline' in sys.argv
checks = 0

def compact(value):
    return json.dumps(value, ensure_ascii=False, separators=(',', ':'))

def digest(text):
    return hashlib.sha256(text.encode('utf-8')).hexdigest()

def row(i, content):
    return dict(id=f'{i:08d}-1111-4111-8111-111111111111', type='preference', origin_kind='agent',
                content=content, content_hash=digest(content), confidence=None, importance='normal',
                provenance='PRIVATE_ORIGIN_' + str(i), agent_id='fixture', project_id='other' if i % 2 else None,
                status=('candidate', 'active', 'archived')[i % 3], visibility='source' if i % 2 else 'private',
                revision=1, created_at='2026-09-26T00:00:00.000Z', updated_at='2026-09-26T00:00:00.000Z',
                last_confirmed=None, owned_by_caller=True, derivation=None, derivation_current=True,
                trust='untrusted-memory-data')

def snapshot(rows):
    return dict(format='ultrabrain-owned-memories-v1', scope='owned-memories-all-states', source_id='selected',
                request_id='11111111-1111-4111-8111-111111111111', snapshot_at='2026-09-26T00:00:00.000Z',
                read_only=True, complete=True, record_count=len(rows),
                excluded=['other-owners', 'document-original-bytes', 'jobs-and-event-history', 'host-configuration-and-credentials'],
                memories=rows, memories_sha256=digest(compact(rows)))

rows = [row(i, '<img src=x onerror="window.duplicateInjected=true">PRIVATE_BODY 中文🙂' if i <= 45 else
            'PRIVATE_GROUP_' + str((i - 46) // 2) if i <= 85 else 'PRIVATE_UNIQUE_' + str(i)) for i in range(1, 88)]
right_rows = [row(1, 'right_same'), row(2, 'right_same')]
# Independent Python grouping oracle, not derived from the JavaScript report.
oracle = {}
for record in rows:
    oracle.setdefault(record['content'], []).append(record)
expected_groups = [members for members in oracle.values() if len(members) > 1]

with tempfile.TemporaryDirectory(prefix='ub-duplicate-browser-') as tmp, sync_playwright() as p:
    tmp = Path(tmp)
    paths = {}
    for name, records in [('left', rows), ('right', right_rows), ('empty', [])]:
        paths[name] = tmp / (name + '.json')
        paths[name].write_text(json.dumps(snapshot(records), ensure_ascii=False, indent=2), encoding='utf-8')
    original_files = {name: (path.read_bytes(), path.stat().st_mtime_ns) for name, path in paths.items()}
    damaged = snapshot(rows)
    damaged['memories'][-1]['content'] = 'PRIVATE_CORRUPTION_OUTSIDE_GROUP'
    paths['bad'] = tmp / 'bad.json'
    paths['bad'].write_text(compact(damaged), encoding='utf-8')
    options = dict(headless=True, args=['--no-sandbox'])
    if os.environ.get('ULTRABRAIN_CHROMIUM'):
        options['executable_path'] = os.environ['ULTRABRAIN_CHROMIUM']
    browser = p.chromium.launch(**options)
    context = browser.new_context(viewport={'width': 1320, 'height': 1000}, accept_downloads=True)
    page = context.new_page()
    errors, traffic, downloads = [], [], []
    page.on('pageerror', lambda e: errors.append(str(e)))
    page.on('request', lambda r: traffic.append((r.method, r.url)))
    page.on('download', lambda d: downloads.append(d))
    if OFFLINE:
        html = (ROOT / 'web/personal/index.html').read_text()
        scripts = re.findall(r'<script src="/([a-z-]+\.js)" defer></script>', html)
        assert scripts == ['app.js', 'snapshot-ui.js', 'snapshot-inspector-ui.js', 'snapshot-explorer-ui.js',
                           'lineage-ui.js', 'overview-ui.js', 'snapshot-duplicates-ui.js']
        page.set_content(re.sub(r'<script[^>]*>.*?</script>|<link[^>]*>', '', html))
        page.add_style_tag(content=(ROOT / 'web/personal/style.css').read_text())
        for script in scripts:
            page.add_script_tag(content=(ROOT / 'web/personal' / script).read_text())
        module = 'data:text/javascript;base64,' + base64.b64encode((ROOT / 'src/personal-snapshot-contract.mjs').read_bytes()).decode()
        # about:blank lacks WebCrypto in this runner; bridge only the real digest.
        page.expose_function('fixtureSHA', lambda data: hashlib.sha256(bytes(data)).hexdigest())
        page.evaluate('''async module=>{
          const contract=await import(module);loadSnapshotContract=async()=>contract;
          sha256Hex=async bytes=>fixtureSHA(Array.from(bytes));
          token='SYNTHETIC';sourceId='selected';view='lookup';
          document.getElementById('workspace').hidden=false;document.getElementById('login').hidden=true;
          fetch=()=>{throw Error('Unexpected data transport in offline browser test');};
        }''', module)
    else:
        page.goto(os.environ['ULTRABRAIN_BROWSER_ORIGIN'], wait_until='networkidle')
        page.locator('#token').fill(os.environ['ULTRABRAIN_BROWSER_TOKEN'])
        page.locator('#login-form button').click()
        expect(page.locator('#workspace')).to_be_visible()
        page.locator('[data-view="lookup"]').click()
        page.wait_for_load_state('networkidle')
    page.locator('#content').fill('DUPLICATES_UNSAVED_DRAFT')
    traffic_start = len(traffic)

    def prepare(left='left', right='right'):
        page.locator('#inspector-open').click()
        page.locator('#inspector-left').set_input_files(str(paths[left]))
        page.locator('#inspector-right').set_input_files(str(paths[right]) if right else [])
        expect(page.locator('#duplicates-open')).to_be_disabled()
        page.locator('#inspector-consent').check()
        page.locator('#inspector-run').click()
        expect(page.locator('#message')).to_contain_text('内部一致性核验通过')
        page.locator('#duplicates-open').click()
        expect(page.locator('#duplicates-panel')).to_be_visible()
        expect(page.locator('#duplicates-groups article')).to_have_count(0)
        expect(page.locator('#duplicates-run')).to_be_disabled()

    def scan():
        page.locator('#duplicates-consent').check()
        page.locator('#duplicates-run').click()
        expect(page.locator('#message')).to_contain_text('重复审阅扫描完成')
        expect(page.locator('#duplicates-run')).to_be_enabled()

    prepare()
    checks += 1
    scan()
    report = page.evaluate('duplicateReport')
    assert [g['member_count'] for g in report['groups']] == [len(g) for g in expected_groups]
    assert [[m['id'] for m in g['members']] for g in report['groups']] == [[m['id'] for m in g] for g in expected_groups]
    assert report['merge_safe'] is False and report['references_compared'] is False
    expect(page.locator('#duplicates-groups article')).to_have_count(10)
    assert 'PRIVATE_BODY' not in page.locator('#duplicates-groups').inner_text()
    expect(page.locator('#duplicates-detail')).to_be_hidden()
    checks += 1
    page.locator('#duplicates-group-next').click()
    expect(page.locator('#duplicates-groups article')).to_have_count(10)
    page.locator('#duplicates-group-next').click()
    expect(page.locator('#duplicates-groups article')).to_have_count(1)
    expect(page.locator('#duplicates-group-next')).to_be_disabled()
    page.locator('#duplicates-group-prev').click()
    page.locator('#duplicates-group-prev').click()
    checks += 1
    page.locator('#duplicates-groups article').nth(0).get_by_role('button').click()
    expect(page.locator('#duplicates-members article')).to_have_count(20)
    seen = [x.locator('strong').inner_text() for x in page.locator('#duplicates-members article').all()]
    while page.locator('#duplicates-member-next').is_enabled():
        page.locator('#duplicates-member-next').click()
        seen += [x.locator('strong').inner_text() for x in page.locator('#duplicates-members article').all()]
    assert seen == [r['id'] for r in expected_groups[0]]
    checks += 1
    page.locator('#duplicates-groups article').nth(1).get_by_role('button').click()
    expect(page.locator('#duplicates-members article')).to_have_count(2)
    page.locator('#duplicates-groups article').nth(0).get_by_role('button').click()
    expect(page.locator('#duplicates-members article')).to_have_count(20)
    checks += 1
    page.locator('#duplicates-members article').first.get_by_role('button').nth(0).click()
    page.locator('#duplicates-member-next').click()
    page.locator('#duplicates-members article').first.get_by_role('button').nth(1).click()
    expect(page.locator('#duplicates-compare')).to_be_disabled()
    page.locator('#duplicates-detail-consent').check()
    page.locator('#duplicates-compare').click()
    expect(page.locator('#duplicates-detail')).to_be_visible()
    assert json.loads(page.locator('#duplicates-detail-a').inner_text()) == rows[0]
    assert json.loads(page.locator('#duplicates-detail-b').inner_text()) == rows[20]
    assert page.locator('#duplicates-detail img, #duplicates-detail script').count() == 0
    assert page.evaluate('typeof window.duplicateInjected') == 'undefined'
    expect(page.locator('#content')).to_have_value('DUPLICATES_UNSAVED_DRAFT')
    checks += 1
    page.set_viewport_size({'width': 390, 'height': 844})
    assert page.evaluate('document.documentElement.scrollWidth<=innerWidth')
    page.set_viewport_size({'width': 1320, 'height': 1000})
    checks += 1
    page.locator('#duplicates-member-prev').click()
    expect(page.locator('#duplicates-detail-a')).to_have_text('')
    expect(page.locator('#duplicates-detail-consent')).not_to_be_checked()
    expect(page.locator('#duplicates-a-id')).to_have_text(rows[0]['id'])
    checks += 1
    page.locator('#duplicates-side').select_option('right')
    expect(page.locator('#duplicates-consent')).not_to_be_checked()
    expect(page.locator('#duplicates-groups article')).to_have_count(0)
    scan()
    assert page.evaluate('duplicateReport.counts.groups') == 1
    checks += 1
    page.locator('#duplicates-consent').uncheck()
    expect(page.locator('#duplicates-groups article')).to_have_count(0)
    assert page.evaluate('duplicateReport===null')
    scan()
    page.locator('#explorer-open').click()
    expect(page.locator('#duplicates-panel')).to_be_hidden()
    checks += 1
    prepare('empty', None)
    scan()
    assert page.evaluate('duplicateReport.scanned_records===0 && duplicateReport.counts.groups===0')
    expect(page.locator('#duplicates-summary')).to_contain_text('扫描 0 条')
    checks += 1
    prepare()
    # Deterministic delivery delay around the real shared scanner for cancellation.
    page.evaluate('''()=>{
      const original=inspectorData.contract.inspectMemorySnapshotDuplicates;
      inspectorData.contract={...inspectorData.contract,inspectMemorySnapshotDuplicates:async(...args)=>{
        await new Promise(r=>window.releaseDuplicate=r);return original(...args);
      }};
    }''')
    page.locator('#duplicates-consent').check()
    page.locator('#duplicates-run').click()
    page.wait_for_function('duplicateWorking')
    page.locator('#duplicates-close').click()
    page.evaluate('releaseDuplicate()')
    page.wait_for_function('!duplicateWorking')
    assert page.evaluate('duplicateReport===null')
    expect(page.locator('#duplicates-groups article')).to_have_count(0)
    checks += 1
    prepare()
    scan()
    page.locator('#inspector-consent').uncheck()
    expect(page.locator('#duplicates-panel')).to_be_hidden()
    assert page.evaluate('duplicateReport===null && duplicateBinding===null')
    checks += 1
    page.locator('#inspector-left').set_input_files(str(paths['bad']))
    page.locator('#inspector-consent').check()
    page.locator('#inspector-run').click()
    expect(page.locator('#message')).to_contain_text('核验未完成')
    expect(page.locator('#duplicates-open')).to_be_disabled()
    checks += 1
    prepare()
    scan()
    if os.environ.get('ULTRABRAIN_DUPLICATE_REVIEW_SCREENSHOT'):
        page.locator('#duplicates-panel').screenshot(path=os.environ['ULTRABRAIN_DUPLICATE_REVIEW_SCREENSHOT'])
    page.locator('#duplicates-close').click()
    expect(page.locator('#content')).to_have_value('DUPLICATES_UNSAVED_DRAFT')
    assert page.evaluate('pending===null')
    # Loading static contract code is permitted; no memory queries or file upload.
    assert not [request for request in traffic[traffic_start:] if request[0] != 'GET']
    assert not errors and not downloads
    if not OFFLINE:
        assert page.evaluate('localStorage.length===0 && sessionStorage.length===0')
    for name, (original, timestamp) in original_files.items():
        assert paths[name].read_bytes() == original and paths[name].stat().st_mtime_ns == timestamp
    checks += 1
    report = dict(passed=True, checks=checks, browser='Chromium ' + browser.version,
                  mode='offline production DOM/scripts, real selected files, Python SHA-256 bridge' if OFFLINE else
                       'authenticated console HTTP/CSP, browser WebCrypto, synthetic source existence only',
                  actual_postgresql=False, private_file_uploads=0, memory_queries=0, model_calls=0, downloads=0)
    if os.environ.get('ULTRABRAIN_DUPLICATE_REVIEW_REPORT'):
        Path(os.environ['ULTRABRAIN_DUPLICATE_REVIEW_REPORT']).write_text(json.dumps(report, indent=2) + '\n')
    context.close()
    browser.close()
print('PASS', checks, 'real Chromium duplicate-review checks;', report['mode'])
