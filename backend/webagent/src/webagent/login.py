import asyncio, sys
from .browser import launch
from .config import AUTH_STATE

DEFAULT_SITES = ["https://accounts.google.com/", "https://outlook.live.com/mail/0/"]

# uv run python -m webagent.login [url ...]
async def main():
    sites = sys.argv[1:] or DEFAULT_SITES
    async with launch(headless=False, block_ads=False) as ctx:
        for n, url in enumerate(sites):
            page = ctx.pages[0] if n == 0 and ctx.pages else await ctx.new_page()
            await page.goto(url)
        print("Sign in on every tab that opened (Google, Outlook, ...).")
        print("Open your demo sheet once to check it loads. Press Enter here when done.")
        await asyncio.get_running_loop().run_in_executor(None, input)
        await ctx.storage_state(path=str(AUTH_STATE))
        print(f"Saved logins for the parallel browsers to {AUTH_STATE}")

if __name__ == "__main__":
    asyncio.run(main())
