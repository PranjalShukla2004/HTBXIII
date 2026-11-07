import asyncio, re, sys
from playwright.async_api import Page
from .browser import launch

NAME_BOX = "#t-name-box, input.waffle-name-box"
FORMULA = "#t-formula-bar-input .cell-input, #t-formula-bar-input"
HEADERS = ["Site", "Product", "Price", "Product URL", "Status", "Notes"]

class SheetError(Exception):
    pass

def _safe(v) -> str:
    s = "" if v is None else str(v).replace("\n", " ").strip()
    if s[:1] in ("=", "+", "-", "@") or re.fullmatch(r"[\d.,]+", s):
        return "'" + s          # keep as text: no formulas, no "1.00" -> "1"
    return s

class SheetWriter:
    """Types rows into a Google Sheet through the normal web UI, visibly."""

    def __init__(self, page: Page, url: str):
        self.page, self.url, self.next_row = page, url, None

    async def open(self):
        await self.page.bring_to_front()
        await self.page.goto(self.url, wait_until="domcontentloaded")
        try:
            await self.page.locator(NAME_BOX).first.wait_for(state="visible", timeout=20000)
        except Exception:
            raise SheetError("Sheet isn't editable in the agent browser. Run `python -m webagent.login` "
                             "and sign in, or set the sheet to 'Anyone with the link can edit'.")
        await self.page.wait_for_timeout(1500)            # let the grid finish loading
        self.next_row = await self._find_next_row()

    async def _goto(self, a1: str):
        box = self.page.locator(NAME_BOX).first
        await box.click()
        await box.fill(a1)
        await box.press("Enter")
        await self.page.wait_for_timeout(250)

    async def _current_cell(self) -> str:
        return await self.page.locator(NAME_BOX).first.input_value()

    async def _cell_text(self) -> str | None:
        try:
            return (await self.page.locator(FORMULA).first.inner_text(timeout=1000)).strip()
        except Exception:
            return None                                   # can't read: assume headers exist

    async def _find_next_row(self) -> int:
        await self._goto("A1")
        if await self._cell_text() == "":
            await self._type_row(1, HEADERS)              # empty sheet: write headers first
            return 2
        await self.page.keyboard.press("Control+ArrowDown")
        await self.page.wait_for_timeout(400)
        row = int(re.sub(r"\D", "", await self._current_cell()) or "1")
        return 2 if row >= 900 else row + 1               # jumped to the bottom = only headers

    async def _type_row(self, row: int, values: list):
        await self._goto(f"A{row}")
        for i, v in enumerate(values):
            await self.page.keyboard.type(_safe(v), delay=12)
            await self.page.keyboard.press("Tab" if i < len(values) - 1 else "Enter")
        await self.page.wait_for_timeout(400)

    async def append(self, values: list):
        if self.next_row is None:
            await self.open()
        await self.page.bring_to_front()
        await self._type_row(self.next_row, values)
        self.next_row += 1

# uv run python -m webagent.sheet_writer "<sheet_url>"
async def _main():
    async with launch(block_ads=False) as ctx:
        page = ctx.pages[0] if ctx.pages else await ctx.new_page()
        w = SheetWriter(page, sys.argv[1])
        await w.open()
        print(f"next empty row: {w.next_row}")
        await w.append(["test-shop.com", "Test jeans", "£9.99", "https://example.com/jeans", "test"])
        print("typed a test row; check the sheet")
        await page.wait_for_timeout(3000)

if __name__ == "__main__":
    asyncio.run(_main())