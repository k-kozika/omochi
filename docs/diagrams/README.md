# Architecture diagram exports

The editable sources are the ten Mermaid blocks in
[`../architecture.md`](../architecture.md). SVG exports let readers zoom into
individual diagrams without a Markdown renderer. The PNG overview is provided
for viewers that cannot display SVG.

| Diagram | Export |
| --- | --- |
| Runtime system map | [SVG](architecture-overview.svg) / [PNG](architecture-overview.png) |
| Package dependencies | [SVG](package-dependencies.svg) |
| SDK runtime | [SVG](sdk-runtime.svg) |
| Single-app preview | [SVG](single-app-preview.svg) |
| Gateway connection lifecycle | [SVG](gateway-connection.svg) |
| Action routing | [SVG](action-routing.svg) |
| Browser and dashboard state | [SVG](browser-state.svg) |
| Remote pairing | [SVG](pairing.svg) |
| Failure and recovery | [SVG](recovery.svg) |
| Catalogs and conformance | [SVG](catalogs-conformance.svg) |

## Regenerate

Edit the Mermaid blocks in `docs/architecture.md`, then regenerate the exports.
Do not manually edit generated SVG or PNG files. These exports use Mermaid CLI
11.17.0 with [`mermaid.config.json`](mermaid.config.json), a white background,
and a 2400-pixel viewport. Mermaid resolves its own layout; the exported width
can differ from the viewport.

From the repository root, using Bun, Python 3, and a Chromium browser
available to Mermaid CLI:

```sh
mkdir -p /tmp/omochi-architecture-export
bunx @mermaid-js/mermaid-cli@11.17.0 \
  -i docs/architecture.md \
  -o /tmp/omochi-architecture-export/architecture.svg \
  -c docs/diagrams/mermaid.config.json -w 2400 -j 2
```

If using an existing browser, pass `-p /path/to/puppeteer.json` with its
`executablePath`. Browser launch options depend on the environment.

Copy the numbered outputs to the filenames linked next to each diagram and
extract the overview for PNG rendering:

```sh
python3 - <<'PY'
from pathlib import Path
import re
import shutil

source = Path('docs/architecture.md').read_text()
blocks = re.findall(r'```mermaid\n(.*?)\n```', source, re.S)
names = re.findall(r'\]\(diagrams/([a-z0-9-]+\.svg)\)', source)
assert len(blocks) == len(names), 'Each diagram needs exactly one SVG link'
output = Path('/tmp/omochi-architecture-export')
for index, name in enumerate(names, 1):
    shutil.copyfile(output / f'architecture-{index}.svg', Path('docs/diagrams') / name)
(output / 'overview.mmd').write_text(blocks[0] + '\n')
PY
bunx @mermaid-js/mermaid-cli@11.17.0 \
  -i /tmp/omochi-architecture-export/overview.mmd \
  -o docs/diagrams/architecture-overview.png \
  -c docs/diagrams/mermaid.config.json -w 2400
```

Inspect the rendered diagrams for clipped labels, overlapping edges, and incorrect
process boundaries. Keep all exported files in sync with the Mermaid sources.
