from typing import Callable, Optional
from urllib.parse import urlparse
from playwright.async_api import BrowserContext
from .run import run_program, extract
from .schemas import IntentProgram, RunPlan, SiteResult, AgentEvent
from .sheet_writer import SheetWriter, SheetError

NEEDED = {"product_name": "the main product's name",
          "price": "the main product's price with currency symbol"}

async def shop_and_log(ctx: BrowserContext, program: IntentProgram, plan: RunPlan, *,
                       on_event: Optional[Callable[[AgentEvent], None]] = None) -> list[SiteResult]:
    def emit(kind, message, site=None, **data):
        if on_event:
            on_event(AgentEvent(kind=kind, site=site, message=message, data=data))

    emit("log", f"plan: {plan.summary}", plan=plan.model_dump())

    writer = None
    if plan.sheet_url:
        sheet_page = ctx.pages[0] if ctx.pages else await ctx.new_page()
        writer = SheetWriter(sheet_page, plan.sheet_url)
        try:
            await writer.open()
            emit("log", f"sheet ready, next row {writer.next_row}")
        except SheetError as e:
            emit("error", str(e))
            writer = None

    shop = await ctx.new_page()
    results: list[SiteResult] = []
    for n, site in enumerate(plan.sites, 1):
        emit("log", f"[{n}/{len(plan.sites)}] shopping on {site}", site=site)
        res = await run_program(ctx, site, program, variables=plan.variables,
                                page=shop, on_event=on_event, run_tag=str(n))

        if res.status == "done":
            missing = {k: d for k, d in NEEDED.items() if not res.outputs.get(k)}
            if missing:
                try:
                    found = await extract(shop, missing)
                    res.outputs.update({k: v for k, v in found.items() if v})
                except Exception as e:
                    emit("log", f"extra extraction failed: {e}", site=site)
            res.outputs.setdefault("product_url", shop.url)

        if res.status == "done":
            status, notes = "Added to cart", ""
        elif res.status == "needs_human":
            status, notes = "Needs human", res.error or ""
        else:
            status, notes = "Failed", (res.error or "")[:120]
        row = [urlparse(site).netloc, res.outputs.get("product_name"), res.outputs.get("price"),
               res.outputs.get("product_url") if res.status == "done" else "", status, notes]

        if writer:
            try:
                row_no = writer.next_row
                await writer.append(row)
                emit("log", f"wrote sheet row {row_no}", site=site, row=row)
            except Exception as e:
                emit("error", f"sheet write failed: {e}", site=site)

        emit("done", status, site=site, result=res.model_dump())
        results.append(res)
    return results