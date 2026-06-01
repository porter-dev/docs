import os, re
from collections import Counter

results = []
for root, dirs, files in os.walk('.'):
    dirs[:] = [d for d in dirs if d not in ('node_modules', '.git')]
    for f in files:
        if not f.endswith('.mdx'):
            continue
        path = os.path.join(root, f)
        with open(path) as fp:
            content = fp.read()
        m = re.match(r'^---\n(.*?)\n---', content, re.DOTALL)
        if not m:
            results.append({'path': path, 'no_frontmatter': True})
            continue
        fm = m.group(1)
        title_m = re.search(r'^title:\s*(.*)$', fm, re.MULTILINE)
        desc_m = re.search(r'^description:\s*(.*)$', fm, re.MULTILINE)
        openapi_m = re.search(r'^openapi:\s*(.*)$', fm, re.MULTILINE)
        title = title_m.group(1).strip().strip('"').strip("'") if title_m else None
        desc = desc_m.group(1).strip().strip('"').strip("'") if desc_m else None
        openapi = openapi_m.group(1).strip() if openapi_m else None
        results.append({
            'path': path,
            'title': title,
            'title_len': len(title) if title else 0,
            'desc': desc,
            'desc_len': len(desc) if desc else 0,
            'openapi': openapi,
        })

desc_counter = Counter()
for r in results:
    if r.get('desc'):
        desc_counter[r['desc']] += 1
dups = {d:c for d,c in desc_counter.items() if c > 1}

print("=== ISSUES ===")
for r in sorted(results, key=lambda x: x['path']):
    issues = []
    if r.get('no_frontmatter'):
        print("NO FRONTMATTER: " + r['path'])
        continue
    is_openapi_op = r.get('openapi') and (' ' in r['openapi']) and not r['openapi'].startswith('.') and not r['openapi'].startswith('/')
    if not r['title'] and not is_openapi_op:
        issues.append("MISSING_TITLE")
    if r['title'] and r['title_len'] > 60:
        issues.append("TITLE_LONG(" + str(r['title_len']) + ")")
    if not r['desc']:
        if not is_openapi_op:
            issues.append("MISSING_DESC")
    else:
        if r['desc_len'] < 130:
            issues.append("DESC_SHORT(" + str(r['desc_len']) + ")")
        if r['desc_len'] > 160:
            issues.append("DESC_LONG(" + str(r['desc_len']) + ")")
        if r['desc'] in dups:
            issues.append("DESC_DUP(" + str(dups[r['desc']]) + ")")
    if issues:
        print(r['path'] + " :: " + str(issues))
        print("  T=" + repr(r['title']))
        print("  D=" + repr(r['desc']))

print("\n=== DUP DESCRIPTIONS ===")
for d, c in dups.items():
    print("(" + str(c) + "x): " + d)
