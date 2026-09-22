#!/usr/bin/env python3
"""Dependency-free client for the local Flourish API."""

from __future__ import annotations

import argparse
import hashlib
import json
import mimetypes
import os
import pathlib
import sys
import urllib.error
import urllib.parse
import urllib.request
import uuid


BASE_URL = os.environ.get("FLOURISH_BASE_URL", "http://127.0.0.1:3210").rstrip("/") + "/api/v1"


class ApiError(RuntimeError):
    pass


def parse_json(value: str | None):
    if not value:
        return None
    if value.startswith("@"):
        return json.loads(pathlib.Path(value[1:]).read_text(encoding="utf-8"))
    return json.loads(value)


def request(method: str, path: str, payload=None, idempotency_key: str | None = None, raw: bool = False):
    url = BASE_URL + (path if path.startswith("/") else "/" + path)
    headers = {"Accept": "application/json", "User-Agent": "Flourish-Hermes/1.0"}
    body = None
    if payload is not None:
        body = json.dumps(payload).encode("utf-8")
        headers["Content-Type"] = "application/json"
    if idempotency_key:
        headers["Idempotency-Key"] = idempotency_key
    try:
        with urllib.request.urlopen(urllib.request.Request(url, data=body, headers=headers, method=method.upper()), timeout=60) as response:
            content = response.read()
            if raw:
                return content, response.headers
            decoded = json.loads(content.decode("utf-8"))
            return decoded.get("data", decoded)
    except urllib.error.HTTPError as error:
        content = error.read().decode("utf-8", errors="replace")
        try:
            decoded = json.loads(content)
            detail = decoded.get("error", {})
            raise ApiError(f"{detail.get('code', error.code)}: {detail.get('message', content)}") from error
        except json.JSONDecodeError:
            raise ApiError(f"HTTP {error.code}: {content}") from error
    except urllib.error.URLError as error:
        raise ApiError(f"Flourish is unavailable at {BASE_URL}: {error.reason}") from error


def multipart_statement(path: pathlib.Path, account_id: str, profile_id: str | None, mapping_json: str | None):
    boundary = "----flourish-" + uuid.uuid4().hex
    chunks: list[bytes] = []

    def field(name: str, value: str):
        chunks.extend([
            f"--{boundary}\r\n".encode(),
            f'Content-Disposition: form-data; name="{name}"\r\n\r\n'.encode(),
            value.encode(), b"\r\n",
        ])

    field("accountId", account_id)
    if profile_id:
        field("profileId", profile_id)
    if mapping_json:
        json.loads(mapping_json)
        field("mapping", mapping_json)
    content_type = mimetypes.guess_type(path.name)[0] or "application/octet-stream"
    chunks.extend([
        f"--{boundary}\r\n".encode(),
        f'Content-Disposition: form-data; name="file"; filename="{path.name}"\r\n'.encode(),
        f"Content-Type: {content_type}\r\n\r\n".encode(),
        path.read_bytes(), b"\r\n",
        f"--{boundary}--\r\n".encode(),
    ])
    url = BASE_URL + "/imports/preview"
    try:
        with urllib.request.urlopen(urllib.request.Request(url, data=b"".join(chunks), headers={"Content-Type": f"multipart/form-data; boundary={boundary}", "Accept": "application/json", "User-Agent": "Flourish-Hermes/1.0"}, method="POST"), timeout=120) as response:
            decoded = json.loads(response.read().decode("utf-8"))
            return decoded.get("data", decoded)
    except urllib.error.HTTPError as error:
        content = error.read().decode("utf-8", errors="replace")
        try:
            detail = json.loads(content).get("error", {})
            raise ApiError(f"{detail.get('code', error.code)}: {detail.get('message', content)}") from error
        except json.JSONDecodeError:
            raise ApiError(f"HTTP {error.code}: {content}") from error


def print_json(value):
    print(json.dumps(value, indent=2, ensure_ascii=False, sort_keys=True))


def main():
    parser = argparse.ArgumentParser(description="Call the local Flourish API")
    commands = parser.add_subparsers(dest="command", required=True)
    commands.add_parser("health")

    state = commands.add_parser("state")
    state.add_argument("--month")

    get = commands.add_parser("get")
    get.add_argument("path")

    write = commands.add_parser("write")
    write.add_argument("method", choices=["POST", "PUT", "PATCH", "DELETE"])
    write.add_argument("path")
    write.add_argument("--json")
    write.add_argument("--idempotency-key")

    preview = commands.add_parser("statement-preview")
    preview.add_argument("--file", required=True)
    preview.add_argument("--account", required=True)
    preview.add_argument("--profile")
    preview.add_argument("--mapping-json")

    apply_parser = commands.add_parser("statement-apply")
    apply_parser.add_argument("batch_id")
    apply_parser.add_argument("--idempotency-key", required=True)

    card_statement = commands.add_parser("card-statement")
    card_statement.add_argument("card_id")
    card_statement.add_argument("--date", required=True)
    card_statement.add_argument("--balance-minor", required=True, type=int)
    card_statement.add_argument("--due-date")
    card_statement.add_argument("--statement-day", type=int)
    card_statement.add_argument("--due-day", type=int)
    card_statement.add_argument("--idempotency-key", required=True)

    loan_create = commands.add_parser("loan-create")
    loan_create.add_argument("--name", required=True)
    loan_create.add_argument("--kind", required=True, choices=["personal_loan", "balance_transfer", "card_installment", "other"])
    loan_create.add_argument("--currency", default="AED")
    loan_create.add_argument("--institution")
    loan_create.add_argument("--card")
    loan_create.add_argument("--included-in-card", action=argparse.BooleanOptionalAction, default=True)
    loan_create.add_argument("--original-minor", required=True, type=int)
    loan_create.add_argument("--balance-minor", required=True, type=int)
    loan_create.add_argument("--emi-minor", type=int)
    loan_create.add_argument("--total-emis", type=int)
    loan_create.add_argument("--remaining-emis", type=int)
    loan_create.add_argument("--apr-bps", type=int)
    loan_create.add_argument("--next-due")
    loan_create.add_argument("--prepayment-allowed", action="store_true")
    loan_create.add_argument("--idempotency-key", required=True)

    loan_emi = commands.add_parser("loan-emi")
    loan_emi.add_argument("loan_id")
    loan_emi.add_argument("--date", required=True)
    loan_emi.add_argument("--amount-minor", required=True, type=int)
    loan_emi.add_argument("--interest-minor", type=int, default=0)
    loan_emi.add_argument("--fee-minor", type=int, default=0)
    loan_emi.add_argument("--note")
    loan_emi.add_argument("--idempotency-key", required=True)

    wealth_draft = commands.add_parser("wealth-draft")
    wealth_draft.add_argument("--file", required=True)
    wealth_draft.add_argument("--json", required=True, help="Draft JSON or @path containing proposals and extraction notes")
    wealth_draft.add_argument("--captured-at")
    wealth_draft.add_argument("--institution")
    wealth_draft.add_argument("--idempotency-key", required=True)

    export = commands.add_parser("export")
    export.add_argument("kind", choices=["transactions", "all"])
    export.add_argument("--output", required=True)
    export.add_argument("--start")
    export.add_argument("--end")

    args = parser.parse_args()
    if args.command == "health":
        result = request("GET", "/health")
    elif args.command == "state":
        result = request("GET", "/dashboard" + ("?month=" + urllib.parse.quote(args.month) if args.month else ""))
    elif args.command == "get":
        result = request("GET", args.path)
    elif args.command == "write":
        result = request(args.method, args.path, parse_json(args.json), args.idempotency_key)
    elif args.command == "statement-preview":
        path = pathlib.Path(args.file).expanduser().resolve()
        if not path.is_file():
            raise ApiError(f"Statement file does not exist: {path}")
        result = multipart_statement(path, args.account, args.profile, args.mapping_json)
    elif args.command == "statement-apply":
        result = request("POST", f"/imports/{args.batch_id}/apply", {}, args.idempotency_key)
    elif args.command == "card-statement":
        payload = {
            "lastStatementDate": args.date,
            "lastStatementBalanceMinor": args.balance_minor,
            "source": "hermes",
        }
        if args.due_date:
            payload["nextDueDate"] = args.due_date
        if args.statement_day is not None:
            payload["statementDay"] = args.statement_day
        if args.due_day is not None:
            payload["dueDay"] = args.due_day
        request("PATCH", f"/cards/{args.card_id}", payload, args.idempotency_key)
        result = request("GET", f"/cards/{args.card_id}")
    elif args.command == "loan-create":
        payload = {
            "name": args.name,
            "kind": args.kind,
            "currency": args.currency,
            "institution": args.institution,
            "linkedCardId": args.card,
            "includedInCardBalance": bool(args.card) and args.included_in_card,
            "originalPrincipalMinor": args.original_minor,
            "currentBalanceMinor": args.balance_minor,
            "emiMinor": args.emi_minor,
            "totalInstallments": args.total_emis,
            "remainingInstallments": args.remaining_emis,
            "aprBps": args.apr_bps,
            "nextDueDate": args.next_due,
            "prepaymentAllowed": args.prepayment_allowed,
            "source": "hermes",
        }
        created = request("POST", "/loans", payload, args.idempotency_key)
        result = request("GET", f"/loans/{created['id']}")
    elif args.command == "loan-emi":
        principal_minor = args.amount_minor - args.interest_minor - args.fee_minor
        if principal_minor < 0:
            raise ApiError("Interest and fees cannot exceed the EMI amount")
        payload = {
            "paidDate": args.date,
            "amountMinor": args.amount_minor,
            "principalMinor": principal_minor,
            "interestMinor": args.interest_minor,
            "feeMinor": args.fee_minor,
            "note": args.note,
            "source": "hermes",
        }
        request("POST", f"/loans/{args.loan_id}/installments", payload, args.idempotency_key)
        result = request("GET", f"/loans/{args.loan_id}")
    elif args.command == "wealth-draft":
        path = pathlib.Path(args.file).expanduser().resolve()
        if not path.is_file():
            raise ApiError(f"Screenshot file does not exist: {path}")
        payload = parse_json(args.json)
        if not isinstance(payload, dict):
            raise ApiError("Wealth draft JSON must be an object")
        payload["sourceFilename"] = path.name
        payload["sourceSha256"] = hashlib.sha256(path.read_bytes()).hexdigest()
        payload["source"] = "hermes"
        if args.captured_at:
            payload["capturedAt"] = args.captured_at
        if args.institution:
            payload["institution"] = args.institution
        result = request("POST", "/wealth/import-drafts", payload, args.idempotency_key)
    elif args.command == "export":
        endpoint = "/exports/data.json" if args.kind == "all" else "/exports/transactions.csv"
        if args.kind == "transactions":
            query = urllib.parse.urlencode({key: value for key, value in {"start": args.start, "end": args.end}.items() if value})
            endpoint += "?" + query if query else ""
        content, _ = request("GET", endpoint, raw=True)
        output = pathlib.Path(args.output).expanduser().resolve()
        output.parent.mkdir(parents=True, exist_ok=True)
        output.write_bytes(content)
        result = {"output": str(output), "bytes": len(content)}
    else:
        raise ApiError("Unknown command")
    print_json(result)


if __name__ == "__main__":
    try:
        main()
    except (ApiError, json.JSONDecodeError) as error:
        print(json.dumps({"error": str(error)}), file=sys.stderr)
        sys.exit(1)
