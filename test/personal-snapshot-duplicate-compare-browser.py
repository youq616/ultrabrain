"""Real Chromium/production UI. Default: real loopback HTTP/CSP, synthetic DB.
--offline: synthetic login + Python SHA bridge; explicitly NOT online CSP evidence.
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
           'snapshot-duplicates-ui.js', 'snapshot-duplicate-compare-ui.js', 'lineage-ui.js', 'overview-ui.js']

def compact(value):
    return json.dumps(value, ensure_ascii=False, separators=(',', ':')).encode('utf-8')

def record(n, content):
    return {'id': f'{n:08d}-1111-4111-8111-111111111111', 'type': 'preference', 'origin_kind': 'agent',
            'content': content, 'content_hash': hashlib.sha256(content.encode()).hexdigest(), 'confidence': None,
            'importance': 'normal', 'provenance': 'PRIVATE_PROVENANCE', 'agent_id': 'fixture',
            'project_id': 'project-a' if n % 2 else None, 'status': 'candidate', 'visibility': 'private',
            'revision': 1, 'created_at': '2026-09-21T00:00:00.000Z', 'updated_at': '2026-09-21T00:00:00.000Z',
            'last_confirmed': None, 'owned_by_caller': True, 'derivation': None, 'derivation_current': True,
            'trust': 'untrusted-memory-data'}

def envelope(rows, source='selected'):
    return compact({'format': 'ultrabrain-owned-memories-v1', 'scope': 'owned-memories-all-states',
                    'source_id': source, 'request_id': '00000099-1111-4111-8111-111111111111',
                    'snapshot_at': '2026-09-21T00:00:00.000Z', 'read_only': True, 'complete': True,
                    'record_count': len(rows), 'excluded': ['other-owners', 'document-original-bytes',
                      'jobs-and-event-history', 'host-configuration-and-credentials'],
                    'memories': rows, 'memories_sha256': hashlib.sha256(compact(rows)).hexdigest()})

left = [record(i+1, 'PRIVATE_GROUP_'+str(i//2)) for i in range(48) if i+1 != 4]
right = [record(i+1, 'PRIVATE_GROUP_'+str(i//2)) for i in range(48) if i+1 != 2]
right[3]['status'] = 'archived'
right[3]['provenance'] = 'PRIVATE_PROVENANCE <img src=x onerror=bad()>'
right[3]['derivation'] = {'quote': 'PRIVATE_QUOTE'}
left += [record(i, 'PRIVATE_BIG') for i in range(100, 145)]
right += [record(i, 'PRIVATE_BIG') for i in range(100, 160)]
# Independent Python expected grouping / membership, not a copy of browser state.
contents = list(dict.fromkeys(r['content'] for r in left+right))
oracle = []
for content in contents:
    a, b = [r for r in left if r['content'] == content], [r for r in right if r['content'] == content]
    if len(a) < 2 and len(b) < 2:
        continue
    la, rb = {r['id']: r for r in a}, {r['id']: r for r in b}
    kind = 'left_only' if len(b) < 2 else 'right_only' if len(a) < 2 else 'unchanged' if la == rb else 'changed'
    oracle.append({'kind': kind, 'ids': sorted(set(la) | set(rb)), 'left': len(a), 'right': len(b)})
assert len(oracle) == 25
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
        html = (ROOT/'web/personal/index.html').read_text()
        assert re.findall(r'<script src="/([a-z-]+\.js)" defer></script>', html) == SCRIPTS
        page.set_content(re.sub(r'<script[^>]*>.*?</script>|<link[^>]*>', '', html))
        page.add_style_tag(content=(ROOT/'web/personal/style.css').read_text())
        for script in SCRIPTS:
            page.add_script_tag(content=(ROOT/'web/personal'/script).read_text())
        module = 'data:text/javascript;base64,'+base64.b64encode((ROOT/'src/personal-snapshot-contract.mjs').read_bytes()).decode()
        page.expose_function('testDigest', lambda values: hashlib.sha256(bytes(values)).hexdigest())
        page.evaluate('''async module=>{
          const c=await import(module);loadSnapshotContract=async()=>c;
          sha256Hex=async bytes=>testDigest(Array.from(bytes));
          token='SYNTHETIC';sourceId='selected';view='lookup';$('workspace').hidden=false;$('login').hidden=true;
        }''', module)
    else:
        origin = os.environ['ULTRABRAIN_BROWSER_ORIGIN']
        page.goto(origin, wait_until='networkidle')
        page.locator('#token').fill(os.environ['ULTRABRAIN_BROWSER_TOKEN'])
        page.locator('#login-form button').click()
        expect(page.locator('#workspace')).to_be_visible()
        page.locator('[data-view="lookup"]').click()
        page.wait_for_load_state('networkidle')
    start = len(traffic)
    page.locator('#content').fill('UNSAVED_PRIVATE_DRAFT')

    def select(id, rows, source='selected', raw=None):
        page.locator(id).set_input_files({'name': 'synthetic.json', 'mimeType': 'application/json', 'buffer': envelope(rows, source) if raw is None else raw})

    def prepare(a=left, b=right, source='selected'):
        page.locator('#inspector-open').click()
        select('#inspector-left', a)
        if b is None:
            page.locator('#inspector-right').set_input_files([])
        else:
            select('#inspector-right', b, source)
        expect(page.locator('#dupcmp-open')).to_be_disabled()
        page.locator('#inspector-consent').check()
        page.locator('#inspector-run').click()
        expect(page.locator('#message')).to_contain_text('内部一致性核验通过')

    def open_panel():
        page.locator('#dupcmp-open').click()
        expect(page.locator('#dupcmp-run')).to_be_disabled()
        expect(page.locator('#dupcmp-groups article')).to_have_count(0)

    def scan():
        page.locator('#dupcmp-consent').check()
        page.locator('#dupcmp-run').click()
        expect(page.locator('#message')).to_contain_text('跨快照重复比较完成')
        expect(page.locator('#dupcmp-run')).to_be_enabled()

    def group_indices():
        return page.locator('#dupcmp-groups article').evaluate_all('(nodes)=>nodes.map(n=>Number(n.dataset.groupIndex))')

    def member_ids():
        return page.locator('#dupcmp-members article').evaluate_all('(nodes)=>nodes.map(n=>n.dataset.memoryId)')

    prepare(b=None)
    expect(page.locator('#dupcmp-open')).to_be_disabled()
    checks += 1
    prepare()
    open_panel()
    assert page.evaluate('duplicateCompareReport===null')
    scan()
    expect(page.locator('#dupcmp-summary')).to_contain_text('共 25 组')
    assert group_indices() == list(range(20))
    assert 'PRIVATE_' not in page.locator('#dupcmp-panel').inner_text()
    checks += 1
    page.locator('#dupcmp-next').click()
    assert group_indices() == list(range(20, 25))
    expect(page.locator('#dupcmp-next')).to_be_disabled()
    page.locator('#dupcmp-prev').click()
    checks += 1
    for kind in ('left_only', 'right_only', 'changed', 'unchanged'):
        page.locator('#dupcmp-kind').select_option(kind)
        expect(page.locator('#dupcmp-detail')).to_be_hidden()
        expected = [i for i, group in enumerate(oracle) if group['kind'] == kind]
        observed = group_indices()
        if len(expected) > 20:
            page.locator('#dupcmp-next').click()
            observed += group_indices()
        assert observed == expected
    checks += 1
    page.locator('#dupcmp-kind').select_option('left_only')
    page.locator('#dupcmp-groups article button').first.click()
    expect(page.locator('#dupcmp-detail-summary')).to_contain_text('左侧 2 条')
    expect(page.locator('#dupcmp-detail-summary')).to_contain_text('右侧 1 条')
    assert member_ids() == oracle[0]['ids']
    checks += 1
    page.locator('#dupcmp-kind').select_option('changed')
    page.locator('#dupcmp-groups article button').first.click()
    assert '来源说明' in page.locator('#dupcmp-members').inner_text()
    assert '结构化引用' in page.locator('#dupcmp-members').inner_text()
    assert 'PRIVATE_' not in page.locator('#dupcmp-panel').inner_text()
    assert page.locator('#dupcmp-panel img, #dupcmp-panel script').count() == 0
    checks += 1
    page.locator('#dupcmp-groups article button').last.click()
    members = member_ids()
    page.locator('#dupcmp-members-next').click()
    members += member_ids()
    page.locator('#dupcmp-members-next').click()
    members += member_ids()
    assert members == oracle[-1]['ids']
    expect(page.locator('#dupcmp-members-next')).to_be_disabled()
    page.locator('#dupcmp-members-prev').click()
    checks += 1
    # Silent property replacement cannot silently reuse a prior member page.
    page.locator('#dupcmp-kind').evaluate("n=>n.value='unchanged'")
    page.locator('#dupcmp-members-next').click()
    expect(page.locator('#dupcmp-summary')).to_contain_text('未确认')
    expect(page.locator('#dupcmp-members article')).to_have_count(0)
    checks += 1
    page.locator('#dupcmp-close').click()
    open_panel()
    scan()
    page.locator('#dupcmp-consent').uncheck()
    assert page.evaluate('duplicateCompareReport===null')
    expect(page.locator('#dupcmp-groups article')).to_have_count(0)
    checks += 1
    scan()
    assert page.evaluate('''async()=>{const work=compareDuplicateSnapshots();$('dupcmp-close').click();await work;
      return duplicateCompareReport===null && !duplicateCompareWorking && $('dupcmp-panel').hidden;}''')
    checks += 1
    prepare([], [])
    open_panel()
    scan()
    expect(page.locator('#dupcmp-summary')).to_contain_text('完整比较：左侧 0 条，右侧 0 条；共 0 组')
    checks += 1
    prepare(source='other')
    open_panel()
    page.locator('#dupcmp-consent').check()
    page.locator('#dupcmp-run').click()
    expect(page.locator('#dupcmp-summary')).to_contain_text('来源不同')
    assert page.evaluate('duplicateCompareReport===null')
    checks += 1
    prepare()
    open_panel()
    scan()
    select('#inspector-right', right, raw=envelope(right).replace(b'PRIVATE_GROUP_', b'CORRUPT_GROUP_'))
    expect(page.locator('#dupcmp-panel')).to_be_hidden()
    expect(page.locator('#dupcmp-files')).to_have_text('')
    page.locator('#inspector-consent').check()
    page.locator('#inspector-run').click()
    expect(page.locator('#message')).to_contain_text('memory_snapshot_unconfirmed')
    expect(page.locator('#dupcmp-open')).to_be_disabled()
    checks += 1
    prepare()
    open_panel()
    scan()
    page.locator('#dupcmp-kind').select_option('changed')
    page.locator('#dupcmp-groups article button').first.click()
    page.set_viewport_size({'width': 390, 'height': 844})
    assert page.evaluate('document.documentElement.scrollWidth<=innerWidth')
    if os.environ.get('ULTRABRAIN_COMPARE_UI_MOBILE_SCREENSHOT'):
        page.locator('#dupcmp-panel h3').evaluate("n=>n.scrollIntoView({block:'start'})")
        page.screenshot(path=os.environ['ULTRABRAIN_COMPARE_UI_MOBILE_SCREENSHOT'])
    page.set_viewport_size({'width': 1320, 'height': 1000})
    page.locator('#dupcmp-panel h3').evaluate("n=>n.scrollIntoView({block:'start'})")
    if os.environ.get('ULTRABRAIN_COMPARE_UI_SCREENSHOT'):
        page.screenshot(path=os.environ['ULTRABRAIN_COMPARE_UI_SCREENSHOT'])
    checks += 1
    page.locator('#inspector-consent').uncheck()
    expect(page.locator('#dupcmp-panel')).to_be_hidden()
    assert page.evaluate('duplicateCompareReport===null && duplicateCompareBinding===null')
    expect(page.locator('#content')).to_have_value('UNSAVED_PRIVATE_DRAFT')
    assert page.evaluate('pending===null')
    checks += 1
    if OFFLINE:
        assert not traffic
    else:
        assert all(method == 'GET' and url == origin+'/snapshot-contract.mjs' for method, url in traffic[start:])
        assert page.evaluate('localStorage.length===0 && sessionStorage.length===0')
    assert not errors and not downloads
    checks += 1
    report = {'passed': True, 'checks': checks, 'browser': 'Chromium '+browser.version,
              'mode': 'offline production HTML/CSS/eight scripts; synthetic login and Python SHA-256 bridge; NOT HTTP/CSP' if OFFLINE
                      else 'real production console HTTP/CSP/eight scripts; synthetic startup database, explicit local files',
              'independent_python_grouping': True, 'data_requests_during_comparison': 0, 'downloads': 0,
              'model_calls': 0, 'user_deployment_verified': False}
    if os.environ.get('ULTRABRAIN_COMPARE_UI_REPORT'):
        Path(os.environ['ULTRABRAIN_COMPARE_UI_REPORT']).write_text(json.dumps(report, indent=2)+'\n')
    context.close()
    browser.close()
print('PASS', checks, 'duplicate-comparison UI checks;', report['mode'])
