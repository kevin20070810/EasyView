"""Offline checks for the 0.3 ui_schema draft and its paired element snapshot.

This checks structure, byte identity, citations, counters and action policy. It
does not prove that a rewrite preserves meaning, that a task is useful to an
older person, or that a referenced website can complete the task. No URL is
fetched and no browser action is executed.

Run from any directory:
    python docs/drafts/ui-schema-0.3/validate.py
    python docs/drafts/ui-schema-0.3/validate.py --self-test
    python docs/drafts/ui-schema-0.3/validate.py --ui FILE --elements FILE
"""

from __future__ import annotations

import argparse
from copy import deepcopy
import hashlib
import json
from pathlib import Path
import re
from typing import Any, Callable
from urllib.parse import urlsplit

import jsonschema


HERE = Path(__file__).resolve().parent
DOCS = HERE.parents[1]
SCHEMA = json.loads((HERE / "ui.schema.json").read_text(encoding="utf-8-sig"))
ELEMENTS_SCHEMA = json.loads((DOCS / "elements.schema.json").read_text(encoding="utf-8-sig"))
jsonschema.Draft202012Validator.check_schema(SCHEMA)
jsonschema.Draft202012Validator.check_schema(ELEMENTS_SCHEMA)
UI_VALIDATOR = jsonschema.Draft202012Validator(SCHEMA, format_checker=jsonschema.FormatChecker())
ELEMENTS_VALIDATOR = jsonschema.Draft202012Validator(
    ELEMENTS_SCHEMA, format_checker=jsonschema.FormatChecker()
)
BLOCKED_REASONS = {"payment", "medical_submission", "identity_submission", "unknown_effect"}
# Applied only to presentation copy, never to source quotes, facts or audit data.
TECHNICAL_COPY = re.compile(
    r"(?:[a-z][a-z0-9+.-]*://|www\.|(?:javascript|data|tel):|"
    r"(?<![A-Za-z])(?:DOM|selector|xpath|token|JSON|ui_schema|element_id|target_selector)(?![A-Za-z])|"
    r"选择器|免责声明|候选元素|技术字段|"
    r"[A-Za-z]:[\\/]|/(?:[A-Za-z0-9_.~-]+)(?:[/?.#]|\b)|"
    r"\b[a-z0-9-]+\.(?:com|cn|org|net|edu|gov|html?|php|aspx?)\b)",
    re.IGNORECASE,
)


def _schema_errors(validator: Any, value: Any, prefix: str) -> list[str]:
    """Report paths and rule names, without echoing potentially private values."""
    errors = sorted(validator.iter_errors(value), key=lambda err: str(list(err.absolute_path)))
    return [
        f"{prefix}/{('/'.join(map(str, err.absolute_path)) or '$')}: schema {err.validator}"
        for err in errors
    ]


def _safe_url(value: Any, allowed: set[str]) -> tuple[str, str, int | None] | None:
    """Return a normalized origin; reject parser quirks and credentialed URLs."""
    if not isinstance(value, str) or not value or re.search(r"[\s\\\x00-\x1f\x7f]", value):
        return None
    try:
        parsed = urlsplit(value)
        scheme = parsed.scheme.lower()
        if scheme not in allowed or parsed.username is not None or parsed.password is not None:
            return None
        if scheme == "tel":
            # Only a phone handler URI; no query, fragment or authority injection.
            if parsed.netloc or parsed.query or parsed.fragment or not re.fullmatch(r"\+?[0-9().-]+", parsed.path):
                return None
            return ("tel", "", None)
        if not parsed.netloc or not parsed.hostname:
            return None
        return (scheme, parsed.hostname.lower(), parsed.port or (443 if scheme == "https" else 80))
    except ValueError:
        return None


def validate(ui: Any, elements: Any, raw_bytes: bytes) -> list[str]:
    """Pure validation: return errors, never mutate inputs, perform I/O or run actions.

    raw_bytes must be the original elements file, not a JSON reserialization.
    Input schemas are checked before indexing any nested object.
    """
    errors = _schema_errors(UI_VALIDATOR, ui, "ui")
    if errors:
        return errors
    errors = _schema_errors(ELEMENTS_VALIDATOR, elements, "elements")
    if errors:
        return errors
    if not isinstance(raw_bytes, bytes):
        return ["input_snapshot: raw_bytes must be original bytes"]
    try:
        original = json.loads(raw_bytes.decode("utf-8-sig"))
    except (UnicodeDecodeError, json.JSONDecodeError):
        return ["input_snapshot: raw_bytes is not valid UTF-8 JSON"]
    if original != elements:
        return ["input_snapshot: supplied elements differ from raw_bytes"]

    def require(condition: bool, path: str, reason: str) -> None:
        if not condition:
            errors.append(f"{path}: {reason}")

    for field in ("page_url", "final_url", "page_title", "source"):
        require(ui[field] == elements[field], field, "must equal input snapshot")
    require(ui["source_elements_schema_version"] == elements["schema_version"],
            "source_elements_schema_version", "must equal input version")
    require(ui["input_snapshot"]["extracted_at"] == elements["extracted_at"],
            "input_snapshot.extracted_at", "must equal input extraction time")
    require(ui["input_snapshot"]["sha256"] == hashlib.sha256(raw_bytes).hexdigest(),
            "input_snapshot.sha256", "must match original input bytes")

    entries = elements["elements"]
    element_ids = [entry["id"] for entry in entries]
    require(len(set(element_ids)) == len(element_ids), "elements.elements", "duplicate element id")
    by_id = {entry["id"]: entry for entry in entries}
    cards = ui["cards"]
    require(len({card["id"] for card in cards}) == len(cards), "cards", "duplicate card id")
    require(sorted(card["priority"] for card in cards) == list(range(1, len(cards) + 1)),
            "cards.priority", "must be unique and contiguous from 1 through card count")
    referenced: set[str] = set()

    actual_stats = {
        "input_elements": len(entries),
        "visible_elements": sum(entry["visible"] is True for entry in entries),
        "input_truncated": elements["stats"].get("truncated", False),
        "task_cards": len(cards),
    }
    for field, expected in actual_stats.items():
        require(ui["stats"][field] == expected, f"stats.{field}", "must match counted input/output")

    # Redirects change the live origin. snapshot:// is an offline fixture marker,
    # so its paired page_url supplies the origin for validation, never execution.
    page_origin = _safe_url(elements["final_url"], {"http", "https"})
    if page_origin is None and elements["source"] == "fallback" and elements["final_url"].startswith("snapshot://"):
        page_origin = _safe_url(elements["page_url"], {"http", "https"})

    def check_copy(value: str | None, path: str) -> None:
        if value is not None:
            require(TECHNICAL_COPY.search(value) is None, path, "technical text or URL/path in presentation copy")

    check_copy(ui["page"]["greeting"], "page.greeting")
    check_copy(ui["page"]["summary"], "page.summary")
    for index, card in enumerate(cards):
        path = f"cards[{index}]"
        provenance = card["provenance"]
        source_ids = set(provenance["source_element_ids"])
        referenced.update(source_ids)
        require(source_ids <= by_id.keys(), f"{path}.provenance", "unknown source element id")
        evidence: dict[str, dict] = {}
        for item in provenance["evidence"]:
            eid = item["id"]
            require(eid not in evidence, f"{path}.provenance.evidence", "duplicate evidence id within card")
            evidence[eid] = item
            require(item["element_id"] in source_ids, f"{path}.provenance.evidence", "evidence element missing from source ids")
            source = by_id.get(item["element_id"])
            require(source is not None, f"{path}.provenance.evidence", "unknown evidence element id")
            if source is not None:
                require(item["quote"] == source.get(item["field"]), f"{path}.provenance.evidence",
                        "quote must equal the complete source field")

        def check_refs(ids: list[str], subpath: str) -> None:
            require(set(ids) <= evidence.keys(), subpath, "unknown evidence reference in this card")

        def check_verbatim(value: str, ids: list[str], subpath: str) -> None:
            require(len(ids) == 1, subpath, "verbatim must cite exactly one complete source field")
            if len(ids) == 1 and ids[0] in evidence:
                require(value == evidence[ids[0]]["quote"], subpath, "verbatim text differs from evidence quote")

        for field in ("title", "subtitle"):
            check_copy(card[field], f"{path}.{field}")
            meta = card["content_meta"][field]
            if meta is not None:
                check_refs(meta["evidence_ids"], f"{path}.content_meta.{field}")
                if meta["mode"] == "verbatim":
                    check_verbatim(card[field], meta["evidence_ids"], f"{path}.content_meta.{field}")
        for fact_index, fact in enumerate(card["facts"]):
            fact_path = f"{path}.facts[{fact_index}]"
            check_refs(fact["evidence_ids"], fact_path)
            check_verbatim(fact["text"], fact["evidence_ids"], fact_path)

        ranking = card["ranking"]
        check_refs(ranking["evidence_ids"], f"{path}.ranking")
        if "user_goal_match" in ranking["reason_codes"]:
            require(bool(ui["user_goal"] and ui["user_goal"].strip()), f"{path}.ranking",
                    "user_goal_match requires an explicit nonempty user_goal")

        risk = card["risk"]
        level, reasons, domains = risk["level"], set(risk["reason_codes"]), set(risk["domains"])
        check_refs(risk["evidence_ids"], f"{path}.risk")
        if level == "normal":
            require(reasons == {"read_only"}, f"{path}.risk", "normal permits only read_only")
        elif level == "sensitive":
            require(bool(reasons & {"personal_data", "external_handler"}) and not reasons & BLOCKED_REASONS,
                    f"{path}.risk", "sensitive requires personal_data/external_handler without blocked reasons")
        else:
            require(bool(reasons & BLOCKED_REASONS), f"{path}.risk", "blocked requires a blocked reason")
        if card["intent"] == "pay":
            require(level == "blocked" and "payment" in reasons and "money" in domains,
                    f"{path}.risk", "pay requires blocked, payment and money")
        if "payment" in reasons:
            require(level == "blocked" and "money" in domains, f"{path}.risk", "payment requires blocked and money")
        for reason, domain in (("medical_submission", "healthcare"), ("identity_submission", "identity")):
            if reason in reasons:
                require(level == "blocked" and domain in domains, f"{path}.risk", f"{reason} requires blocked and {domain}")
        if "external_handler" in reasons:
            require("external_handler" in domains, f"{path}.risk", "external handler requires its domain")

        action = card["action"]
        target_id = action["target_element_id"]
        require(target_id in source_ids, f"{path}.action", "action target missing from source ids")
        target = by_id.get(target_id)
        require(target is not None, f"{path}.action", "unknown target element id")
        if action["confirmation"] is not None:
            for field, value in action["confirmation"].items():
                check_copy(value, f"{path}.action.confirmation.{field}")
        if target is None:
            continue
        require(target.get("disabled") is not True, f"{path}.action", "disabled source cannot be an action target")
        require(action["target_selector"] == target["selector"], f"{path}.action.target_selector", "must match source selector")
        require(action["target_xpath"] == target["xpath"], f"{path}.action.target_xpath", "must match source xpath")
        kind = action["kind"]
        if kind in {"navigate", "external"}:
            require(target["type"] == "link", f"{path}.action", "navigation requires a source link")
            require(action["href"] == target.get("href"), f"{path}.action.href", "must match source href exactly")
            url_origin = _safe_url(action["href"], {"http", "https"} if kind == "navigate" else {"http", "https", "tel"})
            require(url_origin is not None, f"{path}.action.href", "URL scheme/authority is not allowed")
            if kind == "navigate":
                require(page_origin is not None and url_origin == page_origin,
                        f"{path}.action.href", "navigate requires the current page HTTP(S) origin")
            elif url_origin and url_origin[0] == "tel":
                require(level == "sensitive" and "external_handler" in reasons and "external_handler" in domains,
                        f"{path}.risk", "tel requires sensitive external_handler confirmation")
        elif kind == "form":
            require(target["type"] == "form", f"{path}.action", "form requires a source form element")
            require(level != "blocked", f"{path}.action", "blocked tasks cannot use form")
        # scroll and form mean locate/focus only in this draft. There is no
        # click/fill/submit member in the schema, and this checker executes none.

    require(ui["stats"]["referenced_elements"] == len(referenced), "stats.referenced_elements",
            "must count the union of source element ids")
    return errors


def _read_pair(ui_path: Path, elements_path: Path) -> tuple[Any, Any, bytes]:
    raw = elements_path.read_bytes()
    return json.loads(ui_path.read_text(encoding="utf-8-sig")), json.loads(raw.decode("utf-8-sig")), raw


def _self_test(pairs: list[tuple[str, Any, Any, bytes]]) -> tuple[int, int, list[str]]:
    """Negative mutations of passing examples; all mutations stay in memory."""
    cases: list[tuple[str, Any, Any, bytes]] = []
    usable = [pair for pair in pairs if len(pair[1]["cards"]) >= 2 and any(
        card["action"]["kind"] in {"navigate", "external"} for card in pair[1]["cards"]
    )]
    if not usable:
        return 0, 0, ["self-test requires an example with two cards and a link action"]
    _, base, elements, raw = usable[0]

    def mutate(label: str, fn: Callable[[dict], None], original: dict | None = None,
               source: dict | None = None, source_raw: bytes | None = None) -> None:
        changed = deepcopy(base if original is None else original)
        fn(changed)
        cases.append((label, changed, elements if source is None else source, raw if source_raw is None else source_raw))

    mutate("unknown source id", lambda ui: ui["cards"][0]["provenance"]["source_element_ids"].append("el_deadbeef"))
    mutate("altered source quote", lambda ui: ui["cards"][0]["provenance"]["evidence"][0].update(quote="被改写的原文"))
    link_card = next(index for index, card in enumerate(base["cards"]) if card["action"]["kind"] in {"navigate", "external"})
    mutate("replaced link", lambda ui: ui["cards"][link_card]["action"].update(href="https://other.example/replaced"))
    mutate("cross snapshot hash", lambda ui: ui["input_snapshot"].update(sha256="0" * 64))
    mutate("duplicate priority", lambda ui: ui["cards"][1].update(priority=ui["cards"][0]["priority"]))
    mutate("eighth card", lambda ui: ui["cards"].extend(deepcopy(ui["cards"][0]) for _ in range(8 - len(ui["cards"]))))
    mutate("URL in subtitle", lambda ui: ui["cards"][0].update(subtitle="打开 https://example.com"))
    mutate("technical word within Chinese", lambda ui: ui["cards"][0].update(subtitle="查看DOM元素"))
    mutate("unknown evidence reference", lambda ui: ui["cards"][0]["ranking"].update(evidence_ids=["ev_missing"]))
    mutate("unknown action id", lambda ui: ui["cards"][0]["action"].update(target_element_id="el_deadbeef"))
    mutate("unknown field", lambda ui: ui["cards"][0].update(auto_submit=True))
    mutate("invalid empty state", lambda ui: ui.update(state="empty", empty_reason="no_reliable_tasks"))
    mutate("fake reference generator", lambda ui: ui.update(generator={"mode": "model", "policy_version": "senior-v0.3", "prompt_version": "test", "fallback_reason": None}))
    mutate("fabricated user goal", lambda ui: (ui.update(user_goal=None), ui["cards"][0]["ranking"].update(reason_codes=["user_goal_match"])))
    mutate("incorrect statistics", lambda ui: ui["stats"].update(input_elements=400))
    mutate("selector substitution", lambda ui: ui["cards"][0]["action"].update(target_selector="#not-the-source"))
    mutate("xpath substitution", lambda ui: ui["cards"][0]["action"].update(target_xpath="/html/body/fake"))
    mutate("duplicate card id", lambda ui: ui["cards"][1].update(id=ui["cards"][0]["id"]))
    mutate("duplicate evidence id", lambda ui: ui["cards"][0]["provenance"]["evidence"].append(deepcopy(ui["cards"][0]["provenance"]["evidence"][0])))
    mutate("verbatim text changed", lambda ui: ui["cards"][0]["facts"].append({"text": "不是这段原文", "content_mode": "verbatim", "evidence_ids": [ui["cards"][0]["provenance"]["evidence"][0]["id"]]}))
    for _, original, source, source_raw in pairs:
        pay_index = next((i for i, card in enumerate(original["cards"]) if card["intent"] == "pay"), None)
        if pay_index is not None:
            mutate("high risk downgraded", lambda ui, i=pay_index: (ui["cards"][i]["risk"].update(level="normal", reason_codes=["read_only"], domains=[]), ui["cards"][i]["action"].update(confirmation=None)), original, source, source_raw)
            break
    for _, original, source, source_raw in pairs:
        sensitive_index = next((i for i, card in enumerate(original["cards"]) if card["risk"]["level"] == "sensitive"), None)
        if sensitive_index is not None:
            mutate("missing confirmation", lambda ui, i=sensitive_index: ui["cards"][i]["action"].update(confirmation=None), original, source, source_raw)
            break
    cases.extend([
        ("malformed ui", [], elements, raw),
        ("malformed elements", base, {"elements": [None]}, raw),
        ("malformed bytes", base, elements, b"not json"),
        ("wrong bytes type", base, elements, "not bytes"),
        ("decoded input substitution", base, {**elements, "page_title": "another snapshot"}, raw),
    ])
    if len(pairs) > 1:
        cases.append(("different page with shared ids", base, pairs[1][2], pairs[1][3]))
    failures = [label for label, ui, source, source_raw in cases if not validate(ui, source, source_raw)]
    labels = {case[0] for case in cases}
    for required in ("high risk downgraded", "missing confirmation"):
        if required not in labels:
            failures.append(f"missing test fixture: {required}")

    # These controls validate allowed shapes in memory. They do not assert that
    # a runtime generator has actually run, nor produce fake runtime artifacts.
    empty = deepcopy(base)
    empty.update(state="empty", empty_reason="no_reliable_tasks", cards=[])
    empty["stats"].update(task_cards=0, referenced_elements=0)
    runtime = deepcopy(base)
    runtime.update(artifact_kind="runtime", generator={
        "mode": "rules", "policy_version": "senior-v0.3", "prompt_version": None, "fallback_reason": None,
    })
    positive_cases = [("valid empty state", empty), ("valid runtime rules metadata shape", runtime)]
    for label, ui in positive_cases:
        if validate(ui, elements, raw):
            failures.append(f"positive control rejected: {label}")
    return len(cases), len(positive_cases), failures


def main() -> int:
    parser = argparse.ArgumentParser(description="Offline ui_schema 0.3 draft validation; no semantic-quality claim")
    parser.add_argument("--pair", action="append", choices=("hospital", "gov", "traffic"), help="default: all three")
    parser.add_argument("--ui", type=Path)
    parser.add_argument("--elements", type=Path)
    parser.add_argument("--self-test", action="store_true", help="reject negative mutations of passing examples")
    args = parser.parse_args()
    if bool(args.ui) != bool(args.elements):
        parser.error("--ui and --elements must be supplied together")
    if args.ui and args.pair:
        parser.error("--pair cannot be combined with custom input paths")
    paths = [("custom", args.ui, args.elements)] if args.ui else [
        (name, HERE / "examples" / f"ui_schema.{name}.json", DOCS / "examples" / f"elements.{name}.json")
        for name in args.pair or ("hospital", "gov", "traffic")
    ]
    loaded: list[tuple[str, Any, Any, bytes]] = []
    failed = False
    for name, ui_path, elements_path in paths:
        try:
            ui, elements, raw = _read_pair(ui_path, elements_path)
            errors = validate(ui, elements, raw)
        except (OSError, UnicodeDecodeError, json.JSONDecodeError) as exc:
            errors = [f"input file could not be read ({type(exc).__name__})"]
        if errors:
            failed = True
            print(f"[FAIL] {name}: {len(errors)} error(s)")
            for error in errors[:12]:
                print(f"  {error}")
            if len(errors) > 12:
                print(f"  ... {len(errors) - 12} additional errors")
        else:
            loaded.append((name, ui, elements, raw))
            print(f"[PASS] {name}: {len(elements['elements'])} input elements -> {len(ui['cards'])} cards")
    if args.self_test:
        if failed or not loaded:
            print("[FAIL] self-test requires passing input examples")
            failed = True
        else:
            count, positive_count, failures = _self_test(loaded)
            failed = bool(failures)
            print(f"[{'FAIL' if failures else 'PASS'}] self-test: {count} negative mutations, {positive_count} positive controls; {len(failures)} failure(s)")
            for failure in failures:
                print(f"  {failure}")
    print("Scope: schema, evidence, snapshot binding and declared action policy only; semantic usefulness is not evaluated.")
    return 1 if failed else 0


if __name__ == "__main__":
    raise SystemExit(main())
