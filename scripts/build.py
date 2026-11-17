"""Copy only runtime assets; keep docs, tests and credentials out of web output."""
from pathlib import Path
import shutil
root=Path(__file__).resolve().parents[1]
out=root/'dist'
out.mkdir(exist_ok=True)
for name in ['index.html','setup.html','manifest.webmanifest','icon-192.png','apple-touch-icon.png','sw.js']:
    shutil.copy2(root/name,out/name)
for name in ['assets','config']:
    shutil.copytree(root/name,out/name,dirs_exist_ok=True)
import sys
production='--production' in sys.argv
if production:
    source=root/'config/production.js'
    if not source.exists(): raise SystemExit('Production configuration is missing.')
    shutil.copy2(source,out/'config/development.js')
    html=(out/'index.html').read_text().replace('ConstructIQ 2.0 · Development','ConstructIQ 2.0').replace('DEVELOPMENT WORKSPACE','SHARED WORKSPACE').replace('Test data stays on this device · Live projects are disconnected','Projects shared with your team · Offline changes sync when connected').replace('Your development projects. Saved on this device for testing.','Your shared projects. Saved changes sync when connected.').replace('Changes made in this development workspace. A protected, shared audit trail will follow with the test backend.','Shared changes are recorded by the server. Device records remain available offline.').replace('This development workspace is saved on this device. Export includes every referenced attachment or stops with a missing-file error. Keep your own copies of exported backups.','Export includes every referenced attachment or stops with a missing-file error. Imports create restored copies and preserve shared originals.').replace('This development workspace does not sync across devices. Shared accounts will be enabled after the separate test backend is configured.','Use your individual account. Closing the app keeps alerts on; signing out turns them off on this device.')
    (out/'index.html').write_text(html)
    import json
    manifest=json.loads((out/'manifest.webmanifest').read_text());manifest.update(name='ConstructIQ',short_name='ConstructIQ',id='./')
    (out/'manifest.webmanifest').write_text(json.dumps(manifest,indent=2))
    import hashlib
    version=hashlib.sha256(''.join(p.read_text() for p in sorted((out/'assets/js').glob('*.js'))).encode()).hexdigest()[:12]
    worker=(out/'sw.js').read_text().replace('constructiq-development-shell-v4','constructiq-connected-shell-'+version).replace("key.startsWith('constructiq-development-shell-')","(key.startsWith('constructiq-development-shell-')||key.startsWith('constructiq-connected-shell-'))")
    (out/'sw.js').write_text(worker)
print(('Connected' if production else 'Development')+' app prepared in dist/')

# Package a pinned PDF renderer, worker, fonts, CMaps and image codecs for offline use.
import json
package=root/'node_modules/pdfjs-dist'
if not package.exists():
    raise SystemExit('Run npm ci before building: the local PDF renderer is required.')
vendor=out/'assets/vendor/pdfjs'
vendor.mkdir(parents=True,exist_ok=True)
for name in ['pdf.mjs','pdf.worker.mjs']:
    shutil.copy2(package/'legacy/build'/name,vendor/name)
for name in ['cmaps','standard_fonts','wasm']:
    if (package/name).exists(): shutil.copytree(package/name,vendor/name,dirs_exist_ok=True)
shutil.copy2(package/'LICENSE',vendor/'LICENSE')
resources=sorted(str(p.relative_to(out)) for p in vendor.rglob('*') if p.is_file())
(out/'assets/pdf-assets.js').write_text('const CI_PDF_ASSETS='+json.dumps(resources)+';\n')
print('Packaged PDF renderer and '+str(len(resources))+' offline assets.')
