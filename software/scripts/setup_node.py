"""Download an official, checksum-verified portable Node LTS into this project."""
import hashlib
import io
import json
from pathlib import Path
import urllib.request
import zipfile

root = Path(__file__).resolve().parents[1]
directory = root / '.tools'
directory.mkdir(exist_ok=True)
releases = json.load(urllib.request.urlopen('https://nodejs.org/dist/index.json', timeout=30))
release = next(item for item in releases if item['version'].startswith('v22.') and item['lts'])
version = release['version']
name = f'node-{version}-win-x64'
destination = directory / name
if not (destination / 'node.exe').exists():
    base = f'https://nodejs.org/dist/{version}/'
    filename = name + '.zip'
    sums = urllib.request.urlopen(base + 'SHASUMS256.txt', timeout=30).read().decode()
    expected = next(line.split()[0] for line in sums.splitlines() if line.split()[-1] == filename)
    data = urllib.request.urlopen(base + filename, timeout=120).read()
    if hashlib.sha256(data).hexdigest() != expected:
        raise RuntimeError('Official archive checksum did not match.')
    with zipfile.ZipFile(io.BytesIO(data)) as archive:
        for member in archive.infolist():
            resolved = (directory / member.filename).resolve()
            if directory.resolve() not in resolved.parents:
                raise RuntimeError('Unexpected archive path.')
        archive.extractall(directory)
print(destination)
