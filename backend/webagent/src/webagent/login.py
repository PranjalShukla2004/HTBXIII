import asyncio
from .browser import launch

async def main():
    async with launch(headless=False, block_ads=False) as ctx:
        page = ctx.pages[0] if ctx.pages else await ctx.new_page()
        await page.goto("https://accounts.google.com/")
        print("Sign in to Google in this window, then open your demo sheet once to check it loads.")
        print("Press Enter here when done.")
        await asyncio.get_running_loop().run_in_executor(None, input)

if __name__ == "__main__":
    asyncio.run(main())