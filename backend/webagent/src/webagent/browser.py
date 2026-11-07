from contextlib import asynccontextmanager
from playwright.async_api import async_playwright, Browser
from .config import HEADLESS, CHROMIUM_PATH

@asynccontextmanager
async def launch(headless: bool | None = None):
    async with async_playwright() as p:
        browser: Browser = await p.chromium.launch(
            headless=HEADLESS if headless is None else headless,
            executable_path=CHROMIUM_PATH,
        )
        try:
            yield browser
        finally:
            await browser.close()