from contextlib import asynccontextmanager
from urllib.parse import urlparse
from playwright.async_api import async_playwright, Browser, BrowserContext, Route
from .config import HEADLESS, CHROMIUM_PATH

AD_HOSTS = (
    "doubleclick.net", "googlesyndication.com", "googleadservices.com", "adservice.google.com",
    "google-analytics.com", "googletagmanager.com", "fundingchoicesmessages.google.com",
    "amazon-adsystem.com", "adnxs.com", "criteo.com", "criteo.net", "taboola.com", "outbrain.com",
    "facebook.net", "hotjar.com", "scorecardresearch.com", "pubmatic.com", "rubiconproject.com",
    "openx.net", "moatads.com", "quantserve.com", "ads-twitter.com", "bing.com", "clarity.ms",
)

def _is_ad(url: str) -> bool:
    host = urlparse(url).hostname or ""
    return any(host == h or host.endswith("." + h) for h in AD_HOSTS)

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

async def new_context(browser: Browser, *, block_ads: bool = True) -> BrowserContext:
    ctx = await browser.new_context(viewport={"width": 1366, "height": 900}, locale="en-GB")
    ctx.set_default_timeout(8000)
    ctx.set_default_navigation_timeout(30000)
    if block_ads:
        async def handle(route: Route):
            if route.request.resource_type == "media" or _is_ad(route.request.url):
                await route.abort()
            else:
                await route.continue_()
        await ctx.route("**/*", handle)
    return ctx