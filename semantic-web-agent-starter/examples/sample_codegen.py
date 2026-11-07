"""An example of the subset of Playwright Codegen output supported by this starter.

Uses a fake identity and a LOCAL demo page. Not intended for production submissions.
"""
from playwright.sync_api import Playwright, sync_playwright


def run(playwright: Playwright) -> None:
    browser = playwright.chromium.launch(headless=False)
    page = browser.new_page()
    page.goto("http://localhost:8000/examples/manufacturer_a.html")
    page.get_by_role("textbox", name="Full Name").fill("Alex Example")
    page.get_by_role("textbox", name="Work Email").fill("alex@example.test")
    page.get_by_role("textbox", name="Enquiry Details").fill(
        "Please send me a catalogue and MOQ information for industrial fasteners."
    )
    page.get_by_role("button", name="Send Enquiry").click()
    browser.close()


if __name__ == "__main__":
    with sync_playwright() as playwright:
        run(playwright)
