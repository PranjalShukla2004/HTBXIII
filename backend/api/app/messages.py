"""Readable progress messages derived from actual agent/recorder events."""

import json


def action_message(action, url):
    element = action.get("element") or {}
    label = next((element[key] for key in ("label", "aria", "text", "title", "ph", "name")
                  if element.get(key)), action.get("target") or "element")
    label = json.dumps(str(label), ensure_ascii=False)
    value = json.dumps(action.get("value"), ensure_ascii=False)
    op = action.get("op")
    description = {
        "click": f"Clicked {label}",
        "navigate_to": f"Clicked {label} to reach {action.get('target', 'the target page')}",
        "search": f"Searched for {value} using {label}",
        "fill": f"Filled {label} with {value}",
        "select": f"Selected {value} in {label}",
        "check": f"Set {label} to {value}",
        "press": f"Pressed {value} on {label}",
    }.get(op, f"Performed {op} on {label}")
    return f"{description} on {action.get('url') or url}"


def recorder_message(event):
    if event["kind"] == "navigate":
        return f"[rec] navigate -> {event['url']}"
    element = event.get("el") or {}
    label = next((element[key] for key in ("label", "aria_label", "placeholder", "text", "css")
                  if element.get(key)), "")
    return f"[rec] {event['kind']:8} {label[:50]!r:52} {event.get('value') or ''}"
