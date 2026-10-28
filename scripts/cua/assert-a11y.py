#!/usr/bin/env python3
"""Pipe `cua do a11y tree --window <fixture-window> --json` to this check."""
import json
import sys

tree = json.load(sys.stdin)
nodes = tree.get("nodes", [])
assert any("WOC + Cua" in node.get("name", "") for node in nodes), "fixture window missing"
assert any(node.get("name") == "验收输入框" for node in nodes), "fixture input is absent from AT-SPI"
print(f"AT-SPI regression passed: fixture window and input present ({len(nodes)} nodes)")
