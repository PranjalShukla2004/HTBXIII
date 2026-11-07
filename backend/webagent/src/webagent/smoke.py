import asyncio
from .browser import launch
from .llm import llm_json
from .config import DATA

async def main():
    async with launch(headless=True) as browser:
        page = await browser.new_page()
        await page.goto("https://example.com")
        print("browser ok, title:", await page.title())
        await page.screenshot(path=DATA / "logs" / "smoke.png")

    out = await llm_json("Reply with JSON only.", 'Return {"ok": true, "msg": "hello"}', tag="smoke")
    print("llm ok:", out)

if __name__ == "__main__":
    asyncio.run(main())