"""Rebuild the demo's local, deliberately illustrative product SVGs."""
from pathlib import Path

PRODUCTS = [
    ("dolo", "DOLO", "650 mg", "#0f766e", "15 TABLETS"),
    ("crocin", "CROCIN", "ADVANCE 500", "#2563eb", "20 TABLETS"),
    ("cetirizine", "CETIRIZINE", "10 mg", "#7c3aed", "10 TABLETS"),
    ("betadine", "BETADINE", "OINTMENT", "#b45309", "20 g TUBE"),
    ("electral", "ELECTRAL", "POWDER", "#db2777", "21.8 g SACHET"),
]

for slug, name, strength, color, unit in PRODUCTS:
    (Path(__file__).parent / f"{slug}.svg").write_text(f'''<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 240 160" role="img" aria-label="{name} illustration">
<rect width="240" height="160" rx="14" fill="#f4f8fa"/>
<ellipse cx="120" cy="138" rx="79" ry="9" fill="#e2e8f0"/>
<rect x="33" y="27" width="174" height="108" rx="6" fill="white" stroke="#cbd5e1"/>
<path d="M33 33 Q33 27 39 27 H201 Q207 27 207 33 V53 H33Z" fill="{color}"/>
<text x="46" y="44" fill="white" font-family="Arial" font-size="10">SIRU · DEMO</text>
<text x="46" y="78" fill="{color}" font-family="Arial" font-weight="bold" font-size="18">{name}</text>
<text x="46" y="97" fill="#475569" font-family="Arial" font-size="12">{strength}</text>
<text x="46" y="120" fill="#64748b" font-family="Arial" font-size="10">{unit}</text>
</svg>''', encoding="utf-8")
