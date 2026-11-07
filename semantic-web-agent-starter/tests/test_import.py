from pathlib import Path

from semantic_web_agent.recorder_import import import_codegen


def test_import_demo(tmp_path: Path) -> None:
    example = '''
from playwright.sync_api import sync_playwright

def run(playwright):
    page = playwright.chromium.launch().new_page()
    page.goto("http://localhost:8000/examples/manufacturer_a.html")
    page.get_by_role("textbox", name="Full Name").click()
    page.get_by_role("textbox", name="Full Name").fill("Alex Example")
    page.get_by_role("textbox", name="Work Email").fill("alex@example.test")
    page.get_by_role("textbox", name="Enquiry Details").fill("Please send a catalogue")
    page.get_by_role("button", name="Send Enquiry").click()
'''
    path = tmp_path / "record.py"
    path.write_text(example)
    result = import_codegen(path)
    assert len(result["steps"]) == 4
    assert [s["action"] for s in result["steps"]] == ["fill", "fill", "fill", "click"]
    assert result["steps"][-1]["requires_approval"] is True
    assert result["steps"][0]["target"]["label"] == "Full Name"
