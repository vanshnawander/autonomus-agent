"""Small, auditable SearXNG client used by research agents.

The CLI writes one JSONL row per result so search discovery is reproducible.
It intentionally does not download or treat snippets as evidence.
"""
from __future__ import annotations

import argparse
import json
import os
import sys
from datetime import datetime, timezone
from pathlib import Path
from typing import Any
from urllib.parse import urlencode
from urllib.request import Request, urlopen


DEFAULT_URL = os.environ.get("SEARXNG_URL", "http://127.0.0.1:8080")


def search(query: str, *, base_url: str = DEFAULT_URL, limit: int = 20, timeout: float = 15) -> dict[str, Any]:
    params = urlencode({"q": query, "format": "json"})
    request = Request(
        f"{base_url.rstrip('/')}/search?{params}",
        headers={"Accept": "application/json", "User-Agent": "research-orchestrator/1"},
    )
    with urlopen(request, timeout=timeout) as response:
        if response.status != 200:
            raise RuntimeError(f"SearXNG returned HTTP {response.status}")
        payload = json.load(response)
    if not isinstance(payload, dict) or not isinstance(payload.get("results"), list):
        raise RuntimeError("SearXNG returned an invalid JSON response")
    payload["results"] = payload["results"][: max(1, min(limit, 100))]
    return payload


def _safe_output(path_text: str) -> Path:
    path = Path(path_text)
    candidate = (Path.cwd() / path).resolve() if not path.is_absolute() else path.resolve()
    try:
        candidate.relative_to(Path.cwd().resolve())
    except ValueError as exc:
        raise ValueError("search ledger must be inside the current project workspace") from exc
    return candidate


def append_ledger(path: Path, query: str, payload: dict[str, Any], base_url: str) -> int:
    path.parent.mkdir(parents=True, exist_ok=True)
    timestamp = datetime.now(timezone.utc).isoformat()
    written = 0
    with path.open("a", encoding="utf-8") as handle:
        for rank, result in enumerate(payload.get("results", []), start=1):
            engines = result.get("engines") or ([result.get("engine")] if result.get("engine") else [])
            row = {
                "query": query,
                "engine": "searxng",
                "engines": engines,
                "timestamp": timestamp,
                "rank": rank,
                "url": result.get("url"),
                "title": result.get("title"),
                "snippet": result.get("content"),
                "decision": "unreviewed",
                "reason": "discovery result; verify against a primary source before citing",
                "searxng_url": base_url,
            }
            handle.write(json.dumps(row, ensure_ascii=False) + "\n")
            written += 1
    return written


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Query local SearXNG and retain a JSONL search ledger")
    parser.add_argument("query")
    parser.add_argument("--output", default="outputs/literature/search_log.jsonl")
    parser.add_argument("--url", default=DEFAULT_URL)
    parser.add_argument("--limit", type=int, default=20)
    parser.add_argument("--timeout", type=float, default=15)
    args = parser.parse_args(argv)
    try:
        output = _safe_output(args.output)
        payload = search(args.query, base_url=args.url, limit=args.limit, timeout=args.timeout)
        count = append_ledger(output, args.query, payload, args.url)
    except Exception as exc:
        print(f"search failed: {type(exc).__name__}: {exc}", file=sys.stderr)
        return 2
    print(json.dumps({"query": args.query, "results": count, "ledger": str(output)}))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
