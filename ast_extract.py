import sys, json
from graphify.extract import collect_files, extract
from pathlib import Path

if __name__ == '__main__':
    code_files = []
    detect = json.loads(Path(".graphify_detect.json").read_text(encoding="utf-8"))
    for f in detect.get("files", {}).get("code", []):
        p = Path(f)
        code_files.extend(collect_files(p) if p.is_dir() else [p])

    print("Found {} code files".format(len(code_files)))
    if code_files:
        result = extract(code_files)
        Path(".graphify_ast.json").write_text(json.dumps(result, indent=2), encoding="utf-8")
        print("AST: {} nodes, {} edges".format(len(result["nodes"]), len(result["edges"])))
    else:
        Path(".graphify_ast.json").write_text(json.dumps({"nodes":[],"edges":[],"input_tokens":0,"output_tokens":0}), encoding="utf-8")
        print("No code files - skipping AST extraction")
