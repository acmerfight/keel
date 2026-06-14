import re
import sys
from pathlib import Path

path = Path(sys.argv[1])
html = path.read_text()
html = re.sub(r"<script.*?</script>", "", html, flags=re.DOTALL)
html = re.sub(r"\son[a-z]+\s*=\s*\"[^\"]*\"", "", html)
html = re.sub(r"\sjavascript:[^\"'> ]+", "", html)
path.write_text(html)
