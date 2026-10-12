#!/usr/bin/env python3
"""PreToolUse guard: refuse any Bash command that would WRITE to Planning Center.

Reads the hook payload on stdin. If the command references planningcenteronline
AND carries a write signal (POST/PATCH/PUT/DELETE, a request body, or a
scripted write call), emit a deny decision. Everything else passes silently.
Policy: CLAUDE.md -> "Read-only policy (Planning Center)".
"""
import json, re, sys

try:
    payload = json.load(sys.stdin)
except Exception:
    sys.exit(0)
cmd = (payload.get("tool_input") or {}).get("command") or ""
if not re.search(r"planningcenter", cmd, re.I):
    sys.exit(0)

# Short flags like -d / -F / -T are only write signals when an HTTP client is
# actually being invoked. Without this gate, `git commit -F -` or `grep -F`
# with a commit message or search string that mentions planningcenteronline
# would be refused (that false positive blocked a real commit once).
HTTP_CLIENT = re.compile(r"\b(?:curl|wget|xh)\b", re.I)  # not "http(s)": that word is inside every URL
HTTP_CLIENT_SIGNALS = [
    r"(?:^|\s)(?:-X|--request)[\s=]*\\?['\"]?(?:POST|PATCH|PUT|DELETE)\b",   # curl method flag
    r"(?:^|\s)(?:--data(?:-\w+)?|-d|--json|--form|-F|--upload-file|-T)(?:\s|=)",  # curl body
    r"(?:^|\s)--(?:post-data|post-file|body-data|body-file)\b",               # wget body
    r"(?:^|\s)--method[\s=]+(?:POST|PATCH|PUT|DELETE)\b",                     # wget method
]
# Language-level write calls are a signal regardless of which binary runs them.
SCRIPT_SIGNALS = [
    r"\bmethod\s*[:=]\s*\\?['\"](?:POST|PATCH|PUT|DELETE)\\?['\"]",           # node https.request / fetch opts (quotes may be shell-escaped)
    r"\b(?:requests|session|client|https?|fetch|axios)\.(?:post|patch|put|delete)\s*\(",  # python/js clients
    r"urlopen\([^)]*\bdata\s*=",                                               # urllib with body
    r"\bRequest\([^)]*\b(?:data|method)\s*=",                                  # urllib.request.Request(..., data=/method=)
    r"\bgh\s+api\b[^\n]*\s(?:-X|--method)\s*(?:POST|PATCH|PUT|DELETE)\b",
]
signals = list(SCRIPT_SIGNALS) + (HTTP_CLIENT_SIGNALS if HTTP_CLIENT.search(cmd) else [])
hit = next((p for p in signals if re.search(p, cmd, re.I)), None)
if hit:
    print(json.dumps({
        "hookSpecificOutput": {
            "hookEventName": "PreToolUse",
            "permissionDecision": "deny",
            "permissionDecisionReason": (
                "PCO read-only policy: this command would write to Planning Center "
                "(POST/PATCH/PUT/DELETE or a request body against planningcenteronline.com). "
                "This project only reads PCO. See CLAUDE.md -> Read-only policy."
            ),
        }
    }))
sys.exit(0)
