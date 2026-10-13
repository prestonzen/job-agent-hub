"""Classify explicit program prohibitions on automated security scanning.

The queue policy is deliberately default-allow: only a clear prohibition on
automated/AI testing blocks a program. A rule rejecting scanner-only reports is
not a prohibition on scanning and must not be treated as one.
"""

from __future__ import annotations

import html
import re


_TAGS = re.compile(r"<(script|style|noscript)\b[^>]*>.*?</\1>|<[^>]+>", re.I | re.S)
_SPACES = re.compile(r"\s+")

_AUTOMATION = r"(?:automated|automatic|AI(?:[- ](?:assisted|driven|powered|based))?|LLM(?:s|[- ]assisted)?|bots?|scanners?)"
_PROHIBITION = r"(?:strictly\s+)?(?:prohibited|forbidden|not\s+permitted|not\s+allowed|banned)"
POLICY_VERSION = 3
_EXPLICIT_BANS = (
    re.compile(rf"\b(?:do\s+not|don't|never|must\s+not)\s+(?:use|run|perform|conduct|employ)\b[^.!?\n]{{0,140}}\b{_AUTOMATION}\b[^.!?\n]{{0,80}}", re.I),
    re.compile(rf"\b(?:not\s+permitted|not\s+allowed|prohibited|forbidden)\s+to\s+(?:use|run|perform|conduct|employ)\b[^.!?\n]{{0,120}}\b{_AUTOMATION}\b", re.I),
    re.compile(rf"\b(?:refrain\s+from|avoid)\s+(?:using\s+)?[^.!?\n]{{0,100}}\b{_AUTOMATION}\b[^.!?\n]{{0,80}}", re.I),
    re.compile(rf"\b{_AUTOMATION}\b[^.!?\n]{{0,140}}\b{_PROHIBITION}\b", re.I),
    re.compile(rf"\b{_AUTOMATION}\b[^.!?\n]{{0,100}}\b(?:must\s+not|may\s+not|cannot|can\s+not)\b[^.!?\n]{{0,80}}\b(?:scan|test|discover|identify|find|bug|vulnerabilit\w*)\b", re.I),
    re.compile(r"\b(?:automated|high[- ]volume)\s+(?:testing|scanning)\b[^.!?\n]{0,100}\bwithout\s+(?:prior\s+)?coordination\b", re.I),
    re.compile(rf"\b{_AUTOMATION}\b[^.!?\n]{{0,100}}\b(?:must|required to)\s+(?:be\s+)?(?:actively\s+)?supervised\b", re.I),
    re.compile(rf"\b{_AUTOMATION}\b[^.!?\n]{{0,100}}\b(?:requires?|must obtain|needs?)\s+(?:prior\s+authorization|prior\s+approval|advance\s+permission|coordination)\b", re.I),
    re.compile(r"\b(?:only|solely)\s+(?:manual|human)[- ](?:testing|research|discovery)\b|\bonly\s+accept\s+(?:bugs|findings)\s+found\s+by\s+humans?\b", re.I),
)


def policy_text(source: str) -> str:
    """Convert a policy page's HTML or plain text into normalized text."""
    text = _TAGS.sub(" ", source)
    return _SPACES.sub(" ", html.unescape(text)).strip()


def explicit_prohibition(source: str) -> str | None:
    """Return the matching policy evidence, or None when no explicit ban exists."""
    text = policy_text(source)
    for pattern in _EXPLICIT_BANS:
        match = pattern.search(text)
        if match:
            clause = match.group(0)
            # Restrictions on scripted account creation do not prohibit vulnerability scanning.
            if re.search(r"\b(?:account|user)\s+(?:creation|registration|sign[- ]?up)\b", clause, re.I):
                continue
            if re.search(r"\b(?:reports?|submissions?|write[- ]?ups?)\b", clause, re.I) and not re.search(r"\b(?:scan|test|discover|identify|find|bug|vulnerabilit\w*)\b", clause, re.I):
                continue
            # Avoid treating an explicit statement that scanners are not prohibited
            # as a prohibition simply because the same sentence contains that word.
            if re.search(r"\b(?:not|no\s+longer)\s+(?:strictly\s+)?(?:prohibited|forbidden|banned|disallowed)\b", clause, re.I):
                continue
            # A ban that applies only when a stated rate is exceeded does not ban
            # the low-rate scan configured by this pipeline.
            if re.search(r"\b(?:outside|exceed(?:ing)?|above|over)\b[^.!?\n]{0,60}\b(?:rate|request|traffic|limit|threshold)", clause, re.I):
                continue
            excerpt = _SPACES.sub(" ", match.group(0)).strip(" .;,:-")
            return excerpt[:400]
    return None


def policy_decision(source: str) -> tuple[str, str | None]:
    evidence = explicit_prohibition(source)
    return ("blacklisted", evidence) if evidence else ("default-allow", None)
