"""Lazy agent imports let skill discovery and API tests work without a Gemini key."""


class AgentBackend:
    async def plan(self, prompt, program, *, on_llm):
        from webagent.llm import observe_llm
        from webagent.planner import plan_from_chat

        with observe_llm(on_llm):
            return await plan_from_chat(prompt, program)

    async def record(self, url, *, on_event, stop):
        from webagent.recorder import record

        return await record(url, on_event=on_event, stop=stop)

    async def abstract(self, trace, *, on_llm):
        from webagent.abstract import abstract
        from webagent.llm import observe_llm

        with observe_llm(on_llm):
            return await abstract(trace)

    async def run(self, url, program, arguments, *, on_event, on_action, on_llm, choices=None):
        from webagent.browser import launch_isolated
        from webagent.llm import observe_llm
        from webagent.orchestrator import NEEDED
        from webagent.run import run_program, extract

        with observe_llm(on_llm):
            # One throwaway browser per run, so several sites can run side by side (a shared
            # persistent profile can only be open in one browser at a time). Follows HEADLESS.
            async with launch_isolated() as browser:
                page = await browser.new_page()
                result = await run_program(browser, url, program, variables=arguments,
                                           on_event=on_event, on_action=on_action, page=page,
                                           answers=dict(choices or {}))
                if result.status == "done":
                    # The table and sheet always want a product name and price.
                    missing = {k: d for k, d in NEEDED.items() if not result.outputs.get(k)}
                    if missing:
                        try:
                            found = await extract(page, missing)
                            result.outputs.update({k: v for k, v in found.items() if v})
                        except Exception:
                            pass
                    result.outputs.setdefault("product_url", page.url)
                return result

    async def append_sheet(self, sheet_url, rows):
        from webagent.browser import launch
        from webagent.sheet_writer import SheetWriter

        async with launch(block_ads=False) as ctx:
            page = ctx.pages[0] if ctx.pages else await ctx.new_page()
            writer = SheetWriter(page, sheet_url)
            await writer.open()
            for row in rows:
                await writer.append(row)
            await page.wait_for_timeout(2500)        # let the audience see the filled rows
        return len(rows)

    async def close(self):
        import sys

        if module := sys.modules.get("webagent.llm"):
            await module.client.aio.aclose()
            module.client.close()