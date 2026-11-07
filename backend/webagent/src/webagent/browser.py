from contextlib import asynccontextmanager
from urllib.parse import urlparse
from playwright.async_api import async_playwright, BrowserContext, Route
from .config import HEADLESS, CHROMIUM_PATH, PROFILE_DIR

AD_HOSTS = (
    "doubleclick.net", "googlesyndication.com", "googleadservices.com", "adservice.google.com",
    "google-analytics.com", "googletagmanager.com", "fundingchoicesmessages.google.com",
    "amazon-adsystem.com", "adnxs.com", "criteo.com", "criteo.net", "taboola.com", "outbrain.com",
    "facebook.net", "hotjar.com", "scorecardresearch.com", "pubmatic.com", "rubiconproject.com",
    "openx.net", "moatads.com", "quantserve.com", "ads-twitter.com", "clarity.ms",
)

def _is_ad(url: str) -> bool:
    host = urlparse(url).hostname or ""
    return any(host == h or host.endswith("." + h) for h in AD_HOSTS)

@asynccontextmanager
async def launch(headless: bool | None = None, block_ads: bool = True):
    PROFILE_DIR.mkdir(parents=True, exist_ok=True)
    async with async_playwright() as p:
        ctx: BrowserContext = await p.chromium.launch_persistent_context(
            str(PROFILE_DIR),
            headless=HEADLESS if headless is None else headless,
            executable_path=CHROMIUM_PATH,
            viewport={"width": 1366, "height": 900},
            locale="en-GB",
            ignore_default_args=["--enable-automation"],
            args=["--disable-blink-features=AutomationControlled"],
        )
        ctx.set_default_timeout(8000)
        ctx.set_default_navigation_timeout(30000)
        if block_ads:
            async def handle(route: Route):
                if route.request.resource_type == "media" or _is_ad(route.request.url):
                    await route.abort()
                else:
                    await route.continue_()
            await ctx.route("**/*", handle)
        try:
            yield ctx
        finally:
            try:
                await ctx.close()
            except Exception:
                pass          # already closed (e.g. user closed the window)