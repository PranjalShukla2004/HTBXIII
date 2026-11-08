from contextlib import asynccontextmanager
from urllib.parse import urlparse
from playwright.async_api import async_playwright, BrowserContext, Route
from .config import HEADLESS, CHROMIUM_PATH, PROFILE_DIR, AUTH_STATE

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

LAUNCH_ARGS = dict(ignore_default_args=["--enable-automation"],
                   args=["--disable-blink-features=AutomationControlled"])
CONTEXT_ARGS = dict(viewport={"width": 1366, "height": 900}, locale="en-GB")

async def _prepare(ctx: BrowserContext, block_ads: bool):
    ctx.set_default_timeout(8000)
    ctx.set_default_navigation_timeout(30000)
    if block_ads:
        async def handle(route: Route):
            if route.request.resource_type == "media" or _is_ad(route.request.url):
                await route.abort()
            else:
                await route.continue_()
        await ctx.route("**/*", handle)

@asynccontextmanager
async def launch_isolated(headless: bool | None = None, block_ads: bool = True):
    """A fresh browser with no saved profile: safe to run several at once (one window each)."""
    async with async_playwright() as p:
        browser = await p.chromium.launch(
            headless=HEADLESS if headless is None else headless,
            executable_path=CHROMIUM_PATH, **LAUNCH_ARGS)
        try:
            # Reuse the logins saved by `python -m webagent.login` (Gmail, Outlook, ...).
            state = str(AUTH_STATE) if AUTH_STATE.exists() else None
            ctx = await browser.new_context(storage_state=state, **CONTEXT_ARGS)
            await _prepare(ctx, block_ads)
            yield ctx
        finally:
            try:
                await browser.close()
            except Exception:
                pass          # already closed (e.g. user closed the window)

@asynccontextmanager
async def launch(headless: bool | None = None, block_ads: bool = True):
    """The signed-in agent profile (Google Sheets etc.). Only one at a time."""
    PROFILE_DIR.mkdir(parents=True, exist_ok=True)
    async with async_playwright() as p:
        ctx: BrowserContext = await p.chromium.launch_persistent_context(
            str(PROFILE_DIR),
            headless=HEADLESS if headless is None else headless,
            executable_path=CHROMIUM_PATH, **CONTEXT_ARGS, **LAUNCH_ARGS,
        )
        await _prepare(ctx, block_ads)
        try:
            yield ctx
        finally:
            try:
                await ctx.close()
            except Exception:
                pass          # already closed (e.g. user closed the window)
