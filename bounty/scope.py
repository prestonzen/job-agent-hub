"""Strict host/URL filtering for program in-scope and out-of-scope assets."""

from __future__ import annotations

import re
from urllib.parse import urlsplit

_HOST = re.compile(r"^(?:\*\.)?[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?(?:/.*)?$", re.I)
_WEB_TYPES = {"domain", "wildcard", "url", "website", "api"}
_FILE_SUFFIXES = {"apk", "app", "bin", "dmg", "exe", "ipa", "jar", "msi", "pdf", "pkg", "zip"}


def asset_is_scannable(identifier: str, asset_type: str = "") -> bool:
    """Accept only declared web target types or clearly host-like untyped values."""
    raw = identifier.strip()
    if not raw or raw.lower() in {"*", "all"}:
        return False
    kind = asset_type.strip().lower()
    if kind:
        if kind not in _WEB_TYPES:
            return False
        return raw.startswith(("http://", "https://")) or bool(_HOST.match(raw))
    if raw.startswith(("http://", "https://")):
        return bool(urlsplit(raw).hostname)
    if not _HOST.match(raw):
        return False
    host = raw.removeprefix("*.").split("/", 1)[0]
    suffix = host.rsplit(".", 1)[-1].lower()
    return suffix not in _FILE_SUFFIXES


def _rule(value: str) -> tuple[str, str, str] | None:
    raw = value.strip().lower()
    if not raw or any(ch.isspace() for ch in raw) or raw in {"*", "all"}:
        return None
    wildcard = raw.startswith("*.")
    if raw.startswith(("http://", "https://")):
        parsed = urlsplit(raw)
        if not parsed.hostname:
            return None
        path = parsed.path or "/"
        if path in {"/", "/*"}:
            return ("wildcard-host" if wildcard else "host", parsed.hostname, "")
        return ("url", parsed.hostname, path + (("?" + parsed.query) if parsed.query else ""))
    if not _HOST.match(raw):
        return None
    host, slash, path = raw.partition("/")
    wildcard = host.startswith("*.")
    hostname = host[2:] if wildcard else host
    if not hostname or "." not in hostname:
        return None
    if slash and path not in {"", "*"}:
        return ("url", hostname, "/" + path)
    return ("wildcard-host" if wildcard else "host", hostname, "")


def scope_rules(in_scope: list[str], out_of_scope: list[str]) -> dict[str, list[tuple[str, str, str]]]:
    return {
        "in": [rule for value in in_scope if (rule := _rule(value))],
        "out": [rule for value in out_of_scope if (rule := _rule(value))],
    }


def in_scope(target: str, rules: dict[str, list[tuple[str, str, str]]]) -> bool:
    value = target.strip().split()[0].lower() if target.strip() else ""
    if not value:
        return False
    if not value.startswith(("http://", "https://")):
        value = "https://" + value
    parsed = urlsplit(value)
    host = parsed.hostname or ""
    path = parsed.path or "/"
    url = path + (("?" + parsed.query) if parsed.query else "")

    def matches(rule: tuple[str, str, str]) -> bool:
        kind, rule_host, rule_path = rule
        if kind == "host":
            return host == rule_host
        if kind == "wildcard-host":
            return host == rule_host or host.endswith("." + rule_host)
        return host == rule_host and url == rule_path

    if any(matches(rule) for rule in rules["out"]):
        return False
    return any(matches(rule) for rule in rules["in"])
