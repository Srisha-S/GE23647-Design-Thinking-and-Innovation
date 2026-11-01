"""Run npm using this project's portable Node, or a normal Node installation."""
import os
from pathlib import Path
import shutil
import subprocess
import sys

root = Path(__file__).resolve().parents[1]
portable = sorted((root / '.tools').glob('node-*-win-x64/node.exe'), reverse=True)
environment = os.environ.copy()
if portable:
    node = portable[0]
    environment['PATH'] = str(node.parent) + os.pathsep + environment.get('PATH', '')
    command = [str(node), str(node.parent / 'node_modules/npm/bin/npm-cli.js')]
else:
    npm = shutil.which('npm.cmd') or shutil.which('npm')
    if not npm:
        sys.exit('Install Node.js 22.12+ or run python scripts/setup_node.py first.')
    command = [npm]
try:
    sys.exit(subprocess.call(command + sys.argv[1:], cwd=root, env=environment))
except KeyboardInterrupt:
    sys.exit(130)
