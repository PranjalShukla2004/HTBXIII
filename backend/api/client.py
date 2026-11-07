"""Exercise the API and both streams from a terminal, without a frontend."""

import argparse
import asyncio
import json
import sys
from urllib.error import HTTPError, URLError
from urllib.parse import urlsplit, urlunsplit
from urllib.request import Request, urlopen

from websockets.asyncio.client import connect


def request(base, path, payload=None):
    data = json.dumps(payload).encode() if payload is not None else None
    command = Request(base.rstrip("/") + path, data=data,
                      headers={"Content-Type": "application/json"} if data else {})
    with urlopen(command, timeout=30) as response:
        return json.load(response)


async def watch(base, job, channel):
    parsed = urlsplit(base)
    scheme = "wss" if parsed.scheme == "https" else "ws"

    async def consume(name):
        url = urlunsplit((scheme, parsed.netloc, job["streams"][name], "", ""))
        async with connect(url) as socket:
            async for message in socket:
                frame = json.loads(message)
                print(f"[{name}] {json.dumps(frame, ensure_ascii=False)}", flush=True)

    channels = ("llm", "events") if channel == "both" else (channel,)
    await asyncio.gather(*(consume(name) for name in channels))


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--base", default="http://127.0.0.1:8000")
    commands = parser.add_subparsers(dest="command", required=True)
    commands.add_parser("skills")
    run = commands.add_parser("run")
    run.add_argument("skill_id")
    run.add_argument("--url", required=True)
    run.add_argument("--arg", action="append", default=[], metavar="NAME=VALUE")
    record = commands.add_parser("record")
    record.add_argument("skill_id")
    record.add_argument("--url", required=True)
    record.add_argument("--replace", action="store_true")
    follow = commands.add_parser("watch")
    follow.add_argument("job_id")
    for command in (run, record, follow):
        command.add_argument("--channel", choices=("llm", "events", "both"), default="both")
    for name in ("stop", "cancel", "status", "logs"):
        command = commands.add_parser(name)
        command.add_argument("job_id")
    args = parser.parse_args()
    try:
        if args.command == "skills":
            result = request(args.base, "/api/skills")
        elif args.command == "run":
            if any("=" not in argument for argument in args.arg):
                parser.error("--arg must have the form NAME=VALUE")
            arguments = dict(argument.split("=", 1) for argument in args.arg)
            result = request(args.base, f"/api/skills/{args.skill_id}/runs",
                             {"url": args.url, "arguments": arguments})
        elif args.command == "record":
            result = request(args.base, "/api/recordings",
                             {"skill_id": args.skill_id, "url": args.url, "replace": args.replace})
        elif args.command == "stop":
            result = request(args.base, f"/api/recordings/{args.job_id}/stop", {})
        elif args.command == "cancel":
            result = request(args.base, f"/api/jobs/{args.job_id}/cancel", {})
        elif args.command == "logs":
            with urlopen(args.base.rstrip("/") + f"/api/jobs/{args.job_id}/logs", timeout=30) as response:
                print(response.read().decode("utf-8"), end="")
            return
        else:
            result = request(args.base, f"/api/jobs/{args.job_id}")
        print(json.dumps(result, indent=2), flush=True)
        if args.command in {"run", "record", "watch"}:
            asyncio.run(watch(args.base, result, args.channel))
    except HTTPError as error:
        print(f"HTTP {error.code}: {error.read().decode()}", file=sys.stderr)
        raise SystemExit(1)
    except (URLError, OSError) as error:
        print(f"Connection failed: {error}", file=sys.stderr)
        raise SystemExit(1)
    except KeyboardInterrupt:
        print("Disconnected. The job continues; use the cancel command to stop it.", file=sys.stderr)


if __name__ == "__main__":
    main()
