"""Generate TypeScript knowledge module from knowledge.json."""
import json
import sys

KB_JSON = r'C:\Users\mark\Documents\markluce.github.io\supabase\functions\chat\knowledge.json'
OUT_TS = r'C:\Users\mark\Documents\markluce.github.io\supabase\functions\chat\knowledge.ts'

with open(KB_JSON, 'r', encoding='utf-8') as f:
    kb = json.load(f)

lines = ["// Auto-generated from PDFs. Do not edit manually.",
         "export const KNOWLEDGE: Record<string, string> = {"]

for name, text in kb.items():
    # Escape for template literal: backslash, backtick, ${
    escaped = text.replace("\\", "\\\\").replace("`", "\\`").replace("${", "\\${")
    key_escaped = json.dumps(name, ensure_ascii=False)
    lines.append(f"  {key_escaped}: `{escaped}`,")

lines.append("};")

with open(OUT_TS, 'w', encoding='utf-8') as f:
    f.write("\n".join(lines) + "\n")

print(f"Generated: {OUT_TS}")
